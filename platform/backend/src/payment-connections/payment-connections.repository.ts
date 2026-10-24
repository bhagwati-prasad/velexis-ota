// The `payment_provider_connections` repository (platform/docs/architecture.md §2.1: PaymentConnectionsModule owns the
// table; ADR-0011, PADR-0011). One row per tenant, provider and environment (`payment_provider_connections_uq`). In
// `velexis` mode the OTA's customers pay on the Velexis Stripe account: the row holds no account reference and no
// secret of the OTA (`payment_provider_connections_mode_ck`), only the capture mode and the card statement descriptor
// suffix; the OTA backend uses Velexis's keys from its environment file. Kysely on the process's `PLATFORM_DB`,
// schema-qualified tables (ADR-0005).
//
// M1 brings the `velexis` test row of a new OTA, which the provisioning post-step `create_payment_connection` inserts
// (PBE-022, flows/stripe-payments-account.md §A step 1), and the portal's list, read without the ciphertext columns
// (`listForTenant`, PBE-027), and the platform admin's switch of a connection's status (`lockForTenant` and
// `setStatus`, PBE-030, `adminSetConnectionStatus`). M3 adds the portal's descriptor update (`tenantStatusForShare`,
// `lockForTenant` and `setStatementDescriptorSuffix`, PBE-038); go-live's live row and the M5 modes (Connect Standard,
// API keys) add their reads and writes.
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** A `platform.payment_provider_connections` row as the platform reads it (with the ciphertexts: never answer it). */
export type PaymentConnectionRecord = Selectable<PlatformDatabase["platform.payment_provider_connections"]>;

/**
 * A connection row without its secrets: what the API may read to answer (no `secret_ciphertext`, no
 * `webhook_secret_ciphertext`).
 */
export type PaymentConnectionView = Omit<
  PaymentConnectionRecord,
  "secret_ciphertext" | "webhook_secret_ciphertext"
>;

/** The payment provider of every connection in the MVP. */
export const STRIPE_PROVIDER = "stripe";

/** The columns of a `PaymentConnectionView`: every column but the secrets' ciphertexts, which are never selected. */
const PAYMENT_CONNECTION_VIEW_COLUMNS = [
  "id",
  "tenant_id",
  "provider",
  "environment",
  "account_mode",
  "account_reference",
  "publishable_key",
  "encryption_key_id",
  "supported_methods",
  "capture_mode",
  "is_default",
  "status",
  "statement_descriptor_suffix",
  "capabilities",
  "connected_at",
  "disconnected_at",
  "last_verified_at",
  "last_error",
  "created_by_account_id",
  "version",
  "created_at",
  "updated_at",
] as const;

/** The environments of a payment connection (they match the API key environments). */
export type PaymentEnvironment = "test" | "live";

/** The columns of a new `velexis`-mode connection. */
export interface VelexisPaymentConnectionInsert {
  /** `ppc_…`. */
  readonly id: string;
  readonly tenantId: string;
  readonly environment: PaymentEnvironment;
  /** The card statement descriptor suffix (descriptor.ts), or `null` for none. */
  readonly statementDescriptorSuffix: string | null;
  /** The account that set the mode up; `null` for provisioning. */
  readonly createdByAccountId: string | null;
  readonly now: Date;
}

@Injectable()
export class PaymentConnectionsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * Inserts the tenant's `velexis`-mode Stripe connection of `environment` in `trx`: `account_mode = 'velexis'`,
   * `capture_mode = 'manual'` (authorise at checkout, capture once the booking succeeded), the default connection of
   * the environment, `active`, no account reference, keys or secrets. `ON CONFLICT (tenant_id, provider, environment)
   * DO NOTHING`: a tenant that has a Stripe connection of that environment keeps it, and `undefined` is returned.
   */
  async insertVelexisIfAbsent(
    trx: PlatformTransaction,
    row: VelexisPaymentConnectionInsert,
  ): Promise<PaymentConnectionRecord | undefined> {
    return trx
      .insertInto("platform.payment_provider_connections")
      .values({
        id: row.id,
        tenant_id: row.tenantId,
        provider: STRIPE_PROVIDER,
        environment: row.environment,
        account_mode: "velexis",
        capture_mode: "manual",
        is_default: true,
        status: "active",
        statement_descriptor_suffix: row.statementDescriptorSuffix,
        created_by_account_id: row.createdByAccountId,
        created_at: row.now,
        updated_at: row.now,
      })
      .onConflict((conflict) => conflict.columns(["tenant_id", "provider", "environment"]).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * The tenant's Stripe connections, `test` first, then `live`, read on `db` without the secrets' ciphertexts (the
   * columns are never selected).
   */
  async listForTenant(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<PaymentConnectionView[]> {
    return db
      .selectFrom("platform.payment_provider_connections")
      .select(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", STRIPE_PROVIDER)
      .orderBy(sql`environment = 'live'`)
      .orderBy("id")
      .execute();
  }

  /** The tenant's Stripe connection of `environment`, read on `db` (the pool, or the caller's transaction). */
  async findForTenant(
    tenantId: string,
    environment: PaymentEnvironment,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<PaymentConnectionRecord | undefined> {
    return db
      .selectFrom("platform.payment_provider_connections")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", STRIPE_PROVIDER)
      .where("environment", "=", environment)
      .executeTakeFirst();
  }

  /**
   * The tenant's Stripe connection of `environment`, locked for the rest of `trx` (`FOR UPDATE`), read without the
   * secrets' ciphertexts.
   */
  async lockForTenant(
    trx: PlatformTransaction,
    tenantId: string,
    environment: PaymentEnvironment,
  ): Promise<PaymentConnectionView | undefined> {
    return trx
      .selectFrom("platform.payment_provider_connections")
      .select(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .where("tenant_id", "=", tenantId)
      .where("provider", "=", STRIPE_PROVIDER)
      .where("environment", "=", environment)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Sets the status of a connection locked by `lockForTenant` (`disabled`, or back to `active`), with `version + 1`, in
   * `trx`. The mode, the account and the secrets stay as they are; the row comes back without the ciphertexts.
   */
  async setStatus(
    trx: PlatformTransaction,
    id: string,
    status: "active" | "disabled",
    now: Date,
  ): Promise<PaymentConnectionView> {
    return trx
      .updateTable("platform.payment_provider_connections")
      .set((eb) => ({ status, version: eb("version", "+", 1), updated_at: now }))
      .where("id", "=", id)
      .returning(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * The status of the tenant `tenantId`, read in `trx` with `FOR SHARE`, so the tenant cannot be suspended (or change
   * otherwise) until `trx` ends; `undefined` when there is no such tenant. A write to a tenant's connection takes this
   * lock before it locks the connection (`lockForTenant`): the tenant first, then its connection.
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
   * Sets the card statement descriptor suffix of a connection locked by `lockForTenant`, with `version + 1`, in `trx`
   * (`updatePaymentConnection`, PBE-038). The suffix must meet descriptor.ts's rules of a typed suffix; the column's
   * CHECK refuses anything else. The row comes back without the ciphertexts.
   */
  async setStatementDescriptorSuffix(
    trx: PlatformTransaction,
    id: string,
    suffix: string,
    now: Date,
  ): Promise<PaymentConnectionView> {
    return trx
      .updateTable("platform.payment_provider_connections")
      .set((eb) => ({ statement_descriptor_suffix: suffix, version: eb("version", "+", 1), updated_at: now }))
      .where("id", "=", id)
      .returning(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }
}
