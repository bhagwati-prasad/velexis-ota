// Builders for rows of the `platform` schema (PBE-003), for every platform backend test that arranges data in
// PostgreSQL (docs/mvp/conventions.md §10: builders, not shared fixtures that tests mutate).
//
// - `build<Row>(overrides)` (defineBuilder of @velexis/testing) returns a valid row of migration 0002 for the next
//   sequence number: ids are prefixed ULIDs (`acc_`, `ten_`, …, the shape the platform OpenAPI document requires),
//   e-mails, keys, codes and office ids are unique within a test file. Rows that need a parent (a tenant, a shared
//   Amadeus account, a settlement) are built without its id: the insert helper takes the parent.
// - `insert<Row>(db, [parent,] overrides)` builds a row and writes it with one plain SQL INSERT … RETURNING * on `db`,
//   a pool or a client of the role the test acts as. That is `velexis_platform_app` (ADR-0004): the platform backend
//   owns these tables, and its role is the only app role that may write them. It returns the row as PostgreSQL stored
//   it, read through the Velexis type parsers (numeric as a decimal string, timestamptz as a Date, jsonb parsed).
// - `insertRow(db, table, row)` writes any row of any platform table the same way. Table and column names are checked
//   and quoted (`platformTable(table)` gives `platform."<table>"` for a test's own SQL); values are bind parameters.
//
//   const tenant = await insertTenant(platformApp, { status: "suspended", suspension_reason: "billing" });
//   await insertSubscription(platformApp, tenant, { status: "past_due" });
//   const account = await insertAmadeusAccount(platformApp);              // one per environment (UNIQUE)
//   await insertSupplierConnection(platformApp, tenant, velexisSource(account));
//
// Money is a decimal string, never a JS number (conventions §1). Ciphertext columns get PLACEHOLDER_CIPHERTEXT, bytes
// that are not an envelope of @velexis/crypto: a test that decrypts writes a real `encryptValue` result instead. No
// value here is a secret.
import type { Insertable, PlatformDatabase, Selectable } from "@velexis/db";
import { defineBuilder, type Builder, type BuilderOverrides } from "@velexis/testing";

type Unqualified<K> = K extends `platform.${infer T}` ? T : never;

/** A table of the `platform` schema, unqualified: `"tenants"`, `"amadeus_offices"`, … */
export type PlatformTable = Unqualified<keyof PlatformDatabase>;

type TableTypes<T extends PlatformTable> = PlatformDatabase[`platform.${T}` & keyof PlatformDatabase];

/** What an INSERT into `platform.<T>` takes (the generated table types of `pnpm db:codegen`). */
export type PlatformInsert<T extends PlatformTable> = Insertable<TableTypes<T>>;

/** A row of `platform.<T>` as a Velexis pool reads it. */
export type PlatformRow<T extends PlatformTable> = Selectable<TableTypes<T>>;

/** A `pg` pool or client of the role the test acts as (`createPool(db.urlFor("platform"), …)`, `pool.connect()`). */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * The jsonb columns of the platform schema. `pg` sends a JavaScript array as a PostgreSQL array literal and an object
 * as JSON only by accident, so `insertRow` sends these with `JSON.stringify`; text[] columns (`office_ids`, `scopes`,
 * …) keep their arrays. constraints-0002.int.test.ts compares this list with the catalog.
 */
export const JSONB_COLUMNS: {
  readonly [T in PlatformTable]?: readonly (keyof PlatformInsert<T> & string)[];
} = {
  credential_submissions: ["public_data"],
  email_outbox: ["data"],
  invoices: ["line_items"],
  payment_provider_connections: ["capabilities"],
  plans: ["limits", "features"],
  platform_audit_log: ["details"],
  provisioning_jobs: ["payload", "result", "steps"],
  supplier_connections: ["ticketing_defaults", "monitored_queues"],
  tenants: ["metadata"],
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`${JSON.stringify(name)} is not a plain lower-case SQL identifier`);
  }
  return `"${name}"`;
}

/**
 * The quoted, schema-qualified name of a platform table for SQL text (`platform."tenants"`). The name is checked
 * first, so a test never builds SQL from an unchecked identifier; values still go in as bind parameters.
 */
export function platformTable(table: PlatformTable): string {
  return `platform.${quoteIdentifier(table)}`;
}

/**
 * Writes `row` into `platform.<table>` with one INSERT … RETURNING * on `db` and returns the stored row. Properties that
 * are `undefined` are left out, so the column default applies; `null` is SQL NULL, also in jsonb columns. Identifiers
 * are checked, and every value is a bind parameter.
 */
export async function insertRow<T extends PlatformTable>(
  db: Queryable,
  table: T,
  row: PlatformInsert<T>,
): Promise<PlatformRow<T>> {
  const values = row as Record<string, unknown>;
  const columns = Object.keys(values).filter((column) => values[column] !== undefined);
  const jsonb: readonly string[] = JSONB_COLUMNS[table] ?? [];
  const parameters = columns.map((column) => {
    const value = values[column];
    return jsonb.includes(column) && value !== null ? JSON.stringify(value) : value;
  });
  const text =
    columns.length === 0
      ? `INSERT INTO ${platformTable(table)} DEFAULT VALUES RETURNING *`
      : `INSERT INTO ${platformTable(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
        `VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING *`;
  const { rows } = await db.query(text, parameters);
  if (rows.length !== 1) {
    throw new Error(`insertRow: INSERT INTO platform.${table} returned ${rows.length} rows`);
  }
  return rows[0] as PlatformRow<T>;
}

// ---- Values ----------------------------------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The time part of every test id: a fixed, valid ULID timestamp, so ids sort by sequence. */
const ID_TIME = "01JATESTRW";

/**
 * A prefixed ULID for sequence number `n`: `<prefix>_` + 26 Crockford base-32 characters, as the platform's ids and
 * the `^ten_[0-9A-HJKMNP-TV-Z]{26}$` patterns of the OpenAPI document have them. Deterministic, so a failing test
 * shows the same ids on every run.
 */
export function testId(prefix: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError("testId: n must be an integer, 0 or more");
  }
  let random = "";
  for (let rest = n; rest > 0; rest = Math.floor(rest / 32)) {
    random = `${CROCKFORD[rest % 32] ?? ""}${random}`;
  }
  return `${prefix}_${ID_TIME}${random.padStart(16, "0")}`;
}

/** Bytes for a NOT NULL ciphertext column: not an envelope of @velexis/crypto, and no secret. */
export const PLACEHOLDER_CIPHERTEXT = "placeholder, not an envelope";
const placeholderCiphertext = (): Buffer => Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8");

/** The KEK id the placeholder ciphertext claims (`LocalFileKeyProvider` ids are `local:v<N>`). */
export const PLACEHOLDER_KEK_ID = "local:v1";

/** The plan migration 0002 seeds: every tenant can use it before paid plans exist (ADR-0013 point 4). */
export const SEEDED_PLAN_CODE = "early_access";

/** The loopback Amadeus stub of development and tests (`pnpm stub:amadeus`). */
export const AMADEUS_STUB_URL = "http://127.0.0.1:4900";

/** 00:00 UTC on the first day of month `month` (0-based, may overflow into later years) of 2026. */
const monthStart = (month: number): Date => new Date(Date.UTC(2026, month, 1));
const at = (iso: string): Date => new Date(iso);

// ---- Builders and inserts ----------------------------------------------------------------------------------------

/** `platform.accounts`: an active portal account with a verified e-mail and no password (set `password_hash`). */
export type AccountRow = PlatformInsert<"accounts">;
export const buildAccount: Builder<AccountRow> = defineBuilder<AccountRow>((n) => ({
  id: testId("acc", n),
  email: `person${n}@example.com`,
  full_name: `Person ${n}`,
  status: "active",
  email_verified_at: at("2026-10-01T09:00:00.000Z"),
}));
export function insertAccount(
  db: Queryable,
  overrides?: BuilderOverrides<AccountRow>,
): Promise<PlatformRow<"accounts">> {
  return insertRow(db, "accounts", buildAccount(overrides));
}

/** `platform.plans`: a public monthly and annual plan, without Stripe prices (set `stripe_price_id_*`). */
export type PlanRow = PlatformInsert<"plans">;
export const buildPlan: Builder<PlanRow> = defineBuilder<PlanRow>((n) => ({
  code: `plan_${n}`,
  name: `Plan ${n}`,
  currency: "EUR",
  monthly_price: "49.00",
  annual_price: "490.00",
  limits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: true },
  features: {},
  sort_order: n,
}));
export function insertPlan(
  db: Queryable,
  overrides?: BuilderOverrides<PlanRow>,
): Promise<PlatformRow<"plans">> {
  return insertRow(db, "plans", buildPlan(overrides));
}

/** `platform.tenants`: an active OTA on the seeded `early_access` plan, key `agency<n>`. */
export type TenantRow = PlatformInsert<"tenants">;
export const buildTenant: Builder<TenantRow> = defineBuilder<TenantRow>((n) => ({
  id: testId("ten", n),
  key: `agency${n}`,
  name: `Agency ${n} Travel`,
  plan_code: SEEDED_PLAN_CODE,
  status: "active",
  activated_at: at("2026-10-01T09:05:00.000Z"),
}));
export function insertTenant(
  db: Queryable,
  overrides?: BuilderOverrides<TenantRow>,
): Promise<PlatformRow<"tenants">> {
  return insertRow(db, "tenants", buildTenant(overrides));
}

type TenantRef = Pick<PlatformRow<"tenants">, "id">;

/** `platform.subscriptions`: a manual trial on `early_access`; the insert takes the tenant. */
export type SubscriptionRow = Omit<PlatformInsert<"subscriptions">, "tenant_id">;
export const buildSubscription: Builder<SubscriptionRow> = defineBuilder<SubscriptionRow>((n) => ({
  id: testId("sub", n),
  plan_code: SEEDED_PLAN_CODE,
  status: "trialing",
  billing_provider: "manual",
  billing_interval: "month",
  trial_ends_at: at("2026-12-30T00:00:00.000Z"),
}));
export function insertSubscription(
  db: Queryable,
  tenant: TenantRef,
  overrides?: BuilderOverrides<SubscriptionRow>,
): Promise<PlatformRow<"subscriptions">> {
  return insertRow(db, "subscriptions", { ...buildSubscription(overrides), tenant_id: tenant.id });
}

/**
 * `platform.amadeus_accounts`: the Velexis shared account of the `test` environment on the loopback stub. There is at
 * most one account per environment (`amadeus_accounts_environment_uq`): build the `live` one with
 * `{ environment: "live", base_url: "https://…" }`.
 */
export type AmadeusAccountRow = PlatformInsert<"amadeus_accounts">;
export const buildAmadeusAccount: Builder<AmadeusAccountRow> = defineBuilder<AmadeusAccountRow>((n) => ({
  id: testId("ama", n),
  name: `Velexis shared account ${n}`,
  environment: "test",
  base_url: AMADEUS_STUB_URL,
  client_id: `velexis-client-${n}`,
  client_secret_ciphertext: placeholderCiphertext(),
  encryption_key_id: PLACEHOLDER_KEK_ID,
  status: "active",
}));
export function insertAmadeusAccount(
  db: Queryable,
  overrides?: BuilderOverrides<AmadeusAccountRow>,
): Promise<PlatformRow<"amadeus_accounts">> {
  return insertRow(db, "amadeus_accounts", buildAmadeusAccount(overrides));
}

type AmadeusAccountRef = Pick<PlatformRow<"amadeus_accounts">, "id">;

/**
 * `platform.amadeus_offices`: an `available` office `NCE1A<nnnn>` of the pool (n up to 9999); the insert takes the
 * shared account. Assign it with `{ status: "assigned", assigned_tenant_id, assigned_at }`.
 */
export type AmadeusOfficeRow = Omit<PlatformInsert<"amadeus_offices">, "amadeus_account_id">;
export const buildAmadeusOffice: Builder<AmadeusOfficeRow> = defineBuilder<AmadeusOfficeRow>((n) => ({
  id: testId("amo", n),
  office_id: `NCE1A${String(n).padStart(4, "0")}`,
  status: "available",
}));
export function insertAmadeusOffice(
  db: Queryable,
  account: AmadeusAccountRef,
  overrides?: BuilderOverrides<AmadeusOfficeRow>,
): Promise<PlatformRow<"amadeus_offices">> {
  return insertRow(db, "amadeus_offices", {
    ...buildAmadeusOffice(overrides),
    amadeus_account_id: account.id,
  });
}

/**
 * `platform.supplier_connections`: a `test` connection with the OTA's own credentials (`credential_source = 'tenant'`),
 * which needs no other row; the insert takes the tenant. `velexisSource(account)` gives the overrides of a connection
 * through the Velexis shared account.
 */
export type SupplierConnectionRow = Omit<PlatformInsert<"supplier_connections">, "tenant_id">;
export const buildSupplierConnection: Builder<SupplierConnectionRow> = defineBuilder<SupplierConnectionRow>(
  (n) => ({
    id: testId("sc", n),
    provider: "amadeus",
    environment: "test",
    credential_source: "tenant",
    base_url: "https://test.travel.api.amadeus.com",
    client_id: `ota-client-${n}`,
    client_secret_ciphertext: placeholderCiphertext(),
    encryption_key_id: PLACEHOLDER_KEK_ID,
    office_ids: [`NCE1B${String(n).padStart(4, "0")}`],
    default_office_id: `NCE1B${String(n).padStart(4, "0")}`,
  }),
);
export function insertSupplierConnection(
  db: Queryable,
  tenant: TenantRef,
  overrides?: BuilderOverrides<SupplierConnectionRow>,
): Promise<PlatformRow<"supplier_connections">> {
  return insertRow(db, "supplier_connections", {
    ...buildSupplierConnection(overrides),
    tenant_id: tenant.id,
  });
}

/**
 * The overrides of a supplier connection through the Velexis shared `account` (ADR-0012): its environment, and no
 * credentials of its own (`supplier_connections_source_ck`). The offices come from `amadeus_offices`.
 */
export function velexisSource(
  account: Pick<PlatformRow<"amadeus_accounts">, "id" | "environment">,
): Partial<SupplierConnectionRow> {
  return {
    credential_source: "velexis",
    amadeus_account_id: account.id,
    environment: account.environment,
    base_url: null,
    client_id: null,
    client_secret_ciphertext: null,
    encryption_key_id: null,
    office_ids: [],
    default_office_id: null,
  };
}

/**
 * `platform.payment_provider_connections`: the default `velexis` mode (payments on the Velexis Stripe account, no
 * account reference and no secrets of the OTA), active, `test`; the insert takes the tenant.
 */
export type PaymentConnectionRow = Omit<PlatformInsert<"payment_provider_connections">, "tenant_id">;
export const buildPaymentConnection: Builder<PaymentConnectionRow> = defineBuilder<PaymentConnectionRow>(
  (n) => ({
    id: testId("ppc", n),
    provider: "stripe",
    environment: "test",
    account_mode: "velexis",
    status: "active",
    statement_descriptor_suffix: `AGENCY ${n}`,
  }),
);
export function insertPaymentConnection(
  db: Queryable,
  tenant: TenantRef,
  overrides?: BuilderOverrides<PaymentConnectionRow>,
): Promise<PlatformRow<"payment_provider_connections">> {
  return insertRow(db, "payment_provider_connections", {
    ...buildPaymentConnection(overrides),
    tenant_id: tenant.id,
  });
}

/**
 * `platform.settlements`: an empty `draft` statement in EUR for month n of 2026 (n = 1 is January), every amount
 * "0.00". `settlements_net_ck` requires net = gross - refunds - disputes - stripe fees - Velexis fees + adjustments:
 * set the amounts together. The insert takes the tenant.
 */
export type SettlementRow = Omit<PlatformInsert<"settlements">, "tenant_id">;
export const buildSettlement: Builder<SettlementRow> = defineBuilder<SettlementRow>((n) => ({
  id: testId("stl", n),
  environment: "live",
  currency: "EUR",
  period_start: monthStart(n - 1),
  period_end: monthStart(n),
  status: "draft",
  gross_amount: "0.00",
  refunds_amount: "0.00",
  disputes_amount: "0.00",
  stripe_fees_amount: "0.00",
  velexis_fees_amount: "0.00",
  adjustments_amount: "0.00",
  net_amount: "0.00",
}));
export function insertSettlement(
  db: Queryable,
  tenant: TenantRef,
  overrides?: BuilderOverrides<SettlementRow>,
): Promise<PlatformRow<"settlements">> {
  return insertRow(db, "settlements", { ...buildSettlement(overrides), tenant_id: tenant.id });
}

/**
 * `platform.settlement_lines`: a captured `charge` of 100.00 with its Stripe balance transaction `txn_…` (unique: a
 * transaction is settled once); the insert takes the settlement and repeats its tenant.
 */
export type SettlementLineRow = Omit<PlatformInsert<"settlement_lines">, "settlement_id" | "tenant_id">;
export const buildSettlementLine: Builder<SettlementLineRow> = defineBuilder<SettlementLineRow>((n) => ({
  id: testId("sln", n),
  line_type: "charge",
  balance_transaction_id: `txn_1TEST${String(n).padStart(10, "0")}`,
  payment_intent_id: `pi_1TEST${String(n).padStart(10, "0")}`,
  occurred_at: at("2026-01-15T12:00:00.000Z"),
  amount: "100.00",
  stripe_fee: "1.65",
  description: `Charge ${n}`,
}));
export function insertSettlementLine(
  db: Queryable,
  settlement: Pick<PlatformRow<"settlements">, "id" | "tenant_id">,
  overrides?: BuilderOverrides<SettlementLineRow>,
): Promise<PlatformRow<"settlement_lines">> {
  return insertRow(db, "settlement_lines", {
    ...buildSettlementLine(overrides),
    settlement_id: settlement.id,
    tenant_id: settlement.tenant_id,
  });
}

/**
 * `platform.tenant_domains`: a verified storefront sub-domain `site<n>.ota.example.com`; the insert takes the tenant.
 * A custom domain needs `{ kind: "custom", verification_token }` (`tenant_domains_custom_token_ck`).
 */
export type TenantDomainRow = Omit<PlatformInsert<"tenant_domains">, "tenant_id">;
export const buildTenantDomain: Builder<TenantDomainRow> = defineBuilder<TenantDomainRow>((n) => ({
  id: testId("dom", n),
  hostname: `site${n}.ota.example.com`,
  kind: "subdomain",
  purpose: "storefront",
  verification_status: "verified",
  verified_at: at("2026-10-01T09:05:00.000Z"),
}));
export function insertTenantDomain(
  db: Queryable,
  tenant: TenantRef,
  overrides?: BuilderOverrides<TenantDomainRow>,
): Promise<PlatformRow<"tenant_domains">> {
  return insertRow(db, "tenant_domains", { ...buildTenantDomain(overrides), tenant_id: tenant.id });
}

/**
 * `platform.email_outbox`: a `pending` verification e-mail with no secret payload. A row with
 * `secret_payload_ciphertext` also needs `encryption_key_id`, and loses both before a final status
 * (`email_outbox_secret_purge_ck`).
 */
export type EmailOutboxRow = PlatformInsert<"email_outbox">;
export const buildEmailOutbox: Builder<EmailOutboxRow> = defineBuilder<EmailOutboxRow>((n) => ({
  id: testId("eml", n),
  template: "auth.verify_email",
  to_email: `recipient${n}@example.com`,
  locale: "en",
  data: { fullName: `Person ${n}` },
  status: "pending",
}));
export function insertEmailOutbox(
  db: Queryable,
  overrides?: BuilderOverrides<EmailOutboxRow>,
): Promise<PlatformRow<"email_outbox">> {
  return insertRow(db, "email_outbox", buildEmailOutbox(overrides));
}
