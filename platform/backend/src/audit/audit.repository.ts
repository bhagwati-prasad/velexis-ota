// The `platform_audit_log` repository (platform/docs/architecture.md §2.1, AuditModule owns the table). It writes only
// in the caller's transaction, so an audit row commits or rolls back with the change it records (PADR-0006, Audit
// item 1). The table is append-only by privilege: velexis_platform_app may insert and select, never update, delete or
// truncate (migration 0002), so this class has no method that changes a row. The admin's audit search and CSV export
// (adminListAudit, adminExportAudit) read the table through `audit-query.service.ts` (PBE-032); the recent rows of one
// OTA, which the admin's tenant detail shows (PBE-029), are read here (`recentForTenant`).
import { Injectable } from "@nestjs/common";
import type { PlatformDatabase, ReferenceDatabase, Selectable, Transaction } from "@velexis/db";
import type { PlatformDb } from "../common/database";

/** A transaction on the platform and reference schemas, opened by the caller (`platformDb.transaction()`). */
export type PlatformTransaction = Transaction<PlatformDatabase & ReferenceDatabase>;

/** A stored `platform_audit_log` row (`id` a decimal string, `details` the parsed jsonb, redacted when written). */
export type AuditLogRecord = Selectable<PlatformDatabase["platform.platform_audit_log"]>;

/** One row to insert, already redacted, with the column names of `platform.platform_audit_log`. */
export interface AuditRowInsert {
  readonly actorType: string;
  readonly actorAccountId: string | null;
  /** `null` takes the actor account's e-mail address at the time of the action, when there is an actor account. */
  readonly actorLabel: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly tenantId: string | null;
  /** `null` takes the tenant's key at the time of the action, when there is a tenant. */
  readonly tenantKey: string | null;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** The JSON text of the `details` object (jsonb columns are written as JSON text). */
  readonly detailsJson: string;
}

/** What the insert returns: the identity id (a decimal string, as the API shows it) and the time of the row. */
export interface AuditRowInserted {
  readonly id: string;
  readonly createdAt: Date;
}

@Injectable()
export class AuditRepository {
  /**
   * Inserts one row in `trx`. The snapshots (`actor_label`, `tenant_key`) default to the account's e-mail address and
   * the tenant's key as the same transaction sees them, so a tenant created in that transaction has its key already.
   */
  async insert(trx: PlatformTransaction, row: AuditRowInsert): Promise<AuditRowInserted> {
    const { actorAccountId, tenantId } = row;
    const inserted = await trx
      .insertInto("platform.platform_audit_log")
      .values((eb) => ({
        actor_type: row.actorType,
        actor_account_id: actorAccountId,
        actor_label:
          row.actorLabel ??
          (actorAccountId === null
            ? null
            : eb.selectFrom("platform.accounts").select("email").where("id", "=", actorAccountId)),
        action: row.action,
        target_type: row.targetType,
        target_id: row.targetId,
        tenant_id: tenantId,
        tenant_key:
          row.tenantKey ??
          (tenantId === null
            ? null
            : eb.selectFrom("platform.tenants").select("key").where("id", "=", tenantId)),
        request_id: row.requestId,
        ip_address: row.ipAddress,
        user_agent: row.userAgent,
        details: row.detailsJson,
      }))
      .returning(["id", "created_at"])
      .executeTakeFirstOrThrow();
    return { id: inserted.id, createdAt: inserted.created_at };
  }

  /**
   * The last `limit` rows about the OTA `tenantId` (`tenant_id`), newest first (the identity `id` grows with every
   * insert), read on `db` (the pool, or the caller's transaction).
   */
  async recentForTenant(
    db: PlatformDb | PlatformTransaction,
    tenantId: string,
    limit: number,
  ): Promise<AuditLogRecord[]> {
    return db
      .selectFrom("platform.platform_audit_log")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }
}
