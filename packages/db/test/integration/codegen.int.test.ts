// `pnpm db:codegen` against PostgreSQL 16 (X-014; ADR-0005 Query layer item 2).
//
// beforeAll builds the package (`tsc -b`, the `precodegen` script: scripts/codegen.mjs uses the runner of dist/),
// then runs `node scripts/codegen.mjs --out <temporary folder>` twice, as `pnpm db:codegen` runs it, so the
// committed src/generated files are never touched. Each run creates its own scratch database
// `velexis_codegen_<pid>` as TEST_DATABASE_ADMIN_URL (the environment, or .env.local through @velexis/config),
// migrates it with the repository's platform, reference and tenant sets, and drops it.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = resolve(__dirname, "..", "..");
const GENERATED_DIR = join(PACKAGE_DIR, "src", "generated");
const TSC = join(PACKAGE_DIR, "node_modules", "typescript", "bin", "tsc");
const FILES = ["platform.ts", "reference.ts", "tenant.ts"];

/** Temporary output folders, removed after the file. */
const temporaryDirs: string[] = [];
/** The two runs of beforeAll. */
const runs: Run[] = [];

interface Run {
  readonly pid: number;
  readonly out: string;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node <args>` in packages/db and resolves with its output; rejects with stderr when it fails. */
function node(args: readonly string[]): Promise<{ pid: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(process.execPath, args, { cwd: PACKAGE_DIR }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`node ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolvePromise({ pid: child.pid ?? -1, stdout, stderr });
    });
  });
}

async function codegen(): Promise<Run> {
  const out = await mkdtemp(join(tmpdir(), "velexis-codegen-"));
  temporaryDirs.push(out);
  const { pid, stdout, stderr } = await node(["scripts/codegen.mjs", "--out", out]);
  return { pid, out, stdout, stderr };
}

async function readGenerated(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const file of FILES) {
    files[file] = await readFile(join(dir, file), "utf8");
  }
  return files;
}

/** The number of tables in the database interface of a generated file (its member lines). */
function tableCount(source: string, name: string): number {
  const body = new RegExp(`^export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}$`, "m").exec(source)?.[1];
  return body === undefined ? 0 : body.split("\n").filter((line) => /^ {2}\S.*;$/.test(line)).length;
}

function adminUrl(): string {
  loadDevEnvFiles({ appDir: PACKAGE_DIR });
  const config = defineConfig({
    TEST_DATABASE_ADMIN_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  });
  return config.TEST_DATABASE_ADMIN_URL;
}

beforeAll(async () => {
  await node([TSC, "-b"]);
  runs.push(await codegen());
  runs.push(await codegen());
}, 180_000);

afterAll(async () => {
  for (const dir of temporaryDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("scripts/codegen.mjs", () => {
  it("[X-014 AC1] two runs give identical files, equal to the committed src/generated", async () => {
    const [first, second] = runs;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect((await readdir(first?.out ?? "")).sort()).toEqual(FILES);
    const firstFiles = await readGenerated(first?.out ?? "");
    expect(await readGenerated(second?.out ?? "")).toEqual(firstFiles);
    expect(await readGenerated(GENERATED_DIR)).toEqual(firstFiles);
  });

  it("reports the tables of each schema and prints no connection string", async () => {
    const { password } = new URL(adminUrl());
    const files = await readGenerated(GENERATED_DIR);
    const counts = [
      tableCount(files["platform.ts"] ?? "", "PlatformDatabase"),
      tableCount(files["reference.ts"] ?? "", "ReferenceDatabase"),
      tableCount(files["tenant.ts"] ?? "", "TenantTables"),
    ];
    // The baselines create 16 platform and 7 reference tables, plus the ledger the runner adds to each schema, and
    // 42 tenant tables, the ledger included; later migrations add to them.
    expect(counts[0]).toBeGreaterThanOrEqual(17);
    expect(counts[1]).toBeGreaterThanOrEqual(8);
    expect(counts[2]).toBeGreaterThanOrEqual(42);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.stdout).toContain(
        `db:codegen: ${counts[0]} tables in platform.ts, ${counts[1]} tables in reference.ts, ` +
          `${counts[2]} tables in tenant.ts.`,
      );
      expect(run.stderr).toBe("");
      const output = `${run.stdout}${run.stderr}`;
      expect(output).not.toMatch(/postgres(?:ql)?:\/\//);
      if (password !== "") {
        expect(output).not.toContain(password);
      }
    }
  });

  it("drops its scratch database velexis_codegen_<pid>", async () => {
    const client = new pg.Client({ connectionString: adminUrl(), application_name: "velexis-db-int-test" });
    await client.connect();
    try {
      const names = runs.map((run) => `velexis_codegen_${run.pid}`);
      const { rows } = await client.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
        [names],
      );
      expect(runs.every((run) => run.pid > 0)).toBe(true);
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
