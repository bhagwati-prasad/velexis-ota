// `secrets:rewrap` of dist/cli.js (PBE-072; ADR-0010 "Rotation" item 3, docs/mvp/runbooks/master-key-rotation.md steps
// 5 and 7, platform/docs/runbooks/platform-operations.md §8) on a @velexis/testing clone, as velexis_platform_app, with
// values under `local:v1` and `local:v2` in every platform ciphertext column set, each sealed by its writer's own place
// (the place functions of the modules that write them):
//
// - `--dry-run` checks and counts every value and changes nothing;
// - a run moves every value to the current KEK (`local:v2`), values of one row together, sets the key id of a row that
//   had none, and changes nothing else of any row (not `version`, not `updated_at`); every value then decrypts at its
//   place with a key folder that holds `master-v2.key` alone;
// - a second run reports `rewrapped 0` and empty `remainingByKekId` everywhere (idempotent) and exits 0;
// - a row changed by another writer between the read and the write is skipped and keeps that writer's value (a new
//   value under either KEK, or the key id alone, so both halves of the optimistic check are proven);
// - a corrupted ciphertext and one copied from another row count as failed and stay as they were, and the run exits 1;
// - a table whose writes PostgreSQL refuses (velexis_migrator revokes UPDATE for one run) stops with the error's class
//   and code only, the run goes on past it and exits 1, and the next run continues with what is left;
// - the sources are every `*_ciphertext` column of the platform schema (the catalog), so a new one fails this test;
// - nothing the command prints or logs (LOG_LEVEL=debug, so rewrapBatch's per-page lines too) holds a plaintext, a
//   ciphertext or a row id.
//
// The command runs in-process through `runCli` (the dispatcher of dist/cli.js) with this file's configuration
// (`CliOptions.env`), as `node dist/cli.js secrets:rewrap` runs it: `pnpm test:int` runs before the build, so the
// compiled file is not used here. It needs PostgreSQL only (no Redis). Every run happens in a setup hook with an
// explicit bound; the tests then check what happened.
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptValue, envelopeKekId, LocalFileKeyProvider, type KeyProvider } from "@velexis/crypto";
import { createPlatformDb, createPool } from "@velexis/db";
import { createLogger } from "@velexis/logger";
import { createTestDatabase, type TestDatabase } from "@velexis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountSecretPlace } from "../../../src/accounts/mfa.service";
import { EXIT_FAILED, EXIT_OK, runCli } from "../../../src/cli";
import {
  secretPlace,
  SECRET_COLUMNS,
} from "../../../src/common/credentials/credential-submissions.repository";
import { associatedData, EnvelopeService, type CiphertextPlace } from "../../../src/common/crypto.provider";
import { secretPayloadPlace } from "../../../src/notifications/outbox.service";
import {
  connectionSecretPlace as stripeSecretPlace,
  connectionWebhookSecretPlace as stripeWebhookSecretPlace,
} from "../../../src/payment-connections/stripe-api-keys.verifier";
import { revealPlace } from "../../../src/provisioning/post-steps/issue-api-keys.step";
import { rewrapSource } from "../../../src/secrets/rewrap.command";
import {
  REWRAP_SOURCES,
  RewrapRepository,
  type CiphertextSource,
  type RewrapStore,
} from "../../../src/secrets/rewrap.repository";
import { bankDetailsPlace } from "../../../src/settlements/payout-accounts.service";
import { connectionSecretPlace as amadeusConnectionSecretPlace } from "../../../src/supplier-connections/amadeus-credentials.verifier";
import { clientSecretPlace } from "../../../src/supplier-connections/verification.processor";
import {
  insertAccount,
  insertAmadeusAccount,
  insertEmailOutbox,
  insertPaymentConnection,
  insertRow,
  insertSupplierConnection,
  insertTenant,
  platformTable,
  testId,
  velexisSource,
  type PlatformRow,
  type PlatformTable,
} from "../../builders/platform-rows";
import { LogSink } from "../../support/app";
import { createTestMasterKeyDir, type TestMasterKeyDir } from "../../support/master-key";

/** A clone, the key folders and the arrangement of every table: a second or two; bounded for a loaded CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's runs of the command (a few dozen rows each): well under a second each; bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;

type Pool = ReturnType<typeof createPool>;

let db: TestDatabase;
let pool: Pool;
let keyFolder: TestMasterKeyDir;
/** A folder with a copy of `master-v2.key` alone: what step 8 of the runbook leaves. */
let v2OnlyFolder: string;
let v1: KeyProvider;
let v2: KeyProvider;
let v2Only: KeyProvider;
let sealV1: EnvelopeService;
let sealV2: EnvelopeService;

/** One value the arrangement wrote: where it is, what it holds and the place its writer sealed it with. */
interface StoredValue {
  readonly table: PlatformTable;
  readonly idColumn: string;
  readonly rowId: string;
  readonly column: string;
  readonly plaintext: string;
  readonly place: CiphertextPlace;
}

/** Every value of the arrangement, every row id of it, and every ciphertext the command saw or wrote. */
const values: StoredValue[] = [];
const rowIds = new Set<string>();
const ciphertexts: Buffer[] = [];
/** Everything the command printed and logged in this file. */
const output: string[] = [];

/** What a CLI run wrote and answered. */
interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The configuration of the runs: this file's clone, the key folder, the new KEK current, the per-page logs. */
function cliEnv(): Record<string, string> {
  return {
    APP_ENV: "test",
    LOG_LEVEL: "debug",
    DATABASE_URL: db.urlFor("platform"),
    MASTER_KEY_DIR: keyFolder.path,
    MASTER_KEY_CURRENT: "local:v2",
  };
}

/** Runs `node dist/cli.js secrets:rewrap <args>` in-process and keeps what it wrote for the leak check. */
async function rewrap(...args: string[]): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["secrets:rewrap", ...args], {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env: cliEnv(),
  });
  output.push(stdout, stderr);
  return { code, stdout, stderr };
}

/** A plaintext nobody else holds, so the leak check can look for it. */
function plaintextFor(table: string, column: string): string {
  return `plain-${table}-${column}-${randomBytes(12).toString("hex")}`;
}

/**
 * Seals a new plaintext at `place` with `seal` and records it. The caller writes `ciphertext` and `kekId` into the row.
 */
async function seal(
  envelope: EnvelopeService,
  table: PlatformTable,
  rowId: string,
  column: string,
  place: CiphertextPlace,
  idColumn = "id",
): Promise<{ ciphertext: Buffer; kekId: string }> {
  const plaintext = plaintextFor(table, column);
  const sealed = await envelope.encrypt(plaintext, place);
  values.push({ table, idColumn, rowId, column, plaintext, place });
  rowIds.add(rowId);
  ciphertexts.push(sealed.ciphertext);
  return sealed;
}

/** Every row of `table` as JSON (bytea as `\x…` hex), keyed by its id column. */
async function rowsOf(table: PlatformTable, idColumn: string): Promise<Map<string, Record<string, unknown>>> {
  const { rows } = await pool.query(
    `SELECT ${idColumn} AS row_id, to_jsonb(t) AS row FROM ${platformTable(table)} t ORDER BY ${idColumn}`,
  );
  return new Map(
    (rows as Array<{ row_id: string; row: Record<string, unknown> }>).map((row) => [row.row_id, row.row]),
  );
}

/** Every row of every source table. */
async function snapshot(): Promise<Record<string, Map<string, Record<string, unknown>>>> {
  const tables: Record<string, Map<string, Record<string, unknown>>> = {};
  for (const source of REWRAP_SOURCES) {
    tables[source.table] = await rowsOf(source.table as PlatformTable, source.idColumn);
  }
  return tables;
}

/** The source of `table`. */
function sourceOf(table: string): CiphertextSource {
  const found = REWRAP_SOURCES.find((source) => source.table === table);
  if (found === undefined) {
    throw new Error(`no source for ${table}`);
  }
  return found;
}

/** The stored ciphertext of one value, or `null`. */
async function storedCiphertext(value: StoredValue): Promise<Buffer | null> {
  const { rows } = await pool.query(
    `SELECT ${value.column} AS value FROM ${platformTable(value.table)} WHERE ${value.idColumn} = $1`,
    [value.rowId],
  );
  return ((rows[0] as { value: Buffer | null } | undefined)?.value ?? null) as Buffer | null;
}

/** The key id of a row of `table`. */
async function storedKekId(table: string, rowId: string): Promise<string | null> {
  const source = sourceOf(table);
  const { rows } = await pool.query(
    `SELECT ${source.kekIdColumn} AS kek_id FROM ${platformTable(table as PlatformTable)} ` +
      `WHERE ${source.idColumn} = $1`,
    [rowId],
  );
  return (rows[0] as { kek_id: string | null }).kek_id;
}

// ---- The arrangement: every table, values under local:v1 and local:v2, rows without a value ------------------------

/** Per table: rows under local:v1, rows under local:v2, a row without a key id, rows without any ciphertext. */
const arranged: Record<string, { v1: number; v2: number; none?: number; empty: number }> = {};

async function arrange(): Promise<void> {
  const tenants: Array<PlatformRow<"tenants">> = [];
  for (let n = 0; n < 4; n += 1) {
    tenants.push(await insertTenant(pool));
  }
  const [t1, t2, t3, t4] = tenants as [
    PlatformRow<"tenants">,
    PlatformRow<"tenants">,
    PlatformRow<"tenants">,
    PlatformRow<"tenants">,
  ];
  for (const tenant of tenants) {
    rowIds.add(tenant.id);
  }

  // accounts: MFA secrets under v1 (three), v2 (one), one without a key id (no CHECK forbids it), one without MFA.
  for (const [envelope, n] of [
    [sealV1, 3],
    [sealV2, 1],
  ] as const) {
    for (let index = 0; index < n; index += 1) {
      const account = await insertAccount(pool, { mfa_enabled: true });
      const sealed = await seal(
        envelope,
        "accounts",
        account.id,
        "mfa_secret_ciphertext",
        accountSecretPlace(account.id),
      );
      await pool.query(
        "UPDATE platform.accounts SET mfa_secret_ciphertext = $2, encryption_key_id = $3 WHERE id = $1",
        [account.id, sealed.ciphertext, sealed.kekId],
      );
    }
  }
  const unnamed = await insertAccount(pool, { mfa_enabled: true });
  const unnamedSealed = await seal(
    sealV1,
    "accounts",
    unnamed.id,
    "mfa_secret_ciphertext",
    accountSecretPlace(unnamed.id),
  );
  await pool.query("UPDATE platform.accounts SET mfa_secret_ciphertext = $2 WHERE id = $1", [
    unnamed.id,
    unnamedSealed.ciphertext,
  ]);
  rowIds.add((await insertAccount(pool)).id);
  arranged["accounts"] = { v1: 3, v2: 1, none: 1, empty: 1 };

  // amadeus_accounts: one per environment (UNIQUE), the test one under v1, the live one under v2.
  const amadeus: Array<PlatformRow<"amadeus_accounts">> = [];
  for (const [envelope, overrides] of [
    [sealV1, { environment: "test" as const }],
    [sealV2, { environment: "live" as const, base_url: "https://travel.api.amadeus.com" }],
  ] as const) {
    const id = testId("ama", 900 + amadeus.length);
    const sealed = await seal(
      envelope,
      "amadeus_accounts",
      id,
      "client_secret_ciphertext",
      clientSecretPlace(id),
    );
    amadeus.push(
      await insertAmadeusAccount(pool, {
        id,
        ...overrides,
        client_secret_ciphertext: sealed.ciphertext,
        encryption_key_id: sealed.kekId,
      }),
    );
  }
  arranged["amadeus_accounts"] = { v1: 1, v2: 1, empty: 0 };

  // supplier_connections: the OTA's own credentials under v1 (two) and v2 (one); one through the Velexis account.
  for (const [tenant, envelope] of [
    [t1, sealV1],
    [t2, sealV1],
    [t3, sealV2],
  ] as const) {
    const id = testId("sc", 900 + tenants.indexOf(tenant));
    const sealed = await seal(
      envelope,
      "supplier_connections",
      id,
      "client_secret_ciphertext",
      amadeusConnectionSecretPlace(id),
    );
    rowIds.add(
      (
        await insertSupplierConnection(pool, tenant, {
          id,
          client_secret_ciphertext: sealed.ciphertext,
          encryption_key_id: sealed.kekId,
        })
      ).id,
    );
  }
  rowIds.add(
    (await insertSupplierConnection(pool, t4, velexisSource(amadeus[0] as PlatformRow<"amadeus_accounts">)))
      .id,
  );
  arranged["supplier_connections"] = { v1: 2, v2: 1, empty: 1 };

  // payment_provider_connections: own Stripe keys (secret and webhook secret, one key id) under v1 and v2; one in
  // the default velexis mode without secrets.
  for (const [tenant, envelope] of [
    [t1, sealV1],
    [t2, sealV2],
  ] as const) {
    const id = testId("ppc", 900 + tenants.indexOf(tenant));
    const secret = await seal(
      envelope,
      "payment_provider_connections",
      id,
      "secret_ciphertext",
      stripeSecretPlace(id),
    );
    const webhook = await seal(
      envelope,
      "payment_provider_connections",
      id,
      "webhook_secret_ciphertext",
      stripeWebhookSecretPlace(id),
    );
    rowIds.add(
      (
        await insertPaymentConnection(pool, tenant, {
          id,
          account_mode: "api_keys",
          account_reference: `acct_1Test${tenants.indexOf(tenant)}`,
          publishable_key: `pk_test_${tenants.indexOf(tenant)}`,
          secret_ciphertext: secret.ciphertext,
          webhook_secret_ciphertext: webhook.ciphertext,
          encryption_key_id: secret.kekId,
        })
      ).id,
    );
  }
  rowIds.add((await insertPaymentConnection(pool, t3)).id);
  arranged["payment_provider_connections"] = { v1: 1, v2: 1, empty: 1 };

  // credential_submissions: an Amadeus secret alone (v1), Stripe keys with their webhook secret (v1 and v2), and an
  // applied one whose secrets are erased but whose key id stays.
  const submission = async (
    tenant: PlatformRow<"tenants">,
    kind: "amadeus" | "stripe_api_keys",
    envelope: EnvelopeService,
  ): Promise<void> => {
    const id = testId("crs", 900 + values.length);
    const secret = await seal(
      envelope,
      "credential_submissions",
      id,
      SECRET_COLUMNS.secret,
      secretPlace(SECRET_COLUMNS.secret, id),
    );
    const webhook =
      kind === "stripe_api_keys"
        ? await seal(
            envelope,
            "credential_submissions",
            id,
            SECRET_COLUMNS.webhookSecret,
            secretPlace(SECRET_COLUMNS.webhookSecret, id),
          )
        : undefined;
    await insertRow(pool, "credential_submissions", {
      id,
      tenant_id: tenant.id,
      kind,
      environment: "test",
      status: "pending",
      secret_ciphertext: secret.ciphertext,
      webhook_secret_ciphertext: webhook?.ciphertext ?? null,
      encryption_key_id: secret.kekId,
    });
  };
  await submission(t1, "amadeus", sealV1);
  await submission(t2, "stripe_api_keys", sealV1);
  await submission(t3, "stripe_api_keys", sealV2);
  const applied = testId("crs", 999);
  rowIds.add(applied);
  await insertRow(pool, "credential_submissions", {
    id: applied,
    tenant_id: t4.id,
    kind: "amadeus",
    environment: "test",
    status: "applied",
    encryption_key_id: "local:v1",
    finished_at: new Date("2026-11-01T10:00:00.000Z"),
  });
  arranged["credential_submissions"] = { v1: 2, v2: 1, empty: 1 };

  // tenant_payout_accounts: the row id of the associated data is the tenant id (the primary key).
  for (const [tenant, envelope] of [
    [t1, sealV1],
    [t2, sealV1],
    [t3, sealV2],
  ] as const) {
    const sealed = await seal(
      envelope,
      "tenant_payout_accounts",
      tenant.id,
      "bank_details_ciphertext",
      bankDetailsPlace(tenant.id),
      "tenant_id",
    );
    await insertRow(pool, "tenant_payout_accounts", {
      tenant_id: tenant.id,
      account_holder_name: "Agency Holder",
      country_code: "FR",
      currency: "EUR",
      scheme: "iban",
      bank_details_ciphertext: sealed.ciphertext,
      encryption_key_id: sealed.kekId,
      last4: "1234",
    });
  }
  arranged["tenant_payout_accounts"] = { v1: 2, v2: 1, empty: 0 };

  // email_outbox: secret links under v1 (three) and v2 (one); one e-mail without a secret payload.
  for (const envelope of [sealV1, sealV1, sealV1, sealV2]) {
    const id = testId("eml", 900 + values.length);
    const sealed = await seal(
      envelope,
      "email_outbox",
      id,
      "secret_payload_ciphertext",
      secretPayloadPlace(id),
    );
    await insertEmailOutbox(pool, {
      id,
      secret_payload_ciphertext: sealed.ciphertext,
      encryption_key_id: sealed.kekId,
    });
  }
  rowIds.add((await insertEmailOutbox(pool)).id);
  arranged["email_outbox"] = { v1: 3, v2: 1, empty: 1 };

  // provisioning_jobs: the reveal of the test keys under its own key id column, v1 and v2; one job without a reveal.
  for (const [tenant, envelope] of [
    [t1, sealV1],
    [t2, sealV2],
    [t3, undefined],
  ] as const) {
    const id = testId("job", 900 + tenants.indexOf(tenant));
    const sealed =
      envelope === undefined
        ? undefined
        : await seal(envelope, "provisioning_jobs", id, "reveal_ciphertext", revealPlace(id));
    rowIds.add(id);
    await insertRow(pool, "provisioning_jobs", {
      id,
      tenant_id: tenant.id,
      kind: "provision",
      status: "succeeded",
      finished_at: new Date("2026-11-01T10:00:00.000Z"),
      reveal_ciphertext: sealed?.ciphertext ?? null,
      reveal_encryption_key_id: sealed?.kekId ?? null,
    });
  }
  arranged["provisioning_jobs"] = { v1: 1, v2: 1, empty: 1 };
}

/** The table line a run prints for `table` when every row under an old KEK moves. */
function movedLine(table: string): string {
  const counts = arranged[table] as { v1: number; none?: number };
  const before =
    counts.none === undefined
      ? `{"local:v1":${counts.v1}}`
      : `{"(none)":${counts.none},"local:v1":${counts.v1}}`;
  return (
    `secrets:rewrap: platform.${table}: rewrapped ${counts.v1 + (counts.none ?? 0)}, skipped 0, failed 0; ` +
    `remainingByKekId before ${before} after {}`
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  pool = createPool(db.urlFor("platform"), {
    applicationName: "platform-rewrap-test",
    logger: createLogger({ app: "platform-test", env: "test", destination: new LogSink() }),
    max: 2,
  });
  keyFolder = createTestMasterKeyDir();
  const second = join(keyFolder.path, "master-v2.key");
  writeFileSync(second, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  chmodSync(second, 0o600);
  v2OnlyFolder = mkdtempSync(join(tmpdir(), "velexis-platform-keys-v2-"));
  chmodSync(v2OnlyFolder, 0o700);
  copyFileSync(second, join(v2OnlyFolder, "master-v2.key"));
  chmodSync(join(v2OnlyFolder, "master-v2.key"), 0o600);
  [v1, v2, v2Only] = await Promise.all([
    LocalFileKeyProvider.fromDir(keyFolder.path, "local:v1"),
    LocalFileKeyProvider.fromDir(keyFolder.path, "local:v2"),
    LocalFileKeyProvider.fromDir(v2OnlyFolder, "local:v2"),
  ]);
  sealV1 = new EnvelopeService(v1);
  sealV2 = new EnvelopeService(v2);
  await arrange();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await db?.drop();
  keyFolder?.remove();
  if (v2OnlyFolder !== undefined) {
    rmSync(v2OnlyFolder, { recursive: true, force: true });
  }
});

describe("the sources", () => {
  it("are every *_ciphertext column of the platform schema, each table with its key id column [PBE-072 AC1]", async () => {
    const { rows } = await pool.query(
      "SELECT table_name, column_name FROM information_schema.columns " +
        "WHERE table_schema = 'platform' AND data_type = 'bytea' AND column_name LIKE '%\\_ciphertext' " +
        "ORDER BY table_name, column_name",
    );
    const catalog = (rows as Array<{ table_name: string; column_name: string }>).map(
      (row) => `${row.table_name}.${row.column_name}`,
    );
    const listed = REWRAP_SOURCES.flatMap((source) =>
      source.columns.map((column) => `${source.table}.${column}`),
    );

    expect([...listed].sort()).toEqual(catalog);
    for (const source of REWRAP_SOURCES) {
      const { rows: kekColumns } = await pool.query(
        "SELECT data_type FROM information_schema.columns " +
          "WHERE table_schema = 'platform' AND table_name = $1 AND column_name = $2",
        [source.table, source.kekIdColumn],
      );
      expect(kekColumns, `${source.table}.${source.kekIdColumn}`).toEqual([{ data_type: "text" }]);
    }
  });
});

describe("a dry run, a run and a second run", () => {
  let initial: Awaited<ReturnType<typeof snapshot>>;
  let dryRun: CliRun;
  let afterDryRun: Awaited<ReturnType<typeof snapshot>>;
  let run: CliRun;
  let afterRun: Awaited<ReturnType<typeof snapshot>>;
  let second: CliRun;
  let afterSecond: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    initial = await snapshot();
    // Pages of two rows, so every table with more than two rows takes several pages.
    dryRun = await rewrap("--dry-run", "--batch-size", "2");
    afterDryRun = await snapshot();
    run = await rewrap("--batch-size=2");
    afterRun = await snapshot();
    for (const table of Object.values(afterRun)) {
      for (const row of table.values()) {
        for (const value of Object.values(row)) {
          if (typeof value === "string" && value.startsWith("\\x")) {
            ciphertexts.push(Buffer.from(value.slice(2), "hex"));
          }
        }
      }
    }
    second = await rewrap();
    afterSecond = await snapshot();
  }, GROUP_SETUP_TIMEOUT_MS);

  it("--dry-run reports the counts before and what would move, and writes nothing [PBE-072 AC1]", () => {
    expect(dryRun.code).toBe(EXIT_FAILED);
    const lines = dryRun.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "secrets:rewrap: current KEK local:v2 (loaded: local:v1, local:v2); 8 platform table(s); " +
        "dry run: nothing is written.",
    );
    expect(lines.slice(1, 9)).toEqual(
      REWRAP_SOURCES.map((source) => {
        const counts = arranged[source.table] as { v1: number; none?: number };
        const before =
          counts.none === undefined
            ? `{"local:v1":${counts.v1}}`
            : `{"(none)":${counts.none},"local:v1":${counts.v1}}`;
        return (
          `secrets:rewrap: platform.${source.table}: dry run: would re-wrap ${counts.v1 + (counts.none ?? 0)}, ` +
          `would fail 0; remainingByKekId before ${before}`
        );
      }),
    );
    expect(lines.slice(9)).toEqual([
      'secrets:rewrap: total of 8 table(s): dry run: would re-wrap 16, would fail 0; remainingByKekId before {"(none)":1,"local:v1":15}',
      "secrets:rewrap: dry run: nothing was written; 16 row(s) would move to local:v2 and 0 would fail.",
    ]);
    expect(afterDryRun).toEqual(initial);
  });

  it("a run moves every value to the current KEK and reports per table the counts per KEK before and after [PBE-072 AC1]", () => {
    expect(run.code).toBe(EXIT_OK);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "secrets:rewrap: current KEK local:v2 (loaded: local:v1, local:v2); 8 platform table(s).",
    );
    expect(lines.slice(1, 9)).toEqual(REWRAP_SOURCES.map((source) => movedLine(source.table)));
    expect(lines.slice(9)).toEqual([
      "secrets:rewrap: total of 8 table(s): rewrapped 16, skipped 0, failed 0; " +
        'remainingByKekId before {"(none)":1,"local:v1":15} after {}',
      "secrets:rewrap: nothing is left under an old KEK: every value is under local:v2.",
    ]);
  });

  it("every value is under local:v2 and decrypts at its writer's place with master-v2.key alone [PBE-072 AC1]", async () => {
    for (const value of values) {
      const where = `${value.table}.${value.column}:${value.rowId}`;
      const stored = await storedCiphertext(value);
      expect(stored, where).not.toBeNull();
      expect(envelopeKekId(stored as Buffer), where).toBe("local:v2");
      expect(await storedKekId(value.table, value.rowId), where).toBe("local:v2");
      const plaintext = await decryptValue(stored as Buffer, {
        aad: associatedData(value.place),
        keys: v2Only,
      });
      expect(plaintext.toString("utf8"), where).toBe(value.plaintext);
    }
  });

  it("changes only the ciphertexts and key id of the moved rows: not version, not updated_at, not the rest [PBE-072 AC1]", () => {
    for (const source of REWRAP_SOURCES) {
      const before = initial[source.table] as Map<string, Record<string, unknown>>;
      const after = afterRun[source.table] as Map<string, Record<string, unknown>>;
      expect([...after.keys()], source.table).toEqual([...before.keys()]);
      for (const [id, row] of before) {
        const moved = after.get(id) as Record<string, unknown>;
        const changed = Object.keys(row).filter(
          (column) => JSON.stringify(row[column]) !== JSON.stringify(moved[column]),
        );
        const wasUnderV1 =
          row[source.kekIdColumn] !== "local:v2" && source.columns.some((column) => row[column] !== null);
        expect(changed.sort(), `${source.table} ${wasUnderV1 ? "moved" : "untouched"} row`).toEqual(
          wasUnderV1
            ? [...source.columns.filter((column) => row[column] !== null), source.kekIdColumn].sort()
            : [],
        );
      }
    }
    // The applied submission without secrets keeps its old key id: it wraps nothing, so it is no row to move.
    const applied = (afterRun["credential_submissions"] as Map<string, Record<string, unknown>>).get(
      testId("crs", 999),
    );
    expect(applied?.["encryption_key_id"]).toBe("local:v1");
  });

  it("a second run moves nothing, reports rewrapped 0 and an empty remainingByKekId, and exits 0 [PBE-072 AC1]", () => {
    expect(second.code).toBe(EXIT_OK);
    const lines = second.stdout.trimEnd().split("\n");
    expect(lines.slice(1, 9)).toEqual(
      REWRAP_SOURCES.map(
        (source) =>
          `secrets:rewrap: platform.${source.table}: rewrapped 0, skipped 0, failed 0; remainingByKekId before {} after {}`,
      ),
    );
    expect(lines.slice(9)).toEqual([
      "secrets:rewrap: total of 8 table(s): rewrapped 0, skipped 0, failed 0; remainingByKekId before {} after {}",
      "secrets:rewrap: nothing is left under an old KEK: every value is under local:v2.",
    ]);
    expect(afterSecond).toEqual(afterRun);
  });
});

describe("a row changed between the read and the write", () => {
  const accounts = sourceOf("accounts");
  const reenrolled = { id: "", plaintext: "" };
  const disabled = { id: "" };
  const stale = { id: "", plaintext: "" };
  const relabelled = { id: "", value: Buffer.alloc(0) };
  const untouched = { id: "" };
  let outcome: Awaited<ReturnType<typeof rewrapSource>>;

  beforeAll(async () => {
    // Five accounts with MFA under the old KEK, as if their values had been written after the runs above.
    for (const target of [reenrolled, disabled, stale, relabelled, untouched]) {
      const account = await insertAccount(pool, { mfa_enabled: true });
      const sealed = await seal(
        sealV1,
        "accounts",
        account.id,
        "mfa_secret_ciphertext",
        accountSecretPlace(account.id),
      );
      await pool.query(
        "UPDATE platform.accounts SET mfa_secret_ciphertext = $2, encryption_key_id = $3 WHERE id = $1",
        [account.id, sealed.ciphertext, sealed.kekId],
      );
      target.id = account.id;
      if (target === relabelled) {
        relabelled.value = sealed.ciphertext;
      }
    }
    reenrolled.plaintext = plaintextFor("accounts", "mfa_secret_ciphertext");
    stale.plaintext = plaintextFor("accounts", "mfa_secret_ciphertext");
    for (const target of [reenrolled, stale]) {
      values.push({
        table: "accounts",
        idColumn: "id",
        rowId: target.id,
        column: "mfa_secret_ciphertext",
        plaintext: target.plaintext,
        place: accountSecretPlace(target.id),
      });
    }
    const repository = new RewrapRepository(createPlatformDb(pool));
    // The real repository; before the writes of four rows another writer changes the row between the read and the
    // write: a person enrols again (MfaService.enable, under the current KEK), a person turns MFA off, a process that
    // still runs on the old KEK (a unit not restarted at step 4) writes a new value under the same key id, which only
    // the check on the old ciphertext itself can tell apart, and a writer changes the key id alone (no writer does that
    // today), which only the check on the old key id can tell apart.
    const store: RewrapStore = {
      fetch: (source, page) => repository.fetch(source, page),
      countNotUnder: (source, kekId) => repository.countNotUnder(source, kekId),
      async update(source, change) {
        if (change.id === reenrolled.id) {
          const sealed = await sealV2.encrypt(reenrolled.plaintext, accountSecretPlace(reenrolled.id));
          ciphertexts.push(sealed.ciphertext);
          await pool.query(
            "UPDATE platform.accounts SET mfa_secret_ciphertext = $2, encryption_key_id = $3, version = version + 1 " +
              "WHERE id = $1",
            [reenrolled.id, sealed.ciphertext, sealed.kekId],
          );
        } else if (change.id === disabled.id) {
          await pool.query(
            "UPDATE platform.accounts SET mfa_enabled = false, mfa_secret_ciphertext = NULL, " +
              "encryption_key_id = NULL, version = version + 1 WHERE id = $1",
            [disabled.id],
          );
        } else if (change.id === stale.id) {
          const sealed = await sealV1.encrypt(stale.plaintext, accountSecretPlace(stale.id));
          ciphertexts.push(sealed.ciphertext);
          await pool.query(
            "UPDATE platform.accounts SET mfa_secret_ciphertext = $2, version = version + 1 WHERE id = $1",
            [stale.id, sealed.ciphertext],
          );
        } else if (change.id === relabelled.id) {
          await pool.query(
            "UPDATE platform.accounts SET encryption_key_id = 'local:v3', version = version + 1 WHERE id = $1",
            [relabelled.id],
          );
        }
        return repository.update(source, change);
      },
    };
    const sink = new LogSink();
    outcome = await rewrapSource({
      store,
      source: accounts,
      keys: v2,
      batchSize: 500,
      dryRun: false,
      logger: createLogger({ app: "platform-cli", env: "test", level: "debug", destination: sink }),
    });
    output.push(JSON.stringify(sink.lines));
  }, GROUP_SETUP_TIMEOUT_MS);

  it("is skipped and keeps the other writer's value; the rest moves [PBE-072 AC1]", async () => {
    expect(outcome).toEqual({
      kind: "rewrapped",
      table: "platform.accounts",
      before: { "local:v1": 5 },
      rewrapped: 1,
      skipped: 4,
      failed: 0,
      // The stale writer's new value is under the old KEK and the relabelled row names another KEK than the current
      // one: the next run moves both.
      after: { "local:v1": 1, "local:v3": 1 },
    });
    const { rows } = await pool.query(
      "SELECT id, mfa_secret_ciphertext, encryption_key_id FROM platform.accounts WHERE id = ANY($1)",
      [[reenrolled.id, disabled.id, stale.id, relabelled.id, untouched.id]],
    );
    const byId = new Map(
      (
        rows as Array<{ id: string; mfa_secret_ciphertext: Buffer | null; encryption_key_id: string | null }>
      ).map((row) => [row.id, row]),
    );
    const kept = byId.get(reenrolled.id);
    expect(kept?.encryption_key_id).toBe("local:v2");
    const secret = await decryptValue(kept?.mfa_secret_ciphertext as Buffer, {
      aad: associatedData(accountSecretPlace(reenrolled.id)),
      keys: v2Only,
    });
    expect(secret.toString("utf8")).toBe(reenrolled.plaintext);
    expect(byId.get(disabled.id)).toMatchObject({ mfa_secret_ciphertext: null, encryption_key_id: null });
    const staleRow = byId.get(stale.id);
    expect(staleRow?.encryption_key_id).toBe("local:v1");
    const staleSecret = await decryptValue(staleRow?.mfa_secret_ciphertext as Buffer, {
      aad: associatedData(accountSecretPlace(stale.id)),
      keys: v1,
    });
    expect(staleSecret.toString("utf8")).toBe(stale.plaintext);
    expect(byId.get(relabelled.id)).toMatchObject({
      mfa_secret_ciphertext: relabelled.value,
      encryption_key_id: "local:v3",
    });
    expect(byId.get(untouched.id)?.encryption_key_id).toBe("local:v2");
  });
});

describe("a corrupted and a copied ciphertext", () => {
  const corrupted = { id: "", value: Buffer.alloc(0) };
  const copied = { id: "", value: Buffer.alloc(0) };
  let run: CliRun;
  let dryRun: CliRun;

  beforeAll(async () => {
    // An e-mail whose secret payload lost a bit, and an account holding another account's MFA secret. The account of
    // the stale writer above is still under local:v1 and the relabelled one names local:v3: this run moves both.
    const email = testId("eml", 990);
    const sealed = await seal(
      sealV1,
      "email_outbox",
      email,
      "secret_payload_ciphertext",
      secretPayloadPlace(email),
    );
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
    await insertEmailOutbox(pool, {
      id: email,
      secret_payload_ciphertext: flipped,
      encryption_key_id: "local:v1",
    });
    Object.assign(corrupted, { id: email, value: flipped });
    ciphertexts.push(flipped);

    const owner = await insertAccount(pool, { mfa_enabled: true });
    const original = await seal(
      sealV1,
      "accounts",
      owner.id,
      "mfa_secret_ciphertext",
      accountSecretPlace(owner.id),
    );
    const thief = await insertAccount(pool, { mfa_enabled: true });
    rowIds.add(thief.id);
    await pool.query(
      "UPDATE platform.accounts SET mfa_secret_ciphertext = $2, encryption_key_id = 'local:v1' WHERE id = ANY($1)",
      [[owner.id, thief.id], original.ciphertext],
    );
    Object.assign(copied, { id: thief.id, value: original.ciphertext });

    run = await rewrap();
    dryRun = await rewrap("--dry-run");
  }, GROUP_SETUP_TIMEOUT_MS);

  it("count as failed, stay under the old KEK unchanged, and make the run exit 1 [PBE-072 AC1]", async () => {
    expect(run.code).toBe(EXIT_FAILED);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toContain(
      "secrets:rewrap: platform.accounts: rewrapped 3, skipped 0, failed 1; " +
        'remainingByKekId before {"local:v1":3,"local:v3":1} after {"local:v1":1}',
    );
    expect(lines).toContain(
      'secrets:rewrap: platform.email_outbox: rewrapped 0, skipped 0, failed 1; remainingByKekId before {"local:v1":1} after {"local:v1":1}',
    );
    expect(lines.slice(-2)).toEqual([
      "secrets:rewrap: total of 8 table(s): rewrapped 3, skipped 0, failed 2; " +
        'remainingByKekId before {"local:v1":4,"local:v3":1} after {"local:v1":2}',
      "secrets:rewrap: 2 row(s) remain under an old KEK (2 failed, 0 skipped): keep the old key " +
        "(master-key-rotation.md step 5).",
    ]);
    const { rows: emails } = await pool.query(
      "SELECT secret_payload_ciphertext AS value, encryption_key_id FROM platform.email_outbox WHERE id = $1",
      [corrupted.id],
    );
    expect(emails).toEqual([{ value: corrupted.value, encryption_key_id: "local:v1" }]);
    const { rows: thieves } = await pool.query(
      "SELECT mfa_secret_ciphertext AS value, encryption_key_id FROM platform.accounts WHERE id = $1",
      [copied.id],
    );
    expect(thieves).toEqual([{ value: copied.value, encryption_key_id: "local:v1" }]);
  });

  it("show in a dry run as would fail [PBE-072 AC1]", () => {
    expect(dryRun.code).toBe(EXIT_FAILED);
    expect(dryRun.stdout.trimEnd().split("\n").slice(-2)).toEqual([
      'secrets:rewrap: total of 8 table(s): dry run: would re-wrap 0, would fail 2; remainingByKekId before {"local:v1":2}',
      "secrets:rewrap: dry run: nothing was written; 0 row(s) would move to local:v2 and 2 would fail.",
    ]);
  });
});

describe("a table whose writes PostgreSQL refuses, and the run that continues", () => {
  const submission = { id: testId("crs", 998) };
  const email = { id: testId("eml", 991) };
  let stoppedRun: CliRun;
  let stoppedKekIds: Array<string | null>;
  let resumedRun: CliRun;

  beforeAll(async () => {
    // A pending Stripe submission of a new tenant and an e-mail under local:v1; the corrupted e-mail and the copied MFA
    // secret of the group above still fail.
    const tenant = await insertTenant(pool);
    rowIds.add(tenant.id);
    const secret = await seal(
      sealV1,
      "credential_submissions",
      submission.id,
      SECRET_COLUMNS.secret,
      secretPlace(SECRET_COLUMNS.secret, submission.id),
    );
    const webhook = await seal(
      sealV1,
      "credential_submissions",
      submission.id,
      SECRET_COLUMNS.webhookSecret,
      secretPlace(SECRET_COLUMNS.webhookSecret, submission.id),
    );
    await insertRow(pool, "credential_submissions", {
      id: submission.id,
      tenant_id: tenant.id,
      kind: "stripe_api_keys",
      environment: "test",
      status: "pending",
      secret_ciphertext: secret.ciphertext,
      webhook_secret_ciphertext: webhook.ciphertext,
      encryption_key_id: secret.kekId,
    });
    const sealed = await seal(
      sealV1,
      "email_outbox",
      email.id,
      "secret_payload_ciphertext",
      secretPayloadPlace(email.id),
    );
    await insertEmailOutbox(pool, {
      id: email.id,
      secret_payload_ciphertext: sealed.ciphertext,
      encryption_key_id: sealed.kekId,
    });
    // velexis_platform_app loses UPDATE on platform.credential_submissions (velexis_migrator, the owner, revokes it),
    // so that table's first write fails with a real PostgreSQL error; the privilege comes back before the second run.
    const owner = createPool(db.urlFor("migrator"), {
      applicationName: "platform-rewrap-test-owner",
      logger: createLogger({ app: "platform-test", env: "test", destination: new LogSink() }),
      max: 1,
    });
    try {
      await owner.query("REVOKE UPDATE ON platform.credential_submissions FROM velexis_platform_app");
      try {
        stoppedRun = await rewrap();
        stoppedKekIds = await Promise.all([
          storedKekId("credential_submissions", submission.id),
          storedKekId("email_outbox", email.id),
        ]);
      } finally {
        await owner.query("GRANT UPDATE ON platform.credential_submissions TO velexis_platform_app");
      }
    } finally {
      await owner.end();
    }
    resumedRun = await rewrap();
  }, GROUP_SETUP_TIMEOUT_MS);

  it("goes on past it, names the error by its class and code only, and exits 1 [PBE-072 AC2]", () => {
    expect(stoppedRun.code).toBe(EXIT_FAILED);
    const lines = stoppedRun.stdout.trimEnd().split("\n");
    expect(lines).toContain(
      "secrets:rewrap: platform.credential_submissions: stopped (DatabaseError 42501); run the command again: " +
        "it continues with what is left",
    );
    // The tables after it ran: the new e-mail moved, the corrupted one still fails.
    expect(lines).toContain(
      "secrets:rewrap: platform.email_outbox: rewrapped 1, skipped 0, failed 1; " +
        'remainingByKekId before {"local:v1":2} after {"local:v1":1}',
    );
    expect(lines.slice(-3)).toEqual([
      "secrets:rewrap: total of 8 table(s): rewrapped 1, skipped 0, failed 2; " +
        'remainingByKekId before {"local:v1":3} after {"local:v1":2}',
      "secrets:rewrap: 1 table(s) stopped before the end: run the command again.",
      "secrets:rewrap: 2 row(s) remain under an old KEK (2 failed, 0 skipped): keep the old key " +
        "(master-key-rotation.md step 5).",
    ]);
    expect(stoppedRun.stderr).toContain('"msg":"secrets.rewrap.stopped"');
    expect(stoppedRun.stderr).toContain('"reason":"DatabaseError 42501"');
    // PostgreSQL's message is never printed or logged.
    expect(`${stoppedRun.stdout}${stoppedRun.stderr}`).not.toMatch(/permission denied/i);
    // The stopped table's row stays as it was; the row of a table after it moved.
    expect(stoppedKekIds).toEqual(["local:v1", "local:v2"]);
  });

  it("continues with what is left on the next run [PBE-072 AC1]", async () => {
    expect(resumedRun.code).toBe(EXIT_FAILED);
    const lines = resumedRun.stdout.trimEnd().split("\n");
    expect(lines).toContain(
      "secrets:rewrap: platform.credential_submissions: rewrapped 1, skipped 0, failed 0; " +
        'remainingByKekId before {"local:v1":1} after {}',
    );
    expect(lines.slice(-2)).toEqual([
      "secrets:rewrap: total of 8 table(s): rewrapped 1, skipped 0, failed 2; " +
        'remainingByKekId before {"local:v1":3} after {"local:v1":2}',
      "secrets:rewrap: 2 row(s) remain under an old KEK (2 failed, 0 skipped): keep the old key " +
        "(master-key-rotation.md step 5).",
    ]);
    for (const value of values.filter((stored) => stored.rowId === submission.id)) {
      const stored = (await storedCiphertext(value)) as Buffer;
      expect(envelopeKekId(stored)).toBe("local:v2");
      const plaintext = await decryptValue(stored, { aad: associatedData(value.place), keys: v2Only });
      expect(plaintext.toString("utf8")).toBe(value.plaintext);
    }
    expect(await storedKekId("credential_submissions", submission.id)).toBe("local:v2");
  });
});

describe("what the command prints and logs", () => {
  it("holds no plaintext, no ciphertext and no row id, only counts, table names and KEK ids [PBE-072 AC2]", () => {
    const text = output.join("\n");
    // The per-page lines of rewrapBatch were captured (LOG_LEVEL=debug), so the check covers the logs too.
    expect(text).toContain('"msg":"secrets.rewrap.batch"');
    expect(text).toContain('"msg":"secrets.rewrap.done"');
    for (const value of values) {
      expect(text).not.toContain(value.plaintext);
    }
    for (const id of rowIds) {
      expect(text).not.toContain(id);
    }
    for (const ciphertext of ciphertexts) {
      for (const encoded of [
        ciphertext.toString("hex"),
        ciphertext.toString("base64"),
        ciphertext.toString("base64url"),
        // A slice of the bytes after the envelope header: an encoding of part of a value would show it.
        ciphertext.subarray(10, 42).toString("hex"),
        ciphertext.subarray(10, 42).toString("base64"),
      ]) {
        expect(text).not.toContain(encoded);
      }
    }
  });
});
