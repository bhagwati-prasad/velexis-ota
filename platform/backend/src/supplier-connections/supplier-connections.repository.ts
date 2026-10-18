// The `supplier_connections` repository (platform/docs/architecture.md §2.1: SupplierConnectionsModule owns the
// table; ADR-0012). One row per tenant, provider and environment (`supplier_connections_env_uq`). A `velexis` row
// uses the Velexis account of its environment through the offices assigned from the pool and holds no credentials of
// its own; a `tenant` row holds the OTA's own credentials (M5, PBE-053). The CHECK `supplier_connections_source_ck`
// keeps the two shapes apart, and the composite foreign key keeps a `velexis` row on the account of its environment.
//
// Writes of a tenant's connection of one environment are serialised with a transaction-level advisory lock
// (`lockTenantEnvironment`), taken after the office row is locked: an admin assignment here and the provisioning
// post-step (PBE-022) both create or complete the row, and the lock makes sure only one of them inserts it.
//
// `toAmadeusConnection` is the API's `AmadeusConnection` of a row: never the client secret or any ciphertext.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import type { AmadeusEnvironment } from "./amadeus-accounts.repository";

export type AmadeusConnection = components["schemas"]["AmadeusConnection"];

/** A `platform.supplier_connections` row as the platform reads it (with the ciphertext: never answer it). */
export type SupplierConnectionRecord = Selectable<PlatformDatabase["platform.supplier_connections"]>;

/** The supplier of every connection today. */
export const AMADEUS_PROVIDER = "amadeus";

/** A tenant as an assignment needs it. */
export interface ConnectionTenant {
  readonly id: string;
  readonly key: string;
  readonly status: string;
}

/** The office fields of a `velexis` connection served by one office (flow §B, PADR-0012). */
export interface VelexisOffice {
  readonly amadeusAccountId: string;
  readonly officeId: string;
}

/** The columns of a new `velexis` connection. */
export interface VelexisConnectionInsert extends VelexisOffice {
  readonly id: string;
  readonly tenantId: string;
  readonly environment: AmadeusEnvironment;
  readonly createdByAccountId: string | null;
  readonly now: Date;
}

@Injectable()
export class SupplierConnectionsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The tenant's id, key and status, read in `trx`; `undefined` when there is no such tenant. */
  async tenant(trx: PlatformTransaction, tenantId: string): Promise<ConnectionTenant | undefined> {
    return trx
      .selectFrom("platform.tenants")
      .select(["id", "key", "status"])
      .where("id", "=", tenantId)
      .executeTakeFirst();
  }

  /**
   * Waits until no other transaction holds the lock of the tenant's Amadeus connection of `environment`, and holds it
   * until `trx` ends (`pg_advisory_xact_lock`).
   */
  async lockTenantEnvironment(
    trx: PlatformTransaction,
    tenantId: string,
    environment: AmadeusEnvironment,
  ): Promise<void> {
    const key = `platform.supplier_connections:${tenantId}:${AMADEUS_PROVIDER}:${environment}`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
  }

  /** The tenant's Amadeus connection of `environment`, locked for the rest of `trx` (`FOR UPDATE`). */
  async lockForTenant(
    trx: PlatformTransaction,
    tenantId: string,
    environment: AmadeusEnvironment,
  ): Promise<SupplierConnectionRecord | undefined> {
    return trx
      .selectFrom("platform.supplier_connections")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", AMADEUS_PROVIDER)
      .where("environment", "=", environment)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The tenant's Amadeus connection of `environment`, read on `db`. */
  async findForTenant(
    tenantId: string,
    environment: AmadeusEnvironment,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<SupplierConnectionRecord | undefined> {
    return db
      .selectFrom("platform.supplier_connections")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", AMADEUS_PROVIDER)
      .where("environment", "=", environment)
      .executeTakeFirst();
  }

  /**
   * Inserts the tenant's `velexis` connection served by one office: `office_ids = {office}`, the default, queuing and
   * owner offices set to it, empty ticketing defaults and monitored queues, `active`.
   */
  async insertVelexis(
    trx: PlatformTransaction,
    row: VelexisConnectionInsert,
  ): Promise<SupplierConnectionRecord> {
    return trx
      .insertInto("platform.supplier_connections")
      .values({
        id: row.id,
        tenant_id: row.tenantId,
        provider: AMADEUS_PROVIDER,
        environment: row.environment,
        credential_source: "velexis",
        amadeus_account_id: row.amadeusAccountId,
        office_ids: [row.officeId],
        default_office_id: row.officeId,
        queuing_office_id: row.officeId,
        owner_office_id: row.officeId,
        // jsonb columns are written as JSON text.
        ticketing_defaults: JSON.stringify({}),
        monitored_queues: JSON.stringify([]),
        status: "active",
        created_by_account_id: row.createdByAccountId,
        created_at: row.now,
        updated_at: row.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Completes a `velexis` connection locked by `lockForTenant` with one office: the account, `office_ids = {office}`,
   * the default, queuing and owner offices set to it, `active`, no error, `version + 1`. Ticketing defaults and
   * monitored queues keep what the OTA set.
   */
  async completeVelexis(
    trx: PlatformTransaction,
    id: string,
    office: VelexisOffice,
    now: Date,
  ): Promise<SupplierConnectionRecord> {
    return trx
      .updateTable("platform.supplier_connections")
      .set((eb) => ({
        amadeus_account_id: office.amadeusAccountId,
        office_ids: [office.officeId],
        default_office_id: office.officeId,
        queuing_office_id: office.officeId,
        owner_office_id: office.officeId,
        status: "active",
        last_error: null,
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", id)
      .where("credential_source", "=", "velexis")
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * The API's `AmadeusConnection` of a row: the office fields, settings and verification state, never the client
 * secret or its ciphertext; `clientId` only for the OTA's own credentials. `pendingSubmission` is the M5 credential
 * submission (PBE-053) and stays `null` until then.
 */
export function toAmadeusConnection(row: SupplierConnectionRecord): AmadeusConnection {
  return {
    id: row.id,
    environment: row.environment as AmadeusConnection["environment"],
    credentialSource: row.credential_source as AmadeusConnection["credentialSource"],
    status: row.status as AmadeusConnection["status"],
    officeIds: [...row.office_ids],
    defaultOfficeId: row.default_office_id,
    queuingOfficeId: row.queuing_office_id,
    ownerOfficeId: row.owner_office_id,
    clientId: row.credential_source === "tenant" ? row.client_id : null,
    ticketingDefaults: row.ticketing_defaults as AmadeusConnection["ticketingDefaults"],
    monitoredQueues: row.monitored_queues as AmadeusConnection["monitoredQueues"],
    lastVerifiedAt: iso(row.last_verified_at),
    lastError: row.last_error,
    pendingSubmission: null,
    version: row.version,
  };
}
