// The `amadeus_offices` repository (platform/docs/architecture.md §2.1: SupplierConnectionsModule owns the table;
// PADR-0012). Kysely on the process's `PLATFORM_DB`, schema-qualified tables (ADR-0005). An office is one Amadeus
// office id of a Velexis account's pool: `available` → `assigned` → `releasing` → `available`, or `retired` from
// `available` only. The CHECK `amadeus_offices_assignment_ck` keeps `assigned_tenant_id` set exactly while `assigned`
// or `releasing`, and the partial unique index `amadeus_offices_one_assigned_uq` allows one `assigned` office per
// tenant and account. Offices are never deleted.
//
// Writes go through a row locked with `lock` (`FOR UPDATE`), so two concurrent assignments of one office are
// serialised and the second sees the first one's status. Reads for the API (`AmadeusOfficeView`) add the environment
// (from the account) and the key of the assigned tenant.
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import type { AmadeusEnvironment, AmadeusOfficeStatus } from "./amadeus-accounts.repository";

/** A `platform.amadeus_offices` row as the platform reads it. */
export type AmadeusOfficeRecord = Selectable<PlatformDatabase["platform.amadeus_offices"]>;

/** An office with what the API shows next to it: the account's environment and the assigned tenant's key. */
export interface AmadeusOfficeView extends AmadeusOfficeRecord {
  readonly environment: string;
  readonly tenant_key: string | null;
}

/** The columns `insertNew` writes for each office. */
export interface AmadeusOfficeInsert {
  readonly id: string;
  readonly amadeus_account_id: string;
  readonly office_id: string;
  readonly notes: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** The filters of `adminListAmadeusOffices`. */
export interface AmadeusOfficeFilter {
  readonly accountId?: string | undefined;
  readonly environment?: AmadeusEnvironment | undefined;
  readonly status?: AmadeusOfficeStatus | undefined;
}

/** The available offices of one account, for the daily pool level check. */
export interface AmadeusPoolLevel {
  readonly amadeusAccountId: string;
  readonly name: string;
  readonly environment: string;
  readonly available: number;
}

@Injectable()
export class AmadeusOfficesRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The offices with their environment and the assigned tenant's key. */
  private views(db: PlatformDb | PlatformTransaction) {
    return db
      .selectFrom("platform.amadeus_offices as o")
      .innerJoin("platform.amadeus_accounts as a", "a.id", "o.amadeus_account_id")
      .leftJoin("platform.tenants as t", "t.id", "o.assigned_tenant_id")
      .selectAll("o")
      .select(["a.environment as environment", "t.key as tenant_key"]);
  }

  /** The office `id` with its environment and tenant key, read on `db`; `undefined` when there is none. */
  async findView(
    id: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<AmadeusOfficeView | undefined> {
    return this.views(db).where("o.id", "=", id).executeTakeFirst();
  }

  /**
   * One page of offices, oldest first (`created_at`, then id), after the office `afterId` when given; `limit` rows at
   * most. The keyset compares with the row's stored `created_at`, so no precision is lost in the cursor.
   */
  async list(
    filter: AmadeusOfficeFilter,
    afterId: string | undefined,
    limit: number,
  ): Promise<AmadeusOfficeView[]> {
    let query = this.views(this.db);
    if (filter.accountId !== undefined) {
      query = query.where("o.amadeus_account_id", "=", filter.accountId);
    }
    if (filter.environment !== undefined) {
      query = query.where("a.environment", "=", filter.environment);
    }
    if (filter.status !== undefined) {
      query = query.where("o.status", "=", filter.status);
    }
    if (afterId !== undefined) {
      query = query.where(
        sql<boolean>`(o.created_at, o.id) > (SELECT c.created_at, c.id FROM platform.amadeus_offices c WHERE c.id = ${afterId})`,
      );
    }
    return query.orderBy("o.created_at", "asc").orderBy("o.id", "asc").limit(limit).execute();
  }

  /** True when the office `id` exists (a cursor names an office of this table). */
  async exists(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("platform.amadeus_offices")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Inserts the offices that the account's pool does not hold yet (`ON CONFLICT (amadeus_account_id, office_id) DO
   * NOTHING`, so a concurrent addition of the same id is skipped, not an error) and returns the inserted rows.
   */
  async insertNew(
    trx: PlatformTransaction,
    rows: readonly AmadeusOfficeInsert[],
  ): Promise<AmadeusOfficeRecord[]> {
    if (rows.length === 0) {
      return [];
    }
    return trx
      .insertInto("platform.amadeus_offices")
      .values(rows.map((row) => ({ ...row, status: "available" })))
      .onConflict((conflict) => conflict.columns(["amadeus_account_id", "office_id"]).doNothing())
      .returningAll()
      .execute();
  }

  /** The office `id`, locked for the rest of the caller's transaction (`FOR UPDATE`). */
  async lock(trx: PlatformTransaction, id: string): Promise<AmadeusOfficeRecord | undefined> {
    return trx
      .selectFrom("platform.amadeus_offices")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The tenant's `assigned` office of the account, if any (at most one, `amadeus_offices_one_assigned_uq`). */
  async assignedTo(
    trx: PlatformTransaction,
    accountId: string,
    tenantId: string,
  ): Promise<AmadeusOfficeRecord | undefined> {
    return trx
      .selectFrom("platform.amadeus_offices")
      .selectAll()
      .where("amadeus_account_id", "=", accountId)
      .where("assigned_tenant_id", "=", tenantId)
      .where("status", "=", "assigned")
      .executeTakeFirst();
  }

  /** Replaces the notes of a row locked by `lock`, with `version + 1`. */
  async updateNotes(trx: PlatformTransaction, id: string, notes: string | null, now: Date): Promise<void> {
    await trx
      .updateTable("platform.amadeus_offices")
      .set((eb) => ({ notes, version: eb("version", "+", 1), updated_at: now }))
      .where("id", "=", id)
      .execute();
  }

  /**
   * Assigns a row locked by `lock` (and found `available`) to the tenant, with `version + 1`. Throws (`NoResultError`)
   * when the row is not `available` after all: `returning` makes an update of no row an error.
   */
  async assign(trx: PlatformTransaction, id: string, tenantId: string, now: Date): Promise<void> {
    await trx
      .updateTable("platform.amadeus_offices")
      .set((eb) => ({
        status: "assigned",
        assigned_tenant_id: tenantId,
        assigned_at: now,
        release_requested_at: null,
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", id)
      .where("status", "=", "available")
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  /** Retires a row locked by `lock` (and found `available`), with `version + 1`; throws as `assign` does. */
  async retire(trx: PlatformTransaction, id: string, now: Date): Promise<void> {
    await trx
      .updateTable("platform.amadeus_offices")
      .set((eb) => ({ status: "retired", version: eb("version", "+", 1), updated_at: now }))
      .where("id", "=", id)
      .where("status", "=", "available")
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  /**
   * The available offices of every account that is not `disabled`, `test` before `live` (the daily pool level
   * check of PADR-0012 item 6).
   */
  async poolLevels(): Promise<AmadeusPoolLevel[]> {
    const rows = await this.db
      .selectFrom("platform.amadeus_accounts as a")
      .leftJoin("platform.amadeus_offices as o", (join) =>
        join.onRef("o.amadeus_account_id", "=", "a.id").on("o.status", "=", "available"),
      )
      .select((eb) => [
        "a.id as amadeusAccountId",
        "a.name as name",
        "a.environment as environment",
        eb.fn.count<string>("o.id").as("available"),
      ])
      .where("a.status", "<>", "disabled")
      .groupBy(["a.id", "a.name", "a.environment"])
      .orderBy(sql`CASE a.environment WHEN 'test' THEN 0 ELSE 1 END`)
      .execute();
    return rows.map((row) => ({ ...row, available: Number(row.available) }));
  }
}
