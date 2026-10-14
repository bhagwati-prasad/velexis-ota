// The privileges of migration 0002 on a fresh test database (PBE-003; ADR-0004 Database roles,
// platform/docs/data-model.md §4.7 and §4.8, platform/backend/migrations/platform/R__ota_read_access.sql):
//   - velexis_platform_app may insert into platform_audit_log, and may not update, delete or truncate it (the audit
//     trail is append-only by privilege, PADR-0006);
//   - velexis_ota_app may select the shared Amadeus account tables (ADR-0012) and the tables of R__ota_read_access.sql
//     (on accounts, only the listed columns), and none of the platform-only tables of 0002 nor billing_customers.
//
// The file clones the template database of @velexis/testing (the real runner applied 0001, 0002 and
// R__ota_read_access). velexis_platform_app first writes one row into every table the matrix names, with the builders
// of test/builders/platform-rows.ts, so an allowed read returns that row and a denied one hides it. Every check logs
// in as the role itself, with the development DSNs of the .env.example files (TEST_ROLES), and asserts PostgreSQL's
// "permission denied" (SQLSTATE 42501) with the table's name; the catalog (has_table_privilege) is compared with the
// same matrix. Writes made to prove a statement valid (as the owner) are rolled back.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPool } from "@velexis/db";
import { createTestDatabase, type TestDatabase, type TestRole } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertEmailOutbox,
  insertPaymentConnection,
  insertRow,
  insertSettlement,
  insertSettlementLine,
  insertSupplierConnection,
  insertTenant,
  insertTenantDomain,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  platformTable,
  testId,
  velexisSource,
  type PlatformRow,
  type PlatformTable,
  type Queryable,
} from "../../builders/platform-rows";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");
const OTA_READ_ACCESS_SQL = join(
  REPO,
  "platform",
  "backend",
  "migrations",
  "platform",
  "R__ota_read_access.sql",
);

/** The tables velexis_ota_app may read in full: R__ota_read_access.sql (ADR-0004's list). */
const OTA_READ_ACCESS_TABLES: readonly PlatformTable[] = [
  "api_key_tenant_grants",
  "api_keys",
  "payment_provider_connections",
  "plans",
  "supplier_connections",
  "tenant_domains",
  "tenant_memberships",
  "tenants",
];
/** ADR-0004: the only columns of platform.accounts velexis_ota_app may read (R__ota_read_access.sql). */
const OTA_ACCOUNT_COLUMNS = [
  "id",
  "email",
  "email_verified_at",
  "full_name",
  "locale",
  "time_zone",
  "mfa_enabled",
  "status",
  "deleted_at",
  "version",
];
/** The shared Amadeus account tables of ADR-0012, which 0002 grants itself (data-model.md §4.8). */
const OTA_AMADEUS_TABLES: readonly PlatformTable[] = ["amadeus_accounts", "amadeus_offices"];
/** Tables velexis_ota_app must not read (PBE-003 step 3): settlements, secrets, tokens, billing. */
const OTA_DENIED_TABLES: readonly PlatformTable[] = [
  "settlements",
  "settlement_lines",
  "tenant_payout_accounts",
  "credential_submissions",
  "stripe_events",
  "email_outbox",
  "account_tokens",
  "account_recovery_codes",
  "billing_customers",
];
/** The 11 tables 0002 creates; it grants DML on each to velexis_platform_app. */
const NEW_TABLES: readonly PlatformTable[] = [
  "account_recovery_codes",
  "account_tokens",
  "amadeus_accounts",
  "amadeus_offices",
  "billing_customers",
  "credential_submissions",
  "email_outbox",
  "settlement_lines",
  "settlements",
  "stripe_events",
  "tenant_payout_accounts",
];
const AUDIT_LOG = "platform_audit_log" satisfies PlatformTable;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;
type Privilege = (typeof PRIVILEGES)[number];

/** The privilege matrix of PBE-003 step 3, as `table -> privileges` per role. */
const MATRIX: Record<"velexis_platform_app" | "velexis_ota_app", Record<string, readonly Privilege[]>> = {
  velexis_platform_app: {
    [AUDIT_LOG]: ["SELECT", "INSERT"],
    ...Object.fromEntries(
      NEW_TABLES.map((table) => [table, ["SELECT", "INSERT", "UPDATE", "DELETE"] as const]),
    ),
  },
  velexis_ota_app: {
    ...Object.fromEntries(
      [...OTA_READ_ACCESS_TABLES, ...OTA_AMADEUS_TABLES].map((table) => [table, ["SELECT"] as const]),
    ),
    ...Object.fromEntries(OTA_DENIED_TABLES.map((table) => [table, [] as const])),
    // Column privileges only (below): a table-level SELECT would cover every column, secrets included.
    accounts: [],
    [AUDIT_LOG]: [],
  },
};

type Pool = ReturnType<typeof createPool>;

const denied = (table: string) => ({ code: "42501", message: `permission denied for table ${table}` });
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

let db: TestDatabase;
let pools: Record<TestRole, Pool>;
/** The rows velexis_platform_app wrote in beforeAll. */
let rows: {
  account: PlatformRow<"accounts">;
  tenant: PlatformRow<"tenants">;
  amadeusAccount: PlatformRow<"amadeus_accounts">;
  office: PlatformRow<"amadeus_offices">;
  auditEntry: PlatformRow<"platform_audit_log">;
};

function pool(role: TestRole): Pool {
  return createPool(db.urlFor(role), {
    applicationName: `platform-int-privileges-0002-${role}`,
    logger: { error: () => undefined },
    max: 2,
  });
}

/** Runs `fn` on a connection of `role` inside a transaction that is always rolled back. */
async function rolledBack(role: TestRole, fn: (tx: Queryable) => Promise<void>): Promise<void> {
  const client = await pools[role].connect();
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

/** One row in every table of the matrix, written by velexis_platform_app. */
async function writeOneRowPerTable(platformApp: Pool): Promise<typeof rows> {
  const account = await insertAccount(platformApp);
  const tenant = await insertTenant(platformApp, { created_by_account_id: account.id });
  const amadeusAccount = await insertAmadeusAccount(platformApp);
  const office = await insertAmadeusOffice(platformApp, amadeusAccount, {
    status: "assigned",
    assigned_tenant_id: tenant.id,
    assigned_at: new Date("2026-10-02T08:00:00.000Z"),
  });
  await insertSupplierConnection(platformApp, tenant, velexisSource(amadeusAccount));
  await insertPaymentConnection(platformApp, tenant);
  await insertTenantDomain(platformApp, tenant);
  await insertRow(platformApp, "tenant_memberships", {
    id: testId("stf", 1),
    tenant_id: tenant.id,
    account_id: account.id,
    role: "owner",
  });
  await insertRow(platformApp, "api_keys", {
    id: testId("key", 1),
    tenant_id: tenant.id,
    name: "Storefront",
    kind: "publishable",
    environment: "test",
    prefix: "pk_test_PBE003a",
    key_hash: sha256("PBE-003 publishable key"),
    last4: "0001",
  });
  const hostingKey = await insertRow(platformApp, "api_keys", {
    id: testId("key", 2),
    owner_account_id: account.id,
    name: "Hosting",
    kind: "hosting",
    environment: "test",
    prefix: "hk_test_PBE003b",
    key_hash: sha256("PBE-003 hosting key"),
    last4: "0002",
  });
  await insertRow(platformApp, "api_key_tenant_grants", {
    api_key_id: hostingKey.id,
    tenant_id: tenant.id,
    granted_by_account_id: account.id,
  });

  const settlement = await insertSettlement(platformApp, tenant);
  await insertSettlementLine(platformApp, settlement);
  await insertRow(platformApp, "tenant_payout_accounts", {
    tenant_id: tenant.id,
    account_holder_name: "Agency Travel SAS",
    country_code: "FR",
    currency: "EUR",
    scheme: "iban",
    bank_details_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT),
    encryption_key_id: PLACEHOLDER_KEK_ID,
    last4: "0189",
  });
  await insertRow(platformApp, "credential_submissions", {
    id: testId("crs", 1),
    tenant_id: tenant.id,
    kind: "amadeus",
    environment: "live",
    public_data: { clientId: "ota-live-client" },
    status: "failed",
    error_code: "AMADEUS_CREDENTIALS_INVALID",
    finished_at: new Date("2026-10-03T08:00:00.000Z"),
  });
  await insertRow(platformApp, "stripe_events", {
    id: "evt_1PBE003Test0001",
    endpoint: "billing",
    type: "customer.subscription.updated",
    livemode: false,
    stripe_created_at: new Date("2026-10-03T08:00:00.000Z"),
  });
  await insertEmailOutbox(platformApp, { account_id: account.id, tenant_id: tenant.id });
  await insertRow(platformApp, "account_tokens", {
    id: testId("atk", 1),
    account_id: account.id,
    purpose: "email_verification",
    token_hash: sha256("PBE-003 verification token"),
    email: account.email,
    expires_at: new Date("2026-10-04T08:00:00.000Z"),
  });
  await insertRow(platformApp, "account_recovery_codes", {
    account_id: account.id,
    code_hash: sha256("PBE-003 recovery code"),
  });
  await insertRow(platformApp, "billing_customers", {
    tenant_id: tenant.id,
    provider_customer_id: "cus_PBE003Test0001",
    livemode: false,
  });
  const auditEntry = await insertRow(platformApp, AUDIT_LOG, {
    tenant_id: tenant.id,
    tenant_key: tenant.key,
    actor_type: "system",
    actor_label: "pbe-003",
    action: "tenant.created",
    target_type: "tenant",
    target_id: tenant.id,
    details: { source: "privileges-0002" },
  });
  return { account, tenant, amadeusAccount, office, auditEntry };
}

beforeAll(async () => {
  db = await createTestDatabase();
  pools = {
    migrator: pool("migrator"),
    provisioner: pool("provisioner"),
    platform: pool("platform"),
    ota: pool("ota"),
  };
  rows = await writeOneRowPerTable(pools.platform);
});

afterAll(async () => {
  if (pools !== undefined) {
    await Promise.all(Object.values(pools).map((each) => each.end()));
  }
  await db?.drop();
});

describe("migration 0002 privileges on a fresh test database", () => {
  it("lets velexis_platform_app insert into platform_audit_log and read the entry back [PBE-003 AC2]", async () => {
    expect(rows.auditEntry).toMatchObject({
      id: expect.stringMatching(/^[0-9]+$/),
      action: "tenant.created",
      details: { source: "privileges-0002" },
    });
    const second = await insertRow(pools.platform, AUDIT_LOG, {
      actor_type: "account",
      actor_account_id: rows.account.id,
      action: "api_key.created",
    });
    const { rows: entries } = await pools.platform.query(
      "SELECT id, action FROM platform.platform_audit_log ORDER BY id",
    );
    expect(entries).toEqual([
      { id: rows.auditEntry.id, action: "tenant.created" },
      { id: second.id, action: "api_key.created" },
    ]);
  });

  it("denies velexis_platform_app UPDATE, DELETE and TRUNCATE on platform_audit_log [PBE-003 AC2]", async () => {
    const statements = [
      [
        "UPDATE",
        "UPDATE platform.platform_audit_log SET action = 'tenant.deleted' WHERE id = $1",
        [rows.auditEntry.id],
      ],
      ["DELETE", "DELETE FROM platform.platform_audit_log WHERE id = $1", [rows.auditEntry.id]],
      ["TRUNCATE", "TRUNCATE platform.platform_audit_log", []],
    ] as const;
    for (const [, text, values] of statements) {
      await expect(pools.platform.query(text, [...values])).rejects.toMatchObject(denied(AUDIT_LOG));
    }
    // The entry is untouched.
    const { rows: entry } = await pools.platform.query(
      "SELECT action, details FROM platform.platform_audit_log WHERE id = $1",
      [rows.auditEntry.id],
    );
    expect(entry).toEqual([{ action: "tenant.created", details: { source: "privileges-0002" } }]);
    // The statements are valid: the owner (velexis_migrator) runs them, in a transaction that is rolled back.
    for (const [, text, values] of statements) {
      await rolledBack("migrator", async (tx) => {
        await expect(tx.query(text, [...values])).resolves.toBeDefined();
      });
    }
    const { rows: catalog } = await pools.migrator.query(
      "SELECT p.privilege, has_table_privilege('velexis_platform_app', 'platform.platform_audit_log', p.privilege) " +
        "AS allowed FROM unnest($1::text[]) WITH ORDINALITY AS p(privilege, n) ORDER BY p.n",
      [[...PRIVILEGES]],
    );
    expect(catalog).toEqual([
      { privilege: "SELECT", allowed: true },
      { privilege: "INSERT", allowed: true },
      { privilege: "UPDATE", allowed: false },
      { privilege: "DELETE", allowed: false },
      { privilege: "TRUNCATE", allowed: false },
    ]);
  });

  it("lets velexis_ota_app select amadeus_accounts and amadeus_offices [PBE-003 AC2]", async () => {
    const { rows: accounts } = await pools.ota.query(
      "SELECT id, environment, base_url, status FROM platform.amadeus_accounts",
    );
    expect(accounts).toEqual([
      {
        id: rows.amadeusAccount.id,
        environment: "test",
        base_url: rows.amadeusAccount.base_url,
        status: "active",
      },
    ]);
    const { rows: offices } = await pools.ota.query(
      "SELECT id, amadeus_account_id, office_id, status, assigned_tenant_id FROM platform.amadeus_offices",
    );
    expect(offices).toEqual([
      {
        id: rows.office.id,
        amadeus_account_id: rows.amadeusAccount.id,
        office_id: rows.office.office_id,
        status: "assigned",
        assigned_tenant_id: rows.tenant.id,
      },
    ]);
    // Read only: the OTA backend never writes a platform table (ADR-0003).
    await expect(
      pools.ota.query("UPDATE platform.amadeus_offices SET notes = 'ota' WHERE id = $1", [rows.office.id]),
    ).rejects.toMatchObject(denied("amadeus_offices"));
    await expect(
      pools.ota.query("DELETE FROM platform.amadeus_accounts WHERE id = $1", [rows.amadeusAccount.id]),
    ).rejects.toMatchObject(denied("amadeus_accounts"));
  });

  it("lets velexis_ota_app select every table of R__ota_read_access.sql, and only the listed accounts columns [PBE-003 AC2]", async () => {
    // The list of this test is the file's: every platform table its GRANT statements name.
    const file = await readFile(OTA_READ_ACCESS_SQL, "utf8");
    const statements = file
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n");
    const granted = [...new Set([...statements.matchAll(/platform\.([a-z_]+)/g)].map((match) => match[1]))];
    expect(granted.sort()).toEqual([...OTA_READ_ACCESS_TABLES, "accounts"].sort());

    for (const table of OTA_READ_ACCESS_TABLES) {
      const asOta = await pools.ota.query(`SELECT * FROM ${platformTable(table)} ORDER BY 1`);
      const asPlatform = await pools.platform.query(`SELECT * FROM ${platformTable(table)} ORDER BY 1`);
      expect({ table, rows: asOta.rows }).toEqual({ table, rows: asPlatform.rows });
      // beforeAll wrote one row into each (plans: the seeded early_access plan).
      expect({ table, count: asOta.rowCount }).toEqual({ table, count: table === "api_keys" ? 2 : 1 });
    }

    const { rows: accounts } = await pools.ota.query(
      `SELECT ${OTA_ACCOUNT_COLUMNS.join(", ")} FROM platform.accounts`,
    );
    expect(accounts).toEqual([
      expect.objectContaining({ id: rows.account.id, email: rows.account.email, status: "active" }),
    ]);
    await expect(pools.ota.query("SELECT * FROM platform.accounts")).rejects.toMatchObject(
      denied("accounts"),
    );
    await expect(pools.ota.query("SELECT password_hash FROM platform.accounts")).rejects.toMatchObject(
      denied("accounts"),
    );
  });

  it.each(OTA_DENIED_TABLES)("denies velexis_ota_app SELECT on platform.%s [PBE-003 AC2]", async (table) => {
    await expect(pools.ota.query(`SELECT * FROM ${platformTable(table)}`)).rejects.toMatchObject(
      denied(table),
    );
    await expect(pools.ota.query(`SELECT count(*) FROM ${platformTable(table)}`)).rejects.toMatchObject(
      denied(table),
    );
    // The table exists and holds a row, which the platform role reads: the denial is a privilege, not a typo.
    await expect(pools.platform.query(`SELECT * FROM ${platformTable(table)}`)).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it("matches the privilege matrix in the catalog for velexis_platform_app and velexis_ota_app [PBE-003 AC2]", async () => {
    const expected = Object.entries(MATRIX).flatMap(([role, tables]) =>
      Object.entries(tables).flatMap(([table, allowed]) =>
        PRIVILEGES.map((privilege) => ({ role, table, privilege, allowed: allowed.includes(privilege) })),
      ),
    );
    const { rows: actual } = await pools.migrator.query(
      "SELECT e.role, e.table, e.privilege, " +
        "has_table_privilege(e.role, format('platform.%I', e.table), e.privilege) AS allowed " +
        'FROM jsonb_to_recordset($1::jsonb) AS e(role text, "table" text, privilege text)',
      [JSON.stringify(expected.map(({ role, table, privilege }) => ({ role, table, privilege })))],
    );
    expect(actual).toEqual(expected);

    // accounts: SELECT on the ten listed columns only, never a secret, hash or security counter (ADR-0004).
    const { rows: columns } = await pools.migrator.query(
      "SELECT a.attname AS column FROM pg_attribute a WHERE a.attrelid = 'platform.accounts'::regclass " +
        "AND a.attnum > 0 AND NOT a.attisdropped " +
        "AND has_column_privilege('velexis_ota_app', a.attrelid, a.attnum, 'SELECT') ORDER BY a.attnum",
    );
    expect(columns.map((column: { column: string }) => column.column)).toEqual(OTA_ACCOUNT_COLUMNS);
  });

  it("gives velexis_provisioner nothing on the platform schema (ADR-0004)", async () => {
    for (const table of [AUDIT_LOG, "accounts", "settlements", "amadeus_accounts"] as const) {
      await expect(pools.provisioner.query(`SELECT 1 FROM ${platformTable(table)}`)).rejects.toMatchObject({
        code: "42501",
        message: "permission denied for schema platform",
      });
    }
    const { rows: schema } = await pools.migrator.query(
      "SELECT has_schema_privilege('velexis_provisioner', 'platform', 'USAGE') AS usage, " +
        "has_schema_privilege('velexis_provisioner', 'platform', 'CREATE') AS create",
    );
    expect(schema).toEqual([{ usage: false, create: false }]);
  });
});
