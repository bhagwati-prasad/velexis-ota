// The `supplier_connections` repository (platform/docs/architecture.md §2.1: SupplierConnectionsModule owns the
// table; ADR-0012). One row per tenant, provider and environment (`supplier_connections_env_uq`). A `velexis` row
// uses the Velexis account of its environment through the offices assigned from the pool and holds no credentials of
// its own; a `tenant` row holds the OTA's own credentials (M5, PBE-053). The CHECK `supplier_connections_source_ck`
// keeps the two shapes apart, and the composite foreign key keeps a `velexis` row on the account of its environment.
//
// Writes of a tenant's connection of one environment are serialised with a transaction-level advisory lock
// (`lockTenantEnvironment`): an admin assignment here and the provisioning post-step (PBE-022) both create or complete
// the row, and the lock makes sure only one of them inserts it. The admin's assignment takes it after the office row is
// locked; the post-step takes it first and then picks its office with `FOR UPDATE SKIP LOCKED`, which never waits, so
// the two orders cannot deadlock.
//
// `listForTenant` reads a tenant's connections without the ciphertext column (the portal's list, PBE-027), and
// `toAmadeusConnection` is the API's `AmadeusConnection` of a row: never the client secret or any ciphertext.
// `tenantForLiveRequest` (the tenant `FOR SHARE` with its plan's limits) and `activeOwners` are the live office's reads
// (PBE-054: `requestLiveAmadeus`, and the `amadeus.live_ready` e-mail of a live assignment), read only, as the
// operations' `x-platform-tables` say.
// `setStatus` is the platform admin's switch of a connection (PBE-030, `adminSetConnectionStatus`).
// `tenantStatusForShare`, `lockViewForTenant` and `updateSettings` are the portal's settings update (PBE-040,
// `updateAmadeusConnection`): the tenant's row `FOR SHARE` first, then the connection `FOR UPDATE` without the
// ciphertext column, as the payment connection's update does. `switchToTenant` and `insertTenant` apply the OTA's own
// verified credentials (PBE-053, the `amadeus` verifier of `credentials.verify`), under `lockTenantEnvironment`.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import type { AmadeusEnvironment } from "./amadeus-accounts.repository";

export type AmadeusConnection = components["schemas"]["AmadeusConnection"];

/** A `platform.supplier_connections` row as the platform reads it (with the ciphertext: never answer it). */
export type SupplierConnectionRecord = Selectable<PlatformDatabase["platform.supplier_connections"]>;

/** A connection row without its secret: what the API may read to answer (no `client_secret_ciphertext`). */
export type SupplierConnectionView = Omit<SupplierConnectionRecord, "client_secret_ciphertext">;

/** The supplier of every connection today. */
export const AMADEUS_PROVIDER = "amadeus";

/** The columns of a `SupplierConnectionView`: every column but the client secret's ciphertext, never selected. */
const SUPPLIER_CONNECTION_VIEW_COLUMNS = [
  "id",
  "tenant_id",
  "provider",
  "environment",
  "credential_source",
  "amadeus_account_id",
  "base_url",
  "client_id",
  "encryption_key_id",
  "office_ids",
  "default_office_id",
  "queuing_office_id",
  "owner_office_id",
  "ticketing_defaults",
  "monitored_queues",
  "status",
  "last_verified_at",
  "last_error",
  "created_by_account_id",
  "version",
  "created_at",
  "updated_at",
] as const;

/** A tenant as an assignment needs it. */
export interface ConnectionTenant {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: string;
}

/** A tenant as a live office request needs it (PBE-054): its status, name and key, and its plan's limits. */
export interface LiveRequestTenant {
  readonly status: string;
  readonly key: string;
  readonly name: string;
  /** `plans.limits` of the tenant's plan (`liveMode` among them); `null` when the plan row is missing. */
  readonly limits: unknown;
}

/** An active owner of a tenant, with the e-mail address and name the live-ready e-mail needs (PBE-054). */
export interface ConnectionOwner {
  readonly account_id: string;
  readonly email: string;
  readonly full_name: string;
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

/** The columns of a new `velexis` connection that waits for an office (no free office, or no active account). */
export type PendingVelexisConnectionInsert = Omit<VelexisConnectionInsert, "officeId">;

/**
 * The OTA's own verified credentials for a `tenant` connection (PBE-053): the Amadeus host, the client id, the client
 * secret envelope-encrypted for the connection's row (associated data
 * `platform.supplier_connections.client_secret_ciphertext:<sc_id>`, ADR-0010) and its KEK, and the offices (the default,
 * queuing and owner offices among `officeIds`).
 */
export interface TenantCredentials {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecretCiphertext: Uint8Array;
  readonly encryptionKeyId: string;
  readonly officeIds: readonly string[];
  readonly defaultOfficeId: string;
  readonly queuingOfficeId: string;
  readonly ownerOfficeId: string;
}

/** The columns of a new `tenant` connection. */
export interface TenantConnectionInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly environment: AmadeusEnvironment;
  readonly credentials: TenantCredentials;
  readonly createdByAccountId: string | null;
  readonly now: Date;
}

/** The columns a `tenant` connection takes from its credentials (`supplier_connections_source_ck`), verified at `now`. */
function tenantCredentialColumns(credentials: TenantCredentials, now: Date) {
  return {
    credential_source: "tenant",
    amadeus_account_id: null,
    base_url: credentials.baseUrl,
    client_id: credentials.clientId,
    client_secret_ciphertext: Buffer.from(credentials.clientSecretCiphertext),
    encryption_key_id: credentials.encryptionKeyId,
    office_ids: [...credentials.officeIds],
    default_office_id: credentials.defaultOfficeId,
    queuing_office_id: credentials.queuingOfficeId,
    owner_office_id: credentials.ownerOfficeId,
    status: "active",
    last_verified_at: now,
    last_error: null,
  };
}

/**
 * The settings `updateAmadeusConnection` changes (PBE-040): each column that is present replaces the stored value, the
 * jsonb ones as a whole (`ticketing_defaults` as the API's `AmadeusTicketingDefaults`, `monitored_queues` as its list of
 * `AmadeusMonitoredQueue`). Offices, credentials and status are never changed here.
 */
export interface SupplierConnectionSettings {
  readonly default_office_id?: string;
  readonly queuing_office_id?: string;
  readonly owner_office_id?: string;
  readonly ticketing_defaults?: AmadeusConnection["ticketingDefaults"];
  readonly monitored_queues?: AmadeusConnection["monitoredQueues"];
}

@Injectable()
export class SupplierConnectionsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The tenant's id, key, name and status, read in `trx`; `undefined` when there is no such tenant. */
  async tenant(trx: PlatformTransaction, tenantId: string): Promise<ConnectionTenant | undefined> {
    return trx
      .selectFrom("platform.tenants")
      .select(["id", "key", "name", "status"])
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

  /**
   * The tenant's Amadeus connection of `environment`, locked for the rest of `trx` (`FOR UPDATE`) as `lockForTenant`
   * locks it, but read without the client secret's ciphertext (the column is never selected): the portal's settings
   * update (PBE-040) answers from this row when nothing changes.
   */
  async lockViewForTenant(
    trx: PlatformTransaction,
    tenantId: string,
    environment: AmadeusEnvironment,
  ): Promise<SupplierConnectionView | undefined> {
    return trx
      .selectFrom("platform.supplier_connections")
      .select(SUPPLIER_CONNECTION_VIEW_COLUMNS)
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
   * The tenant's Amadeus connections, `test` first, then `live`, read on `db` without the client secret's ciphertext
   * (the column is never selected).
   */
  async listForTenant(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<SupplierConnectionView[]> {
    return db
      .selectFrom("platform.supplier_connections")
      .select(SUPPLIER_CONNECTION_VIEW_COLUMNS)
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", AMADEUS_PROVIDER)
      .orderBy(sql`environment = 'live'`)
      .orderBy("id")
      .execute();
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
   * Inserts the tenant's `velexis` connection without an office (flows/amadeus-connection.md §B, provisioning.md §3):
   * the account of its environment, `office_ids = {}`, no default, queuing or owner office, empty ticketing defaults
   * and monitored queues, `pending_verification`. An admin completes it with an office later
   * (`adminAssignAmadeusOffice`, `completeVelexis`).
   */
  async insertPendingVelexis(
    trx: PlatformTransaction,
    row: PendingVelexisConnectionInsert,
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
        office_ids: [],
        // jsonb columns are written as JSON text.
        ticketing_defaults: JSON.stringify({}),
        monitored_queues: JSON.stringify([]),
        status: "pending_verification",
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

  /**
   * Switches a connection locked by `lockForTenant` to the OTA's own credentials (PBE-053, flows/amadeus-connection.md
   * §D item 3): `credential_source = 'tenant'`, no Velexis account, the host, client id and re-encrypted secret, the
   * offices, `active` and verified now, no error, `version + 1`. Ticketing defaults and monitored queues keep what the
   * OTA set. The row comes back without the client secret's ciphertext.
   */
  async switchToTenant(
    trx: PlatformTransaction,
    id: string,
    credentials: TenantCredentials,
    now: Date,
  ): Promise<SupplierConnectionView> {
    return trx
      .updateTable("platform.supplier_connections")
      .set((eb) => ({
        ...tenantCredentialColumns(credentials, now),
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", id)
      .returning(SUPPLIER_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * Inserts the tenant's connection of `environment` with the OTA's own credentials (PBE-053, flows/amadeus-connection.md
   * §D item 4: own credentials before any Velexis connection of that environment): the columns of `switchToTenant`,
   * empty ticketing defaults and monitored queues, version 1. The caller holds `lockTenantEnvironment`. The row comes back
   * without the client secret's ciphertext.
   */
  async insertTenant(trx: PlatformTransaction, row: TenantConnectionInsert): Promise<SupplierConnectionView> {
    return trx
      .insertInto("platform.supplier_connections")
      .values({
        id: row.id,
        tenant_id: row.tenantId,
        provider: AMADEUS_PROVIDER,
        environment: row.environment,
        ...tenantCredentialColumns(row.credentials, row.now),
        // jsonb columns are written as JSON text.
        ticketing_defaults: JSON.stringify({}),
        monitored_queues: JSON.stringify([]),
        created_by_account_id: row.createdByAccountId,
        created_at: row.now,
        updated_at: row.now,
      })
      .returning(SUPPLIER_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * Sets the status of a connection locked by `lockForTenant` (PBE-030, `adminSetConnectionStatus`: `disabled`, or back
   * to `active`), with `version + 1`, in `trx`. Offices, settings and credentials stay as they are; the row comes back
   * without the client secret's ciphertext.
   */
  async setStatus(
    trx: PlatformTransaction,
    id: string,
    status: "active" | "disabled",
    now: Date,
  ): Promise<SupplierConnectionView> {
    return trx
      .updateTable("platform.supplier_connections")
      .set((eb) => ({ status, version: eb("version", "+", 1), updated_at: now }))
      .where("id", "=", id)
      .returning(SUPPLIER_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * The status of the tenant `tenantId`, read in `trx` with `FOR SHARE`, so the tenant cannot be suspended (or change
   * otherwise) until `trx` ends; `undefined` when there is no such tenant. A portal write to a tenant's connection takes
   * this lock before it locks the connection (`lockViewForTenant`): the tenant first, then its connection.
   */
  async tenantStatusForShare(trx: PlatformTransaction, tenantId: string): Promise<string | undefined> {
    const row = await trx
      .selectFrom("platform.tenants")
      .select("status")
      .where("id", "=", tenantId)
      .forShare()
      .executeTakeFirst();
    return row?.status;
  }

  /**
   * Writes the settings of a connection locked by `lockViewForTenant` (PBE-040, `updateAmadeusConnection`): the columns
   * `settings` holds, with `version + 1`, in `trx`. Offices, credentials and status stay as they are; the row comes back
   * without the client secret's ciphertext.
   */
  async updateSettings(
    trx: PlatformTransaction,
    id: string,
    settings: SupplierConnectionSettings,
    now: Date,
  ): Promise<SupplierConnectionView> {
    return trx
      .updateTable("platform.supplier_connections")
      .set((eb) => ({
        ...(settings.default_office_id === undefined
          ? {}
          : { default_office_id: settings.default_office_id }),
        ...(settings.queuing_office_id === undefined
          ? {}
          : { queuing_office_id: settings.queuing_office_id }),
        ...(settings.owner_office_id === undefined ? {} : { owner_office_id: settings.owner_office_id }),
        // jsonb columns are written as JSON text.
        ...(settings.ticketing_defaults === undefined
          ? {}
          : { ticketing_defaults: JSON.stringify(settings.ticketing_defaults) }),
        ...(settings.monitored_queues === undefined
          ? {}
          : { monitored_queues: JSON.stringify(settings.monitored_queues) }),
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", id)
      .returning(SUPPLIER_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * The tenant `tenantId` with its plan's `limits`, read in `trx` with `FOR SHARE` on the tenant's row, so the tenant
   * cannot be suspended (or change otherwise) until `trx` ends (PBE-054, `requestLiveAmadeus`: the tenant first, then
   * its connection lock); `undefined` when there is no such tenant.
   */
  async tenantForLiveRequest(
    trx: PlatformTransaction,
    tenantId: string,
  ): Promise<LiveRequestTenant | undefined> {
    return trx
      .selectFrom("platform.tenants as t")
      .leftJoin("platform.plans as p", "p.code", "t.plan_code")
      .select(["t.status", "t.key", "t.name", "p.limits"])
      .where("t.id", "=", tenantId)
      .forShare("t")
      .executeTakeFirst();
  }

  /**
   * The active owners of `tenantId`, oldest membership first, with their e-mail address and name (read only), in
   * `trx`: the recipients of the live-ready e-mail (PBE-054). An account that is disabled or deleted gets no e-mail.
   */
  async activeOwners(trx: PlatformTransaction, tenantId: string): Promise<ConnectionOwner[]> {
    return trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(["m.account_id", "a.email", "a.full_name"])
      .where("m.tenant_id", "=", tenantId)
      .where("m.role", "=", "owner")
      .where("m.status", "=", "active")
      .where("a.status", "not in", ["disabled", "deleted"])
      .where("a.deleted_at", "is", null)
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
  }
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * The API's `AmadeusConnection` of a row: the office fields, settings and verification state, never the client
 * secret or its ciphertext; `clientId` only for the OTA's own credentials. `pendingSubmission` is `null` here:
 * `listAmadeusConnections` replaces it with the latest submission of own credentials for the connection's environment
 * while it is open or after it failed (PBE-053, AmadeusCredentialsService.listConnections).
 */
export function toAmadeusConnection(row: SupplierConnectionView): AmadeusConnection {
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
