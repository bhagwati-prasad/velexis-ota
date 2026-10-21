// The storefront cookies of the API (OADR-0006, api-changes §2.3): the hosted storefront calls the API same-origin
// through Caddy, so its sessions and its CSRF value live in host-only `__Host-` cookies of the storefront's own host.
// This is the only code that writes them, and it writes them only for the storefront edge caller: a key caller (a
// third-party frontend or server with a `pk_`/`sk_` key) never gets a `Set-Cookie` (OADR-0006 point 1).
//
//   Cookie            HttpOnly  Max-Age                          Content
//   __Host-vx_at      yes       900 s                            customer access JWT (OBE-031, `setSession`)
//   __Host-vx_rt      yes       the refresh family's remaining   refresh token (OBE-031, `setSession`)
//                               lifetime
//   __Host-vx_csrf    no        30 days                          256-bit random, base64url (storefront.get; rotated
//                                                                by `setSession` and `clearSession`)
//   __Host-vx_bt      yes       30 days                          up to 5 guest booking tokens (OBE-047,
//                                                                `addBookingToken`)
//
// Every cookie is `Secure; SameSite=Lax; Path=/` without `Domain`, which the `__Host-` prefix requires: the browser
// keeps it for the exact host, so a session on `acme.ota.example.com` never reaches another OTA. Only the CSRF value is
// readable by the storefront's JavaScript, which copies it into `X-CSRF-Token` (the CSRF guard compares both).
//
//   if (this.cookies.write(res, "csrf", newCsrfValue())) { … }   // false (and no header) for a key caller
//   const edge = this.cookies.setSession(res, tokens);            // sign-in: the session in cookies, a new CSRF value
//   this.cookies.clearSession(res);                               // sign-out: both session cookies removed
//   this.cookies.addBookingToken(res, req.cookies[…], entry);     // a guest booking or lookup: the token prepended
//
// The guest cookie (OADR-0006 point 6): `__Host-vx_bt` holds up to five `bkg_<id>.<token>` entries separated by `~`,
// newest first: the booking id, a `.`, and the booking's guest token. `addBookingToken` prepends the entry of a new
// guest booking or lookup to the entries the request sent (an older entry of the same booking is replaced), keeps the
// newest five (the sixth booking drops the oldest) and writes the whole list again, so the browser replaces it at
// once. `parseBookingTokens` reads the entries a request sends (the booking access guard picks the one of the
// requested booking); a malformed entry, or one beyond the fifth, is ignored, never an error.
//
// The session cookies (OADR-0006 points 2 and 4): `setSession` writes the access token for 900 s and the refresh token
// for what remains of its family (12 hours, or 30 days with rememberMe, from the sign-in; rotation never extends it),
// and rotates the CSRF value, as sign-in, a sign-up that opens a session and a password change do. auth.refresh keeps
// the CSRF value (`{ rotateCsrf: false }`): OADR-0006 point 2 rotates it on sign-in, sign-up, sign-out and password
// change. `clearSession` removes both session cookies and rotates the CSRF value (sign-out, a refused refresh). In
// edge mode the answer bodies carry no token (OADR-0006 point 4); for a key caller both return false and write
// nothing, and the caller answers the tokens in the body (bearer mode).
//
// Values are opaque to the browser and are written as they are, so a value is restricted to the characters the
// tokens use (base64url, `.` of JWTs, `~` between guest booking tokens); anything else is refused with an error
// instead of being encoded.
import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { Response } from "express";
import { CallerContext } from "../../tenancy/caller-resolver";
import { CSRF_COOKIE, CSRF_TOKEN_PATTERN } from "../auth/csrf.guard";
import { Clock } from "../clock";

/** The storefront cookies by role. */
export const STOREFRONT_COOKIES = Object.freeze({
  accessToken: "__Host-vx_at",
  refreshToken: "__Host-vx_rt",
  csrf: CSRF_COOKIE,
  bookingTokens: "__Host-vx_bt",
} as const);

export type StorefrontCookie = keyof typeof STOREFRONT_COOKIES;

const DAY_SECONDS = 24 * 60 * 60;

/** `Max-Age` of the cookies whose lifetime does not depend on a session (api-changes §2.3). */
export const COOKIE_MAX_AGE_SECONDS = Object.freeze({
  accessToken: 900,
  csrf: 30 * DAY_SECONDS,
  bookingTokens: 30 * DAY_SECONDS,
} as const);

/** The one cookie the storefront's JavaScript may read (OADR-0006 point 2). */
const READABLE: ReadonlySet<StorefrontCookie> = new Set(["csrf"]);

/** The characters of a cookie value: base64url, `.` (JWTs) and `~` (the separator of `__Host-vx_bt`). */
const COOKIE_VALUE = /^[A-Za-z0-9_\-.~]*$/;

/** Longest value written: a browser keeps about 4 KB per cookie, name and attributes included. */
const MAX_VALUE_LENGTH = 3_800;

export interface CookieOptions {
  /** Seconds until the browser drops the cookie; `0` removes it. A non-negative integer. */
  readonly maxAgeSeconds: number;
}

/** The tokens of a customer session that `setSession` puts into cookies (`SessionTokens` of the identity module). */
export interface SessionCookieTokens {
  /** The 15-minute access JWT. */
  readonly accessToken: string;
  /** The opaque refresh token (`rt_…`). */
  readonly refreshToken: string;
  /** The end of the refresh family: the refresh cookie lives until then. */
  readonly refreshTokenExpiresAt: Date;
}

export interface SetSessionOptions {
  /** Whether a new CSRF value replaces the current one: true (sign-in, sign-up, password change) unless refreshing. */
  readonly rotateCsrf?: boolean;
}

/** Whole seconds from `now` until `end`, at least 0: a cookie never outlives what it holds. */
export function secondsUntil(end: Date, now: Date): number {
  return Math.max(0, Math.floor((end.getTime() - now.getTime()) / 1000));
}

/**
 * The `Set-Cookie` value of a storefront cookie: `<name>=<value>; Max-Age=<s>; Path=/; Secure; SameSite=Lax`, plus
 * `HttpOnly` for every cookie but the CSRF one. Never a `Domain` (the `__Host-` prefix forbids it). Throws a
 * `TypeError` for a value with other characters, or one that is too long, and a `RangeError` for a bad `Max-Age`;
 * the errors never contain the value.
 */
export function storefrontSetCookie(cookie: StorefrontCookie, value: string, options: CookieOptions): string {
  if (!COOKIE_VALUE.test(value) || value.length > MAX_VALUE_LENGTH) {
    throw new TypeError(
      `the value of ${STOREFRONT_COOKIES[cookie]} must be at most ${MAX_VALUE_LENGTH} characters of ` +
        "A-Z, a-z, 0-9, '-', '_', '.' and '~'",
    );
  }
  const { maxAgeSeconds } = options;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new RangeError(`the Max-Age of ${STOREFRONT_COOKIES[cookie]} must be a non-negative integer`);
  }
  const attributes = [`Max-Age=${maxAgeSeconds}`, "Path=/", "Secure", "SameSite=Lax"];
  if (!READABLE.has(cookie)) {
    attributes.push("HttpOnly");
  }
  return [`${STOREFRONT_COOKIES[cookie]}=${value}`, ...attributes].join("; ");
}

/** The most guest bookings `__Host-vx_bt` holds (OADR-0006 point 6). */
export const MAX_BOOKING_TOKEN_ENTRIES = 5;

/** The separator of the entries of `__Host-vx_bt`. */
const BOOKING_TOKEN_SEPARATOR = "~";

/** A booking id as the entries of `__Host-vx_bt` name it (`BookingId` of the document). */
const ENTRY_BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;

/** The token part of an entry: base64url characters (the token's own shape is the booking access guard's check). */
const ENTRY_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/** One entry of `__Host-vx_bt`: a booking and its guest token (`bkg_<id>.<token>`). */
export interface BookingTokenEntry {
  readonly bookingId: string;
  readonly token: string;
}

/**
 * The entries of a `__Host-vx_bt` value (a cookie as cookie-parser gives it), newest first: at most five, one per
 * booking (the first, newest, one wins). Anything that is not a string, a malformed entry and an entry beyond the
 * fifth are ignored.
 */
export function parseBookingTokens(value: unknown): BookingTokenEntry[] {
  if (typeof value !== "string" || value === "" || value.length > MAX_VALUE_LENGTH) {
    return [];
  }
  const entries: BookingTokenEntry[] = [];
  for (const part of value.split(BOOKING_TOKEN_SEPARATOR)) {
    const dot = part.indexOf(".");
    const bookingId = dot < 0 ? "" : part.slice(0, dot);
    const token = dot < 0 ? "" : part.slice(dot + 1);
    if (
      ENTRY_BOOKING_ID.test(bookingId) &&
      ENTRY_TOKEN.test(token) &&
      !entries.some((entry) => entry.bookingId === bookingId)
    ) {
      entries.push(Object.freeze({ bookingId, token }));
    }
    if (entries.length === MAX_BOOKING_TOKEN_ENTRIES) {
      break;
    }
  }
  return entries;
}

/** The entries with `entry` first: an older entry of its booking removed, the newest five kept. */
export function withBookingToken(
  entries: readonly BookingTokenEntry[],
  entry: BookingTokenEntry,
): BookingTokenEntry[] {
  return [entry, ...entries.filter((other) => other.bookingId !== entry.bookingId)].slice(
    0,
    MAX_BOOKING_TOKEN_ENTRIES,
  );
}

/** The `__Host-vx_bt` value of `entries`: `bkg_<id>.<token>` joined by `~`. Throws a `TypeError` for a bad entry. */
export function formatBookingTokens(entries: readonly BookingTokenEntry[]): string {
  return entries
    .map((entry) => {
      if (!ENTRY_BOOKING_ID.test(entry.bookingId) || !ENTRY_TOKEN.test(entry.token)) {
        throw new TypeError(`an entry of ${STOREFRONT_COOKIES.bookingTokens} must be bkg_<id>.<token>`);
      }
      return `${entry.bookingId}.${entry.token}`;
    })
    .join(BOOKING_TOKEN_SEPARATOR);
}

/** A new CSRF value of the shape the CSRF guard accepts: 32 random bytes in base64url (43 characters). */
export function newCsrfValue(): string {
  return randomBytes(32).toString("base64url");
}

/** True when `value` (a cookie as cookie-parser gives it) is a CSRF value `newCsrfValue` could have written. */
export function isWellFormedCsrfValue(value: unknown): value is string {
  return typeof value === "string" && CSRF_TOKEN_PATTERN.test(value);
}

/** Writes the storefront cookies on a response, for the storefront edge caller only. */
@Injectable()
export class CookieWriter {
  constructor(
    private readonly callers: CallerContext,
    private readonly clock: Clock,
  ) {}

  /** True when the current request comes from the storefront edge, the only caller that gets cookies. */
  isEdge(): boolean {
    return this.callers.get()?.type === "edge";
  }

  /**
   * Appends `Set-Cookie` for `cookie` with `value` and returns true, in edge mode. For any other caller it writes
   * nothing and returns false. `maxAgeSeconds` defaults to the cookie's lifetime in `COOKIE_MAX_AGE_SECONDS`; the
   * refresh token has none and must pass it.
   */
  write(res: Response, cookie: StorefrontCookie, value: string, maxAgeSeconds?: number): boolean {
    if (!this.isEdge()) {
      return false;
    }
    const maxAge = maxAgeSeconds ?? defaultMaxAge(cookie);
    res.append("Set-Cookie", storefrontSetCookie(cookie, value, { maxAgeSeconds: maxAge }));
    return true;
  }

  /** Removes `cookie` from the browser (an empty value with `Max-Age=0`), in edge mode; false for other callers. */
  clear(res: Response, cookie: StorefrontCookie): boolean {
    return this.write(res, cookie, "", 0);
  }

  /**
   * Puts a customer session into cookies, in edge mode: `__Host-vx_at` for 900 s, `__Host-vx_rt` until the end of the
   * refresh family, and (unless `rotateCsrf` is false) a new `__Host-vx_csrf`. Returns false and writes nothing for
   * any other caller, which gets the tokens in the answer body instead. The values are checked before any header is
   * appended, so a refused value never leaves half a session behind.
   */
  setSession(res: Response, tokens: SessionCookieTokens, options: SetSessionOptions = {}): boolean {
    if (!this.isEdge()) {
      return false;
    }
    const refreshMaxAge = secondsUntil(tokens.refreshTokenExpiresAt, this.clock.now());
    const headers = [
      storefrontSetCookie("accessToken", tokens.accessToken, {
        maxAgeSeconds: COOKIE_MAX_AGE_SECONDS.accessToken,
      }),
      storefrontSetCookie("refreshToken", tokens.refreshToken, { maxAgeSeconds: refreshMaxAge }),
    ];
    if (options.rotateCsrf ?? true) {
      headers.push(
        storefrontSetCookie("csrf", newCsrfValue(), { maxAgeSeconds: COOKIE_MAX_AGE_SECONDS.csrf }),
      );
    }
    res.append("Set-Cookie", headers);
    return true;
  }

  /**
   * Adds a guest booking's token to `__Host-vx_bt`, in edge mode: `entry` prepended to the entries of `current` (the
   * cookie the request sent, as cookie-parser gives it), the newest five written for 30 days. Returns false and writes
   * nothing for any other caller, which gets the token in the answer body instead.
   */
  addBookingToken(res: Response, current: unknown, entry: BookingTokenEntry): boolean {
    if (!this.isEdge()) {
      return false;
    }
    const value = formatBookingTokens(withBookingToken(parseBookingTokens(current), entry));
    res.append(
      "Set-Cookie",
      storefrontSetCookie("bookingTokens", value, { maxAgeSeconds: COOKIE_MAX_AGE_SECONDS.bookingTokens }),
    );
    return true;
  }

  /**
   * Ends the customer session in the browser, in edge mode: `__Host-vx_at` and `__Host-vx_rt` removed (`Max-Age=0`)
   * and a new `__Host-vx_csrf`. Returns false and writes nothing for any other caller.
   */
  clearSession(res: Response): boolean {
    if (!this.isEdge()) {
      return false;
    }
    res.append("Set-Cookie", [
      storefrontSetCookie("accessToken", "", { maxAgeSeconds: 0 }),
      storefrontSetCookie("refreshToken", "", { maxAgeSeconds: 0 }),
      storefrontSetCookie("csrf", newCsrfValue(), { maxAgeSeconds: COOKIE_MAX_AGE_SECONDS.csrf }),
    ]);
    return true;
  }
}

function defaultMaxAge(cookie: StorefrontCookie): number {
  if (cookie === "refreshToken") {
    throw new TypeError(
      `${STOREFRONT_COOKIES.refreshToken} has no default Max-Age: pass the family's lifetime`,
    );
  }
  return COOKIE_MAX_AGE_SECONDS[cookie];
}
