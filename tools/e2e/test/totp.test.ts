import { describe, expect, it } from "vitest";
import {
  Authenticator,
  secretFromOtpauthUrl,
  totpCode,
  totpStep,
  type AuthenticatorClock,
} from "../support/totp";

// RFC 6238 appendix B (SHA-1): the secret is the ASCII "12345678901234567890", whose base32 form is below; the
// platform's codes are the last 6 of the RFC's 8 digits.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS: readonly (readonly [number, string])[] = [
  [59, "287082"],
  [1_111_111_109, "081804"],
  [1_111_111_111, "050471"],
  [1_234_567_890, "005924"],
  [2_000_000_000, "279037"],
  [20_000_000_000, "353130"],
];

/** A clock that only moves when the authenticator sleeps. */
function fakeClock(start: number): AuthenticatorClock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe("totpCode", () => {
  it.each(RFC_VECTORS)("gives the RFC 6238 code at %i s", (seconds, code) => {
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(code);
    expect(totpCode(RFC_SECRET, new Date(seconds * 1000))).toBe(code);
  });

  it("ignores spaces, dashes and lower case in the secret, as people type it", () => {
    expect(totpCode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq", 59_000)).toBe("287082");
  });

  it("refuses a secret that is not base32", () => {
    expect(() => totpCode("not a secret!", 0)).toThrow(/base32/);
    expect(() => totpCode("ABC", 0)).toThrow(/at least 16/);
  });
});

describe("secretFromOtpauthUrl", () => {
  it("reads the secret of the set-up URI of startMfaSetup", () => {
    const url =
      "otpauth://totp/Velexis:anna.berg%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Velexis" +
      "&algorithm=SHA1&digits=6&period=30";
    expect(secretFromOtpauthUrl(url)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });

  it("refuses other URIs", () => {
    expect(() => secretFromOtpauthUrl("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP")).toThrow(
      /otpauth:\/\/totp/,
    );
    expect(() => secretFromOtpauthUrl("https://example.com/?secret=JBSWY3DPEHPK3PXP")).toThrow(/otpauth/);
  });
});

describe("Authenticator", () => {
  it("never returns the code of a step twice: the current step, the next one, then it waits", async () => {
    // 10 s into step 100.
    const start = (100 * 30 + 10) * 1000;
    const clock = fakeClock(start);
    const authenticator = new Authenticator(RFC_SECRET, clock);

    const first = await authenticator.nextCode();
    const second = await authenticator.nextCode();
    expect(first).toBe(totpCode(RFC_SECRET, 100 * 30_000));
    expect(second).toBe(totpCode(RFC_SECRET, 101 * 30_000));
    expect(clock.slept).toEqual([]);

    // Steps 100 and 101 are used: step 102 is accepted (±1) once step 101 has begun, 20 s and a bit later.
    const third = await authenticator.nextCode();
    expect(third).toBe(totpCode(RFC_SECRET, 102 * 30_000));
    expect(clock.slept).toEqual([20_050]);
    expect(totpStep(clock.now())).toBe(101);
  });

  it("returns the current step again only after the clock moved past the steps it used", async () => {
    const clock = fakeClock(200 * 30_000);
    const authenticator = new Authenticator(RFC_SECRET, clock);
    await authenticator.nextCode();
    await clock.sleep(5 * 30_000);
    expect(await authenticator.nextCode()).toBe(totpCode(RFC_SECRET, clock.now()));
  });
});
