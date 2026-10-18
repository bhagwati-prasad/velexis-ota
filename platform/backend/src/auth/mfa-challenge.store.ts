// The MFA challenges of the sign-in (PBE-014; platform/docs/flows/signup-and-create-ota.md step 4, PADR-0008 item 4,
// architecture §6.4): when the password of an account with MFA is right, `signIn` answers a challenge token instead of
// a session, and `verifyMfa` (PBE-015) completes it with a TOTP or recovery code within 5 minutes and 5 attempts.
//
// The challenge lives only in Redis, as `mfach:<sha256(token)>` with the builder's 5-minute TTL (redis-keys.ts): the
// token itself (`mfa_` + 256 random bits, base64url) is handed out once and never stored, logged or audited
// (`mfaChallengeToken` is on the logger's redaction list). The value is JSON `{v: 1, audience, accountId, issuedAt,
// maxAttempts}`: `audience` keeps a portal challenge out of the admin's `adminVerifyMfa` (PBE-028) and the reverse.
// PBE-015 counts the attempts and ends the challenge after `maxAttempts` wrong codes or a success (`delete`).
//
// Redis is required: while it is down, `create` fails and the sign-in of an account with MFA fails (architecture §9).
import { Inject, Injectable } from "@nestjs/common";
import { generateToken, sha256Hex } from "@velexis/crypto";
import type { Redis } from "ioredis";
import { Clock } from "../common/clock";
import { MFA_CHALLENGE_TTL_SECONDS, redisKeys, setKeyIfAbsent } from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { SessionAudience } from "./sessions.repository";

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

  /** The unexpired challenge of `token`, or `undefined` for an unknown, expired or ended one. */
  async find(token: string): Promise<MfaChallenge | undefined> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return undefined;
    }
    return parseMfaChallenge(await this.client.get(redisKeys.mfaChallenge(sha256Hex(token)).key));
  }

  /** Ends the challenge of `token` (after a success, or after its last wrong code). */
  async delete(token: string): Promise<void> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return;
    }
    await this.client.del(redisKeys.mfaChallenge(sha256Hex(token)).key);
  }
}
