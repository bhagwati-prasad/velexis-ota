// Customer sessions (OBE-031; ota/docs/architecture.md §3.2, ADR-0008 "Refresh tokens", OADR-0006 points 2 and 5, db
// README §8): the refresh families of `customer_sessions` and the tokens built on them. The sign-in, sign-up, refresh,
// sign-out and password operations (OBE-032 to OBE-035) use this service; it never touches a request or a response
// (the cookie writer puts its tokens into cookies for the storefront edge).
//
// - `start` opens a family in the caller's transaction (sign-in, sign-up, password reset): its first row, `ses_…`,
//   which is also the family id and the session id (`sid`, `AuthSessionDetails.id`), with the SHA-256 of an opaque
//   256-bit refresh token (`rt_…`, the contract's `^rt_[A-Za-z0-9_-]{20,256}$`), an absolute end 12 hours later, or 30
//   days with `rememberMe` (`family_expires_at`), the end user's user agent and the IP's country. The IP itself is not
//   stored, as the contract says (`AuthSessionDetails.ipCountry`).
// - `tokensFor` signs the 15-minute access token of an issued family for the request's tenant (`tid`).
// - `refresh` rotates on every use: the presented row is marked rotated and the family's next row is written with a
//   new token and the same end (rotation never extends a family). Presenting a token that was rotated already revokes
//   the whole family (`401 REFRESH_TOKEN_REUSED`, committed before the answer, so the newest token of the family stops
//   working too). An unknown, malformed, revoked or expired token, or a customer that may no longer hold a session
//   (disabled, deleted), answers `401 REFRESH_TOKEN_INVALID` and changes nothing.
// - `revokeFamily` and `revokeAllOfCustomer` end sessions in the caller's transaction (sign-out, password change,
//   account deletion).
//
// Concurrency: every change of a family takes the customer's `FOR KEY SHARE` lock, then the lock of the family's
// first row, then the presented row; a revocation of all the customer's families takes the customer's `FOR UPDATE`
// lock. So a revocation never misses a generation that a concurrent rotation is writing, two refreshes with one token
// run one after the other (the second is a reuse), and the locks are always taken in the same order (no deadlock).
//
// Refresh and access tokens are never logged or stored in clear.
import { Injectable } from "@nestjs/common";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  SessionsRepository,
  type CustomerSessionRecord,
  type SessionCustomer,
  type SessionRevokeReason,
} from "./sessions.repository";
import { TokenService } from "./token.service";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The absolute lifetime of a family without `rememberMe` (ADR-0008, OADR-0006 point 2). */
export const SESSION_TTL_MS = 12 * HOUR_MS;

/** The absolute lifetime of a family with `rememberMe`. */
export const REMEMBER_ME_SESSION_TTL_MS = 30 * DAY_MS;

/** The prefix of refresh tokens (`rt_…`, the contract's `AuthRefreshRequest.refreshToken`). */
export const REFRESH_TOKEN_PREFIX = "rt";

/** The bytes of a refresh token: 256 bits (architecture §3.2). */
export const REFRESH_TOKEN_BYTES = 32;

/** A refresh token as the contract allows it; anything else is refused without a lookup. */
export const REFRESH_TOKEN_PATTERN = /^rt_[A-Za-z0-9_-]{20,256}$/;

/** The longest user agent recorded (`X-Velexis-End-User-Agent`: longer values are truncated). */
export const MAX_USER_AGENT_LENGTH = 512;

/** The customer states that may hold a session: verified accounts and accounts that wait for verification. */
export const SESSION_CUSTOMER_STATUSES: readonly string[] = Object.freeze(["active", "pending_verification"]);

/** True when `customer` may open and refresh sessions. */
export function mayHoldSession(customer: SessionCustomer | undefined): boolean {
  return (
    customer !== undefined &&
    customer.deleted_at === null &&
    SESSION_CUSTOMER_STATUSES.includes(customer.status)
  );
}

/** When a family opened at `now` ends: 12 hours, or 30 days with `rememberMe`. */
export function familyExpiry(now: Date, rememberMe: boolean): Date {
  return new Date(now.getTime() + (rememberMe ? REMEMBER_ME_SESSION_TTL_MS : SESSION_TTL_MS));
}

/** What `refresh` does with a presented row: rotate it, revoke its family (a reuse), or refuse it. */
export type RefreshVerdict = "rotate" | "reused" | "invalid";

/**
 * The verdict for the row of a presented refresh token at `now`. A rotated row is a reuse whatever else holds (also
 * when its family is revoked or ended: the reuse is still reported and the family revoked); otherwise a revoked row, or
 * one at or past its own or its family's end, is invalid.
 */
export function refreshVerdict(
  row: Pick<CustomerSessionRecord, "rotated_at" | "revoked_at" | "expires_at" | "family_expires_at">,
  now: Date,
): RefreshVerdict {
  if (row.rotated_at !== null) {
    return "reused";
  }
  if (
    row.revoked_at !== null ||
    row.expires_at.getTime() <= now.getTime() ||
    row.family_expires_at.getTime() <= now.getTime()
  ) {
    return "invalid";
  }
  return "rotate";
}

/** A user agent as stored: trimmed, at most 512 characters, `null` when empty. */
export function storedUserAgent(userAgent: string | null | undefined): string | null {
  const value = userAgent?.trim() ?? "";
  return value === "" ? null : value.slice(0, MAX_USER_AGENT_LENGTH);
}

/** What `start` takes. */
export interface StartSessionInput {
  readonly customerId: string;
  /** The identity used (`cid_…`), when the session follows a password check. */
  readonly identityId: string | null;
  readonly rememberMe: boolean;
  /** The end user's user agent (the request's own, or `X-Velexis-End-User-Agent` of a secret key). */
  readonly userAgent?: string | null | undefined;
  /** The country of the end user's IP, two capital letters, when known. */
  readonly ipCountry?: string | null | undefined;
}

/** A family's newest generation as the service hands it out: the refresh token itself exists only here. */
export interface IssuedSession {
  readonly customerId: string;
  /** `ses_…`: the family, the session id and the `sid` of its access tokens. */
  readonly sessionId: string;
  readonly rememberMe: boolean;
  readonly refreshToken: string;
  /** The family's absolute end, which is also the refresh token's. */
  readonly refreshTokenExpiresAt: Date;
}

/** An issued family with a new access token: what the cookie writer and the bearer answers carry. */
export interface SessionTokens extends IssuedSession {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
}

const COUNTRY = /^[A-Z]{2}$/;

@Injectable()
export class SessionsService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly tokens: TokenService,
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(SessionsService.name) private readonly logger: PinoLogger,
  ) {}

  /** Opens a family of `input.customerId` in `trx` (see the file header). The caller checked the customer. */
  async start(trx: TenantTransaction, input: StartSessionInput): Promise<IssuedSession> {
    const now = this.clock.now();
    const sessionId = this.ids.newId("ses");
    const familyExpiresAt = familyExpiry(now, input.rememberMe);
    const { token, hash } = generateToken(REFRESH_TOKEN_PREFIX, REFRESH_TOKEN_BYTES);
    const ipCountry = input.ipCountry ?? null;
    await this.sessions.insert(trx, {
      id: sessionId,
      customerId: input.customerId,
      identityId: input.identityId,
      familyId: sessionId,
      refreshTokenHash: hash,
      rememberMe: input.rememberMe,
      familyExpiresAt,
      userAgent: storedUserAgent(input.userAgent),
      ipCountry: ipCountry !== null && COUNTRY.test(ipCountry) ? ipCountry : null,
      now,
    });
    return {
      customerId: input.customerId,
      sessionId,
      rememberMe: input.rememberMe,
      refreshToken: token,
      refreshTokenExpiresAt: familyExpiresAt,
    };
  }

  /** `issued` with a new 15-minute access token for the tenant of the current request. */
  async tokensFor(issued: IssuedSession): Promise<SessionTokens> {
    const access = await this.tokens.signCustomerToken({
      sub: issued.customerId,
      tid: this.tenants.require().tenantId,
      sid: issued.sessionId,
    });
    return { ...issued, accessToken: access.token, accessTokenExpiresAt: access.expiresAt };
  }

  /** auth.refresh's rotation (see the file header), in a transaction of its own on the request's tenant. */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) {
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    const tokenHash = sha256Hex(refreshToken);
    const outcome = await this.tx.run(
      async (
        trx,
      ): Promise<{ readonly issued: IssuedSession } | { readonly reused: CustomerSessionRecord }> => {
        const seen = await this.sessions.findByTokenHash(trx, tokenHash);
        if (seen === undefined) {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        const customer = await this.sessions.lockCustomerForSessionChange(trx, seen.customer_id);
        await this.sessions.lockFamily(trx, seen.family_id);
        // Read again under the locks: a rotation or revocation that committed meanwhile is seen now.
        const row = await this.sessions.lockByTokenHash(trx, tokenHash);
        const now = this.clock.now();
        const verdict = row === undefined ? "invalid" : refreshVerdict(row, now);
        if (row === undefined || verdict === "invalid") {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        if (verdict === "reused") {
          await this.sessions.revokeFamily(trx, row.family_id, "rotation_reuse", now);
          return { reused: row };
        }
        if (!mayHoldSession(customer)) {
          throw new AppError("REFRESH_TOKEN_INVALID");
        }
        return { issued: await this.rotate(trx, row, now) };
      },
    );
    if ("reused" in outcome) {
      // Ids only: the token is never logged.
      this.logger.warn(
        { customerId: outcome.reused.customer_id, sessionId: outcome.reused.family_id },
        "customer.refresh_token_reused",
      );
      throw new AppError("REFRESH_TOKEN_REUSED");
    }
    return this.tokensFor(outcome.issued);
  }

  /**
   * Revokes family `sessionId` of `customerId` in `trx` at now with `reason` (sign-out of one session). Returns false,
   * and changes nothing, when the family is not the customer's.
   */
  async revokeFamily(
    trx: TenantTransaction,
    customerId: string,
    sessionId: string,
    reason: SessionRevokeReason,
  ): Promise<boolean> {
    await this.sessions.lockCustomerForSessionChange(trx, customerId);
    if (!(await this.sessions.lockFamily(trx, sessionId))) {
      return false;
    }
    const family = await this.sessions.listFamily(trx, sessionId);
    if (family[0]?.customer_id !== customerId) {
      return false;
    }
    await this.sessions.revokeFamily(trx, sessionId, reason, this.clock.now());
    return true;
  }

  /**
   * Revokes every family of `customerId` in `trx` at now with `reason`, except `exceptSessionId` (the current session
   * of a password change). Returns how many families it revoked.
   */
  async revokeAllOfCustomer(
    trx: TenantTransaction,
    customerId: string,
    reason: SessionRevokeReason,
    exceptSessionId?: string,
  ): Promise<number> {
    await this.sessions.lockCustomerForUpdate(trx, customerId);
    return this.sessions.revokeAllOfCustomer(trx, customerId, reason, this.clock.now(), exceptSessionId);
  }

  /**
   * Rotates `row` (locked, verdict `rotate`) at `now`, in `trx`: the family's next generation with a new token and
   * the same end, user agent and country, and `row` marked rotated and replaced by it.
   */
  private async rotate(
    trx: TenantTransaction,
    row: CustomerSessionRecord,
    now: Date,
  ): Promise<IssuedSession> {
    const { token, hash } = generateToken(REFRESH_TOKEN_PREFIX, REFRESH_TOKEN_BYTES);
    const id = this.ids.newId("ses");
    await this.sessions.insert(trx, {
      id,
      customerId: row.customer_id,
      identityId: row.identity_id,
      familyId: row.family_id,
      refreshTokenHash: hash,
      rememberMe: row.remember_me,
      familyExpiresAt: row.family_expires_at,
      // The family's device: the user agent and country of the sign-in, as the columns document them.
      userAgent: row.user_agent,
      ipCountry: row.ip_country,
      now,
    });
    await this.sessions.markRotated(trx, row.id, id, now);
    return {
      customerId: row.customer_id,
      sessionId: row.family_id,
      rememberMe: row.remember_me,
      refreshToken: token,
      refreshTokenExpiresAt: row.family_expires_at,
    };
  }
}
