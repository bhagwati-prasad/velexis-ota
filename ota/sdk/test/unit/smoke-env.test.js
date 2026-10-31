// The smoke run's own safeguards (SDK-014; test/smoke/smoke-env.js, vitest.smoke.config.js): the smoke tests need a
// running OTA API, so they are not part of `test`, but what they do when there is none is. When the API is down, the
// run fails at once with a message that says so (a refused connection, a host that never answers within the short
// bound, a server that is not the API), before any test file runs and before any setting is read; a missing or
// malformed key is named without its value; the portal token and the platform ids match what the OTA backend accepts.
//
// The loopback servers are made here; nothing reaches the network. Running the smoke configuration against a closed
// port spawns Vitest once, in a set-up hook with a budget of its own.
import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertApiReachable,
  checkSmokeRun,
  newPlatformId,
  newPortalToken,
  newSmokeEndUser,
  PROBE_TIMEOUT_MS,
  readSmokeSettings,
  SmokeSetupError,
} from "../smoke/smoke-env.js";

const SDK_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** The settings of a complete run, made up (none of them reaches anything here). */
const SETTINGS = Object.freeze({
  OTA_API_URL: "http://127.0.0.1:4000",
  SDK_SMOKE_PUBLISHABLE_KEY: `pk_test_${"a".repeat(40)}`,
  SDK_SMOKE_SECRET_KEY: `sk_test_${"b".repeat(40)}`,
  SDK_SMOKE_CONSOLE_KEY: `sk_test_${"d".repeat(40)}`,
  REDIS_URL: "redis://127.0.0.1:6379/0",
  DATABASE_MIGRATOR_URL: "postgres://velexis_migrator:dev_migrator@127.0.0.1:5432/velexis",
});

/** @type {Array<() => Promise<void>>} */
const closers = [];

/**
 * Listens on a free loopback port until the file's end, when it drops its connections and closes.
 * @param {import("node:net").Server} server
 */
async function listen(server) {
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        for (const socket of sockets) {
          socket.destroy();
        }
      }),
  );
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return `http://127.0.0.1:${address.port}`;
}

/** A loopback URL where nothing listens: a port bound a moment ago, then released. */
async function closedUrl() {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return `http://127.0.0.1:${address.port}`;
}

/** @type {string} */
let down;
/** @type {string} */
let silent;
/** @type {string} */
let notTheApi;
/** @type {string} */
let live;
/** @type {string[]} */
const livePaths = [];
/** @type {{ code: number | null, output: string }} */
let smokeRun;

/**
 * Spawning Vitest on the smoke configuration: about two seconds locally (Vitest's start and the refused connection);
 * the bound allows for a busy 4-CPU runner and only stops a run that hangs.
 */
const SMOKE_RUN_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  down = await closedUrl();
  // Accepts connections and never answers: a host that hangs.
  silent = await listen(createTcpServer(() => undefined));
  notTheApi = await listen(
    createHttpServer((_request, response) => {
      response.writeHead(503, { "Content-Type": "text/plain" }).end("maintenance");
    }),
  );
  live = await listen(
    createHttpServer((request, response) => {
      livePaths.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
    }),
  );
  // The smoke configuration against the closed port, as `pnpm --filter @velexis/ota-sdk test:smoke` runs it, with keys
  // that are well-formed: the run must fail on the API, not on a setting.
  smokeRun = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(SDK_DIR, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.smoke.config.js"],
      {
        cwd: SDK_DIR,
        env: { ...process.env, ...SETTINGS, OTA_API_URL: down, CI: "true", NO_COLOR: "1" },
        timeout: SMOKE_RUN_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          output: `${stdout}${stderr}`,
        });
      },
    );
  });
}, SMOKE_RUN_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

describe("the reachability check of the smoke run", () => {
  it("fails at once on a refused connection, naming the API and what to start [SDK-014 AC1]", async () => {
    const error = await assertApiReachable(down).catch((/** @type {unknown} */ caught) => caught);
    expect(error).toBeInstanceOf(SmokeSetupError);
    expect(String(error)).toContain(
      `The OTA API at ${down} is not reachable (GET /health/live: ECONNREFUSED)`,
    );
    expect(String(error)).toContain("dev:seed");
  });

  it("gives up on a host that never answers after its short bound [SDK-014 AC1]", async () => {
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    const error = await assertApiReachable(silent, { timeoutMs: 200 }).catch(
      (/** @type {unknown} */ caught) => caught,
    );
    expect(error).toBeInstanceOf(SmokeSetupError);
    expect(String(error)).toContain(
      `The OTA API at ${silent} is not reachable (GET /health/live: no answer within 200 ms)`,
    );
  });

  it("refuses a server that answers something else than the API's 200 [SDK-014 AC1]", async () => {
    const error = await assertApiReachable(notTheApi).catch((/** @type {unknown} */ caught) => caught);
    expect(error).toBeInstanceOf(SmokeSetupError);
    expect(String(error)).toContain(
      `The OTA API at ${notTheApi} answered GET /health/live with 503, not 200`,
    );
  });

  it("passes when the API answers GET /health/live, a trailing slash of OTA_API_URL included [SDK-014 AC1]", async () => {
    await expect(assertApiReachable(`${live}/`)).resolves.toBeUndefined();
    expect(livePaths).toEqual(["/health/live"]);
  });

  it("checks the API before the settings, so a stack that is down is what it reports [SDK-014 AC1]", async () => {
    const error = await checkSmokeRun({ OTA_API_URL: down }).catch((/** @type {unknown} */ caught) => caught);
    expect(String(error)).toContain("is not reachable");
    await expect(checkSmokeRun({ ...SETTINGS, OTA_API_URL: live })).resolves.toBeUndefined();
  });

  it("makes `test:smoke` fail before any test file when the API is down [SDK-014 AC1]", () => {
    expect(smokeRun.code).toBe(1);
    expect(smokeRun.output).toContain(`SmokeSetupError: The OTA API at ${down} is not reachable`);
    expect(smokeRun.output).not.toMatch(/Tests\s+\d+ passed/);
  });
});

describe("the settings of the smoke run", () => {
  it("[FIX-W37-OTA AC5] needs dev:seed's console automation key, and no longer the OTA admin's service key", () => {
    /** @type {unknown} */
    let error;
    try {
      readSmokeSettings({ ...SETTINGS, SDK_SMOKE_CONSOLE_KEY: undefined });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SmokeSetupError);
    expect(String(error)).toContain("SDK_SMOKE_CONSOLE_KEY is required but missing");
    expect(String(error)).toContain("SDK_SMOKE_CONSOLE_KEY");
    // A live key, or the service key's shape, is not the console key of dev:seed's test OTA.
    for (const value of [`sk_live_${"e".repeat(40)}`, "sk_dev_ota_admin_service_key_change_me"]) {
      expect(() => readSmokeSettings({ ...SETTINGS, SDK_SMOKE_CONSOLE_KEY: value })).toThrow(
        /SDK_SMOKE_CONSOLE_KEY does not match/,
      );
    }
    const settings = readSmokeSettings({
      ...SETTINGS,
      OTA_ADMIN_SERVICE_KEY: "sk_dev_ota_admin_service_key_change_me",
    });
    expect(Object.keys(settings)).not.toContain("OTA_ADMIN_SERVICE_KEY");
  });

  it("names each missing or malformed setting, never its value [SDK-014 AC1]", () => {
    const secret = `sk_live_${"c".repeat(40)}`;
    /** @type {unknown} */
    let error;
    try {
      readSmokeSettings({ ...SETTINGS, SDK_SMOKE_PUBLISHABLE_KEY: undefined, SDK_SMOKE_SECRET_KEY: secret });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SmokeSetupError);
    const message = String(error);
    expect(message).toContain("SDK_SMOKE_PUBLISHABLE_KEY is required but missing");
    expect(message).toContain("SDK_SMOKE_SECRET_KEY does not match");
    expect(message).not.toContain("cccc");
  });

  it("defaults OTA_API_URL to the API's local port and reads every other setting as given [SDK-014 AC1]", () => {
    expect(readSmokeSettings({ ...SETTINGS, OTA_API_URL: undefined })).toEqual({
      ...SETTINGS,
      OTA_API_URL: "http://127.0.0.1:4000",
    });
    expect(readSmokeSettings({ ...SETTINGS, OTA_API_URL: "http://127.0.0.1:4600" }).OTA_API_URL).toBe(
      "http://127.0.0.1:4600",
    );
  });
});

describe("the test staff member's credentials", () => {
  it("makes portal tokens and platform ids the OTA backend accepts [SDK-014 AC1]", () => {
    // The patterns of ota/backend/src/identity/staff/staff-sessions.ts (PORTAL_TOKEN_PATTERN and the ULID ids) and of
    // the platform's createConsoleToken (`ptk_` and 43 base62 characters).
    const tokens = Array.from({ length: 50 }, () => newPortalToken());
    expect(tokens.every((token) => /^ptk_[A-Za-z0-9]{43}$/.test(token))).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(newPlatformId("acc")).toMatch(/^acc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newPlatformId("stf")).toMatch(/^stf_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("names a new end user of the IPv6 documentation prefix each run, so the per-IP limits count runs apart [SDK-014 AC1]", () => {
    // The API takes a secret key's X-Velexis-End-User-IP when it is an IP address, and counts IPv6 limits by /64.
    const users = Array.from({ length: 20 }, () => newSmokeEndUser());
    for (const user of users) {
      expect(isIP(user.ip)).toBe(6);
      expect(user.ip).toMatch(/^2001:db8:[0-9a-f]{1,4}:[0-9a-f]{1,4}::1$/);
      expect(user.userAgent).toBe("velexis-sdk-smoke");
    }
    const subnets = new Set(users.map((user) => user.ip.split(":").slice(0, 4).join(":")));
    expect(subnets.size).toBeGreaterThan(1);
  });
});
