#!/usr/bin/env node
// search-load.mjs: the M2 search load test of the OTA API (OBE-028; the follow-ups of OADR-0001 and OADR-0002). How to
// run it is in README.md next to this file; the figures and the decisions they led to are in ota/docs/performance.md.
//
//   node ota/backend/test/load/search-load.mjs --visitors 10 --searches 200
//
// Plain Node and `fetch`, no dependency of its own: it uses the workspace packages the OTA backend already has
// (@velexis/config, @velexis/db, @velexis/crypto, @velexis/testing, ioredis) and the BUILT backend and stub
// (`pnpm build --filter=@velexis/ota-backend...`). PostgreSQL and Redis must run: TEST_DATABASE_ADMIN_URL and REDIS_URL
// come from the environment or the `.env.local` files, as for `pnpm test:int`.
//
// One run:
//   1. a new database built like the integration tests' template (`velexis_test_tpl_load_<runId>`: platform and
//      reference migrated, the reference fixture, tenant_alpha and tenant_beta, more tenant schemas with --tenants),
//      and the platform rows each tenant has in production: the tenant (active, reached on its storefront sub-domain),
//      the Velexis test Amadeus account (one credential set shared by every tenant), the tenant's own test connection
//      with one office; its storefront settings and default markup rule as provisioning seeds them, plus one markup
//      rule of its own (net + 10 %, or net + 5.00 EUR per booking), so every offer is priced by a real rule;
//   2. a child process with the Amadeus stub (@velexis/testing/amadeus) behind a proxy that holds every answer for
//      --stub-delay-ms (300 ms) and moves every last ticketing day 60 days ahead, as the M2 integration tests do, so no
//      run depends on the fixture's calendar date. The stub answers every search with the 5 offers of its fixture;
//      --offers n makes the proxy answer with n (the stub's repeated, each with its own id), since Amadeus answers up
//      to 250 and the API asks for 250;
//   3. the built API (`ota/backend/dist/main.js`) in a child process on a free port, started as the VM starts it
//      (APP_ENV and NODE_ENV production, `--enable-source-maps`, `--max-old-space-size=640`; --app-env test turns on
//      the development checks such as the search_path leak guard), with random key files, edge secret and service key
//      of its own, Redis database --redis-db, and a preload (written into the run's temporary folder) that measures
//      without changing anything: the INSERT and UPDATE statements of the shopping tables, the waits for a connection
//      of the API's pool, the RSS and the event-loop delay;
//   4. --warmup journeys per visitor at the measured concurrency and at every tenant (not counted, so the API's pool
//      has its connections and the code is compiled; then a pause for the buckets to refill), then --visitors concurrent visitors run
//      --searches journeys in all. A journey is one storefront visitor with an address of their own (X-Forwarded-For in 198.18.0.0/15, the
//      benchmarking range): `flights.search` (SIMPLE, one adult, `resultOptions.limit: 0` as the storefront sends it),
//      `flights.listResults` (the first page of 20) and `flights.price` of the first offer (with the storefront's
//      `include`), through the edge with Caddy's headers and the CSRF cookie, an Idempotency-Key per call as the SDK
//      sends it, and --think-ms between two calls. Visitor i shops at tenant i mod --tenants; each search has its own
//      route and day, so no two share one Amadeus call (single flight). A `429 RATE_LIMITED` is retried after its
//      Retry-After with the same Idempotency-Key, at most --max-retries times (the SDK's default, 2); a journey still
//      refused counts as refused, which is the buckets doing their job, not an error;
//   5. the report: latency per operation (2xx answers), `flights.search` without the stub delay and without the whole
//      Amadeus call (the search row's `duration_ms`), the 429 answers, the Amadeus calls per second the proxy let
//      through, the statement times, rows and table sizes, the API's RSS, pool waits and event-loop delay, and the run
//      (date, commit, CPUs, load average before and after). --json <file> writes the same figures as JSON.
// Everything is removed at the end, also after Ctrl-C or a SIGTERM (to the process group or to this process alone):
// both processes, the database, the Redis database's keys and the temporary folder.
//
// Exit codes: 0 every answer was expected (2xx, or a 429 of the Amadeus buckets) and the p95 of `flights.search`
// without the stub delay is within --p95-budget-ms; 1 an unexpected answer, the budget missed, or the run could not be
// set up; 2 a usage error; 130 interrupted. Nothing it prints or writes carries a key, a password, a token or a
// connection string.
import { execFileSync, fork, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const SCRIPT = fileURLToPath(import.meta.url);
/** ota/backend (this file is ota/backend/test/load/search-load.mjs). */
const BACKEND_DIR = resolve(dirname(SCRIPT), "..", "..");
const REPO_ROOT = resolve(BACKEND_DIR, "..", "..");
const TENANT_MIGRATIONS_DIR = join(BACKEND_DIR, "migrations", "tenant");
const require = createRequire(import.meta.url);

/** What builds every file the run loads. */
const BUILD_COMMAND = "pnpm build --filter=@velexis/ota-backend...";
/** The built files the run needs, relative to the repository root. */
const BUILT_FILES = [
  "ota/backend/dist/main.js",
  "packages/config/dist/index.js",
  "packages/crypto/dist/index.js",
  "packages/db/dist/index.js",
  "packages/testing/dist/index.js",
  "tools/amadeus-stub/dist/index.js",
];

/** The internal role of the child process that runs the stub and its proxy (`--role amadeus`). */
const AMADEUS_ROLE = "amadeus";
/** `<key>.<base>` is a tenant's storefront host (the value of the `.env.example` files). */
const STOREFRONT_BASE_DOMAIN = "ota.example.com";
/** The tenants of a run, in order: --tenants takes the first n (alpha and beta are the template's schemas). */
const TENANT_KEYS = Object.freeze(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]);
/** The routes of the measured searches (airports of the reference fixture); each search has its own route and day. */
const ROUTES = Object.freeze([
  ["MAD", "ORY"],
  ["CDG", "LHR"],
  ["LHR", "JFK"],
  ["JFK", "LAX"],
]);
/** The days ahead a measured search departs: 30 to 329, so a search repeats only after 1 200 journeys. */
const FIRST_DAY = 30;
const DAYS = 300;
/** The route and day of the warm-up searches, which no measured search uses. */
const WARMUP_ROUTE = Object.freeze(["ORY", "MAD"]);
const WARMUP_DAY = 15;
/** The storefront's first results page (ota/frontend/src/pages/search.js) and its `include` of flights.price (offer.js). */
const RESULTS_LIMIT = 20;
const PRICE_INCLUDE = Object.freeze(["bags", "other-services", "detailed-fare-rules"]);
/** The SDK's timeout of flights.search and flights.price (ota/sdk/scripts/operation-overrides.json). */
const REQUEST_TIMEOUT_MS = 60_000;
/** The SDK waits at most this long for a Retry-After; a longer one ends the call. */
const MAX_RETRY_AFTER_SECONDS = 30;
/** How far ahead the proxy moves the offers' last ticketing day, as the M2 integration tests do. */
const LAST_TICKETING_DAYS = 60;
/** The tenant tables whose statements the preload times and whose rows and sizes the report shows. */
const MEASURED_TABLES = Object.freeze([
  "flight_searches",
  "flight_offers",
  "priced_offers",
  "supplier_requests",
  "idempotency_keys",
]);
/** `application_name` of the API's pool (OTA_POOL_MAX of src/tenancy/tenancy.module.ts). */
const API_POOL = "ota-api";
/** The DSNs of the `.env.example` files, which name the development database: the run sets its own. */
const WITHHELD = Object.freeze([
  "DATABASE_URL",
  "DATABASE_MIGRATOR_URL",
  "DATABASE_PROVISIONER_URL",
  "TEST_DATABASE_ADMIN_URL",
  "REDIS_URL",
]);
/**
 * The pause between the warm-up and the measured phase: a tenant's bucket refills its burst of 10 in 2 s at 5 per
 * second (src/amadeus/limits.ts), well before the API's pool closes an idle connection (10 s).
 */
const BUCKET_REFILL_MS = 3_000;
/** How long the API may take to answer GET /health/ready, and to stop after SIGTERM before it gets SIGKILL. */
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
/** How long a child process may take to answer a message. */
const MESSAGE_TIMEOUT_MS = 10_000;
/** How many lines of the API's log a failed start shows. */
const LOG_TAIL_LINES = 40;

const USAGE = `Usage: node ota/backend/test/load/search-load.mjs [options]

  --visitors <n>       concurrent visitors (default 10)
  --searches <n>       journeys in all, each one search, one results page and one price (default 200)
  --tenants <n>        tenants, 2 to 8; visitor i shops at tenant i mod n (default 2)
  --stub-delay-ms <n>  how long the stub holds every answer (default 300)
  --offers <n>         offers in each search answer, 1 to 250; 0 keeps the stub's 5 (default 0)
  --think-ms <n>       pause of a visitor between two calls (default 0)
  --max-retries <n>    retries of a 429 after its Retry-After, as the SDK (default 2)
  --warmup <n>         warm-up journeys per visitor, not counted (default 1)
  --p95-budget-ms <n>  budget of the flights.search p95 without the stub delay (default 500)
  --redis-db <n>       the Redis database of the run, 1 to 15, emptied before and after (default 14)
  --app-env <env>      APP_ENV of the API: production (as on the VM) or test (default production)
  --json <file>        also write the figures as JSON
  -h, --help           this text

Build first with \`${BUILD_COMMAND}\`; PostgreSQL and Redis must run (TEST_DATABASE_ADMIN_URL, REDIS_URL).
`;

// ---- Output ------------------------------------------------------------------------------------------------------

const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);

class UsageError extends Error {}

/** The run was stopped by Ctrl-C (SIGINT) or SIGTERM. */
class Interrupted extends Error {}

/**
 * Aborted by the first SIGINT or SIGTERM: the visitors stop, every request in flight is aborted, the set-up stops after
 * the step it is in, and the run cleans up what it created before it exits with 130.
 */
const interruption = new AbortController();

function throwIfInterrupted() {
  if (interruption.signal.aborted) {
    throw new Interrupted("interrupted");
  }
}

/** `sleep(ms)` that ends early, without an error, when the run is interrupted. */
const pauseFor = (ms) => sleep(ms, undefined, { signal: interruption.signal }).catch(() => undefined);

// ---- Options -----------------------------------------------------------------------------------------------------

/** The integer options: [name, default, min, max]. */
const INTEGER_OPTIONS = Object.freeze([
  ["visitors", 10, 1, 500],
  ["searches", 200, 1, 100_000],
  ["tenants", 2, 2, TENANT_KEYS.length],
  ["stub-delay-ms", 300, 0, 30_000],
  ["offers", 0, 0, 250],
  ["think-ms", 0, 0, 600_000],
  ["max-retries", 2, 0, 10],
  ["warmup", 1, 0, 100],
  ["p95-budget-ms", 500, 1, 600_000],
  ["redis-db", 14, 1, 15],
]);

const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/** The options of `argv`; throws a UsageError for anything it does not understand. */
function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        ...Object.fromEntries(INTEGER_OPTIONS.map(([name]) => [name, { type: "string" }])),
        "app-env": { type: "string" },
        json: { type: "string" },
        role: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  const options = { help: values.help === true, role: values.role, json: values.json };
  for (const [name, fallback, min, max] of INTEGER_OPTIONS) {
    const text = values[name];
    const value = text === undefined ? fallback : Number(text);
    if (
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max ||
      (text !== undefined && !/^\d+$/.test(text))
    ) {
      throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
    }
    options[camel(name)] = value;
  }
  const appEnv = values["app-env"] ?? "production";
  if (appEnv !== "production" && appEnv !== "test") {
    throw new UsageError("--app-env must be production or test");
  }
  options.appEnv = appEnv;
  if (options.role !== undefined && options.role !== AMADEUS_ROLE) {
    throw new UsageError(`unknown --role ${options.role}`);
  }
  if (options.json === "") {
    throw new UsageError("--json needs a file name");
  }
  return Object.freeze(options);
}

// ---- Small helpers -----------------------------------------------------------------------------------------------

/** `date` plus `days` days, as an ISO day (UTC). */
function isoDay(days, from = new Date()) {
  return new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Count, mean and nearest-rank percentiles of `values` (milliseconds or any number). */
function summarize(values) {
  if (values.length === 0) {
    return { count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (percent) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1))];
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    p50: at(50),
    p90: at(90),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1],
  };
}

const round1 = (value) => (value === undefined ? undefined : Math.round(value * 10) / 10);
const mib = (bytes) => (bytes === undefined ? undefined : Math.round((bytes / 1_048_576) * 10) / 10);

/** A summary with every figure rounded to 0.1. */
const rounded = (summary) =>
  Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [key, key === "count" ? value : round1(value)]),
  );

/** A free TCP port of 127.0.0.1 (released before it is used: good enough on a developer's machine). */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** The variables of `files` (relative to the repository root), parsed like `.env` files; a later file wins. */
function exampleEnv(files) {
  const values = {};
  for (const file of files) {
    for (const [name, value] of Object.entries(parseEnv(readFileSync(join(REPO_ROOT, file), "utf8")))) {
      if (value !== undefined) {
        values[name] = value;
      }
    }
  }
  return values;
}

/** The last `lines` lines of a log file, or nothing when it cannot be read. */
function tail(file, lines) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

let messageId = 0;

/**
 * Sends `{type, id}` to a child process and resolves with the `body` of its answer `{id, body}`. A child that has
 * exited (its IPC channel closed) rejects the promise: `send` gets a callback, so the failure never becomes an
 * unhandled `error` event that would end the run before its clean-up.
 */
function ask(child, type) {
  messageId += 1;
  const id = messageId;
  return new Promise((resolveAnswer, reject) => {
    if (!child.connected) {
      reject(new Error(`the ${type} message could not be sent: the child process has exited`));
      return;
    }
    // `finish` runs only after `timer` is set: from a message, the timeout or the send callback, all asynchronous.
    const finish = (error, body) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      if (error === undefined) {
        resolveAnswer(body);
      } else {
        reject(error);
      }
    };
    const onMessage = (message) => {
      if (message !== null && typeof message === "object" && message.id === id) {
        finish(undefined, message.body);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`the ${type} message of a child process was not answered`)),
      MESSAGE_TIMEOUT_MS,
    );
    child.on("message", onMessage);
    child.send({ type, id }, (error) => {
      if (error) {
        finish(new Error(`the ${type} message could not be sent: ${error.message}`));
      }
    });
  });
}

/** SIGTERM, then SIGKILL after STOP_TIMEOUT_MS; resolves once the process has exited. */
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  let timer;
  const timedOut = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(true), STOP_TIMEOUT_MS);
  });
  if ((await Promise.race([exited.then(() => false), timedOut])) === true) {
    child.kill("SIGKILL");
    await exited;
  }
  clearTimeout(timer);
}

// ---- The Amadeus side: the stub behind a delaying proxy (child process, --role amadeus) ---------------------------

/** The operation of a request to the stub, as the report names it. */
function amadeusOperationOf(method, url) {
  const path = url.split("?")[0];
  if (path === "/v1/security/oauth2/token") {
    return "token";
  }
  if (path === "/v2/shopping/flight-offers") {
    return "search";
  }
  if (method === "POST" && path === "/v1/shopping/flight-offers/pricing") {
    return "price";
  }
  return "other";
}

/** `max` (GET) or `searchCriteria.maxFlightOffers` (POST) of a search request, when it has one. */
function maxOffersOf(url, body) {
  const max = new URL(url, "http://stub").searchParams.get("max");
  if (max !== null) {
    return Number(max);
  }
  try {
    const value = JSON.parse(body.toString("utf8"))?.searchCriteria?.maxFlightOffers;
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A search answer of the stub with `offers` offers (the stub's repeated, each with its own id; 0 keeps them) and every
 * last ticketing day set to `lastTicketingDate`. Anything that is not a list of offers is returned as it is.
 */
function reshapeSearchAnswer(payload, { offers, max, lastTicketingDate }) {
  let answer;
  try {
    answer = JSON.parse(payload.toString("utf8"));
  } catch {
    return payload;
  }
  const source = Array.isArray(answer?.data) ? answer.data : [];
  if (source.length === 0) {
    return payload;
  }
  const count = offers === 0 ? source.length : Math.min(offers, max ?? offers);
  const data = Array.from({ length: count }, (_, index) => ({
    ...source[index % source.length],
    id: offers === 0 ? source[index].id : String(index + 1),
    lastTicketingDate,
  }));
  return Buffer.from(JSON.stringify({ ...answer, meta: { ...answer.meta, count: data.length }, data }));
}

/** The response headers of the stub to send on: without the ones that describe the old body or connection. */
function relayedHeaders(headers, length) {
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!["content-length", "transfer-encoding", "connection", "keep-alive"].includes(name)) {
      kept[name] = value;
    }
  }
  return { ...kept, "content-length": String(length) };
}

/** The Amadeus counters of the proxy: calls, statuses and the stub's own time per operation, calls per second. */
function newAmadeusCounters() {
  return { startedAt: Date.now(), operations: new Map(), perSecond: new Map() };
}

function summarizeAmadeus(counters) {
  const seconds = Math.max((Date.now() - counters.startedAt) / 1000, 0.001);
  const operations = {};
  for (const [name, entry] of counters.operations) {
    operations[name] = {
      calls: entry.calls,
      statuses: entry.statuses,
      stubMs: rounded(summarize(entry.stubMs)),
    };
  }
  const windows = [...counters.perSecond.values()];
  const shopping = windows.reduce((total, count) => total + count, 0);
  return {
    seconds: round1(seconds),
    operations,
    shoppingCallsPerSecond: {
      mean: round1(shopping / seconds),
      peak: windows.length === 0 ? 0 : Math.max(...windows),
    },
  };
}

/** Runs the stub and its proxy until the parent disconnects or sends SIGTERM (the `--role amadeus` process). */
async function serveAmadeus(options) {
  const { startAmadeusStub } = require("@velexis/testing/amadeus");
  const stub = await startAmadeusStub();
  const upstream = new URL(stub.url);
  const lastTicketingDate = isoDay(LAST_TICKETING_DAYS);
  let counters = newAmadeusCounters();

  const record = (operation, status, stubMs) => {
    let entry = counters.operations.get(operation);
    if (entry === undefined) {
      entry = { calls: 0, statuses: {}, stubMs: [] };
      counters.operations.set(operation, entry);
    }
    entry.calls += 1;
    entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
    entry.stubMs.push(stubMs);
    if (operation === "search" || operation === "price") {
      const second = Math.floor(Date.now() / 1000);
      counters.perSecond.set(second, (counters.perSecond.get(second) ?? 0) + 1);
    }
  };

  const server = createHttpServer((req, res) => {
    const received = performance.now();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => name !== "connection"),
      );
      const forward = httpRequest(
        { host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers },
        (answer) => {
          const parts = [];
          answer.on("data", (part) => parts.push(part));
          answer.on("end", () => {
            const operation = amadeusOperationOf(req.method ?? "GET", req.url ?? "/");
            const status = answer.statusCode ?? 502;
            const payload =
              operation === "search" && status === 200
                ? reshapeSearchAnswer(Buffer.concat(parts), {
                    offers: options.offers,
                    max: maxOffersOf(req.url ?? "/", body),
                    lastTicketingDate,
                  })
                : Buffer.concat(parts);
            record(operation, status, performance.now() - received);
            setTimeout(() => {
              res.writeHead(status, relayedHeaders(answer.headers, payload.length));
              res.end(payload);
            }, options.stubDelayMs);
          });
        },
      );
      forward.on("error", () => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end("{}");
      });
      forward.end(body);
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  process.on("message", (message) => {
    if (message === null || typeof message !== "object") {
      return;
    }
    if (message.type === "stats") {
      process.send({ id: message.id, body: summarizeAmadeus(counters) });
    } else if (message.type === "reset") {
      counters = newAmadeusCounters();
      process.send({ id: message.id, body: null });
    }
  });
  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    server.close();
    server.closeAllConnections();
    void stub.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("disconnect", stop);
  process.send({ type: "ready", url: `http://127.0.0.1:${server.address().port}` });
}

/** Starts the `--role amadeus` child process; resolves once its proxy listens. */
async function startAmadeus(options, runDir) {
  const logFile = join(runDir, "amadeus.log");
  const log = openSync(logFile, "a");
  const child = fork(
    SCRIPT,
    [
      "--role",
      AMADEUS_ROLE,
      "--stub-delay-ms",
      String(options.stubDelayMs),
      "--offers",
      String(options.offers),
    ],
    { env: {}, execArgv: [], stdio: ["ignore", log, log, "ipc"] },
  );
  closeSync(log);
  const url = await new Promise((resolveUrl, reject) => {
    const onExit = (code) =>
      reject(
        new Error(
          `the Amadeus stub process exited (${code}) before it listened:\n${tail(logFile, LOG_TAIL_LINES)}`,
        ),
      );
    child.once("exit", onExit);
    child.once("message", (message) => {
      child.off("exit", onExit);
      if (message?.type === "ready" && typeof message.url === "string") {
        resolveUrl(message.url);
      } else {
        reject(new Error("the Amadeus stub process sent something unexpected"));
      }
    });
  });
  return {
    url,
    stats: () => ask(child, "stats"),
    reset: () => ask(child, "reset"),
    stop: () => stopProcess(child),
  };
}

// ---- The API process and its measuring preload --------------------------------------------------------------------

/**
 * The preload of the API process (`node --require`). It wraps `pg.Client#query` and `pg.Pool#connect` of the `pg` the
 * API uses (`__PG__`) to time, never to change: the INSERT and UPDATE statements of the measured tables (`__TABLES__`)
 * from sending to answer, with their row counts, and the wait for a connection of the API's pool. It samples the RSS
 * and the event-loop delay, and answers the load test's `stats` and `reset` messages on the IPC channel. Durations,
 * counts and sizes only: never a statement's parameters, a row or a connection string.
 */
const PRELOAD_SOURCE = `"use strict";
// Written by ota/backend/test/load/search-load.mjs into the run's temporary folder and preloaded into the API process
// with node --require. It measures and changes nothing: see PRELOAD_SOURCE in search-load.mjs.
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const pg = require(__PG__);
const TABLES = new Set(__TABLES__);
const API_POOL = __POOL__;
const STATEMENT = /^(insert into|update) "([a-z_]+)"/;
let statements = new Map();
let poolWaits = [];
let maxWaiting = 0;
let peakRss = process.memoryUsage.rss();
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
}, 200).unref();

function record(key, ms, rows) {
  let entry = statements.get(key);
  if (entry === undefined) {
    entry = { ms: [], rows: [] };
    statements.set(key, entry);
  }
  entry.ms.push(ms);
  entry.rows.push(rows);
}

const query = pg.Client.prototype.query;
pg.Client.prototype.query = function measuredQuery(config, values, callback) {
  const match =
    typeof config === "string" && typeof values !== "function" && callback === undefined ? STATEMENT.exec(config) : null;
  if (match === null || !TABLES.has(match[2])) {
    return query.apply(this, arguments);
  }
  const started = performance.now();
  const result = query.apply(this, arguments);
  if (result !== null && typeof result === "object" && typeof result.then === "function") {
    result.then(
      (answer) => record(match[1] + " " + match[2], performance.now() - started, answer && answer.rowCount),
      () => undefined,
    );
  }
  return result;
};

const connect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function measuredConnect(callback) {
  if (callback !== undefined || !this.options || this.options.application_name !== API_POOL) {
    return connect.apply(this, arguments);
  }
  const started = performance.now();
  const result = connect.apply(this, arguments);
  maxWaiting = Math.max(maxWaiting, this.waitingCount);
  result.then(() => poolWaits.push(performance.now() - started), () => undefined);
  return result;
};

function snapshot() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  return {
    statements: Object.fromEntries(statements),
    poolWaitsMs: poolWaits,
    maxWaiting,
    rssBytes: memory.rss,
    peakRssBytes: peakRss,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    heapUsedBytes: memory.heapUsed,
    eventLoopDelayMs: {
      mean: loopDelay.mean / 1e6,
      p50: loopDelay.percentile(50) / 1e6,
      p99: loopDelay.percentile(99) / 1e6,
      max: loopDelay.max / 1e6,
    },
  };
}

if (typeof process.send === "function") {
  process.on("message", (message) => {
    if (message === null || typeof message !== "object") {
      return;
    }
    if (message.type === "reset") {
      statements = new Map();
      poolWaits = [];
      maxWaiting = 0;
      peakRss = process.memoryUsage.rss();
      loopDelay.reset();
      process.send({ id: message.id, body: null });
    } else if (message.type === "stats") {
      process.send({ id: message.id, body: snapshot() });
    }
  });
  process.channel.unref();
}
`;

/** The variables of the API process: its `.env.example` files without the DSNs, and the run's own values. */
function apiEnv(options, run) {
  const production = options.appEnv === "production";
  const values = exampleEnv([".env.example", "ota/backend/.env.example"]);
  for (const name of WITHHELD) {
    delete values[name];
  }
  return {
    ...values,
    APP_ENV: options.appEnv,
    ...(production ? { NODE_ENV: "production" } : {}),
    LOG_LEVEL: "info",
    PORT: String(run.apiPort),
    HEALTH_PORT: String(run.healthPort),
    TRUST_PROXY: "loopback",
    DATABASE_URL: run.otaUrl,
    REDIS_URL: run.redisUrl,
    MASTER_KEY_DIR: run.keys.dir,
    MASTER_KEY_CURRENT: "local:v1",
    API_KEY_PEPPER_FILE: run.keys.pepperFile,
    JWT_PRIVATE_KEY_FILE: run.keys.jwtKeyFile,
    DOCUMENT_URL_KEY_FILE: run.keys.documentUrlKeyFile,
    STORAGE_DIR: join(run.dir, "storage"),
    VELEXIS_EDGE_SECRET: run.keys.edgeSecret,
    OTA_ADMIN_SERVICE_KEY: run.keys.serviceKey,
    AMADEUS_BASE_URL_TEST: run.amadeusUrl,
    AMADEUS_BASE_URL_LIVE: run.amadeusUrl,
    STOREFRONT_BASE_DOMAIN,
    PUBLIC_OTA_API_URL: `http://127.0.0.1:${run.apiPort}`,
    SENTRY_DSN: "",
  };
}

/** Starts the built API with the preload; resolves once GET /health/ready answers 200. */
async function startApi(options, run) {
  const dbRequire = createRequire(require.resolve("@velexis/db/package.json"));
  const preload = join(run.dir, "api-preload.cjs");
  writeFileSync(
    preload,
    PRELOAD_SOURCE.replace("__PG__", JSON.stringify(dbRequire.resolve("pg")))
      .replace("__TABLES__", JSON.stringify(MEASURED_TABLES))
      .replace("__POOL__", JSON.stringify(API_POOL)),
    { mode: 0o600 },
  );
  mkdirSync(join(run.dir, "storage"), { mode: 0o700 });
  const logFile = join(run.dir, "api.log");
  const log = openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [
      "--enable-source-maps",
      "--max-old-space-size=640",
      "--require",
      preload,
      join(BACKEND_DIR, "dist", "main.js"),
    ],
    { cwd: BACKEND_DIR, env: apiEnv(options, run), stdio: ["ignore", log, log, "ipc"] },
  );
  closeSync(log);
  const api = {
    url: `http://127.0.0.1:${run.apiPort}`,
    logFile,
    stats: () => ask(child, "stats"),
    reset: () => ask(child, "reset"),
    stop: () => stopProcess(child),
  };
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (interruption.signal.aborted) {
      await api.stop();
      throw new Interrupted("interrupted");
    }
    if (child.exitCode !== null) {
      throw new Error(
        `the API exited (${child.exitCode}) before it was ready:\n${tail(logFile, LOG_TAIL_LINES)}`,
      );
    }
    try {
      const response = await fetch(`${api.url}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer();
      if (response.status === 200) {
        return api;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  await api.stop();
  throw new Error(
    `the API was not ready within ${READY_TIMEOUT_MS / 1000} s:\n${tail(logFile, LOG_TAIL_LINES)}`,
  );
}

// ---- Set-up: database, tenants, key files ------------------------------------------------------------------------

/** Random key files as `pnpm dev:keys` writes them (mode 0600), and the run's edge secret and service key. */
function writeKeyFiles(runDir) {
  const dir = join(runDir, "keys");
  mkdirSync(dir, { mode: 0o700 });
  const keyFile = (name, contents) => {
    const file = join(dir, name);
    writeFileSync(file, contents, { mode: 0o600 });
    return file;
  };
  const base64Key = () => `${randomBytes(32).toString("base64")}\n`;
  keyFile("master-v1.key", base64Key());
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    dir,
    pepperFile: keyFile("api-key-pepper", base64Key()),
    jwtKeyFile: keyFile("ota-jwt-ed25519.pem", privateKey),
    documentUrlKeyFile: keyFile("document-url.key", base64Key()),
    edgeSecret: randomBytes(32).toString("hex"),
    serviceKey: `sk_svc_${randomBytes(24).toString("hex")}`,
  };
}

/** The markup rule of the tenant at `index`: net + 10 %, or net + 5.00 EUR per booking, in turn. */
function markupRule(index, newId) {
  const rule = {
    id: newId("mkr"),
    scope: JSON.stringify({}),
    priority: 10,
    stackable: false,
    is_default: false,
    is_active: true,
  };
  return index % 2 === 0
    ? { ...rule, name: "Ten percent", calculation: "percentage", percentage: "10" }
    : {
        ...rule,
        name: "Five euros",
        calculation: "fixed",
        fixed_amount: "5.00",
        fixed_currency: "EUR",
        applies_per: "booking",
      };
}

/**
 * The tenants of the run, written as the platform and provisioning write them (see the file header, step 1): the
 * platform rows as velexis_migrator, the tenant rows through tenantTx as velexis_ota_app.
 */
async function seedTenants(packages, run, count) {
  const { createPlatformDb, createPool, createTenantDb, tenantTx } = packages.db;
  const { encryptValue, LocalFileKeyProvider, newId } = packages.crypto;
  const quiet = { error: () => undefined };
  const migratorPool = createPool(run.migratorUrl, {
    applicationName: "ota-load-seed",
    logger: quiet,
    max: 2,
  });
  const otaPool = createPool(run.otaUrl, { applicationName: "ota-load-seed", logger: quiet, max: 2 });
  try {
    const platform = createPlatformDb(migratorPool);
    const tenantDb = createTenantDb(otaPool, { appEnv: "test" });
    const keys = await LocalFileKeyProvider.fromDir(run.keys.dir, "local:v1");
    for (const key of TENANT_KEYS.slice(2, count)) {
      await packages.migrate.migrateTenantSchema({
        schema: `tenant_${key}`,
        dir: TENANT_MIGRATIONS_DIR,
        url: run.migratorUrl,
        create: true,
      });
    }
    const accountId = newId("ama");
    // A client id and secret of this run only: the stub accepts any non-empty pair.
    const { ciphertext, kekId } = await encryptValue(randomBytes(24).toString("base64url"), {
      aad: `platform.amadeus_accounts.client_secret_ciphertext:${accountId}`,
      keys,
    });
    await platform
      .insertInto("platform.amadeus_accounts")
      .values({
        id: accountId,
        name: "Velexis test (load test)",
        environment: "test",
        base_url: "https://test.travel.api.amadeus.com",
        client_id: `velexis-load-${randomBytes(4).toString("hex")}`,
        client_secret_ciphertext: ciphertext,
        encryption_key_id: kekId,
        status: "active",
      })
      .execute();
    const tenants = [];
    for (const [index, key] of TENANT_KEYS.slice(0, count).entries()) {
      const tenant = Object.freeze({
        key,
        id: newId("ten"),
        schema: `tenant_${key}`,
        host: `${key}.${STOREFRONT_BASE_DOMAIN}`,
        office: `NCE1A${String(index + 1).padStart(4, "0")}`,
      });
      await platform
        .insertInto("platform.tenants")
        .values({ id: tenant.id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
        .execute();
      await platform
        .insertInto("platform.supplier_connections")
        .values({
          id: newId("sc"),
          tenant_id: tenant.id,
          environment: "test",
          credential_source: "velexis",
          amadeus_account_id: accountId,
          office_ids: [tenant.office],
          default_office_id: tenant.office,
          queuing_office_id: tenant.office,
          owner_office_id: tenant.office,
          status: "active",
        })
        .execute();
      await tenantTx(tenantDb, tenant.schema, async (trx) => {
        await packages.seeds.seedStorefrontSettings(trx, {
          name: `${key} Travel`,
          defaultCurrency: "EUR",
          defaultLocale: "en",
        });
        await packages.seeds.seedDefaultMarkupRule(trx);
        await trx.insertInto("markup_rules").values(markupRule(index, newId)).execute();
      });
      tenants.push(tenant);
    }
    return tenants;
  } finally {
    await Promise.all([migratorPool.end(), otaPool.end()]);
  }
}

/** Rows and sizes of the measured tables (all tenants together), and each search's status and Amadeus time. */
async function databaseFigures(packages, run, tenants) {
  const { createPool, createTenantDb, sql, tenantTx } = packages.db;
  const pool = createPool(run.otaUrl, {
    applicationName: "ota-load-report",
    logger: { error: () => undefined },
    max: 1,
  });
  try {
    const tenantDb = createTenantDb(pool, { appEnv: "test" });
    const tables = Object.fromEntries(
      MEASURED_TABLES.map((table) => [table, { rows: 0, tableBytes: 0, indexBytes: 0, totalBytes: 0 }]),
    );
    const searches = new Map();
    for (const tenant of tenants) {
      await tenantTx(tenantDb, tenant.schema, async (trx) => {
        for (const table of MEASURED_TABLES) {
          const { rows } = await sql`
            SELECT (SELECT count(*) FROM ${sql.table(table)})::float8 AS rows,
                   pg_table_size(to_regclass(${table}))::float8 AS table_bytes,
                   pg_indexes_size(to_regclass(${table}))::float8 AS index_bytes,
                   pg_total_relation_size(to_regclass(${table}))::float8 AS total_bytes
          `.execute(trx);
          const [row] = rows;
          tables[table].rows += Number(row.rows);
          tables[table].tableBytes += Number(row.table_bytes);
          tables[table].indexBytes += Number(row.index_bytes);
          tables[table].totalBytes += Number(row.total_bytes);
        }
        const { rows } = await sql`SELECT id, status, result_count, duration_ms FROM flight_searches`.execute(
          trx,
        );
        for (const row of rows) {
          searches.set(row.id, {
            status: row.status,
            resultCount: row.result_count,
            durationMs: row.duration_ms,
          });
        }
      });
    }
    return { tables, searches };
  } finally {
    await pool.end();
  }
}

// ---- The visitors ------------------------------------------------------------------------------------------------

/** The address of journey `index`: 198.18.0.0/15 (RFC 2544), the warm-up journeys at its end. */
function visitorAddress(index, warmup) {
  const n = warmup ? 131_071 - index : index;
  return `198.${18 + ((n >> 16) & 1)}.${(n >> 8) & 255}.${n & 255}`;
}

/** The SIMPLE search of journey `index`: its own route and day (see ROUTES); the warm-up has its own. */
function searchCriteria(index, warmup) {
  const [origin, destination] = warmup ? WARMUP_ROUTE : ROUTES[Math.floor(index / DAYS) % ROUTES.length];
  return {
    mode: "simple",
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate: isoDay((warmup ? WARMUP_DAY : FIRST_DAY) + (index % DAYS)),
    adults: 1,
    resultOptions: { limit: 0 },
  };
}

/**
 * One call of a visitor, with the SDK's retries of a 429 after its Retry-After; every attempt is recorded. An
 * interrupted run aborts the request in flight and answers status 0, code INTERRUPTED, without recording it.
 */
async function call(context, record, { operation, method, path, body, headers }) {
  const interrupted = { status: 0, payload: undefined, code: "INTERRUPTED" };
  for (let attempt = 0; ; attempt += 1) {
    if (interruption.signal.aborted) {
      return interrupted;
    }
    context.inFlight += 1;
    context.maxInFlight = Math.max(context.maxInFlight, context.inFlight);
    const started = performance.now();
    let status = 0;
    let payload;
    let code;
    let retryAfter = 1;
    try {
      const response = await fetch(`${context.apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), interruption.signal]),
      });
      status = response.status;
      const text = await response.text();
      try {
        payload = text === "" ? undefined : JSON.parse(text);
      } catch {
        payload = undefined;
      }
      code = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
      const header = response.headers.get("retry-after");
      retryAfter = header !== null && /^\d+$/.test(header) ? Number(header) : 1;
    } catch (error) {
      code = error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR";
    } finally {
      context.inFlight -= 1;
    }
    if (interruption.signal.aborted) {
      return interrupted;
    }
    const ms = performance.now() - started;
    context.busyMs += ms;
    record({ operation, status, code, ms, attempt, at: started - context.startedAt, searchId: payload?.id });
    if (
      status === 429 &&
      code === "RATE_LIMITED" &&
      attempt < context.maxRetries &&
      retryAfter <= MAX_RETRY_AFTER_SECONDS
    ) {
      await pauseFor(retryAfter * 1000);
      continue;
    }
    return { status, payload, code };
  }
}

/** The outcome of a journey that stopped at `answer` of `operation`. */
function stopped(operation, answer) {
  if (answer.status === 429 && answer.code === "RATE_LIMITED") {
    return { outcome: "refused", detail: `${operation} 429 RATE_LIMITED` };
  }
  return { outcome: "failed", detail: `${operation} ${answer.status} ${answer.code ?? ""}`.trim() };
}

/** One visitor's journey at `tenant`: search, the first results page, the price of the first offer. */
async function journey(context, tenant, index, warmup, record) {
  const csrf = randomBytes(32).toString("base64url");
  const read = {
    Accept: "application/json",
    "Accept-Language": "en",
    "X-Velexis-Edge": context.edgeSecret,
    "X-Velexis-Host": tenant.host,
    "X-Forwarded-For": visitorAddress(index, warmup),
  };
  const write = () => ({
    ...read,
    "Content-Type": "application/json",
    Origin: `https://${tenant.host}`,
    "X-CSRF-Token": csrf,
    Cookie: `__Host-vx_csrf=${csrf}`,
    "Idempotency-Key": randomUUID(),
  });
  const pause = () => (context.thinkMs > 0 ? pauseFor(context.thinkMs) : undefined);
  const search = await call(context, record, {
    operation: "flights.search",
    method: "POST",
    path: "/v1/flight-searches",
    body: searchCriteria(index, warmup),
    headers: write(),
  });
  if (search.status !== 201 || typeof search.payload?.id !== "string") {
    return stopped("flights.search", search);
  }
  await pause();
  const results = await call(context, record, {
    operation: "flights.listResults",
    method: "GET",
    path: `/v1/flight-searches/${encodeURIComponent(search.payload.id)}/offers?limit=${RESULTS_LIMIT}`,
    headers: read,
  });
  const offerId = Array.isArray(results.payload?.data) ? results.payload.data[0]?.id : undefined;
  if (results.status !== 200 || typeof offerId !== "string") {
    return stopped("flights.listResults", results);
  }
  await pause();
  const price = await call(context, record, {
    operation: "flights.price",
    method: "POST",
    path: "/v1/priced-offers",
    body: { offerIds: [offerId], include: [...PRICE_INCLUDE] },
    headers: write(),
  });
  if (price.status !== 201) {
    return stopped("flights.price", price);
  }
  return { outcome: "completed" };
}

// ---- The run -----------------------------------------------------------------------------------------------------

/** The workspace packages and built modules the run uses (after `checkBuilt`). */
function loadPackages() {
  return {
    config: require("@velexis/config"),
    crypto: require("@velexis/crypto"),
    db: require("@velexis/db"),
    migrate: require("@velexis/db/migrate"),
    testing: require("@velexis/testing"),
    Redis: require("ioredis").default,
    seeds: {
      ...require(join(BACKEND_DIR, "dist", "provisioning", "seeds", "storefront-settings.seed.js")),
      ...require(join(BACKEND_DIR, "dist", "provisioning", "seeds", "markup-rules.seed.js")),
    },
  };
}

function checkBuilt() {
  const missing = BUILT_FILES.filter((file) => !existsSync(join(REPO_ROOT, file)));
  if (missing.length > 0) {
    throw new Error(`not built: ${missing.join(", ")}. Run \`${BUILD_COMMAND}\` first.`);
  }
}

/** The commit of the checkout, with `+changes` when tracked files differ from it. */
function commitOf() {
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const commit = git(["rev-parse", "--short=12", "HEAD"]);
    return git(["status", "--porcelain", "--untracked-files=no"]) === "" ? commit : `${commit}+changes`;
  } catch {
    return "unknown";
  }
}

const loadAverage = () => os.loadavg().map((value) => Math.round(value * 100) / 100);

/**
 * Runs `visitors` concurrent visitors over the journeys `[0, journeys)` and returns what they saw. Visitor i shops at
 * tenant i mod the number of tenants and takes the next journey when it has finished one.
 */
async function runVisitors(context, tenants, { visitors, journeys, warmup }) {
  const records = [];
  const outcomes = [];
  let next = 0;
  const visitor = async (visitorIndex) => {
    const tenant = tenants[visitorIndex % tenants.length];
    for (let index = next; index < journeys && !interruption.signal.aborted; index = next) {
      next += 1;
      const result = await journey(context, tenant, index, warmup, (r) =>
        records.push({ ...r, tenant: tenant.key }),
      );
      outcomes.push({ ...result, tenant: tenant.key });
      if (context.thinkMs > 0) {
        await pauseFor(context.thinkMs);
      }
    }
  };
  await Promise.all(Array.from({ length: visitors }, (_, visitorIndex) => visitor(visitorIndex)));
  return { records, outcomes };
}

/** The figures of a run, from what the visitors, the proxy, the API and the database saw. */
function figuresOf({ options, tenants, phaseMs, context, visits, amadeus, apiStart, apiEnd, database }) {
  const { records, outcomes } = visits;
  const ok = (operation) =>
    records.filter((r) => r.operation === operation && r.status >= 200 && r.status < 300).map((r) => r.ms);
  const searches = records.filter((r) => r.operation === "flights.search" && r.status === 201);
  const amadeusTimes = searches
    .map((r) => database.searches.get(r.searchId)?.durationMs)
    .map((durationMs, index) =>
      typeof durationMs === "number" ? searches[index].ms - durationMs : undefined,
    )
    .filter((value) => value !== undefined);
  const latency = {
    "flights.search": rounded(summarize(ok("flights.search"))),
    "flights.search without the stub delay": rounded(
      summarize(ok("flights.search").map((ms) => ms - options.stubDelayMs)),
    ),
    "flights.search without the Amadeus call": rounded(summarize(amadeusTimes)),
    "flights.listResults": rounded(summarize(ok("flights.listResults"))),
    "flights.price": rounded(summarize(ok("flights.price"))),
    "flights.price without the stub delay": rounded(
      summarize(ok("flights.price").map((ms) => ms - options.stubDelayMs)),
    ),
  };
  const answers = {};
  for (const r of records) {
    const entry = (answers[r.operation] ??= { attempts: 0, statuses: {}, rateLimited: 0 });
    entry.attempts += 1;
    const status = r.status === 0 ? r.code : String(r.status);
    entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
    if (r.status === 429 && r.code === "RATE_LIMITED") {
      entry.rateLimited += 1;
    }
  }
  const count = (outcome) => outcomes.filter((o) => o.outcome === outcome).length;
  const unexpected = [
    ...new Set(outcomes.filter((o) => o.outcome === "failed").map((o) => o.detail)),
    ...new Set(
      records
        .filter(
          (r) => !(r.status >= 200 && r.status < 300) && !(r.status === 429 && r.code === "RATE_LIMITED"),
        )
        .map((r) =>
          `${r.operation} ${r.status === 0 ? r.code : r.status} ${r.status === 0 ? "" : (r.code ?? "")}`.trim(),
        ),
    ),
  ];
  const statements = {};
  for (const [key, entry] of Object.entries(apiEnd.statements)) {
    const rows = entry.rows.filter((value) => typeof value === "number");
    statements[key] = {
      ...rounded(summarize(entry.ms)),
      meanRows: round1(rows.reduce((total, value) => total + value, 0) / Math.max(rows.length, 1)),
    };
  }
  const storedSearches = [...database.searches.values()];
  const completedSearches = storedSearches.filter((s) => s.status === "completed").length;
  const tables = Object.fromEntries(
    Object.entries(database.tables).map(([table, t]) => [
      table,
      {
        rows: t.rows,
        tableMiB: mib(t.tableBytes),
        indexMiB: mib(t.indexBytes),
        totalMiB: mib(t.totalBytes),
        totalKiBPerCompletedSearch:
          completedSearches === 0 ? undefined : round1(t.totalBytes / 1024 / completedSearches),
      },
    ]),
  );
  const p95 = latency["flights.search without the stub delay"].p95;
  return {
    load: {
      visitors: options.visitors,
      journeys: options.searches,
      tenants: tenants.map((t) => t.key),
      stubDelayMs: options.stubDelayMs,
      offersPerSearch: options.offers === 0 ? "stub (5)" : options.offers,
      thinkMs: options.thinkMs,
      maxRetries: options.maxRetries,
      appEnv: options.appEnv,
    },
    phase: {
      seconds: round1(phaseMs / 1000),
      journeys: { completed: count("completed"), refused: count("refused"), failed: count("failed") },
      journeysPerSecond: round1(count("completed") / (phaseMs / 1000)),
      inFlightRequests: { mean: round1(context.busyMs / phaseMs), max: context.maxInFlight },
    },
    latencyMs: latency,
    answers,
    amadeus,
    statementsMs: statements,
    api: {
      rssAfterStartMiB: mib(apiStart.rssBytes),
      rssPeakMiB: mib(Math.max(apiEnd.peakRssBytes, apiEnd.maxRssBytes)),
      rssEndMiB: mib(apiEnd.rssBytes),
      heapUsedEndMiB: mib(apiEnd.heapUsedBytes),
      poolWaitMs: rounded(summarize(apiEnd.poolWaitsMs)),
      poolMaxWaiting: apiEnd.maxWaiting,
      eventLoopDelayMs: rounded(apiEnd.eventLoopDelayMs),
    },
    database: { searches: { stored: storedSearches.length, completed: completedSearches }, tables },
    budget: {
      p95Ms: p95,
      budgetMs: options.p95BudgetMs,
      within: p95 !== undefined && p95 <= options.p95BudgetMs,
    },
    unexpected,
  };
}

// ---- The report --------------------------------------------------------------------------------------------------

const pad = (value, width) => String(value ?? "-").padStart(width);
const SUMMARY_HEADER = `${pad("count", 7)}${pad("mean", 9)}${pad("p50", 9)}${pad("p90", 9)}${pad("p95", 9)}${pad("p99", 9)}${pad("max", 9)}`;
const summaryLine = (label, s, width) =>
  `  ${label.padEnd(width)}${pad(s.count, 7)}${pad(s.mean, 9)}${pad(s.p50, 9)}${pad(s.p90, 9)}${pad(s.p95, 9)}${pad(s.p99, 9)}${pad(s.max, 9)}\n`;

function report(run, figures) {
  const lines = [];
  const add = (text) => lines.push(text);
  const { load, phase } = figures;
  add("\nOTA search load test (OBE-028)\n");
  add(
    `  run       ${run.date}, commit ${run.commit}, Node ${run.node}, PostgreSQL ${run.postgres}, Redis ${run.redis}\n`,
  );
  add(
    `  machine   ${run.machine.cpus} CPUs (${run.machine.cpuModel}), ${run.machine.memoryGiB} GiB, ${run.machine.os}\n`,
  );
  add(
    `  load avg  ${run.loadAverage.start.join(" ")} at the start, ${run.loadAverage.end.join(" ")} at the end\n`,
  );
  add(
    `  load      ${load.visitors} visitors, ${load.journeys} journeys on ${load.tenants.length} tenants, stub delay ` +
      `${load.stubDelayMs} ms, ${load.offersPerSearch} offers per search, think time ${load.thinkMs} ms, ` +
      `APP_ENV ${load.appEnv}\n`,
  );
  add(
    `  phase     ${phase.seconds} s: ${phase.journeys.completed} journeys completed, ${phase.journeys.refused} ` +
      `refused (429 after ${load.maxRetries} retries), ${phase.journeys.failed} failed; ${phase.journeysPerSecond} ` +
      `journeys/s; requests in flight: mean ${phase.inFlightRequests.mean}, max ${phase.inFlightRequests.max}\n`,
  );
  const width = 42;
  add(`\nLatency of the 2xx answers (ms)${" ".repeat(width - 29)}${SUMMARY_HEADER}\n`);
  for (const [label, summary] of Object.entries(figures.latencyMs)) {
    add(summaryLine(label, summary, width));
  }
  add("\nAnswers per operation (every attempt)\n");
  for (const [operation, entry] of Object.entries(figures.answers)) {
    const statuses = Object.entries(entry.statuses)
      .map(([status, n]) => `${status}: ${n}`)
      .join(", ");
    const share = Math.round((entry.rateLimited / entry.attempts) * 1000) / 10;
    add(
      `  ${operation.padEnd(22)} ${pad(entry.attempts, 6)} attempts (${statuses}); 429 RATE_LIMITED ${share} %\n`,
    );
  }
  add(`\nAmadeus calls let through by the buckets (proxy, ${figures.amadeus.seconds} s)\n`);
  for (const [operation, entry] of Object.entries(figures.amadeus.operations)) {
    add(
      `  ${operation.padEnd(8)} ${pad(entry.calls, 6)} calls, stub time before the delay p95 ${entry.stubMs.p95} ms\n`,
    );
  }
  const rate = figures.amadeus.shoppingCallsPerSecond;
  add(`  search and price: ${rate.mean} calls/s on average, ${rate.peak} in the busiest second\n`);
  add(`\nStatements of the API (pg client, ms)${" ".repeat(width - 35)}${SUMMARY_HEADER}  rows\n`);
  for (const [key, summary] of Object.entries(figures.statementsMs).sort(([a], [b]) => a.localeCompare(b))) {
    add(`${summaryLine(key, summary, width).trimEnd()}${pad(summary.meanRows, 6)}\n`);
  }
  const api = figures.api;
  add(
    `\nAPI process: RSS ${api.rssAfterStartMiB} MiB after start, ${api.rssPeakMiB} MiB peak, ${api.rssEndMiB} MiB at ` +
      `the end (heap used ${api.heapUsedEndMiB} MiB); pool wait p95 ${api.poolWaitMs.p95 ?? "-"} ms, max ` +
      `${api.poolWaitMs.max ?? "-"} ms, at most ${api.poolMaxWaiting} waiting; event-loop delay p50 ` +
      `${api.eventLoopDelayMs.p50} ms, p99 ${api.eventLoopDelayMs.p99} ms, max ${api.eventLoopDelayMs.max} ms\n`,
  );
  const { stored, completed } = figures.database.searches;
  add(`\nTables after the run (all tenants; ${stored} searches stored, ${completed} completed)\n`);
  add(
    `  ${"table".padEnd(20)}${pad("rows", 9)}${pad("table MiB", 11)}${pad("index MiB", 11)}${pad("total MiB", 11)}${pad("KiB/search", 12)}\n`,
  );
  for (const [table, t] of Object.entries(figures.database.tables)) {
    add(
      `  ${table.padEnd(20)}${pad(t.rows, 9)}${pad(t.tableMiB, 11)}${pad(t.indexMiB, 11)}${pad(t.totalMiB, 11)}` +
        `${pad(t.totalKiBPerCompletedSearch, 12)}\n`,
    );
  }
  const { budget } = figures;
  add(
    `\nflights.search p95 without the stub delay: ${budget.p95Ms ?? "-"} ms, budget ${budget.budgetMs} ms: ` +
      `${budget.within ? "within the budget" : "OVER THE BUDGET"}\n`,
  );
  if (figures.unexpected.length > 0) {
    add(`Unexpected answers: ${figures.unexpected.join("; ")}\n`);
  }
  return lines.join("");
}

// ---- Main --------------------------------------------------------------------------------------------------------

async function run(options) {
  checkBuilt();
  const packages = loadPackages();
  const { defineConfig, env, loadDevEnvFiles } = packages.config;
  loadDevEnvFiles({ appDir: BACKEND_DIR });
  const settings = defineConfig({
    TEST_DATABASE_ADMIN_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
    REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
  });
  const { databaseUrl, redisUrlWithDatabase, TEST_ROLES } = packages.testing;
  const cpus = os.cpus();
  const runInfo = {
    date: new Date().toISOString(),
    commit: commitOf(),
    node: process.version,
    machine: {
      cpus: cpus.length,
      cpuModel: (cpus[0]?.model ?? "unknown").trim(),
      memoryGiB: Math.round((os.totalmem() / 1_073_741_824) * 10) / 10,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
    },
    loadAverage: { start: loadAverage(), end: [] },
  };
  out(
    `search-load: ${options.visitors} visitors, ${options.searches} journeys on ${options.tenants} tenants ` +
      `(load average ${runInfo.loadAverage.start.join(" ")}, ${runInfo.machine.cpus} CPUs); setting up…\n`,
  );

  const runDir = mkdtempSync(join(os.tmpdir(), "velexis-search-load-"));
  const cleanups = [];
  let cleaning;
  const cleanup = () => {
    cleaning ??= (async () => {
      for (const step of cleanups.reverse()) {
        await step().catch((error) => err(`search-load: clean-up step failed: ${error.message}\n`));
      }
      rmSync(runDir, { recursive: true, force: true });
    })();
    return cleaning;
  };
  // The first signal (Ctrl-C reaches the whole process group; `kill` or `timeout` reach this process alone) stops the
  // run after the step it is in, and the `finally` below cleans up. A second one cleans up at once, even while a
  // set-up step still runs, and exits.
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals === 1) {
      err("search-load: interrupted, stopping and cleaning up…\n");
      interruption.abort();
      return;
    }
    void cleanup().finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const keys = writeKeyFiles(runDir);
    const runId = `load_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const database = await packages.testing.createTemplateDatabase({
      runId,
      adminUrl: settings.TEST_DATABASE_ADMIN_URL,
    });
    cleanups.push(() => database.drop());
    throwIfInterrupted();
    const redisUrl = redisUrlWithDatabase(settings.REDIS_URL, options.redisDb);
    const redis = new packages.Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.flushdb();
    cleanups.push(async () => {
      await redis.flushdb();
      await redis.quit();
    });
    throwIfInterrupted();
    const redisVersion = /redis_version:([^\r\n]+)/.exec(await redis.info("server"))?.[1] ?? "unknown";
    const run = {
      dir: runDir,
      keys,
      redisUrl,
      migratorUrl: databaseUrl(settings.TEST_DATABASE_ADMIN_URL, database.name, TEST_ROLES.migrator),
      otaUrl: databaseUrl(settings.TEST_DATABASE_ADMIN_URL, database.name, TEST_ROLES.ota),
      apiPort: await freePort(),
      healthPort: await freePort(),
      amadeusUrl: "",
    };
    const tenants = await seedTenants(packages, run, options.tenants);
    throwIfInterrupted();
    const amadeus = await startAmadeus(options, runDir);
    cleanups.push(() => amadeus.stop());
    throwIfInterrupted();
    run.amadeusUrl = amadeus.url;
    const api = await startApi(options, run);
    cleanups.push(() => api.stop());
    throwIfInterrupted();
    const apiStart = await api.stats();
    const context = {
      apiUrl: api.url,
      edgeSecret: keys.edgeSecret,
      maxRetries: options.maxRetries,
      thinkMs: options.thinkMs,
      inFlight: 0,
      maxInFlight: 0,
      busyMs: 0,
      startedAt: performance.now(),
    };

    if (options.warmup > 0) {
      // At the measured concurrency (and at every tenant), so the API's pool has its connections and the code paths
      // are compiled when the measured phase starts; then the buckets refill.
      const visitors = Math.max(options.visitors, tenants.length);
      const warmup = await runVisitors(context, tenants, {
        visitors,
        journeys: options.warmup * visitors,
        warmup: true,
      });
      throwIfInterrupted();
      const failures = warmup.outcomes.filter((o) => o.outcome === "failed");
      const idle = tenants.filter(
        (t) => !warmup.outcomes.some((o) => o.tenant === t.key && o.outcome === "completed"),
      );
      if (failures.length > 0 || idle.length > 0) {
        const details = [
          ...failures.map((o) => `${o.tenant}: ${o.detail}`),
          ...idle.map((t) => `${t.key}: none completed`),
        ];
        throw new Error(`the warm-up failed: ${details.join("; ")}\n${tail(api.logFile, LOG_TAIL_LINES)}`);
      }
      await pauseFor(BUCKET_REFILL_MS);
      throwIfInterrupted();
    }
    out(`search-load: warm-up done; ${options.searches} journeys…\n`);
    await Promise.all([amadeus.reset(), api.reset()]);
    Object.assign(context, { inFlight: 0, maxInFlight: 0, busyMs: 0, startedAt: performance.now() });
    const phaseStarted = performance.now();
    const visits = await runVisitors(context, tenants, {
      visitors: options.visitors,
      journeys: options.searches,
      warmup: false,
    });
    throwIfInterrupted();
    const phaseMs = performance.now() - phaseStarted;
    const [amadeusFigures, apiEnd] = await Promise.all([amadeus.stats(), api.stats()]);
    runInfo.loadAverage.end = loadAverage();
    const versionPool = packages.db.createPool(run.otaUrl, {
      applicationName: "ota-load-report",
      logger: { error: () => undefined },
      max: 1,
    });
    runInfo.postgres = (await versionPool.query("SHOW server_version")).rows[0]?.server_version ?? "unknown";
    await versionPool.end();
    runInfo.redis = redisVersion;
    const figures = figuresOf({
      options,
      tenants,
      phaseMs,
      context,
      visits,
      amadeus: amadeusFigures,
      apiStart,
      apiEnd,
      database: await databaseFigures(packages, run, tenants),
    });
    out(report(runInfo, figures));
    if (options.json !== undefined) {
      const file = resolve(options.json);
      // Every attempt of the measured phase too (operation, tenant, status, code, start and duration), for plots.
      const records = visits.records.map(({ operation, tenant, status, code, attempt, at, ms }) => ({
        operation,
        tenant,
        status,
        code,
        attempt,
        at: round1(at),
        ms: round1(ms),
      }));
      writeFileSync(file, `${JSON.stringify({ run: runInfo, ...figures, records }, null, 2)}\n`);
      out(`search-load: figures written to ${file}\n`);
    }
    return figures.unexpected.length === 0 && figures.budget.within ? 0 : 1;
  } catch (error) {
    // After a signal, an error of the step that was running is the interruption's doing: the run just stops.
    if (interruption.signal.aborted) {
      return 130;
    }
    err(`search-load: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await cleanup();
    if (interruption.signal.aborted) {
      err("search-load: cleaned up\n");
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      err(`search-load: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  if (options.role === AMADEUS_ROLE) {
    await serveAmadeus(options);
    return undefined;
  }
  return await run(options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT) {
  const code = await main();
  if (code !== undefined) {
    process.exitCode = code;
    // Idle keep-alive sockets close on their own; never let one hold the result back for long.
    setTimeout(() => process.exit(code), 5_000).unref();
  }
}
