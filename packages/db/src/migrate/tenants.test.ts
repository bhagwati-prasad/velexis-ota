// The tenant commands without a database (X-013): the concurrency limiter, the failure ratio, the tenant options
// of migrate.js and the package scripts. The database behaviour is in test/integration/tenants.int.test.ts.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATE_USAGE, runMigrateCli } from "../cli/migrate.js";
import { InvalidTenantSchemaError } from "../tenant-schema.js";
import {
  BASELINE_FILE,
  DEFAULT_MAX_FAILURE_RATIO,
  DEFAULT_TENANT_CONCURRENCY,
  failureRatio,
  fanOutExitCode,
  MIGRATE_EXIT_CODES,
  migrateTenants,
  migrateTenantSchema,
  runWithConcurrency,
  TenantChecksumMismatchError,
  type MigrateTenantsResult,
  type TenantMigrationFileEvent,
} from "./index.js";

const PACKAGE_DIR = resolve(__dirname, "..", "..");
const REPO = resolve(PACKAGE_DIR, "..", "..");
/** Port 1 refuses every connection: any attempt to connect would reject. */
const NO_DATABASE = "postgres://nobody@127.0.0.1:1/none";
const MIGRATOR_URL = "postgres://velexis_migrator:dev_migrator@127.0.0.1:5432/velexis";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-migrate-tenants-"));
  roots.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

class Buffered {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** A promise the test resolves or rejects by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolveFn, rejectFn) => {
    resolvePromise = resolveFn;
    rejectPromise = rejectFn;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** Lets every pending promise callback run. */
const settle = (): Promise<void> => new Promise((resolveFn) => setImmediate(resolveFn));

describe("runWithConcurrency", () => {
  it("never runs more than `limit` tasks at once, and starts every item once, in order [X-013 AC6]", async () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    const gates = new Map(items.map((item) => [item, deferred()]));
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const done = runWithConcurrency(items, 3, async (item) => {
      started.push(item);
      active += 1;
      peak = Math.max(peak, active);
      await gates.get(item)?.promise;
      active -= 1;
    });

    await settle();
    expect(started).toEqual(["a", "b", "c"]);
    // Finishing one task frees exactly one slot.
    gates.get("b")?.resolve();
    await settle();
    expect(started).toEqual(["a", "b", "c", "d"]);
    for (const item of items) {
      gates.get(item)?.resolve();
    }
    await done;
    expect(started).toEqual(items);
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it("runs every item at once when the limit is larger, and nothing for no items", async () => {
    let peak = 0;
    let active = 0;
    await runWithConcurrency([1, 2], 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await settle();
      active -= 1;
    });
    expect(peak).toBe(2);
    const task = vi.fn(() => Promise.resolve());
    await runWithConcurrency([], 4, task);
    expect(task).not.toHaveBeenCalled();
  });

  it("starts no further item after a task rejects, lets the running ones finish, then rethrows", async () => {
    const gate = deferred();
    const started: number[] = [];
    const finished: number[] = [];
    const done = runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      if (item === 1) {
        throw new Error("task 1 failed");
      }
      await gate.promise;
      finished.push(item);
    });
    const outcome = done.catch((error: unknown) => error);
    await settle();
    gate.resolve();
    expect(await outcome).toMatchObject({ message: "task 1 failed" });
    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([2]);
  });

  it("rejects a limit that is not a positive integer", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(runWithConcurrency([1], limit, () => Promise.resolve())).rejects.toThrow(TypeError);
    }
  });
});

describe("the failure ratio of the fan-out", () => {
  it("exits 3 only when failed / total is greater than the maximum ratio [X-013 AC4] [X-013 AC5]", () => {
    expect(DEFAULT_MAX_FAILURE_RATIO).toBe(0.1);
    expect(DEFAULT_TENANT_CONCURRENCY).toBe(4);
    // 1 of 10 is exactly 10 %: allowed. 1 of 3 is 33 %: too many.
    expect(fanOutExitCode(1, 10, 0.1)).toBe(MIGRATE_EXIT_CODES.ok);
    expect(fanOutExitCode(2, 10, 0.1)).toBe(MIGRATE_EXIT_CODES.failureRatioExceeded);
    expect(fanOutExitCode(1, 3, 0.1)).toBe(MIGRATE_EXIT_CODES.failureRatioExceeded);
    expect(fanOutExitCode(1, 3, 0.5)).toBe(MIGRATE_EXIT_CODES.ok);
    expect(fanOutExitCode(0, 0, 0)).toBe(MIGRATE_EXIT_CODES.ok);
    expect(fanOutExitCode(1, 100, 0)).toBe(MIGRATE_EXIT_CODES.failureRatioExceeded);
    expect(fanOutExitCode(5, 5, 1)).toBe(MIGRATE_EXIT_CODES.ok);
    expect(failureRatio(1, 4)).toBe(0.25);
    expect(failureRatio(0, 0)).toBe(0);
  });
});

describe("migrateTenantSchema and migrateTenants without a database", () => {
  it("rejects an invalid schema name before reading the folder or connecting", async () => {
    for (const schema of ["tenant_a; DROP TABLE x", "public", "tenant_a", "Tenant_acme", ""]) {
      await expect(
        migrateTenantSchema({ schema, dir: join(PACKAGE_DIR, "does-not-exist"), url: NO_DATABASE }),
      ).rejects.toBeInstanceOf(InvalidTenantSchemaError);
    }
  });

  it("does nothing and connects to nothing for a folder that does not exist", async () => {
    const missing = join(await folder(), "tenant");
    await expect(
      migrateTenantSchema({ schema: "tenant_acme", dir: missing, url: NO_DATABASE, create: true }),
    ).resolves.toEqual({
      schema: "tenant_acme",
      dir: missing,
      dirExists: false,
      created: false,
      applied: [],
      upToDate: 0,
      ledgerOnly: [],
    });
    await expect(migrateTenants({ dir: missing, url: NO_DATABASE })).resolves.toEqual({
      dir: missing,
      dirExists: false,
      report: null,
      failureRatio: 0,
      exitCode: 0,
    });
  });

  it("rejects an invalid concurrency or failure ratio before reading anything", async () => {
    const dir = join(PACKAGE_DIR, "does-not-exist");
    for (const concurrency of [0, -2, 2.5]) {
      await expect(migrateTenants({ dir, url: NO_DATABASE, concurrency })).rejects.toThrow(
        /concurrency must be a positive integer/,
      );
    }
    for (const maxFailureRatio of [-0.1, 1.5, Number.NaN]) {
      await expect(migrateTenants({ dir, url: NO_DATABASE, maxFailureRatio })).rejects.toThrow(
        /maxFailureRatio must be a number from 0 to 1/,
      );
    }
  });

  it("rejects a repeatable file in the tenant set before connecting", async () => {
    const dir = await folder({
      [BASELINE_FILE]: "SELECT 1;\n",
      "R__grants.sql": "GRANT SELECT ON customers TO velexis_ota_app;\n",
    });
    await expect(migrateTenants({ dir, url: NO_DATABASE })).rejects.toMatchObject({
      name: "MigrationFilesError",
      exitCode: 1,
    });
    await expect(migrateTenantSchema({ schema: "tenant_acme", dir, url: NO_DATABASE })).rejects.toMatchObject(
      {
        name: "MigrationFilesError",
      },
    );
  });
});

describe("migrate.js tenants and tenant without a database", () => {
  let stdout: Buffered;
  let stderr: Buffered;
  beforeEach(() => {
    stdout = new Buffered();
    stderr = new Buffered();
  });

  it("lists both tenant commands and their options in the usage", () => {
    expect(MIGRATE_USAGE).toContain(
      "tenants --dir <path> [--concurrency 4] [--max-failure-ratio 0.1] [--report <file>]",
    );
    expect(MIGRATE_USAGE).toContain("tenant --schema tenant_<key> --dir <path> [--create]");
  });

  it("prints a notice, applies nothing and exits 0 for a --dir that does not exist", async () => {
    const missing = join(await folder(), "tenant");
    const fanOut = vi.fn(migrateTenants);
    const single = vi.fn(migrateTenantSchema);
    for (const argv of [
      ["tenants", "--dir", missing, "--report", join(missing, "report.json")],
      ["tenant", "--schema", "tenant_acme", "--dir", missing, "--create"],
    ]) {
      const err = new Buffered();
      const code = await runMigrateCli(argv, {
        stdout,
        stderr: err,
        env: { APP_ENV: "production" },
        migrateTenants: fanOut,
        migrateTenantSchema: single,
      });
      expect(code).toBe(0);
      expect(err.text).toBe(
        `migrate: notice: the tenant migrations folder ${missing} does not exist; it is an empty set and nothing was applied\n`,
      );
    }
    expect(stdout.text).toBe("");
    expect(fanOut).not.toHaveBeenCalled();
    expect(single).not.toHaveBeenCalled();
  });

  it("rejects an invalid --schema before reading the folder or the configuration", async () => {
    const single = vi.fn(migrateTenantSchema);
    for (const schema of ["tenant_a; DROP TABLE x", "public", "tenant_a", "platform"]) {
      const err = new Buffered();
      const code = await runMigrateCli(["tenant", "--schema", schema, "--dir", "."], {
        stdout,
        stderr: err,
        migrateTenantSchema: single,
      });
      expect(code).toBe(1);
      expect(err.text).toContain(`migrate: --schema ${JSON.stringify(schema)} is not a tenant schema name`);
      expect(err.text).toContain(MIGRATE_USAGE);
    }
    expect(single).not.toHaveBeenCalled();
  });

  it("prints the usage and exits 1 for a missing --schema, an option of another command or an invalid value", async () => {
    const cases: Array<[string[], string]> = [
      [["tenant", "--dir", "."], "tenant needs --schema tenant_<key>"],
      [["tenants"], "tenants needs --dir <path>"],
      [["platform", "--dir", ".", "--create"], "platform does not take --create"],
      [["reference", "--dir", ".", "--concurrency", "2"], "reference does not take --concurrency"],
      [["tenants", "--dir", ".", "--schema", "tenant_acme"], "tenants does not take --schema"],
      [["tenants", "--dir", ".", "--create"], "tenants does not take --create"],
      [
        ["tenant", "--schema", "tenant_acme", "--dir", ".", "--report", "r.json"],
        "tenant does not take --report",
      ],
      [
        ["tenant", "--schema", "tenant_acme", "--dir", ".", "--max-failure-ratio", "0.5"],
        "tenant does not take --max-failure-ratio",
      ],
      [["tenants", "--dir", ".", "--concurrency", "0"], '--concurrency must be a positive integer, not "0"'],
      [["tenants", "--dir", ".", "--concurrency=-1"], '--concurrency must be a positive integer, not "-1"'],
      [
        ["tenants", "--dir", ".", "--concurrency", "2.5"],
        '--concurrency must be a positive integer, not "2.5"',
      ],
      [
        ["tenants", "--dir", ".", "--concurrency", "four"],
        '--concurrency must be a positive integer, not "four"',
      ],
      [
        ["tenants", "--dir", ".", "--max-failure-ratio", "10%"],
        "--max-failure-ratio must be a number from 0 to 1",
      ],
      [
        ["tenants", "--dir", ".", "--max-failure-ratio", "1.5"],
        "--max-failure-ratio must be a number from 0 to 1",
      ],
      [
        ["tenants", "--dir", ".", "--max-failure-ratio=-0.1"],
        "--max-failure-ratio must be a number from 0 to 1",
      ],
      [["tenants", "--dir", ".", "--report", ""], "--report needs a file name"],
      [["tenants", "--dir", ".", "--url", "postgres://x@h/db"], "there is no --url flag"],
      [
        ["tenant", "--schema", "tenant_acme", "--dir", ".", "--create=yes"],
        "Option '--create' does not take an argument",
      ],
    ];
    const fanOut = vi.fn(migrateTenants);
    const single = vi.fn(migrateTenantSchema);
    for (const [argv, message] of cases) {
      const err = new Buffered();
      const code = await runMigrateCli(argv, {
        stdout,
        stderr: err,
        migrateTenants: fanOut,
        migrateTenantSchema: single,
      });
      expect(code, argv.join(" ")).toBe(1);
      expect(err.text).toContain(`migrate: ${message}`);
      expect(err.text).toContain(MIGRATE_USAGE);
      expect(err.text).not.toContain("postgres://");
    }
    expect(stdout.text).toBe("");
    expect(fanOut).not.toHaveBeenCalled();
    expect(single).not.toHaveBeenCalled();
  });

  it("passes the options and DATABASE_MIGRATOR_URL to migrateTenants, prints the events and the failures, and returns its exit code [X-013 AC5] [X-013 AC6]", async () => {
    const dir = await folder({ [BASELINE_FILE]: "SELECT 1;\n" });
    const applied: TenantMigrationFileEvent = {
      set: "tenant",
      schema: "tenant_one",
      file: "0002_add_loyalty.sql",
      id: "0002_add_loyalty",
      kind: "numbered",
      phase: "expand",
      status: "applied",
      checksum: "c".repeat(64),
      transaction: true,
      executionMs: 3,
    };
    const result: MigrateTenantsResult = {
      dir,
      dirExists: true,
      report: {
        target: "0002_add_loyalty",
        total: 3,
        applied: [
          { schema: "tenant_one", files: [applied] },
          { schema: "tenant_three", files: [] },
        ],
        failed: [
          {
            schema: "tenant_two",
            file: "0002_add_loyalty.sql",
            error: { message: 'relation "loyalty_cards" already exists', code: "42P07" },
            exitCode: 1,
          },
        ],
        skipped: [],
      },
      failureRatio: 1 / 3,
      exitCode: MIGRATE_EXIT_CODES.failureRatioExceeded,
    };
    const fanOut = vi.fn<typeof migrateTenants>((options) => {
      options.onFile?.(applied);
      return Promise.resolve(result);
    });
    const code = await runMigrateCli(
      [
        "tenants",
        "--dir",
        dir,
        "--concurrency",
        "2",
        "--max-failure-ratio",
        "0.1",
        "--report",
        "out/report.json",
      ],
      {
        stdout,
        stderr,
        cwd: dir,
        env: { APP_ENV: "production", DATABASE_MIGRATOR_URL: MIGRATOR_URL },
        migrateTenants: fanOut,
      },
    );
    expect(code).toBe(3);
    expect(fanOut).toHaveBeenCalledWith(
      expect.objectContaining({
        dir,
        url: MIGRATOR_URL,
        concurrency: 2,
        maxFailureRatio: 0.1,
        report: join(dir, "out", "report.json"),
      }),
    );
    expect(stdout.text).toBe(`${JSON.stringify(applied)}\n`);
    expect(stderr.text).toBe(
      'migrate: tenant_two 0002_add_loyalty.sql failed: relation "loyalty_cards" already exists (SQLSTATE 42P07)\n' +
        "migrate: 1 of 3 tenant schema(s) failed (33.3 %), more than --max-failure-ratio 0.1 allows\n",
    );
    expect(stderr.text).not.toContain("dev_migrator");
  });

  it("uses concurrency 4 and a failure ratio of 0.1 by default, and writes no report unless asked", async () => {
    const dir = await folder({ [BASELINE_FILE]: "SELECT 1;\n" });
    const fanOut = vi.fn<typeof migrateTenants>(() =>
      Promise.resolve({
        dir,
        dirExists: true,
        report: { target: "0001_baseline", total: 0, applied: [], failed: [], skipped: [] },
        failureRatio: 0,
        exitCode: MIGRATE_EXIT_CODES.ok,
      }),
    );
    const code = await runMigrateCli(["tenants", "--dir", dir], {
      stdout,
      stderr,
      env: { APP_ENV: "production", DATABASE_MIGRATOR_URL: MIGRATOR_URL },
      migrateTenants: fanOut,
    });
    expect(code).toBe(0);
    expect(fanOut).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 4, maxFailureRatio: 0.1, report: undefined }),
    );
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe("");
  });

  it("passes --schema and --create to migrateTenantSchema and maps a checksum mismatch to exit code 2", async () => {
    const dir = await folder({ [BASELINE_FILE]: "SELECT 1;\n" });
    const changed: TenantMigrationFileEvent = {
      set: "tenant",
      schema: "tenant_acme",
      file: BASELINE_FILE,
      id: "0001_baseline",
      kind: "numbered",
      phase: "expand",
      status: "checksum_mismatch",
      checksum: "b".repeat(64),
      transaction: true,
      appliedChecksum: "a".repeat(64),
    };
    const single = vi.fn<typeof migrateTenantSchema>((options) => {
      options.onFile?.(changed);
      return Promise.reject(new TenantChecksumMismatchError("tenant_acme", [BASELINE_FILE]));
    });
    const code = await runMigrateCli(["tenant", "--schema", "tenant_acme", "--dir", dir, "--create"], {
      stdout,
      stderr,
      env: { APP_ENV: "production", DATABASE_MIGRATOR_URL: MIGRATOR_URL },
      migrateTenantSchema: single,
    });
    expect(code).toBe(MIGRATE_EXIT_CODES.checksumMismatch);
    expect(single).toHaveBeenCalledWith(
      expect.objectContaining({ schema: "tenant_acme", dir, url: MIGRATOR_URL, create: true }),
    );
    expect(stdout.text).toBe(`${JSON.stringify(changed)}\n`);
    expect(stderr.text).toMatch(
      /^migrate: 1 applied tenant migration file\(s\) changed since they were applied to tenant_acme: 0001_baseline\.sql\./,
    );

    // Without --create, create is false; ledger rows without a file are a notice.
    const quiet = vi.fn<typeof migrateTenantSchema>(() =>
      Promise.resolve({
        schema: "tenant_acme",
        dir,
        dirExists: true,
        created: false,
        applied: [],
        upToDate: 1,
        ledgerOnly: ["0002_newer"],
      }),
    );
    const err = new Buffered();
    expect(
      await runMigrateCli(["tenant", "--schema", "tenant_acme", "--dir", dir], {
        stdout,
        stderr: err,
        env: { APP_ENV: "production", DATABASE_MIGRATOR_URL: MIGRATOR_URL },
        migrateTenantSchema: quiet,
      }),
    ).toBe(0);
    expect(quiet).toHaveBeenCalledWith(expect.objectContaining({ create: false }));
    expect(err.text).toBe(
      `migrate: notice: tenant_acme.schema_migrations has 0002_newer, which is not in ${dir} (applied by another release)\n`,
    );
  });
});

describe("pnpm db:migrate:tenants", () => {
  it("runs migrate.js tenants on the repository's tenant set, after building the package", async () => {
    const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const root = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts["db:migrate:tenants"]).toBe("pnpm --filter @velexis/db run migrate:tenants");
    expect(pkg.scripts["premigrate:tenants"]).toBe("tsc -b");
    const [node, script, command, flag, dir, ...rest] = (pkg.scripts["migrate:tenants"] ?? "").split(/\s+/);
    expect([node, script, command, flag, rest]).toEqual([
      "node",
      "dist/cli/migrate.js",
      "tenants",
      "--dir",
      [],
    ]);
    const tenantDir = resolve(PACKAGE_DIR, dir ?? "");
    expect(tenantDir).toBe(join(REPO, "ota", "backend", "migrations", "tenant"));
    expect((await stat(join(tenantDir, BASELINE_FILE))).isFile()).toBe(true);
  });
});
