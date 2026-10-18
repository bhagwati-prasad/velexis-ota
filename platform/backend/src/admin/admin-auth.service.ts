// The platform admin's sign-in and sessions (PBE-028; PADR-0006 "Access", PADR-0009 item 4,
// platform/docs/api-inventory-admin.md §1 and §2, platform/docs/flows/platform-admin-operations.md §A, scope PF-80).
// Accounts are the portal's (`is_platform_admin` on `accounts`); the admin has its own sign-in, its own refresh
// families and its own audience:
//
// - adminSignIn: the portal's password step (SignInService.verifyPassword: the same lockout, the same failure count
//   and the same Argon2id work for an unknown address; a wrong password is audited as `admin.sign_in_failed`). After
//   a correct password, an account that is not an `active` platform admin answers the same `401 INVALID_CREDENTIALS`
//   as a wrong password, and a platform admin without MFA `403 MFA_REQUIRED` (both audited as
//   `admin.sign_in_failed`, with the reason). Otherwise the answer is always an MFA challenge of the `platform_admin`
//   audience (5 minutes, 5 attempts): a TOTP or recovery code is required on every admin sign-in (PADR-0006 item 2).
// - adminVerifyMfa: the code checks of the portal's verifyMfa (MfaService.verifyChallenge with the `platform_admin`
//   audience: a portal challenge is refused, the account's `mfa` limit, one use per TOTP step, recovery codes used
//   up), then, in one transaction: the failure count cleared and `last_login_at` set, the first row of a refresh
//   family with `audience = 'platform_admin'`, a 12-hour absolute end (`family_expires_at`) and `mfa_verified_at` =
//   the time of the code, and the audit row `admin.sign_in` (`actor_type = 'platform_admin'`). It answers
//   `AdminSession`.
// - adminRefresh rotates on use, exactly as the portal's refreshSession does, but only `platform_admin` families: a
//   portal refresh token answers `401 REFRESH_TOKEN_INVALID` and changes nothing (and the portal refuses admin
//   tokens). A rotated token presented again revokes the family (`401 REFRESH_TOKEN_REUSED`). Each refresh token
//   expires after 2 idle hours and never after the family's end, so no admin session outlives its 12 hours. An
//   account that is no longer an active platform admin with MFA cannot refresh.
// - adminStepUp: a fresh TOTP code (MfaService.verifyStepUpCode, the portal's rules) rotates the current generation
//   of the caller's admin family with `mfa_verified_at` = now, so the new access token carries `mfa_at` = now for the
//   step-up operations (RecentMfaGuard, 15 minutes).
// - adminSignOut revokes the admin family of the presented refresh token when it is the caller's; anything else
//   changes nothing (`204` either way). adminGetMe answers the admin and the milestone switches (`featuresFor()`,
//   PADR-0015).
//
// Access tokens: audience `platform_admin`, `ev = true`, `amr = ["pwd","otp"]`, `mfa_at` from the family. The locks
// are those of the portal's sessions (sessions.service.ts): the account's `FOR KEY SHARE` lock, then the family's
// first row, then the presented row. AdminAuthGuard re-reads `is_platform_admin` and `status` on every admin request,
// so a revoked admin loses access at once. Tokens, passwords and codes are never logged, audited or stored in clear.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError, isAppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { MfaService } from "../accounts/mfa.service";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { AccountsRepository, type MfaAccount } from "../auth/accounts.repository";
import type { TotpCodeRequest, VerifyMfaRequest } from "../auth/mfa-challenge.store";
import { SessionsRepository, type SessionRecord } from "../auth/sessions.repository";
import {
  authMethodsOf,
  mfaAtOf,
  REFRESH_TOKEN_PREFIX,
  refreshTokenExpiry,
  refreshVerdict,
  type IssuedRefreshToken,
  type RefreshSessionRequest,
  type SignOutRequest,
} from "../auth/sessions.service";
import {
  AccountLockedError,
  lockoutRetryAfter,
  SignInService,
  type SignInRequest,
} from "../auth/sign-in.service";
import { TokenService, type AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches } from "../common/features";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { runInTransaction } from "../common/redis/invalidation.publisher";

export type AdminSession = components["schemas"]["AdminSession"];
export type AdminMe = components["schemas"]["AdminMe"];
export type AdminMfaChallenge = components["schemas"]["AdminMfaChallenge"];
export type { RefreshSessionRequest, SignInRequest, SignOutRequest, TotpCodeRequest, VerifyMfaRequest };

const HOUR_MS = 60 * 60 * 1000;

/** The absolute lifetime of an admin family (PADR-0006 item 1, PADR-0009 item 4). */
export const ADMIN_FAMILY_TTL_MS = 12 * HOUR_MS;

/** The idle expiry of one admin refresh token (PADR-0009 item 4). */
export const ADMIN_REFRESH_TOKEN_TTL_MS = 2 * HOUR_MS;

/** The longest refresh token looked up: the `OpaqueToken` schema's `maxLength`. */
const MAX_REFRESH_TOKEN_LENGTH = 512;

/** The account fields an admin session needs: who it is, and whether it may still hold an admin session. */
type AdminAccount = Pick<
  MfaAccount,
  "id" | "email" | "full_name" | "status" | "is_platform_admin" | "mfa_enabled" | "deleted_at"
>;

/** True when `account` is an `active` platform admin (not erased): the only accounts the admin lets in. */
export function isActiveAdmin<A extends Pick<MfaAccount, "status" | "is_platform_admin" | "deleted_at">>(
  account: A | undefined,
): account is A {
  return (
    account !== undefined &&
    account.deleted_at === null &&
    account.status === "active" &&
    account.is_platform_admin
  );
}

/** True when `account` may hold an admin session: an active platform admin with MFA on (PADR-0006 item 2). */
export function mayHoldAdminSession<A extends AdminAccount>(account: A | undefined): account is A {
  return isActiveAdmin(account) && account.mfa_enabled;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly signIns: SignInService,
    private readonly mfa: MfaService,
    private readonly accounts: AccountsRepository,
    private readonly sessions: SessionsRepository,
    private readonly tokens: TokenService,
    private readonly features: FeatureSwitches,
    private readonly audit: AuditService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly context: RequestContext,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(AdminAuthService.name) private readonly logger: PinoLogger,
  ) {}

  /** adminSignIn (see the file header). */
  async signIn(request: SignInRequest): Promise<AdminMfaChallenge> {
    const account = await this.signIns.verifyPassword(request, "platform_admin");
    const admin = await this.accounts.findMfaAccount(this.db, account.id);
    if (!isActiveAdmin(admin)) {
      await this.recordRefusal(account.id, { reason: "not_active_platform_admin" });
      throw new AppError("INVALID_CREDENTIALS");
    }
    if (!admin.mfa_enabled) {
      await this.recordRefusal(account.id, { reason: "mfa_not_enabled" });
      throw new AppError("MFA_REQUIRED");
    }
    const issued = await this.signIns.issueChallenge(account.id, "platform_admin");
    return { mfaChallengeToken: issued.token, expiresIn: issued.expiresIn };
  }

  /** adminVerifyMfa (see the file header). */
  async verifyMfa(request: VerifyMfaRequest): Promise<AdminSession> {
    const { accountId, verifiedAt } = await this.mfa.verifyChallenge(request, "platform_admin");
    return runInTransaction(this.db, async (trx) => {
      const now = this.clock.now();
      if (!(await this.accounts.recordSignIn(trx, accountId, now, { signedIn: true }))) {
        // Five wrong passwords since the challenge was issued locked the account: the code does not unlock it.
        const lockedUntil = await this.accounts.lockedUntil(trx, accountId);
        throw new AccountLockedError(lockoutRetryAfter(lockedUntil ?? now, now));
      }
      const account = await this.accounts.findMfaAccount(trx, accountId);
      if (!mayHoldAdminSession(account)) {
        throw new AppError("MFA_CHALLENGE_INVALID");
      }
      const issued = await this.startFamily(trx, accountId, verifiedAt, now);
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: accountId,
        action: "admin.sign_in",
        targetType: "session",
        targetId: issued.familyId,
        details: { audience: "platform_admin", method: "code" in request ? "totp" : "recovery_code" },
      });
      return this.adminSession(issued, account);
    });
  }

  /** adminRefresh (see the file header). */
  async refresh(refreshToken: string): Promise<AdminSession> {
    if (refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    const tokenHash = sha256Hex(refreshToken);
    const outcome = await runInTransaction(
      this.db,
      async (trx): Promise<{ readonly session: AdminSession } | { readonly reused: SessionRecord }> => {
        const seen = await this.sessions.findByTokenHash(trx, tokenHash);
        if (seen?.audience !== "platform_admin") {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        await this.accounts.lockForSessionChange(trx, seen.account_id);
        await this.sessions.lockFamily(trx, seen.family_id);
        // Read again under the locks: a rotation or revocation that committed meanwhile is seen now.
        const row = await this.sessions.lockByTokenHash(trx, tokenHash);
        const now = this.clock.now();
        const verdict = row === undefined ? "invalid" : refreshVerdict(row, now, "platform_admin");
        if (row === undefined || verdict === "invalid") {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        if (verdict === "reused") {
          await this.sessions.revokeFamily(trx, row.family_id, "rotation_reuse", now);
          return { reused: row };
        }
        const account = await this.accounts.findMfaAccount(trx, row.account_id);
        if (!mayHoldAdminSession(account)) {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        const issued = await this.rotate(trx, row, now);
        return { session: await this.adminSession(issued, account) };
      },
    );
    if ("reused" in outcome) {
      // Ids only: the token is never logged.
      this.logger.warn(
        {
          accountId: outcome.reused.account_id,
          familyId: outcome.reused.family_id,
          audience: "platform_admin",
        },
        "auth.refresh_token_reused",
      );
      throw new AppError("REFRESH_TOKEN_REUSED");
    }
    return outcome.session;
  }

  /** adminStepUp (see the file header): `token` is the caller's verified admin access token. */
  async stepUp(token: AccessTokenClaims, request: TotpCodeRequest): Promise<AdminSession> {
    let verifiedAt: Date;
    try {
      verifiedAt = await this.mfa.verifyStepUpCode(token.sub, request.code);
    } catch (error) {
      // An admin without MFA cannot hold an admin session (an emergency MFA reset revoked it): the access token
      // outlived its session.
      if (isAppError(error) && error.code === "MFA_REQUIRED") {
        throw new AppError("UNAUTHENTICATED");
      }
      throw error;
    }
    return runInTransaction(this.db, async (trx) => {
      if (
        !(await this.accounts.lockForSessionChange(trx, token.sub)) ||
        !(await this.sessions.lockFamily(trx, token.sid))
      ) {
        throw new AppError("UNAUTHENTICATED");
      }
      const row = await this.sessions.lockCurrentOfFamily(trx, token.sid);
      const now = this.clock.now();
      if (
        row === undefined ||
        row.account_id !== token.sub ||
        refreshVerdict(row, now, "platform_admin") !== "rotate"
      ) {
        throw new AppError("UNAUTHENTICATED");
      }
      const account = await this.accounts.findMfaAccount(trx, token.sub);
      if (!mayHoldAdminSession(account)) {
        throw new AppError("UNAUTHENTICATED");
      }
      const issued = await this.rotate(trx, row, now, { mfaVerifiedAt: verifiedAt });
      return this.adminSession(issued, account);
    });
  }

  /** adminSignOut (see the file header): `accountId` is the caller's, from the access token. */
  async signOut(accountId: string, refreshToken: string): Promise<void> {
    if (refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      return;
    }
    const tokenHash = sha256Hex(refreshToken);
    await runInTransaction(this.db, async (trx) => {
      const seen = await this.sessions.findByTokenHash(trx, tokenHash);
      if (seen?.account_id !== accountId || seen.audience !== "platform_admin") {
        return;
      }
      await this.accounts.lockForSessionChange(trx, accountId);
      await this.sessions.lockFamily(trx, seen.family_id);
      await this.sessions.revokeFamily(trx, seen.family_id, "logout", this.clock.now());
    });
  }

  /** adminGetMe (see the file header): AdminAuthGuard has checked that the caller is an active platform admin. */
  async me(accountId: string): Promise<AdminMe> {
    const account = await this.accounts.findMfaAccount(this.db, accountId);
    if (account === undefined || account.deleted_at !== null) {
      throw new AppError("UNAUTHENTICATED");
    }
    return this.adminMe(account);
  }

  /** Audits an admin sign-in refused after a correct password (the reason, never the password). */
  private async recordRefusal(accountId: string, details: { readonly reason: string }): Promise<void> {
    await runInTransaction(this.db, async (trx) => {
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "admin.sign_in_failed",
        targetType: "account",
        targetId: accountId,
        details,
      });
    });
  }

  /**
   * Starts an admin family of `accountId` at `now`, in `trx`: its first row with the end user's user agent and IP
   * (request context, PADR-0019), the 12-hour family end, the 2-hour idle expiry of the token and the TOTP
   * verification of the sign-in.
   */
  private async startFamily(
    trx: PlatformTransaction,
    accountId: string,
    mfaVerifiedAt: Date,
    now: Date,
  ): Promise<IssuedRefreshToken> {
    const familyId = this.ids.new("asn");
    const familyExpiresAt = new Date(now.getTime() + ADMIN_FAMILY_TTL_MS);
    const { token, hash } = generateToken(REFRESH_TOKEN_PREFIX);
    const expiresAt = refreshTokenExpiry(now, familyExpiresAt, ADMIN_REFRESH_TOKEN_TTL_MS);
    await this.sessions.insert(trx, {
      id: familyId,
      accountId,
      familyId,
      audience: "platform_admin",
      refreshTokenHash: hash,
      userAgent: this.context.userAgent ?? null,
      ipAddress: this.context.ip ?? null,
      expiresAt,
      familyExpiresAt,
      mfaVerifiedAt,
      now,
    });
    return { accountId, familyId, refreshToken: token, refreshTokenExpiresAt: expiresAt, mfaVerifiedAt };
  }

  /**
   * Rotates `row` (locked, an admin row, verdict `rotate`) at `now`, in `trx`: the family's next generation with a new
   * token, the same family end and TOTP verification (or the newer one of a step-up), and `row` marked rotated.
   */
  private async rotate(
    trx: PlatformTransaction,
    row: SessionRecord,
    now: Date,
    options: { readonly mfaVerifiedAt?: Date } = {},
  ): Promise<IssuedRefreshToken> {
    const mfaVerifiedAt = options.mfaVerifiedAt ?? row.mfa_verified_at;
    // An admin row always has a family end (startFamily); a row without one ends with its own expiry.
    const familyExpiresAt = row.family_expires_at ?? row.expires_at;
    const { token, hash } = generateToken(REFRESH_TOKEN_PREFIX);
    const expiresAt = refreshTokenExpiry(now, familyExpiresAt, ADMIN_REFRESH_TOKEN_TTL_MS);
    const id = this.ids.new("asn");
    await this.sessions.insert(trx, {
      id,
      accountId: row.account_id,
      familyId: row.family_id,
      audience: "platform_admin",
      refreshTokenHash: hash,
      // The family's device: the user agent and IP of the sign-in.
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      expiresAt,
      familyExpiresAt,
      mfaVerifiedAt,
      now,
    });
    await this.sessions.markRotated(trx, row.id, id, now);
    return {
      accountId: row.account_id,
      familyId: row.family_id,
      refreshToken: token,
      refreshTokenExpiresAt: expiresAt,
      mfaVerifiedAt,
    };
  }

  /** The `AdminSession` answer of `issued`: a new admin access token of its family and the admin. */
  private async adminSession(issued: IssuedRefreshToken, account: AdminAccount): Promise<AdminSession> {
    const mfaAt = mfaAtOf(issued.mfaVerifiedAt);
    const access = await this.tokens.sign({
      aud: "platform_admin",
      sub: account.id,
      sid: issued.familyId,
      ev: true,
      amr: authMethodsOf(issued.mfaVerifiedAt),
      ...(mfaAt === undefined ? {} : { mfa_at: mfaAt }),
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: issued.refreshToken,
      refreshTokenExpiresAt: issued.refreshTokenExpiresAt.toISOString(),
      admin: this.adminMe(account),
    };
  }

  /** `AdminMe`: the admin and the switches of this process. */
  private adminMe(account: Pick<AdminAccount, "id" | "email" | "full_name">): AdminMe {
    return {
      id: account.id,
      email: account.email,
      fullName: account.full_name,
      features: this.features.features(),
    };
  }
}
