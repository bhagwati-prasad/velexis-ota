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
// The auth operations of OBE-033 build on these:
//
// - `view` reads a family's metadata (`AuthSessionDetails`: the sign-in time of its first row, and the remember-me
//   flag, end, user agent, country and last use of its current generation) and its customer, for an answer.
// - `refreshSession` is auth.refresh: `refresh`, and the customer and the session's metadata read in the same
//   transaction as the rotation, for the answer (`AuthSessionResult`, or `AuthSessionInfo` for the edge).
// - `current` is auth.getSession: the family of the access token's `sid` must still be live (its current generation
//   neither revoked nor past its end) and its customer may still hold a session; otherwise `401 UNAUTHENTICATED`. An
//   access token is stateless for its 15 minutes on the other operations (ADR-0008), but "me" answers only for a
//   session that has not been signed out. It records the use (`last_used_at`) at most once a minute.
// - `signOut` is auth.signOut: the session of the access token (`sid`), or, without one, the family of the refresh
//   token the caller holds (the body's for a key caller, the `__Host-vx_rt` cookie's for the edge); `scope: all`
//   revokes every family of that customer, and needs the access token or a current refresh token. Revoking a revoked
//   family, or a `current` sign-out with an unknown refresh token, changes nothing and still succeeds; no credential
//   at all is `401 UNAUTHENTICATED`.
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
import { CustomersRepository, type CustomerRecord } from "./customers.repository";
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

/** How a session was opened (`AuthSessionDetails.authMethod`). */
export type SessionAuthMethod = "password" | "sign_up" | "password_reset";

/**
 * How the sessions of this release are reported: the tenant schema keeps no column for how a family was opened, and
 * only auth.signIn opens families yet (OBE-033); sign-up and password reset (OBE-032, OBE-034) open theirs later.
 */
export const DEFAULT_AUTH_METHOD: SessionAuthMethod = "password";

/** A family's metadata, as `AuthSessionDetails` shows it (without the access token of the answer). */
export interface SessionDetails {
  /** `ses_…`: the family. */
  readonly sessionId: string;
  /** The sign-in: when the family's first row was written. */
  readonly createdAt: Date;
  /** The current generation's last use, else its creation (the sign-in or the last refresh). */
  readonly lastUsedAt: Date;
  /** The family's absolute end. */
  readonly refreshTokenExpiresAt: Date;
  readonly rememberMe: boolean;
  readonly authMethod: SessionAuthMethod;
  readonly userAgent: string | null;
  readonly ipCountry: string | null;
}

/** A session and its customer, as the answers of the auth operations show them. */
export interface SessionView {
  readonly customer: CustomerRecord;
  readonly details: SessionDetails;
}

/** A session with new tokens (auth.signIn, auth.refresh), and its customer and metadata for the answer. */
export interface SessionWithTokens extends SessionView {
  readonly tokens: SessionTokens;
}

/** `scope` of auth.signOut. */
export type SignOutScope = "current" | "all";

/** What `signOut` takes. */
export interface SignOutInput {
  readonly scope: SignOutScope;
  /** The signed-in customer of the request (the access token's `sub` and `sid`), when it has one. */
  readonly principal: { readonly customerId: string; readonly sessionId: string } | undefined;
  /** The refresh token the caller holds: the body's (key callers) or the `__Host-vx_rt` cookie's (the edge). */
  readonly refreshToken: string | undefined;
}

/** How often auth.getSession records a session's use (`last_used_at`, "minute precision"). */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** True when `row` (a family's current generation) still holds a session at `now`: not revoked, not past its end. */
export function isLiveGeneration(
  row: Pick<CustomerSessionRecord, "revoked_at" | "expires_at" | "family_expires_at">,
  now: Date,
): boolean {
  return (
    row.revoked_at === null &&
    row.expires_at.getTime() > now.getTime() &&
    row.family_expires_at.getTime() > now.getTime()
  );
}

/** The metadata of a family from its first row and its current generation. */
export function sessionDetailsOf(
  head: CustomerSessionRecord,
  current: CustomerSessionRecord,
): SessionDetails {
  return {
    sessionId: head.id,
    createdAt: head.created_at,
    lastUsedAt: current.last_used_at ?? current.created_at,
    refreshTokenExpiresAt: current.family_expires_at,
    rememberMe: current.remember_me,
    authMethod: DEFAULT_AUTH_METHOD,
    userAgent: current.user_agent,
    ipCountry: current.ip_country,
  };
}

const COUNTRY = /^[A-Z]{2}$/;

@Injectable()
export class SessionsService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly customers: CustomersRepository,
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
    return (await this.refreshSession(refreshToken)).tokens;
  }

  /**
   * auth.refresh: the rotation of `refresh`, with the customer and the session's metadata read in the rotation's
   * transaction for the answer.
   */
  async refreshSession(refreshToken: string): Promise<SessionWithTokens> {
    if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) {
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    const tokenHash = sha256Hex(refreshToken);
    const outcome = await this.tx.run(
      async (
        trx,
      ): Promise<
        | { readonly issued: IssuedSession; readonly view: SessionView }
        | { readonly reused: CustomerSessionRecord }
      > => {
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
        const issued = await this.rotate(trx, row, now);
        const view = await this.view(trx, issued.customerId, issued.sessionId);
        if (view === undefined) {
          // The customer and the family are locked by this transaction: they cannot have gone.
          throw new Error("SessionsService.refreshSession: the rotated family has no current generation");
        }
        return { issued, view };
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
    return { ...outcome.view, tokens: await this.tokensFor(outcome.issued) };
  }

  /**
   * Family `sessionId` of `customerId` and that customer, as an answer shows them, in `trx` (the metadata from the
   * family's first row and its current generation); `undefined` when either is missing or the family is another
   * customer's. It says nothing about whether the family is still live (`current` checks that).
   */
  async view(
    trx: TenantTransaction,
    customerId: string,
    sessionId: string,
  ): Promise<SessionView | undefined> {
    const head = await this.sessions.findFamilyHead(trx, sessionId);
    if (head === undefined || head.customer_id !== customerId) {
      return undefined;
    }
    const current = await this.sessions.findCurrentGeneration(trx, sessionId);
    const customer = await this.customers.findCustomer(trx, customerId);
    return current === undefined || customer === undefined
      ? undefined
      : { customer, details: sessionDetailsOf(head, current) };
  }

  /**
   * auth.getSession for the signed-in customer of the request (see the file header): the customer and the session,
   * or `401 UNAUTHENTICATED` when the session has ended (signed out, revoked, past its end) or its customer may no
   * longer hold one. Records the session's use at most once a minute.
   */
  async current(principal: {
    readonly customerId: string;
    readonly sessionId: string;
  }): Promise<SessionView> {
    return this.tx.run(async (trx) => {
      const now = this.clock.now();
      const head = await this.sessions.findFamilyHead(trx, principal.sessionId);
      const current =
        head === undefined ? undefined : await this.sessions.findCurrentGeneration(trx, principal.sessionId);
      const customer = await this.customers.findCustomer(trx, principal.customerId);
      if (
        head === undefined ||
        current === undefined ||
        customer === undefined ||
        head.customer_id !== principal.customerId ||
        !isLiveGeneration(current, now) ||
        !mayHoldSession(customer)
      ) {
        throw new AppError("UNAUTHENTICATED");
      }
      const lastUsed = current.last_used_at;
      if (lastUsed === null || now.getTime() - lastUsed.getTime() >= LAST_USED_RESOLUTION_MS) {
        await this.sessions.touch(trx, current.id, now);
        return { customer, details: sessionDetailsOf(head, { ...current, last_used_at: now }) };
      }
      return { customer, details: sessionDetailsOf(head, current) };
    });
  }

  /**
   * auth.signOut (see the file header), in a transaction of its own on the request's tenant: revokes the session, or
   * every session of its customer with `scope: all` (`logout`). Returns how many families it revoked (a family that
   * was revoked already counts as one for `current`).
   */
  async signOut(input: SignOutInput): Promise<number> {
    const outcome = await this.tx.run(async (trx) => {
      const target = await this.signOutTarget(trx, input);
      if (target === undefined) {
        return { target, revoked: 0 };
      }
      if (input.scope === "all") {
        return { target, revoked: await this.revokeAllOfCustomer(trx, target.customerId, "logout") };
      }
      const revoked = await this.revokeFamily(trx, target.customerId, target.sessionId, "logout");
      return { target, revoked: revoked ? 1 : 0 };
    });
    // Ids only: no token is ever logged.
    this.logger.info(
      {
        customerId: outcome.target?.customerId,
        sessionId: outcome.target?.sessionId,
        scope: input.scope,
        revoked: outcome.revoked,
      },
      "customer.signed_out",
    );
    return outcome.revoked;
  }

  /**
   * Whose session `signOut` ends: the access token's, else the family of the presented refresh token. `undefined` (a
   * no-op) for a `current` sign-out with an unknown refresh token; `401 UNAUTHENTICATED` without any credential, and
   * for `scope: all` without the access token or a current refresh token.
   */
  private async signOutTarget(
    trx: TenantTransaction,
    input: SignOutInput,
  ): Promise<{ readonly customerId: string; readonly sessionId: string } | undefined> {
    if (input.principal !== undefined) {
      return { customerId: input.principal.customerId, sessionId: input.principal.sessionId };
    }
    if (input.refreshToken === undefined) {
      throw new AppError("UNAUTHENTICATED");
    }
    const row = REFRESH_TOKEN_PATTERN.test(input.refreshToken)
      ? await this.sessions.findByTokenHash(trx, sha256Hex(input.refreshToken))
      : undefined;
    if (input.scope === "all" && (row === undefined || refreshVerdict(row, this.clock.now()) !== "rotate")) {
      throw new AppError("UNAUTHENTICATED");
    }
    return row === undefined ? undefined : { customerId: row.customer_id, sessionId: row.family_id };
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
    // The first row tells whose family it is (every generation has its customer): no need to read them all.
    const head = await this.sessions.findFamilyHead(trx, sessionId);
    if (head?.customer_id !== customerId) {
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
