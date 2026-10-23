// The three entry points as real processes, compiled exactly as `pnpm build` compiles them (tsconfig.build.json) into
// a scratch folder under the package's node_modules/.cache (ignored by git and ESLint), from where the dependencies
// resolve as from dist/. The scratch folder has the layout of the release folder (ADR-0023): the compiled `dist/` next
// to copies of `openapi/` and `migrations/`, which the processes read from their package folder (the API parses the
// OpenAPI document at start-up, OBE-010). They run with NODE_ENV=production, as under systemd, so no .env.local file
// is read: each process sees only the variables a test gives it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "../../../src/config";
import { exchange } from "../../helpers/http";
import { integrationEnv } from "../env";

const PACKAGE_DIR = join(APP_DIR, "node_modules", ".cache", `entry-points-${randomBytes(6).toString("hex")}`);
const OUT_DIR = join(PACKAGE_DIR, "dist");
/** The folders of the package's published files that the processes read at run time. */
const RUNTIME_FOLDERS = ["openapi", "migrations"] as const;
/**
 * The files `pnpm build` copies from `src/` into `dist/` beside the compiled code (package.json's build script): the
 * API reads the breached-password list when its identity module is built (OBE-032), the worker the e-mail templates.
 */
const BUILD_ASSETS = ["notifications/templates", "identity/breached-passwords.txt"] as const;
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
  for (const folder of RUNTIME_FOLDERS) {
    cpSync(join(APP_DIR, folder), join(PACKAGE_DIR, folder), { recursive: true });
  }
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
  for (const asset of BUILD_ASSETS) {
    cpSync(join(APP_DIR, "src", asset), join(OUT_DIR, asset), {
      recursive: true,
      filter: (path) => !path.endsWith(".ts"),
    });
  }
}, COMPILE_TIMEOUT_MS);

afterAll(() => {
  rmSync(PACKAGE_DIR, { recursive: true, force: true });
});

/**
 * Each process loads the application's modules in about a second, several times that on a loaded runner, and the
 * health checks below give a starting process 10 s to answer (`waitForHealth`). The processes of a describe block
 * run in its setup hook with this budget, never inside a test's 5 s, and the tests assert on what they gave.
 */
const PROCESSES_TIMEOUT_MS = 60_000;

/** What a process serving health checks gave: the first status, the body of /health/ready, how it ended. */
interface Served {
  readonly status: number;
  readonly body: unknown;
  readonly exit: Exit;
}

/** Starts `entry`, waits for its first answer on `port`, reads /health/ready once more, then stops it with SIGTERM. */
async function serveHealth(entry: string, env: Record<string, string>, port: number): Promise<Served> {
  const started = run(entry, env);
  let status: number;
  let body: unknown;
  try {
    status = await waitForHealth(port, "/health/ready", started);
    body = (await exchange(port, "/health/ready")).json();
  } finally {
    started.stop();
  }
  return { status, body, exit: await started.exited };
}

describe("main.js", () => {
  let missingUrl: Exit;
  let served: Served;

  beforeAll(async () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = services.api;
    missingUrl = await run("main.js", withoutUrl).exited;
    // 127.0.0.1:4000 is the API's default port (OBE-001 AC2): integration files never run at the same time.
    served = await serveHealth("main.js", services.api, 4000);
  }, PROCESSES_TIMEOUT_MS);

  it("exits 1 with a ConfigError naming DATABASE_URL when it is missing [OBE-001 AC3]", () => {
    const exit = missingUrl;

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

  it("serves /health/ready on 127.0.0.1:4000 and stops on SIGTERM [OBE-001 AC2]", () => {
    expect(served.status).toBe(200);
    expect(served.body).toEqual({
      status: "ok",
      checks: { postgres: "ok", redis: "ok" },
    });

    const { exit } = served;
    // Nest closes the application, then lets SIGTERM end the process (a clean stop for systemd).
    expect(exit.signal ?? exit.code).toBe("SIGTERM");
    expect(jsonLines(exit.stdout).map((line) => line["msg"])).toContain("api.listening");
  });
});

describe("worker.js", () => {
  let missingUrl: Exit;
  let missingProvisioner: Exit;
  let served: Served;

  beforeAll(async () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = services.worker;
    missingUrl = await run("worker.js", withoutUrl).exited;
    missingProvisioner = await run("worker.js", services.api).exited;
    // 127.0.0.1:4001 is the worker's default health port (OBE-001 AC2).
    served = await serveHealth("worker.js", services.worker, 4001);
  }, PROCESSES_TIMEOUT_MS);

  it("exits 1 with a ConfigError naming DATABASE_URL when it is missing [OBE-001 AC3]", () => {
    const exit = missingUrl;

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

  it("exits 1 without the provisioner DSN, which the API never needs [OBE-001 AC3]", () => {
    const exit = missingProvisioner;

    expect(exit.code).toBe(1);
    expect(exit.stdout).toContain("DATABASE_PROVISIONER_URL is required but missing");
  });

  it("serves /health/ready on 127.0.0.1:4001 and stops on SIGTERM [OBE-001 AC2]", () => {
    expect(served.status).toBe(200);

    const { exit } = served;
    expect(exit.signal ?? exit.code).toBe("SIGTERM");
  });
});

describe("cli.js", () => {
  let help: Exit;
  let unknown: Exit;

  beforeAll(async () => {
    help = await run("cli.js", {}, ["help"]).exited;
    unknown = await run("cli.js", {}, ["nope"]).exited;
  }, PROCESSES_TIMEOUT_MS);

  it("lists its commands on help and exits 1 on an unknown command", () => {
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: node dist/cli.js <command> [arguments]");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('unknown command "nope"');
  });
});
