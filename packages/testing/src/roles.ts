// The PostgreSQL login roles of deploy/postgres/bootstrap.sql, with the development passwords of the root
// .env.example (DATABASE_MIGRATOR_URL, DATABASE_PROVISIONER_URL) and of platform/backend/.env.example and
// ota/backend/.env.example (DATABASE_URL). deploy/scripts/dev-setup.sh sets them locally and the CI bootstrap sets
// them on the runner. They are TEST-ONLY dummy values: production passwords live in /etc/velexis on the VM and never
// in the repository (ADR-0010). roles.test.ts fails when the .env.example files and this table differ.

/** The roles a test database hands out URLs for: `createTestDatabase().urlFor(role)`. */
export type TestRole = "migrator" | "provisioner" | "platform" | "ota";

export interface TestRoleLogin {
  /** The PostgreSQL role name. */
  readonly user: string;
  /** The development password of `.env.example`; test-only. */
  readonly password: string;
  /** The variable and `.env.example` file that carry this login (the source of truth for the password). */
  readonly source: { readonly file: string; readonly variable: string };
}

/**
 * The four login roles (ADR-0004 Database roles):
 * - `migrator`: `velexis_migrator`, DDL, owns the database, `platform` and `reference`;
 * - `provisioner`: `velexis_provisioner`, owns every `tenant_<key>` schema;
 * - `platform`: `velexis_platform_app`, DML on `platform` and `reference`, nothing on tenants;
 * - `ota`: `velexis_ota_app`, DML on tenant schemas, `search_path = pg_catalog` until `tenantTx` sets it.
 */
export const TEST_ROLES: Readonly<Record<TestRole, TestRoleLogin>> = Object.freeze({
  migrator: Object.freeze({
    user: "velexis_migrator",
    password: "dev_migrator",
    source: Object.freeze({ file: ".env.example", variable: "DATABASE_MIGRATOR_URL" }),
  }),
  provisioner: Object.freeze({
    user: "velexis_provisioner",
    password: "dev_provisioner",
    source: Object.freeze({ file: ".env.example", variable: "DATABASE_PROVISIONER_URL" }),
  }),
  platform: Object.freeze({
    user: "velexis_platform_app",
    password: "dev_platform",
    source: Object.freeze({ file: "platform/backend/.env.example", variable: "DATABASE_URL" }),
  }),
  ota: Object.freeze({
    user: "velexis_ota_app",
    password: "dev_ota",
    source: Object.freeze({ file: "ota/backend/.env.example", variable: "DATABASE_URL" }),
  }),
});

/** The roles in a fixed order. */
export const TEST_ROLE_NAMES: readonly TestRole[] = Object.freeze([
  "migrator",
  "provisioner",
  "platform",
  "ota",
]);

/**
 * `url` (usually TEST_DATABASE_ADMIN_URL) with the database, and optionally the login, replaced. Host, port and
 * query parameters stay as they are. The result carries a password: never log or print it.
 */
export function databaseUrl(
  url: string,
  database: string,
  login?: Pick<TestRoleLogin, "user" | "password">,
): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  if (login !== undefined) {
    parsed.username = encodeURIComponent(login.user);
    parsed.password = encodeURIComponent(login.password);
  }
  return parsed.toString();
}
