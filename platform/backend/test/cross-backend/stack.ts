// The cross-backend stack of `pnpm --filter @velexis/platform-backend test:xb` (PBE-035; PADR-0017 item 2,
// platform/docs/flows/provisioning.md "Tests that prove it"). PBE-036 and PFE-019 reuse it. One stack per test file,
// started in a `beforeAll` hook with an explicit timeout:
//
//   const stack = await startStack();                       // the steps below, or a clear error
//   const owner = await signUpOwner(stack, { label: "xb-owner", ip: "203.0.113.35" });
//   const ota = await createOta(stack, owner, { key: "acme", name: "Acme Travel" });
//   const setup = await waitForSetup(stack, owner, ota.tenantId);   // `active` within 60 s, or a clear error
//   await stack.stop();                                     // in afterAll
//
// `startStack` runs, in this order:
//
//   1. **The gate.** The OTA side is the BUILT OTA backend: `ota/backend/dist/worker.js` (PADR-0017 item 2). In CI,
//      test:xb runs after the `Build` step, because `pnpm test:int` builds only each package's dependencies and
//      ota/backend is none of platform/backend's. When an entry point is missing, `startStack` throws
//      `OtaBuildMissingError` before it creates a database or starts a process: a clear failure that names the build
//      command, never a timeout.
//   2. **The platform API** on one `createTestDatabase()` clone and one Redis database (`useRedis()`):
//      `createTestApp()` of test/support/app.ts (the application of main.ts with its own JWT key and key folder) on
//      the real Clock, as dist/main.js runs. The platform side runs from its sources, as in `pnpm test:int`, so
//      test:xb needs only the OTA build.
//   3. **Reference rows** the journeys need beyond the template's fixture: the time zone `Europe/Paris` (the fixture
//      has none), as `pnpm db:seed:reference` would load it, written as velexis_platform_app.
//   4. **The Amadeus stub** in this process (`@velexis/testing/amadeus`, a free port) and **`dev:seed`** (PBE-034)
//      run in-process as `node dist/cli.js dev:seed` runs it: the platform admin, the verified Velexis test Amadeus
//      account at the stub and its ten test offices, so provisioning can assign an office. Its stdout holds the new
//      admin's password and TOTP URI: it is dropped, never printed; only its stderr appears in an error.
//   5. **The platform worker**: the module graph of dist/worker.js (WorkerModule, its processors and schedulers) on
//      the same database, Redis database and key folder, on the real Clock.
//   6. **The OTA worker**: `node ota/backend/dist/worker.js`, a child process, with DATABASE_URL of velexis_ota_app
//      and DATABASE_PROVISIONER_URL of velexis_provisioner on the same clone (ADR-0004, OADR-0007 item 2), the same
//      Redis database, the platform's key folder (the OTA zone holds identical copies of the KEK and the API key
//      pepper, ADR-0010) and a free HEALTH_PORT. It is ready when `GET /health/ready` answers 200; when it exits
//      first, or is not ready within 60 s, `startStack` fails with its last output lines.
//
// The OTA process gets its environment from the `.env.example` files (the root one, then ota/backend's), without
// the DSNs of the development database, with the stack's values on top, and nothing else: no variable of this
// process (CI's job DSNs included) reaches it, and the migrator's DSN never does (OADR-0007, ADR-0021). The OTA
// backend's config still fills unset variables from a developer's `.env.local` files (`loadDevEnvFiles`, APP_ENV
// `test`), and `cp .env.example .env.local` puts the migrator's DSN there: so the DSNs an OTA process must not hold
// get empty values (OTA_BLANKED_DSNS), which @velexis/config treats as unset and `loadDevEnvFiles` never fills, and
// only the worker gets the provisioner's. The values are the dummy development values of those files and fresh test
// keys; nothing here is a secret. Its output (redacted JSON lines) is kept in memory, and the last lines appear in
// every error about it.
//
// `stop()` stops the OTA processes (SIGTERM, SIGKILL after 10 s), the platform worker, the stub and the API, then
// drops the database (createTestApp's `close()`). Test-only code: nothing under src/ imports it.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { Test, type TestingModule } from "@nestjs/testing";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import { extractLinks, mailpit, uniqueEmail, type MailpitMessage } from "@velexis/testing/mailpit";
import type { Response } from "supertest";
import { runCli } from "../../src/cli";
import { Clock } from "../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../src/common/database";
import { APP_DIR, createProcessLogger, PLATFORM_PROCESSES } from "../../src/config";
import { WorkerModule } from "../../src/worker.module";
import { TEST_TERMS_VERSION } from "../builders/accounts";
import {
  createTestApp,
  LogSink,
  TEST_BFF_KEY,
  TEST_STOREFRONT_BASE_DOMAIN,
  type TestApp,
} from "../support/app";
import { TEST_MAIL_ENV } from "../support/master-key";

/** The repository root (this file is platform/backend/test/cross-backend/stack.ts). */
export const REPO_ROOT = resolve(APP_DIR, "..", "..");

/** The OTA backend whose built entry points the stack runs. */
export const OTA_BACKEND_DIR = join(REPO_ROOT, "ota", "backend");

/** The command that builds them (`ota/backend/package.json`). */
export const OTA_BUILD_COMMAND = "pnpm --filter @velexis/ota-backend build";

/** The built OTA worker, relative to the OTA backend folder. */
export const OTA_WORKER_ENTRY = "dist/worker.js";

/** Every app of the stack listens on the loopback interface only, as on the VM. */
export const STACK_HOST = "127.0.0.1";

/** The time zone the stack adds to the reference fixture, for createTenant. */
export const STACK_TIME_ZONE = "Europe/Paris";

/** The country and currency of the OTAs `createOta` creates: both in the reference fixture of @velexis/testing. */
export const STACK_COUNTRY = "FR";
export const STACK_CURRENCY = "EUR";

/** How long an OTA process may take to answer its readiness check. */
export const OTA_READY_TIMEOUT_MS = 60_000;

/** The acceptance bound of a new OTA's setup (PBE-035 AC1): `active` within 60 seconds. */
export const SETUP_TIMEOUT_MS = 60_000;

/** How long the worker may take to deliver an e-mail to Mailpit. */
export const MAIL_TIMEOUT_MS = 20_000;

/** The subject of the verification e-mail (src/notifications/templates). */
export const VERIFY_SUBJECT = "Confirm your e-mail address for Velexis";

/**
 * The pause between two reads of the setup progress (getProvisioning), for `waitForSetup` and for a test that waits
 * for a later step. Every read counts against the `authenticated` limit of the account (300 per fixed minute,
 * src/common/http/throttler.config.ts): at one read per 250 ms, 60 s of reads are 240, so a setup that keeps to its
 * 60 s bound, plus the reads after it in the same minute at this pace, stays under the limit and never meets a 429.
 */
export const SETUP_POLL_MS = 250;

/** How long an OTA process may take to exit after SIGTERM before it gets SIGKILL. */
const STOP_TIMEOUT_MS = 10_000;
/** The pause between two readiness checks. */
const POLL_MS = 250;
/** How many output lines of an OTA process are kept, and how many an error shows. */
const OUTPUT_LINES_KEPT = 400;
const OUTPUT_LINES_SHOWN = 40;

// ---- The gate --------------------------------------------------------------------------------------------------

/** An entry point of the OTA backend is not built: test:xb runs the built OTA backend (PADR-0017 item 2). */
export class OtaBuildMissingError extends Error {
  override readonly name = "OtaBuildMissingError";

  constructor(readonly missing: readonly string[]) {
    super(
      `test:xb runs the built OTA backend, and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
        `missing. Build it first: ${OTA_BUILD_COMMAND} (in CI, test:xb runs after the Build step).`,
    );
  }
}

/**
 * Throws `OtaBuildMissingError` naming every entry of `entries` (relative to `otaBackendDir`) that cannot be read,
 * relative to the repository root when inside it (`ota/backend/dist/worker.js`). Synchronous: it runs before anything
 * is started.
 */
export function assertOtaBuilt(
  otaBackendDir: string = OTA_BACKEND_DIR,
  entries: readonly string[] = [OTA_WORKER_ENTRY],
): void {
  const missing = entries
    .map((entry) => resolve(otaBackendDir, entry))
    .filter((path) => {
      try {
        accessSync(path, constants.R_OK);
        return false;
      } catch {
        return true;
      }
    })
    .map((path) => (path.startsWith(`${REPO_ROOT}${sep}`) ? relative(REPO_ROOT, path) : path));
  if (missing.length > 0) {
    throw new OtaBuildMissingError(missing);
  }
}

// ---- Settings and environments ---------------------------------------------------------------------------------

/**
 * The services of the environment the stack does not start: Mailpit's SMTP port (the platform worker sends there)
 * and its API (read by `@velexis/testing/mailpit`). CI sets them on the job; locally they come from the environment
 * or the `.env.local` files, as for `pnpm test:int`. PostgreSQL (TEST_DATABASE_ADMIN_URL) and Redis (REDIS_URL) are
 * read by `createTestDatabase()` and `useRedis()`.
 */
const STACK_SETTINGS_SCHEMA = {
  SMTP_URL: env.url({ protocols: ["smtp:", "smtps:"] }),
  MAILPIT_API_URL: env.url({ protocols: ["http:", "https:"] }),
} as const;

function readSettings(): { readonly SMTP_URL: string; readonly MAILPIT_API_URL: string } {
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(STACK_SETTINGS_SCHEMA);
}

/** The `.env.example` files of the OTA processes, root first: a later file wins, as `<app>/.env.local` does. */
const OTA_EXAMPLE_ENV_FILES = [".env.example", "ota/backend/.env.example"] as const;

/**
 * DSNs no OTA process takes from the `.env.example` files, which name the development database `velexis`: each gets
 * the clone's DSN of its own role instead. The migrator's and the test admin's are never given to an app.
 */
const WITHHELD = [
  "DATABASE_URL",
  "DATABASE_MIGRATOR_URL",
  "DATABASE_PROVISIONER_URL",
  "TEST_DATABASE_ADMIN_URL",
] as const;

/**
 * The withheld DSNs every OTA process gets as empty values: @velexis/config treats an empty value as unset, and
 * `loadDevEnvFiles` fills only variables that are not set at all, so a developer's `.env.local` cannot add them. The
 * OTA worker's spec sets DATABASE_PROVISIONER_URL over this; DATABASE_URL is always the stack's.
 */
export const OTA_BLANKED_DSNS: Readonly<Record<string, "">> = Object.freeze({
  DATABASE_MIGRATOR_URL: "",
  DATABASE_PROVISIONER_URL: "",
  TEST_DATABASE_ADMIN_URL: "",
});

/** The variables of `files` (relative to the repository root) without the withheld DSNs; a later file wins. */
export function exampleEnv(files: readonly string[]): Record<string, string> {
  const withheld: readonly string[] = WITHHELD;
  const values: Record<string, string> = {};
  for (const file of files) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(join(REPO_ROOT, file), "utf8")))) {
      if (value !== undefined && !withheld.includes(name)) {
        values[name] = value;
      }
    }
  }
  return values;
}

/** A TCP port of 127.0.0.1 that nothing listens on (now). */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(0, STACK_HOST, listening);
  });
  const address = server.address();
  await new Promise<void>((closed) => server.close(() => closed()));
  if (address === null || typeof address === "string") {
    throw new Error("freePort: no TCP address");
  }
  return address.port;
}

// ---- OTA processes ---------------------------------------------------------------------------------------------

/** One process of the built OTA backend, while it runs. */
export interface OtaProcess {
  /** `ota-worker` (PBE-035); PBE-036 adds the API. */
  readonly name: string;
  /** The port its readiness check answers on (HEALTH_PORT of the worker). */
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The last lines it wrote to stdout and stderr, oldest first (redacted JSON log lines). */
  output(): readonly string[];
  /** How it ended (`exited with code 1`, `was stopped by SIGTERM`), or `undefined` while it runs. */
  exitDescription(): string | undefined;
  /** SIGTERM, then SIGKILL after 10 s; resolves when it has exited. Idempotent. */
  stop(): Promise<void>;
}

/** What `startOtaProcess` starts. */
export interface OtaProcessSpec {
  readonly name: string;
  /** The built entry point, relative to the OTA backend folder (`dist/worker.js`). */
  readonly entry: string;
  /** The port of its readiness check; set in `env` too (HEALTH_PORT or PORT). */
  readonly port: number;
  /** Its whole environment: nothing of this process's environment is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** Default: OTA_BACKEND_DIR. */
  readonly otaBackendDir?: string;
}

/** The last `OUTPUT_LINES_SHOWN` lines of `process`, for an error message. */
export function outputTail(process: Pick<OtaProcess, "output">): string {
  const lines = process.output().slice(-OUTPUT_LINES_SHOWN);
  return lines.length === 0 ? "(no output)" : lines.join("\n");
}

/** Keeps the last OUTPUT_LINES_KEPT lines written to a stream. */
class OutputBuffer {
  private readonly lines: string[] = [];
  private partial = "";

  write(chunk: Buffer): void {
    const parts = (this.partial + chunk.toString("utf8")).split("\n");
    this.partial = parts.pop() ?? "";
    this.push(parts);
  }

  snapshot(): readonly string[] {
    return this.partial === "" ? [...this.lines] : [...this.lines, this.partial];
  }

  private push(lines: readonly string[]): void {
    this.lines.push(...lines.filter((line) => line.trim() !== ""));
    if (this.lines.length > OUTPUT_LINES_KEPT) {
      this.lines.splice(0, this.lines.length - OUTPUT_LINES_KEPT);
    }
  }
}

/**
 * Starts `node <entry>` of the built OTA backend and resolves when `GET /health/ready` answers 200. Rejects (after
 * stopping it) when it exits first or is not ready within OTA_READY_TIMEOUT_MS, with its last output lines.
 */
export async function startOtaProcess(spec: OtaProcessSpec): Promise<OtaProcess> {
  const dir = spec.otaBackendDir ?? OTA_BACKEND_DIR;
  assertOtaBuilt(dir, [spec.entry]);
  const output = new OutputBuffer();
  const child: ChildProcess = spawn(process.execPath, ["--enable-source-maps", join(dir, spec.entry)], {
    cwd: dir,
    env: { ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.write(chunk));
  let exitDescription: string | undefined;
  const exited = new Promise<void>((done) => {
    child.once("exit", (code, signal) => {
      exitDescription = signal === null ? `exited with code ${code}` : `was stopped by ${signal}`;
      done();
    });
    child.once("error", (error) => {
      exitDescription = `could not start: ${error.message}`;
      done();
    });
  });
  // A last resort when the test process ends without its afterAll (a crash, process.exit): no OTA process outlives it.
  const kill = (): void => {
    if (exitDescription === undefined) {
      child.kill("SIGKILL");
    }
  };
  process.once("exit", kill);

  let stopping: Promise<void> | undefined;
  const url = `http://${STACK_HOST}:${spec.port}`;
  const running: OtaProcess = {
    name: spec.name,
    port: spec.port,
    url,
    output: () => output.snapshot(),
    exitDescription: () => exitDescription,
    stop: () => {
      stopping ??= (async () => {
        if (exitDescription === undefined) {
          child.kill("SIGTERM");
          // An unreferenced timer: it never keeps the test process alive once the child has exited.
          const stopped = await Promise.race([
            exited.then(() => true),
            delay(STOP_TIMEOUT_MS, false, { ref: false }),
          ]);
          if (!stopped) {
            child.kill("SIGKILL");
          }
        }
        await exited;
        process.off("exit", kill);
      })();
      return stopping;
    },
  };

  const readyUrl = `${url}/health/ready`;
  const started = performance.now();
  let last = "no answer yet";
  while (performance.now() - started < OTA_READY_TIMEOUT_MS) {
    if (exitDescription !== undefined) {
      await running.stop();
      throw new Error(
        `The ${spec.name} (${join("ota/backend", spec.entry)}) ${exitDescription} before it was ready. ` +
          `Its last output:\n${outputTail(running)}`,
      );
    }
    try {
      const response = await fetch(readyUrl, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
      await response.body?.cancel();
      if (response.status === 200) {
        return running;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(POLL_MS);
  }
  await running.stop();
  throw new Error(
    `The ${spec.name} was not ready within ${OTA_READY_TIMEOUT_MS / 1000} s (GET ${readyUrl}: ${last}). ` +
      `Its last output:\n${outputTail(running)}`,
  );
}

// ---- The stack -------------------------------------------------------------------------------------------------

export interface StartStackOptions {
  /** The OTA backend folder whose built entry points run; default the repository's ota/backend. */
  readonly otaBackendDir?: string;
  /** Variables over the platform API's and worker's test defaults (createTestApp's `env`). */
  readonly env?: Readonly<Record<string, string>>;
}

/** A started stack (see the file header). */
export interface Stack {
  /**
   * The platform API: `api.http` (Supertest), `api.bffHeaders(ip)`, `api.db` (the clone), `api.redis`, `api.config`,
   * `api.logs`. The application runs on the real Clock; `api.clock`, createTestApp's FakeClock, is not used.
   */
  readonly api: TestApp;
  /** velexis_platform_app's pool of the API, for reading platform rows. */
  readonly pool: PlatformPool;
  /** The platform worker's module graph. */
  readonly worker: TestingModule;
  /** What the platform worker logged (the API's lines are in `api.logs`). */
  readonly workerLogs: LogSink;
  /** The Amadeus stub (`AMADEUS_BASE_URL_TEST` of the stack). */
  readonly amadeusStub: AmadeusStub;
  /** The OTA worker (ota/backend/dist/worker.js). */
  readonly otaWorker: OtaProcess;
  /** The environment the OTA processes start from: `.env.example` values and the stack's (see the file header). */
  otaEnv(): Record<string, string>;
  /** Stops everything and drops the database (see the file header). Idempotent. */
  stop(): Promise<void>;
}

/** Runs `dev:seed` in-process (src/cli.ts, as `node dist/cli.js dev:seed`); throws with its stderr unless it exits 0. */
async function runDevSeed(cliEnv: Record<string, string>): Promise<void> {
  let stderr = "";
  const code = await runCli(["dev:seed"], {
    // stdout holds the new admin's password and TOTP set-up URI: dropped, never printed or kept.
    stdout: { write: () => true },
    // Its problems and log lines (redacted, no secret): for the error below.
    stderr: { write: (text: string) => (stderr += text) },
    env: cliEnv,
  });
  if (code !== 0) {
    throw new Error(`dev:seed exited with ${code}:\n${stderr}`);
  }
}

/** Starts the stack (steps 1 to 6 of the file header). On a failure it stops what it started and rethrows. */
export async function startStack(options: StartStackOptions = {}): Promise<Stack> {
  const otaBackendDir = options.otaBackendDir ?? OTA_BACKEND_DIR;
  assertOtaBuilt(otaBackendDir, [OTA_WORKER_ENTRY]);
  const settings = readSettings();

  const cleanups: Array<() => Promise<void>> = [];
  const cleanUp = async (): Promise<void> => {
    const problems: string[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup().catch((error: unknown) => problems.push(String(error)));
    }
    if (problems.length > 0) {
      throw new Error(`The cross-backend stack did not stop cleanly:\n  - ${problems.join("\n  - ")}`);
    }
  };

  try {
    const api = await createTestApp({
      // The real Clock, as dist/main.js runs: the OTA worker and PostgreSQL run on real time too.
      overrides: [{ provide: Clock, useValue: new Clock() }],
      env: { SMTP_URL: settings.SMTP_URL, OPS_ALERT_EMAIL: uniqueEmail("ops-xb"), ...options.env },
    });
    cleanups.push(() => api.close());
    const pool = api.app.get<PlatformPool>(PLATFORM_POOL);
    await pool.query(
      "INSERT INTO reference.time_zones (name, country_code, utc_offset_minutes, dst_offset_minutes) " +
        "VALUES ($1, $2, 60, 120) ON CONFLICT DO NOTHING",
      [STACK_TIME_ZONE, STACK_COUNTRY],
    );

    const amadeusStub = await startAmadeusStub();
    cleanups.push(() => amadeusStub.stop());
    const { config } = api;
    await runDevSeed({
      APP_ENV: "test",
      LOG_LEVEL: "info",
      DATABASE_URL: api.db.urlFor("platform"),
      REDIS_URL: api.redis.url,
      PLATFORM_BFF_KEY: TEST_BFF_KEY,
      JWT_PRIVATE_KEY_FILE: config.JWT_PRIVATE_KEY_FILE,
      MASTER_KEY_DIR: config.MASTER_KEY_DIR,
      MASTER_KEY_CURRENT: config.MASTER_KEY_CURRENT,
      API_KEY_PEPPER_FILE: config.API_KEY_PEPPER_FILE,
      ...TEST_MAIL_ENV,
      SMTP_URL: settings.SMTP_URL,
      OPS_ALERT_EMAIL: config.OPS_ALERT_EMAIL,
      STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
      AMADEUS_BASE_URL_TEST: amadeusStub.url,
    });

    const workerLogs = new LogSink();
    const worker = await Test.createTestingModule({
      imports: [
        WorkerModule.forRoot(config, createProcessLogger(PLATFORM_PROCESSES.worker, config, workerLogs)),
      ],
    }).compile();
    await worker.init();
    cleanups.push(() => worker.close());

    const otaEnv = (): Record<string, string> => ({
      ...exampleEnv(OTA_EXAMPLE_ENV_FILES),
      ...OTA_BLANKED_DSNS,
      APP_ENV: "test",
      LOG_LEVEL: "info",
      DATABASE_URL: api.db.urlFor("ota"),
      REDIS_URL: api.redis.url,
      MASTER_KEY_DIR: config.MASTER_KEY_DIR,
      MASTER_KEY_CURRENT: config.MASTER_KEY_CURRENT,
      API_KEY_PEPPER_FILE: config.API_KEY_PEPPER_FILE,
      SMTP_URL: settings.SMTP_URL,
      MAILPIT_API_URL: settings.MAILPIT_API_URL,
      STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
      AMADEUS_BASE_URL_TEST: amadeusStub.url,
      AMADEUS_BASE_URL_LIVE: amadeusStub.url,
    });
    const healthPort = await freePort();
    const otaWorker = await startOtaProcess({
      name: "ota-worker",
      entry: OTA_WORKER_ENTRY,
      port: healthPort,
      otaBackendDir,
      env: {
        ...otaEnv(),
        // The worker alone holds the provisioner's DSN (ADR-0004, OADR-0007 item 2).
        DATABASE_PROVISIONER_URL: api.db.urlFor("provisioner"),
        HEALTH_PORT: String(healthPort),
      },
    });
    cleanups.push(() => otaWorker.stop());

    let stopped: Promise<void> | undefined;
    return {
      api,
      pool,
      worker,
      workerLogs,
      amadeusStub,
      otaWorker,
      otaEnv,
      stop: () => (stopped ??= cleanUp()),
    };
  } catch (error) {
    await cleanUp().catch(() => undefined);
    throw error;
  }
}

// ---- Journeys through the platform API -------------------------------------------------------------------------

/** `<status>`, or `<status> <code>` of an error answer: never a body value (it may hold a token). */
export function outcomeOf(res: Pick<Response, "status" | "body">): string {
  const code = (res.body as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === "string" ? `${res.status} ${code}` : String(res.status);
}

function expectStatus(res: Response, status: number, operation: string): void {
  if (res.status !== status) {
    throw new Error(`${operation} answered ${outcomeOf(res)}, not ${status}`);
  }
}

/** A verified, signed-in portal account. */
export interface PortalOwner {
  readonly email: string;
  readonly accountId: string;
  /** The bearer and the PADR-0019 headers of a portal call from `ip`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The answers of the journey, for contract checks. */
  readonly responses: {
    readonly signUp: Response;
    readonly verifyEmail: Response;
    readonly signIn: Response;
  };
}

/** The token of the message's `/verify-email` link of the portal. */
function verificationToken(stack: Stack, message: Pick<MailpitMessage, "HTML" | "Text">): string {
  const prefix = `${stack.api.config.PUBLIC_PORTAL_URL.replace(/\/$/, "")}/verify-email?token=`;
  const link = extractLinks(message).find((url) => url.startsWith(prefix));
  const token = link === undefined ? null : new URL(link).searchParams.get("token");
  if (token === null) {
    throw new Error("the verification e-mail has no /verify-email link");
  }
  return token;
}

/**
 * Signs up a new account through the API (`signUp`), verifies its address with the token of the e-mail that the
 * platform worker sent to Mailpit (`verifyEmail`), and signs it in (`signIn`). The address is `uniqueEmail(label)`,
 * the password a new random one (never logged), and every call comes from end-user `ip`.
 */
export async function signUpOwner(
  stack: Stack,
  {
    label,
    ip,
    fullName = "Ada Lovelace",
  }: { readonly label: string; readonly ip: string; readonly fullName?: string },
): Promise<PortalOwner> {
  const { http } = stack.api;
  const bff = stack.api.bffHeaders(ip);
  const email = uniqueEmail(label);
  const password = `Xb-${randomBytes(18).toString("base64url")}`;

  const signUp = await http
    .post("/v1/auth/sign-up")
    .set(bff)
    .send({ email, password, fullName, acceptTerms: true, termsVersion: TEST_TERMS_VERSION });
  expectStatus(signUp, 202, "signUp");
  const message = await mailpit.waitForMessage({
    to: email,
    subject: VERIFY_SUBJECT,
    timeoutMs: MAIL_TIMEOUT_MS,
  });
  const verifyEmail = await http
    .post("/v1/auth/verify-email")
    .set(bff)
    .send({ token: verificationToken(stack, message) });
  expectStatus(verifyEmail, 200, "verifyEmail");
  const signIn = await http.post("/v1/auth/sign-in").set(bff).send({ email, password });
  expectStatus(signIn, 200, "signIn");
  const session = signIn.body as { accessToken?: unknown; account?: { id?: unknown } };
  if (typeof session.accessToken !== "string" || typeof session.account?.id !== "string") {
    throw new Error("signIn answered no portal session (an MFA challenge?)");
  }
  return {
    email,
    accountId: session.account.id,
    headers: { Authorization: `Bearer ${session.accessToken}`, ...bff },
    responses: { signUp, verifyEmail, signIn },
  };
}

/** A new OTA, as createTenant answered it. */
export interface CreatedOta {
  readonly tenantId: string;
  readonly jobId: string;
  readonly key: string;
  /** `tenant_<key>`: the schema the OTA worker builds. */
  readonly schemaName: string;
  readonly response: Response;
}

/** Creates an OTA through the API (`createTenant`, a new Idempotency-Key) in STACK_COUNTRY, STACK_CURRENCY and zone. */
export async function createOta(
  stack: Stack,
  owner: PortalOwner,
  { key, name }: { readonly key: string; readonly name: string },
): Promise<CreatedOta> {
  const response = await stack.api.http
    .post("/v1/tenants")
    .set(owner.headers)
    .set("Idempotency-Key", randomUUID())
    .send({
      key,
      name,
      countryCode: STACK_COUNTRY,
      defaultCurrency: STACK_CURRENCY,
      timeZone: STACK_TIME_ZONE,
    });
  expectStatus(response, 202, "createTenant");
  const { tenant, provisioningJob } = response.body as {
    tenant: { id: string; key: string };
    provisioningJob: { id: string };
  };
  return {
    tenantId: tenant.id,
    jobId: provisioningJob.id,
    key: tenant.key,
    schemaName: `tenant_${tenant.key}`,
    response,
  };
}

/** The parts of a getProvisioning answer that `waitForSetup` reads. */
interface ProvisioningProgress {
  readonly tenantStatus: string;
  readonly job: {
    readonly status: string;
    readonly step: string | null;
    readonly attempt: number;
    readonly error: { readonly code?: string } | null;
  };
}

/** One line about a getProvisioning answer, for an error message. */
function describeProgress(res: Response | undefined): string {
  if (res === undefined) {
    return "no answer yet";
  }
  if (res.status !== 200) {
    return `getProvisioning answered ${outcomeOf(res)}`;
  }
  const { tenantStatus, job } = res.body as ProvisioningProgress;
  const error = job.error?.code === undefined ? "" : `, error ${job.error.code}`;
  return `tenant ${tenantStatus}, job ${job.status} at step ${job.step ?? "-"} (attempt ${job.attempt}${error})`;
}

/** The end of a setup that `waitForSetup` saw. */
export interface SetupResult {
  /** The first getProvisioning answer with the tenant `active`. */
  readonly active: Response;
  /** How long after the call the tenant was seen `active`. */
  readonly elapsedMs: number;
}

/**
 * Reads the setup progress (`getProvisioning`) every SETUP_POLL_MS until the tenant is `active`, and resolves with that
 * answer. Rejects with what it last saw and the OTA worker's last output when the tenant or its job fails, when the
 * API refuses the read (a 4xx other than 429), when the OTA worker exits, or when `timeoutMs` (default 60 s, the
 * acceptance bound) passes: a clear failure, not a timeout.
 */
export async function waitForSetup(
  stack: Stack,
  owner: PortalOwner,
  tenantId: string,
  { timeoutMs = SETUP_TIMEOUT_MS }: { readonly timeoutMs?: number } = {},
): Promise<SetupResult> {
  const started = performance.now();
  let last: Response | undefined;
  const fail = (why: string): Error =>
    new Error(
      `The OTA ${tenantId} ${why}. Last progress: ${describeProgress(last)}. ` +
        `The OTA worker's last output:\n${outputTail(stack.otaWorker)}`,
    );
  for (;;) {
    last = await stack.api.http.get(`/v1/tenants/${tenantId}/provisioning`).set(owner.headers);
    if (last.status === 200) {
      const { tenantStatus, job } = last.body as ProvisioningProgress;
      if (tenantStatus === "active") {
        return { active: last, elapsedMs: performance.now() - started };
      }
      if (tenantStatus === "failed" || job.status === "failed" || job.status === "canceled") {
        throw fail("did not become active");
      }
    } else if (last.status >= 400 && last.status < 500 && last.status !== 429) {
      // A refusal (an expired token, a non-member) does not go away by waiting.
      throw fail("cannot be followed");
    }
    const exit = stack.otaWorker.exitDescription();
    if (exit !== undefined) {
      throw fail(`is not active, and the OTA worker ${exit}`);
    }
    if (performance.now() - started >= timeoutMs) {
      throw fail(`was not active within ${timeoutMs / 1000} s`);
    }
    await delay(SETUP_POLL_MS);
  }
}
