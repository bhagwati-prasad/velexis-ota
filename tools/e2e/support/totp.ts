// TOTP codes for the accounts of a journey (PFE-014), as an authenticator app computes them: SHA-1, 6 digits, 30-second
// steps, the parameters of the platform's MFA set-up (`startMfaSetup` in platform/backend/openapi, PADR-0008).
//
//   const secret = secretFromOtpauthUrl(otpauthUrl);       // or the base32 secret shown for manual entry
//   await page.getByLabel(/code/i).fill(totpCode(secret));
//
// The platform accepts each code once and the codes of the previous and next steps (±1). A journey that needs several
// codes for one account in a row (enable MFA, sign in, step up) uses an `Authenticator`, which never hands out the same
// step twice: the current step, then the next one, then it waits for the clock.
import { authenticator } from "otplib";

/** The step length of the platform's TOTP, in seconds. */
export const TOTP_PERIOD_SECONDS = 30;
/** The number of digits of a code. */
export const TOTP_DIGITS = 6;

/** otplib's authenticator (base32 secrets) with the platform's parameters; `clone` never changes the shared one. */
const PLATFORM_TOTP = authenticator.clone({ step: TOTP_PERIOD_SECONDS, digits: TOTP_DIGITS, window: 0 });

const BASE32 = /^[A-Z2-7]+=*$/;

function normaliseSecret(secret: string): string {
  const normalised = secret.replace(/[\s-]/g, "").toUpperCase();
  if (normalised.length < 16 || !BASE32.test(normalised)) {
    throw new TypeError("a TOTP secret is base32 (A-Z, 2-7) and at least 16 characters long");
  }
  return normalised;
}

/** The time step of `at` (milliseconds since the epoch). */
export function totpStep(at: number): number {
  return Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code of `secret` (base32, spaces and dashes ignored) at `at` (default: now). */
export function totpCode(secret: string, at: Date | number = Date.now()): string {
  const epoch = typeof at === "number" ? at : at.getTime();
  return PLATFORM_TOTP.clone({ epoch }).generate(normaliseSecret(secret));
}

/** The base32 secret of an `otpauth://totp/…?secret=…` URI (the QR code of the MFA set-up page). */
export function secretFromOtpauthUrl(otpauthUrl: string): string {
  const url = new URL(otpauthUrl);
  const secret = url.searchParams.get("secret");
  if (url.protocol !== "otpauth:" || url.hostname !== "totp" || secret === null) {
    throw new TypeError("not an otpauth://totp/ URI with a secret");
  }
  return normaliseSecret(secret);
}

/** The clock and the wait of an `Authenticator`; unit tests pass fake ones. */
export interface AuthenticatorClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: AuthenticatorClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * One account's authenticator app. `nextCode()` returns a code for a step it has not returned before: the current
 * step, else the next one (inside the platform's ±1 window), else it waits until the clock reaches a usable step
 * (at most one step, 30 s).
 */
export class Authenticator {
  private lastStep = Number.NEGATIVE_INFINITY;
  readonly secret: string;

  constructor(
    secret: string,
    private readonly clock: AuthenticatorClock = REAL_CLOCK,
  ) {
    this.secret = normaliseSecret(secret);
  }

  async nextCode(): Promise<string> {
    for (;;) {
      const now = this.clock.now();
      const current = totpStep(now);
      const step = Math.max(current, this.lastStep + 1);
      if (step <= current + 1) {
        this.lastStep = step;
        return totpCode(this.secret, step * TOTP_PERIOD_SECONDS * 1000);
      }
      // Both the current and the next step are used up: wait for the next step to begin.
      await this.clock.sleep((current + 1) * TOTP_PERIOD_SECONDS * 1000 - now + 50);
    }
  }
}
