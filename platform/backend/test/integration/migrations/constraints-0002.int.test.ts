// The constraints of migration 0002 on PostgreSQL 16 (PBE-003; platform/docs/data-model.md §4 and §6,
// platform/docs/data-model-migration-0002.md "How to use it"). One `it` per rule of the plan: each writes rows as
// velexis_platform_app, the role that owns these tables' data (ADR-0004), with the builders of
// test/builders/platform-rows.ts, and asserts the SQLSTATE, the table and the NAME of the violated constraint, so a
// test cannot pass because some other constraint (or a missing privilege) rejected the row. Each rule also shows the
// valid rows next to the rejected one, so a constraint that rejects too much fails too.
//
// The file clones the template database of @velexis/testing once (migrations 0001, 0002 and R__ota_read_access,
// applied by the real runner). Every test runs in its own transaction, which is rolled back at the end, so the tests
// share no rows and run in any order; an expected violation is wrapped in a savepoint, so the test continues after it.
import { createPool } from "@velexis/db";
import { createTestDatabase, type TestDatabase } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTenant,
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertEmailOutbox,
  insertPaymentConnection,
  insertPlan,
  insertRow,
  insertSettlement,
  insertSettlementLine,
  insertSubscription,
  insertSupplierConnection,
  insertTenant,
  insertTenantDomain,
  JSONB_COLUMNS,
  PLACEHOLDER_KEK_ID,
  SEEDED_PLAN_CODE,
  velexisSource,
  type PlatformInsert,
  type PlatformRow,
  type Queryable,
} from "../../builders/platform-rows";

type Pool = ReturnType<typeof createPool>;

/** PostgreSQL error codes (SQLSTATE, class 23: integrity constraint violation). */
const SQLSTATE = { check: "23514", unique: "23505", foreignKey: "23503" } as const;

interface Violation {
  readonly kind: keyof typeof SQLSTATE;
  readonly table: string;
  readonly constraint: string;
}

const check = (table: string, constraint: string): Violation => ({ kind: "check", table, constraint });
const unique = (table: string, constraint: string): Violation => ({ kind: "unique", table, constraint });
const foreignKey = (table: string, constraint: string): Violation => ({
  kind: "foreignKey",
  table,
  constraint,
});

/** The ULID ids of the platform OpenAPI document (`^ten_[0-9A-HJKMNP-TV-Z]{26}$`). */
const ulidId = (prefix: string): RegExp => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);

let db: TestDatabase;
let platformApp: Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  platformApp = createPool(db.urlFor("platform"), {
    applicationName: "platform-int-constraints-0002",
    logger: { error: () => undefined },
    max: 2,
  });
});

afterAll(async () => {
  await platformApp?.end();
  await db?.drop();
});

/** Runs `fn` in a transaction of velexis_platform_app that is always rolled back. */
async function rolledBack(fn: (tx: Queryable) => Promise<void>): Promise<void> {
  const client = await platformApp.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}

/**
 * Asserts that `attempt` fails with `violation`: the SQLSTATE, the schema and table, and the constraint name, which
 * PostgreSQL also quotes in the message. A savepoint keeps the transaction usable for the rest of the test.
 */
async function expectViolation(
  tx: Queryable,
  attempt: () => Promise<unknown>,
  violation: Violation,
): Promise<void> {
  await tx.query("SAVEPOINT expected_violation");
  await expect(attempt()).rejects.toMatchObject({
    code: SQLSTATE[violation.kind],
    schema: "platform",
    table: violation.table,
    constraint: violation.constraint,
    message: expect.stringContaining(`"${violation.constraint}"`),
  });
  await tx.query("ROLLBACK TO SAVEPOINT expected_violation");
}

const assignedTo = (tenant: Pick<PlatformRow<"tenants">, "id">) => ({
  status: "assigned",
  assigned_tenant_id: tenant.id,
  assigned_at: new Date("2026-10-02T08:00:00.000Z"),
});

describe("test/builders/platform-rows.ts", () => {
  it("writes the default row of every builder as velexis_platform_app", () =>
    rolledBack(async (tx) => {
      const account = await insertAccount(tx);
      const plan = await insertPlan(tx);
      const tenant = await insertTenant(tx, { created_by_account_id: account.id, plan_code: plan.code });
      const other = await insertTenant(tx);
      const subscription = await insertSubscription(tx, tenant, { plan_code: plan.code });
      const amadeus = await insertAmadeusAccount(tx);
      const office = await insertAmadeusOffice(tx, amadeus, assignedTo(other));
      const ownCredentials = await insertSupplierConnection(tx, tenant);
      const shared = await insertSupplierConnection(tx, other, velexisSource(amadeus));
      const payment = await insertPaymentConnection(tx, tenant);
      const settlement = await insertSettlement(tx, tenant);
      const line = await insertSettlementLine(tx, settlement);
      const domain = await insertTenantDomain(tx, tenant);
      const email = await insertEmailOutbox(tx, { account_id: account.id, tenant_id: tenant.id });

      expect(account).toMatchObject({ id: expect.stringMatching(ulidId("acc")), status: "active" });
      expect(plan).toMatchObject({
        code: expect.stringMatching(/^plan_[0-9]+$/),
        monthly_price: "49.00",
        limits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: true },
        trial_days: 14,
      });
      expect(tenant).toMatchObject({
        id: expect.stringMatching(ulidId("ten")),
        key: expect.stringMatching(/^agency[0-9]+$/),
        schema_name: `tenant_${tenant.key}`,
        storefront_environment: "test",
        metadata: {},
      });
      expect(subscription).toMatchObject({ id: expect.stringMatching(ulidId("sub")), tenant_id: tenant.id });
      expect(office).toMatchObject({
        id: expect.stringMatching(ulidId("amo")),
        office_id: expect.stringMatching(/^NCE1A[0-9]{4}$/),
      });
      expect(ownCredentials).toMatchObject({ credential_source: "tenant", amadeus_account_id: null });
      expect(shared).toMatchObject({ credential_source: "velexis", amadeus_account_id: amadeus.id });
      expect(payment).toMatchObject({
        account_mode: "velexis",
        capabilities: {},
        supported_methods: ["card"],
      });
      expect(settlement).toMatchObject({
        net_amount: "0.00",
        period_start: new Date("2026-01-01T00:00:00Z"),
      });
      expect(line).toMatchObject({ tenant_id: tenant.id, amount: "100.00", stripe_fee: "1.65" });
      expect(domain).toMatchObject({ kind: "subdomain", verification_token: null });
      expect(email).toMatchObject({
        data: { fullName: expect.stringMatching(/^Person [0-9]+$/) },
        secret_payload_ciphertext: null,
      });
      for (const [row, prefix] of [
        [amadeus, "ama"],
        [ownCredentials, "sc"],
        [payment, "ppc"],
        [settlement, "stl"],
        [line, "sln"],
        [domain, "dom"],
        [email, "eml"],
      ] as const) {
        expect(row.id).toMatch(ulidId(prefix));
      }
    }));

  it("sends jsonb values as JSON, arrays included, and keeps text[] values as arrays", () =>
    rolledBack(async (tx) => {
      const tenant = await insertTenant(tx);
      const monitoredQueues = [{ officeId: "NCE1B0001", queueId: "50", category: "0" }];
      const connection = await insertSupplierConnection(tx, tenant, {
        monitored_queues: monitoredQueues,
        office_ids: ["NCE1B0001", "NCE1B0002"],
      });
      expect(connection.monitored_queues).toEqual(monitoredQueues);
      expect(connection.office_ids).toEqual(["NCE1B0001", "NCE1B0002"]);
      const { rows } = await tx.query(
        "SELECT jsonb_typeof(monitored_queues) AS queues, pg_typeof(office_ids)::text AS offices " +
          "FROM platform.supplier_connections WHERE id = $1",
        [connection.id],
      );
      expect(rows).toEqual([{ queues: "array", offices: "text[]" }]);
    }));

  it("lists every jsonb column of the platform schema in JSONB_COLUMNS", async () => {
    const { rows } = await platformApp.query<{ table: string; column: string }>(
      "SELECT c.relname AS table, a.attname AS column FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
        "WHERE c.relnamespace = 'platform'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 " +
        "AND NOT a.attisdropped AND a.atttypid = 'jsonb'::regtype",
    );
    // Both sides sorted the same way here, so neither the database collation nor ICU decides the order.
    const catalog = rows.map(({ table, column }) => `${table}.${column}`).sort();
    const listed = Object.entries(JSONB_COLUMNS)
      .flatMap(([table, columns]) => (columns ?? []).map((column) => `${table}.${column}`))
      .sort();
    expect(listed).toEqual(catalog);
  });

  it("refuses a table or column name that is not a plain identifier, before sending any SQL", async () => {
    const sent: string[] = [];
    const recorder: Queryable = {
      query: (text) => {
        sent.push(text);
        return Promise.resolve({ rows: [] });
      },
    };
    // Rows and table names that the types forbid, as untyped input would bring them.
    const badColumn = { ...buildTenant(), 'key") VALUES (1); --': "x" } as PlatformInsert<"tenants">;
    await expect(insertRow(recorder, "tenants", badColumn)).rejects.toThrow(
      "is not a plain lower-case SQL identifier",
    );
    await expect(insertRow(recorder, "Tenants" as "tenants", buildTenant())).rejects.toThrow(
      '"Tenants" is not a plain lower-case SQL identifier',
    );
    expect(sent).toEqual([]);
  });
});

describe("migration 0002 constraints, as velexis_platform_app", () => {
  it("rejects a tenant key with an underscore with tenants_key_dns_ck [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      // The baseline CHECK (tenants_key_check) allows "_" and 40 characters; a DNS label of <key>.ota.example.com
      // allows neither, so only tenants_key_dns_ck can reject these keys.
      await expectViolation(
        tx,
        () => insertTenant(tx, { key: "acme_travel" }),
        check("tenants", "tenants_key_dns_ck"),
      );
      await expectViolation(
        tx,
        () => insertTenant(tx, { key: `a${"b".repeat(30)}` }),
        check("tenants", "tenants_key_dns_ck"),
      );
      await expect(insertTenant(tx, { key: "acmetravel" })).resolves.toMatchObject({
        schema_name: "tenant_acmetravel",
      });
      await expect(insertTenant(tx, { key: `a${"b".repeat(29)}` })).resolves.toBeDefined();
    }));

  it("rejects an unknown suspension reason with tenants_suspension_reason_ck [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const suspended = { status: "suspended", suspended_at: new Date("2026-10-03T10:00:00.000Z") };
      for (const reason of ["vacation", "Billing", ""]) {
        await expectViolation(
          tx,
          () => insertTenant(tx, { ...suspended, suspension_reason: reason }),
          check("tenants", "tenants_suspension_reason_ck"),
        );
      }
      // PADR-0014: the four reasons, and none while the tenant is not suspended.
      for (const reason of ["billing", "abuse", "request", "admin"]) {
        await expect(insertTenant(tx, { ...suspended, suspension_reason: reason })).resolves.toMatchObject({
          suspension_reason: reason,
        });
      }
      await expect(insertTenant(tx, { suspension_reason: null })).resolves.toBeDefined();
    }));

  it("rejects a live supplier connection on the test Amadeus account with supplier_connections_account_fk [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const testAccount = await insertAmadeusAccount(tx, { environment: "test" });
      const tenant = await insertTenant(tx);
      // The composite foreign key (amadeus_account_id, environment) -> amadeus_accounts (id, environment).
      await expectViolation(
        tx,
        () => insertSupplierConnection(tx, tenant, { ...velexisSource(testAccount), environment: "live" }),
        foreignKey("supplier_connections", "supplier_connections_account_fk"),
      );
      const testConnection = await insertSupplierConnection(tx, tenant, velexisSource(testAccount));
      await expectViolation(
        tx,
        () =>
          tx.query("UPDATE platform.supplier_connections SET environment = 'live' WHERE id = $1", [
            testConnection.id,
          ]),
        foreignKey("supplier_connections", "supplier_connections_account_fk"),
      );
      // The live connection goes through the live account.
      const liveAccount = await insertAmadeusAccount(tx, {
        environment: "live",
        base_url: "https://travel.api.amadeus.com",
      });
      await expect(insertSupplierConnection(tx, tenant, velexisSource(liveAccount))).resolves.toMatchObject({
        environment: "live",
        amadeus_account_id: liveAccount.id,
      });
    }));

  it("rejects credential_source velexis without amadeus_account_id with supplier_connections_source_ck [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const account = await insertAmadeusAccount(tx);
      const tenant = await insertTenant(tx);
      await expectViolation(
        tx,
        () => insertSupplierConnection(tx, tenant, { ...velexisSource(account), amadeus_account_id: null }),
        check("supplier_connections", "supplier_connections_source_ck"),
      );
      // A Velexis connection carries no credentials of its own, and an own-credentials one no shared account.
      await expectViolation(
        tx,
        () => insertSupplierConnection(tx, tenant, { ...velexisSource(account), client_id: "ota-client" }),
        check("supplier_connections", "supplier_connections_source_ck"),
      );
      await expectViolation(
        tx,
        () => insertSupplierConnection(tx, tenant, { amadeus_account_id: account.id }),
        check("supplier_connections", "supplier_connections_source_ck"),
      );
      await expect(insertSupplierConnection(tx, tenant, velexisSource(account))).resolves.toMatchObject({
        credential_source: "velexis",
        base_url: null,
        client_secret_ciphertext: null,
      });
    }));

  it("rejects a second assigned office for one tenant and account with amadeus_offices_one_assigned_uq [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const account = await insertAmadeusAccount(tx);
      const alpha = await insertTenant(tx);
      const beta = await insertTenant(tx);
      await insertAmadeusOffice(tx, account, assignedTo(alpha));
      await expectViolation(
        tx,
        () => insertAmadeusOffice(tx, account, assignedTo(alpha)),
        unique("amadeus_offices", "amadeus_offices_one_assigned_uq"),
      );
      const available = await insertAmadeusOffice(tx, account);
      await expectViolation(
        tx,
        () =>
          tx.query(
            "UPDATE platform.amadeus_offices SET status = 'assigned', assigned_tenant_id = $1 WHERE id = $2",
            [alpha.id, available.id],
          ),
        unique("amadeus_offices", "amadeus_offices_one_assigned_uq"),
      );
      // Still allowed: an office of the same tenant that is releasing, and another tenant's assigned office.
      await expect(
        insertAmadeusOffice(tx, account, { ...assignedTo(alpha), status: "releasing" }),
      ).resolves.toMatchObject({ status: "releasing", assigned_tenant_id: alpha.id });
      await expect(insertAmadeusOffice(tx, account, assignedTo(beta))).resolves.toMatchObject({
        status: "assigned",
        assigned_tenant_id: beta.id,
      });
    }));

  it("rejects a second current subscription, unpaid counting as current, with subscriptions_current_uq [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const stripe = { billing_provider: "stripe" };
      // Ended subscriptions do not count: canceled and incomplete_expired rows sit next to a current one.
      const tenant = await insertTenant(tx);
      await insertSubscription(tx, tenant, {
        ...stripe,
        status: "canceled",
        canceled_at: new Date("2026-09-30T12:00:00.000Z"),
      });
      await insertSubscription(tx, tenant, { ...stripe, status: "incomplete_expired" });
      await insertSubscription(tx, tenant, { ...stripe, status: "unpaid" });
      await expectViolation(
        tx,
        () => insertSubscription(tx, tenant, { ...stripe, status: "active" }),
        unique("subscriptions", "subscriptions_current_uq"),
      );
      // Every current status blocks a second current subscription.
      for (const status of ["trialing", "active", "past_due", "paused", "incomplete", "unpaid"]) {
        const other = await insertTenant(tx);
        await insertSubscription(tx, other, { ...stripe, status });
        await expectViolation(
          tx,
          () => insertSubscription(tx, other, { ...stripe, status: "trialing" }),
          unique("subscriptions", "subscriptions_current_uq"),
        );
      }
    }));

  it("drops subscriptions_status_check: incomplete_expired is accepted, subscriptions_status_ck rejects the rest [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const { rows } = await tx.query(
        "SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint " +
          "WHERE conrelid = 'platform.subscriptions'::regclass AND contype = 'c' AND conname LIKE 'subscriptions\\_status%' " +
          "ORDER BY conname",
      );
      expect(rows).toEqual([
        { name: "subscriptions_status_ck", definition: expect.stringContaining("'incomplete_expired'") },
      ]);
      const tenant = await insertTenant(tx);
      // Both statuses were refused by the baseline's inline CHECK.
      await expect(
        insertSubscription(tx, tenant, { billing_provider: "stripe", status: "incomplete_expired" }),
      ).resolves.toMatchObject({ status: "incomplete_expired" });
      await expect(
        insertSubscription(tx, tenant, { billing_provider: "stripe", status: "unpaid" }),
      ).resolves.toMatchObject({ status: "unpaid" });
      await expectViolation(
        tx,
        () => insertSubscription(tx, tenant, { billing_provider: "stripe", status: "expired" }),
        check("subscriptions", "subscriptions_status_ck"),
      );
    }));

  it("rejects a settlement whose net does not equal its parts with settlements_net_ck [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const tenant = await insertTenant(tx);
      // net = gross - refunds - disputes - Stripe fees - Velexis fees + adjustments = 921.50
      const amounts = {
        gross_amount: "1000.00",
        refunds_amount: "50.00",
        disputes_amount: "0.00",
        stripe_fees_amount: "29.00",
        velexis_fees_amount: "9.50",
        adjustments_amount: "10.00",
      };
      await expectViolation(
        tx,
        () => insertSettlement(tx, tenant, { ...amounts, net_amount: "1000.00" }),
        check("settlements", "settlements_net_ck"),
      );
      await expectViolation(
        tx,
        () => insertSettlement(tx, tenant, { ...amounts, net_amount: "921.49" }),
        check("settlements", "settlements_net_ck"),
      );
      const settlement = await insertSettlement(tx, tenant, { ...amounts, net_amount: "921.50" });
      expect(settlement.net_amount).toBe("921.50");
      await expectViolation(
        tx,
        () =>
          tx.query("UPDATE platform.settlements SET gross_amount = '1100.00' WHERE id = $1", [settlement.id]),
        check("settlements", "settlements_net_ck"),
      );
    }));

  it("rejects a duplicate balance_transaction_id with settlement_lines_balance_transaction_id_key [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const tenant = await insertTenant(tx);
      const january = await insertSettlement(tx, tenant);
      const february = await insertSettlement(tx, tenant);
      const charge = await insertSettlementLine(tx, january);
      // A Stripe balance transaction is settled at most once, in any statement (PADR-0003).
      await expectViolation(
        tx,
        () => insertSettlementLine(tx, february, { balance_transaction_id: charge.balance_transaction_id }),
        unique("settlement_lines", "settlement_lines_balance_transaction_id_key"),
      );
      await expectViolation(
        tx,
        () => insertSettlementLine(tx, january, { balance_transaction_id: charge.balance_transaction_id }),
        unique("settlement_lines", "settlement_lines_balance_transaction_id_key"),
      );
      // Manual lines have no balance transaction, and any number of them may exist.
      const adjustment = {
        line_type: "adjustment",
        balance_transaction_id: null,
        amount: "-5.00",
        stripe_fee: "0.00",
      };
      await insertSettlementLine(tx, january, adjustment);
      await expect(insertSettlementLine(tx, february, adjustment)).resolves.toMatchObject({
        balance_transaction_id: null,
      });
    }));

  it("rejects a sent e-mail that still holds secret_payload_ciphertext with email_outbox_secret_purge_ck [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const secret = {
        secret_payload_ciphertext: Buffer.from("placeholder, not an envelope"),
        encryption_key_id: PLACEHOLDER_KEK_ID,
      };
      await expectViolation(
        tx,
        () =>
          insertEmailOutbox(tx, { ...secret, status: "sent", sent_at: new Date("2026-10-02T08:00:00.000Z") }),
        check("email_outbox", "email_outbox_secret_purge_ck"),
      );
      // The other final statuses too; pending and sending rows may hold the secret.
      for (const status of ["failed", "canceled"]) {
        await expectViolation(
          tx,
          () => insertEmailOutbox(tx, { ...secret, status }),
          check("email_outbox", "email_outbox_secret_purge_ck"),
        );
      }
      await insertEmailOutbox(tx, { ...secret, status: "sending" });
      const pending = await insertEmailOutbox(tx, { ...secret, status: "pending" });
      // The worker's update must erase the secret in the same statement that sets the final status.
      await expectViolation(
        tx,
        () =>
          tx.query("UPDATE platform.email_outbox SET status = 'sent', sent_at = now() WHERE id = $1", [
            pending.id,
          ]),
        check("email_outbox", "email_outbox_secret_purge_ck"),
      );
      const { rows } = await tx.query(
        "UPDATE platform.email_outbox SET status = 'sent', sent_at = now(), secret_payload_ciphertext = NULL, " +
          "secrets_purged_at = now() WHERE id = $1 RETURNING status, secret_payload_ciphertext",
        [pending.id],
      );
      expect(rows).toEqual([{ status: "sent", secret_payload_ciphertext: null }]);
    }));

  it("rejects a custom domain without verification_token with tenant_domains_custom_token_ck [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const tenant = await insertTenant(tx);
      const custom = {
        kind: "custom",
        hostname: "flights.acme-travel.example",
        verification_status: "pending",
        verified_at: null,
      };
      await expectViolation(
        tx,
        () => insertTenantDomain(tx, tenant, { ...custom, verification_token: null }),
        check("tenant_domains", "tenant_domains_custom_token_ck"),
      );
      await expect(
        insertTenantDomain(tx, tenant, { ...custom, verification_token: "velexis-verify-0001" }),
      ).resolves.toMatchObject({ kind: "custom", verification_token: "velexis-verify-0001" });
      // The provisioned sub-domain needs no DNS verification.
      await expect(insertTenantDomain(tx, tenant, { verification_token: null })).resolves.toMatchObject({
        kind: "subdomain",
      });
    }));

  it("rejects two connect_standard rows with the same account reference with payment_provider_connections_connect_uq [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const connect = { account_mode: "connect_standard", account_reference: "acct_1TestConnect01" };
      const alpha = await insertTenant(tx);
      const beta = await insertTenant(tx);
      await insertPaymentConnection(tx, alpha, connect);
      // Connect events are routed by event.account: one connected account belongs to one tenant.
      await expectViolation(
        tx,
        () => insertPaymentConnection(tx, beta, connect),
        unique("payment_provider_connections", "payment_provider_connections_connect_uq"),
      );
      // Velexis-mode rows have no account reference, so any number of tenants have one.
      await expect(insertPaymentConnection(tx, beta)).resolves.toMatchObject({
        account_mode: "velexis",
        account_reference: null,
      });
      await expect(
        insertPaymentConnection(tx, beta, {
          account_mode: "connect_standard",
          account_reference: "acct_1TestConnect02",
          environment: "live",
          is_default: true,
        }),
      ).resolves.toMatchObject({ account_reference: "acct_1TestConnect02" });
    }));

  it("seeds the early_access plan, which tenants reference before paid plans exist [PBE-003 AC1]", () =>
    rolledBack(async (tx) => {
      const { rows } = await tx.query(
        "SELECT code, name, currency, monthly_price, annual_price, per_booking_fee, included_bookings, limits, " +
          "features, is_public, is_active, sort_order, trial_days, settlement_fee_bps, stripe_product_id, " +
          "stripe_price_id_month, stripe_price_id_year FROM platform.plans WHERE code = $1",
        [SEEDED_PLAN_CODE],
      );
      expect(rows).toEqual([
        {
          code: "early_access",
          name: "Early access",
          currency: "EUR",
          monthly_price: "0.00",
          annual_price: null,
          per_booking_fee: "0.00",
          included_bookings: 0,
          limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: false },
          features: {},
          is_public: true,
          is_active: true,
          sort_order: 0,
          trial_days: 90,
          settlement_fee_bps: 0,
          stripe_product_id: null,
          stripe_price_id_month: null,
          stripe_price_id_year: null,
        },
      ]);
      await expect(insertTenant(tx, { plan_code: SEEDED_PLAN_CODE })).resolves.toMatchObject({
        plan_code: "early_access",
      });
      // The seed is the plan's natural key, and tenants.plan_code is a NOT NULL foreign key to it.
      await expectViolation(
        tx,
        () => insertPlan(tx, { code: SEEDED_PLAN_CODE }),
        unique("plans", "plans_pkey"),
      );
      await expectViolation(
        tx,
        () => insertTenant(tx, { plan_code: "no_such_plan" }),
        foreignKey("tenants", "tenants_plan_code_fkey"),
      );
    }));
});
