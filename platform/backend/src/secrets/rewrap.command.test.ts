// Unit tests of `secrets:rewrap` (PBE-072): its arguments, its report and its exit codes, the per-table run over an
// in-memory store with the semantics of rewrap.repository.ts's SQL (keyset pages, the optimistic check), and the
// refusals that come before any connection. The database itself is test/integration/secrets/rewrap.int.test.ts's.
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  decryptValue,
  encryptValue,
  envelopeKekId,
  LocalFileKeyProvider,
  type RewrapChange,
  type RewrapPage,
  type RewrapRow,
} from "@velexis/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestMasterKeyDir, type TestMasterKeyDir } from "../../test/support/master-key";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliContext } from "../cli";
import { associatedData } from "../common/crypto.provider";
import {
  failureReason,
  formatKekCounts,
  outcomeLine,
  REWRAP_ARGUMENTS,
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
  type KekCounts,
  type RewrapStore,
} from "./rewrap.repository";

const SUBMISSIONS = REWRAP_SOURCES.find(
  (source) => source.table === "credential_submissions",
) as CiphertextSource;
const [SECRET, WEBHOOK_SECRET] = SUBMISSIONS.columns as [string, string];

let keyFolder: TestMasterKeyDir;
let v1: LocalFileKeyProvider;
let v2: LocalFileKeyProvider;
/** A DATABASE_URL on a loopback port where nothing listens. */
let unreachableDatabaseUrl: string;

/** A loopback port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return address.port;
}

beforeAll(async () => {
  // The test folder holds master-v1.key; a second key makes the rotation from local:v1 to local:v2.
  keyFolder = createTestMasterKeyDir();
  const second = join(keyFolder.path, "master-v2.key");
  writeFileSync(second, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  chmodSync(second, 0o600);
  [v1, v2] = await Promise.all([
    LocalFileKeyProvider.fromDir(keyFolder.path, "local:v1"),
    LocalFileKeyProvider.fromDir(keyFolder.path, "local:v2"),
  ]);
  unreachableDatabaseUrl = `postgres://velexis_platform_app:unused@127.0.0.1:${await freePort()}/velexis`;
});

afterAll(() => {
  keyFolder.remove();
});

interface StoredRow {
  kekId: string | null;
  ciphertexts: Record<string, Buffer | null>;
}

/** A RewrapStore over a Map with the semantics of rewrap.repository.ts's SQL, for one source. */
class MemoryStore implements RewrapStore {
  readonly rows = new Map<string, StoredRow>();
  updates = 0;
  /** Runs before each update, as a concurrent writer would. */
  beforeUpdate: ((id: string) => void) | undefined;
  /** Makes every call fail, as a database outage would. */
  failure: Error | undefined;

  private holds(row: StoredRow): boolean {
    return Object.values(row.ciphertexts).some((value) => value !== null);
  }

  private check(): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  fetch(_source: CiphertextSource, page: RewrapPage): Promise<readonly RewrapRow[]> {
    this.check();
    const ids = [...this.rows.keys()]
      .filter((id) => page.afterId === null || id > page.afterId)
      .sort()
      .filter((id) => {
        const row = this.rows.get(id) as StoredRow;
        return row.kekId !== page.currentKekId && this.holds(row);
      })
      .slice(0, page.limit);
    return Promise.resolve(
      ids.map((id) => {
        const row = this.rows.get(id) as StoredRow;
        return { id, kekId: row.kekId ?? NO_KEK_ID, ciphertexts: { ...row.ciphertexts } };
      }),
    );
  }

  update(_source: CiphertextSource, change: RewrapChange): Promise<boolean> {
    this.check();
    this.beforeUpdate?.(change.id);
    const row = this.rows.get(change.id);
    const previousKekId = change.previous.kekId === NO_KEK_ID ? null : change.previous.kekId;
    const unchanged =
      row !== undefined &&
      row.kekId === previousKekId &&
      Object.entries(change.previous.ciphertexts).every(([column, value]) => {
        const stored = row.ciphertexts[column] ?? null;
        return value === null ? stored === null : stored !== null && stored.equals(value);
      });
    if (!unchanged) {
      return Promise.resolve(false);
    }
    this.updates += 1;
    Object.assign(row.ciphertexts, change.ciphertexts);
    row.kekId = change.kekId;
    return Promise.resolve(true);
  }

  countNotUnder(_source: CiphertextSource, currentKekId: string): Promise<KekCounts> {
    this.check();
    return Promise.resolve(
      sortedCounts(
        [...this.rows.values()]
          .filter((row) => row.kekId !== currentKekId && this.holds(row))
          .map((row) => [row.kekId ?? NO_KEK_ID, 1] as const),
      ),
    );
  }
}

/** The secret and the webhook secret of submission `id`, encrypted at their places under `keys`. */
async function submissionRow(
  id: string,
  keys: LocalFileKeyProvider,
  webhook = true,
): Promise<{ row: StoredRow; plaintexts: string[] }> {
  const secret = `sk_test_${id}_secret`;
  const hook = `whsec_${id}_secret`;
  const sealed = await encryptValue(secret, {
    aad: associatedData({ table: SUBMISSIONS.table, column: SECRET, rowId: id }),
    keys,
  });
  const sealedHook = webhook
    ? await encryptValue(hook, {
        aad: associatedData({ table: SUBMISSIONS.table, column: WEBHOOK_SECRET, rowId: id }),
        keys,
      })
    : undefined;
  return {
    row: {
      kekId: sealed.kekId,
      ciphertexts: { [SECRET]: sealed.ciphertext, [WEBHOOK_SECRET]: sealedHook?.ciphertext ?? null },
    },
    plaintexts: webhook ? [secret, hook] : [secret],
  };
}

/** The ids of the rows in `store` that come from the run's own values, as a leak check needs them. */
function idsOf(store: MemoryStore): string[] {
  return [...store.rows.keys()];
}

describe("rewrapArgumentsOf", () => {
  it("takes --dry-run and --batch-size, with 500 rows per page by default [PBE-072 AC1]", () => {
    expect(rewrapArgumentsOf([])).toEqual({ dryRun: false, batchSize: 500 });
    expect(rewrapArgumentsOf(["--dry-run"])).toEqual({ dryRun: true, batchSize: 500 });
    expect(rewrapArgumentsOf(["--batch-size", "2", "--dry-run"])).toEqual({ dryRun: true, batchSize: 2 });
    expect(rewrapArgumentsOf(["--batch-size=10000"])).toEqual({ dryRun: false, batchSize: 10_000 });
  });

  it("refuses unknown, repeated and malformed arguments [PBE-072 AC1]", () => {
    for (const args of [
      ["--all"],
      ["--tenant", "demo"],
      ["now"],
      ["--dry-run", "--dry-run"],
      ["--dry-run=yes"],
      ["--batch-size"],
      ["--batch-size", "0"],
      ["--batch-size", "10001"],
      ["--batch-size", "-1"],
      ["--batch-size", "1e3"],
      ["--batch-size=", "5"],
      ["--batch-size", "5", "--batch-size", "6"],
    ]) {
      expect(rewrapArgumentsOf(args), args.join(" ")).toBeUndefined();
    }
  });
});

describe("the report", () => {
  const done: TableOutcome = {
    kind: "rewrapped",
    table: "platform.accounts",
    before: { "local:v1": 3, [NO_KEK_ID]: 1 },
    rewrapped: 4,
    skipped: 0,
    failed: 0,
    after: {},
  };

  it("prints counts by KEK id in KEK id order, a row without a key id as (none) [PBE-072 AC1]", () => {
    expect(formatKekCounts({ "local:v3": 1, "local:v1": 2, [NO_KEK_ID]: 4 })).toBe(
      '{"(none)":4,"local:v1":2,"local:v3":1}',
    );
    expect(formatKekCounts({})).toBe("{}");
  });

  it("gives one line per table: re-wrapped, skipped and failed, and remainingByKekId before and after [PBE-072 AC1]", () => {
    expect(outcomeLine(done)).toBe(
      "secrets:rewrap: platform.accounts: rewrapped 4, skipped 0, failed 0; " +
        'remainingByKekId before {"(none)":1,"local:v1":3} after {}',
    );
    expect(
      outcomeLine({
        kind: "dry_run",
        table: "platform.email_outbox",
        before: { "local:v1": 2 },
        wouldRewrap: 1,
        wouldFail: 1,
      }),
    ).toBe(
      'secrets:rewrap: platform.email_outbox: dry run: would re-wrap 1, would fail 1; remainingByKekId before {"local:v1":2}',
    );
    expect(outcomeLine({ kind: "stopped", table: "platform.accounts", reason: "DatabaseError 57P01" })).toBe(
      "secrets:rewrap: platform.accounts: stopped (DatabaseError 57P01); run the command again: it continues with what is left",
    );
  });

  it("exits 0 when nothing is left under an old KEK [PBE-072 AC1]", () => {
    const summary = summaryOf(totalsOf([done]), false, "local:v2");

    expect(summary.code).toBe(EXIT_OK);
    expect(summary.lines).toEqual([
      "secrets:rewrap: total of 1 table(s): rewrapped 4, skipped 0, failed 0; " +
        'remainingByKekId before {"(none)":1,"local:v1":3} after {}',
      "secrets:rewrap: nothing is left under an old KEK: every value is under local:v2.",
    ]);
  });

  it("exits 1 when a row failed or remains, and when a table stopped [PBE-072 AC1]", () => {
    const remains: TableOutcome = {
      kind: "rewrapped",
      table: "platform.email_outbox",
      before: { "local:v1": 3 },
      rewrapped: 1,
      skipped: 1,
      failed: 1,
      after: { "local:v1": 2 },
    };
    const failedRun = summaryOf(totalsOf([done, remains]), false, "local:v2");

    expect(failedRun.code).toBe(EXIT_FAILED);
    expect(failedRun.lines).toEqual([
      "secrets:rewrap: total of 2 table(s): rewrapped 5, skipped 1, failed 1; " +
        'remainingByKekId before {"(none)":1,"local:v1":6} after {"local:v1":2}',
      "secrets:rewrap: 2 row(s) remain under an old KEK (1 failed, 1 skipped): keep the old key " +
        "(master-key-rotation.md step 5).",
    ]);

    const stopped = summaryOf(
      totalsOf([done, { kind: "stopped", table: "platform.email_outbox", reason: "Error ECONNREFUSED" }]),
      false,
      "local:v2",
    );
    expect(stopped.code).toBe(EXIT_FAILED);
    expect(stopped.lines.slice(1)).toEqual([
      "secrets:rewrap: 1 table(s) stopped before the end: run the command again.",
      "secrets:rewrap: nothing is left under an old KEK in the tables that ran to the end.",
    ]);
  });

  it("reports a dry run's counts before and what would move; exit 0 only when nothing is under an old KEK [PBE-072 AC1]", () => {
    const pending = summaryOf(
      totalsOf([
        {
          kind: "dry_run",
          table: "platform.accounts",
          before: { "local:v1": 2 },
          wouldRewrap: 1,
          wouldFail: 1,
        },
      ]),
      true,
      "local:v2",
    );
    expect(pending.code).toBe(EXIT_FAILED);
    expect(pending.lines).toEqual([
      'secrets:rewrap: total of 1 table(s): dry run: would re-wrap 1, would fail 1; remainingByKekId before {"local:v1":2}',
      "secrets:rewrap: dry run: nothing was written; 1 row(s) would move to local:v2 and 1 would fail.",
    ]);

    const nothing = summaryOf(
      totalsOf([{ kind: "dry_run", table: "platform.accounts", before: {}, wouldRewrap: 0, wouldFail: 0 }]),
      true,
      "local:v2",
    );
    expect(nothing.code).toBe(EXIT_OK);
    expect(nothing.lines[1]).toBe(
      "secrets:rewrap: dry run: nothing was written; nothing is under an old KEK.",
    );

    // A table that stopped was not counted: the verdict speaks of the others only, and the exit code is 1.
    const stopped = summaryOf(
      totalsOf([
        { kind: "dry_run", table: "platform.accounts", before: {}, wouldRewrap: 0, wouldFail: 0 },
        { kind: "stopped", table: "platform.email_outbox", reason: "DatabaseError 57P01" },
      ]),
      true,
      "local:v2",
    );
    expect(stopped.code).toBe(EXIT_FAILED);
    expect(stopped.lines.slice(1)).toEqual([
      "secrets:rewrap: 1 table(s) stopped before the end: run the command again.",
      "secrets:rewrap: dry run: nothing was written; nothing is under an old KEK in the tables that ran to the end.",
    ]);
  });

  it("names an error by its class and code, never by its message [PBE-072 AC2]", () => {
    // As node-postgres's DatabaseError (pg-protocol): `name` is the protocol message type, `error`.
    class DatabaseError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "error";
      }
    }
    const database = Object.assign(new DatabaseError('Failing row contains (crs_01J…, \\x01…, "secret").'), {
      code: "23514",
    });
    expect(failureReason(database)).toBe("DatabaseError 23514");
    expect(
      failureReason(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
      ),
    ).toBe("Error ECONNREFUSED");
    expect(failureReason(new TypeError("value acc_01J… is wrong"))).toBe("TypeError");
    expect(failureReason("a plain string with a secret")).toBe("Error");
    expect(failureReason(Object.assign(new Error("x"), { code: "not a code: secret" }))).toBe("Error");
  });
});

describe("rewrapSource over an in-memory store", () => {
  it("moves every row to the current KEK, values of one row together, and a second run moves nothing [PBE-072 AC1]", async () => {
    const store = new MemoryStore();
    const plaintexts: string[] = [];
    for (const [id, keys, webhook] of [
      ["crs_a", v1, true],
      ["crs_b", v2, true],
      ["crs_c", v1, false],
      ["crs_d", v1, true],
    ] as const) {
      const made = await submissionRow(id, keys, webhook);
      store.rows.set(id, made.row);
      plaintexts.push(...made.plaintexts);
    }
    // A row whose values are under local:v1 but whose key id was never written (accounts has no CHECK against it).
    const unnamed = await submissionRow("crs_e", v1);
    store.rows.set("crs_e", { ...unnamed.row, kekId: null });
    plaintexts.push(...unnamed.plaintexts);
    // A finished submission: its key id stays, its ciphertexts are erased; it holds nothing to re-wrap.
    store.rows.set("crs_f", { kekId: "local:v1", ciphertexts: { [SECRET]: null, [WEBHOOK_SECRET]: null } });
    const lines: string[] = [];
    const logger = {
      info: (fields: object, message: string) => lines.push(JSON.stringify({ fields, message })),
    };

    const first = await rewrapSource({
      store,
      source: SUBMISSIONS,
      keys: v2,
      batchSize: 2,
      dryRun: false,
      logger,
    });

    expect(first).toEqual({
      kind: "rewrapped",
      table: "platform.credential_submissions",
      before: { [NO_KEK_ID]: 1, "local:v1": 3 },
      rewrapped: 4,
      skipped: 0,
      failed: 0,
      after: {},
    });
    for (const [id, row] of store.rows) {
      if (id === "crs_f") {
        expect(row).toEqual({ kekId: "local:v1", ciphertexts: { [SECRET]: null, [WEBHOOK_SECRET]: null } });
        continue;
      }
      expect(row.kekId, id).toBe("local:v2");
      for (const [column, value] of Object.entries(row.ciphertexts)) {
        if (value === null) {
          expect(`${id}.${column}`).toBe("crs_c.webhook_secret_ciphertext");
          continue;
        }
        expect(envelopeKekId(value), `${id}.${column}`).toBe("local:v2");
        // The value still opens at its own place, now with the new KEK.
        const plaintext = await decryptValue(value, {
          aad: associatedData({ table: SUBMISSIONS.table, column, rowId: id }),
          keys: v2,
        });
        expect(plaintexts).toContain(plaintext.toString("utf8"));
      }
    }
    const written = store.updates;

    const second = await rewrapSource({ store, source: SUBMISSIONS, keys: v2, batchSize: 2, dryRun: false });

    expect(second).toMatchObject({ rewrapped: 0, skipped: 0, failed: 0, before: {}, after: {} });
    expect(store.updates).toBe(written);
    // rewrapBatch's per-page and final log lines: counts and KEK ids only.
    const logged = lines.join("\n");
    expect(logged).toContain("secrets.rewrap.done");
    for (const secret of [...plaintexts, ...idsOf(store)]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("leaves a corrupted and a copied value unchanged and counts them as failed [PBE-072 AC1]", async () => {
    const store = new MemoryStore();
    const good = await submissionRow("crs_a", v1);
    const corrupted = await submissionRow("crs_b", v1);
    const tampered = Buffer.from(corrupted.row.ciphertexts[SECRET] as Buffer);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    store.rows.set("crs_a", good.row);
    store.rows.set("crs_b", {
      ...corrupted.row,
      ciphertexts: { ...corrupted.row.ciphertexts, [SECRET]: tampered },
    });
    // crs_a's own ciphertext copied to crs_c: it does not authenticate at crs_c's place.
    store.rows.set("crs_c", { kekId: "local:v1", ciphertexts: { ...good.row.ciphertexts } });
    const copied = { ...(store.rows.get("crs_c") as StoredRow).ciphertexts };

    const outcome = await rewrapSource({
      store,
      source: SUBMISSIONS,
      keys: v2,
      batchSize: 500,
      dryRun: false,
    });

    expect(outcome).toEqual({
      kind: "rewrapped",
      table: "platform.credential_submissions",
      before: { "local:v1": 3 },
      rewrapped: 1,
      skipped: 0,
      failed: 2,
      after: { "local:v1": 2 },
    });
    expect(store.rows.get("crs_b")).toEqual({
      kekId: "local:v1",
      ciphertexts: { ...corrupted.row.ciphertexts, [SECRET]: tampered },
    });
    expect(store.rows.get("crs_c")).toEqual({ kekId: "local:v1", ciphertexts: copied });
  });

  it("skips a row changed between the read and the write and keeps the other writer's value [PBE-072 AC1]", async () => {
    const store = new MemoryStore();
    for (const id of ["crs_a", "crs_b"]) {
      store.rows.set(id, (await submissionRow(id, v1)).row);
    }
    const newer = (await submissionRow("crs_a", v2)).row;
    store.beforeUpdate = (id) => {
      if (id === "crs_a") {
        // The owner entered the secret again meanwhile: the writer wrote it under the current KEK.
        store.rows.set("crs_a", { kekId: newer.kekId, ciphertexts: { ...newer.ciphertexts } });
      }
    };

    const outcome = await rewrapSource({
      store,
      source: SUBMISSIONS,
      keys: v2,
      batchSize: 500,
      dryRun: false,
    });

    expect(outcome).toMatchObject({ rewrapped: 1, skipped: 1, failed: 0, after: {} });
    expect(store.rows.get("crs_a")).toEqual({ kekId: newer.kekId, ciphertexts: newer.ciphertexts });
  });

  it("checks and counts in a dry run, and writes nothing [PBE-072 AC1]", async () => {
    const store = new MemoryStore();
    store.rows.set("crs_a", (await submissionRow("crs_a", v1)).row);
    const bad = (await submissionRow("crs_b", v1)).row;
    store.rows.set("crs_b", {
      kekId: bad.kekId,
      ciphertexts: { ...bad.ciphertexts, [SECRET]: randomBytes(120) },
    });
    const before = structuredClone([...store.rows]);

    const outcome = await rewrapSource({ store, source: SUBMISSIONS, keys: v2, batchSize: 1, dryRun: true });

    expect(outcome).toEqual({
      kind: "dry_run",
      table: "platform.credential_submissions",
      before: { "local:v1": 2 },
      wouldRewrap: 1,
      wouldFail: 1,
    });
    expect(store.updates).toBe(0);
    expect(structuredClone([...store.rows])).toEqual(before);
  });

  it("stops the table on a database error and reports only its class and code [PBE-072 AC2]", async () => {
    const store = new MemoryStore();
    store.rows.set("crs_a", (await submissionRow("crs_a", v1)).row);
    store.failure = Object.assign(new Error("Failing row contains (crs_a, \\x0108…)"), {
      name: "DatabaseError",
      code: "57P01",
    });

    const outcome = await rewrapSource({
      store,
      source: SUBMISSIONS,
      keys: v2,
      batchSize: 500,
      dryRun: false,
    });

    expect(outcome).toEqual({
      kind: "stopped",
      table: "platform.credential_submissions",
      reason: "DatabaseError 57P01",
    });
    expect(outcomeLine(outcome)).not.toContain("crs_a");
  });
});

describe("the sources", () => {
  it("cover every platform ciphertext column set of platform-operations.md §8, each with its key id column [PBE-072 AC1]", () => {
    expect(
      REWRAP_SOURCES.map((source) => [
        source.table,
        source.idColumn,
        source.kekIdColumn,
        source.columns.join(","),
      ]),
    ).toEqual([
      ["accounts", "id", "encryption_key_id", "mfa_secret_ciphertext"],
      ["amadeus_accounts", "id", "encryption_key_id", "client_secret_ciphertext"],
      ["supplier_connections", "id", "encryption_key_id", "client_secret_ciphertext"],
      [
        "payment_provider_connections",
        "id",
        "encryption_key_id",
        "secret_ciphertext,webhook_secret_ciphertext",
      ],
      ["credential_submissions", "id", "encryption_key_id", "secret_ciphertext,webhook_secret_ciphertext"],
      ["tenant_payout_accounts", "tenant_id", "encryption_key_id", "bank_details_ciphertext"],
      ["email_outbox", "id", "encryption_key_id", "secret_payload_ciphertext"],
      ["provisioning_jobs", "id", "reveal_encryption_key_id", "reveal_ciphertext"],
    ]);
    expect(Object.isFrozen(REWRAP_SOURCES)).toBe(true);
  });
});

describe("runSecretsRewrap: refusals before any connection", () => {
  /** stdout and stderr as strings, and the context of a run with `env`. */
  function run(args: readonly string[], env: Record<string, string>) {
    const output = { stdout: "", stderr: "" };
    const context: CliContext = {
      stdout: { write: (text: string) => (output.stdout += text) },
      stderr: { write: (text: string) => (output.stderr += text) },
      env,
      commands: [],
    };
    return { output, done: runSecretsRewrap(args, context) };
  }

  const env = (overrides: Record<string, string> = {}): Record<string, string> => ({
    APP_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL: unreachableDatabaseUrl,
    MASTER_KEY_DIR: keyFolder.path,
    MASTER_KEY_CURRENT: "local:v2",
    ...overrides,
  });

  it("answers a usage error without echoing the argument [PBE-072 AC2]", async () => {
    const { output, done } = run(["Secret-Value 1!"], env());

    expect(await done).toBe(EXIT_USAGE);
    expect(output.stderr).toContain("secrets:rewrap: invalid arguments; nothing was re-wrapped.");
    expect(output.stderr).toContain(REWRAP_USAGE);
    expect(REWRAP_USAGE).toBe(`Usage: node dist/cli.js secrets:rewrap ${REWRAP_ARGUMENTS}`);
    expect(output.stderr).not.toContain("Secret-Value");
    expect(output.stdout).toBe("");
  });

  it("refuses an invalid configuration, naming the variable and never its value [PBE-072 AC2]", async () => {
    const { output, done } = run([], env({ MASTER_KEY_CURRENT: "v2-secret-looking-value" }));

    expect(await done).toBe(EXIT_FAILED);
    expect(output.stderr).toMatch(/^secrets:rewrap: the configuration is invalid:\n[^]*MASTER_KEY_CURRENT/);
    expect(output.stderr).not.toContain("v2-secret-looking-value");
    expect(output.stdout).toBe("");
  });

  it("refuses to start when the current KEK cannot be loaded, before it connects [PBE-072 AC1]", async () => {
    const { output, done } = run(["--dry-run"], env({ MASTER_KEY_CURRENT: "local:v3" }));

    expect(await done).toBe(EXIT_FAILED);
    expect(output.stderr).toMatch(
      /^secrets:rewrap: the master keys cannot be loaded \(.*master-v3\.key.*\); nothing was re-wrapped\.\n$/,
    );
    // Nothing was printed on stdout and no connection was tried (that would have been ECONNREFUSED on stderr).
    expect(output.stdout).toBe("");
    expect(output.stderr).not.toContain("ECONNREFUSED");
  });

  it("reports every table as stopped by its error code when the database cannot be reached [PBE-072 AC2]", async () => {
    const { output, done } = run([], env());

    expect(await done).toBe(EXIT_FAILED);
    const lines = output.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "secrets:rewrap: current KEK local:v2 (loaded: local:v1, local:v2); 8 platform table(s).",
    );
    expect(lines.slice(1, 9)).toEqual(
      REWRAP_SOURCES.map(
        (source) =>
          `secrets:rewrap: platform.${source.table}: stopped (Error ECONNREFUSED); run the command again: ` +
          "it continues with what is left",
      ),
    );
    expect(lines.slice(9)).toEqual([
      "secrets:rewrap: total of 8 table(s): rewrapped 0, skipped 0, failed 0; remainingByKekId before {} after {}",
      "secrets:rewrap: 8 table(s) stopped before the end: run the command again.",
      "secrets:rewrap: nothing is left under an old KEK in the tables that ran to the end.",
    ]);
    // The error lines carry the table and the reason, not the connection string.
    expect(output.stderr).toContain("secrets.rewrap.stopped");
    expect(output.stderr).not.toContain("unused@");
  });
});
