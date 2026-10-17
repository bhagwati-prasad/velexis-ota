// The `api_keys` repository (platform/docs/architecture.md §2.1: ApiKeysModule owns the table; PADR-0005). Kysely on
// the process's `PLATFORM_DB` (the API's pool, or the worker's for the usage flush and the keys of provisioning),
// schema-qualified tables (ADR-0005). Keys are never deleted: revoking and rolling set `revoked_at` and `expires_at`.
//
// The use cases of the portal also read what decides whether a key may be made, next to the key rows and read only:
// the tenant's status and storefront environment (`tenants`) and its plan's `limits` (`plans`), as TenantsRepository
// reads `tenant_domains` (resource modules of one layer never import each other, architecture §2.2). The writes of a
// tenant's keys that count against the plan's limit are serialised with a transaction-level advisory lock per tenant
// (`lockTenantKeys`), so two concurrent creations cannot both take the last free key.
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import type { ApiKeyEnvironment } from "./api-key-rules";

/** A `platform.api_keys` row as the platform reads it. */
export type ApiKeyRecord = Selectable<PlatformDatabase["platform.api_keys"]>;

/** A key row with the full name of the account that created it (`null` for the keys of provisioning). */
export interface ApiKeyWithCreator extends ApiKeyRecord {
  readonly created_by_full_name: string | null;
}

/** The columns `ApiKeyGenerator.issue` writes. */
export interface ApiKeyInsert {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly kind: string;
  readonly environment: string;
  readonly prefix: string;
  readonly key_hash: string;
  readonly last4: string;
  readonly allowed_origins: string[];
  readonly scopes: string[];
  readonly expires_at: Date | null;
  readonly created_by_account_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** What decides whether a tenant's keys may be created or changed. */
export interface TenantKeyState {
  readonly status: string;
  readonly storefront_environment: string;
  /** `plans.limits` of the tenant's plan (`apiKeys` among them); `null` when the plan row is missing. */
  readonly limits: unknown;
}

/** The filters of `listApiKeys`. */
export interface ApiKeyListFilter {
  readonly environment?: ApiKeyEnvironment | undefined;
  readonly includeRevoked: boolean;
}

/** The name and origins of `updateApiKey`; an absent field is not changed. */
export interface ApiKeySettingsChanges {
  readonly name?: string;
  readonly allowed_origins?: string[];
}

/** One last use of a key, as the usage flush writes it. */
export interface ApiKeyUsage {
  readonly keyId: string;
  readonly at: Date;
  /** The client IP of the request, or `null` when the OTA backend sent none (or none that is an address). */
  readonly ip: string | null;
}

/** How long a usage counter lives in Redis (`apikey:used:<keyId>`, 1 day): the flush looks at keys this recent. */
const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ApiKeysRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * Inserts a key row in `trx` unless its id, prefix or hash exists already (`ON CONFLICT DO NOTHING`, so the
   * transaction stays usable); `undefined` when it did not insert.
   */
  async insertIfNew(trx: PlatformTransaction, row: ApiKeyInsert): Promise<ApiKeyRecord | undefined> {
    return trx
      .insertInto("platform.api_keys")
      .values(row)
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Waits until no other transaction holds the API key lock of `tenantId`, and holds it until `trx` ends
   * (`pg_advisory_xact_lock`), so the limit check and the insert of a key happen as one step per tenant.
   */
  async lockTenantKeys(trx: PlatformTransaction, tenantId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`platform.api_keys:${tenantId}`}, 0))`.execute(
      trx,
    );
  }

  /** The tenant's status, storefront environment and plan limits; `undefined` when there is no such tenant. */
  async tenantState(trx: PlatformTransaction, tenantId: string): Promise<TenantKeyState | undefined> {
    return trx
      .selectFrom("platform.tenants as t")
      .leftJoin("platform.plans as p", "p.code", "t.plan_code")
      .select(["t.status", "t.storefront_environment", "p.limits"])
      .where("t.id", "=", tenantId)
      .executeTakeFirst();
  }

  /** The tenant's keys that count against the plan's limit at `now`: neither revoked nor expired (PADR-0005 item 9). */
  async countActive(trx: PlatformTransaction, tenantId: string, now: Date): Promise<number> {
    const row = await trx
      .selectFrom("platform.api_keys")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("tenant_id", "=", tenantId)
      .where("revoked_at", "is", null)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** The tenant's keys, newest first, with their creators; revoked ones only with `includeRevoked`. */
  async list(tenantId: string, filter: ApiKeyListFilter): Promise<ApiKeyWithCreator[]> {
    let query = this.withCreator(this.db).where("k.tenant_id", "=", tenantId);
    if (filter.environment !== undefined) {
      query = query.where("k.environment", "=", filter.environment);
    }
    if (!filter.includeRevoked) {
      query = query.where("k.revoked_at", "is", null);
    }
    return query.orderBy("k.created_at", "desc").orderBy("k.id", "desc").execute();
  }

  /** The key `keyId` of `tenantId` with its creator, read on `db` (the pool, or the caller's transaction). */
  async findForTenant(
    tenantId: string,
    keyId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<ApiKeyWithCreator | undefined> {
    return this.withCreator(db)
      .where("k.tenant_id", "=", tenantId)
      .where("k.id", "=", keyId)
      .executeTakeFirst();
  }

  /** The key `keyId` of `tenantId`, locked for the rest of the caller's transaction (`FOR UPDATE`). */
  async lockForTenant(
    trx: PlatformTransaction,
    tenantId: string,
    keyId: string,
  ): Promise<ApiKeyRecord | undefined> {
    return trx
      .selectFrom("platform.api_keys")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("id", "=", keyId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Writes the name and origins of `changes` of a row locked by `lockForTenant`. */
  async updateSettings(
    trx: PlatformTransaction,
    keyId: string,
    changes: ApiKeySettingsChanges,
    now: Date,
  ): Promise<void> {
    await trx
      .updateTable("platform.api_keys")
      .set({ ...changes, updated_at: now })
      .where("id", "=", keyId)
      .execute();
  }

  /** Sets the expiry of a row locked by `lockForTenant` (a roll). */
  async setExpiry(trx: PlatformTransaction, keyId: string, expiresAt: Date, now: Date): Promise<void> {
    await trx
      .updateTable("platform.api_keys")
      .set({ expires_at: expiresAt, updated_at: now })
      .where("id", "=", keyId)
      .execute();
  }

  /** Revokes a row locked by `lockForTenant`: `revoked_at` and the revoking account. */
  async revoke(trx: PlatformTransaction, keyId: string, accountId: string, now: Date): Promise<void> {
    await trx
      .updateTable("platform.api_keys")
      .set({ revoked_at: now, revoked_by_account_id: accountId, updated_at: now })
      .where("id", "=", keyId)
      .execute();
  }

  /**
   * One page of the keys whose usage counter may still be in Redis at `now`, in id order after `afterId`: every key
   * revoked or expired less than a day ago, or not at all (a counter lives 1 day, and a key's last request may come
   * just before it is revoked).
   */
  async usageCandidates(now: Date, afterId: string | null, limit: number): Promise<string[]> {
    const since = new Date(now.getTime() - USAGE_WINDOW_MS);
    let query = this.db
      .selectFrom("platform.api_keys")
      .select("id")
      .where((eb) => eb.or([eb("revoked_at", "is", null), eb("revoked_at", ">", since)]))
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", since)]));
    if (afterId !== null) {
      query = query.where("id", ">", afterId);
    }
    const rows = await query.orderBy("id").limit(limit).execute();
    return rows.map((row) => row.id);
  }

  /**
   * Writes the last uses of `usages` into `last_used_at` and `last_used_ip`, in one statement; a use older than the
   * one already stored is left out, so the last use never moves back. Returns the number of keys updated.
   */
  async recordUsage(usages: readonly ApiKeyUsage[]): Promise<number> {
    if (usages.length === 0) {
      return 0;
    }
    const ids = usages.map((usage) => usage.keyId);
    const times = usages.map((usage) => usage.at.toISOString());
    const ips = usages.map((usage) => usage.ip);
    const result = await sql`
      UPDATE platform.api_keys AS k
      SET last_used_at = u.at, last_used_ip = u.ip::inet
      FROM unnest(${ids}::text[], ${times}::timestamptz[], ${ips}::text[]) AS u(id, at, ip)
      WHERE k.id = u.id AND (k.last_used_at IS NULL OR k.last_used_at < u.at)
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  /** The key rows of `db` with the full name of their creator (`accounts`, read only). */
  private withCreator(db: PlatformDb | PlatformTransaction) {
    return db
      .selectFrom("platform.api_keys as k")
      .leftJoin("platform.accounts as a", "a.id", "k.created_by_account_id")
      .selectAll("k")
      .select("a.full_name as created_by_full_name");
  }
}
