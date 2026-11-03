// The cross-backend stack of `pnpm --filter @velexis/ota-backend test:xb` (OBE-083; PADR-0017 item 2, ota/docs/scope.md
// OF-12). It follows the platform's stack (platform/backend/test/cross-backend/stack.ts: the gate, the stack folder, the
// environments from the `.env.example` files, the readiness checks, the output kept for errors), with both backends
// BUILT: the OTA backend's own test cannot import the platform's code (ADR-0002), so the platform API, its worker and
// its `dev:seed` run from `platform/backend/dist/` as child processes too. One stack per test file, started in a
// `beforeAll` hook with an explicit timeout:
//
//   const stack = await startStack();                                   // the steps below, or a clear error
//   const owner = await signUpOwner(stack, { label: "xb-m5", ip });     // portal sign-up, Mailpit, sign-in
//   const ota = await createOta(stack, owner, { key: "acme", name: "Acme Travel" });
//   await waitForSetup(stack, owner, ota.tenantId);                     // `active` within 60 s, or a clear error
//   const answer = await httpCall(stack.otaApi.url, "GET", "/v1/storefront", { headers: { "X-Api-Key": key } });
//   await stack.stop();                                                 // in afterAll
//
// `startStack` runs, in this order:
//
//   1. **The gate.** The five entry points must be built: `platform/backend/dist/{main,worker,cli}.js` and
//      `ota/backend/dist/{main,worker}.js`. In CI, test:xb runs after the `Build` step (PADR-0017 item 2: `pnpm test`
//      and `pnpm test:int` build only each package's dependencies). A missing one throws `BuildMissingError`, naming it
//      and the build commands, before a database is created or a process started: a clear failure, never a timeout.
//   2. **The services of the test process.** One `createTestDatabase()` clone and one Redis database (`useRedis()`),
//      shared by every process, as on the VM. The fakes run in this process on free ports of 127.0.0.1:
//      - the fake Stripe API of test/helpers/fake-stripe.ts, which answers the OTA's PaymentIntents and the platform's
//        `GET /v1/account` (the verification of own Stripe keys, PBE-057);
//      - three Amadeus stubs (`@velexis/testing/amadeus`): the Velexis stub, where `dev:seed` puts the Velexis test
//        account and which accepts any client; and the stubs of the OTA's own test and live credentials, which accept
//        only the credentials the stack made for them (`ownAmadeus`). The platform's AMADEUS_BASE_URL_TEST and _LIVE
//        name the two own stubs (the hosts its verification asks and writes into an own-credentials connection), and
//        the OTA processes get no AMADEUS_BASE_URL_* override (empty values), so each call goes to the host of the
//        connection or account that serves it (flows/amadeus-connection-and-tokens.md §2 rule 5): which stub a call
//        reaches proves which credential set served it.
//      Reference rows the journeys need beyond the template's fixture (the time zone `Europe/Paris` and CDG's, as
//      `pnpm db:seed:reference` loads them) are written as velexis_migrator.
//   3. **`dev:seed`** of the platform: `node platform/backend/dist/cli.js dev:seed` with the Velexis stub as
//      AMADEUS_BASE_URL_TEST: the platform admin, the verified Velexis test account and its twenty test offices, so
//      provisioning assigns an office. Its stdout holds the new admin's password and TOTP URI: it is never read (the
//      child's stdout is not even piped); only its stderr appears in an error.
//   4. **The four processes**, at once, each with `--require` of the stack's Stripe preload (below), and each ready when
//      `GET /health/ready` answers 200 (an exit before that, or 60 s without it, fails with its last output lines):
//      - the platform API (`dist/main.js`) and worker (`dist/worker.js`): DATABASE_URL of velexis_platform_app, a fresh
//        PLATFORM_BFF_KEY, the stack's JWT key, KEK folder and API key pepper, and the milestone switches of M5 on
//        (FEATURE_OWN_AMADEUS, FEATURE_OWN_STRIPE, FEATURE_SETTLEMENTS, FEATURE_CUSTOM_DOMAINS, FEATURE_LIVE_SWITCH).
//        FEATURE_STRIPE_BILLING stays off: with it on, createTenant opens a Stripe Checkout and the OTA's setup waits
//        for Stripe's `checkout.session.completed` (PBE-044, PBE-045), a hosted page no test can complete; the plan and
//        subscription that go-live checks are then platform rows the test writes as the billing sync would;
//      - the OTA worker (`dist/worker.js`) and API (`dist/main.js`), as the platform's stack starts them: DATABASE_URL
//        of velexis_ota_app, the worker alone with DATABASE_PROVISIONER_URL (ADR-0004), the same KEK folder and pepper
//        (the OTA zone holds identical copies, ADR-0010), the OTA's own JWT and document URL keys, a fresh
//        VELEXIS_EDGE_SECRET, and fresh Velexis Stripe test keys (`velexisStripe`), so the test sees which key a
//        PaymentIntent was created with.
//
// **Stripe.** Neither backend can be pointed at another Stripe host by configuration: the OTA's STRIPE_API_ENDPOINT is
// a test-only injection and a production process refuses one; the platform's client has none. So the stack writes a
// preload into its folder (`stripe-endpoint.cjs`, mode 0600), which each process loads with `node --require` before its
// own code: it replaces the `stripe` module of the process (the one copy both backends resolve) with a constructor that
// adds `host`, `port` and `protocol: "http"` of the fake Stripe API to every client's options, the public options the
// OTA's test injection uses too. It refuses to load with APP_ENV=production and only ever names a loopback port, and
// nothing outside this file writes or loads it. So every Stripe request of the stack, the OTA's with the Velexis key,
// with an OTA's own key or with `Stripe-Account`, and the platform's, reaches the fake, which records its headers.
//
// The processes share a **stack folder** (a new temporary folder, mode 0700, deleted by `stop()`): the KEK folder and
// pepper, both JWT keys, the document URL key, the OTA's STORAGE_DIR and the preload, every file mode 0600. Each
// process gets its environment from the `.env.example` files (root, then the backend's), without the DSNs of the
// development database, with the stack's values on top, and nothing else: no variable of this process (CI's job DSNs
// included) reaches it; the migrator's, the test admin's and (but for the OTA worker) the provisioner's DSNs are set
// empty (as OTA_BLANKED_DSNS of the platform's stack), which @velexis/config treats as unset and a developer's
// `.env.local` cannot fill. The values are dummies of
// those files and fresh test keys; nothing here is a secret. Process output (redacted JSON lines) is kept in memory, and
// the last lines appear in every error about the process.
//
// `stop()` stops the processes (SIGTERM, SIGKILL after 10 s), the fakes, the pools and Redis, drops the database and
// deletes the stack folder. The journeys through the platform API (sign-up, OTA, setup, MFA and step-up, keys, the
// following of a credential submission) are below; the steps of a test are in its file. Test-only code: nothing under src/ imports
// it.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
  type TenantDb,
} from "@velexis/db";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub, type StubCredentials } from "@velexis/testing/amadeus";
import { extractLinks, mailpit, uniqueEmail } from "@velexis/testing/mailpit";
import { APP_DIR } from "../../src/config";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/** The repository root (this file is ota/backend/test/cross-backend/stack.ts). */
export const REPO_ROOT = resolve(APP_DIR, "..", "..");

/** The two backends whose built entry points the stack runs. */
export const PLATFORM_BACKEND_DIR = join(REPO_ROOT, "platform", "backend");
export const OTA_BACKEND_DIR = join(REPO_ROOT, "ota", "backend");

/** The commands that build them (their package.json files). */
export const BUILD_COMMANDS = Object.freeze([
  "pnpm --filter @velexis/platform-backend build",
  "pnpm --filter @velexis/ota-backend build",
]);

/** The built entry points, relative to their backend's folder. */
export const ENTRY = Object.freeze({ api: "dist/main.js", worker: "dist/worker.js", cli: "dist/cli.js" });

/** Every entry point the stack starts, absolute: the gate checks each. */
export const STACK_ENTRIES: readonly string[] = Object.freeze([
  join(PLATFORM_BACKEND_DIR, ENTRY.api),
  join(PLATFORM_BACKEND_DIR, ENTRY.worker),
  join(PLATFORM_BACKEND_DIR, ENTRY.cli),
  join(OTA_BACKEND_DIR, ENTRY.api),
  join(OTA_BACKEND_DIR, ENTRY.worker),
]);

/** Every process of the stack listens on the loopback interface only, as on the VM. */
export const STACK_HOST = "127.0.0.1";

/** The country, currency and time zone of the OTAs `createOta` creates (the time zone is added to the fixture). */
export const STACK_COUNTRY = "FR";
export const STACK_CURRENCY = "EUR";
export const STACK_TIME_ZONE = "Europe/Paris";

/** The storefront base domain and the portal URL of the platform (the placeholders of `.env.example`). */
export const STACK_STOREFRONT_BASE_DOMAIN = "ota.example.com";
export const STACK_PORTAL_URL = "http://localhost:3000";

/** The terms version of the sign-ups (stored as given). */
export const STACK_TERMS_VERSION = "2026-10-01";

/** The subject of the platform's verification e-mail (platform/backend/src/notifications/templates). */
export const VERIFY_SUBJECT = "Confirm your e-mail address for Velexis";

/** How long a process may take to answer its readiness check. */
export const READY_TIMEOUT_MS = 60_000;
/** The acceptance bound of a new OTA's setup (PBE-035 AC1): `active` within 60 seconds. */
export const SETUP_TIMEOUT_MS = 60_000;
/** How long the platform worker may take to deliver an e-mail to Mailpit. */
export const MAIL_TIMEOUT_MS = 20_000;
/** How long a credential submission may take to become final (the platform worker's job and one provider call). */
export const SUBMISSION_TIMEOUT_MS = 30_000;
/** How long one HTTP call of `httpCall` may take before it fails. */
export const CALL_TIMEOUT_MS = 10_000;
/**
 * The pause between two reads of a progress (getProvisioning, getCredentialSubmission): at 250 ms the reads of a minute
 * stay under the `authenticated` limit of an account (300 per fixed minute), as in the platform's stack.
 */
export const POLL_MS = 250;

/** How long a process may take to exit after SIGTERM before it gets SIGKILL. */
const STOP_TIMEOUT_MS = 10_000;
/** How long `dev:seed` may take. */
const SEED_TIMEOUT_MS = 60_000;
/** How many output lines of a process are kept, and how many an error shows. */
const OUTPUT_LINES_KEPT = 400;
const OUTPUT_LINES_SHOWN = 40;

// ---- The gate --------------------------------------------------------------------------------------------------

/** An entry point of a backend is not built: test:xb runs the built backends (PADR-0017 item 2). */
export class BuildMissingError extends Error {
  override readonly name = "BuildMissingError";

  constructor(readonly missing: readonly string[]) {
    super(
      `test:xb runs the built backends, and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. ` +
        `Build them first: ${BUILD_COMMANDS.join(" && ")} (in CI, test:xb runs after the Build step).`,
    );
  }
}

/**
 * Throws `BuildMissingError` naming every entry of `entries` (absolute paths) that cannot be read, relative to the
 * repository root when inside it (`platform/backend/dist/main.js`). Synchronous: it runs before anything is started.
 */
export function assertBuilt(entries: readonly string[] = STACK_ENTRIES): void {
  const missing = entries
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
    throw new BuildMissingError(missing);
  }
}

// ---- Settings, keys and environments ---------------------------------------------------------------------------

/**
 * The services of the environment the stack does not start: Mailpit's SMTP port (the platform worker sends there) and
 * its API (read by `@velexis/testing/mailpit`). CI sets them on the job; locally they come from the environment or the
 * `.env.local` files, as for `pnpm test:int`. PostgreSQL (TEST_DATABASE_ADMIN_URL) and Redis (REDIS_URL) are read by
 * `createTestDatabase()` and `useRedis()`.
 */
const STACK_SETTINGS_SCHEMA = {
  SMTP_URL: env.url({ protocols: ["smtp:", "smtps:"] }),
  MAILPIT_API_URL: env.url({ protocols: ["http:", "https:"] }),
} as const;

function readSettings(): { readonly SMTP_URL: string; readonly MAILPIT_API_URL: string } {
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(STACK_SETTINGS_SCHEMA);
}

/** The `.env.example` files of each backend's processes, root first: a later file wins, as `<app>/.env.local` does. */
const EXAMPLE_ENV_FILES = Object.freeze({
  platform: [".env.example", "platform/backend/.env.example"],
  ota: [".env.example", "ota/backend/.env.example"],
} as const);

/** DSNs no process takes from the `.env.example` files, which name the development database `velexis`. */
const WITHHELD: readonly string[] = [
  "DATABASE_URL",
  "DATABASE_MIGRATOR_URL",
  "DATABASE_PROVISIONER_URL",
  "TEST_DATABASE_ADMIN_URL",
];

/**
 * The withheld DSNs every process gets as empty values (see the file header); DATABASE_URL is always the stack's, and
 * the OTA worker's DATABASE_PROVISIONER_URL is set over this.
 */
export const BLANKED_DSNS: Readonly<Record<string, "">> = Object.freeze({
  DATABASE_MIGRATOR_URL: "",
  DATABASE_PROVISIONER_URL: "",
  TEST_DATABASE_ADMIN_URL: "",
});

/** The variables of `files` (relative to the repository root) without the withheld DSNs; a later file wins. */
export function exampleEnv(files: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const file of files) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(join(REPO_ROOT, file), "utf8")))) {
      if (value !== undefined && !WITHHELD.includes(name)) {
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

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `length` random letters and digits: the body of a test key (`sk_test_<…>`), made at run time, never written down. */
export function randomBase62(length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += BASE62[randomInt(BASE62.length)];
  }
  return text;
}

/** A Stripe key pair of one environment: made at run time, kept in memory only. */
export interface StripeKeyPair {
  readonly secretKey: string;
  readonly publishableKey: string;
}

/** A new Stripe key pair of `environment` in Stripe's format (`sk_test_…`, `pk_test_…`). */
export function newStripeKeys(environment: "test" | "live"): StripeKeyPair {
  return {
    secretKey: `sk_${environment}_${randomBase62(32)}`,
    publishableKey: `pk_${environment}_${randomBase62(32)}`,
  };
}

/** The stack folder of the processes (see the file header). */
export interface StackFolder {
  /** MASTER_KEY_DIR: `master-v1.key`, the KEK of both zones (`local:v1`). */
  readonly keyDir: string;
  /** API_KEY_PEPPER_FILE of both backends. */
  readonly pepperFile: string;
  /** JWT_PRIVATE_KEY_FILE of the platform API and of the OTA API: fresh Ed25519 keys, PKCS#8 PEM. */
  readonly platformJwtKeyFile: string;
  readonly otaJwtKeyFile: string;
  /** DOCUMENT_URL_KEY_FILE of the OTA API. */
  readonly documentUrlKeyFile: string;
  /** STORAGE_DIR of the OTA processes: an empty folder. */
  readonly storageDir: string;
  /** The Stripe preload every process loads (`node --require`). */
  readonly stripePreload: string;
  /** Deletes the folder and everything in it. Idempotent. */
  remove(): void;
}

/** The KEK id of the stack's key folder. */
export const STACK_MASTER_KEY_CURRENT = "local:v1";

/** Writes `content` into `file` with mode 0600, whatever the umask, as `pnpm dev:keys` writes its key files. */
function writePrivateFile(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** 32 random bytes in base64, as `pnpm dev:keys` writes a key file. */
const base64Key = (): string => `${randomBytes(32).toString("base64")}\n`;

/** A new Ed25519 private key as PKCS#8 PEM, as `pnpm dev:keys` writes the signing keys. */
function ed25519Pem(): string {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

/**
 * The preload of the stack's processes (see the file header): the `stripe` module of the process, as its own code
 * resolves it from its working directory, replaced by a constructor that sends every request to `port` on 127.0.0.1.
 */
export function stripePreloadSource(port: number): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new RangeError("stripePreloadSource: not a TCP port");
  }
  return [
    '"use strict";',
    "// Written by ota/backend/test/cross-backend/stack.ts for one cross-backend stack (OBE-083), deleted with it.",
    "// It sends the Stripe requests of this process to the stack's fake Stripe API on the loopback interface.",
    'if (process.env.APP_ENV === "production") {',
    '  throw new Error("The cross-backend Stripe preload is for tests only");',
    "}",
    'const { createRequire } = require("node:module");',
    'const appRequire = createRequire(require("node:path").join(process.cwd(), "package.json"));',
    'const file = appRequire.resolve("stripe");',
    'const Stripe = appRequire("stripe");',
    `const endpoint = Object.freeze({ host: "${STACK_HOST}", port: ${port}, protocol: "http" });`,
    "function StripeOfTheStack(key, config) {",
    "  return new Stripe(key, { ...(config ?? {}), ...endpoint });",
    "}",
    "Object.setPrototypeOf(StripeOfTheStack, Stripe);",
    "StripeOfTheStack.prototype = Stripe.prototype;",
    "StripeOfTheStack.Stripe = StripeOfTheStack;",
    "StripeOfTheStack.default = StripeOfTheStack;",
    "require.cache[file].exports = StripeOfTheStack;",
    "",
  ].join("\n");
}

/** Creates a stack folder (see the file header) whose preload names the fake Stripe API on `stripePort`. */
export function createStackFolder(stripePort: number): StackFolder {
  const dir = mkdtempSync(join(tmpdir(), "velexis-ota-xb-stack-"));
  chmodSync(dir, 0o700);
  const keyDir = join(dir, "keys");
  mkdirSync(keyDir, { mode: 0o700 });
  chmodSync(keyDir, 0o700);
  writePrivateFile(join(keyDir, "master-v1.key"), base64Key());
  const pepperFile = join(keyDir, "api-key-pepper");
  writePrivateFile(pepperFile, base64Key());
  const platformJwtKeyFile = join(dir, "platform-jwt-ed25519.pem");
  writePrivateFile(platformJwtKeyFile, ed25519Pem());
  const otaJwtKeyFile = join(dir, "ota-jwt-ed25519.pem");
  writePrivateFile(otaJwtKeyFile, ed25519Pem());
  const documentUrlKeyFile = join(dir, "document-url.key");
  writePrivateFile(documentUrlKeyFile, base64Key());
  const storageDir = join(dir, "storage");
  mkdirSync(storageDir, { mode: 0o700 });
  const stripePreload = join(dir, "stripe-endpoint.cjs");
  writePrivateFile(stripePreload, stripePreloadSource(stripePort));
  return {
    keyDir,
    pepperFile,
    platformJwtKeyFile,
    otaJwtKeyFile,
    documentUrlKeyFile,
    storageDir,
    stripePreload,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---- Processes -------------------------------------------------------------------------------------------------

/** One process of the stack, while it runs. */
export interface StackProcess {
  /** `platform-api`, `platform-worker`, `ota-api` or `ota-worker`. */
  readonly name: string;
  /** The port its readiness check answers on (PORT of an API, HEALTH_PORT of a worker). */
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The process id: the same process serves every step of a file (it is never restarted). */
  readonly pid: number | undefined;
  /** The last lines it wrote to stdout and stderr, oldest first (redacted JSON log lines). */
  output(): readonly string[];
  /** How it ended (`exited with code 1`, `was stopped by SIGTERM`), or `undefined` while it runs. */
  exitDescription(): string | undefined;
  /** SIGTERM, then SIGKILL after 10 s; resolves when it has exited. Idempotent. */
  stop(): Promise<void>;
}

/** What `startProcess` starts. */
export interface ProcessSpec {
  readonly name: string;
  /** The built entry point, absolute. */
  readonly entry: string;
  /** Its working directory: its backend's folder. */
  readonly cwd: string;
  /** The port of its readiness check; set in `env` too (HEALTH_PORT or PORT). */
  readonly port: number;
  /** Its whole environment: nothing of this process's environment is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** A file for `node --require`, loaded before the entry point. */
  readonly preload?: string;
}

/** The last `OUTPUT_LINES_SHOWN` lines of `process`, for an error message. */
export function outputTail(process: Pick<StackProcess, "output">): string {
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
    this.lines.push(...parts.filter((line) => line.trim() !== ""));
    if (this.lines.length > OUTPUT_LINES_KEPT) {
      this.lines.splice(0, this.lines.length - OUTPUT_LINES_KEPT);
    }
  }

  snapshot(): readonly string[] {
    return this.partial === "" ? [...this.lines] : [...this.lines, this.partial];
  }
}

/**
 * Starts `node [--require <preload>] <entry>` and resolves when `GET /health/ready` answers 200. Rejects (after
 * stopping it) when it exits first or is not ready within READY_TIMEOUT_MS, with its last output lines.
 */
export async function startProcess(spec: ProcessSpec): Promise<StackProcess> {
  assertBuilt([spec.entry]);
  const output = new OutputBuffer();
  const args = [
    "--enable-source-maps",
    ...(spec.preload === undefined ? [] : ["--require", spec.preload]),
    spec.entry,
  ];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: spec.cwd,
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
  // A last resort when the test process ends without its afterAll (a crash, process.exit): no process outlives it.
  const kill = (): void => {
    if (exitDescription === undefined) {
      child.kill("SIGKILL");
    }
  };
  process.once("exit", kill);

  let stopping: Promise<void> | undefined;
  const url = `http://${STACK_HOST}:${spec.port}`;
  const running: StackProcess = {
    name: spec.name,
    port: spec.port,
    url,
    pid: child.pid,
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
  while (performance.now() - started < READY_TIMEOUT_MS) {
    if (exitDescription !== undefined) {
      await running.stop();
      throw new Error(
        `The ${spec.name} (${relative(REPO_ROOT, spec.entry)}) ${exitDescription} before it was ready. ` +
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
    `The ${spec.name} was not ready within ${READY_TIMEOUT_MS / 1000} s (GET ${readyUrl}: ${last}). ` +
      `Its last output:\n${outputTail(running)}`,
  );
}

/**
 * Runs the platform's `dev:seed` (`node platform/backend/dist/cli.js dev:seed`) with `values` as its whole environment.
 * Its stdout (the new admin's password and TOTP URI) is not piped into this process at all; a non-zero exit throws
 * with its stderr (log lines and problems, no secret).
 */
async function runPlatformDevSeed(values: Readonly<Record<string, string>>): Promise<void> {
  const child = spawn(process.execPath, [join(PLATFORM_BACKEND_DIR, ENTRY.cli), "dev:seed"], {
    cwd: PLATFORM_BACKEND_DIR,
    env: { ...values },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = new OutputBuffer();
  child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
  const outcome = await Promise.race([
    new Promise<string>((done) => {
      child.once("exit", (code, signal) =>
        done(signal === null ? `exited with ${code}` : `was stopped by ${signal}`),
      );
      child.once("error", (error) => done(`could not start: ${error.message}`));
    }),
    delay(SEED_TIMEOUT_MS, "timeout", { ref: false }),
  ]);
  if (outcome === "timeout") {
    child.kill("SIGKILL");
  }
  if (outcome !== "exited with 0") {
    throw new Error(
      `The platform's dev:seed ${outcome}:\n${stderr.snapshot().slice(-OUTPUT_LINES_SHOWN).join("\n")}`,
    );
  }
}

// ---- The stack -------------------------------------------------------------------------------------------------

/** The milestone switches of the platform processes (see the file header: billing stays off). */
export const PLATFORM_SWITCHES = Object.freeze({
  FEATURE_STRIPE_BILLING: "false",
  FEATURE_OWN_STRIPE: "true",
  FEATURE_SETTLEMENTS: "true",
  FEATURE_OWN_AMADEUS: "true",
  FEATURE_CUSTOM_DOMAINS: "true",
  FEATURE_LIVE_SWITCH: "true",
});

/** A started stack (see the file header). */
export interface Stack {
  /** The database clone: `db.urlFor(role)`. */
  readonly db: TestDatabase;
  /** The Redis database of every process. */
  readonly redis: TestRedis;
  /** velexis_migrator on the clone: the platform rows a test writes as the platform would (fixtures). */
  readonly migrator: Kysely<PlatformDatabase & ReferenceDatabase>;
  /** velexis_ota_app on the clone: tenant rows a test reads or writes through `tenantTx` (ADR-0004). */
  readonly tenantDb: TenantDb;
  /** The fake Stripe API every process of the stack sends its Stripe requests to. */
  readonly stripe: FakeStripe;
  /** The Velexis Stripe test keys of the OTA processes (STRIPE_SECRET_KEY_TEST, STRIPE_PUBLISHABLE_KEY_TEST). */
  readonly velexisStripe: StripeKeyPair;
  /** The Velexis stub: the account of `dev:seed`, any client accepted. */
  readonly velexisStub: AmadeusStub;
  /** The stubs of the OTA's own credentials (the platform's AMADEUS_BASE_URL_TEST and _LIVE). */
  readonly ownStubs: { readonly test: AmadeusStub; readonly live: AmadeusStub };
  /** The only credentials each own stub accepts: the OTA's own Amadeus credentials of the journeys. */
  readonly ownAmadeus: { readonly test: StubCredentials; readonly live: StubCredentials };
  readonly platformApi: StackProcess;
  readonly platformWorker: StackProcess;
  readonly otaApi: StackProcess;
  readonly otaWorker: StackProcess;
  /** The four processes. */
  processes(): readonly StackProcess[];
  /** The headers of a call from the portal's server for an end user at `ip` (PADR-0019), with the stack's BFF key. */
  bffHeaders(ip: string): Record<string, string>;
  /** The headers Caddy adds to a storefront's `/api/*` request for `host` (ADR-0018), with the stack's edge secret. */
  edgeHeaders(host: string): Record<string, string>;
  /** Stops everything and drops the database (see the file header). Idempotent. */
  stop(): Promise<void>;
}

/** A quiet pool logger: the pools of the stack report their errors through the queries that fail. */
const quietPoolLogger = { error: (): void => undefined };

/** Starts the stack (the steps of the file header). On a failure it stops what it started and rethrows. */
export async function startStack(): Promise<Stack> {
  assertBuilt();
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
    const db = await createTestDatabase();
    cleanups.push(() => db.drop());
    const redis = await useRedis();
    cleanups.push(() => redis.close());
    const pools: Array<ReturnType<typeof createPool>> = [];
    cleanups.push(async () => {
      await Promise.all(pools.map((pool) => pool.end()));
    });
    const migratorPool = createPool(db.urlFor("migrator"), {
      applicationName: "ota-xb-migrator",
      logger: quietPoolLogger,
      max: 2,
    });
    pools.push(migratorPool);
    const migrator = createPlatformDb<PlatformDatabase & ReferenceDatabase>(migratorPool);
    const otaPool = createPool(db.urlFor("ota"), {
      applicationName: "ota-xb-tenant",
      logger: quietPoolLogger,
      max: 2,
    });
    pools.push(otaPool);
    const tenantDb = createTenantDb(otaPool, { appEnv: "test" });

    // Reference rows the journeys need beyond the template's fixture, as `pnpm db:seed:reference` loads them.
    await migrator
      .insertInto("reference.time_zones")
      .values({
        name: STACK_TIME_ZONE,
        country_code: STACK_COUNTRY,
        utc_offset_minutes: 60,
        dst_offset_minutes: 120,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    await migrator
      .updateTable("reference.airports")
      .set({ time_zone: STACK_TIME_ZONE, latitude: "49.009722", longitude: "2.547778" })
      .where("iata_code", "=", "CDG")
      .execute();

    const stripe = await startFakeStripe();
    cleanups.push(() => stripe.close());
    const ownAmadeus = {
      test: {
        clientId: `xb-own-test-${randomBase62(8)}`,
        clientSecret: randomBytes(24).toString("base64url"),
      },
      live: {
        clientId: `xb-own-live-${randomBase62(8)}`,
        clientSecret: randomBytes(24).toString("base64url"),
      },
    };
    const velexisStub = await startAmadeusStub();
    cleanups.push(() => velexisStub.stop());
    const ownTestStub = await startAmadeusStub({ credentials: ownAmadeus.test });
    cleanups.push(() => ownTestStub.stop());
    const ownLiveStub = await startAmadeusStub({ credentials: ownAmadeus.live });
    cleanups.push(() => ownLiveStub.stop());

    // Removed after the processes that use it have stopped (cleanups run in reverse).
    const folder = createStackFolder(stripe.endpoint.port);
    cleanups.push(() => Promise.resolve(folder.remove()));

    const bffKey = `xb_bff_${randomBase62(40)}`;
    const edgeSecret = randomBytes(32).toString("hex");
    const velexisStripe = newStripeKeys("test");
    const [platformApiPort, platformWorkerPort, otaApiPort, otaWorkerPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
      freePort(),
    ]);
    const otaApiUrl = `http://${STACK_HOST}:${otaApiPort}`;

    // What both backends share: the run's services, the KEK folder and the pepper (identical copies, ADR-0010).
    const shared = {
      ...BLANKED_DSNS,
      APP_ENV: "test",
      LOG_LEVEL: "info",
      REDIS_URL: redis.url,
      MASTER_KEY_DIR: folder.keyDir,
      MASTER_KEY_CURRENT: STACK_MASTER_KEY_CURRENT,
      API_KEY_PEPPER_FILE: folder.pepperFile,
      SMTP_URL: settings.SMTP_URL,
      MAILPIT_API_URL: settings.MAILPIT_API_URL,
      STOREFRONT_BASE_DOMAIN: STACK_STOREFRONT_BASE_DOMAIN,
      PUBLIC_OTA_API_URL: otaApiUrl,
    };
    const platformEnv: Record<string, string> = {
      ...exampleEnv(EXAMPLE_ENV_FILES.platform),
      ...shared,
      DATABASE_URL: db.urlFor("platform"),
      PORT: String(platformApiPort),
      HEALTH_PORT: String(platformWorkerPort),
      PLATFORM_BFF_KEY: bffKey,
      JWT_PRIVATE_KEY_FILE: folder.platformJwtKeyFile,
      OPS_ALERT_EMAIL: uniqueEmail("xb-m5-ops"),
      PUBLIC_PORTAL_URL: STACK_PORTAL_URL,
      AMADEUS_BASE_URL_TEST: ownTestStub.url,
      AMADEUS_BASE_URL_LIVE: ownLiveStub.url,
      STRIPE_SECRET_KEY: `sk_test_${randomBase62(32)}`,
      STRIPE_BILLING_WEBHOOK_SECRET: `whsec_${randomBase62(32)}`,
      STRIPE_CONNECT_CLIENT_ID: `ca_${randomBase62(24)}`,
      STRIPE_CONNECT_WEBHOOK_SECRET: `whsec_${randomBase62(32)}`,
      ...PLATFORM_SWITCHES,
    };
    const otaEnv: Record<string, string> = {
      ...exampleEnv(EXAMPLE_ENV_FILES.ota),
      ...shared,
      DATABASE_URL: db.urlFor("ota"),
      // No override: every Amadeus call goes to the host of its connection or account (see the file header).
      AMADEUS_BASE_URL_TEST: "",
      AMADEUS_BASE_URL_LIVE: "",
      STORAGE_DIR: folder.storageDir,
      VELEXIS_EDGE_SECRET: edgeSecret,
      STRIPE_SECRET_KEY_TEST: velexisStripe.secretKey,
      STRIPE_PUBLISHABLE_KEY_TEST: velexisStripe.publishableKey,
      STRIPE_SECRET_KEY_LIVE: "",
      STRIPE_PUBLISHABLE_KEY_LIVE: "",
    };

    await runPlatformDevSeed({
      ...platformEnv,
      // The Velexis test account of the seed lives on the Velexis stub.
      AMADEUS_BASE_URL_TEST: velexisStub.url,
    });

    const started = await Promise.allSettled([
      startProcess({
        name: "platform-api",
        entry: join(PLATFORM_BACKEND_DIR, ENTRY.api),
        cwd: PLATFORM_BACKEND_DIR,
        port: platformApiPort,
        env: platformEnv,
        preload: folder.stripePreload,
      }),
      startProcess({
        name: "platform-worker",
        entry: join(PLATFORM_BACKEND_DIR, ENTRY.worker),
        cwd: PLATFORM_BACKEND_DIR,
        port: platformWorkerPort,
        env: platformEnv,
        preload: folder.stripePreload,
      }),
      startProcess({
        name: "ota-api",
        entry: join(OTA_BACKEND_DIR, ENTRY.api),
        cwd: OTA_BACKEND_DIR,
        port: otaApiPort,
        env: {
          ...otaEnv,
          PORT: String(otaApiPort),
          JWT_PRIVATE_KEY_FILE: folder.otaJwtKeyFile,
          DOCUMENT_URL_KEY_FILE: folder.documentUrlKeyFile,
        },
        preload: folder.stripePreload,
      }),
      startProcess({
        name: "ota-worker",
        entry: join(OTA_BACKEND_DIR, ENTRY.worker),
        cwd: OTA_BACKEND_DIR,
        port: otaWorkerPort,
        env: {
          ...otaEnv,
          // The worker alone holds the provisioner's DSN (ADR-0004, OADR-0007 item 2).
          DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
          HEALTH_PORT: String(otaWorkerPort),
        },
        preload: folder.stripePreload,
      }),
    ]);
    const processes: StackProcess[] = [];
    const failures: string[] = [];
    for (const outcome of started) {
      if (outcome.status === "fulfilled") {
        processes.push(outcome.value);
        cleanups.push(() => outcome.value.stop());
      } else {
        failures.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      }
    }
    if (failures.length > 0) {
      throw new Error(`The cross-backend stack did not start:\n${failures.join("\n\n")}`);
    }
    const [platformApi, platformWorker, otaApi, otaWorker] = processes as [
      StackProcess,
      StackProcess,
      StackProcess,
      StackProcess,
    ];

    let stopped: Promise<void> | undefined;
    return {
      db,
      redis,
      migrator,
      tenantDb,
      stripe,
      velexisStripe,
      velexisStub,
      ownStubs: { test: ownTestStub, live: ownLiveStub },
      ownAmadeus,
      platformApi,
      platformWorker,
      otaApi,
      otaWorker,
      processes: () => [platformApi, platformWorker, otaApi, otaWorker],
      bffHeaders: (ip) => ({
        "X-Velexis-Bff-Key": bffKey,
        "X-Velexis-End-User-IP": ip,
        "X-Velexis-End-User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0",
      }),
      edgeHeaders: (host) => ({ "X-Velexis-Edge": edgeSecret, "X-Velexis-Host": host }),
      stop: () => (stopped ??= cleanUp()),
    };
  } catch (error) {
    await cleanUp().catch(() => undefined);
    throw error;
  }
}

/** The processes of `stack` that are no longer running, with how each ended: empty while all four run. */
export function exitedProcesses(stack: Pick<Stack, "processes">): string[] {
  return stack.processes().flatMap((process) => {
    const exit = process.exitDescription();
    return exit === undefined ? [] : [`${process.name} ${exit}:\n${outputTail(process)}`];
  });
}

// ---- HTTP ------------------------------------------------------------------------------------------------------

/** An answer of an API of the stack: the status, the parsed JSON body (`undefined` without one) and the headers. */
export interface HttpAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/**
 * `method path` on `baseUrl` (an API of the stack, on 127.0.0.1) with `headers` and a JSON `body`. Rejects when no
 * answer comes within CALL_TIMEOUT_MS or the body is not JSON. Never logs a header or a body (they may hold a key).
 */
export async function httpCall(
  baseUrl: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  {
    headers = {},
    body,
  }: { readonly headers?: Readonly<Record<string, string>>; readonly body?: unknown } = {},
): Promise<HttpAnswer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} answered ${response.status} with a body that is not JSON`);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** `<status>`, or `<status> <code>` of an error answer: never a body value (it may hold a token). */
export function outcomeOf(answer: Pick<HttpAnswer, "status" | "body">): string {
  const code = (answer.body as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === "string" ? `${answer.status} ${code}` : String(answer.status);
}

/** Throws unless `answer` has `status`, naming the operation and the outcome. */
export function expectStatus(answer: HttpAnswer, status: number, operation: string): void {
  if (answer.status !== status) {
    const reason = (answer.body as { error?: { details?: unknown } } | undefined)?.error?.details;
    const details = reason === undefined ? "" : ` (details ${JSON.stringify(reason)})`;
    throw new Error(`${operation} answered ${outcomeOf(answer)}${details}, not ${status}`);
  }
}

/** A call of the platform API (`method path`) with `headers` and a JSON `body`. */
export function platformCall(
  stack: Pick<Stack, "platformApi">,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: { readonly headers?: Readonly<Record<string, string>>; readonly body?: unknown } = {},
): Promise<HttpAnswer> {
  return httpCall(stack.platformApi.url, method, path, options);
}

// ---- TOTP ------------------------------------------------------------------------------------------------------

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The bytes of a base32 secret (RFC 4648, no padding), as authenticator apps read the portal's MFA secret. */
function base32Bytes(secret: string): Buffer {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(character);
    if (index < 0) {
      throw new TypeError("not a base32 secret");
    }
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The TOTP step of `at` (30 seconds, PADR-0008 item 1). */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 30_000);
}

/** The six-digit TOTP code (RFC 6238: HMAC-SHA-1, 30-second steps) of `secret` for the time step `step`. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Bytes(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// ---- Journeys through the platform API -------------------------------------------------------------------------

/** A verified, signed-in portal account. */
export interface PortalOwner {
  readonly email: string;
  readonly accountId: string;
  /** The end user's IP of every call. */
  readonly ip: string;
  /** The bearer and the PADR-0019 headers of a portal call; after `enableMfaWithStepUp`, a stepped-up session's. */
  headers: Record<string, string>;
}

/** The token of the message's `/verify-email` link of the portal. */
function verificationToken(message: Parameters<typeof extractLinks>[0]): string {
  const prefix = `${STACK_PORTAL_URL}/verify-email?token=`;
  const link = extractLinks(message).find((url) => url.startsWith(prefix));
  const token = link === undefined ? null : new URL(link).searchParams.get("token");
  if (token === null) {
    throw new Error("the verification e-mail has no /verify-email link");
  }
  return token;
}

/**
 * Signs up a new account (`signUp`), verifies its address with the token of the e-mail the platform worker sent to
 * Mailpit (`verifyEmail`) and signs it in (`signIn`). The address is `uniqueEmail(label)`, the password a new random
 * one (never logged), and every call comes from end-user `ip`.
 */
export async function signUpOwner(
  stack: Stack,
  { label, ip }: { readonly label: string; readonly ip: string },
): Promise<PortalOwner> {
  const bff = stack.bffHeaders(ip);
  const email = uniqueEmail(label);
  const password = `Xb-${randomBytes(18).toString("base64url")}`;
  const signUp = await platformCall(stack, "POST", "/v1/auth/sign-up", {
    headers: bff,
    body: { email, password, fullName: "Ada Lovelace", acceptTerms: true, termsVersion: STACK_TERMS_VERSION },
  });
  expectStatus(signUp, 202, "signUp");
  const message = await mailpit.waitForMessage({
    to: email,
    subject: VERIFY_SUBJECT,
    timeoutMs: MAIL_TIMEOUT_MS,
  });
  const verify = await platformCall(stack, "POST", "/v1/auth/verify-email", {
    headers: bff,
    body: { token: verificationToken(message) },
  });
  expectStatus(verify, 200, "verifyEmail");
  const signIn = await platformCall(stack, "POST", "/v1/auth/sign-in", {
    headers: bff,
    body: { email, password },
  });
  expectStatus(signIn, 200, "signIn");
  const session = signIn.body as { accessToken?: unknown; account?: { id?: unknown } };
  if (typeof session.accessToken !== "string" || typeof session.account?.id !== "string") {
    throw new Error("signIn answered no portal session (an MFA challenge?)");
  }
  return {
    email,
    accountId: session.account.id,
    ip,
    headers: { Authorization: `Bearer ${session.accessToken}`, ...bff },
  };
}

/**
 * Turns MFA on for `owner` (startMfaSetup, enableMfa with the code of the current step) and steps up (stepUp with the
 * code of the next step, which the platform accepts as the step after the one enableMfa used, ±1 step): from then on
 * `owner.headers` carry the stepped-up session, which the sensitive operations accept for 15 minutes. The secret stays
 * in this function.
 */
export async function enableMfaWithStepUp(stack: Stack, owner: PortalOwner): Promise<void> {
  const setup = await platformCall(stack, "POST", "/v1/me/mfa/setup", { headers: owner.headers });
  expectStatus(setup, 200, "startMfaSetup");
  const { secret } = setup.body as { secret: string };
  const step = totpStep(new Date());
  const enable = await platformCall(stack, "POST", "/v1/me/mfa/enable", {
    headers: owner.headers,
    body: { code: totpCode(secret, step) },
  });
  expectStatus(enable, 200, "enableMfa");
  const stepUp = await platformCall(stack, "POST", "/v1/auth/step-up", {
    headers: owner.headers,
    body: { code: totpCode(secret, step + 1) },
  });
  expectStatus(stepUp, 200, "stepUp");
  const { accessToken } = stepUp.body as { accessToken: string };
  owner.headers = { ...owner.headers, Authorization: `Bearer ${accessToken}` };
}

/** A new OTA, as createTenant answered it. */
export interface CreatedOta {
  readonly tenantId: string;
  readonly key: string;
  /** `tenant_<key>`: the schema the OTA worker builds. */
  readonly schemaName: string;
  /** `<key>.<STOREFRONT_BASE_DOMAIN>`: its storefront sub-domain. */
  readonly storefrontHost: string;
}

/** Creates an OTA through the API (`createTenant`, a new Idempotency-Key) in STACK_COUNTRY, STACK_CURRENCY and zone. */
export async function createOta(
  stack: Stack,
  owner: PortalOwner,
  { key, name }: { readonly key: string; readonly name: string },
): Promise<CreatedOta> {
  const answer = await platformCall(stack, "POST", "/v1/tenants", {
    headers: { ...owner.headers, "Idempotency-Key": randomUUID() },
    body: {
      key,
      name,
      countryCode: STACK_COUNTRY,
      defaultCurrency: STACK_CURRENCY,
      timeZone: STACK_TIME_ZONE,
    },
  });
  expectStatus(answer, 202, "createTenant");
  const { tenant } = answer.body as { tenant: { id: string; key: string } };
  return {
    tenantId: tenant.id,
    key: tenant.key,
    schemaName: `tenant_${tenant.key}`,
    storefrontHost: `${tenant.key}.${STACK_STOREFRONT_BASE_DOMAIN}`,
  };
}

/** The parts of a getProvisioning answer that `waitForSetup` reads. */
interface ProvisioningProgress {
  readonly tenantStatus: string;
  readonly job: {
    readonly status: string;
    readonly step: string | null;
    readonly error: { code?: string } | null;
  };
}

/**
 * Reads the setup progress (`getProvisioning`) every POLL_MS until the tenant is `active`. Rejects with what it last
 * saw and the OTA worker's last output when the tenant or its job fails, when the API refuses the read (a 4xx other
 * than 429), when a process of the stack exits, or after SETUP_TIMEOUT_MS: a clear failure, not a timeout.
 */
export async function waitForSetup(stack: Stack, owner: PortalOwner, tenantId: string): Promise<void> {
  const started = performance.now();
  let last = "no answer yet";
  const fail = (why: string): Error =>
    new Error(
      `The OTA ${tenantId} ${why}. Last progress: ${last}. The OTA worker's last output:\n${outputTail(stack.otaWorker)}`,
    );
  for (;;) {
    const answer = await platformCall(stack, "GET", `/v1/tenants/${tenantId}/provisioning`, {
      headers: owner.headers,
    });
    if (answer.status === 200) {
      const { tenantStatus, job } = answer.body as ProvisioningProgress;
      last = `tenant ${tenantStatus}, job ${job.status} at step ${job.step ?? "-"}${job.error?.code === undefined ? "" : `, error ${job.error.code}`}`;
      if (tenantStatus === "active") {
        return;
      }
      if (tenantStatus === "failed" || job.status === "failed" || job.status === "canceled") {
        throw fail("did not become active");
      }
    } else {
      last = `getProvisioning answered ${outcomeOf(answer)}`;
      if (answer.status >= 400 && answer.status < 500 && answer.status !== 429) {
        throw fail("cannot be followed");
      }
    }
    const exited = exitedProcesses(stack);
    if (exited.length > 0) {
      throw fail(`is not active, and ${exited.join("; ")}`);
    }
    if (performance.now() - started >= SETUP_TIMEOUT_MS) {
      throw fail(`was not active within ${SETUP_TIMEOUT_MS / 1000} s`);
    }
    await delay(POLL_MS);
  }
}

/** A key createApiKey answered: the full key stays in this process's memory only. */
export interface CreatedKey {
  readonly answer: HttpAnswer;
  readonly id: string;
  readonly key: string;
}

/** Creates a secret key of `environment` with the `storefront` scope (createApiKey), as the OTA's owner. */
export async function createSecretKey(
  stack: Stack,
  owner: PortalOwner,
  tenantId: string,
  environment: "test" | "live" = "test",
): Promise<CreatedKey> {
  const answer = await platformCall(stack, "POST", `/v1/tenants/${tenantId}/api-keys`, {
    headers: owner.headers,
    body: { name: `Storefront server (${environment})`, kind: "secret", environment, scopes: ["storefront"] },
  });
  expectStatus(answer, 201, "createApiKey");
  const { apiKey, key } = answer.body as { apiKey: { id: string }; key: string };
  return { answer, id: apiKey.id, key };
}

/** The final states of a credential submission (getCredentialSubmission). */
const FINAL_SUBMISSION_STATUSES: ReadonlySet<string> = new Set(["applied", "failed", "superseded"]);

/** A credential submission as getCredentialSubmission answers it. */
export interface Submission {
  readonly id: string;
  readonly kind: string;
  readonly environment: string;
  readonly status: string;
  readonly errorCode: string | null;
}

/**
 * Follows a credential submission (getCredentialSubmission every POLL_MS) until it is final, and answers that answer.
 * Rejects after SUBMISSION_TIMEOUT_MS with the last status and the platform worker's last output.
 */
export async function waitForSubmission(
  stack: Stack,
  owner: PortalOwner,
  tenantId: string,
  submissionId: string,
): Promise<HttpAnswer> {
  const started = performance.now();
  let last: HttpAnswer | undefined;
  for (;;) {
    last = await platformCall(
      stack,
      "GET",
      `/v1/tenants/${tenantId}/credential-submissions/${submissionId}`,
      {
        headers: owner.headers,
      },
    );
    expectStatus(last, 200, "getCredentialSubmission");
    if (FINAL_SUBMISSION_STATUSES.has((last.body as Submission).status)) {
      return last;
    }
    if (performance.now() - started >= SUBMISSION_TIMEOUT_MS) {
      throw new Error(
        `The submission ${submissionId} was still ${(last.body as Submission).status} after ` +
          `${SUBMISSION_TIMEOUT_MS / 1000} s. The platform worker's last output:\n${outputTail(stack.platformWorker)}`,
      );
    }
    await delay(POLL_MS);
  }
}
