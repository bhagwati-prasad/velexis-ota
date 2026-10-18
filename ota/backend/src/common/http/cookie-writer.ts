// The storefront cookies of the API (OADR-0006, api-changes §2.3): the hosted storefront calls the API same-origin
// through Caddy, so its sessions and its CSRF value live in host-only `__Host-` cookies of the storefront's own host.
// This is the only code that writes them, and it writes them only for the storefront edge caller: a key caller (a
// third-party frontend or server with a `pk_`/`sk_` key) never gets a `Set-Cookie` (OADR-0006 point 1).
//
//   Cookie            HttpOnly  Max-Age                          Content
//   __Host-vx_at      yes       900 s                            customer access JWT (OBE-033)
//   __Host-vx_rt      yes       the refresh family's lifetime    refresh token (OBE-033)
//   __Host-vx_csrf    no        30 days                          256-bit random, base64url (storefront.get)
//   __Host-vx_bt      yes       30 days                          up to 5 guest booking tokens (OBE-042, OBE-047)
//
// Every cookie is `Secure; SameSite=Lax; Path=/` without `Domain`, which the `__Host-` prefix requires: the browser
// keeps it for the exact host, so a session on `acme.ota.example.com` never reaches another OTA. Only the CSRF value is
// readable by the storefront's JavaScript, which copies it into `X-CSRF-Token` (the CSRF guard compares both).
//
//   if (this.cookies.write(res, "csrf", newCsrfValue())) { … }   // false (and no header) for a key caller
//
// Values are opaque to the browser and are written as they are, so a value is restricted to the characters the
// tokens use (base64url, `.` of JWTs, `~` between guest booking tokens); anything else is refused with an error
// instead of being encoded.
import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { Response } from "express";
import { CallerContext } from "../../tenancy/caller-resolver";
import { CSRF_COOKIE, CSRF_TOKEN_PATTERN } from "../auth/csrf.guard";

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
  constructor(private readonly callers: CallerContext) {}

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
}

function defaultMaxAge(cookie: StorefrontCookie): number {
  if (cookie === "refreshToken") {
    throw new TypeError(
      `${STOREFRONT_COOKIES.refreshToken} has no default Max-Age: pass the family's lifetime`,
    );
  }
  return COOKIE_MAX_AGE_SECONDS[cookie];
}
