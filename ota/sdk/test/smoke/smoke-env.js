// What the SDK's smoke tests share (SDK-014; ota/sdk/README.md §8.1): their settings, the reachability check that
// vitest.smoke.config.js runs once as its global setup, the customer journey both modes call, and the test staff
// session of the server mode.
//
// The smoke tests run against a running OTA API wired to the Amadeus stub, with the two test keys the OTA backend's
// `dev:seed` printed when it created them (ota/backend/README.md §5 and §6). Nothing here starts a process: the stack
// is the developer's (or the nightly workflow's, .github/workflows/e2e.yml), and the keys are given, never stored.
//
// Settings, read through @velexis/config from the environment, then the `.env.local` files of ota/sdk and of the
// repository root (as the apps read theirs), and never printed: a refusal names the variable, not its value.
//
//   OTA_API_URL                 the API on a direct loopback connection (default http://127.0.0.1:4000, the API's port)
//   SDK_SMOKE_PUBLISHABLE_KEY   the `pk_test_…` key dev:seed printed (token mode)
//   SDK_SMOKE_SECRET_KEY        the `sk_test_…` key dev:seed printed (server mode; scoped `storefront`)
//   OTA_ADMIN_SERVICE_KEY       the OTA admin's service key of the same stack (root .env.example's development value)
//   REDIS_URL                   the API's Redis, where the test portal token is stored as the platform's API stores it
//   DATABASE_MIGRATOR_URL       the stack database as velexis_migrator, for the test staff member's platform rows
//
// When the API is down, the global setup fails at once with what to do: the check waits PROBE_TIMEOUT_MS at most, so a
// host that does not answer cannot hang the run, and the clients send each request once (`maxRetries: 0`) with a
// timeout of REQUEST_TIMEOUT_MS, so an API that stops answering in the middle fails the calls instead of stalling them.
//
// The test staff member (server mode): dev:seed's secret key is scoped `storefront`, which the scope guard refuses on
// every console operation (403 SCOPE_NOT_ALLOWED, `storefront_key`), so the console's staff session is the OTA admin's:
// the service key, a staff token signed in with a portal token. `openTestStaffSession` writes what the platform would
// have written before its `createConsoleToken` (an active account with an `agent` membership of the demo OTA, as
// velexis_migrator, like the end-to-end harness's platform rows and dev:seed itself) and stores the portal token as
// that operation does (`SET ptk:<sha256> <json> EX 60 NX`, PADR-0007 item 1); `close` signs the session out and deletes
// the account again (its membership goes with it). No token, key or password is ever logged or printed.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ConfigError, defineConfig, env, loadDevEnvFiles } from "@velexis/config";

/** The SDK package's folder: its `.env.local` comes before the repository root's. */
export const SDK_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** How long the reachability check waits for `GET /health/live`: short, so a host that drops packets fails fast. */
export const PROBE_TIMEOUT_MS = 3_000;

/** Each request of the smoke clients: the slowest call, flights.search against the stub, takes well under a second. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The budget of a file's set-up hook, which makes all of its calls (about fifteen, each bounded by REQUEST_TIMEOUT_MS
 * and sent once): a few seconds locally; the bound only stops a run that hangs.
 */
export const CALLS_TIMEOUT_MS = 90_000;

/** How long the test staff session waits for PostgreSQL and Redis to accept a connection: a stack that is down fails. */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * The budget of the server-mode file's clean-up hook: the staff sign-out (one request, REQUEST_TIMEOUT_MS at most), then
 * the account's DELETE, so an API that stopped answering still leaves no test staff member behind.
 */
export const CLOSE_TIMEOUT_MS = REQUEST_TIMEOUT_MS + 10_000;

/** The demo OTA of dev:seed (ota/backend/src/dev/dev-seed.command.ts). */
export const DEMO_TENANT_KEY = "demo";

/**
 * The test staff member's role: `agent`, the least role with `amadeus:read` (ota/docs/scope.md §1.3), which the raw
 * Amadeus reads of the server-mode file need; no settings, refunds or raw writes.
 */
export const SMOKE_STAFF_ROLE = "agent";

/**
 * The end user a server-mode client names on every call (the SDK's `endUser` option: X-Velexis-End-User-IP and -Agent),
 * as a third-party server forwards its visitor, and as the OTA admin's service key requires (OADR-0011 point 4): an
 * address of the IPv6 documentation prefix 2001:db8::/32 (RFC 3849) in a random /64 of its own. The API counts its
 * limits per end-user IP (5 sign-ups an hour, architecture §8; IPv6 by /64), so each run counts apart and the smoke
 * run can be repeated on one stack; without it every server-mode call would count against the API's loopback client.
 */
export function newSmokeEndUser() {
  const group = () => randomBytes(2).readUInt16BE(0).toString(16);
  return Object.freeze({ ip: `2001:db8:${group()}:${group()}::1`, userAgent: "velexis-sdk-smoke" });
}

/** The settings of the reachability check. */
const API_SCHEMA = {
  OTA_API_URL: env.url({ protocols: ["http:", "https:"], default: "http://127.0.0.1:4000" }),
};

/** Every setting of the smoke run (the file header). */
export const SMOKE_SCHEMA = {
  ...API_SCHEMA,
  // PADR-0005: the environment, then 40 base62 characters (dev:seed's newTestKey).
  SDK_SMOKE_PUBLISHABLE_KEY: env.string({ pattern: /^pk_test_[0-9A-Za-z]{40}$/ }),
  SDK_SMOKE_SECRET_KEY: env.string({ pattern: /^sk_test_[0-9A-Za-z]{40}$/ }),
  // The pattern of ota/backend/src/config.ts (SERVICE_KEY_PATTERN).
  OTA_ADMIN_SERVICE_KEY: env.string({ pattern: /^sk_[A-Za-z0-9_]{16,}$/ }),
  REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
  DATABASE_MIGRATOR_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
};

/** @typedef {import("@velexis/config").ConfigOf<typeof SMOKE_SCHEMA>} SmokeSettings */

/** A smoke run that cannot start: its message says what is missing and what to do, and never quotes a value. */
export class SmokeSetupError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SmokeSetupError";
  }
}

const HOW_TO_START =
  "Start the OTA API with the Amadeus stub and run the platform's and the OTA backend's dev:seed first " +
  "(ota/sdk/README.md §8.1, ota/backend/README.md §6)";

/**
 * Validates `schema` against `source`, or against the environment after the `.env.local` files.
 * @template {import("@velexis/config").ConfigSchema} S
 * @param {S} schema
 * @param {import("@velexis/config").EnvSource} [source]
 * @returns {import("@velexis/config").ConfigOf<S>}
 */
function readConfig(schema, source) {
  if (source === undefined) {
    loadDevEnvFiles({ appDir: SDK_DIR });
  }
  try {
    return source === undefined ? defineConfig(schema) : defineConfig(schema, source);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new SmokeSetupError(
        `The SDK smoke tests are not configured. ${HOW_TO_START}, then pass the two keys its dev:seed printed as ` +
          `SDK_SMOKE_PUBLISHABLE_KEY and SDK_SMOKE_SECRET_KEY.\n${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Every setting of the smoke run (the file header); throws `SmokeSetupError` naming each variable that is missing or
 * malformed.
 * @param {import("@velexis/config").EnvSource} [source] Default: the environment and the `.env.local` files.
 * @returns {SmokeSettings}
 */
export function readSmokeSettings(source) {
  return readConfig(SMOKE_SCHEMA, source);
}

/**
 * The origin of `url` (credentials, path and query left out): what a message may name.
 * @param {string} url
 */
function originOf(url) {
  return new URL(url).origin;
}

/**
 * Why a fetch failed, in a few words: a timeout, or the network error's code (ECONNREFUSED …).
 * @param {unknown} error
 * @param {number} timeoutMs
 */
function failureOf(error, timeoutMs) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `no answer within ${timeoutMs} ms`;
  }
  const cause = error instanceof Error ? /** @type {{ code?: unknown }} */ (error.cause) : undefined;
  if (cause !== null && typeof cause === "object" && typeof cause.code === "string") {
    return cause.code;
  }
  return error instanceof Error ? error.name : "the request failed";
}

/**
 * Resolves when the API at `baseUrl` answers `GET /health/live` with 200 within `timeoutMs`; otherwise throws a
 * `SmokeSetupError` that names the API's origin, why it failed and what to do.
 * @param {string} baseUrl
 * @param {{ timeoutMs?: number, fetch?: typeof fetch }} [options]
 */
export async function assertApiReachable(baseUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/health/live`;
  /** @type {Response} */
  let response;
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await response.body?.cancel();
  } catch (error) {
    throw new SmokeSetupError(
      `The OTA API at ${originOf(baseUrl)} is not reachable (GET /health/live: ${failureOf(error, timeoutMs)}). ` +
        `${HOW_TO_START}, or set OTA_API_URL to where it listens.`,
    );
  }
  if (response.status !== 200) {
    throw new SmokeSetupError(
      `The OTA API at ${originOf(baseUrl)} answered GET /health/live with ${response.status}, not 200: is it the ` +
        `OTA API? ${HOW_TO_START}, or set OTA_API_URL to where it listens.`,
    );
  }
}

/**
 * What the global setup checks before any test file runs: the API answers (first, so a stack that is down is said
 * first), then every setting is there.
 * @param {import("@velexis/config").EnvSource} [source] Default: the environment and the `.env.local` files.
 * @param {{ timeoutMs?: number }} [options]
 */
export async function checkSmokeRun(source, options = {}) {
  const { OTA_API_URL } = readConfig(API_SCHEMA, source);
  await assertApiReachable(OTA_API_URL, options);
  readSmokeSettings(source);
}

/** Vitest's global setup of vitest.smoke.config.js: the run fails here, before any test file, when it cannot work. */
export async function setup() {
  await checkSmokeRun();
}

// ---- Outcomes of the calls ----------------------------------------------------------------------------------------

/** @typedef {{ readonly ok: true, readonly value: any } | { readonly ok: false, readonly error: unknown }} Outcome */

/**
 * Runs `call` and keeps what it gave: a set-up hook makes every call, the tests read the outcomes, so one failed call
 * fails its own test and the others still report.
 * @param {() => Promise<unknown>} call
 * @returns {Promise<Outcome>}
 */
export async function settle(call) {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The value of a call that succeeded; rethrows the error of one that failed, so the test shows the SDK's error.
 * @param {Outcome | undefined} outcome
 */
export function resultOf(outcome) {
  if (outcome === undefined) {
    throw new Error("the call was not made: an earlier call it needs failed");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/**
 * The error of a call that had to fail; throws when it succeeded.
 * @param {Outcome | undefined} outcome
 * @returns {any}
 */
export function refusalOf(outcome) {
  if (outcome === undefined) {
    throw new Error("the call was not made: an earlier call it needs failed");
  }
  if (outcome.ok) {
    throw new Error("the call succeeded, but it should have been refused");
  }
  return outcome.error;
}

// ---- The customer journey -----------------------------------------------------------------------------------------

/** A date `days` from today (UTC), `YYYY-MM-DD`: the stub prices any future date. */
export function daysAhead(/** @type {number} */ days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** A unique e-mail address of this run (example.com: nothing is delivered anywhere). */
export function smokeEmail(/** @type {string} */ label) {
  return `sdk-smoke.${label}.${randomBytes(6).toString("hex")}@example.com`;
}

/**
 * One call of each customer namespace, in the order a storefront makes them: storefront.get, reference.locations,
 * flights.search and flights.price, checkout.create (a guest checkout of the priced offer), auth.signUp (a new customer
 * with a session), account.get and bookings.list with its access token, then auth.signOut. A call that needs an earlier
 * call's result is left out when that call failed.
 * @param {import("../../src/index.js").VelexisClient} client
 * @param {{ label: string }} options
 */
export async function customerJourney(client, options) {
  /** @type {Record<string, Outcome>} */
  const outcomes = {};
  const email = smokeEmail(options.label);
  // A password made up for this run: long enough, not on the breached list, never printed.
  const password = `Smoke-${randomBytes(12).toString("base64url")}`;

  outcomes["storefront.get"] = await settle(() => client.storefront.get());
  outcomes["reference.locations.search"] = await settle(() =>
    client.reference.locations.search({ keyword: "par", limit: 3 }),
  );
  outcomes["flights.search"] = await settle(() =>
    client.flights.search({
      mode: "simple",
      originLocationCode: "PAR",
      destinationLocationCode: "NYC",
      departureDate: daysAhead(30),
      returnDate: daysAhead(37),
      adults: 1,
      currencyCode: "EUR",
      resultOptions: { limit: 5, view: "summary" },
    }),
  );
  const search = outcomes["flights.search"];
  const offerId = search.ok ? search.value?.offers?.[0]?.id : undefined;
  if (typeof offerId === "string") {
    outcomes["flights.price"] = await settle(() => client.flights.price({ offerIds: [offerId] }));
  }
  const priced = outcomes["flights.price"];
  if (priced?.ok === true && typeof priced.value?.id === "string") {
    outcomes["checkout.create"] = await settle(() =>
      client.checkout.create({ pricedOfferId: priced.value.id }),
    );
  }
  const storefront = outcomes["storefront.get"];
  const termsVersion = storefront.ok ? storefront.value?.legal?.termsVersion : undefined;
  if (typeof termsVersion === "string") {
    outcomes["auth.signUp"] = await settle(() =>
      client.auth.signUp({
        email,
        password,
        firstName: "Sam",
        lastName: "Smoke",
        marketingConsent: false,
        termsVersion,
      }),
    );
  }
  const signedUp = outcomes["auth.signUp"];
  const accessToken = signedUp?.ok === true ? signedUp.value?.session?.accessToken : undefined;
  if (typeof accessToken === "string") {
    outcomes["account.get"] = await settle(() => client.account.get({}, { accessToken }));
    outcomes["bookings.list"] = await settle(() => client.bookings.list({}, { accessToken }));
  }
  return { outcomes, email, accessToken: typeof accessToken === "string" ? accessToken : undefined };
}

/**
 * Ends the customer session the journey opened (auth.signOut): its outcome.
 * @param {import("../../src/index.js").VelexisClient} client
 * @param {string | undefined} accessToken
 * @returns {Promise<Outcome | undefined>}
 */
export async function signOutCustomer(client, accessToken) {
  return accessToken === undefined ? undefined : settle(() => client.auth.signOut({}, { accessToken }));
}

// ---- The test staff member (server mode) --------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * `<prefix>_<ULID>`: 10 characters of the time, 16 random ones (Crockford base32), as the platform's ids.
 * @param {"acc" | "stf"} prefix
 */
export function newPlatformId(prefix) {
  let time = Date.now();
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = `${CROCKFORD[time % 32]}${head}`;
    time = Math.floor(time / 32);
  }
  let tail = "";
  for (const byte of randomBytes(16)) {
    tail += CROCKFORD[byte % 32];
  }
  return `${prefix}_${head}${tail}`;
}

/** A portal token as the platform's createConsoleToken makes it: `ptk_` and 43 base62 characters from the CSPRNG. */
export function newPortalToken() {
  let token = "ptk_";
  while (token.length < 4 + 43) {
    for (const byte of randomBytes(64)) {
      // 248 = 4 × 62: bytes above it are drawn again, so every character is uniform.
      if (byte < 248 && token.length < 4 + 43) {
        token += BASE62[byte % 62];
      }
    }
  }
  return token;
}

/**
 * Opens a staff session of a new test staff member of the demo OTA through the OTA admin's service key (the file
 * header): the platform rows, the portal token, then console.auth.signIn. `close` signs the session out and deletes the
 * account; it never throws.
 * @param {SmokeSettings} settings
 * @param {import("../../src/index.js").VelexisClient} service A server-mode client with the service key, `sessionKind:
 *   "staff"`, `environment: "test"` and an end user (`endUser`, newSmokeEndUser).
 */
export async function openTestStaffSession(settings, service) {
  const { default: pg } = await import("pg");
  const { Redis } = await import("ioredis");
  const migrator = new pg.Client({
    connectionString: settings.DATABASE_MIGRATOR_URL,
    application_name: "velexis-sdk-smoke",
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // One connection, one command: no reconnection and no queue while it is down, so a Redis that is down fails at once.
  const redis = new Redis(settings.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  const accountId = newPlatformId("acc");
  const staffId = newPlatformId("stf");
  let created = false;
  /** @type {any} */
  let session;

  const close = async () => {
    if (session !== undefined) {
      const accessToken = session.session.accessToken;
      await service.console.auth.signOut({}, { accessToken }).catch(() => undefined);
    }
    if (created) {
      // The membership goes with the account (ON DELETE CASCADE).
      await migrator.query("DELETE FROM platform.accounts WHERE id = $1", [accountId]).catch(() => undefined);
    }
    await migrator.end().catch(() => undefined);
    redis.disconnect();
  };

  try {
    await migrator.connect();
    const tenants = await migrator.query("SELECT id, status FROM platform.tenants WHERE key = $1", [
      DEMO_TENANT_KEY,
    ]);
    const tenant = tenants.rows[0];
    if (tenant === undefined || tenant.status !== "active") {
      throw new SmokeSetupError(
        `The demo OTA is ${tenant === undefined ? "missing" : tenant.status} in the database of DATABASE_MIGRATOR_URL: ` +
          "is it the API's database, and did the OTA backend's dev:seed run there?",
      );
    }
    await migrator.query("BEGIN");
    await migrator.query(
      "INSERT INTO platform.accounts (id, email, full_name, status, email_verified_at, locale, time_zone) " +
        "VALUES ($1, $2, 'SDK Smoke', 'active', now(), 'en', 'UTC')",
      [accountId, smokeEmail("staff")],
    );
    await migrator.query(
      "INSERT INTO platform.tenant_memberships (id, tenant_id, account_id, role, status) " +
        "VALUES ($1, $2, $3, $4, 'active')",
      [staffId, tenant.id, accountId, SMOKE_STAFF_ROLE],
    );
    await migrator.query("COMMIT");
    created = true;

    const portalToken = newPortalToken();
    const grant = JSON.stringify({
      v: 1,
      accountId,
      tenantId: tenant.id,
      membershipId: staffId,
      role: SMOKE_STAFF_ROLE,
      // A test OTA: the platform asks for MFA only before a live OTA's console (PADR-0008).
      mfa: false,
      issuedAt: new Date().toISOString(),
      requestId: randomUUID(),
    });
    await redis.connect();
    const key = `ptk:${createHash("sha256").update(portalToken).digest("hex")}`;
    if ((await redis.set(key, grant, "EX", 60, "NX")) !== "OK") {
      throw new Error("the test portal token could not be stored");
    }
    session = await service.console.auth.signIn({ grantType: "portal_token", portalToken });
    return { session, accountId, staffId, tenantId: tenant.id, close };
  } catch (error) {
    await migrator.query("ROLLBACK").catch(() => undefined);
    await close();
    throw error;
  }
}
