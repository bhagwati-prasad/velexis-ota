// The `payment_provider_connections` repository (platform/docs/architecture.md §2.1: PaymentConnectionsModule owns the
// table; ADR-0011, PADR-0011). One row per tenant, provider and environment (`payment_provider_connections_uq`). In
// `velexis` mode the OTA's customers pay on the Velexis Stripe account: the row holds no account reference and no
// secret of the OTA (`payment_provider_connections_mode_ck`), only the capture mode and the card statement descriptor
// suffix; the OTA backend uses Velexis's keys from its environment file. Kysely on the process's `PLATFORM_DB`,
// schema-qualified tables (ADR-0005).
//
// M1 brings the `velexis` test row of a new OTA, which the provisioning post-step `create_payment_connection` inserts
// (PBE-022, flows/stripe-payments-account.md §A step 1); the descriptor update (PBE-038), go-live's live row and the M5
// modes (Connect Standard, API keys) add their reads and writes.
import { Inject, Injectable } from "@nestjs/common";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** A `platform.payment_provider_connections` row as the platform reads it (with the ciphertexts: never answer it). */
export type PaymentConnectionRecord = Selectable<PlatformDatabase["platform.payment_provider_connections"]>;

/** The payment provider of every connection in the MVP. */
export const STRIPE_PROVIDER = "stripe";

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
}
