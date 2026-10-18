// The `amadeus_accounts` repository (platform/docs/architecture.md §2.1: SupplierConnectionsModule owns the table;
// ADR-0012, PADR-0012). Kysely on the process's `PLATFORM_DB` (the API's pool, or the worker's for the verification
// job), schema-qualified tables (ADR-0005). There is at most one Velexis account per environment
// (`amadeus_accounts_environment_uq`); rows are never deleted.
//
// The client secret is stored only as the envelope of `client_secret_ciphertext` (associated data
// `platform.amadeus_accounts.client_secret_ciphertext:<id>`, ADR-0010). This class never decrypts it and never returns
// it to a caller that answers a request: `AmadeusAccountsService` maps rows to the API's account without that column.
// It also counts the offices of each account's pool (`amadeus_offices`, the same module's table) for the admin list.
import { Inject, Injectable } from "@nestjs/common";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** A `platform.amadeus_accounts` row as the platform reads it (with the ciphertext: never answer it). */
export type AmadeusAccountRecord = Selectable<PlatformDatabase["platform.amadeus_accounts"]>;

/** The Amadeus environments (`test`, `live`), one Velexis account each. */
export const AMADEUS_ENVIRONMENTS = Object.freeze(["test", "live"] as const);
export type AmadeusEnvironment = (typeof AMADEUS_ENVIRONMENTS)[number];

/** `amadeus_accounts.status` (migration 0002). */
export type AmadeusAccountStatus = "pending_verification" | "active" | "invalid_credentials" | "disabled";

/** `amadeus_offices.status` (PADR-0012 item 1), in the order of the OpenAPI document's `AmadeusOfficeCounts`. */
export const AMADEUS_OFFICE_STATUSES = Object.freeze([
  "available",
  "assigned",
  "releasing",
  "retired",
] as const);
export type AmadeusOfficeStatus = (typeof AMADEUS_OFFICE_STATUSES)[number];

/** The offices of an account's pool in each status. */
export type AmadeusOfficeCounts = Record<AmadeusOfficeStatus, number>;

/** The place of an account's client secret, for the envelope's associated data (ADR-0010). */
export const CLIENT_SECRET_COLUMN = Object.freeze({
  table: "amadeus_accounts",
  column: "client_secret_ciphertext",
} as const);

/** The columns `insertIfNew` writes. */
export interface AmadeusAccountInsert {
  readonly id: string;
  readonly name: string;
  readonly environment: AmadeusEnvironment;
  readonly base_url: string;
  readonly client_id: string;
  readonly client_secret_ciphertext: Buffer;
  readonly encryption_key_id: string;
  readonly created_by_account_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** What `adminUpdateAmadeusAccount` changes; an absent field is not changed. */
export interface AmadeusAccountChanges {
  readonly name?: string;
  readonly base_url?: string;
  readonly client_id?: string;
  readonly client_secret_ciphertext?: Buffer;
  readonly encryption_key_id?: string;
  readonly status?: AmadeusAccountStatus;
  readonly last_error?: string | null;
}

/** The outcome of one verification: the status, and when it succeeded, the time and no error. */
export interface AmadeusAccountVerification {
  readonly status: AmadeusAccountStatus;
  readonly last_error: string | null;
  /** Set on success only; `undefined` keeps the time of the last success. */
  readonly last_verified_at?: Date;
}

/** No offices in any status. */
export function emptyOfficeCounts(): AmadeusOfficeCounts {
  return { available: 0, assigned: 0, releasing: 0, retired: 0 };
}

const isOfficeStatus = (value: string): value is AmadeusOfficeStatus =>
  (AMADEUS_OFFICE_STATUSES as readonly string[]).includes(value);

@Injectable()
export class AmadeusAccountsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** Every account, `test` before `live`. */
  async list(db: PlatformDb | PlatformTransaction = this.db): Promise<AmadeusAccountRecord[]> {
    const rows = await db.selectFrom("platform.amadeus_accounts").selectAll().execute();
    const rank = (environment: string): number => {
      const index = (AMADEUS_ENVIRONMENTS as readonly string[]).indexOf(environment);
      return index === -1 ? AMADEUS_ENVIRONMENTS.length : index;
    };
    return rows.sort((a, b) => rank(a.environment) - rank(b.environment) || (a.id < b.id ? -1 : 1));
  }

  /** The account `id`, read on `db` (the pool, or the caller's transaction); `undefined` when there is none. */
  async find(
    id: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<AmadeusAccountRecord | undefined> {
    return db.selectFrom("platform.amadeus_accounts").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** The account `id`, locked for the rest of the caller's transaction (`FOR UPDATE`). */
  async lock(trx: PlatformTransaction, id: string): Promise<AmadeusAccountRecord | undefined> {
    return trx
      .selectFrom("platform.amadeus_accounts")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Inserts the account of an environment unless that environment (or the id) has one already (`ON CONFLICT DO
   * NOTHING`, so the transaction stays usable and two concurrent creations give one row); `undefined` when it did
   * not insert.
   */
  async insertIfNew(
    trx: PlatformTransaction,
    row: AmadeusAccountInsert,
  ): Promise<AmadeusAccountRecord | undefined> {
    return trx
      .insertInto("platform.amadeus_accounts")
      .values({ ...row, status: "pending_verification" })
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** Writes `changes` to a row locked by `lock`, with `version + 1`, and returns the row as stored. */
  async update(
    trx: PlatformTransaction,
    id: string,
    changes: AmadeusAccountChanges,
    now: Date,
  ): Promise<AmadeusAccountRecord> {
    return trx
      .updateTable("platform.amadeus_accounts")
      .set((eb) => ({ ...changes, version: eb("version", "+", 1), updated_at: now }))
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Writes the outcome of a verification (or, for adminVerifyAmadeusAccount on a disabled account, its start:
   * `pending_verification`) to a row locked by `lock`. The version is not changed: it guards the admin's edits
   * (`If-Match`), and the verification changes none of them.
   */
  async recordVerification(
    trx: PlatformTransaction,
    id: string,
    verification: AmadeusAccountVerification,
    now: Date,
  ): Promise<AmadeusAccountRecord> {
    return trx
      .updateTable("platform.amadeus_accounts")
      .set({ ...verification, updated_at: now })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The offices of each account's pool by status; accounts without offices get zeros. */
  async officeCounts(
    accountIds: readonly string[],
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<Map<string, AmadeusOfficeCounts>> {
    const counts = new Map(accountIds.map((id) => [id, emptyOfficeCounts()]));
    if (accountIds.length === 0) {
      return counts;
    }
    const rows = await db
      .selectFrom("platform.amadeus_offices")
      .select((eb) => ["amadeus_account_id", "status", eb.fn.countAll<string>().as("count")])
      .where("amadeus_account_id", "in", [...accountIds])
      .groupBy(["amadeus_account_id", "status"])
      .execute();
    for (const row of rows) {
      const account = counts.get(row.amadeus_account_id);
      if (account !== undefined && isOfficeStatus(row.status)) {
        account[row.status] = Number(row.count);
      }
    }
    return counts;
  }
}
