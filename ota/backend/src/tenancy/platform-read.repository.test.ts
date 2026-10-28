// PlatformReadRepository against a recording fake pool: the statements each lookup sends, the mapping, and the rows
// it refuses. The same lookups against PostgreSQL 16, as velexis_ota_app, are in
// test/integration/tenancy/platform-read.int.test.ts.
import {
  createPlatformDb,
  createTenantDb,
  InvalidTenantSchemaError,
  tenantTx,
  type createPool,
} from "@velexis/db";
import { describe, expect, it, vi } from "vitest";
import { newId } from "../common/ids";
import {
  MAX_MONITORED_QUEUES,
  parseMonitoredQueues,
  PLATFORM_READ_STATEMENT_TIMEOUT_MS,
  PlatformReadRepository,
} from "./platform-read.repository";
import { UnexpectedPlatformValueError, type PlatformTenant } from "./platform-read.types";

type Pool = ReturnType<typeof createPool>;

interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const TENANT_ID = newId("ten");

/** A `platform.tenants` row as node-postgres returns it, valid unless a test overrides a column. */
function tenantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TENANT_ID,
    key: "acme",
    name: "Acme Travel",
    status: "active",
    schema_name: "tenant_acme",
    storefront_environment: "live",
    default_currency: "GBP",
    default_locale: "en-GB",
    billing_notice: "past_due",
    ...overrides,
  };
}

/**
 * A pool with one fake connection that records every statement. Selects from `platform.tenants` answer `rows`; the
 * other statements (transaction control, set_config) answer no row.
 */
function fakePool(rows: readonly Record<string, unknown>[] = [], options: { failSelect?: Error } = {}) {
  const queries: RecordedQuery[] = [];
  const client = {
    query: (text: string, parameters: readonly unknown[] = []) => {
      const sql = text.replace(/\s+/g, " ").trim();
      queries.push({ sql, parameters });
      const isTenantSelect = sql.includes('from "platform"."tenants"');
      if (isTenantSelect && options.failSelect !== undefined) {
        return Promise.reject(options.failSelect);
      }
      const result = isTenantSelect ? rows : [];
      return Promise.resolve({ command: "SELECT", rowCount: result.length, rows: result });
    },
    release: vi.fn(),
  };
  const connect = vi.fn(() => Promise.resolve(client));
  const pool = { connect, end: () => Promise.resolve() } as unknown as Pool;
  return { pool, connect, client, queries, statements: () => queries.map((query) => query.sql) };
}

const START_READ_ONLY = "start transaction read only";
const SET_STATEMENT_TIMEOUT = "SELECT set_config('statement_timeout', $1, true)";
const SELECT_TENANT =
  'select "id", "key", "name", "status", "schema_name", "storefront_environment", "default_currency", "default_locale", "billing_notice" from "platform"."tenants"';

const EXPECTED_TENANT: PlatformTenant = {
  id: TENANT_ID,
  key: "acme",
  name: "Acme Travel",
  status: "active",
  schemaName: "tenant_acme" as PlatformTenant["schemaName"],
  storefrontEnvironment: "live",
  defaultCurrency: "GBP",
  defaultLocale: "en-GB",
  billingNotice: "past_due",
};

describe("PlatformReadRepository.tenantById", () => {
  it("reads the tenant in one read-only transaction with a short statement timeout and maps the row [OBE-003 AC1]", async () => {
    const fake = fakePool([tenantRow()]);
    const repository = new PlatformReadRepository(createPlatformDb(fake.pool));

    const tenant = await repository.tenantById(TENANT_ID);

    expect(tenant).toEqual(EXPECTED_TENANT);
    expect(Object.isFrozen(tenant)).toBe(true);
    expect(fake.queries).toEqual([
      { sql: START_READ_ONLY, parameters: [] },
      { sql: SET_STATEMENT_TIMEOUT, parameters: [String(PLATFORM_READ_STATEMENT_TIMEOUT_MS)] },
      { sql: `${SELECT_TENANT} where "id" = $1`, parameters: [TENANT_ID] },
      { sql: "commit", parameters: [] },
    ]);
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("returns null for an unknown id [OBE-003 AC1]", async () => {
    const fake = fakePool([]);
    const repository = new PlatformReadRepository(createPlatformDb(fake.pool));

    await expect(repository.tenantById(newId("ten"))).resolves.toBeNull();
    expect(fake.statements().at(-1)).toBe("commit");
  });

  it("maps a tenant without a billing notice to null", async () => {
    const fake = fakePool([tenantRow({ billing_notice: null, storefront_environment: "test" })]);
    const repository = new PlatformReadRepository(createPlatformDb(fake.pool));

    await expect(repository.tenantById(TENANT_ID)).resolves.toEqual({
      ...EXPECTED_TENANT,
      storefrontEnvironment: "test",
      billingNotice: null,
    });
  });

  it("rolls the transaction back and rethrows when the query fails", async () => {
    const failure = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const fake = fakePool([], { failSelect: failure });
    const repository = new PlatformReadRepository(createPlatformDb(fake.pool));

    await expect(repository.tenantById(TENANT_ID)).rejects.toBe(failure);
    expect(fake.statements()).toEqual([
      START_READ_ONLY,
      SET_STATEMENT_TIMEOUT,
      `${SELECT_TENANT} where "id" = $1`,
      "rollback",
    ]);
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });
});

describe("PlatformReadRepository.tenantByKey", () => {
  it("reads the tenant by its key, bound as a parameter [OBE-003 AC1]", async () => {
    const fake = fakePool([tenantRow()]);
    const repository = new PlatformReadRepository(createPlatformDb(fake.pool));

    await expect(repository.tenantByKey("acme")).resolves.toEqual(EXPECTED_TENANT);
    expect(fake.queries).toEqual([
      { sql: START_READ_ONLY, parameters: [] },
      { sql: SET_STATEMENT_TIMEOUT, parameters: [String(PLATFORM_READ_STATEMENT_TIMEOUT_MS)] },
      { sql: `${SELECT_TENANT} where "key" = $1`, parameters: ["acme"] },
      { sql: "commit", parameters: [] },
    ]);
  });

  it("returns null for an unknown key [OBE-003 AC1]", async () => {
    const fake = fakePool([]);
    const repository = new PlatformReadRepository(createPlatformDb(fake.pool));

    await expect(repository.tenantByKey("nosuchkey")).resolves.toBeNull();
  });

  it.each(["", "a", "Acme", "demo.ota", "acme travel", "acme\u0000", "1acme", "a".repeat(41)])(
    "treats %j, which cannot be a tenant key, as unknown without a query",
    async (key) => {
      const fake = fakePool([tenantRow()]);
      const repository = new PlatformReadRepository(createPlatformDb(fake.pool));

      await expect(repository.tenantByKey(key)).resolves.toBeNull();
      expect(fake.connect).not.toHaveBeenCalled();
    },
  );
});

describe("rows the repository refuses", () => {
  it.each([null, "tenant_Acme", "tenant_a", "public", "tenant_x; DROP SCHEMA tenant_alpha CASCADE"])(
    "refuses a row with the schema name %j before any tenant SQL runs [OBE-003 AC3]",
    async (schemaName) => {
      const fake = fakePool([tenantRow({ schema_name: schemaName })]);
      const pool = fake.pool;
      const repository = new PlatformReadRepository(createPlatformDb(pool));
      const tenants = createTenantDb(pool, { appEnv: "test" });
      const resolved = vi.fn();
      const useCase = vi.fn(() => Promise.resolve("never"));

      // What a tenant-scoped use case does: resolve the tenant, then open its tenant transaction on the same pool.
      const run = async (): Promise<string> => {
        const tenant = await repository.tenantById(TENANT_ID);
        resolved(tenant);
        if (tenant === null) {
          throw new Error("unknown tenant");
        }
        return await tenantTx(tenants, tenant.schemaName, useCase);
      };

      await expect(run()).rejects.toBeInstanceOf(InvalidTenantSchemaError);
      // The repository itself refused the row: no caller got the schema name.
      expect(resolved).not.toHaveBeenCalled();
      expect(useCase).not.toHaveBeenCalled();
      // Only the platform read reached the database: one connection, one read-only transaction, committed.
      expect(fake.connect).toHaveBeenCalledTimes(1);
      expect(fake.statements()).toEqual([
        START_READ_ONLY,
        SET_STATEMENT_TIMEOUT,
        `${SELECT_TENANT} where "id" = $1`,
        "commit",
      ]);
    },
  );

  it.each([
    ["status", "archived", "provisioning, active, suspended, deprovisioning, deleted, failed"],
    ["storefront_environment", "production", "test, live"],
    ["billing_notice", "overdue", "past_due, trial_ending"],
  ])(
    "refuses a row whose %s is %j, naming the column, the row and the known values",
    async (column, value, known) => {
      const fake = fakePool([tenantRow({ [column]: value })]);
      const repository = new PlatformReadRepository(createPlatformDb(fake.pool));

      const error: unknown = await repository.tenantById(TENANT_ID).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnexpectedPlatformValueError);
      expect(error).toMatchObject({
        column: `platform.tenants.${column}`,
        rowId: TENANT_ID,
        message: `platform.tenants.${column} of ${TENANT_ID} is "${value}", not one of ${known}`,
      });
    },
  );
});

describe("parseMonitoredQueues (OBE-065: the queue poller's list)", () => {
  it("keeps each well-formed entry once, in order, and counts the others", () => {
    const parsed = parseMonitoredQueues([
      { officeId: "NCE1A0955", queueId: 50, category: 0 },
      { officeId: "NCE1A0955", queueId: 8, category: 3 },
      // The same queue again, then entries of other shapes and ranges.
      { officeId: "NCE1A0955", queueId: 50, category: 0 },
      { officeId: "nce1a0955", queueId: 1, category: 0 },
      { officeId: "NCE1A0955", queueId: 100, category: 0 },
      { officeId: "NCE1A0955", queueId: 1, category: 255 },
      { officeId: "NCE1A0955", queueId: 1.5, category: 0 },
      { officeId: "NCE1A0955", queueId: "1", category: 0 },
      { officeId: "NCE1A0955", queueId: 1 },
      { officeId: "NCE1A0955", queueId: 1, category: 0, max: 10 },
      "NCE1A0955/1/0",
      null,
    ]);

    expect(parsed).toEqual({
      queues: [
        { officeId: "NCE1A0955", queueId: 50, category: 0 },
        { officeId: "NCE1A0955", queueId: 8, category: 3 },
      ],
      invalid: 10,
    });
    expect(Object.isFrozen(parsed.queues)).toBe(true);
  });

  it(`polls at most ${MAX_MONITORED_QUEUES} queues of a connection, as the platform allows`, () => {
    const entries = Array.from({ length: MAX_MONITORED_QUEUES + 2 }, (_, queueId) => ({
      officeId: "NCE1A0955",
      queueId,
      category: 0,
    }));

    const parsed = parseMonitoredQueues(entries);

    expect(parsed.queues).toHaveLength(MAX_MONITORED_QUEUES);
    expect(parsed.queues.at(-1)).toEqual({
      officeId: "NCE1A0955",
      queueId: MAX_MONITORED_QUEUES - 1,
      category: 0,
    });
    expect(parsed.invalid).toBe(2);
  });

  it("reads an empty or missing list as no queue, and a value that is not a list as one invalid entry", () => {
    expect(parseMonitoredQueues([])).toEqual({ queues: [], invalid: 0 });
    expect(parseMonitoredQueues(null)).toEqual({ queues: [], invalid: 0 });
    expect(parseMonitoredQueues({ officeId: "NCE1A0955", queueId: 50, category: 0 })).toEqual({
      queues: [],
      invalid: 1,
    });
  });
});
