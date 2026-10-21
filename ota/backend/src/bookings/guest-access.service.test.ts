// Guest booking tokens and bookings.lookup (OBE-047; ota/docs/flows/my-bookings-and-guest-lookup.md §2, §3 step 8 and
// §4, OADR-0006 points 1, 4 and 6): the token's shape and lifetimes, the name and reference comparison of the lookup,
// the entries of the `__Host-vx_bt` cookie (newest first, at most five), where the booking access guard finds a
// presented token, how a token is handed to the edge and to key callers, the failure counters' keys and replies, the
// one 404 of every mismatch, and the token a replayed 504 hands on. The lookup against PostgreSQL and Redis, and the
// tokens of checkout.complete, are in test/integration/bookings/guest-access.int.test.ts.
import { AppError, toErrorEnvelope } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { Request, Response } from "express";
import { CLS_REQ, type ClsService } from "nestjs-cls";
import { describe, expect, it } from "vitest";
import {
  BOOKING_TOKEN_PATTERN,
  bookingTokenHash,
  presentedBookingTokens,
} from "../common/auth/booking-access.guard";
import {
  CookieWriter,
  formatBookingTokens,
  MAX_BOOKING_TOKEN_ENTRIES,
  parseBookingTokens,
  storefrontSetCookie,
  withBookingToken,
  type BookingTokenEntry,
} from "../common/http/cookie-writer";
import type { RequestContext } from "../common/http/request-context";
import type { Caller, CallerContext } from "../tenancy/caller-resolver";
import { storedBookingTokenOf } from "./booking-orchestrator.service";
import {
  completionTokenExpiry,
  GuestAccessService,
  lastNameMatches,
  lookupCounters,
  LookupAttempts,
  lookupNotFound,
  nameKey,
  newBookingToken,
  NO_BOOKING_TOKEN,
  referenceKey,
  type IssuedBookingToken,
  type LookupRedis,
} from "./guest-access.service";

const NOW = new Date("2026-10-21T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TENANT_ID = "ten_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E";

const EDGE: Caller = Object.freeze({ type: "edge", id: "edge", host: "alpha.ota.example.com" });
const KEY: Caller = Object.freeze({
  type: "key",
  id: "key_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E",
  keyId: "key_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E",
  kind: "secret",
  tenantId: TENANT_ID,
  environment: "test",
  scopes: ["storefront"],
});
const SERVICE: Caller = Object.freeze({ type: "service", id: "service" });

/** Six booking ids, oldest first. */
const BOOKINGS = [
  "bkg_01JA4CH3G1K4N7R0U3X6A9D2F1",
  "bkg_01JA4CH3G1K4N7R0U3X6A9D2F2",
  "bkg_01JA4CH3G1K4N7R0U3X6A9D2F3",
  "bkg_01JA4CH3G1K4N7R0U3X6A9D2F4",
  "bkg_01JA4CH3G1K4N7R0U3X6A9D2F5",
  "bkg_01JA4CH3G1K4N7R0U3X6A9D2F6",
] as const;

const entryOf = (bookingId: string): BookingTokenEntry => ({ bookingId, token: newBookingToken("test") });

/** A response that records what is appended to `Set-Cookie`. */
function recordingResponse(): { readonly res: Response; readonly setCookies: string[] } {
  const setCookies: string[] = [];
  const res = {
    append(name: string, value: string | string[]) {
      expect(name).toBe("Set-Cookie");
      setCookies.push(...(Array.isArray(value) ? value : [value]));
      return res;
    },
  };
  return { res: res as unknown as Response, setCookies };
}

/** The service as `deliver` uses it: the caller, the request of the context and the cookie writer. */
function deliveringService(caller: Caller, req: Partial<Request> | undefined): GuestAccessService {
  const callers = { get: () => caller } as unknown as CallerContext;
  const cls = {
    isActive: () => req !== undefined,
    get: (key: unknown) => (key === CLS_REQ ? req : undefined),
  } as unknown as ClsService;
  const unused = undefined as never;
  return new GuestAccessService(
    unused,
    unused,
    callers,
    { endUser: () => undefined } as unknown as RequestContext,
    new CookieWriter(callers, new FakeClock(NOW)),
    cls,
    unused,
    unused,
    unused,
    unused,
    unused,
    new FakeClock(NOW),
    unused,
    { setContext: () => undefined } as never,
  );
}

const issued = (bookingId: string): IssuedBookingToken => ({
  bookingId,
  token: newBookingToken("test"),
  expiresAt: new Date(NOW.getTime() + DAY_MS),
});

describe("newBookingToken", () => {
  it("is vxbt_<environment>_ and 256 random bits in base64url, of the shape the booking access guard looks up", () => {
    for (const environment of ["test", "live"] as const) {
      const token = newBookingToken(environment);

      expect(token).toMatch(BOOKING_TOKEN_PATTERN);
      expect(token.startsWith(`vxbt_${environment}_`)).toBe(true);
      expect(Buffer.from(token.slice(`vxbt_${environment}_`.length), "base64url")).toHaveLength(32);
    }
    const tokens = new Set(Array.from({ length: 50 }, () => newBookingToken("live")));
    expect(tokens.size).toBe(50);
  });

  it("is stored by its SHA-256 only (hex), never as itself", () => {
    const token = newBookingToken("test");

    expect(bookingTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(bookingTokenHash(token)).not.toContain(token);
  });
});

describe("completionTokenExpiry", () => {
  it("is 30 days for a trip that ends sooner, else 7 days after the last flight lands (the contract's rule)", () => {
    const soon = new Date(NOW.getTime() + 3 * DAY_MS);
    const later = new Date(NOW.getTime() + 90 * DAY_MS);

    expect(completionTokenExpiry(NOW, soon)).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
    expect(completionTokenExpiry(NOW, later)).toEqual(new Date(later.getTime() + 7 * DAY_MS));
    // The token always covers the whole trip.
    expect(completionTokenExpiry(NOW, later).getTime()).toBeGreaterThan(later.getTime());
  });
});

describe("the lookup's comparison", () => {
  it("compares last names case- and accent-insensitively, with any traveller of the booking", () => {
    const candidate = { id: BOOKINGS[0], leadLastName: "ROSSI", lastNames: ["ROSSI", "MULLER", "STRASSE"] };

    for (const typed of ["Rossi", " rossi ", "Müller", "MÜLLER", "muller", "Straße"]) {
      expect(lastNameMatches(candidate, typed)).toBe(true);
    }
    for (const typed of ["Ross", "Bianchi", "", "   ", "Mueller"]) {
      expect(lastNameMatches(candidate, typed)).toBe(false);
    }
    expect(nameKey("  de   la  Cruz ")).toBe("DE LA CRUZ");
  });

  it("falls back to the lead traveller's name of a booking without travellers yet (a pending booking)", () => {
    const pending = { id: BOOKINGS[1], leadLastName: "SAMPLE", lastNames: [] };

    expect(lastNameMatches(pending, "sample")).toBe(true);
    expect(lastNameMatches(pending, "other")).toBe(false);
  });

  it("compares references in upper case, trimmed", () => {
    expect(referenceKey(" vx9m4t ")).toBe("VX9M4T");
  });

  it("[OBE-047 AC1] answers every mismatch with the same 404, whose bodies differ in requestId only [OF-07 AC2]", () => {
    const wrongReference = toErrorEnvelope(lookupNotFound(), "req_wrong_reference", {
      exposeSupplier: false,
    });
    const wrongName = toErrorEnvelope(lookupNotFound(), "req_wrong_name", { exposeSupplier: false });

    expect(wrongReference.status).toBe(404);
    expect(wrongName.status).toBe(404);
    const withoutRequestId = (body: unknown) =>
      JSON.stringify(body).replace(/"requestId":"[^"]*"/, '"requestId":""');
    expect(withoutRequestId(wrongReference.body)).toBe(withoutRequestId(wrongName.body));
  });
});

describe("the entries of __Host-vx_bt", () => {
  it("[OBE-047 AC2] keeps the newest five: a sixth guest booking drops the oldest entry", () => {
    let entries: BookingTokenEntry[] = [];
    const added = BOOKINGS.map(entryOf);
    for (const entry of added) {
      entries = parseBookingTokens(formatBookingTokens(withBookingToken(entries, entry)));
    }

    expect(entries).toHaveLength(MAX_BOOKING_TOKEN_ENTRIES);
    // Newest first; the first booking's entry is gone.
    expect(entries.map((entry) => entry.bookingId)).toEqual([...BOOKINGS].slice(1).reverse());
    expect(entries[0]).toEqual(added[5]);
  });

  it("replaces an older entry of the same booking and moves it to the front", () => {
    const [first, second] = [entryOf(BOOKINGS[0]), entryOf(BOOKINGS[1])];
    const again = entryOf(BOOKINGS[0]);

    const entries = withBookingToken(withBookingToken([first], second), again);

    expect(entries).toEqual([again, second]);
  });

  it("reads entries as bkg_<id>.<token> joined by ~, ignoring malformed ones, duplicates and any beyond the fifth", () => {
    const valid = BOOKINGS.map(entryOf);
    const value = [
      "garbage",
      `${valid[0]?.bookingId}.${valid[0]?.token}`,
      `not_a_booking.${valid[1]?.token}`,
      `${valid[0]?.bookingId}.${newBookingToken("test")}`,
      `${valid[1]?.bookingId}.`,
      `${valid[2]?.bookingId}.tok%en`,
      ...valid.slice(1).map((entry) => `${entry.bookingId}.${entry.token}`),
    ].join("~");

    const entries = parseBookingTokens(value);

    expect(entries.map((entry) => entry.bookingId)).toEqual([...BOOKINGS].slice(0, 5));
    expect(entries[0]).toEqual(valid[0]);
    expect(parseBookingTokens(undefined)).toEqual([]);
    expect(parseBookingTokens(["an", "array"])).toEqual([]);
    expect(parseBookingTokens("")).toEqual([]);
  });

  it("[OBE-047 AC2] fits in one HttpOnly cookie with five entries of either environment", () => {
    const value = formatBookingTokens(
      BOOKINGS.slice(0, 5).map((bookingId) => ({ bookingId, token: newBookingToken("live") })),
    );

    const header = storefrontSetCookie("bookingTokens", value, { maxAgeSeconds: 30 * 24 * 60 * 60 });

    expect(header).toMatch(
      /^__Host-vx_bt=bkg_[^;]+; Max-Age=2592000; Path=\/; Secure; SameSite=Lax; HttpOnly$/,
    );
    expect(() => formatBookingTokens([{ bookingId: "bkg_bad", token: "x" }])).toThrow(TypeError);
  });
});

describe("presentedBookingTokens", () => {
  const [bookingA, bookingB] = [BOOKINGS[0], BOOKINGS[1]];
  const tokenA = newBookingToken("test");
  const tokenB = newBookingToken("test");
  const cookie = formatBookingTokens([
    { bookingId: bookingB, token: tokenB },
    { bookingId: bookingA, token: tokenA },
  ]);

  it("[OBE-047 AC3] picks the edge's cookie entry of the requested booking only, never another booking's token", () => {
    const req = {
      headers: { "x-booking-token": tokenB },
      cookies: { "__Host-vx_bt": cookie },
    };

    expect(presentedBookingTokens(req, EDGE, bookingA)).toEqual([tokenA]);
    expect(presentedBookingTokens(req, EDGE, bookingB)).toEqual([tokenB]);
    // No entry for the booking: nothing is presented (the guard answers 401 and the page offers the lookup).
    expect(presentedBookingTokens(req, EDGE, BOOKINGS[2])).toEqual([]);
  });

  it("[OBE-047 AC3] takes a key caller's X-Booking-Token and ignores cookies, which only the edge has", () => {
    const req = { headers: { "x-booking-token": ` ${tokenB} ` }, cookies: { "__Host-vx_bt": cookie } };

    expect(presentedBookingTokens(req, KEY, bookingA)).toEqual([tokenB]);
    expect(
      presentedBookingTokens({ headers: {}, cookies: { "__Host-vx_bt": cookie } }, KEY, bookingA),
    ).toEqual([]);
    expect(presentedBookingTokens(req, SERVICE, bookingA)).toEqual([]);
  });

  it("drops values that are not of the issued shape, so nothing else is looked up", () => {
    for (const value of [
      "",
      "vxbt_test_short",
      `${tokenA}x`,
      `vxbt_prod_${tokenA.slice(10)}`,
      [tokenA, tokenB],
    ]) {
      expect(presentedBookingTokens({ headers: { "x-booking-token": value } }, KEY, bookingA)).toEqual([]);
    }
  });
});

describe("GuestAccessService.deliver", () => {
  it("[OBE-047 AC2] puts the edge's token in the HttpOnly __Host-vx_bt cookie, prepended to the request's entries, and none in the body", () => {
    const older = entryOf(BOOKINGS[0]);
    const { res, setCookies } = recordingResponse();
    const req = { res, cookies: { "__Host-vx_bt": formatBookingTokens([older]) } };
    const token = issued(BOOKINGS[1]);

    const delivered = deliveringService(EDGE, req).deliver(token);

    expect(delivered).toEqual(NO_BOOKING_TOKEN);
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toBe(
      storefrontSetCookie(
        "bookingTokens",
        `${BOOKINGS[1]}.${token.token}~${older.bookingId}.${older.token}`,
        { maxAgeSeconds: 30 * 24 * 60 * 60 },
      ),
    );
    expect(setCookies[0]).toContain("; HttpOnly");
  });

  it("gives a key caller the token in the body and never a Set-Cookie", () => {
    const { res, setCookies } = recordingResponse();
    const token = issued(BOOKINGS[2]);

    const delivered = deliveringService(KEY, { res, cookies: {} }).deliver(token);

    expect(delivered).toEqual({
      bookingToken: token.token,
      bookingTokenExpiresAt: token.expiresAt.toISOString(),
    });
    expect(setCookies).toEqual([]);
  });

  it("refuses to hand an edge token out without a request to answer", () => {
    expect(() => deliveringService(EDGE, undefined).deliver(issued(BOOKINGS[3]))).toThrow(
      "outside a request",
    );
  });
});

describe("the failed-lookup counters", () => {
  it("count per end-user IP and per tenant and reference, under throttler keys that hold neither in clear", () => {
    const counters = lookupCounters({
      caller: EDGE,
      tenantId: TENANT_ID,
      ip: "203.0.113.7",
      reference: "VX9M4T",
    });

    expect(counters.ip.key).toMatch(/^rl:ota_lookup_ip:[0-9a-f]{64}$/);
    expect(counters.reference.key).toMatch(/^rl:ota_lookup_reference:[0-9a-f]{64}$/);
    expect(counters.ip.ttlSeconds).toBe(15 * 60);
    expect(counters.reference.ttlSeconds).toBe(15 * 60);
    // Five failures per window on each (architecture §8).
    expect([counters.ip.limit, counters.reference.limit]).toEqual([5, 5]);
    expect(`${counters.ip.key}${counters.reference.key}`).not.toMatch(/203\.0\.113\.7|VX9M4T/);
    // Another tenant's reference is another counter; the same visitor is the same one.
    const other = lookupCounters({
      caller: EDGE,
      tenantId: "ten_01J9ZQ4V6W8X0Y2Z4A6B8C0D2F",
      ip: "203.0.113.7",
      reference: "VX9M4T",
    });
    expect(other.reference.key).not.toBe(counters.reference.key);
    expect(other.ip.key).toBe(counters.ip.key);
  });

  it("[OBE-047 AC1] answers taken, or refused with the seconds left, and refuses with 503 when Redis cannot answer", async () => {
    const counters = lookupCounters({
      caller: KEY,
      tenantId: TENANT_ID,
      ip: "198.51.100.2",
      reference: "VX9M4T",
    });
    const attemptsWith = (eval_: LookupRedis["eval"]) => new LookupAttempts({ eval: eval_ } as LookupRedis);
    const calls: unknown[][] = [];
    const recording = attemptsWith(((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve([1, 0]);
    }) as LookupRedis["eval"]);

    await expect(recording.take(counters)).resolves.toEqual({ taken: true });
    // Each counter with its own window (ms) and limit, in the order of KEYS.
    expect(calls[0]?.slice(1)).toEqual([
      2,
      counters.ip.key,
      counters.reference.key,
      "900000",
      "5",
      "900000",
      "5",
    ]);
    // A counter of another window and limit is counted by its own, never by the other one's.
    await recording.take({
      ip: { ...counters.ip, ttlSeconds: 60, limit: 3 },
      reference: counters.reference,
    });
    expect(calls[1]?.slice(4)).toEqual(["60000", "3", "900000", "5"]);
    await expect(
      attemptsWith((() => Promise.resolve([0, 120_400])) as LookupRedis["eval"]).take(counters),
    ).resolves.toEqual({ taken: false, retryAfterSeconds: 121 });
    for (const failing of [
      () => Promise.resolve("OK"),
      () => Promise.reject(new Error("connection is closed")),
    ]) {
      const error: unknown = await attemptsWith(failing as LookupRedis["eval"])
        .take(counters)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("SERVICE_UNAVAILABLE");
    }
  });
});

describe("the token of a replayed 504", () => {
  it("is the one the first answer's details gave a key caller, and none otherwise", () => {
    const timeout = (details: Record<string, unknown>) => ({
      status: 504,
      headers: {},
      setCookie: [],
      body: { error: { code: "SUPPLIER_TIMEOUT", details } },
    });
    const token = newBookingToken("test");
    const expiresAt = new Date(NOW.getTime() + 30 * DAY_MS).toISOString();

    expect(
      storedBookingTokenOf(
        timeout({ bookingId: BOOKINGS[0], bookingToken: token, bookingTokenExpiresAt: expiresAt }),
      ),
    ).toEqual({ bookingToken: token, bookingTokenExpiresAt: expiresAt });
    expect(
      storedBookingTokenOf(
        timeout({ bookingId: BOOKINGS[0], bookingToken: null, bookingTokenExpiresAt: null }),
      ),
    ).toEqual(NO_BOOKING_TOKEN);
    expect(storedBookingTokenOf({ status: 504, headers: {}, setCookie: [], body: "not json" })).toEqual(
      NO_BOOKING_TOKEN,
    );
  });
});
