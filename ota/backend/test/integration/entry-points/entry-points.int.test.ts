// The three entry points as real processes, compiled exactly as `pnpm build` compiles them (tsconfig.build.json) into
// a scratch folder under the package's node_modules/.cache (ignored by git and ESLint), from where the dependencies
// resolve as from dist/. They run with NODE_ENV=production, as under systemd, so no .env.local file is read: each
// process sees only the variables a test gives it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "../../../src/config";
import { exchange } from "../../helpers/http";
import { integrationEnv } from "../env";

const OUT_DIR = join(APP_DIR, "node_modules", ".cache", `entry-points-${randomBytes(6).toString("hex")}`);
/** Compiling the package with type information takes a few seconds, more on a busy CI runner. */
const COMPILE_TIMEOUT_MS = 30_000;
const services = integrationEnv();

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Running {
  readonly exited: Promise<Exit>;
  readonly output: () => string;
  stop(): void;
}

function run(entry: string, env: Record<string, string>, args: readonly string[] = []): Running {
  const child = spawn(process.execPath, [join(OUT_DIR, entry), ...args], {
    cwd: APP_DIR,
    env: { NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<Exit>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code, signal) => resolveExit({ code, signal, stdout, stderr }));
  });
  return { exited, output: () => stdout + stderr, stop: () => void child.kill("SIGTERM") };
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The status of the first answer on the health port, polled while the process starts. */
async function waitForHealth(port: number, path: string, process: Running): Promise<number> {
  try {
    return await vi.waitFor(async () => (await exchange(port, path)).status, {
      timeout: 10_000,
      interval: 100,
    });
  } catch (error) {
    throw new Error(`no answer on ${port}${path}:\n${process.output()}`, { cause: error });
  }
}

beforeAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  const configFile = ts.readConfigFile(join(APP_DIR, "tsconfig.build.json"), (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, APP_DIR);
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    outDir: OUT_DIR,
    sourceMap: false,
  });
  const result = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual(
    [],
  );
}, COMPILE_TIMEOUT_MS);

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

describe("main.js", () => {
  it("exits 1 with a ConfigError naming DATABASE_URL when it is missing [OBE-001 AC3]", async () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = services.api;

    const exit = await run("main.js", withoutUrl).exited;

    expect(exit.code).toBe(1);
    expect(jsonLines(exit.stdout)).toEqual([
      expect.objectContaining({
        app: "ota-api",
        msg: "api.config_invalid",
        err: expect.objectContaining({
          type: "ConfigError",
          message: expect.stringContaining("DATABASE_URL is required but missing"),
        }),
      }),
    ]);
  });

  it("serves /health/ready on 127.0.0.1:4000 and stops on SIGTERM [OBE-001 AC2]", async () => {
    const api = run("main.js", services.api);
    try {
      expect(await waitForHealth(4000, "/health/ready", api)).toBe(200);
      expect((await exchange(4000, "/health/ready")).json()).toEqual({
        status: "ok",
        checks: { postgres: "ok", redis: "ok" },
      });
    } finally {
      api.stop();
    }

    const exit = await api.exited;
    // Nest closes the application, then lets SIGTERM end the process (a clean stop for systemd).
    expect(exit.signal ?? exit.code).toBe("SIGTERM");
    expect(jsonLines(exit.stdout).map((line) => line["msg"])).toContain("api.listening");
  });
});

describe("worker.js", () => {
  it("exits 1 with a ConfigError naming DATABASE_URL when it is missing [OBE-001 AC3]", async () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = services.worker;

    const exit = await run("worker.js", withoutUrl).exited;

    expect(exit.code).toBe(1);
    expect(jsonLines(exit.stdout)).toEqual([
      expect.objectContaining({
        app: "ota-worker",
        msg: "worker.config_invalid",
        err: expect.objectContaining({
          message: expect.stringContaining("DATABASE_URL is required but missing"),
        }),
      }),
    ]);
  });

  it("exits 1 without the provisioner DSN, which the API never needs [OBE-001 AC3]", async () => {
    const exit = await run("worker.js", services.api).exited;

    expect(exit.code).toBe(1);
    expect(exit.stdout).toContain("DATABASE_PROVISIONER_URL is required but missing");
  });

  it("serves /health/ready on 127.0.0.1:4001 and stops on SIGTERM [OBE-001 AC2]", async () => {
    const worker = run("worker.js", services.worker);
    try {
      expect(await waitForHealth(4001, "/health/ready", worker)).toBe(200);
    } finally {
      worker.stop();
    }

    const exit = await worker.exited;
    expect(exit.signal ?? exit.code).toBe("SIGTERM");
  });
});

describe("cli.js", () => {
  it("lists its commands on help and exits 1 on an unknown command", async () => {
    const help = await run("cli.js", {}, ["help"]).exited;
    const unknown = await run("cli.js", {}, ["nope"]).exited;

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: node dist/cli.js <command> [arguments]");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('unknown command "nope"');
  });
});
