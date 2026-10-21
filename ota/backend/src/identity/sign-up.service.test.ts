// The pure parts of sign-up and e-mail verification (OBE-032): the published legal versions, the customer's locale
// and currency, the idempotency hooks of auth.signUp, the masked address of the answers, the states of a
// verification token and where a resend sends it. The operations themselves run against PostgreSQL, Redis and
// Mailpit in test/integration/identity/sign-up.int.test.ts.
import { describe, expect, it } from "vitest";
import type { Clock } from "../common/clock";
import type { IdempotencyRecord } from "../common/http/idempotency.service";
import { maskedAddress } from "./customers.mapper";
import {
  legalVersionsOf,
  SIGN_UP_SESSION_REPLAY_MS,
  SignUpIdempotencyHooks,
  signUpCurrency,
  signUpLocale,
} from "./sign-up.service";
import { emailInstant, resendTarget, tokenState } from "./verification.service";

const SEEDED = new Date("2026-03-04T05:06:07.000Z");

describe("legalVersionsOf", () => {
  it("[OBE-032] publishes the stored versions, else the day the settings were seeded, as storefront.get does", () => {
    expect(
      legalVersionsOf({ termsVersion: " 2026-09-01 ", privacyVersion: null, createdAt: SEEDED }),
    ).toEqual({
      termsVersion: "2026-09-01",
      privacyVersion: "2026-03-04",
    });
    expect(legalVersionsOf({ termsVersion: "", privacyVersion: "x".repeat(41), createdAt: SEEDED })).toEqual({
      termsVersion: "2026-03-04",
      privacyVersion: "2026-03-04",
    });
  });
});

describe("signUpLocale and signUpCurrency", () => {
  const settings = {
    defaultLocale: "en",
    supportedLocales: ["en", "fr-FR"],
    defaultCurrency: "EUR",
    supportedCurrencies: ["EUR", "GBP"],
  };

  it("takes the body's locale, else Accept-Language's, among the storefront's, else its default", () => {
    expect(signUpLocale(settings, "fr-FR", "en")).toBe("fr-FR");
    expect(signUpLocale(settings, "fr", undefined)).toBe("fr-FR");
    expect(signUpLocale(settings, "en-GB", undefined)).toBe("en");
    expect(signUpLocale(settings, undefined, "fr-CA,fr;q=0.9")).toBe("fr-FR");
    expect(signUpLocale(settings, "de", "de-DE")).toBe("en");
  });

  it("takes the body's currency when the storefront sells in it, else its default", () => {
    expect(signUpCurrency(settings, "GBP")).toBe("GBP");
    expect(signUpCurrency(settings, "USD")).toBe("EUR");
    expect(signUpCurrency(settings, undefined)).toBe("EUR");
  });
});

describe("SignUpIdempotencyHooks", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const hooks = new SignUpIdempotencyHooks({ now: () => now } as Clock);

  /** A stored sign-up made `ageMs` before now. */
  function record(ageMs: number, status: "completed" | "failed" = "completed"): IdempotencyRecord {
    const createdAt = new Date(now.getTime() - ageMs);
    return {
      id: "idk_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
      operationId: "signUp",
      scope: "test:key_01JA2Z9W5K7Q3M8N4P6R2T0V1X:signUp",
      status,
      response: {
        status: 201,
        headers: { location: "/v1/account" },
        setCookie: ["__Host-vx_at=a; Path=/"],
        body: { customer: { id: "cus_1" }, session: { accessToken: "a" }, emailVerification: {} },
      },
      resource: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(createdAt.getTime() + 86_400_000),
    };
  }

  it("[OBE-032] hashes the body without the password, with the address normalised", () => {
    const hashed = hooks.hashInput({
      path: {},
      query: {},
      body: { email: " Anna.Berg@Example.com ", password: "Fjord-Lantern-Quiet-42", firstName: "Anna" },
    });

    expect(hashed).toEqual({
      path: {},
      query: {},
      body: { email: "anna.berg@example.com", firstName: "Anna" },
    });
    expect(JSON.stringify(hashed)).not.toContain("Fjord");
  });

  it("[OBE-032] replays the session for 5 minutes, then the customer with session null and no cookies", async () => {
    expect(await hooks.resolveReplay(record(SIGN_UP_SESSION_REPLAY_MS))).toBeUndefined();
    expect(await hooks.resolveReplay(record(SIGN_UP_SESSION_REPLAY_MS + 1, "failed"))).toBeUndefined();

    const later = await hooks.resolveReplay(record(SIGN_UP_SESSION_REPLAY_MS + 1));

    expect(later).toEqual({
      status: 201,
      headers: { location: "/v1/account" },
      setCookie: [],
      body: { customer: { id: "cus_1" }, session: null, emailVerification: {} },
    });
  });
});

describe("maskedAddress", () => {
  it("[OBE-032] keeps the first character of each part of the local part and the domain", () => {
    expect(maskedAddress("anna.berg@example.com")).toBe("a***.b***@example.com");
    expect(maskedAddress("a@example.com")).toBe("a***@example.com");
    expect(maskedAddress("anna+travel@mail.example.com")).toBe("a***@mail.example.com");
  });
});

describe("tokenState", () => {
  const sent = new Date("2026-10-21T10:00:00.000Z");
  const expires = new Date("2026-10-22T10:00:00.000Z");

  it("[OBE-032] is used once the address was verified at or after the token was issued, and expires at its end", () => {
    const fresh = { emailVerifiedAt: null, tokenSentAt: sent, tokenExpiresAt: expires };
    expect(tokenState(fresh, new Date("2026-10-22T09:59:59.999Z"))).toBe("valid");
    expect(tokenState(fresh, expires)).toBe("expired");
    expect(tokenState({ ...fresh, tokenExpiresAt: null }, sent)).toBe("expired");
    expect(tokenState({ ...fresh, emailVerifiedAt: sent }, sent)).toBe("used");
    // An earlier verification (the old address of a pending change) does not use a newer token.
    expect(tokenState({ ...fresh, emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z") }, sent)).toBe(
      "valid",
    );
  });

  it("shows the expiry in e-mails as whole seconds in UTC", () => {
    expect(emailInstant(new Date("2026-11-02T10:00:00.123Z"))).toBe("2026-11-02T10:00:00Z");
  });
});

describe("resendTarget", () => {
  const unverified = { email: "Anna.Berg@example.com", email_verified_at: null, pending_email: null };
  const verified = { ...unverified, email_verified_at: new Date("2026-10-21T10:00:00.000Z") };

  it("[OBE-032] sends a signed-in customer's link to its pending address, else to its unverified address", () => {
    expect(resendTarget(unverified, undefined)).toEqual({ to: "Anna.Berg@example.com" });
    expect(resendTarget(verified, undefined)).toEqual({ outcome: "verified" });
    expect(resendTarget({ ...verified, pending_email: "anna@new.example.com" }, undefined)).toEqual({
      to: "anna@new.example.com",
    });
    expect(resendTarget({ ...unverified, pending_email: "anna@new.example.com" }, undefined)).toEqual({
      to: "anna@new.example.com",
    });
  });

  it("[OBE-032] sends an anonymous call's link only to the named, unverified address without a pending change", () => {
    expect(resendTarget(unverified, " anna.berg@EXAMPLE.com")).toEqual({ to: "Anna.Berg@example.com" });
    expect(resendTarget(verified, "anna.berg@example.com")).toEqual({ outcome: "verified" });
    // The identity's token would confirm the pending address, so the current address's mailbox gets none.
    expect(
      resendTarget({ ...unverified, pending_email: "anna@new.example.com" }, "anna.berg@example.com"),
    ).toEqual({ outcome: "pending_change" });
  });
});
