// The idempotency key of a form's next submission after a failed call (OADR-0018 point 5, revisions of 2026-10-27,
// FIX-W31-OTA, and 2026-10-28, FIX-W32-OTA): which failures use the key up (the OTA API stored the answer under it),
// and which keep it, so a retry replays or waits for the first request (`409 IDEMPOTENCY_KEY_REUSED` among them since
// 2026-10-28: a reload instead of a new key). The server actions and the dialogs are tested through the SDK
// in app/(console)/bookings/[bookingId]/actions.test.ts and in the DOM in components/confirm-dialog.test.tsx.
import { describe, expect, it } from "vitest";

import {
  actionFailure,
  actionKeyAfter,
  keepsActionKey,
  withNextActionKey,
  type KeyedCallFailure,
} from "./action-state";

const failure = (status: number, code: string, details?: Record<string, unknown>): KeyedCallFailure => ({
  status,
  code,
  ...(details === undefined ? {} : { details }),
});

describe("keepsActionKey", () => {
  it("[FIX-W31-OTA AC2] uses the key up after a final 4xx the API stores under it", () => {
    for (const used of [
      failure(400, "VALIDATION_FAILED"),
      failure(402, "PAYMENT_DECLINED"),
      failure(403, "FEATURE_DISABLED", { feature: "consoleCardPayment" }),
      failure(404, "NOT_FOUND"),
      failure(409, "BOOKING_NOT_MODIFIABLE", { reason: "ticketing_in_progress" }),
      failure(409, "CONFLICT", { reason: "payment_not_capturable" }),
      failure(410, "OFFER_EXPIRED"),
      failure(422, "UNPROCESSABLE", { reason: "amount_exceeds_captured" }),
      failure(424, "SUPPLIER_NOT_CONFIGURED"),
    ]) {
      expect(keepsActionKey(used), `${used.status} ${used.code}`).toBe(false);
    }
  });

  it("[FIX-W31-OTA AC2] keeps it after 412, 429, a request still running under the key, any 5xx, a timeout and a network error", () => {
    for (const kept of [
      failure(412, "PRECONDITION_FAILED", { currentVersion: 4 }),
      failure(429, "RATE_LIMITED"),
      failure(409, "CONFLICT", { reason: "idempotency_key_in_use" }),
      failure(500, "INTERNAL_ERROR"),
      failure(502, "PAYMENT_PROVIDER_ERROR"),
      failure(503, "SERVICE_UNAVAILABLE"),
      failure(504, "SUPPLIER_TIMEOUT"),
      failure(0, "TIMEOUT"),
      failure(0, "NETWORK_ERROR"),
    ]) {
      expect(keepsActionKey(kept), `${kept.status} ${kept.code}`).toBe(true);
    }
  });
});

describe("409 IDEMPOTENCY_KEY_REUSED (OADR-0018 point 5, revision of 2026-10-28)", () => {
  it("[FIX-W32-OTA AC3] keeps the key: an earlier request under it may still be running, so no new key is handed", () => {
    const reused = failure(409, "IDEMPOTENCY_KEY_REUSED");
    expect(keepsActionKey(reused)).toBe(true);
    const state = actionFailure("Reload the page.", { code: "IDEMPOTENCY_KEY_REUSED" });
    const next = () => "5d4c3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
    expect(withNextActionKey(state, reused, next)).toBe(state);
    const current = "0b6c9a1e-2f3d-4c5b-8a79-6e5d4c3b2a10";
    expect(actionKeyAfter(current, withNextActionKey(state, reused, next))).toBe(current);
  });
});

describe("withNextActionKey and actionKeyAfter", () => {
  it("[FIX-W31-OTA AC2] adds a new key to the state of a failure that used the key up, and nothing otherwise", () => {
    const state = actionFailure("The amount is above what can still be refunded.", { code: "UNPROCESSABLE" });
    const keys = ["5d4c3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d"];
    const next = () => keys.shift() ?? "";

    expect(withNextActionKey(state, failure(422, "UNPROCESSABLE"), next)).toEqual({
      ...state,
      nextActionKey: "5d4c3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
    });
    expect(withNextActionKey(state, failure(503, "SERVICE_UNAVAILABLE"), next)).toBe(state);
    // Without a key generator of its own, a random UUID v4 (crypto.randomUUID on the server).
    expect(withNextActionKey(state, failure(400, "VALIDATION_FAILED")).nextActionKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("[FIX-W31-OTA AC2] sends the state's new key next, else the current one", () => {
    const current = "0b6c9a1e-2f3d-4c5b-8a79-6e5d4c3b2a10";
    expect(actionKeyAfter(current, { ok: false, nextActionKey: "next-key" })).toBe("next-key");
    expect(actionKeyAfter(current, { ok: false, code: "SERVICE_UNAVAILABLE" })).toBe(current);
    expect(actionKeyAfter(current, {})).toBe(current);
  });
});
