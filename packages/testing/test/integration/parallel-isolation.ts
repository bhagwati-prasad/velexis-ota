// The scenario of X-015 AC1 run by two integration test files at the same time (test-database.int.test.ts and
// test-database-parallel.int.test.ts): each file clones its own database, writes its own customers into tenant_alpha
// and tenant_beta through tenantTx as velexis_ota_app, waits until the other file has written too, then reads its
// database back and must find only its own rows.
//
// "At the same time" is proven, not assumed: the files meet at a barrier of marker files in a folder of the system
// temporary folder named after the run id of the template both files were given (unique per run, so a folder left by
// an interrupted run is never mistaken for this one's). Each file writes `arrived-<file>` with its database and
// template names and waits for the other's; at the end each writes `done-<file>`, and the file that sees both
// `done-*` removes the folder.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPool, createTenantDb, tenantTx, type TenantDb } from "@velexis/db";
import { inject, vi } from "vitest";
import {
  runIdOfTemplate,
  TEMPLATE_DATABASE_KEY,
  TEST_TENANTS,
  type TestDatabase,
  type TestTenant,
} from "../../src/index.js";

export type ParallelFile = "first" | "second";

/** How long a file waits for the other one at the barrier. */
export const BARRIER_TIMEOUT_MS = 60_000;

interface CustomersTable {
  id: string;
  email: string;
}
interface MarkerDatabase {
  customers: CustomersTable;
}

const OTHER: Readonly<Record<ParallelFile, ParallelFile>> = { first: "second", second: "first" };

/** The customer id one file writes into one tenant: `cus_<file>_<tenant key>`. */
export function markerId(file: ParallelFile, tenant: TestTenant): string {
  return `cus_${file}_${tenant.slice("tenant_".length)}`;
}

/** The run's template, provided by the global setup. */
export function templateName(): string {
  const template = (inject as (key: string) => unknown)(TEMPLATE_DATABASE_KEY);
  if (typeof template !== "string") {
    throw new Error("no template database was provided to this test file");
  }
  return template;
}

/** The barrier folder of this run: both files are given the same template, whose run id is unique. */
function barrierDir(): string {
  return join(tmpdir(), `velexis-testing-parallel-isolation-${runIdOfTemplate(templateName())}`);
}

/** Creates the barrier folder, readable by this user only. */
async function makeBarrierDir(): Promise<string> {
  const dir = barrierDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** What a file announces at the barrier. */
export interface Arrival {
  readonly database: string;
  readonly template: string;
}

/** Runs `fn` with a tenant database handle as velexis_ota_app on `db`, then ends the pool. */
export async function withTenantDb<T>(
  db: TestDatabase,
  fn: (tenants: TenantDb<MarkerDatabase>) => Promise<T>,
): Promise<T> {
  const pool = createPool(db.urlFor("ota"), {
    applicationName: "velexis-testing-int",
    logger: { error: vi.fn() },
    max: 2,
  });
  try {
    return await fn(createTenantDb<MarkerDatabase>(pool, { appEnv: "test" }));
  } finally {
    await pool.end();
  }
}

/** Writes this file's customer into each tenant schema, through tenantTx (the only way to tenant data). */
export async function writeMarkers(db: TestDatabase, file: ParallelFile): Promise<void> {
  await withTenantDb(db, async (tenants) => {
    for (const tenant of TEST_TENANTS) {
      const id = markerId(file, tenant);
      await tenantTx(tenants, tenant, (trx) =>
        trx
          .insertInto("customers")
          .values({ id, email: `${id}@example.com` })
          .execute(),
      );
    }
  });
}

/** The customer ids of each tenant schema of `db`, sorted. */
export async function customerIds(db: TestDatabase): Promise<Record<TestTenant, string[]>> {
  return await withTenantDb(db, async (tenants) => {
    const ids = {} as Record<TestTenant, string[]>;
    for (const tenant of TEST_TENANTS) {
      const rows = await tenantTx(tenants, tenant, (trx) =>
        trx.selectFrom("customers").select("id").orderBy("id").execute(),
      );
      ids[tenant] = rows.map((row) => row.id);
    }
    return ids;
  });
}

/**
 * Announces that `file` has written its rows to `database`, and waits until the other file has done the same.
 * Returns the other file's database and template.
 */
export async function arrive(file: ParallelFile, database: string): Promise<Arrival> {
  const dir = await makeBarrierDir();
  const arrival: Arrival = { database, template: templateName() };
  await writeFile(join(dir, `arrived-${file}`), JSON.stringify(arrival));
  const other = join(dir, `arrived-${OTHER[file]}`);
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(other)) {
    if (Date.now() > deadline) {
      throw new Error(
        `the ${OTHER[file]} test file did not arrive within ${BARRIER_TIMEOUT_MS} ms: run both test-database files ` +
          "together (pnpm test:int), in parallel",
      );
    }
    await delay(25);
  }
  return JSON.parse(await readFile(other, "utf8")) as Arrival;
}

/**
 * Marks `file` as done; the second file to finish removes the barrier folder. When the other file never arrived
 * (this file ran alone and failed at the barrier), there is nobody to wait for, and the folder goes at once.
 */
export async function leave(file: ParallelFile): Promise<void> {
  const dir = await makeBarrierDir();
  await writeFile(join(dir, `done-${file}`), "");
  const other = OTHER[file];
  if (existsSync(join(dir, `done-${other}`)) || !existsSync(join(dir, `arrived-${other}`))) {
    await rm(dir, { recursive: true, force: true });
  }
}
