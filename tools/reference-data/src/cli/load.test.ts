import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOAD_ORDER,
  type LoadReferenceDataOptions,
  type LoadReferenceDataResult,
  type ReferenceTable,
  type TableCounts,
} from "../load.js";
import { LOAD_USAGE, runLoadCli, type LoadCliIo } from "./load.js";

/** A dummy DSN: never a real password (AGENTS.md §8). */
const DSN = "postgres://velexis_platform_app:not-a-real-password@127.0.0.1:5432/velexis";

const COUNTS = Object.fromEntries(
  LOAD_ORDER.map((table, i) => [table, { inserted: i, updated: 0, deactivated: 0 }]),
) as Record<ReferenceTable, TableCounts>;
const RESULT: LoadReferenceDataResult = { tables: COUNTS, overrides: 1, durationMs: 42 };

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: LoadReferenceDataOptions[];
}

async function run(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  load: (options: LoadReferenceDataOptions) => Promise<LoadReferenceDataResult> = () =>
    Promise.resolve(RESULT),
  io: Partial<LoadCliIo> = {},
): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const calls: LoadReferenceDataOptions[] = [];
  const code = await runLoadCli(argv, {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    env,
    cwd: "/srv/velexis/current/reference-data",
    load: (options) => {
      calls.push(options);
      return load(options);
    },
    ...io,
  });
  return { code, stdout, stderr, calls };
}

const jsonLines = (text: string): Array<Record<string, unknown>> =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("load.js", () => {
  it("loads the folder of --data with DATABASE_URL and prints the counts as one JSON line", async () => {
    const result = await run(["--data", "data"], { APP_ENV: "test", DATABASE_URL: DSN });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.calls).toEqual([{ url: DSN, dataDir: "/srv/velexis/current/reference-data/data" }]);
    const lines = jsonLines(result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30,
      app: "reference-loader",
      env: "test",
      msg: "reference.loaded",
      dataDir: "/srv/velexis/current/reference-data/data",
      tables: COUNTS,
      overrides: 1,
      durationMs: 42,
    });
    expect(result.stdout).not.toContain("not-a-real-password");
  });

  it("labels its lines production on the VM, where velexis-deploy sets only NODE_ENV", async () => {
    const result = await run(["--data=/srv/data"], { NODE_ENV: "production", DATABASE_URL: DSN });
    expect(result.code).toBe(0);
    expect(result.calls[0]?.dataDir).toBe(resolve("/srv/data"));
    expect(jsonLines(result.stdout)[0]).toMatchObject({ env: "production", msg: "reference.loaded" });
  });

  it("reports a failed load as one error line and exits 1, without the DSN", async () => {
    const failure = Object.assign(new Error("upsert of reference.currencies failed: permission denied"), {
      code: "42501",
    });
    const result = await run(["--data", "data"], { APP_ENV: "test", DATABASE_URL: DSN }, () =>
      Promise.reject(failure),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const lines = jsonLines(result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 50,
      msg: "reference.load_failed",
      err: { type: "Error", code: "42501", message: failure.message },
    });
    expect(result.stdout).not.toContain("not-a-real-password");
    expect(result.stdout).not.toContain(DSN);
  });

  it("refuses to run without DATABASE_URL, naming the variable", async () => {
    // APP_ENV=production: no dev env file is read, whatever the developer's .env.local holds.
    const result = await run(["--data", "data"], { APP_ENV: "production" });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^load: Invalid configuration \(1 problem\):\n {2}- DATABASE_URL /);
  });

  it("never prints the value of an invalid DATABASE_URL", async () => {
    const result = await run(["--data", "data"], {
      APP_ENV: "production",
      DATABASE_URL: "mysql://root:not-a-real-password@127.0.0.1/velexis",
    });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.stderr).not.toContain("not-a-real-password");
  });

  it.each([
    [["--url", DSN, "--data", "data"], "there is no --url flag"],
    [[`--url=${DSN}`], "there is no --url flag"],
    [[], "missing --data <dir>"],
    [["--data", " "], "missing --data <dir>"],
    [["--data"], "--data"],
    [["--data", "data", "extra"], "extra"],
    [["--force"], "--force"],
  ])("refuses the arguments %j with the usage", async (argv, message) => {
    const result = await run(argv, { APP_ENV: "test", DATABASE_URL: DSN });
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain(LOAD_USAGE);
    expect(result.stderr).not.toContain("not-a-real-password");
  });

  it("prints the usage for --help and loads nothing", async () => {
    const result = await run(["--help"], {});
    expect(result).toMatchObject({ code: 0, stdout: LOAD_USAGE, stderr: "", calls: [] });
  });

  it("resolves a relative --data against the current directory", async () => {
    const result = await run(["--data", join("..", "data")], { APP_ENV: "test", DATABASE_URL: DSN });
    expect(result.calls[0]?.dataDir).toBe("/srv/velexis/current/data");
  });
});
