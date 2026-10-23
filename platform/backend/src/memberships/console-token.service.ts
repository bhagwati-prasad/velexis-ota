// The one-time console token of the OTA admin's single sign-on (PBE-039; PADR-0007, flows/team-and-ota-admin-sso.md §C,
// PADR-0008 "OTA admin access of a live OTA", scope PF-22): `createConsoleToken`, which the portal's "Open console"
// route handler calls and whose token it posts to `consoleSsoUrl` in a form body. TenantRoleGuard lets every active
// member through (`openConsole` of the role matrix) and AccountRateLimitGuard counts 30 per account per minute
// (`consoleToken` of throttler.config.ts); this service checks the rest on a fresh read of the membership, its account
// and its tenant, in this order:
//
// 1. the account still holds a session (`active` or `pending_verification`, not erased), else `401 UNAUTHENTICATED`:
//    the access token outlived it; then a verified e-mail address (`active` with `email_verified_at`), else `403
//    EMAIL_NOT_VERIFIED`;
// 2. the membership is still active (the guard's read may be a moment old), else `404 NOT_FOUND`;
// 3. the tenant is `active`, else `409 TENANT_NOT_ACTIVE` with `details.status` and, for a suspended tenant,
//    `details.suspensionReason`, so the portal can explain why (and link to billing);
// 4. a live OTA (`storefront_environment = 'live'`) needs an account with MFA enabled, else `403 MFA_REQUIRED`
//    (PADR-0008: the policy of live OTAs, not a step-up; no recent TOTP code is needed).
//
// Then it makes the token, `ptk_` + 43 base62 characters from the CSPRNG (256 bits, the platform document's
// `PortalToken` and within the OTA contract's `^ptk_[A-Za-z0-9]{24,64}$`), and stores `SET ptk:<sha256 hex> <json> EX
// 60 NX` (`redisKeys.portalToken`, `setKeyIfAbsent`) with `{v: 1, accountId, tenantId, membershipId, role, mfa,
// issuedAt, requestId}`, which the OTA backend takes once with `GETDEL` (OBE-059's `parsePortalToken`). Redis first:
// while it is unreachable the answer is `503 SERVICE_UNAVAILABLE` and nothing else is written, because the token lives
// only there. The audit row `console.token_issued` (target the membership, never the token or its digest) follows in a
// transaction of its own; when it fails, the key is deleted again, so no token is ever usable without its audit row.
//
// The token leaves this service only in the answer, which the controller sends with `Cache-Control: no-store` (so the
// idempotency store would never keep it either; the operation is not idempotent anyway). It is never logged: no line
// here names it, the Redis error a refused write carries is reduced to its name and message (an ioredis reply error
// lists the command's arguments), and `portalToken` is on the logger's redaction list.
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../audit/audit.service";
import { isTenantRole, type TenantMembership, type TenantRole } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { RequestContext } from "../common/http/request-context";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import {
  PORTAL_TOKEN_TTL_SECONDS,
  redisKeys,
  setKeyIfAbsent,
  type RedisKey,
} from "../common/redis/redis-keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { PlatformBackendConfig } from "../config";
import { MembershipsRepository, type ConsoleTokenState } from "./memberships.repository";

export type ConsoleToken = components["schemas"]["ConsoleToken"];

/** The prefix of portal tokens (PADR-0007 item 1). */
export const PORTAL_TOKEN_PREFIX = "ptk_";
/** The base62 characters after the prefix: 43 × log2(62) ≈ 256 bits. */
export const PORTAL_TOKEN_RANDOM_LENGTH = 43;
/** A portal token as this service makes it: the `PortalToken` schema of the platform document. */
export const PORTAL_TOKEN_PATTERN = /^ptk_[0-9A-Za-z]{43}$/;
/** The OTA admin's route that redeems the token (`POST /sso`, ota/admin/src/app/sso/route.ts). */
export const CONSOLE_SSO_PATH = "/sso";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** The largest multiple of 62 a byte can hold: bytes from it up are drawn again, so every character is uniform. */
const BASE62_BYTE_LIMIT = 248;

/** The account states that still hold a portal session (sessions.service.ts `SESSION_ACCOUNT_STATUSES`). */
const SESSION_ACCOUNT_STATUSES: ReadonlySet<string> = new Set(["active", "pending_verification"]);

/**
 * `length` characters of base62 from Node's CSPRNG, each uniform (rejection sampling of random bytes). The API key
 * generator has the same rule (api-keys/api-key-generator.ts); a module of the same layer may not import it
 * (architecture §2.2), so the few lines live here too.
 */
function randomBase62(length: number): string {
  let text = "";
  while (text.length < length) {
    const bytes = randomBytes(length - text.length + 8);
    for (const byte of bytes) {
      if (byte < BASE62_BYTE_LIMIT && text.length < length) {
        text += BASE62[byte % 62] ?? "";
      }
    }
    bytes.fill(0);
  }
  return text;
}

/** A new portal token: `ptk_` and 43 base62 characters from the CSPRNG. Hand it out once; store only its SHA-256. */
export function generatePortalToken(): string {
  return `${PORTAL_TOKEN_PREFIX}${randomBase62(PORTAL_TOKEN_RANDOM_LENGTH)}`;
}

/**
 * The OTA admin's sign-on URL: PUBLIC_OTA_ADMIN_URL with `/sso` after its path (a trailing slash dropped), without a
 * query or a fragment (`https://admin.ota.example.com/sso`).
 */
export function consoleSsoUrl(otaAdminUrl: string): string {
  const url = new URL(otaAdminUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${CONSOLE_SSO_PATH}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The value of `ptk:<sha256>` (PADR-0007 item 1), as the OTA backend's `parsePortalToken` reads it. */
export interface PortalTokenValue {
  readonly v: 1;
  readonly accountId: string;
  readonly tenantId: string;
  /** `stf_…`: the staff id of the OTA admin. */
  readonly membershipId: string;
  /** Informative: the OTA backend re-reads the membership when it redeems the token. */
  readonly role: TenantRole;
  /** Whether the account has MFA enabled, so the OTA admin can remind a member of a test-only OTA. */
  readonly mfa: boolean;
  /** ISO 8601, the service Clock's time. */
  readonly issuedAt: string;
  readonly requestId: string | null;
}

/** What the checks let through: the membership as it is now and the account's MFA flag. */
interface ConsoleGrant {
  readonly membershipId: string;
  readonly role: TenantRole;
  readonly mfa: boolean;
}

/**
 * The checks of steps 1 to 4 of the file header on `state` (undefined: no active membership any more), in their
 * order: `401 UNAUTHENTICATED`, `403 EMAIL_NOT_VERIFIED`, `404 NOT_FOUND`, `409 TENANT_NOT_ACTIVE`, `403
 * MFA_REQUIRED`. The account is read with the membership, so a closed account answers 401 whatever its tenant's state;
 * a membership that is gone leaves no row to read the account from and answers 404.
 */
export function consoleGrantOf(state: ConsoleTokenState | undefined): ConsoleGrant {
  if (state !== undefined) {
    if (state.account_deleted_at !== null || !SESSION_ACCOUNT_STATUSES.has(state.account_status)) {
      throw new AppError("UNAUTHENTICATED");
    }
    if (state.account_status !== "active" || state.email_verified_at === null) {
      throw new AppError("EMAIL_NOT_VERIFIED");
    }
  }
  if (state === undefined || !isTenantRole(state.role)) {
    throw new AppError("NOT_FOUND");
  }
  if (state.tenant_status !== "active") {
    throw new AppError("TENANT_NOT_ACTIVE", {
      details:
        state.tenant_status === "suspended" && state.suspension_reason !== null
          ? { status: state.tenant_status, suspensionReason: state.suspension_reason }
          : { status: state.tenant_status },
    });
  }
  if (state.storefront_environment === "live" && !state.mfa_enabled) {
    throw new AppError("MFA_REQUIRED");
  }
  return { membershipId: state.membership_id, role: state.role, mfa: state.mfa_enabled };
}

/**
 * A Redis error reduced to its name and message, for a log line or an error's cause: an ioredis reply error also
 * lists the command's arguments (the key holds the token's digest), and the error filter logs the cause chain.
 */
export function redisFailure(error: unknown): Error {
  const failure = new Error(error instanceof Error ? error.message : "Redis command failed");
  failure.name = error instanceof Error ? error.name : "Error";
  return failure;
}

@Injectable()
export class ConsoleTokenService {
  private readonly ssoUrl: string;

  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly context: RequestContext,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(ConsoleTokenService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.ssoUrl = consoleSsoUrl(config.get("PUBLIC_OTA_ADMIN_URL", { infer: true }));
  }

  /** createConsoleToken: a one-time portal token for the caller's OTA (see the file header). */
  async create(caller: TenantMembership): Promise<ConsoleToken> {
    const { tenantId, accountId } = caller;
    const grant = consoleGrantOf(await this.memberships.findConsoleTokenState(tenantId, accountId));
    const issuedAt = this.clock.now();
    const expiresAt = new Date(issuedAt.getTime() + PORTAL_TOKEN_TTL_SECONDS * 1000);
    const token = generatePortalToken();
    const key = redisKeys.portalToken(sha256Hex(token));
    const value: PortalTokenValue = {
      v: 1,
      accountId,
      tenantId,
      membershipId: grant.membershipId,
      role: grant.role,
      mfa: grant.mfa,
      issuedAt: issuedAt.toISOString(),
      requestId: this.context.requestId ?? null,
    };
    let stored: boolean;
    try {
      stored = await setKeyIfAbsent(this.redis, key, JSON.stringify(value));
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: redisFailure(error) });
    }
    if (!stored) {
      // A 256-bit token never repeats; if it ever did, NX kept the other token, and this one is not handed out.
      throw new Error("ConsoleTokenService.create: the portal token key exists already");
    }
    try {
      await runInTransaction(this.db, (trx) =>
        this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "console.token_issued",
          targetType: "membership",
          targetId: grant.membershipId,
          tenantId,
          details: { role: grant.role, mfa: grant.mfa, expiresAt: expiresAt.toISOString() },
        }),
      );
    } catch (error) {
      await this.discard(key);
      throw error;
    }
    return { portalToken: token, expiresAt: expiresAt.toISOString(), consoleSsoUrl: this.ssoUrl };
  }

  /** Deletes a token whose audit row could not be written; a failure leaves it to expire within 60 s (logged). */
  private async discard(key: RedisKey): Promise<void> {
    try {
      await this.redis.del(key.key);
    } catch (error) {
      this.logger.warn({ err: redisFailure(error) }, "console_token.discard_failed");
    }
  }
}
