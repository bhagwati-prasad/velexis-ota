// The `billing_customers` repository (PBE-044; platform/docs/architecture.md §2.1: BillingModule owns the table,
// PADR-0002 item 1): one Stripe Customer per OTA, created on its first Checkout and reused for every later Checkout and
// Customer Portal session, also after a cancellation. Billing sync (PBE-045) upserts the row and copies the billing
// e-mail back. Kysely on the API's `PLATFORM_DB` (ADR-0005).
//
// `customerContext` reads what a new Customer is made of: the OTA's legal name, else its name, and the e-mail address
// of the owner who starts the Checkout. It reads `tenants` and `accounts` (the tables of TenantsModule and AuthModule,
// same layer) without writing them, as the other billing reads join `tenants`.
//
// `billing_customer_attempts` (migration 0003, PADR-0002 item 3 revision of 2026-10-24) holds the attempt of the
// Customer creation while it has failed: no row is attempt 0 (Stripe idempotency key `customer:<tenantId>`), a row
// attempt n (`customer:<tenantId>:<n>`). `advanceCustomerAttempt` moves it on after a failure that spent the key, as a
// compare-and-set, so concurrent failures of one attempt move it once.
import { Inject, Injectable } from "@nestjs/common";
import { sql, type PlatformDatabase, type Selectable } from "@velexis/db";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** A row of `billing_customers`, as Checkout and the Customer Portal read it. */
export type BillingCustomerRow = Pick<
  Selectable<PlatformDatabase["platform.billing_customers"]>,
  "tenant_id" | "provider_customer_id" | "livemode"
>;

/** What a new Stripe Customer of an OTA is made of (PADR-0002 item 1). */
export interface CustomerContext {
  /** The OTA's legal name, else its name. */
  readonly name: string;
  /** The e-mail address of the owner who starts the Checkout. */
  readonly email: string;
}

/** A Stripe Customer created for an OTA, to store. */
export interface NewBillingCustomer {
  readonly tenantId: string;
  /** `cus_…`. */
  readonly customerId: string;
  readonly livemode: boolean;
  /** The e-mail address the Customer was created with; billing sync keeps it up to date. */
  readonly billingEmail: string;
  readonly now: Date;
}

const ROW_COLUMNS = ["tenant_id", "provider_customer_id", "livemode"] as const;

/** A Customer creation that moves on from attempt `from` (`advanceCustomerAttempt`). */
export interface CustomerAttemptMove {
  readonly tenantId: string;
  /** The attempt whose key the failure spent. */
  readonly from: number;
  readonly now: Date;
}

@Injectable()
export class BillingCustomersRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** The Stripe Customer of `tenantId`, read on `db`; `undefined` while the OTA has none. */
  async find(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<BillingCustomerRow | undefined> {
    return db
      .selectFrom("platform.billing_customers")
      .select(ROW_COLUMNS)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
  }

  /**
   * The name and e-mail address of a new Customer of `tenantId` whose Checkout `accountId` starts (see the file
   * header); `undefined` when the tenant or the account does not exist.
   */
  async customerContext(tenantId: string, accountId: string): Promise<CustomerContext | undefined> {
    return this.db
      .selectFrom("platform.tenants as t")
      .innerJoin("platform.accounts as a", (join) => join.on("a.id", "=", accountId))
      .select([sql<string>`coalesce(t.legal_name, t.name)`.as("name"), "a.email"])
      .where("t.id", "=", tenantId)
      .executeTakeFirst();
  }

  /** The attempt of the next Stripe Customer creation of `tenantId`: 0 until a creation spent its key. */
  async customerAttempt(tenantId: string): Promise<number> {
    const row = await this.db
      .selectFrom("platform.billing_customer_attempts")
      .select("attempt")
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    return row?.attempt ?? 0;
  }

  /**
   * Moves the Customer creation of `tenantId` from attempt `from` to `from + 1`, unless another request moved it from
   * `from` already (one statement: an insert of attempt 1, or an update guarded by the attempt it saw), and answers the
   * attempt now stored.
   */
  async advanceCustomerAttempt(move: CustomerAttemptMove): Promise<number> {
    if (!Number.isSafeInteger(move.from) || move.from < 0) {
      throw new RangeError("advanceCustomerAttempt: the attempt must be a whole number from 0");
    }
    await this.db
      .insertInto("platform.billing_customer_attempts")
      .values({ tenant_id: move.tenantId, attempt: move.from + 1, updated_at: move.now })
      .onConflict((conflict) =>
        conflict
          .column("tenant_id")
          .doUpdateSet((eb) => ({
            attempt: eb.ref("excluded.attempt"),
            updated_at: eb.ref("excluded.updated_at"),
          }))
          .where("platform.billing_customer_attempts.attempt", "=", move.from),
      )
      .execute();
    return this.customerAttempt(move.tenantId);
  }

  /**
   * Stores the Customer of an OTA unless it has one already (`ON CONFLICT (tenant_id) DO NOTHING`; a concurrent first
   * Checkout of the OTA waits for the other insert), and answers the OTA's stored Customer: this one, or the one that
   * was there first.
   */
  async insertIfAbsent(customer: NewBillingCustomer): Promise<BillingCustomerRow> {
    await this.db
      .insertInto("platform.billing_customers")
      .values({
        tenant_id: customer.tenantId,
        provider: "stripe",
        provider_customer_id: customer.customerId,
        livemode: customer.livemode,
        billing_email: customer.billingEmail,
        created_at: customer.now,
        updated_at: customer.now,
      })
      .onConflict((conflict) => conflict.column("tenant_id").doNothing())
      .execute();
    const stored = await this.find(customer.tenantId);
    if (stored === undefined) {
      throw new Error("insertIfAbsent: the Stripe Customer of the tenant cannot be read back");
    }
    return stored;
  }

  /** The tenant whose stored Customer is `customerId` (`cus_…` is unique), read in `trx`; `undefined` for none. */
  async tenantOfCustomer(trx: PlatformTransaction, customerId: string): Promise<string | undefined> {
    const row = await trx
      .selectFrom("platform.billing_customers")
      .select("tenant_id")
      .where("provider_customer_id", "=", customerId)
      .executeTakeFirst();
    return row?.tenant_id;
  }

  /**
   * Stores the Customer that paid a completed Checkout as the OTA's Customer in `trx` (PBE-045, billing sync): a new
   * row, or the stored one (locked) with this Customer, its `livemode` and the e-mail address Checkout collected (the
   * stored one when Checkout gave none). Nothing is written when nothing differs. The caller checks first that no other
   * OTA holds the Customer (`tenantOfCustomer`), so the unique `cus_…` never fails here.
   */
  async upsertFromSync(
    trx: PlatformTransaction,
    customer: SyncedBillingCustomer,
  ): Promise<BillingCustomerSync> {
    const stored = await trx
      .selectFrom("platform.billing_customers")
      .select(["provider_customer_id", "livemode", "billing_email"])
      .where("tenant_id", "=", customer.tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (stored === undefined) {
      await trx
        .insertInto("platform.billing_customers")
        .values({
          tenant_id: customer.tenantId,
          provider: "stripe",
          provider_customer_id: customer.customerId,
          livemode: customer.livemode,
          billing_email: customer.billingEmail,
          created_at: customer.now,
          updated_at: customer.now,
        })
        .execute();
      return { previousCustomerId: null, changed: true };
    }
    const billingEmail = customer.billingEmail ?? stored.billing_email;
    if (
      stored.provider_customer_id === customer.customerId &&
      stored.livemode === customer.livemode &&
      stored.billing_email === billingEmail
    ) {
      return { previousCustomerId: stored.provider_customer_id, changed: false };
    }
    await trx
      .updateTable("platform.billing_customers")
      .set({
        provider_customer_id: customer.customerId,
        livemode: customer.livemode,
        billing_email: billingEmail,
        updated_at: customer.now,
      })
      .where("tenant_id", "=", customer.tenantId)
      .execute();
    return { previousCustomerId: stored.provider_customer_id, changed: true };
  }
}

/** The Stripe Customer of a completed Checkout, as billing sync stores it (PBE-045, `upsertFromSync`). */
export interface SyncedBillingCustomer {
  readonly tenantId: string;
  /** `cus_…`: the session's Customer. */
  readonly customerId: string;
  readonly livemode: boolean;
  /** The e-mail address Checkout collected (`customer_details.email`); `null` keeps the stored one. */
  readonly billingEmail: string | null;
  readonly now: Date;
}

/** What `upsertFromSync` did. */
export interface BillingCustomerSync {
  /** The Customer stored before; `null` when the OTA had none. */
  readonly previousCustomerId: string | null;
  /** False when the stored row was the same already. */
  readonly changed: boolean;
}
