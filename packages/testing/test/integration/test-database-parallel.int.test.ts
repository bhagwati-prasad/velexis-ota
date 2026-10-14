// The second file of the X-015 AC1 scenario (parallel-isolation.ts): it runs at the same time as
// test-database.int.test.ts, in another Vitest worker, with its own clone of the run's template.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_DATABASE_PREFIX, type TestDatabase } from "../../src/index.js";
import {
  arrive,
  BARRIER_TIMEOUT_MS,
  customerIds,
  leave,
  markerId,
  templateName,
  writeMarkers,
} from "./parallel-isolation.js";

describe("two test files running in parallel (second file)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await leave("second");
    await db?.drop();
  });

  it(
    "each get their own database, and changes in one are invisible to the other [X-015 AC1]",
    async () => {
      await writeMarkers(db, "second");
      // test-database.int.test.ts has written its own rows into its own database by now.
      const other = await arrive("second", db.name);
      // Their own databases, cloned from the one template of the run (X-015 AC2).
      expect(other.database).toMatch(new RegExp(`^${TEST_DATABASE_PREFIX}`));
      expect(other.database).not.toBe(db.name);
      expect(other.template).toBe(templateName());
      expect(await customerIds(db)).toEqual({
        tenant_alpha: [markerId("second", "tenant_alpha")],
        tenant_beta: [markerId("second", "tenant_beta")],
      });
    },
    BARRIER_TIMEOUT_MS + 10_000,
  );
});
