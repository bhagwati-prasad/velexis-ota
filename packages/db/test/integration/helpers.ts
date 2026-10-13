// A scratch PostgreSQL database for the @velexis/db integration tests (X-010). @velexis/testing (X-015)
// replaces this helper with migrated template databases.
//
// As TEST_DATABASE_ADMIN_URL (role velexis_test_admin: LOGIN CREATEDB, member of velexis_migrator; created by
// deploy/scripts/dev-setup.sh locally and by the CI bootstrap) it creates `velexis_dbtest_<random>` owned by
// velexis_migrator with the database-level grants of deploy/postgres/bootstrap.sql, then two tenant schemas
// owned by velexis_provisioner (as provisioning does), each with an `items` table holding different rows, a
// small `reference` and `platform` schema, and the grants of velexis_ota_app. The login roles and their
// `ALTER ROLE ... SET` defaults (search_path = pg_catalog for velexis_ota_app) are cluster-wide, so they come
// from bootstrap.sql.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import pg from "pg";

/** The two tenant schemas. A tenant key has at least two characters, so `tenant_a` is not a schema name. */
export const TENANTS = ["tenant_alpha", "tenant_beta"] as const;
export type TestTenant = (typeof TENANTS)[number];

/** The rows of `<tenant>.items`: every label names its own tenant, and the two sets never overlap. */
export const ITEMS: Readonly<
  Record<TestTenant, ReadonlyArray<{ id: string; label: string; price: string }>>
> = {
  tenant_alpha: [
    { id: "itm_a1", label: "alpha one", price: "12.30" },
    { id: "itm_a2", label: "alpha two", price: "0.05" },
    { id: "itm_a3", label: "alpha three", price: "1000.00" },
  ],
  tenant_beta: [
    { id: "itm_b1", label: "beta one", price: "7.00" },
    { id: "itm_b2", label: "beta two", price: "99.99" },
  ],
};

/**
 * The development password of velexis_ota_app, set by deploy/scripts/dev-setup.sh and the CI bootstrap from
 * .env.example. A test-only dummy value; production passwords live in /etc/velexis (ADR-0010).
 */
const OTA_APP_DEV_PASSWORD = "dev_ota";

export interface ScratchDatabase {
  /** `velexis_dbtest_<random>`. */
  readonly name: string;
  /** DSN of the scratch database as velexis_ota_app (role default search_path = pg_catalog). */
  readonly otaUrl: string;
  /** Drops the database. End every pool on it first. */
  drop(): Promise<void>;
}

function adminUrl(): string {
  loadDevEnvFiles({ appDir: resolve(__dirname, "..", "..") });
  const config = defineConfig({
    TEST_DATABASE_ADMIN_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  });
  return config.TEST_DATABASE_ADMIN_URL;
}

function withDatabase(
  url: string,
  database: string,
  credentials?: { user: string; password: string },
): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (credentials !== undefined) {
    parsed.username = credentials.user;
    parsed.password = credentials.password;
  }
  return parsed.toString();
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: "velexis-db-int-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates the scratch database described at the top of this file. */
export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const admin = adminUrl();
  const name = `velexis_dbtest_${randomBytes(6).toString("hex")}`;
  const database = pg.escapeIdentifier(name);

  await withClient(admin, async (client) => {
    // The same database options and grants as deploy/postgres/bootstrap.sql.
    await client.query(
      `CREATE DATABASE ${database} OWNER velexis_migrator ENCODING 'UTF8' ` +
        `LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0`,
    );
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO velexis_platform_app, velexis_ota_app`,
    );
    await client.query(`GRANT CONNECT, TEMPORARY, CREATE ON DATABASE ${database} TO velexis_provisioner`);
    await client.query(`GRANT ALL ON DATABASE ${database} TO velexis_migrator`);
  });

  const scratch: ScratchDatabase = {
    name,
    otaUrl: withDatabase(admin, name, { user: "velexis_ota_app", password: OTA_APP_DEV_PASSWORD }),
    drop: () =>
      withClient(admin, async (client) => void (await client.query(`DROP DATABASE IF EXISTS ${database}`))),
  };

  try {
    await withClient(withDatabase(admin, name), async (client) => {
      await client.query("BEGIN");
      await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      // platform and reference belong to the migrator, as after bootstrap.sql and the baselines.
      await client.query("SET LOCAL ROLE velexis_migrator");
      await client.query("CREATE SCHEMA platform");
      await client.query("CREATE TABLE platform.tenants (id text PRIMARY KEY, schema_name text NOT NULL)");
      await client.query(
        "INSERT INTO platform.tenants VALUES ('ten_alpha', 'tenant_alpha'), ('ten_beta', 'tenant_beta')",
      );
      await client.query("CREATE SCHEMA reference");
      await client.query(
        "CREATE TABLE reference.currencies (code text PRIMARY KEY, minor_units smallint NOT NULL)",
      );
      await client.query("INSERT INTO reference.currencies VALUES ('EUR', 2), ('JPY', 0)");
      await client.query("GRANT USAGE ON SCHEMA platform, reference TO velexis_ota_app");
      await client.query("GRANT SELECT ON platform.tenants, reference.currencies TO velexis_ota_app");
      // Tenant schemas belong to the provisioner, as after provisioning (ADR-0004).
      await client.query("SET LOCAL ROLE velexis_provisioner");
      for (const tenant of TENANTS) {
        const schema = pg.escapeIdentifier(tenant);
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(
          `CREATE TABLE ${schema}.items (id text PRIMARY KEY, label text NOT NULL, price numeric(12,2) NOT NULL, ` +
            "created_at timestamptz NOT NULL DEFAULT now())",
        );
        for (const item of ITEMS[tenant]) {
          await client.query(`INSERT INTO ${schema}.items (id, label, price) VALUES ($1, $2, $3)`, [
            item.id,
            item.label,
            item.price,
          ]);
        }
        await client.query(`GRANT USAGE ON SCHEMA ${schema} TO velexis_ota_app`);
        await client.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO velexis_ota_app`,
        );
      }
      await client.query("COMMIT");
    });
  } catch (error) {
    await scratch.drop();
    throw error;
  }
  return scratch;
}
