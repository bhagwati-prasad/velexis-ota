// Unit tests of `secrets:rewrap` (OBE-100): its arguments, its report and its exit codes, the per-table run over an
// in-memory store with the semantics of rewrap.repository.ts's SQL (keyset pages, the optimistic check), and the
// refusals that come before any connection. The database itself is test/integration/secrets/rewrap.int.test.ts's.
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aadFor,
  decryptValue,
  encryptValue,
  envelopeKekId,
  LocalFileKeyProvider,
  type RewrapChange,
  type RewrapPage,
  type RewrapRow,
} from "@velexis/crypto";
import type { TenantSchema } from "@velexis/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort } from "../../test/helpers/ports";
import {
  failureReason,
  formatKekCounts,
  outcomeLine,
  REWRAP_EXIT,
  REWRAP_USAGE,
  rewrapArgumentsOf,
  rewrapSource,
  runSecretsRewrap,
  summaryOf,
  totalsOf,
  type TableOutcome,
} from "./rewrap.command";
import {
  NO_KEK_ID,
  REWRAP_SOURCES,
  sortedCounts,
  type CiphertextSource,
  type RewrapStore,
} from "./rewrap.repository";

const SCHEMA = "tenant_alpha" as TenantSchema;
const TRAVELERS = REWRAP_SOURCES.find((source) => source.table === "checkout_travelers") as CiphertextSource;
const [DOCUMENTS, DISCOUNTS] = TRAVELERS.columns as [string, string];

const created: string[] = [];
let keyFolder: string;
let emptyFolder: string;
let v1: LocalFileKeyProvider;
let v2: LocalFileKeyProvider;
/** A DATABASE_URL on a loopback port where nothing listens. */
let unreachableDatabaseUrl: string;

/** A folder of mode 0700 under the system's temporary folder, removed after the file. */
async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-ota-rewrap-"));
  created.push(dir);
  await chmod(dir, 0o700);
  return dir;
}

beforeAll(async () => {
  keyFolder = await folder();
  for (const version of [1, 2]) {
    const path = join(keyFolder, `master-v${version}.key`);
    await writeFile(path, `${randomBytes(32).toString("base64")}\n`);
    await chmod(path, 0o600);
  }
  emptyFolder = await folder();
  unreachableDatabaseUrl = `postgres://velexis_ota_app:unused@127.0.0.1:${await freePort()}/velexis`;
  [v1, v2] = await Promise.all([
    LocalFileKeyProvider.fromDir(keyFolder, "local:v1"),
    LocalFileKeyProvider.fromDir(keyFolder, "local:v2"),
  ]);
});

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface StoredRow {
  kekId: string;
  ciphertexts: Record<string, Buffer | null>;
}

/** The store of rewrap.repository.ts in memory: one table, keyset pages, and the update's optimistic check. */
class MemoryStore implements RewrapStore {
  readonly rows = new Map<string, StoredRow>();
  updates = 0;
  /** Thrown by the next `fetch` (a database outage). */
  failure: Error | undefined;

  fetch(_schema: TenantSchema, source: CiphertextSource, page: RewrapPage): Promise<readonly RewrapRow[]> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const ids = [...this.rows.keys()]
      .filter((id) => this.pending(id, page.currentKekId))
      .filter((id) => page.afterId === null || id > page.afterId)
      .sort()
      .slice(0, page.limit);
    return Promise.resolve(
      ids.map((id) => {
        const row = this.rows.get(id) as StoredRow;
        return {
          id,
          kekId: row.kekId,
          ciphertexts: Object.fromEntries(
            source.columns.map((column) => [column, row.ciphertexts[column] ?? null]),
          ),
        };
      }),
    );
  }

  update(_schema: TenantSchema, _source: CiphertextSource, change: RewrapChange): Promise<boolean> {
    this.updates += 1;
    const row = this.rows.get(change.id);
    // NULL and a missing column compare equal, as SQL's `IS NOT DISTINCT FROM NULL`.
    const same = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) =>
      a === null || a === undefined || b === null || b === undefined
        ? (a ?? null) === (b ?? null)
        : Buffer.from(a).equals(b);
    if (
      row === undefined ||
      row.kekId !== change.previous.kekId ||
      !Object.entries(change.previous.ciphertexts).every(([column, value]) =>
        same(row.ciphertexts[column], value),
      )
    ) {
      return Promise.resolve(false);
    }
    Object.assign(row.ciphertexts, change.ciphertexts);
    row.kekId = change.kekId;
    return Promise.resolve(true);
  }

  countNotUnder(_schema: TenantSchema, _source: CiphertextSource, currentKekId: string) {
    return Promise.resolve(
      sortedCounts(
        [...this.rows.entries()]
          .filter(([id]) => this.pending(id, currentKekId))
          .map(([, row]) => [row.kekId, 1] as const),
      ),
    );
  }

  /** Every row as hex text, to compare before and after. */
  snapshot(): Array<[string, string, Record<string, string | null>]> {
    return [...this.rows].map(([id, row]) => [
      id,
      row.kekId,
      Object.fromEntries(
        Object.entries(row.ciphertexts).map(([column, value]) => [column, value?.toString("hex") ?? null]),
      ),
    ]);
  }

  private pending(id: string, currentKekId: string): boolean {
    const row = this.rows.get(id) as StoredRow;
    return row.kekId !== currentKekId && Object.values(row.ciphertexts).some((value) => value !== null);
  }
}

/** A traveller row `id` with its documents (and discount entries) sealed under `keys` at their place. */
async function travelerRow(
  store: MemoryStore,
  id: string,
  keys: LocalFileKeyProvider,
  values: { documents?: string; discounts?: string },
): Promise<void> {
  const seal = async (column: string, value: string | undefined) =>
    value === undefined
      ? null
      : (await encryptValue(value, { aad: aadFor(SCHEMA, TRAVELERS.table, column, id), keys })).ciphertext;
  store.rows.set(id, {
    kekId: keys.currentKekId(),
    ciphertexts: {
      [DOCUMENTS]: await seal(DOCUMENTS, values.documents),
      [DISCOUNTS]: await seal(DISCOUNTS, values.discounts),
    },
  });
}

/** A logger that keeps what it is given. */
function memoryLogger(): {
  lines: Array<{ fields: Record<string, unknown>; message: string }>;
  info: (f: Record<string, unknown>, m: string) => void;
} {
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
  return { lines, info: (fields, message) => void lines.push({ fields: { ...fields }, message }) };
}

describe("rewrapArgumentsOf", () => {
  it("[OBE-100 AC1] takes every tenant schema, writes and pages by 500 without arguments", () => {
    expect(rewrapArgumentsOf([])).toEqual({ target: { kind: "all" }, dryRun: false, batchSize: 500 });
    expect(rewrapArgumentsOf(["--all"])).toEqual({ target: { kind: "all" }, dryRun: false, batchSize: 500 });
  });

  it("[OBE-100 AC1] reads --tenant, --dry-run and --batch-size in both spellings", () => {
    expect(rewrapArgumentsOf(["--tenant", "alpha", "--dry-run", "--batch-size", "25"])).toEqual({
      target: { kind: "tenant", key: "alpha" },
      dryRun: true,
      batchSize: 25,
    });
    expect(rewrapArgumentsOf(["--batch-size=10000", "--tenant=demo_2", "--all"])).toBeUndefined();
    expect(rewrapArgumentsOf(["--batch-size=10000", "--tenant=demo_2"])).toEqual({
      target: { kind: "tenant", key: "demo_2" },
      dryRun: false,
      batchSize: 10_000,
    });
    expect(rewrapArgumentsOf(["--all", "--batch-size", "1"])).toMatchObject({ batchSize: 1 });
  });

  it("[OBE-100 AC1] refuses anything else", () => {
    for (const args of [
      ["--tenant", "alpha", "--all"],
      ["--all", "--all"],
      ["--dry-run", "--dry-run"],
      ["--dry-run=yes"],
      ["--all=1"],
      ["--tenant"],
      ["--tenant", "Alpha"],
      ["--tenant", "a"],
      ["--tenant=alpha", "--tenant=beta"],
      ["--batch-size", "0"],
      ["--batch-size", "10001"],
      ["--batch-size", "050"],
      ["--batch-size", "1e3"],
      ["--batch-size"],
      ["--batch-size", "5", "--batch-size", "6"],
      ["--force"],
      ["alpha"],
    ]) {
      expect([args, rewrapArgumentsOf(args)]).toEqual([args, undefined]);
    }
  });
});

describe("rewrapSource", () => {
  it("[OBE-100 AC1] moves every row of a table to the current KEK and counts it before and after", async () => {
    const store = new MemoryStore();
    await travelerRow(store, "ctr_01", v1, { documents: "P1234567", discounts: "RC-1" });
    await travelerRow(store, "ctr_02", v1, { discounts: "RC-2" });
    await travelerRow(store, "ctr_03", v2, { documents: "P7654321" });
    await travelerRow(store, "ctr_04", v1, {});
    const logger = memoryLogger();

    const outcome = await rewrapSource({
      store,
      schema: SCHEMA,
      source: TRAVELERS,
      keys: v2,
      batchSize: 1,
      dryRun: false,
      logger,
    });

    expect(outcome).toEqual({
      kind: "rewrapped",
      schema: SCHEMA,
      table: "checkout_travelers",
      before: { "local:v1": 2 },
      rewrapped: 2,
      skipped: 0,
      failed: 0,
      after: {},
    });
    for (const [id, row] of store.rows) {
      for (const [column, value] of Object.entries(row.ciphertexts)) {
        if (value !== null) {
          expect([id, envelopeKekId(value)]).toEqual([id, "local:v2"]);
          // Still at its own place: the associated data of its row and column.
          await expect(
            decryptValue(value, { aad: aadFor(SCHEMA, TRAVELERS.table, column, id), keys: v2 }),
          ).resolves.toBeInstanceOf(Buffer);
        }
      }
    }
    // Counts only, never a row id.
    expect(JSON.stringify(logger.lines)).not.toMatch(/ctr_/);
    expect(logger.lines.at(-1)).toEqual({
      fields: { rewrapped: 2, skipped: 0, failed: 0, remainingByKekId: {} },
      message: "secrets.rewrap.done",
    });
  });

  it("[OBE-100 AC1] writes nothing in a dry run, and tells what would move and what would fail", async () => {
    const store = new MemoryStore();
    await travelerRow(store, "ctr_01", v1, { documents: "P1234567" });
    await travelerRow(store, "ctr_02", v1, { documents: "P2345678" });
    // A value copied from another row does not authenticate at its place.
    (store.rows.get("ctr_02") as StoredRow).ciphertexts[DOCUMENTS] =
      (store.rows.get("ctr_01") as StoredRow).ciphertexts[DOCUMENTS] ?? null;
    const before = store.snapshot();

    const outcome = await rewrapSource({
      store,
      schema: SCHEMA,
      source: TRAVELERS,
      keys: v2,
      batchSize: 500,
      dryRun: true,
    });

    expect(outcome).toEqual({
      kind: "dry_run",
      schema: SCHEMA,
      table: "checkout_travelers",
      before: { "local:v1": 2 },
      wouldRewrap: 1,
      wouldFail: 1,
    });
    expect(store.updates).toBe(0);
    expect(store.snapshot()).toEqual(before);
  });

  it("[OBE-100 AC1] counts a value that does not authenticate as failed and leaves its row as it was", async () => {
    const store = new MemoryStore();
    await travelerRow(store, "ctr_01", v1, { documents: "P1234567" });
    const corrupted = Buffer.from((store.rows.get("ctr_01") as StoredRow).ciphertexts[DOCUMENTS] as Buffer);
    const last = corrupted.length - 1;
    corrupted.writeUInt8(corrupted.readUInt8(last) ^ 0x01, last);
    (store.rows.get("ctr_01") as StoredRow).ciphertexts[DOCUMENTS] = corrupted;

    const outcome = await rewrapSource({
      store,
      schema: SCHEMA,
      source: TRAVELERS,
      keys: v2,
      batchSize: 500,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ kind: "rewrapped", rewrapped: 0, failed: 1, after: { "local:v1": 1 } });
    expect((store.rows.get("ctr_01") as StoredRow).ciphertexts[DOCUMENTS]).toEqual(corrupted);
  });

  it("[OBE-100 AC2] stops the table on a database error and reports its class and code, never its message", async () => {
    const store = new MemoryStore();
    await travelerRow(store, "ctr_01", v1, { documents: "P1234567" });
    store.failure = Object.assign(new Error('canceling statement: value "P1234567" of ctr_01'), {
      code: "57014",
    });

    const outcome = await rewrapSource({
      store,
      schema: SCHEMA,
      source: TRAVELERS,
      keys: v2,
      batchSize: 500,
      dryRun: false,
    });

    expect(outcome).toEqual({
      kind: "stopped",
      schema: SCHEMA,
      table: "checkout_travelers",
      reason: "Error 57014",
    });
    expect(outcomeLine(outcome)).toBe(
      "secrets:rewrap: tenant_alpha.checkout_travelers: stopped (Error 57014); run the command again: it continues " +
        "with what is left",
    );
  });

  it("[OBE-100 AC2] names an error by its class and code only, node-postgres's DatabaseError by its class", () => {
    // node-postgres's DatabaseError sets `name` to the protocol message type, `error`.
    class DatabaseError extends Error {
      readonly code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = "error";
        this.code = code;
      }
    }
    expect(failureReason(new DatabaseError("duplicate key value (id)=(ctr_01)", "23505"))).toBe(
      "DatabaseError 23505",
    );
    expect(
      failureReason(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
      ),
    ).toBe("Error ECONNREFUSED");
    expect(failureReason(new TypeError("ctr_01 is not read as bytea"))).toBe("TypeError");
    expect(failureReason(Object.assign(new Error("m"), { code: "not a code: ctr_01" }))).toBe("Error");
    expect(failureReason("a thrown string with ctr_01")).toBe("Error");
  });
});

describe("the report", () => {
  const done = (overrides: Partial<Extract<TableOutcome, { kind: "rewrapped" }>> = {}): TableOutcome => ({
    kind: "rewrapped",
    schema: SCHEMA,
    table: "notifications",
    before: { "local:v1": 3 },
    rewrapped: 3,
    skipped: 0,
    failed: 0,
    after: {},
    ...overrides,
  });

  it("[OBE-100 AC1] formats the counts per KEK id in KEK id order, a row without a KEK id as (none)", () => {
    expect(formatKekCounts({})).toBe("{}");
    expect(formatKekCounts({ "local:v2": 1, "local:v10": 2, [NO_KEK_ID]: 1, "local:v1": 4 })).toBe(
      '{"(none)":1,"local:v1":4,"local:v10":2,"local:v2":1}',
    );
  });

  it("[OBE-100 AC1] reports per tenant and table the rows re-wrapped, skipped and failed and remainingByKekId before and after", () => {
    expect(outcomeLine(done({ skipped: 1, rewrapped: 2, after: { "local:v1": 1 } }))).toBe(
      'secrets:rewrap: tenant_alpha.notifications: rewrapped 2, skipped 1, failed 0; remainingByKekId before {"local:v1":3} after {"local:v1":1}',
    );
    expect(
      outcomeLine({
        kind: "dry_run",
        schema: SCHEMA,
        table: "idempotency_keys",
        before: { "local:v1": 2 },
        wouldRewrap: 2,
        wouldFail: 0,
      }),
    ).toBe(
      'secrets:rewrap: tenant_alpha.idempotency_keys: dry run: would re-wrap 2, would fail 0; remainingByKekId before {"local:v1":2}',
    );
  });

  it("[OBE-100 AC1] exits 0 only when nothing is left under an old KEK", () => {
    const beta = { schema: "tenant_beta" as TenantSchema };
    const clean = summaryOf(
      totalsOf([done(), done({ ...beta, before: { "local:v1": 1, "local:v0": 1 }, rewrapped: 2 })], 2),
      false,
      "local:v2",
    );
    expect(clean).toEqual({
      lines: [
        'secrets:rewrap: total of 2 tenant schema(s), 2 table(s): rewrapped 5, skipped 0, failed 0; remainingByKekId before {"local:v0":1,"local:v1":4} after {}',
        "secrets:rewrap: nothing is left under an old KEK: every value is under local:v2.",
      ],
      code: REWRAP_EXIT.done,
    });
    const remains = summaryOf(
      totalsOf([done({ rewrapped: 1, failed: 1, skipped: 1, after: { "local:v1": 2 } })], 1),
      false,
      "local:v2",
    );
    expect(remains.code).toBe(REWRAP_EXIT.remains);
    expect(remains.lines.at(-1)).toBe(
      "secrets:rewrap: 2 row(s) remain under an old KEK (1 failed, 1 skipped): keep the old key (master-key-rotation.md step 5).",
    );
    const stopped = summaryOf(
      totalsOf(
        [done(), { kind: "stopped", schema: SCHEMA, table: "idempotency_keys", reason: "Error 57P01" }],
        1,
      ),
      false,
      "local:v2",
    );
    expect(stopped).toEqual({
      lines: [
        'secrets:rewrap: total of 1 tenant schema(s), 2 table(s): rewrapped 3, skipped 0, failed 0; remainingByKekId before {"local:v1":3} after {}',
        "secrets:rewrap: 1 table(s) stopped before the end: run the command again.",
        "secrets:rewrap: nothing is left under an old KEK in the tables that ran to the end.",
      ],
      code: REWRAP_EXIT.remains,
    });
  });

  it("[OBE-100 AC1] sums a dry run, which exits 0 only when nothing is under an old KEK", () => {
    const dry: TableOutcome = {
      kind: "dry_run",
      schema: SCHEMA,
      table: "notifications",
      before: { "local:v1": 3 },
      wouldRewrap: 2,
      wouldFail: 1,
    };
    expect(summaryOf(totalsOf([dry], 1), true, "local:v2")).toEqual({
      lines: [
        'secrets:rewrap: total of 1 tenant schema(s), 1 table(s): dry run: would re-wrap 2, would fail 1; remainingByKekId before {"local:v1":3}',
        "secrets:rewrap: dry run: nothing was written; 2 row(s) would move to local:v2 and 1 would fail.",
      ],
      code: REWRAP_EXIT.remains,
    });
    const nothing: TableOutcome = { ...dry, before: {}, wouldRewrap: 0, wouldFail: 0 };
    expect(summaryOf(totalsOf([nothing], 1), true, "local:v2")).toEqual({
      lines: [
        "secrets:rewrap: total of 1 tenant schema(s), 1 table(s): dry run: would re-wrap 0, would fail 0; remainingByKekId before {}",
        "secrets:rewrap: dry run: nothing was written; nothing is under an old KEK.",
      ],
      code: REWRAP_EXIT.done,
    });
  });
});

describe("runSecretsRewrap", () => {
  function buffer(): { write(chunk: string): void; text(): string } {
    const chunks: string[] = [];
    return { write: (chunk) => void chunks.push(chunk), text: () => chunks.join("") };
  }

  async function run(args: string[], env: Record<string, string>) {
    const stdout = buffer();
    const stderr = buffer();
    const code = await runSecretsRewrap(args, { stdout, stderr, env });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("[OBE-100 AC1] refuses invalid arguments with exit code 2 before reading any configuration", async () => {
    // No variable is given: a command that went on would fail on the missing configuration, not with the usage.
    const { code, stdout, stderr } = await run(["--tenant", "alpha", "--all"], {});
    expect(code).toBe(REWRAP_EXIT.usage);
    expect(stdout).toBe("");
    expect(stderr).toContain(`secrets:rewrap: invalid arguments; nothing was re-wrapped.\n${REWRAP_USAGE}\n`);
  });

  it("[OBE-100 AC1] refuses to start when the current KEK cannot be loaded, before it connects", async () => {
    const env = {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      // Nothing listens there: a command that went on would report the tenant schemas as unreadable.
      DATABASE_URL: unreachableDatabaseUrl,
      MASTER_KEY_CURRENT: "local:v3",
    };
    const missing = await run([], { ...env, MASTER_KEY_DIR: keyFolder });
    expect(missing.code).toBe(REWRAP_EXIT.remains);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toMatch(
      /^secrets:rewrap: the master keys cannot be loaded \(.*master-v3\.key.*\); nothing was re-wrapped\.\n$/,
    );
    const empty = await run(["--dry-run"], {
      ...env,
      MASTER_KEY_DIR: emptyFolder,
      MASTER_KEY_CURRENT: "local:v1",
    });
    expect([empty.code, empty.stdout]).toEqual([REWRAP_EXIT.remains, ""]);
    expect(empty.stderr).toContain("the master keys cannot be loaded");
    const invalid = await run([], { APP_ENV: "test" });
    expect([invalid.code, invalid.stdout]).toEqual([REWRAP_EXIT.remains, ""]);
    expect(invalid.stderr).toContain("secrets:rewrap: the configuration is invalid:");
  });
});
