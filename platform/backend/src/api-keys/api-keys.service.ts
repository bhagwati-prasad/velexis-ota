// The API key use cases of the portal (platform/docs/api-inventory-resources.md §1, flows/api-keys.md, PADR-0005;
// scope PF-30): list, create (shown once), rename or change origins, roll and revoke. Who may call them is
// TenantRoleGuard's (owners and admins; the membership arrives here checked). This service owns the transactions,
// their audit rows and the `api_key` invalidations after the commit (architecture §4).
//
// Rules on top of the OpenAPI validation:
// - the origins and scopes of api-key-rules.ts (`400 VALIDATION_FAILED`), and an `expiresAt` in the future;
// - writes need an `active` OTA (`409 TENANT_NOT_ACTIVE`, PADR-0014 item 5: a suspended OTA's keys are read-only);
// - `live` keys only once the OTA is live (`422 LIVE_MODE_NOT_ENABLED`), and a live secret key, created or rolled,
//   needs a TOTP step-up within 15 minutes (`403 MFA_REQUIRED`, `401 REAUTH_REQUIRED`; PADR-0005 item 9). The
//   account's MFA state is read before the transaction opens: AccountAuthStates reads on the pool, and a read there
//   while the transaction holds a connection (and the tenant's key lock) could wait for a connection that the
//   requests queued behind the lock never give back;
// - keys that are neither revoked nor expired count against `plans.limits.apiKeys` (`422 PLAN_LIMIT_REACHED` with
//   `details.limit` and `details.used`); a roll that keeps the old key working needs room for both, while a roll
//   with `now` replaces a working key one for one and needs none (an OTA over its limit after a downgrade can still
//   replace a leaked key);
// - a revoked key is never changed again (`409 CONFLICT`, `details.reason = "revoked"`).
//
// The full key leaves this service only in the answer of create and roll; audit rows hold the prefix, kind,
// environment and scopes, never the key or its hash.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccountAuthStates, type AccountAuthState } from "../common/auth/admin-auth.guard";
import { assertRecentMfa } from "../common/auth/recent-mfa.guard";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { ApiKeyGenerator, apiKeyAuditFacts } from "./api-key-generator";
import { apiKeyAccess, originProblems, type ApiKeyEnvironment, type ApiKeyKind } from "./api-key-rules";
import {
  ApiKeysRepository,
  type ApiKeyRecord,
  type ApiKeySettingsChanges,
  type ApiKeyWithCreator,
} from "./api-keys.repository";

export type ApiKey = components["schemas"]["ApiKey"];
export type ApiKeyList = components["schemas"]["ApiKeyList"];
export type ApiKeyCreated = components["schemas"]["ApiKeyCreated"];
export type ApiKeyRolled = components["schemas"]["ApiKeyRolled"];
export type CreateApiKeyRequest = components["schemas"]["CreateApiKeyRequest"];
export type UpdateApiKeyRequest = components["schemas"]["UpdateApiKeyRequest"];
export type RollApiKeyRequest = components["schemas"]["RollApiKeyRequest"];
export type ExpireOldIn = RollApiKeyRequest["expireOldIn"];

/** The query of `listApiKeys`, as the validation interceptor coerced it (`includeRevoked` defaults to false). */
export interface ListApiKeysQuery {
  readonly environment?: ApiKeyEnvironment | undefined;
  readonly includeRevoked?: boolean | undefined;
}

const HOUR_MS = 60 * 60 * 1000;

/** How long the old key keeps working after a roll (PADR-0005 item 8). */
export const EXPIRE_OLD_IN_MS: Readonly<Record<ExpireOldIn, number>> = Object.freeze({
  now: 0,
  "1h": HOUR_MS,
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
});

/**
 * The old key's expiry after a roll at `now`: `now` plus the delay, but never later than an expiry the key has
 * already (a roll never extends a key's life).
 */
export function rolledExpiry(current: Date | null, expireOldIn: ExpireOldIn, now: Date): Date {
  const expiry = new Date(now.getTime() + EXPIRE_OLD_IN_MS[expireOldIn]);
  return current !== null && current < expiry ? current : expiry;
}

/** True when `row` authenticates at `now`: not revoked and not expired. */
export function isActiveKey(row: Pick<ApiKeyRecord, "revoked_at" | "expires_at">, now: Date): boolean {
  return row.revoked_at === null && (row.expires_at === null || row.expires_at > now);
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * The `apiKeys` quota of a plan's `limits` column: a whole number of at least 0, or 0 when the plan does not set it
 * (the rule of `PlanLimits` in listPlans, so a plan with incomplete limits never grants more than it shows).
 */
export function apiKeyLimit(limits: unknown): number {
  const value =
    limits !== null && typeof limits === "object" && !Array.isArray(limits)
      ? (limits as Record<string, unknown>)["apiKeys"]
      : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The `ApiKey` of the OpenAPI document for a row with its creator: never the key or its hash. */
export function toApiKey(row: ApiKeyWithCreator): ApiKey {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ApiKeyKind,
    environment: row.environment as ApiKeyEnvironment,
    prefix: row.prefix,
    last4: row.last4,
    allowedOrigins: [...row.allowed_origins],
    scopes: [...row.scopes],
    createdAt: row.created_at.toISOString(),
    createdBy:
      row.created_by_account_id === null || row.created_by_full_name === null
        ? null
        : { accountId: row.created_by_account_id, fullName: row.created_by_full_name },
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly keys: ApiKeysRepository,
    private readonly generator: ApiKeyGenerator,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly accounts: AccountAuthStates,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** listApiKeys: the OTA's keys, newest first; revoked ones only with `includeRevoked`. */
  async list(membership: TenantMembership, query: ListApiKeysQuery): Promise<ApiKeyList> {
    const rows = await this.keys.list(membership.tenantId, {
      environment: query.environment,
      includeRevoked: query.includeRevoked === true,
    });
    return { data: rows.map(toApiKey) };
  }

  /** createApiKey: a new key with its settings and the full key, which the caller answers once. */
  async create(
    membership: TenantMembership,
    claims: Pick<AccessTokenClaims, "sub" | "mfa_at">,
    request: CreateApiKeyRequest,
  ): Promise<ApiKeyCreated> {
    const now = this.clock.now();
    const { access, fieldErrors } = apiKeyAccess(request);
    const expiresAt = request.expiresAt === undefined ? null : new Date(request.expiresAt);
    if (expiresAt !== null && !(expiresAt > now)) {
      fieldErrors.push({ path: "/expiresAt", code: "past", message: "Must be in the future." });
    }
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors });
    }
    const { tenantId, accountId } = membership;
    // Read before the transaction (see the file header); checked in it, after the live mode.
    const account = needsStepUp(request.kind, request.environment)
      ? await this.accounts.read(claims.sub)
      : undefined;
    return runInTransaction(this.db, async (trx) => {
      await this.keys.lockTenantKeys(trx, tenantId);
      const tenant = await this.writableTenant(trx, tenantId);
      if (request.environment === "live" && tenant.storefront_environment !== "live") {
        throw new AppError("LIVE_MODE_NOT_ENABLED");
      }
      assertStepUp(request.kind, request.environment, account, claims, now);
      await this.checkLimit(trx, tenantId, tenant.limits, now, 1);
      const issued = await this.generator.issue(trx, {
        tenantId,
        name: request.name,
        kind: request.kind,
        environment: request.environment,
        allowedOrigins: access.allowedOrigins,
        scopes: access.scopes,
        expiresAt,
        createdByAccountId: accountId,
      });
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "api_key.created",
        targetType: "api_key",
        targetId: issued.row.id,
        tenantId,
        details: apiKeyAuditFacts(issued.row),
      });
      return { apiKey: toApiKey(await this.reread(trx, tenantId, issued.row.id)), key: issued.key };
    });
  }

  /**
   * updateApiKey: a new name, or new origins of a publishable key (the rules of createApiKey), with an
   * `api_key.updated` audit row of the fields that changed and an `api_key` invalidation after the commit. A request
   * that changes nothing writes nothing.
   */
  async update(membership: TenantMembership, keyId: string, request: UpdateApiKeyRequest): Promise<ApiKey> {
    const { tenantId, accountId } = membership;
    return runInTransaction(this.db, async (trx) => {
      const key = await this.lockedKey(trx, tenantId, keyId);
      await this.writableTenant(trx, tenantId);
      assertNotRevoked(key);
      const changes: { -readonly [K in keyof ApiKeySettingsChanges]: ApiKeySettingsChanges[K] } = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (request.allowedOrigins !== undefined) {
        assertValidOrigins(key, request.allowedOrigins);
        if (!sameList(request.allowedOrigins, key.allowed_origins)) {
          changes.allowed_origins = [...request.allowedOrigins];
          before["allowedOrigins"] = [...key.allowed_origins];
          after["allowedOrigins"] = [...request.allowedOrigins];
        }
      }
      if (request.name !== undefined && request.name !== key.name) {
        changes.name = request.name;
        before["name"] = key.name;
        after["name"] = request.name;
      }
      if (Object.keys(changes).length > 0) {
        await this.keys.updateSettings(trx, key.id, changes, this.clock.now());
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "api_key.updated",
          targetType: "api_key",
          targetId: key.id,
          tenantId,
          before,
          after,
          details: apiKeyAuditFacts(key),
        });
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "api_key", prefix: key.prefix });
      }
      return toApiKey(await this.reread(trx, tenantId, key.id));
    });
  }

  /**
   * rollApiKey: a new key with the old one's name, kind, environment, origins and scopes, answered once, and the old
   * key's expiry set `expireOldIn` ahead (never later than an expiry it has), with an `api_key.rolled` audit row and
   * an `api_key` invalidation of the old prefix after the commit.
   */
  async roll(
    membership: TenantMembership,
    claims: Pick<AccessTokenClaims, "sub" | "mfa_at">,
    keyId: string,
    request: RollApiKeyRequest,
  ): Promise<ApiKeyRolled> {
    const now = this.clock.now();
    const { tenantId, accountId } = membership;
    // Read before the transaction (see the file header), for the case that the key is a live secret key.
    const account = await this.accounts.read(claims.sub);
    return runInTransaction(this.db, async (trx) => {
      await this.keys.lockTenantKeys(trx, tenantId);
      const old = await this.lockedKey(trx, tenantId, keyId);
      const tenant = await this.writableTenant(trx, tenantId);
      assertNotRevoked(old);
      const kind = old.kind as ApiKeyKind;
      const environment = old.environment as ApiKeyEnvironment;
      assertStepUp(kind, environment, account, claims, now);
      // Expiring a working key at once replaces it one for one: no room needed. Otherwise the new key counts, next
      // to the old one while it works (an expired key counts no more, so its roll adds a key).
      if (request.expireOldIn !== "now" || !isActiveKey(old, now)) {
        await this.checkLimit(trx, tenantId, tenant.limits, now, 1);
      }
      const expiresAt = rolledExpiry(old.expires_at, request.expireOldIn, now);
      await this.keys.setExpiry(trx, old.id, expiresAt, now);
      const issued = await this.generator.issue(trx, {
        tenantId,
        name: old.name,
        kind,
        environment,
        allowedOrigins: old.allowed_origins,
        scopes: old.scopes,
        expiresAt: null,
        createdByAccountId: accountId,
      });
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "api_key.rolled",
        targetType: "api_key",
        targetId: old.id,
        tenantId,
        before: { expiresAt: iso(old.expires_at) },
        after: { expiresAt: expiresAt.toISOString() },
        details: { ...apiKeyAuditFacts(old), newKeyId: issued.row.id, newPrefix: issued.row.prefix },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "api_key", prefix: old.prefix });
      return {
        apiKey: toApiKey(await this.reread(trx, tenantId, issued.row.id)),
        key: issued.key,
        previous: { id: old.id, expiresAt: expiresAt.toISOString() },
      };
    });
  }

  /**
   * revokeApiKey: `revoked_at` and the revoking account, an `api_key.revoked` audit row and an `api_key` invalidation
   * after the commit, so the OTA backend refuses the key within seconds.
   */
  async revoke(membership: TenantMembership, keyId: string): Promise<ApiKey> {
    const { tenantId, accountId } = membership;
    return runInTransaction(this.db, async (trx) => {
      const key = await this.lockedKey(trx, tenantId, keyId);
      await this.writableTenant(trx, tenantId);
      assertNotRevoked(key);
      await this.keys.revoke(trx, key.id, accountId, this.clock.now());
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "api_key.revoked",
        targetType: "api_key",
        targetId: key.id,
        tenantId,
        details: apiKeyAuditFacts(key),
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "api_key", prefix: key.prefix });
      return toApiKey(await this.reread(trx, tenantId, key.id));
    });
  }

  /** The tenant's state for a write: `404` when it is gone, `409 TENANT_NOT_ACTIVE` unless it is `active`. */
  private async writableTenant(trx: PlatformTransaction, tenantId: string) {
    const tenant = await this.keys.tenantState(trx, tenantId);
    if (tenant === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (tenant.status !== "active") {
      throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenant.status } });
    }
    return tenant;
  }

  /** The key `keyId` of the tenant, locked; `404 NOT_FOUND` for a key of another tenant or none. */
  private async lockedKey(trx: PlatformTransaction, tenantId: string, keyId: string): Promise<ApiKeyRecord> {
    const key = await this.keys.lockForTenant(trx, tenantId, keyId);
    if (key === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return key;
  }

  /** The key as stored now, with its creator, in `trx`. */
  private async reread(
    trx: PlatformTransaction,
    tenantId: string,
    keyId: string,
  ): Promise<ApiKeyWithCreator> {
    const row = await this.keys.findForTenant(tenantId, keyId, trx);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return row;
  }

  /**
   * `422 PLAN_LIMIT_REACHED` (with `details.limit` and `details.used`) when `added` more keys would take the tenant's
   * keys that count at `now` past `plans.limits.apiKeys` (a plan without the limit allows none, as `listPlans` shows
   * it).
   */
  private async checkLimit(
    trx: PlatformTransaction,
    tenantId: string,
    limits: unknown,
    now: Date,
    added: number,
  ): Promise<void> {
    const limit = apiKeyLimit(limits);
    const used = await this.keys.countActive(trx, tenantId, now);
    if (used + added > limit) {
      throw new AppError("PLAN_LIMIT_REACHED", { details: { limit, used } });
    }
  }
}

/** True for a key whose creation or roll needs a TOTP step-up: a live secret key (PADR-0005 item 9). */
export function needsStepUp(kind: ApiKeyKind, environment: ApiKeyEnvironment): boolean {
  return kind === "secret" && environment === "live";
}

/**
 * The step-up of a live secret key (PADR-0008): `403 MFA_REQUIRED` without MFA, `401 REAUTH_REQUIRED` without a TOTP
 * verification in the last 15 minutes, `401 UNAUTHENTICATED` when the account is gone. `account` is the caller's state
 * as read before the transaction (`undefined` when there is none, or when it was not read because no step-up applies).
 */
function assertStepUp(
  kind: ApiKeyKind,
  environment: ApiKeyEnvironment,
  account: AccountAuthState | undefined,
  claims: Pick<AccessTokenClaims, "mfa_at">,
  now: Date,
): void {
  if (!needsStepUp(kind, environment)) {
    return;
  }
  if (account === undefined) {
    throw new AppError("UNAUTHENTICATED");
  }
  assertRecentMfa(account, claims, now);
}

/** `409 CONFLICT` with `details.reason = "revoked"` for a revoked key: it is never changed again. */
function assertNotRevoked(key: Pick<ApiKeyRecord, "revoked_at">): void {
  if (key.revoked_at !== null) {
    throw new AppError("CONFLICT", { details: { reason: "revoked" } });
  }
}

/** The origin rules of a key's new origins: a secret key takes none, a publishable key those of api-key-rules.ts. */
function assertValidOrigins(
  key: Pick<ApiKeyRecord, "kind" | "environment">,
  origins: readonly string[],
): void {
  const fieldErrors: FieldError[] =
    key.kind === "publishable"
      ? originProblems(origins, key.environment as ApiKeyEnvironment)
      : origins.length > 0
        ? [
            {
              path: "/allowedOrigins",
              code: "notAllowed",
              message: "A secret key is used from servers only and takes no browser origins.",
            },
          ]
        : [];
  if (fieldErrors.length > 0) {
    throw new AppError("VALIDATION_FAILED", { fieldErrors });
  }
}
