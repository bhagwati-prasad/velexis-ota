// TOTP MFA of portal accounts (PBE-015; scope PF-04, platform/docs/api-inventory.md §4 and §5, PADR-0008 "MFA",
// ADR-0008, ADR-0010): the set-up, enabling, the sign-in challenge, the step-up, disabling and the recovery codes.
//
// - TOTP (PADR-0008 item 1): `otplib`'s authenticator, SHA-1, 6 digits, 30-second steps, codes of the step before and
//   after accepted (±1). The time is the service's Clock. A code is accepted once per account: the time step of every
//   accepted code is kept in `mfastep:<accountId>` (90 s, `setKeyIfHigher`), and a code of that step or an earlier one
//   is refused, whichever operation used it (enable, verifyMfa, stepUp).
// - startMfaSetup (`portal_unverified`): a new 160-bit secret, envelope-encrypted with the associated data
//   `redis.mfasetup.totp_secret:<accountId>` into `mfasetup:<accountId>` for 10 minutes (with its creation time, so
//   the Clock ends it too), replacing an earlier pending one. The answer carries the base32 secret and the
//   `otpauth://` URI once, with `Cache-Control: no-store`. `409 MFA_ALREADY_ENABLED` while MFA is on.
// - enableMfa (`portal_unverified`): a valid code of the pending secret moves it into
//   `accounts.mfa_secret_ciphertext` (associated data `platform.accounts.mfa_secret_ciphertext:<id>`), turns MFA on
//   (`mfa_enabled_at`, `version + 1`), replaces the recovery codes with ten new ones, queues `auth.mfa_changed`, audits
//   `account.mfa_enabled` and publishes an `account` invalidation, in one transaction; then the pending secret is
//   removed (best effort: a Redis failure is logged as `mfa.setup_cleanup_failed`, and the set-up can no longer be
//   used anyway). The ten codes are answered once. A missing or expired set-up answers `400 MFA_SETUP_EXPIRED`.
// - verifyMfa (`public`): the challenge of `signIn` (MfaChallengeStore) with a TOTP code or an unused recovery code.
//   An unknown, expired or ended challenge answers `401 MFA_CHALLENGE_INVALID`. Every attempt counts against the
//   account's `mfa` limit (10 per 10 minutes, shared with stepUp; `429 RATE_LIMITED` with `Retry-After`) and against
//   the challenge: a wrong code answers `401 MFA_CODE_INVALID` and is audited (`auth.sign_in_failed`), the fifth wrong
//   code ends the challenge, so the next attempt answers `MFA_CHALLENGE_INVALID`. A valid code ends the challenge and
//   starts the portal family with `mfa_verified_at` = now (`SignInService.startSession`, which audits
//   `auth.sign_in`); a recovery code is used up first (`used_at`, audited `auth.recovery_code_used`). An account that
//   may no longer sign in or has no MFA any more ends the challenge (`MFA_CHALLENGE_INVALID`).
// - stepUp (`portal`, `mfa` limit by the guard): a valid TOTP code (recovery codes are for sign-in only) rotates the
//   caller's family with `mfa_verified_at` = now (SessionsService.stepUp); `403 MFA_REQUIRED` without MFA, `401
//   MFA_CODE_INVALID` for a wrong or replayed code.
// - disableMfa and regenerateRecoveryCodes (`portal`, `x-mfa-step-up`: RecentMfaGuard has checked MFA and a step-up
//   within 15 minutes): a platform admin cannot turn MFA off (`403 FORBIDDEN`, `details.reason = "platform_admin"`,
//   PADR-0006). Disabling clears the secret and every recovery code; regenerating replaces the codes. Both queue
//   `auth.mfa_changed` (PADR-0008 item 6) and audit; disabling publishes an `account` invalidation.
//
// Recovery codes (PADR-0008 item 3): 16 Crockford base32 characters (80 bits) shown as `XXXX-XXXX-XXXX-XXXX`; a code
// is typed in any letter case, with or without dashes and spaces (O reads as 0, I and L as 1), and stored only as the
// SHA-256 of its 16 normalised characters. The TOTP secret, the codes and the recovery codes are never logged,
// audited, queued or stored in clear; audit rows hold counts and the method only.
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { authenticator } from "otplib";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { AccountsRepository, type MfaAccount } from "../auth/accounts.repository";
import {
  MfaChallengeStore,
  MfaRateLimitedError,
  MfaVerification,
  type MfaChallenge,
  type TotpCodeRequest,
  type VerifyMfaRequest,
} from "../auth/mfa-challenge.store";
import { maySignIn, SessionsService, type PortalSession } from "../auth/sessions.service";
import { SignInService } from "../auth/sign-in.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { EnvelopeService, type CiphertextPlace } from "../common/crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import {
  RATE_LIMITS,
  RateLimitStoreUnavailableError,
  RedisThrottlerStorage,
  trackerDigest,
} from "../common/http/throttler.config";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { MFA_SETUP_TTL_SECONDS, redisKeys, setKey, setKeyIfHigher } from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { OutboxService } from "../notifications/outbox.service";
import { RecoveryCodesRepository } from "./recovery-codes.repository";

export type MfaSetup = components["schemas"]["MfaSetup"];
export type RecoveryCodes = components["schemas"]["RecoveryCodes"];

/** The issuer shown by authenticator apps (the `otpauth://` label and `issuer`). */
export const TOTP_ISSUER = "Velexis";
/** The step of a code, in seconds (PADR-0008 item 1). */
export const TOTP_STEP_SECONDS = 30;
/** The digits of a code. */
export const TOTP_DIGITS = 6;
/** The steps accepted before and after the current one. */
export const TOTP_WINDOW = 1;
/** The size of a TOTP secret: 160 bits, as RFC 4226 recommends (32 base32 characters). */
export const TOTP_SECRET_BYTES = 20;
/** The recovery codes of one set (PADR-0008 item 3). */
export const RECOVERY_CODE_COUNT = 10;
/** The characters of a recovery code: Crockford's base32 (no I, L, O, U). */
export const RECOVERY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The random bytes of a recovery code: 80 bits, 16 base32 characters. */
const RECOVERY_CODE_BYTES = 10;
const RECOVERY_CODE_LENGTH = 16;

/** otplib's authenticator (base32 secrets) with the platform's parameters; `clone` never changes the shared one. */
const PLATFORM_TOTP = authenticator.clone({
  step: TOTP_STEP_SECONDS,
  digits: TOTP_DIGITS,
  window: TOTP_WINDOW,
});

/** A new TOTP secret in base32 (160 bits). */
export function generateTotpSecret(): string {
  return PLATFORM_TOTP.generateSecret(TOTP_SECRET_BYTES);
}

/** The `otpauth://totp/Velexis:<email>?secret=…` URI of `secret` for the QR code. */
export function otpauthUrl(email: string, secret: string): string {
  return PLATFORM_TOTP.keyuri(email, TOTP_ISSUER, secret);
}

/** The TOTP time step of `at`. */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The code of `secret` at `at` (tests and the development seed; never logged). */
export function totpCode(secret: string, at: Date): string {
  return PLATFORM_TOTP.clone({ epoch: at.getTime() }).generate(secret);
}

/**
 * The time step whose code `code` is for `secret` at `at`: the current step or the one before or after it; `undefined`
 * when the code is none of them (or not six digits).
 */
export function matchTotp(secret: string, code: string, at: Date): number | undefined {
  if (!/^[0-9]{6}$/.test(code)) {
    return undefined;
  }
  const delta = PLATFORM_TOTP.clone({ epoch: at.getTime() }).checkDelta(code, secret);
  return delta === null ? undefined : totpStep(at) + delta;
}

/** A new recovery code: 80 random bits as four groups of four Crockford base32 characters. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  let encoded = "";
  for (let index = 0; index < RECOVERY_CODE_LENGTH; index += 1) {
    encoded = `${RECOVERY_CODE_ALPHABET[Number(value & 31n)] ?? "0"}${encoded}`;
    value >>= 5n;
  }
  bytes.fill(0);
  return encoded.match(/.{4}/g)?.join("-") ?? encoded;
}

/** `RECOVERY_CODE_COUNT` distinct new recovery codes. */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    codes.add(generateRecoveryCode());
  }
  return [...codes];
}

/**
 * The 16 characters a typed recovery code stands for: dashes and spaces dropped, upper case, O read as 0 and I and L
 * as 1 (Crockford); `undefined` for anything that cannot be a code.
 */
export function normaliseRecoveryCode(input: string): string | undefined {
  const normalised = input.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  if (normalised.length !== RECOVERY_CODE_LENGTH) {
    return undefined;
  }
  for (const character of normalised) {
    if (!RECOVERY_CODE_ALPHABET.includes(character)) {
      return undefined;
    }
  }
  return normalised;
}

/** The stored hash of a recovery code as shown or typed: SHA-256 of its normalised characters. */
export function recoveryCodeHash(code: string): string | undefined {
  const normalised = normaliseRecoveryCode(code);
  return normalised === undefined ? undefined : sha256Hex(normalised);
}

/** A pending set-up as `mfasetup:<accountId>` holds it. */
export interface PendingMfaSetup {
  readonly v: 1;
  /** The envelope of the base32 secret, base64. */
  readonly ciphertext: string;
  /** When the set-up started, epoch milliseconds (Clock). */
  readonly createdAt: number;
}

/** The pending set-up stored in `text`, or `undefined` for anything that is not one. */
export function parsePendingMfaSetup(text: string | null): PendingMfaSetup | undefined {
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
  const { v, ciphertext, createdAt } = value as Record<string, unknown>;
  if (v !== 1 || typeof ciphertext !== "string" || ciphertext === "" || !Number.isSafeInteger(createdAt)) {
    return undefined;
  }
  return { v, ciphertext, createdAt: createdAt as number };
}

/** The place of a pending secret in Redis, for the envelope's associated data. */
export function pendingSecretPlace(accountId: string): CiphertextPlace {
  return { schema: "redis", table: "mfasetup", column: "totp_secret", rowId: accountId };
}

/** The place of an account's TOTP secret, for the envelope's associated data. */
export function accountSecretPlace(accountId: string): CiphertextPlace {
  return { table: "accounts", column: "mfa_secret_ciphertext", rowId: accountId };
}

/** The `change` line of the `auth.mfa_changed` e-mail. */
export const MFA_CHANGES = Object.freeze({
  enabled: "it was turned on",
  disabled: "it was turned off",
  recoveryCodes: "new recovery codes were created, and the earlier ones no longer work",
});

/** How a verifyMfa attempt proved the second factor. */
type MfaMethod = "totp" | "recovery_code";

@Injectable()
export class MfaService implements MfaVerification {
  private readonly throttle: RedisThrottlerStorage;

  constructor(
    private readonly accounts: AccountsRepository,
    private readonly recoveryCodes: RecoveryCodesRepository,
    private readonly challenges: MfaChallengeStore,
    private readonly signIns: SignInService,
    private readonly sessions: SessionsService,
    private readonly envelope: EnvelopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly publisher: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectPinoLogger(MfaService.name) private readonly logger: PinoLogger,
  ) {
    this.throttle = new RedisThrottlerStorage(redis);
  }

  /** startMfaSetup (see the file header). */
  async startSetup(accountId: string): Promise<MfaSetup> {
    const account = await this.existingAccount(accountId);
    if (account.mfa_enabled) {
      throw new AppError("MFA_ALREADY_ENABLED");
    }
    const secret = generateTotpSecret();
    const { ciphertext } = await this.envelope.encrypt(secret, pendingSecretPlace(accountId));
    const pending: PendingMfaSetup = {
      v: 1,
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      createdAt: this.clock.now().getTime(),
    };
    await setKey(this.redis, redisKeys.mfaSetup(accountId), JSON.stringify(pending));
    return { secret, otpauthUrl: otpauthUrl(account.email, secret), expiresIn: MFA_SETUP_TTL_SECONDS };
  }

  /** enableMfa (see the file header). */
  async enable(accountId: string, request: TotpCodeRequest): Promise<RecoveryCodes> {
    const setupKey = redisKeys.mfaSetup(accountId);
    const pending = parsePendingMfaSetup(await this.redis.get(setupKey.key));
    const now = this.clock.now();
    if (pending === undefined || now.getTime() >= pending.createdAt + MFA_SETUP_TTL_SECONDS * 1000) {
      throw new AppError("MFA_SETUP_EXPIRED");
    }
    const account = await this.existingAccount(accountId);
    const secret = await this.envelope.decrypt(
      Buffer.from(pending.ciphertext, "base64"),
      pendingSecretPlace(accountId),
    );
    try {
      if (!(await this.acceptTotp(accountId, secret.toString("utf8"), request.code, now))) {
        throw new AppError("MFA_CODE_INVALID");
      }
      const stored = await this.envelope.encrypt(secret, accountSecretPlace(accountId));
      const codes = generateRecoveryCodes();
      await runInTransaction(this.db, async (trx) => {
        await this.accounts.lockMfaAccount(trx, accountId);
        // MFA turned on meanwhile (a concurrent enable of the same set-up): this set-up is used up.
        if (
          !(await this.accounts.enableMfa(trx, accountId, {
            secretCiphertext: stored.ciphertext,
            kekId: stored.kekId,
            now,
          }))
        ) {
          throw new AppError("MFA_SETUP_EXPIRED");
        }
        await this.recoveryCodes.replaceAll(trx, accountId, codes.map(hashOf), now);
        await this.notify(trx, account, MFA_CHANGES.enabled);
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "account.mfa_enabled",
          targetType: "account",
          targetId: accountId,
          after: { mfaEnabled: true, mfaEnabledAt: now.toISOString() },
          details: { recoveryCodeCount: codes.length },
        });
        this.publisher.publishAfterCommit(trx, { v: 1, type: "account", accountId });
      });
      // MFA is on: enableMfa refuses this set-up from now on and its TTL ends it, so removing it is clean-up. A Redis
      // failure here is logged and must not cost the person the ten codes they have not seen yet.
      await this.redis.del(setupKey.key).catch((error: unknown) => {
        this.logger.warn({ err: error }, "mfa.setup_cleanup_failed");
      });
      return { recoveryCodes: codes };
    } finally {
      secret.fill(0);
    }
  }

  /** disableMfa (see the file header): RecentMfaGuard has checked MFA and the step-up. */
  async disable(accountId: string): Promise<void> {
    await runInTransaction(this.db, async (trx) => {
      const account = await this.accounts.lockMfaAccount(trx, accountId);
      if (account === undefined || account.deleted_at !== null) {
        throw new AppError("UNAUTHENTICATED");
      }
      if (account.is_platform_admin) {
        throw new AppError("FORBIDDEN", { details: { reason: "platform_admin" } });
      }
      const now = this.clock.now();
      if (!(await this.accounts.disableMfa(trx, accountId, now))) {
        throw new AppError("MFA_REQUIRED");
      }
      const removed = await this.recoveryCodes.deleteAll(trx, accountId);
      await this.notify(trx, account, MFA_CHANGES.disabled);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "account.mfa_disabled",
        targetType: "account",
        targetId: accountId,
        before: { mfaEnabled: true },
        after: { mfaEnabled: false },
        details: { recoveryCodesRemoved: removed },
      });
      this.publisher.publishAfterCommit(trx, { v: 1, type: "account", accountId });
    });
  }

  /** regenerateRecoveryCodes (see the file header): RecentMfaGuard has checked MFA and the step-up. */
  async regenerateRecoveryCodes(accountId: string): Promise<RecoveryCodes> {
    const codes = generateRecoveryCodes();
    await runInTransaction(this.db, async (trx) => {
      const account = await this.accounts.lockMfaAccount(trx, accountId);
      if (account === undefined || account.deleted_at !== null) {
        throw new AppError("UNAUTHENTICATED");
      }
      if (!account.mfa_enabled) {
        throw new AppError("MFA_REQUIRED");
      }
      const now = this.clock.now();
      await this.recoveryCodes.replaceAll(trx, accountId, codes.map(hashOf), now);
      await this.notify(trx, account, MFA_CHANGES.recoveryCodes);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "account.recovery_codes_regenerated",
        targetType: "account",
        targetId: accountId,
        details: { recoveryCodeCount: codes.length },
      });
    });
    return { recoveryCodes: codes };
  }

  /** verifyMfa (see the file header). */
  async verifyMfa(request: VerifyMfaRequest): Promise<PortalSession> {
    const token = request.mfaChallengeToken;
    const challenge = await this.challenges.find(token);
    if (challenge?.audience !== "portal") {
      throw new AppError("MFA_CHALLENGE_INVALID");
    }
    const { accountId } = challenge;
    await this.countAccountAttempt(accountId);
    const attempt = await this.challenges.recordAttempt(token);
    if (attempt > challenge.maxAttempts) {
      await this.challenges.delete(token);
      throw new AppError("MFA_CHALLENGE_INVALID");
    }
    const account = await this.accounts.findMfaAccount(this.db, accountId);
    if (
      account === undefined ||
      account.deleted_at !== null ||
      !maySignIn(account.status) ||
      !account.mfa_enabled ||
      account.mfa_secret_ciphertext === null
    ) {
      await this.challenges.delete(token);
      throw new AppError("MFA_CHALLENGE_INVALID");
    }
    const now = this.clock.now();
    const method: MfaMethod = "code" in request ? "totp" : "recovery_code";
    const verified =
      "code" in request
        ? await this.acceptAccountTotp(account, request.code, now)
        : await this.useRecoveryCode(accountId, request.recoveryCode, now);
    if (!verified) {
      await this.recordWrongCode(challenge, method, attempt);
      if (attempt >= challenge.maxAttempts) {
        await this.challenges.delete(token);
      }
      throw new AppError("MFA_CODE_INVALID");
    }
    // Of two concurrent successes with one challenge, only the one that ends it gets a session.
    if (!(await this.challenges.delete(token))) {
      throw new AppError("MFA_CHALLENGE_INVALID");
    }
    return this.signIns.startSession(accountId, { mfaVerifiedAt: now });
  }

  /** stepUp (see the file header): `token` is the caller's verified access token. */
  async stepUp(token: AccessTokenClaims, request: TotpCodeRequest): Promise<PortalSession> {
    const account = await this.existingAccount(token.sub);
    if (!account.mfa_enabled || account.mfa_secret_ciphertext === null) {
      throw new AppError("MFA_REQUIRED");
    }
    const now = this.clock.now();
    if (!(await this.acceptAccountTotp(account, request.code, now))) {
      throw new AppError("MFA_CODE_INVALID");
    }
    return this.sessions.stepUp(token.sub, token.sid, now);
  }

  /** The account behind an access token; `401 UNAUTHENTICATED` when it is gone (erased) since the token was issued. */
  private async existingAccount(accountId: string): Promise<MfaAccount> {
    const account = await this.accounts.findMfaAccount(this.db, accountId);
    if (account === undefined || account.deleted_at !== null) {
      throw new AppError("UNAUTHENTICATED");
    }
    return account;
  }

  /** True when `code` is a valid, unused TOTP code of the account's stored secret at `now` (and now used). */
  private async acceptAccountTotp(account: MfaAccount, code: string, now: Date): Promise<boolean> {
    if (account.mfa_secret_ciphertext === null) {
      return false;
    }
    const secret = await this.envelope.decrypt(account.mfa_secret_ciphertext, accountSecretPlace(account.id));
    try {
      return await this.acceptTotp(account.id, secret.toString("utf8"), code, now);
    } finally {
      secret.fill(0);
    }
  }

  /**
   * True when `code` is a code of `secret` within ±1 step of `now` whose step is later than every step the account
   * used before; the step is then recorded (`mfastep:<accountId>`), so the code works once.
   */
  private async acceptTotp(accountId: string, secret: string, code: string, now: Date): Promise<boolean> {
    const step = matchTotp(secret, code, now);
    if (step === undefined) {
      return false;
    }
    return setKeyIfHigher(this.redis, redisKeys.totpLastStep(accountId), step);
  }

  /** Uses up the unused recovery code `code` of `accountId` (audited); false when it is not one. */
  private async useRecoveryCode(accountId: string, code: string, now: Date): Promise<boolean> {
    const codeHash = recoveryCodeHash(code);
    if (codeHash === undefined) {
      return false;
    }
    return runInTransaction(this.db, async (trx) => {
      if (!(await this.recoveryCodes.use(trx, accountId, codeHash, now))) {
        return false;
      }
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "auth.recovery_code_used",
        targetType: "account",
        targetId: accountId,
        details: { recoveryCodesLeft: await this.recoveryCodes.countUnused(trx, accountId) },
      });
      return true;
    });
  }

  /** Audits a wrong code against a challenge: the method and the attempt, never the code. */
  private async recordWrongCode(challenge: MfaChallenge, method: MfaMethod, attempt: number): Promise<void> {
    await runInTransaction(this.db, async (trx) => {
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: challenge.accountId,
        action: "auth.sign_in_failed",
        targetType: "account",
        targetId: challenge.accountId,
        details: { reason: "invalid_mfa_code", method, attempt, maxAttempts: challenge.maxAttempts },
      });
    });
  }

  /**
   * Counts one verifyMfa attempt against the account's `mfa` limit (10 per 10 minutes, the bucket stepUp's guard
   * counts too): `429 RATE_LIMITED` over it, `503 SERVICE_UNAVAILABLE` while Redis cannot count (the limit refuses).
   */
  private async countAccountAttempt(accountId: string): Promise<void> {
    const limit = RATE_LIMITS.mfa;
    const windowMs = limit.windowSeconds * 1000;
    let counted;
    try {
      counted = await this.throttle.increment(
        trackerDigest(limit.by, accountId),
        windowMs,
        limit.limit,
        windowMs,
        limit.name,
      );
    } catch (error) {
      if (error instanceof RateLimitStoreUnavailableError) {
        throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
      }
      throw error;
    }
    if (counted.isBlocked) {
      throw new MfaRateLimitedError(counted.timeToBlockExpire);
    }
  }

  /** Queues `auth.mfa_changed` to the account in `trx`. */
  private async notify(
    trx: PlatformTransaction,
    account: Pick<MfaAccount, "id" | "email" | "full_name">,
    change: string,
  ): Promise<void> {
    await this.outbox.queue(trx, {
      templateKey: "auth.mfa_changed",
      to: account.email,
      accountId: account.id,
      data: { fullName: account.full_name, change },
    });
  }
}

/** The stored hash of a code this service generated. */
function hashOf(code: string): string {
  const hash = recoveryCodeHash(code);
  if (hash === undefined) {
    throw new Error("MfaService: a generated recovery code does not normalise");
  }
  return hash;
}
