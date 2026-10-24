// The `billing_customers` repository (PBE-044; platform/docs/architecture.md §2.1: BillingModule owns the table,
// PADR-0002 item 1): one Stripe Customer per OTA, created on its first Checkout and reused for every later Checkout and
// Customer Portal session, also after a cancellation. Billing sync (PBE-045) upserts the row and copies the billing
// e-mail back. Kysely on the API's `PLATFORM_DB` (ADR-0005).
//
// `customerContext` reads what a new Customer is made of: the OTA's legal name, else its name, and the e-mail address
// of the owner who starts the Checkout. It reads `tenants` and `accounts` (the tables of TenantsModule and AuthModule,
// same layer) without writing them, as the other billing reads join `tenants`.
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
}
