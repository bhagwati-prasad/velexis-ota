// Staff refresh de-duplication (OADR-0018 point 3, README §4). A staff refresh token rotates: the backend revokes
// the whole family when a rotated token is presented again (`401 REFRESH_TOKEN_REUSED`, OADR-0011 point 2). One
// browser sends several requests at the same moment (navigation, prefetches, parallel server actions), and each may
// carry the same old token, so every refresh of the OTA admin goes through `dedupRefresh`: the first request with a
// token calls the API; every request with the same token while that call is pending, or within 30 s after it
// settled, gets the same outcome (the same new tokens) without a second call.
//
// - The map is keyed by the token's SHA-256, so it never holds a token as a key; it lives in this Node.js process
//   (one admin process on the single VM, ADR-0007). It is kept on `globalThis` under a registered symbol, so the
//   middleware's bundle and the app's bundles of one process share it.
// - A success and a refusal that ends the session (`final`) are kept for 30 s. A failure that may pass (rate limit,
//   API unavailable, network) is forgotten as soon as it settles, so the next request may try again; the SDK has
//   already retried the call with its idempotency key, which the backend replays.
import "server-only";

import { createHash } from "node:crypto";

import type { ConsoleStaffSession } from "@velexis/ota-sdk";

/** How long a settled refresh is reused for the same token, in ms. */
export const REFRESH_REUSE_MS = 30_000;

/**
 * Codes after which the refresh token can never work again: the admin clears the cookies and sends the staff member
 * to the portal (README §4 point 4). Other failures keep the session for a later attempt.
 */
export const FINAL_REFRESH_ERROR_CODES: ReadonlySet<string> = new Set([
  "REFRESH_TOKEN_INVALID",
  "REFRESH_TOKEN_REUSED",
  "STAFF_MEMBERSHIP_INACTIVE",
  "TENANT_SUSPENDED",
  "UNAUTHENTICATED",
  "VALIDATION_FAILED",
]);

/** The outcome of one refresh, shared by every request that presented the same token. */
export type StaffRefreshOutcome =
  | { readonly ok: true; readonly session: ConsoleStaffSession }
  | { readonly ok: false; readonly final: boolean; readonly error: unknown };

/** The API call of a refresh: `console.auth.refresh({ refreshToken })` through the SDK. */
export type StaffRefreshCall = (refreshToken: string) => Promise<ConsoleStaffSession>;

/** The de-duplicated refresh: `call` runs only for the first request with a token. */
export type DedupRefresh = (refreshToken: string, call: StaffRefreshCall) => Promise<StaffRefreshOutcome>;

/** One refresh in the map. */
export interface RefreshFlight {
  readonly outcome: Promise<StaffRefreshOutcome>;
  /** Epoch ms after which the flight is forgotten; infinite while the call is pending. */
  expiresAt: number;
}

/** The map key of a refresh token: its SHA-256 in hex, so the map never holds a token. */
export function refreshTokenKey(refreshToken: string): string {
  return createHash("sha256").update(refreshToken, "utf8").digest("hex");
}

/** `error` is a refusal after which the refresh token can never work again. */
export function isFinalRefreshError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" && FINAL_REFRESH_ERROR_CODES.has(code);
}

async function settle(call: StaffRefreshCall, refreshToken: string): Promise<StaffRefreshOutcome> {
  try {
    return { ok: true, session: await call(refreshToken) };
  } catch (error) {
    return { ok: false, final: isFinalRefreshError(error), error };
  }
}

/** Options of `createRefreshDedup`; the defaults are those of the process-wide `dedupRefresh`. */
export interface RefreshDedupOptions {
  /** The clock, epoch ms. */
  readonly now?: () => number;
  /** How long a settled outcome is reused, ms. */
  readonly reuseMs?: number;
  /** The map of flights (a fresh one by default; tests inspect it). */
  readonly flights?: Map<string, RefreshFlight>;
}

/** A de-duplicated refresh with its own map (tests); the admin uses `dedupRefresh`. */
export function createRefreshDedup(options: RefreshDedupOptions = {}): DedupRefresh {
  const { now = Date.now, reuseMs = REFRESH_REUSE_MS, flights = new Map<string, RefreshFlight>() } = options;

  function forgetExpired(at: number): void {
    for (const [key, flight] of flights) {
      if (flight.expiresAt <= at) {
        flights.delete(key);
      }
    }
  }

  return (refreshToken, call) => {
    forgetExpired(now());
    const key = refreshTokenKey(refreshToken);
    const existing = flights.get(key);
    if (existing !== undefined) {
      return existing.outcome;
    }
    const outcome = settle(call, refreshToken);
    const flight: RefreshFlight = { outcome, expiresAt: Number.POSITIVE_INFINITY };
    flights.set(key, flight);
    void outcome.then((settled) => {
      if (settled.ok || settled.final) {
        flight.expiresAt = now() + reuseMs;
      } else if (flights.get(key) === flight) {
        flights.delete(key);
      }
    });
    return outcome;
  };
}

/** The registered symbol of the process-wide map (shared by the middleware's and the app's bundles). */
const FLIGHTS_KEY = Symbol.for("velexis.ota-admin.staff-refresh-flights");

function processFlights(): Map<string, RefreshFlight> {
  const store = globalThis as typeof globalThis & { [FLIGHTS_KEY]?: Map<string, RefreshFlight> };
  store[FLIGHTS_KEY] ??= new Map<string, RefreshFlight>();
  return store[FLIGHTS_KEY];
}

/** The refresh de-duplication of this admin process: every staff refresh goes through it. */
export const dedupRefresh: DedupRefresh = createRefreshDedup({ flights: processFlights() });
