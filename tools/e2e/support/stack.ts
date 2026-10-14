// The end-to-end stack: Playwright's global setup and teardown (PFE-014, PADR-0017 item 3, ADR-0015 "End-to-end").
//
// Setup, in this order, so a broken prerequisite fails in seconds with a message that says what to do:
//   1. read the harness settings (TEST_DATABASE_ADMIN_URL, REDIS_URL, SMTP_URL, MAILPIT_API_URL, E2E_WITH_OTA,
//      E2E_REDIS_DB, E2E_STRIPE) through @velexis/config, after the development .env.local files;
//   2. check that every app is built and that every port of the stack is free;
//   3. empty the stack's own Redis database, create a fresh PostgreSQL database `velexis_e2e_<runId>` like
//      deploy/postgres/bootstrap.sql does (owner velexis_migrator, the database grants, deploy/postgres/schemas.sql),
//      then run `pnpm db:migrate` and `pnpm db:seed:reference` against it;
//   4. start the BUILT apps on their ports of docs/mvp/architecture.md §3: the platform API (3100) and worker (3101),
//      the portal (3000) and the platform admin (3001) from their Next.js standalone servers, and with E2E_WITH_OTA=1
//      the Amadeus stub (4900) and the OTA worker (4001);
//   5. wait until each answers GET /health/ready with 200 (the stub, which has no health route, with its 404).
// Teardown stops every process (SIGTERM, then SIGKILL after 10 s), drops the database and empties the Redis database.
//
// Every app gets its environment from the `.env.example` files (the root one, then its own: the same precedence as the
// `.env.local` files in development), with the stack's database, Redis, ports and public URLs on top. So a variable a
// later task adds to an `.env.example` reaches the stack without a change here, and a developer's `.env.local` never
// changes what the apps see. The values are the dummy development values of those files; nothing here is a secret.
// Each process writes its output to test-results/stack/<name>.log (Playwright empties test-results/ before the
// global setup, and CI uploads the folder on failure). Database URLs carry the development passwords: they are passed
// to the processes and never printed.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, openSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { defineConfig, env, loadDevEnvFiles, type ConfigOf, type EnvSource } from "@velexis/config";
import {
  databaseGrantStatements,
  databaseUrl,
  dropDatabase,
  redisUrlWithDatabase,
  TEST_ROLES,
  type TestRole,
} from "@velexis/testing";
import Redis from "ioredis";
import pg from "pg";

/** tools/e2e (this file is tools/e2e/support/stack.ts). */
export const E2E_DIR = resolve(__dirname, "..");
/** The repository root. */
export const REPO_ROOT = resolve(E2E_DIR, "..", "..");
/** Where each process of the stack writes its output (`<name>.log`), inside Playwright's output folder. */
export const STACK_LOG_DIR = join(E2E_DIR, "test-results", "stack");

/** Every app of the stack listens on the loopback interface only, as on the VM. */
export const STACK_HOST = "127.0.0.1";

/** The ports of docs/mvp/architecture.md §3: the same as in development, so links in e-mails look the same. */
export const STACK_PORTS = Object.freeze({
  portal: 3000,
  platformAdmin: 3001,
  otaAdmin: 3002,
  platformApi: 3100,
  platformWorker: 3101,
  otaApi: 4000,
  otaWorker: 4001,
  amadeusStub: 4900,
} as const);

const origin = (port: number): string => `http://${STACK_HOST}:${port}`;

/** The portal: base URL of the `portal` and `portal-stripe` projects, and `PUBLIC_PORTAL_URL` of every app. */
export const PORTAL_URL = origin(STACK_PORTS.portal);
/** The platform admin: base URL of the `platform-admin` project and `PUBLIC_PLATFORM_ADMIN_URL`. */
export const PLATFORM_ADMIN_URL = origin(STACK_PORTS.platformAdmin);
/** The platform API, which the tests may call to arrange data (PADR-0017 item 5). */
export const PLATFORM_API_URL = origin(STACK_PORTS.platformApi);
/** The OTA admin and the OTA API: not started by this harness yet (the OTA plan adds them), but their URLs are set. */
export const OTA_ADMIN_URL = origin(STACK_PORTS.otaAdmin);
export const OTA_API_URL = origin(STACK_PORTS.otaApi);
/** The Amadeus stub (`AMADEUS_BASE_URL_TEST` and `_LIVE` of every app). */
export const AMADEUS_STUB_URL = origin(STACK_PORTS.amadeusStub);

/** The name of every database this harness creates: `velexis_e2e_<runId>`. */
export const E2E_DATABASE_PREFIX = "velexis_e2e_";

/** How long one process may take to answer its readiness check. */
export const READY_TIMEOUT_MS = 60_000;
/** How long `pnpm db:migrate` and `pnpm db:seed:reference` may take. */
const COMMAND_TIMEOUT_MS = 180_000;
/** How long a process may take to exit after SIGTERM before it gets SIGKILL. */
const STOP_TIMEOUT_MS = 10_000;
/** The pause between two readiness checks. */
const READY_POLL_MS = 250;
/** How many lines of a log an error shows. */
const LOG_TAIL_LINES = 40;

// ---- Settings ------------------------------------------------------------------------------------------------

/**
 * The harness's own variables. They come from the environment (CI sets them on the job), else from the `.env.local`
 * files of tools/e2e and of the repository root, as for `pnpm test:int` (docs/mvp/local-development.md §7).
 */
export const STACK_SETTINGS_SCHEMA = {
  /** velexis_test_admin (LOGIN CREATEDB, member of velexis_migrator): creates and drops the stack's database. */
  TEST_DATABASE_ADMIN_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  /** The Redis server; the stack uses only its database E2E_REDIS_DB. */
  REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
  /** Mailpit's SMTP port, where the apps send e-mail. */
  SMTP_URL: env.url({ protocols: ["smtp:", "smtps:"] }),
  /** Mailpit's API, where the tests read that e-mail (support/mailpit.ts). */
  MAILPIT_API_URL: env.url({ protocols: ["http:", "https:"] }),
  /** `1` also starts the Amadeus stub and the OTA worker (journeys that provision an OTA). */
  E2E_WITH_OTA: env.bool({ default: false }),
  /**
   * The Redis database of the stack, emptied when the stack starts and stops. Not 0 (the developer's `pnpm dev`).
   * The default 15 is the last one: `useRedis` of @velexis/testing gives Vitest worker n the database 1 + (n % 15), so
   * it reaches 15 only with 14 or more workers.
   */
  E2E_REDIS_DB: env.int({ min: 1, max: 15, default: 15 }),
  /**
   * `1` (the nightly job, when the Stripe test secrets are configured) defines the `portal-stripe` project and gives
   * the platform backend the two Stripe values below instead of the dummies of its `.env.example` (PADR-0017 item 4).
   */
  E2E_STRIPE: env.bool({ default: false }),
  /** With E2E_STRIPE=1: the Velexis Stripe account's test-mode secret key. */
  STRIPE_SECRET_KEY: env.string({ optional: true }),
  /** With E2E_STRIPE=1: the signing secret of the `stripe listen` forwarding to /webhooks/stripe/billing. */
  STRIPE_BILLING_WEBHOOK_SECRET: env.string({ optional: true }),
} as const;

export type StackSettings = ConfigOf<typeof STACK_SETTINGS_SCHEMA>;

/** Stripe values the stack accepts with E2E_STRIPE=1: test mode only, never a live key. */
const STRIPE_TEST_VALUES = {
  STRIPE_SECRET_KEY: /^sk_test_[A-Za-z0-9_]+$/,
  STRIPE_BILLING_WEBHOOK_SECRET: /^whsec_[A-Za-z0-9_]+$/,
} as const;

/**
 * The harness settings from `source`, or from the process environment after the `.env.local` files of tools/e2e and
 * of the repository root (never in production). Throws a `ConfigError` that names each bad variable, never a value.
 */
export function readStackSettings(source?: EnvSource): StackSettings {
  if (source === undefined) {
    loadDevEnvFiles({ appDir: E2E_DIR });
  }
  const settings =
    source === undefined ? defineConfig(STACK_SETTINGS_SCHEMA) : defineConfig(STACK_SETTINGS_SCHEMA, source);
  if (settings.E2E_STRIPE) {
    const bad = Object.entries(STRIPE_TEST_VALUES)
      .filter(
        ([variable, pattern]) => !pattern.test(settings[variable as keyof typeof STRIPE_TEST_VALUES] ?? ""),
      )
      .map(([variable]) => variable);
    if (bad.length > 0) {
      throw new Error(
        `E2E_STRIPE=1 needs Stripe test-mode values (sk_test_…, whsec_…) in: ${bad.join(", ")}. Live keys are ` +
          "never used in tests.",
      );
    }
  }
  return settings;
}

// ---- The stack's context and the environment of each process -------------------------------------------------

/** What every process and every test needs to know about one running stack. */
export interface StackContext {
  readonly settings: StackSettings;
  /** `velexis_e2e_<runId>`. */
  readonly databaseName: string;
  /** REDIS_URL with the stack's database (E2E_REDIS_DB) as its path. */
  readonly redisUrl: string;
}

/** A new database name: `velexis_e2e_` and a base-36 timestamp and 6 random hex digits. */
export function newDatabaseName(): string {
  return `${E2E_DATABASE_PREFIX}${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

/** The context of a stack on `databaseName`. */
export function stackContext(settings: StackSettings, databaseName: string): StackContext {
  if (!/^velexis_e2e_[a-z0-9_]{1,40}$/.test(databaseName)) {
    throw new TypeError(`not a database name of this harness: ${databaseName}`);
  }
  return Object.freeze({
    settings,
    databaseName,
    redisUrl: redisUrlWithDatabase(settings.REDIS_URL, settings.E2E_REDIS_DB),
  });
}

/** The DSN of `role` on the stack's database (host and port of TEST_DATABASE_ADMIN_URL). Never print it. */
export function stackDatabaseUrl(context: StackContext, role: TestRole): string {
  return databaseUrl(context.settings.TEST_DATABASE_ADMIN_URL, context.databaseName, TEST_ROLES[role]);
}

/** The processes of the stack, and the platform CLI that support/seed.ts runs. */
export type ServiceName =
  | "platform-api"
  | "platform-worker"
  | "platform-cli"
  | "portal"
  | "platform-admin"
  | "amadeus-stub"
  | "ota-worker";

/** The `.env.example` files of each process, root first: a later file wins, as `<app>/.env.local` does. */
const EXAMPLE_ENV_FILES: Readonly<Record<ServiceName, readonly string[]>> = {
  "platform-api": [".env.example", "platform/backend/.env.example"],
  "platform-worker": [".env.example", "platform/backend/.env.example"],
  "platform-cli": [".env.example", "platform/backend/.env.example"],
  portal: [".env.example", "platform/frontend/.env.example"],
  "platform-admin": [".env.example", "platform/admin/.env.example"],
  "amadeus-stub": [".env.example"],
  "ota-worker": [".env.example", "ota/backend/.env.example"],
};

/**
 * DSNs no process gets from the `.env.example` files or the developer's shell, which name the development database
 * `velexis`: each backend process gets the stack database's DSN of its own role instead (`serviceOverrides`), the
 * Next.js apps and the stub get none. The migrator's and the test admin's DSNs are for `pnpm db:migrate` and the
 * harness only (root .env.example: "Never given to a running app"); the provisioner's is the OTA worker's alone
 * (ADR-0004, ADR-0026).
 */
const WITHHELD = [
  "DATABASE_URL",
  "DATABASE_MIGRATOR_URL",
  "DATABASE_PROVISIONER_URL",
  "TEST_DATABASE_ADMIN_URL",
] as const;

/** `values` without the withheld DSNs. */
function withoutWithheld<T>(values: Readonly<Record<string, T>>): Record<string, T> {
  const withheld: readonly string[] = WITHHELD;
  return Object.fromEntries(Object.entries(values).filter(([variable]) => !withheld.includes(variable)));
}

/** The variables of `files` (relative to the repository root), parsed like `.env` files; a later file wins. */
export function exampleEnv(files: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const file of files) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(join(REPO_ROOT, file), "utf8")))) {
      if (value !== undefined) {
        values[name] = value;
      }
    }
  }
  return values;
}

/** What the stack sets on top of the `.env.example` values, for every process. */
function stackOverrides(context: StackContext): Record<string, string> {
  return {
    APP_ENV: "test",
    LOG_LEVEL: "info",
    REDIS_URL: context.redisUrl,
    SMTP_URL: context.settings.SMTP_URL,
    MAILPIT_API_URL: context.settings.MAILPIT_API_URL,
    // The browser reaches the apps on 127.0.0.1, so links in e-mails and redirects must name that host: cookies of
    // `localhost` would not be sent to `127.0.0.1`.
    PUBLIC_PORTAL_URL: PORTAL_URL,
    PUBLIC_PLATFORM_ADMIN_URL: PLATFORM_ADMIN_URL,
    PUBLIC_OTA_ADMIN_URL: OTA_ADMIN_URL,
    PUBLIC_OTA_API_URL: OTA_API_URL,
    PLATFORM_API_URL,
    OTA_API_URL,
    AMADEUS_BASE_URL_TEST: AMADEUS_STUB_URL,
    AMADEUS_BASE_URL_LIVE: AMADEUS_STUB_URL,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

/** With E2E_STRIPE=1, the Stripe test values of the harness (checked by `readStackSettings`); otherwise nothing. */
function stripeOverrides(settings: StackSettings): Record<string, string> {
  if (!settings.E2E_STRIPE) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const variable of Object.keys(STRIPE_TEST_VALUES) as (keyof typeof STRIPE_TEST_VALUES)[]) {
    const value = settings[variable];
    if (value !== undefined) {
      values[variable] = value;
    }
  }
  return values;
}

/** The variables that differ per process. */
function serviceOverrides(name: ServiceName, context: StackContext): Record<string, string> {
  switch (name) {
    case "platform-api":
    case "platform-worker":
    case "platform-cli":
      return {
        DATABASE_URL: stackDatabaseUrl(context, "platform"),
        PORT: String(STACK_PORTS.platformApi),
        HEALTH_PORT: String(STACK_PORTS.platformWorker),
        ...stripeOverrides(context.settings),
      };
    case "portal":
      return { PORT: String(STACK_PORTS.portal), HOSTNAME: STACK_HOST };
    case "platform-admin":
      return { PORT: String(STACK_PORTS.platformAdmin), HOSTNAME: STACK_HOST };
    case "amadeus-stub":
      return { STUB_PORT: String(STACK_PORTS.amadeusStub) };
    case "ota-worker":
      return {
        DATABASE_URL: stackDatabaseUrl(context, "ota"),
        DATABASE_PROVISIONER_URL: stackDatabaseUrl(context, "provisioner"),
        PORT: String(STACK_PORTS.otaApi),
        HEALTH_PORT: String(STACK_PORTS.otaWorker),
      };
  }
}

/**
 * The variables of process `name`, without the inherited environment: its `.env.example` files without the withheld
 * DSNs, the stack's overrides, then its own ones (the stack database's DSNs of the process's roles).
 */
export function serviceEnv(name: ServiceName, context: StackContext): Record<string, string> {
  return {
    ...withoutWithheld(exampleEnv(EXAMPLE_ENV_FILES[name])),
    ...stackOverrides(context),
    ...serviceOverrides(name, context),
  };
}

/**
 * The environment a child process starts with: the harness's own (PATH, HOME, …) without the withheld DSNs, then
 * `values`. Every variable an app reads is in its `.env.example`, so `values` decides all of them: what an app's
 * `loadDevEnvFiles` may still fill from a developer's `.env.local` is only what the app does not read.
 */
export function childEnv(values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  // The one place the harness passes its process environment on: children need PATH, HOME and the like.
  return { ...withoutWithheld(process.env), ...values };
}

// ---- The processes ------------------------------------------------------------------------------------------

/** One process of the stack. */
export interface ServiceSpec {
  readonly name: Exclude<ServiceName, "platform-cli">;
  /** The built entry point, relative to the repository root. */
  readonly entry: string;
  /** The command that builds it. */
  readonly build: string;
  /** The working directory, relative to the repository root. */
  readonly cwd: string;
  readonly port: number;
  /** The URL polled until `isReady` accepts its status. */
  readonly readyUrl: string;
  readonly isReady: (status: number) => boolean;
  readonly env: Readonly<Record<string, string>>;
}

const READY_PATH = "/health/ready";
const ok = (status: number): boolean => status === 200;

/** The Next.js apps: the standalone server, plus the static assets that `deploy/scripts/pack-release.sh` copies. */
const NEXT_APPS = ["platform/frontend", "platform/admin"] as const;

/** The processes of a stack in start order; the OTA ones only with E2E_WITH_OTA=1. */
export function stackServices(context: StackContext): readonly ServiceSpec[] {
  const service = (
    name: ServiceSpec["name"],
    spec: Omit<ServiceSpec, "name" | "readyUrl" | "isReady" | "env"> & { isReady?: ServiceSpec["isReady"] },
  ): ServiceSpec => ({
    name,
    ...spec,
    readyUrl: `${origin(spec.port)}${READY_PATH}`,
    isReady: spec.isReady ?? ok,
    env: serviceEnv(name, context),
  });
  const platform = [
    service("platform-api", {
      entry: "platform/backend/dist/main.js",
      build: "pnpm --filter @velexis/platform-backend build",
      cwd: "platform/backend",
      port: STACK_PORTS.platformApi,
    }),
    service("platform-worker", {
      entry: "platform/backend/dist/worker.js",
      build: "pnpm --filter @velexis/platform-backend build",
      cwd: "platform/backend",
      port: STACK_PORTS.platformWorker,
    }),
    service("portal", {
      entry: "platform/frontend/.next/standalone/platform/frontend/server.js",
      build: "pnpm --filter @velexis/platform-frontend build",
      cwd: "platform/frontend/.next/standalone/platform/frontend",
      port: STACK_PORTS.portal,
    }),
    service("platform-admin", {
      entry: "platform/admin/.next/standalone/platform/admin/server.js",
      build: "pnpm --filter @velexis/platform-admin build",
      cwd: "platform/admin/.next/standalone/platform/admin",
      port: STACK_PORTS.platformAdmin,
    }),
  ];
  if (!context.settings.E2E_WITH_OTA) {
    return platform;
  }
  return [
    service("amadeus-stub", {
      entry: "tools/amadeus-stub/dist/cli.js",
      build: "pnpm --filter @velexis/amadeus-stub build",
      cwd: "tools/amadeus-stub",
      port: STACK_PORTS.amadeusStub,
      // The stub has no health route: its Amadeus-style 404 on /health/ready proves it serves HTTP.
      isReady: (status) => status === 404,
    }),
    ...platform,
    service("ota-worker", {
      entry: "ota/backend/dist/worker.js",
      build: "pnpm --filter @velexis/ota-backend build",
      cwd: "ota/backend",
      port: STACK_PORTS.otaWorker,
    }),
  ];
}

/** Throws one error that lists every entry point that is not built, with the command that builds it. */
export function assertBuilt(services: readonly ServiceSpec[]): void {
  const missing = services.filter((service) => {
    try {
      accessSync(join(REPO_ROOT, service.entry), constants.R_OK);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    const lines = missing.map((service) => `  - ${service.name}: ${service.entry} (${service.build})`);
    throw new Error(
      `The end-to-end stack runs the built apps, and these are not built:\n${lines.join("\n")}`,
    );
  }
}

/** Resolves when `port` of 127.0.0.1 can be bound, rejects when something listens there. */
function assertPortFree(port: number, name: string): Promise<void> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `port ${port} (${name}) is in use: stop what listens there (a \`pnpm dev\`, another end-to-end run)`
            : `port ${port} (${name}) cannot be bound: ${error.message}`,
        ),
      );
    });
    probe.listen(port, STACK_HOST, () => probe.close(() => resolvePort()));
  });
}

/** Rejects with one error naming every port of `services` that is in use. */
export async function assertPortsFree(services: readonly ServiceSpec[]): Promise<void> {
  const results = await Promise.allSettled(
    services.map((service) => assertPortFree(service.port, service.name)),
  );
  const problems = results.flatMap((result) =>
    result.status === "rejected" ? [`  - ${(result.reason as Error).message}`] : [],
  );
  if (problems.length > 0) {
    throw new Error(`The end-to-end stack needs its ports:\n${problems.join("\n")}`);
  }
}

/** The last lines of a log file, for an error message (the apps log redacted JSON lines, never a secret). */
function logTail(file: string): string {
  try {
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    return lines.slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    return "(no output)";
  }
}

function seconds(since: number): string {
  return `${((performance.now() - since) / 1000).toFixed(1)} s`;
}

function say(message: string): void {
  console.log(`[e2e stack] ${message}`);
}

/** A process of the stack while it runs. */
interface RunningService {
  readonly spec: ServiceSpec;
  readonly child: ChildProcess;
  readonly logFile: string;
  /** Resolves when the process has exited. */
  readonly exited: Promise<void>;
  exitDescription: string | undefined;
}

function startService(spec: ServiceSpec): RunningService {
  const logFile = join(STACK_LOG_DIR, `${spec.name}.log`);
  const fd = openSync(logFile, "w");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ["--enable-source-maps", join(REPO_ROOT, spec.entry)], {
      cwd: join(REPO_ROOT, spec.cwd),
      env: childEnv(spec.env),
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const running: RunningService = {
    spec,
    child,
    logFile,
    exitDescription: undefined,
    exited: new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        running.exitDescription = signal === null ? `exited with code ${code}` : `was stopped by ${signal}`;
        resolveExit();
      });
      child.once("error", (error) => {
        running.exitDescription = `could not start: ${error.message}`;
        resolveExit();
      });
    }),
  };
  return running;
}

/**
 * Polls the readiness URL until it is accepted; rejects when the process exits first or after the timeout. Stops
 * quietly when `cancel` is aborted (another process failed and the stack is being stopped).
 */
async function waitUntilReady(
  running: RunningService,
  cancel: AbortSignal,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<void> {
  const { spec } = running;
  const started = performance.now();
  let last = "no answer yet";
  while (performance.now() - started < timeoutMs) {
    if (cancel.aborted) {
      return;
    }
    if (running.exitDescription !== undefined) {
      throw new Error(
        `${spec.name} ${running.exitDescription} before it was ready. Its output (${running.logFile}):\n` +
          logTail(running.logFile),
      );
    }
    try {
      const response = await fetch(spec.readyUrl, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
      await response.body?.cancel();
      if (spec.isReady(response.status)) {
        say(`${spec.name} ready on ${origin(spec.port)} (${seconds(started)})`);
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(READY_POLL_MS);
  }
  throw new Error(
    `${spec.name} was not ready within ${timeoutMs / 1000} s (GET ${spec.readyUrl}: ${last}). ` +
      `Its output (${running.logFile}):\n${logTail(running.logFile)}`,
  );
}

/** SIGTERM, then SIGKILL after STOP_TIMEOUT_MS. */
async function stopService(running: RunningService): Promise<void> {
  if (running.exitDescription !== undefined) {
    return;
  }
  running.child.kill("SIGTERM");
  // An unreferenced timer: it never keeps the harness alive once every process has exited.
  const stopped = await Promise.race([
    running.exited.then(() => true),
    delay(STOP_TIMEOUT_MS, false, { ref: false }),
  ]);
  if (!stopped) {
    running.child.kill("SIGKILL");
    await running.exited;
  }
}

/** Runs `pnpm <args>` in the repository root with `values` on top of the environment; output to `<logName>.log`. */
async function runPnpm(
  args: readonly string[],
  values: Record<string, string>,
  logName: string,
): Promise<void> {
  const logFile = join(STACK_LOG_DIR, `${logName}.log`);
  const fd = openSync(logFile, "w");
  let child: ChildProcess;
  try {
    child = spawn("pnpm", [...args], { cwd: REPO_ROOT, env: childEnv(values), stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const outcome = await new Promise<string | undefined>((resolveRun) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveRun(`did not finish within ${COMMAND_TIMEOUT_MS / 1000} s`);
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveRun(`could not start: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun(
        code === 0 ? undefined : signal === null ? `exited with code ${code}` : `was stopped by ${signal}`,
      );
    });
  });
  if (outcome !== undefined) {
    throw new Error(`pnpm ${args.join(" ")} ${outcome}. Its output (${logFile}):\n${logTail(logFile)}`);
  }
}

// ---- Database and Redis -------------------------------------------------------------------------------------

/**
 * Creates `context.databaseName` as TEST_DATABASE_ADMIN_URL the way deploy/postgres/bootstrap.sql creates
 * `velexis`: owned by velexis_migrator (UTF-8, `C.UTF-8`, from template0), with its database grants, then
 * deploy/postgres/schemas.sql as velexis_migrator. `pnpm db:migrate` does the rest.
 */
async function createStackDatabase(context: StackContext): Promise<void> {
  const adminUrl = context.settings.TEST_DATABASE_ADMIN_URL;
  const name = pg.escapeIdentifier(context.databaseName);
  const migrator = pg.escapeIdentifier(TEST_ROLES.migrator.user);
  const admin = new pg.Client({ connectionString: adminUrl, application_name: "velexis-e2e" });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE ${name} OWNER ${migrator} ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' ` +
        "TEMPLATE template0",
    );
    for (const statement of databaseGrantStatements(context.databaseName)) {
      await admin.query(statement);
    }
  } finally {
    await admin.end();
  }
  const schemasSql = await readFile(join(REPO_ROOT, "deploy", "postgres", "schemas.sql"), "utf8");
  const client = new pg.Client({
    connectionString: databaseUrl(adminUrl, context.databaseName),
    application_name: "velexis-e2e",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${migrator}`);
    await client.query(schemasSql);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

/** Empties the stack's Redis database: no job, rate-limit counter or token of an earlier run survives. */
async function flushRedis(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

/** Copies `.next/static` (and `public/`) of each Next.js app into its standalone tree, as pack-release.sh does. */
async function syncNextStaticAssets(): Promise<void> {
  for (const app of NEXT_APPS) {
    const source = join(REPO_ROOT, app);
    const target = join(source, ".next", "standalone", app);
    await rm(join(target, ".next", "static"), { recursive: true, force: true });
    await cp(join(source, ".next", "static"), join(target, ".next", "static"), { recursive: true });
    await rm(join(target, "public"), { recursive: true, force: true });
    try {
      accessSync(join(source, "public"), constants.R_OK);
      await cp(join(source, "public"), join(target, "public"), { recursive: true });
    } catch {
      // No public/ folder: nothing to copy.
    }
  }
}

// ---- The stack ----------------------------------------------------------------------------------------------

/** A started stack. */
export interface Stack {
  readonly context: StackContext;
  /** Stops every process, drops the database and empties the Redis database. Idempotent. */
  stop(): Promise<void>;
}

/** Starts the stack of `settings` (steps 2 to 5 of the header). On failure it cleans up and rethrows. */
export async function startStack(settings: StackSettings): Promise<Stack> {
  const started = performance.now();
  const context = stackContext(settings, newDatabaseName());
  const services = stackServices(context);
  assertBuilt(services);
  await assertPortsFree(services);
  await mkdir(STACK_LOG_DIR, { recursive: true });

  const running: RunningService[] = [];
  const cancelReadiness = new AbortController();
  // Set before CREATE DATABASE: a failure after it (grants, schemas.sql) still drops the database, and dropping one
  // that was never created is a no-op.
  let databaseRequested = false;
  // A last resort when the harness dies without its teardown (an uncaught error, process.exit): no app outlives it.
  const killAll = (): void => {
    for (const service of running) {
      if (service.exitDescription === undefined) {
        service.child.kill("SIGKILL");
      }
    }
  };
  process.once("exit", killAll);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    const problems: string[] = [];
    for (const service of [...running].reverse()) {
      await stopService(service).catch((error: unknown) =>
        problems.push(`${service.spec.name}: ${String(error)}`),
      );
    }
    process.off("exit", killAll);
    if (databaseRequested) {
      await dropDatabase(settings.TEST_DATABASE_ADMIN_URL, context.databaseName).catch((error: unknown) =>
        problems.push(`drop database ${context.databaseName}: ${String(error)}`),
      );
    }
    await flushRedis(context.redisUrl).catch((error: unknown) =>
      problems.push(`flush Redis: ${String(error)}`),
    );
    if (problems.length > 0) {
      throw new Error(`The end-to-end stack did not stop cleanly:\n  - ${problems.join("\n  - ")}`);
    }
    say("stopped, database dropped");
  };

  try {
    await flushRedis(context.redisUrl);
    databaseRequested = true;
    await createStackDatabase(context);
    const step = performance.now();
    await runPnpm(
      ["db:migrate"],
      { DATABASE_MIGRATOR_URL: stackDatabaseUrl(context, "migrator") },
      "db-migrate",
    );
    await runPnpm(
      ["db:seed:reference"],
      { APP_ENV: "test", DATABASE_URL: stackDatabaseUrl(context, "platform") },
      "db-seed-reference",
    );
    say(`database ${context.databaseName} migrated and seeded (${seconds(step)})`);
    await syncNextStaticAssets();
    for (const spec of services) {
      running.push(startService(spec));
    }
    await Promise.all(running.map((service) => waitUntilReady(service, cancelReadiness.signal)));
  } catch (error) {
    cancelReadiness.abort();
    await stop().catch((stopError: unknown) => say(String(stopError)));
    throw error;
  }
  say(`ready in ${seconds(started)}: ${services.map((service) => service.name).join(", ")}`);
  return { context, stop };
}

/**
 * Playwright's global setup: starts the stack and returns its teardown. The database name reaches the test workers
 * through E2E_DATABASE_NAME: Playwright starts them after the global setup, with its environment.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack(readStackSettings());
  process.env["E2E_DATABASE_NAME"] = stack.context.databaseName;
  return stack.stop;
}

const RUNNING_STACK_SCHEMA = {
  E2E_DATABASE_NAME: env.string({ pattern: /^velexis_e2e_[a-z0-9_]+$/ }),
} as const;

/** The stack the global setup started, seen from a test worker (or from `source` in a unit test). */
export function runningStackContext(source?: EnvSource): StackContext {
  const settings = readStackSettings(source);
  const { E2E_DATABASE_NAME } =
    source === undefined ? defineConfig(RUNNING_STACK_SCHEMA) : defineConfig(RUNNING_STACK_SCHEMA, source);
  return stackContext(settings, E2E_DATABASE_NAME);
}
