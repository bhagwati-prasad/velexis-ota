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
// `lockForTenant` and `setStatementDescriptorSuffix`, PBE-038); go-live's live row and the API-key mode add their reads
// and writes. Connect Standard (PBE-055, flows/stripe-payments-account.md §C, PADR-0011 item 2) reads who starts it
// and the OTA's state (`connectStarter`, `connectMember`, `tenantForShare`: the tenant, the membership and, for the
// start only, the account, read only, as the operations' `x-platform-tables` say), finds an account connected to
// another OTA (`connectedElsewhere`) or still connected to any OTA (`connectedHolderOf`, for the livemode mismatch's
// deauthorisation, FIX-W37-PLATFORM), and switches a locked row, or inserts a missing one, to `connect_standard` with
// the OTA's `acct_…` and no key or secret (`applyConnectStandard`, `insertConnectStandard`). The Connect account events
// (PBE-056, flows/stripe-payments-account.md §C item 5, PADR-0011 item 3) find the `connect_standard` rows of one
// `acct_…` (`connectRowsOfAccount`, and `lockConnectRowsOfAccount` in the write's transaction), refresh their
// capabilities and status (`refreshConnectAccount`), disable them with `disconnected_at` (`disconnectConnect`), and
// read the OTA's name and key and its active owners for the owners' e-mail (`tenantLabel`, `activeOwners`, read only).
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { MEMBER_VISIBLE_TENANT_STATUSES } from "../common/auth/tenant-role.guard";
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

/** What Stripe says of a connected account (`account.updated` refreshes it), as `capabilities` stores it. */
export interface ConnectCapabilities {
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
}

/** The columns a Connect Standard connection gets (PADR-0011 item 2). */
export interface ConnectStandardWrite {
  /** `acct_…`: the OTA's own Stripe account (`payment_provider_connections_mode_ck`). */
  readonly accountReference: string;
  readonly capabilities: ConnectCapabilities;
  /** `active` when the account can take charges, `pending` until `account.updated` says so. */
  readonly status: "active" | "pending";
  /** The owner or admin who connected it. */
  readonly connectedByAccountId: string;
  readonly now: Date;
}

/** A missing connection of `environment`, inserted in Connect Standard mode. */
export interface ConnectStandardInsert extends ConnectStandardWrite {
  /** `ppc_…`. */
  readonly id: string;
  readonly tenantId: string;
  readonly environment: PaymentEnvironment;
  readonly statementDescriptorSuffix: string | null;
}

/** A Connect OAuth's member: the account's active membership (`stf_…`) and role, and the OTA's status. */
export interface ConnectMember {
  readonly membership_id: string;
  readonly role: string;
  readonly tenant_status: string;
}

/** Who starts a Connect OAuth: the ConnectMember of the caller and the e-mail address. */
export interface ConnectStarter extends ConnectMember {
  readonly email: string;
}

/** The OTA of a Connect OAuth, read `FOR SHARE`. */
export interface ConnectTenant {
  readonly status: string;
  /** `live` once the OTA went live: its live connection is switched too. */
  readonly storefront_environment: string;
}

/** What `account.updated` refreshes on a Connect connection (PBE-056). */
export interface ConnectAccountRefresh {
  readonly capabilities: ConnectCapabilities;
  /** The status after the event (`active` or `pending` for a connection in one of those; else the one it has). */
  readonly status: string;
  readonly now: Date;
}

/** The OTA's name and key for the owners' e-mails, with what says whether its members still see it. */
export interface PaymentConnectionTenantLabel {
  readonly name: string;
  readonly key: string;
  readonly status: string;
  readonly deleted_at: Date | null;
}

/** An active owner of an OTA: a recipient of the owners' e-mails. */
export interface PaymentConnectionOwner {
  readonly account_id: string;
  readonly email: string;
  readonly full_name: string;
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

  /**
   * The account's **active** membership of `tenantId` (in a tenant members may see, as TenantRoleGuard reads it) with
   * its role and the tenant's status (completeStripeConnect, which reads no account); `undefined` without such a
   * membership. Read on the pool.
   */
  async connectMember(tenantId: string, accountId: string): Promise<ConnectMember | undefined> {
    return this.memberOf(tenantId, accountId).executeTakeFirst();
  }

  /**
   * The ConnectMember of the caller with the account's e-mail address, which startStripeConnect prefills Stripe's
   * form with; `undefined` without such a membership. Read on the pool.
   */
  async connectStarter(tenantId: string, accountId: string): Promise<ConnectStarter | undefined> {
    return this.memberOf(tenantId, accountId)
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select("a.email")
      .executeTakeFirst();
  }

  /**
   * The status and storefront environment of the tenant `tenantId`, read in `trx` with `FOR SHARE` (the tenant first,
   * then its connections, as `tenantStatusForShare`); `undefined` when there is no such tenant.
   */
  async tenantForShare(trx: PlatformTransaction, tenantId: string): Promise<ConnectTenant | undefined> {
    return trx
      .selectFrom("platform.tenants")
      .select(["status", "storefront_environment"])
      .where("id", "=", tenantId)
      .forShare()
      .executeTakeFirst();
  }

  /**
   * The tenant whose `connect_standard` Stripe connection holds `accountReference`, when it is not `tenantId`; read on
   * `db` (the pool, or the caller's transaction). One `acct_…` per OTA: Connect events are routed by `event.account`
   * (PADR-0011 item 2, `payment_provider_connections_connect_uq`).
   */
  async connectedElsewhere(
    accountReference: string,
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<string | undefined> {
    const row = await db
      .selectFrom("platform.payment_provider_connections")
      .select("tenant_id")
      .where("provider", "=", STRIPE_PROVIDER)
      .where("account_mode", "=", "connect_standard")
      .where("account_reference", "=", accountReference)
      .where("tenant_id", "<>", tenantId)
      .orderBy("id")
      .executeTakeFirst();
    return row?.tenant_id;
  }

  /**
   * The tenant of a `connect_standard` Stripe connection that holds `accountReference` and is still connected
   * (`disconnected_at` empty: active, pending, or disabled by a platform admin), of any OTA (the caller's too) and any
   * environment; `undefined` when none does, in particular when every connection that names the account was disabled
   * by a Stripe deauthorisation (`disconnected_at` set). Read on the pool. A livemode mismatch of the Connect callback
   * deauthorises the account only when this is `undefined` (FIX-W37-PLATFORM, lead decision (2a) of 2026-10-31).
   */
  async connectedHolderOf(accountReference: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("platform.payment_provider_connections")
      .select("tenant_id")
      .where("provider", "=", STRIPE_PROVIDER)
      .where("account_mode", "=", "connect_standard")
      .where("account_reference", "=", accountReference)
      .where("disconnected_at", "is", null)
      .orderBy("id")
      .executeTakeFirst();
    return row?.tenant_id;
  }

  /**
   * Switches a connection locked by `lockForTenant` to Connect Standard in `trx` (flows/stripe-payments-account.md §C
   * item 4): `account_mode = 'connect_standard'`, the `acct_…`, no publishable key, no secret and no key id (the
   * storefront uses Velexis's publishable key with `stripeAccount`, the OTA backend Velexis's secret key with
   * `Stripe-Account`), the capabilities, `connected_at`, no `disconnected_at` or `last_error`, the status, the account
   * that set the mode up, `version + 1`. The row comes back without the ciphertexts.
   */
  async applyConnectStandard(
    trx: PlatformTransaction,
    id: string,
    write: ConnectStandardWrite,
  ): Promise<PaymentConnectionView> {
    return trx
      .updateTable("platform.payment_provider_connections")
      .set((eb) => ({
        account_mode: "connect_standard",
        account_reference: write.accountReference,
        publishable_key: null,
        secret_ciphertext: null,
        webhook_secret_ciphertext: null,
        encryption_key_id: null,
        capabilities: JSON.stringify(write.capabilities),
        connected_at: write.now,
        disconnected_at: null,
        last_error: null,
        status: write.status,
        created_by_account_id: write.connectedByAccountId,
        version: eb("version", "+", 1),
        updated_at: write.now,
      }))
      .where("id", "=", id)
      .returning(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * Inserts the tenant's Stripe connection of an environment that has none yet, in Connect Standard mode, in `trx`:
   * the columns of `applyConnectStandard`, `manual` capture and the default connection of the environment. The row
   * comes back without the ciphertexts.
   */
  async insertConnectStandard(
    trx: PlatformTransaction,
    row: ConnectStandardInsert,
  ): Promise<PaymentConnectionView> {
    return trx
      .insertInto("platform.payment_provider_connections")
      .values({
        id: row.id,
        tenant_id: row.tenantId,
        provider: STRIPE_PROVIDER,
        environment: row.environment,
        account_mode: "connect_standard",
        account_reference: row.accountReference,
        capture_mode: "manual",
        is_default: true,
        status: row.status,
        statement_descriptor_suffix: row.statementDescriptorSuffix,
        capabilities: JSON.stringify(row.capabilities),
        connected_at: row.now,
        created_by_account_id: row.connectedByAccountId,
        created_at: row.now,
        updated_at: row.now,
      })
      .returning(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * The `connect_standard` Stripe connections that hold `accountReference` (every OTA's, every environment), `test`
   * first, read on `db` without the ciphertexts. One `acct_…` per OTA and environment
   * (`payment_provider_connections_connect_uq`), so at most the test and the live connection of one OTA in practice.
   */
  async connectRowsOfAccount(
    accountReference: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<PaymentConnectionView[]> {
    return this.connectRowsQuery(db, accountReference).execute();
  }

  /**
   * The rows of `connectRowsOfAccount`, locked for the rest of `trx` (`FOR UPDATE`), `test` before `live` as
   * `lockForTenant` takes them, so a Connect callback of the same OTA never waits for them in the other order.
   */
  async lockConnectRowsOfAccount(
    trx: PlatformTransaction,
    accountReference: string,
  ): Promise<PaymentConnectionView[]> {
    return this.connectRowsQuery(trx, accountReference).forUpdate().execute();
  }

  /**
   * Writes what `account.updated` re-fetched on a connection locked by `lockConnectRowsOfAccount`, in `trx`: the
   * capabilities and the status, `version + 1`. The mode, the account and `connected_at` stay as they are; the row comes
   * back without the ciphertexts.
   */
  async refreshConnectAccount(
    trx: PlatformTransaction,
    id: string,
    refresh: ConnectAccountRefresh,
  ): Promise<PaymentConnectionView> {
    return trx
      .updateTable("platform.payment_provider_connections")
      .set((eb) => ({
        capabilities: JSON.stringify(refresh.capabilities),
        status: refresh.status,
        version: eb("version", "+", 1),
        updated_at: refresh.now,
      }))
      .where("id", "=", id)
      .returning(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /**
   * Disables a connection locked by `lockConnectRowsOfAccount` because the OTA deauthorised Velexis in Stripe
   * (`account.application.deauthorized`), in `trx`: `status = 'disabled'`, `disconnected_at`, `version + 1`. The mode
   * stays `connect_standard` and the account reference stays (no fallback to `velexis`, PADR-0011 item 4); the row comes
   * back without the ciphertexts.
   */
  async disconnectConnect(trx: PlatformTransaction, id: string, now: Date): Promise<PaymentConnectionView> {
    return trx
      .updateTable("platform.payment_provider_connections")
      .set((eb) => ({
        status: "disabled",
        disconnected_at: now,
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", id)
      .returning(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** The name, key, status and deletion time of the tenant `tenantId`, read on `db`; `undefined` without one. */
  async tenantLabel(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<PaymentConnectionTenantLabel | undefined> {
    return db
      .selectFrom("platform.tenants")
      .select(["name", "key", "status", "deleted_at"])
      .where("id", "=", tenantId)
      .executeTakeFirst();
  }

  /**
   * The active owners of `tenantId`, oldest membership first, with their e-mail address and name (read only), in
   * `trx`. An account that is disabled or deleted is left out.
   */
  async activeOwners(trx: PlatformTransaction, tenantId: string): Promise<PaymentConnectionOwner[]> {
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

  /** The query of `connectRowsOfAccount`: the `connect_standard` rows of the account, `test` first. */
  private connectRowsQuery(db: PlatformDb | PlatformTransaction, accountReference: string) {
    return db
      .selectFrom("platform.payment_provider_connections")
      .select(PAYMENT_CONNECTION_VIEW_COLUMNS)
      .where("provider", "=", STRIPE_PROVIDER)
      .where("account_mode", "=", "connect_standard")
      .where("account_reference", "=", accountReference)
      .orderBy(sql`environment = 'live'`)
      .orderBy("id");
  }

  /** The query of `connectMember`: the active membership of the account in a tenant its members may see. */
  private memberOf(tenantId: string, accountId: string) {
    return this.db
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.tenants as t", "t.id", "m.tenant_id")
      .select(["m.id as membership_id", "m.role", "t.status as tenant_status"])
      .where("m.tenant_id", "=", tenantId)
      .where("m.account_id", "=", accountId)
      .where("m.status", "=", "active")
      .where("t.status", "in", MEMBER_VISIBLE_TENANT_STATUSES)
      .where("t.deleted_at", "is", null);
  }
}
