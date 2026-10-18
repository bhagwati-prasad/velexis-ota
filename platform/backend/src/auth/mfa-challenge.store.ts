// The MFA challenges of the sign-in (PBE-014; platform/docs/flows/signup-and-create-ota.md step 4, PADR-0008 item 4,
// architecture §6.4): when the password of an account with MFA is right, `signIn` answers a challenge token instead of
// a session, and `verifyMfa` (PBE-015) completes it with a TOTP or recovery code within 5 minutes and 5 attempts.
//
// The challenge lives only in Redis, as `mfach:<sha256(token)>` with the builder's 5-minute TTL (redis-keys.ts): the
// token itself (`mfa_` + 256 random bits, base64url) is handed out once and never stored, logged or audited
// (`mfaChallengeToken` is on the logger's redaction list). The value is JSON `{v: 1, audience, accountId, issuedAt,
// maxAttempts}`: `audience` keeps a portal challenge out of the admin's `adminVerifyMfa` (PBE-028) and the reverse.
// A challenge also ends at `issuedAt` + 5 minutes by the service's Clock, whatever Redis still holds, so its lifetime
// follows the FakeClock in tests.
//
// verifyMfa (PBE-015) counts the codes tried against a challenge in `mfach:<sha256(token)>:attempts` (`recordAttempt`,
// one atomic increment per attempt, so concurrent attempts cannot exceed the limit) and ends the challenge after
// `maxAttempts` wrong codes or a success (`delete`, which tells whether this call ended it: of two concurrent
// successes only one gets a session).
//
// AuthController's verifyMfa and stepUp are carried out by AccountsModule's MfaService (PBE-015), which owns the TOTP
// secrets and recovery codes and imports AuthModule for these challenges, the sign-in and the sessions. AuthModule
// depends only on the abstract `MfaVerification` below, which the global AccountsModule provides, as MembershipsModule
// provides TenantMembershipLookup to CommonModule's guard (architecture §2.2).
//
// Redis is required: while it is down, `create` fails and the sign-in of an account with MFA fails (architecture §9).
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { Clock } from "../common/clock";
import {
  incrementInWindow,
  MFA_CHALLENGE_TTL_SECONDS,
  redisKeys,
  setKeyIfAbsent,
} from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { SessionAudience } from "./sessions.repository";
import type { PortalSession } from "./sessions.service";
import type { AccessTokenClaims } from "./token.service";

export type VerifyMfaRequest = components["schemas"]["VerifyMfaRequest"];
export type TotpCodeRequest = components["schemas"]["TotpCodeRequest"];

/**
 * verifyMfa and stepUp, as AuthController calls them: implemented by AccountsModule's MfaService (PBE-015; see the
 * file header).
 */
export abstract class MfaVerification {
  /** verifyMfa: completes a portal sign-in challenge with a TOTP or recovery code and answers the session. */
  abstract verifyMfa(request: VerifyMfaRequest): Promise<PortalSession>;

  /** stepUp: a fresh TOTP code of the caller answers a new session of the same family with `mfa_at` now. */
  abstract stepUp(token: AccessTokenClaims, request: TotpCodeRequest): Promise<PortalSession>;
}

/**
 * `429 RATE_LIMITED` of verifyMfa, counted by the service rather than a guard (the account is known only from the
 * challenge), with the seconds the controller answers as `Retry-After`.
 */
export class MfaRateLimitedError extends AppError<"RATE_LIMITED"> {
  constructor(readonly retryAfterSeconds: number) {
    super("RATE_LIMITED");
  }
}

/** Wrong codes a challenge allows before it ends (PADR-0008 item 4). */
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

/** The prefix of challenge tokens (`mfa_…`). */
export const MFA_CHALLENGE_TOKEN_PREFIX = "mfa";

/** The longest token `find` looks up: the `OpaqueToken` schema's `maxLength`. */
const MAX_TOKEN_LENGTH = 512;

/** A stored challenge. */
export interface MfaChallenge {
  readonly v: 1;
  /** The sign-in it continues: the portal's `signIn` or the admin's `adminSignIn`. */
  readonly audience: SessionAudience;
  /** `acc_…` whose password was right. */
  readonly accountId: string;
  /** When the challenge was issued, epoch milliseconds (Clock). */
  readonly issuedAt: number;
  /** Wrong codes allowed before the challenge ends. */
  readonly maxAttempts: number;
}

/** A new challenge as `signIn` answers it (`MfaChallenge` of the document, without `mfaRequired`). */
export interface IssuedMfaChallenge {
  /** The challenge token, handed out once. */
  readonly token: string;
  /** Seconds until it expires (300). */
  readonly expiresIn: number;
}

const ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;

/** True for a string that may be a challenge token: not empty and at most the `OpaqueToken` length. */
function isTokenShaped(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
}

/** The challenge stored in `text`, or `undefined` for anything that is not one. */
export function parseMfaChallenge(text: string | null): MfaChallenge | undefined {
  if (text === null) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const { v, audience, accountId, issuedAt, maxAttempts } = value as Record<string, unknown>;
  if (
    v !== 1 ||
    (audience !== "portal" && audience !== "platform_admin") ||
    typeof accountId !== "string" ||
    !ACCOUNT_ID.test(accountId) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(maxAttempts) ||
    (maxAttempts as number) < 1
  ) {
    return undefined;
  }
  return {
    v,
    audience,
    accountId,
    issuedAt: issuedAt as number,
    maxAttempts: maxAttempts as number,
  };
}

@Injectable()
export class MfaChallengeStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    private readonly clock: Clock,
  ) {}

  /** Stores a new challenge of `accountId` for `audience` and returns its token (see the file header). */
  async create(accountId: string, audience: SessionAudience): Promise<IssuedMfaChallenge> {
    if (!ACCOUNT_ID.test(accountId)) {
      throw new TypeError("MfaChallengeStore.create: accountId must be an acc_ id");
    }
    const { token, hash } = generateToken(MFA_CHALLENGE_TOKEN_PREFIX);
    const challenge: MfaChallenge = {
      v: 1,
      audience,
      accountId,
      issuedAt: this.clock.now().getTime(),
      maxAttempts: MFA_CHALLENGE_MAX_ATTEMPTS,
    };
    // NX: a 256-bit token never repeats; if it ever did, no challenge of someone else would be overwritten.
    if (!(await setKeyIfAbsent(this.client, redisKeys.mfaChallenge(hash), JSON.stringify(challenge)))) {
      throw new Error("MfaChallengeStore.create: the challenge key exists already");
    }
    return { token, expiresIn: MFA_CHALLENGE_TTL_SECONDS };
  }

  /**
   * The unexpired challenge of `token`, or `undefined` for an unknown, expired (by Redis's TTL or the Clock) or ended
   * one.
   */
  async find(token: string): Promise<MfaChallenge | undefined> {
    if (!isTokenShaped(token)) {
      return undefined;
    }
    const challenge = parseMfaChallenge(await this.client.get(redisKeys.mfaChallenge(sha256Hex(token)).key));
    if (
      challenge === undefined ||
      this.clock.now().getTime() >= challenge.issuedAt + MFA_CHALLENGE_TTL_SECONDS * 1000
    ) {
      return undefined;
    }
    return challenge;
  }

  /**
   * Counts one code tried against the challenge of `token` and returns how many were tried so far, this one included
   * (`mfach:<sha256>:attempts`, living as long as a challenge can).
   */
  async recordAttempt(token: string): Promise<number> {
    if (!isTokenShaped(token)) {
      throw new TypeError("MfaChallengeStore.recordAttempt: not a challenge token");
    }
    const { hits } = await incrementInWindow(this.client, redisKeys.mfaChallengeAttempts(sha256Hex(token)));
    return hits;
  }

  /**
   * Ends the challenge of `token` (after a success, or after its last wrong code). Returns `true` when this call
   * ended it, `false` when it had ended already (or never existed).
   */
  async delete(token: string): Promise<boolean> {
    if (!isTokenShaped(token)) {
      return false;
    }
    return (await this.client.del(redisKeys.mfaChallenge(sha256Hex(token)).key)) === 1;
  }
}
