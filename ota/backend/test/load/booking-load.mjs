#!/usr/bin/env node
// booking-load.mjs: the M6 mixed-traffic load test of the OTA API and its worker against the VM's memory budget
// (OBE-088; docs/mvp/architecture.md §3, the follow-up of OADR-0014). How to run it is in README.md next to this file;
// the figures and the decisions they led to are in ota/docs/performance.md §6.
//
//   node ota/backend/test/load/booking-load.mjs --tenants 5 --minutes 30
//
// Plain Node and `fetch`, no dependency of its own: it imports the helpers of search-load.mjs (the stub and its proxy,
// the measuring preload, the process start, the set-up) and uses the workspace packages the OTA backend already has and
// the BUILT backend, worker and stub (`pnpm build --filter=@velexis/ota-backend...`). PostgreSQL and Redis must run:
// TEST_DATABASE_ADMIN_URL and REDIS_URL come from the environment or the `.env.local` files, as for `pnpm test:int`.
// Its Redis figures are the whole Redis server's: run it on a Redis of its own (README.md).
//
// One run:
//   1. a new database built like the integration tests' template, and the platform rows each tenant has in production
//      (search-load.mjs step 1), plus: the shared Velexis test Amadeus account's `base_url` is the run's proxy (the
//      worker calls it); each tenant has the Velexis Stripe test connection, two staff members (`agent`, MFA on) and,
//      in its storefront settings, the airline card on for the test environment, an alert address and a booking queue
//      (50, category 0), so a lost Flight Create Orders answer can be reconciled;
//   2. the Amadeus stub behind the delaying proxy of search-load.mjs (--stub-delay-ms; search answers of --offers
//      offers, never more than the search asked for). The proxy picks the stub scenario of each Flight Create Orders
//      from the traveller's last name the booking journey chose: `ticketing-failed` (the order without tickets, so the
//      worker's ticketing job issues it from 5 minutes later) for every --deferred-ticketing-every-th booking,
//      `timeout` (the order is written, the answer is lost after the stub's 30 s, so the worker's reconciliation looks
//      for it) for every --timeout-every-th, else the stub's normal answer (an issued order);
//   3. an SMTP sink in a child process that takes every e-mail and keeps only its count and size;
//   4. the built API and the built worker, each started as its systemd unit starts it (APP_ENV and NODE_ENV production,
//      `--enable-source-maps`; the API with `--max-old-space-size=640 --max-semi-space-size=32`, the worker with
//      `--max-old-space-size=400`) with search-load.mjs's measuring preload; the worker's copy also times every BullMQ
//      job: how long it waited from due to its first attempt, and how long each attempt ran;
//   5. a warm-up per tenant (one journey of each kind), then --minutes of mixed traffic at fixed rates (an open model:
//      a journey starts at its time whatever the others do, at most --max-in-flight at once), the tenants in turn:
//        - shoppers (--shoppers-per-minute): `flights.search`, `flights.listResults` (first page of 20) and
//          `flights.price` of the first offer, as search-load.mjs's journeys;
//        - bookers (--bookings-per-minute): the same three calls, then `checkout.create`, the traveller and the contact,
//          `checkout.createPayment {method: "airline_card"}`, the card hint (`checkout.updatePayment`, the card fee),
//          `checkout.get`, `checkout.completeWithAirlineCard` with Visa's documented test card, and the guest's
//          `bookings.get` with the booking token; every call through the edge as the hosted storefront makes it;
//        - staff (--staff-per-minute): one of the tenant's signed-in staff members through the OTA admin's service key
//          lists the bookings, opens the first, lists the payments and the Amadeus calls (console.auth.refresh every 10
//          minutes, as the OTA admin refreshes the 15-minute access token);
//      --think-ms between two calls of a journey. Every minute the run makes the bookings look last synchronised, and
//      last claimed by a sync, 7 hours ago, so every booking with an order is due for the booking sync: each
//      `bookings.sync_scan` (every 10 minutes) then enqueues its most, up to 20 bookings per tenant; and it rewrites the
//      bookings whose order came back without tickets as card-paid issuance retries (`deferredToRetries`);
//   6. every --sample-s seconds: the RSS of the API and the worker, the connections of the run's database
//      (`pg_stat_activity`, by application), Redis's memory, clients and keys, the worker's `/health/ready` queues
//      (waiting jobs, the oldest wait, failures in the last hour) and the 1-minute load average;
//   7. the report: p50/p95/p99 per operation, the journeys, the Amadeus calls, the e-mails, the API's and the worker's
//      CPU and RSS against their `MemoryMax` (768 and 512 MiB), the connections against the pools and
//      `max_connections`, Redis's memory against the VM's `maxmemory` (512 MiB) and `MEMORY USAGE` of the run's keys
//      by kind and of its jobs by name at the end (what one completed job holds), the queue latency per queue and per
//      job against
//      --queue-budget-s for `ota-ticketing` and `ota-bookings`, the bookings' outcomes, the database and
//      document storage growth, a timeline per --window-minutes, and the run (date, commit, `nproc`, the load average
//      at the start, at the end and per window). --json <file> writes the same figures as JSON.
// Everything is removed at the end, also after Ctrl-C or a SIGTERM: the processes, the database, the Redis database's
// keys and the temporary folder (with the documents the worker rendered).
//
// Exit codes: 0 every answer was expected, no journey was skipped or still running at the end, the API's and the
// worker's RSS stayed within their `MemoryMax`, and no `ota-ticketing` or `ota-bookings` job waited longer than
// --queue-budget-s, with jobs of both measured once a fixture had made their work due long enough before the end
// (EXPECT_JOBS_AFTER_MS); 1 otherwise, or when the run could not be set up; 2 a usage error; 130 interrupted. Nothing it prints or writes carries a key, a
// password, a token, a card number or a connection string; the card is test data and lives in memory only.
import { fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  apiEnv,
  ask,
  BACKEND_DIR,
  BUCKET_REFILL_MS,
  BUILD_COMMAND,
  BUILT_FILES,
  call,
  checkBuilt,
  commitOf,
  err,
  freePort,
  interruption,
  isoDay,
  LOG_TAIL_LINES,
  loadAverage,
  loadPackages,
  mib,
  out,
  pauseFor,
  PRICE_INCLUDE,
  RESULTS_LIMIT,
  round1,
  rounded,
  seedTenants,
  serveAmadeus,
  startAmadeus,
  startApi,
  startService,
  stopProcess,
  stopped,
  summarize,
  tail,
  TENANT_KEYS,
  throwIfInterrupted,
  UsageError,
  visitorAddress,
  writeKeyFiles,
} from "./search-load.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

/** The built files of this run: search-load.mjs's and the worker. */
const BOOKING_BUILT_FILES = Object.freeze([...BUILT_FILES, "ota/backend/dist/worker.js"]);
/** The internal roles of this script's child processes. */
const AMADEUS_ROLE = "amadeus";
const MAIL_ROLE = "mail";

/** The worker's pool (OTA_POOL_MAX of src/tenancy/tenancy.module.ts) and the API's, by `application_name`. */
const WORKER_POOL = "ota-worker";
const POOL_MAX = Object.freeze({ "ota-api": 20, "ota-worker": 10 });
/** NODE_OPTIONS of deploy/systemd/velexis-ota-worker.service. */
const WORKER_NODE_OPTIONS = Object.freeze(["--max-old-space-size=400"]);
/** `MemoryMax` of the units (deploy/systemd), in bytes: docs/mvp/architecture.md §3. */
const MEMORY_MAX = Object.freeze({ api: 768 * 1_048_576, worker: 512 * 1_048_576 });
/** The VM's PostgreSQL `max_connections` and Redis `maxmemory` (docs/mvp/deployment-single-vm.md §5). */
const VM_MAX_CONNECTIONS = 100;
const VM_REDIS_MAXMEMORY = 512 * 1_048_576;
/** The queues the OTA worker consumes (src/common/queues/queue-names.ts) and the two the plan bounds (OBE-088). */
const OTA_QUEUES = Object.freeze([
  "ota-tenant-ops",
  "ota-stripe-events",
  "ota-payments",
  "ota-bookings",
  "ota-ticketing",
  "ota-notifications",
  "ota-documents",
  "ota-maintenance",
]);
const BOOKING_CRITICAL_QUEUES = Object.freeze(["ota-ticketing", "ota-bookings"]);

/** The routes of the measured searches (airports of the reference fixture); each search has its own route and day. */
const ROUTES = Object.freeze([
  ["MAD", "ORY"],
  ["CDG", "LHR"],
  ["LHR", "JFK"],
  ["JFK", "LAX"],
  ["ORY", "CDG"],
  ["LAX", "MAD"],
]);
/** The days ahead a search departs: 30 to 329, so a search repeats only after 1 800 journeys. */
const FIRST_DAY = 30;
const DAYS = 300;
/** The route and days of the warm-up's searches, which no measured search uses. */
const WARMUP_ROUTE = Object.freeze(["MAD", "CDG"]);
const WARMUP_DAY = 10;

/**
 * The traveller's last name of a booking picks the stub's scenario of its Flight Create Orders (step 2 of the header):
 * the proxy reads it from the order's first traveller.
 */
const LAST_NAMES = Object.freeze({ issued: "SAMPLE", deferred: "DEFERRED", late: "LATECOMER" });
const SCENARIO_OF_LAST_NAME = Object.freeze({
  [LAST_NAMES.deferred]: "ticketing-failed",
  [LAST_NAMES.late]: "timeout",
});
/** Visa's documented test card; the stub accepts it. Test data only, in memory only, never printed. */
const TEST_CARD = Object.freeze({
  brand: "VISA",
  holderName: "ANNA SAMPLE",
  number: "4111111111111111",
  expiryMonth: 12,
  expiryYear: new Date().getUTCFullYear() + 3,
  securityCode: "123",
});
/** The guest booking cookie of the hosted storefront (src/common/http/cookie-writer.ts). */
const GUEST_COOKIE = "__Host-vx_bt";
/** The tenants' booking queue (storefront_settings), as an OTA confirms one per shared office before launch. */
const BOOKING_QUEUE = Object.freeze({ number: 50, category: 0 });
/** Staff members per tenant, their role, and how often the OTA admin refreshes their 15-minute access token. */
const STAFF_PER_TENANT = 2;
const STAFF_ROLE = "agent";
const SESSION_REFRESH_MS = 10 * 60_000;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** The portal token's TTL in Redis, as the platform's API writes it (PADR-0007 item 1). */
const PORTAL_TOKEN_TTL_SECONDS = 60;
/** How often the run makes the bookings due for the booking sync and the deferred ones due for issuance (step 5). */
const FIXTURE_TICK_MS = 60_000;
/** A sync claim younger than this may belong to a sync that still runs: the ageing fixture leaves it alone. */
const SYNC_CLAIM_IN_FLIGHT_MS = 2 * 60_000;
/**
 * How long before the end of the phase a fixture must first have made work due for the run to expect a job of that
 * queue: a `ticketing.scan` runs every 5 minutes and a `bookings.sync_scan` every 10 (src/jobs/schedulers.ts), plus a
 * minute of margin. A booking-critical queue without any job after that means the queue latency was not measured.
 */
const EXPECT_JOBS_AFTER_MS = Object.freeze({ "ota-ticketing": 6 * 60_000, "ota-bookings": 11 * 60_000 });
/** The largest tenant tables the report shows. */
const TABLES_SHOWN = 14;
/** How long the run waits at the end for the journeys still in flight (a lost Create Orders answer takes 30 s). */
const DRAIN_MS = 120_000;
/** The airline card's limit of completions an hour per tenant (`airlineCardPerTenant`, src/common/http/rate-limits.ts). */
const AIRLINE_CARD_PER_TENANT_PER_HOUR = 60;

const USAGE = `Usage: node ota/backend/test/load/booking-load.mjs [options]

  --tenants <n>                   tenants, 2 to 8, served in turn (default 5)
  --minutes <n>                   minutes of measured traffic (default 30)
  --shoppers-per-minute <n>       search, results page and price journeys started per minute (default 120)
  --bookings-per-minute <n>       journeys that also book with the airline card, per minute, at most one per
                                  tenant (the card's limit of 60 an hour per tenant) (default 4)
  --staff-per-minute <n>          console journeys (bookings list and detail, payments, Amadeus calls) (default 30)
  --think-ms <n>                  pause between two calls of a journey (default 1000)
  --offers <n>                    offers in each search answer, 1 to 250, never more than the search asked
                                  for; 0 keeps the stub's 5 (default 250)
  --stub-delay-ms <n>             how long the stub holds every answer (default 300)
  --deferred-ticketing-every <n>  every n-th booking's order comes back without tickets; the run makes it a
                                  card-paid issuance retry, which the worker issues; 0 never (default 4)
  --timeout-every <n>             every n-th booking's Create Orders answer is lost, so the worker reconciles
                                  it; 0 never (default 25)
  --max-retries <n>               retries of a 429 after its Retry-After, as the SDK (default 2)
  --max-in-flight <n>             journeys at once; a journey that would start above it is skipped and the
                                  run fails (default 400)
  --queue-budget-s <n>            the longest wait of an ota-ticketing or ota-bookings job (default 60)
  --sample-s <n>                  seconds between two samples of the processes, PostgreSQL and Redis (default 5)
  --window-minutes <n>            minutes per row of the timeline (default 5)
  --redis-db <n>                  the Redis database of the run, 1 to 15, emptied before and after (default 13)
  --app-env <env>                 APP_ENV of the API and the worker: production (as on the VM) or test
  --json <file>                   also write the figures as JSON
  -h, --help                      this text

Build first with \`${BUILD_COMMAND}\`; PostgreSQL and Redis must run (TEST_DATABASE_ADMIN_URL, REDIS_URL).
`;

// ---- Options -----------------------------------------------------------------------------------------------------

/** The integer options: [name, default, min, max]. */
const INTEGER_OPTIONS = Object.freeze([
  ["tenants", 5, 2, TENANT_KEYS.length],
  ["minutes", 30, 1, 240],
  ["shoppers-per-minute", 120, 0, 6_000],
  ["bookings-per-minute", 4, 0, TENANT_KEYS.length],
  ["staff-per-minute", 30, 0, 6_000],
  ["think-ms", 1_000, 0, 600_000],
  ["offers", 250, 0, 250],
  ["stub-delay-ms", 300, 0, 30_000],
  ["deferred-ticketing-every", 4, 0, 1_000],
  ["timeout-every", 25, 0, 1_000],
  ["max-retries", 2, 0, 10],
  ["max-in-flight", 400, 1, 10_000],
  ["queue-budget-s", 60, 1, 3_600],
  ["sample-s", 5, 1, 60],
  ["window-minutes", 5, 1, 60],
  ["redis-db", 13, 1, 15],
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
  if (options.role !== undefined && options.role !== AMADEUS_ROLE && options.role !== MAIL_ROLE) {
    throw new UsageError(`unknown --role ${options.role}`);
  }
  if (options.json === "") {
    throw new UsageError("--json needs a file name");
  }
  // The airline card's limit: 60 completions an hour per tenant (`airlineCardPerTenant`); above it the API refuses.
  if (options.bookingsPerMinute * 60 > options.tenants * AIRLINE_CARD_PER_TENANT_PER_HOUR) {
    throw new UsageError(
      `--bookings-per-minute must be at most --tenants (${options.tenants}): the airline card allows ` +
        `${AIRLINE_CARD_PER_TENANT_PER_HOUR} completions an hour per tenant`,
    );
  }
  if (options.shoppersPerMinute + options.bookingsPerMinute + options.staffPerMinute === 0) {
    throw new UsageError("at least one of the rates must be above 0");
  }
  return Object.freeze(options);
}

// ---- The Amadeus side: search-load.mjs's proxy, with the scenario of each Create Orders (--role amadeus) ----------

/** The stub scenario of a Flight Create Orders body: from its first traveller's last name (header step 2). */
function createOrderScenario(operation, body) {
  if (operation !== "create-order") {
    return undefined;
  }
  try {
    const lastName = JSON.parse(body.toString("utf8"))?.data?.travelers?.[0]?.name?.lastName;
    return typeof lastName === "string" ? SCENARIO_OF_LAST_NAME[lastName.toUpperCase()] : undefined;
  } catch {
    return undefined;
  }
}

// ---- The SMTP sink (child process, --role mail) ------------------------------------------------------------------

/**
 * A minimal SMTP server on 127.0.0.1 that accepts every message: EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP and QUIT, no
 * TLS (the worker's SMTP_URL is `smtp:`). It keeps the number of sessions, messages and recipients and the size of the
 * messages, never their content.
 */
function serveMail() {
  let counters = { sessions: 0, messages: 0, recipients: 0, bytes: 0 };
  const server = createNetServer((socket) => {
    counters.sessions += 1;
    let buffer = "";
    let inData = false;
    let dataBytes = 0;
    let recipients = 0;
    socket.on("error", () => undefined);
    socket.write("220 load-sink ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) {
            // Keep the last four characters: the end of the data may come in the next chunk.
            dataBytes += Math.max(0, buffer.length - 4);
            buffer = buffer.slice(-4);
            return;
          }
          dataBytes += end;
          buffer = buffer.slice(end + 5);
          inData = false;
          counters.messages += 1;
          counters.recipients += recipients;
          counters.bytes += dataBytes;
          socket.write("250 2.0.0 Queued\r\n");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) {
          return;
        }
        const verb = buffer.slice(0, Math.min(4, newline)).toUpperCase();
        buffer = buffer.slice(newline + 2);
        if (verb === "EHLO") {
          socket.write("250-load-sink\r\n250 8BITMIME\r\n");
        } else if (verb === "HELO") {
          socket.write("250 load-sink\r\n");
        } else if (verb === "MAIL") {
          recipients = 0;
          socket.write("250 2.1.0 OK\r\n");
        } else if (verb === "RCPT") {
          recipients += 1;
          socket.write("250 2.1.5 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          dataBytes = 0;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "RSET") {
          recipients = 0;
          socket.write("250 2.0.0 OK\r\n");
        } else if (verb === "NOOP") {
          socket.write("250 2.0.0 OK\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 2.0.0 Bye\r\n");
          return;
        } else {
          socket.write("502 5.5.2 Command not recognized\r\n");
        }
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    process.on("message", (message) => {
      if (message === null || typeof message !== "object") {
        return;
      }
      if (message.type === "stats") {
        process.send({ id: message.id, body: counters });
      } else if (message.type === "reset") {
        counters = { sessions: 0, messages: 0, recipients: 0, bytes: 0 };
        process.send({ id: message.id, body: null });
      }
    });
    const stop = () => {
      server.close();
      process.exit(0);
    };
    process.once("SIGTERM", stop);
    process.once("disconnect", stop);
    process.send({ type: "ready", port: server.address().port });
  });
}

/** Starts the `--role mail` child process; resolves once it listens. */
async function startMail(runDir) {
  const logFile = join(runDir, "mail.log");
  const log = openSync(logFile, "a");
  const child = fork(SCRIPT, ["--role", MAIL_ROLE], {
    env: {},
    execArgv: [],
    stdio: ["ignore", log, log, "ipc"],
  });
  closeSync(log);
  const port = await new Promise((resolvePort, reject) => {
    const onExit = (code) =>
      reject(
        new Error(`the SMTP sink exited (${code}) before it listened:\n${tail(logFile, LOG_TAIL_LINES)}`),
      );
    child.once("exit", onExit);
    child.once("message", (message) => {
      child.off("exit", onExit);
      if (message?.type === "ready" && Number.isSafeInteger(message.port)) {
        resolvePort(message.port);
      } else {
        reject(new Error("the SMTP sink sent something unexpected"));
      }
    });
  });
  return {
    port,
    stats: () => ask(child, "stats"),
    reset: () => ask(child, "reset"),
    stop: () => stopProcess(child),
  };
}

// ---- Set-up: the rows booking-load adds to search-load's tenants ---------------------------------------------------

/**
 * The platform rows a tenant of this run has beyond search-load.mjs's, as the platform writes them: the Velexis
 * Stripe test connection (manual capture) and STAFF_PER_TENANT staff members, each a portal account with MFA and an
 * active membership. Returns the members of each tenant through `members` and the connection's id through
 * `connections`.
 */
function platformRowsOf(newId, members, connections) {
  return async (platform, tenant) => {
    const connectionId = newId("ppc");
    connections.set(tenant.key, connectionId);
    await platform
      .insertInto("platform.payment_provider_connections")
      .values({
        id: connectionId,
        tenant_id: tenant.id,
        provider: "stripe",
        environment: "test",
        account_mode: "velexis",
        capture_mode: "manual",
        is_default: true,
        status: "active",
        statement_descriptor_suffix: `${tenant.key.toUpperCase()} TRAVEL`,
      })
      .execute();
    const staff = [];
    for (let index = 0; index < STAFF_PER_TENANT; index += 1) {
      const accountId = newId("acc");
      await platform
        .insertInto("platform.accounts")
        .values({
          id: accountId,
          email: `staff${index + 1}.${tenant.key}.${randomBytes(3).toString("hex")}@example.com`,
          full_name: `Load Agent ${index + 1}`,
          status: "active",
          email_verified_at: new Date(),
          locale: "en-GB",
          time_zone: "Europe/Paris",
          mfa_enabled: true,
        })
        .execute();
      const staffId = newId("stf");
      await platform
        .insertInto("platform.tenant_memberships")
        .values({
          id: staffId,
          tenant_id: tenant.id,
          account_id: accountId,
          role: STAFF_ROLE,
          status: "active",
        })
        .execute();
      staff.push({ accountId, staffId, tenantId: tenant.id });
    }
    members.set(tenant.key, staff);
  };
}

/** The storefront settings of a tenant of this run (header step 1), through tenantTx as velexis_ota_app. */
async function tenantRowsOf(trx, tenant) {
  await trx
    .updateTable("storefront_settings")
    .set({
      airline_card_enabled_test: true,
      ops_alert_email: `ops@${tenant.key}-travel.example.com`,
      booking_queue_number: BOOKING_QUEUE.number,
      booking_queue_category: BOOKING_QUEUE.category,
    })
    .execute();
}

/** The variables of the worker: the API's (search-load.mjs `apiEnv`) and the worker unit's own. */
function workerEnv(options, run) {
  const env = apiEnv(options, run);
  delete env.PORT;
  return {
    ...env,
    HEALTH_PORT: String(run.workerHealthPort),
    DATABASE_PROVISIONER_URL: run.provisionerUrl,
    SMTP_URL: `smtp://127.0.0.1:${run.smtpPort}`,
    MAIL_FROM: '"Velexis OTA (load test)" <no-reply@mail.ota.example.com>',
    OPS_ALERT_EMAIL: "ops@example.com",
    PUBLIC_OTA_ADMIN_URL: "https://admin.ota.example.com",
  };
}

// ---- The journeys ------------------------------------------------------------------------------------------------

/** The SIMPLE search of journey `index`: its own route and day; the warm-up has its own. */
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

/** Letters for a sequence number (1 → A, 27 → AA): names hold no digits. */
function lettersOf(sequence) {
  let rest = sequence;
  let letters = "";
  while (rest > 0) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

/** The headers of a storefront visitor at `tenant` (Caddy's edge headers, the CSRF cookie and header). */
function storefrontHeaders(context, tenant, address) {
  const csrf = randomBytes(32).toString("base64url");
  const read = {
    Accept: "application/json",
    "Accept-Language": "en",
    "X-Velexis-Edge": context.edgeSecret,
    "X-Velexis-Host": tenant.host,
    "X-Forwarded-For": address,
  };
  return {
    read,
    write: () => ({
      ...read,
      "Content-Type": "application/json",
      Origin: `https://${tenant.host}`,
      "X-CSRF-Token": csrf,
      Cookie: `__Host-vx_csrf=${csrf}`,
      "Idempotency-Key": randomUUID(),
    }),
  };
}

/** A failed journey when `answer` is not `status`, else undefined. */
function unless(operation, answer, status) {
  return answer.status === status ? undefined : stopped(operation, answer);
}

/** Search, the first results page and the price of the first offer; the priced offer's id, or the outcome. */
async function shop(context, record, headers, index, warmup) {
  const pause = () => pauseFor(context.thinkMs);
  const search = await call(context, record, {
    operation: "flights.search",
    method: "POST",
    path: "/v1/flight-searches",
    body: searchCriteria(index, warmup),
    headers: headers.write(),
  });
  if (search.status !== 201 || typeof search.payload?.id !== "string") {
    return { stop: stopped("flights.search", search) };
  }
  await pause();
  const results = await call(context, record, {
    operation: "flights.listResults",
    method: "GET",
    path: `/v1/flight-searches/${encodeURIComponent(search.payload.id)}/offers?limit=${RESULTS_LIMIT}`,
    headers: headers.read,
  });
  const offerId = Array.isArray(results.payload?.data) ? results.payload.data[0]?.id : undefined;
  if (results.status !== 200 || typeof offerId !== "string") {
    return { stop: stopped("flights.listResults", results) };
  }
  await pause();
  const price = await call(context, record, {
    operation: "flights.price",
    method: "POST",
    path: "/v1/priced-offers",
    body: { offerIds: [offerId], include: [...PRICE_INCLUDE] },
    headers: headers.write(),
  });
  if (price.status !== 201 || typeof price.payload?.id !== "string") {
    return { stop: stopped("flights.price", price) };
  }
  return { pricedOfferId: price.payload.id };
}

/** A shopper's journey: search, results page, price. */
async function shopperJourney(context, tenant, index, warmup, record) {
  const headers = storefrontHeaders(context, tenant, visitorAddress(index, warmup));
  const shopped = await shop(context, record, headers, index, warmup);
  return shopped.stop ?? { outcome: "completed" };
}

/**
 * A booker's journey (header step 5): the shopper's three calls, the checkout with the airline card, and the guest's
 * booking. `kind` is `issued`, `deferred` or `late` (the stub scenario of its Create Orders, through the last name).
 */
async function bookerJourney(context, tenant, index, warmup, record, kind) {
  const headers = storefrontHeaders(context, tenant, visitorAddress(index, warmup));
  const pause = () => pauseFor(context.thinkMs);
  const shopped = await shop(context, record, headers, index, warmup);
  if (shopped.stop !== undefined) {
    return shopped.stop;
  }
  await pause();
  const created = await call(context, record, {
    operation: "checkout.create",
    method: "POST",
    path: "/v1/checkouts",
    body: { pricedOfferId: shopped.pricedOfferId },
    headers: headers.write(),
  });
  const checkoutId = created.payload?.id;
  if (created.status !== 201 || typeof checkoutId !== "string") {
    return stopped("checkout.create", created);
  }
  const checkoutPath = `/v1/checkouts/${encodeURIComponent(checkoutId)}`;
  const firstName = `TESTA${lettersOf(index + 1)}`;
  const lastName = LAST_NAMES[kind];
  const phones = [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }];
  await pause();
  const travelers = await call(context, record, {
    operation: "checkout.setTravelers",
    method: "PUT",
    path: `${checkoutPath}/travelers`,
    body: {
      travelers: [
        {
          travelerId: "1",
          name: { firstName, lastName },
          dateOfBirth: "1988-04-12",
          gender: "FEMALE",
          contact: { emailAddress: `traveller-${index}@example.com`, phones },
          documents: [
            {
              documentType: "PASSPORT",
              number: `X${String(10_000_000 + ((index * 7_919) % 89_999_999))}`,
              issuanceDate: isoDay(-365),
              expiryDate: isoDay(5 * 365),
              issuanceCountry: "SE",
              issuanceLocation: "STOCKHOLM",
              nationality: "SE",
              birthPlace: "UPPSALA",
              holder: true,
            },
          ],
        },
      ],
    },
    headers: headers.write(),
  });
  const failedTravelers = unless("checkout.setTravelers", travelers, 200);
  if (failedTravelers !== undefined) {
    return failedTravelers;
  }
  const contacts = await call(context, record, {
    operation: "checkout.setContacts",
    method: "PUT",
    path: `${checkoutPath}/contacts`,
    body: {
      contacts: [
        {
          purpose: "STANDARD",
          isPrimary: true,
          addresseeName: { firstName, lastName },
          emailAddress: `contact-${index}@example.com`,
          phones,
          language: "en",
        },
      ],
    },
    headers: headers.write(),
  });
  const failedContacts = unless("checkout.setContacts", contacts, 200);
  if (failedContacts !== undefined) {
    return failedContacts;
  }
  await pause();
  const payment = await call(context, record, {
    operation: "checkout.createPayment",
    method: "POST",
    path: `${checkoutPath}/payments`,
    body: { method: "airline_card", termsAccepted: true },
    headers: headers.write(),
  });
  const paymentId = payment.payload?.id;
  if (payment.status !== 201 || typeof paymentId !== "string") {
    return stopped("checkout.createPayment", payment);
  }
  const hinted = await call(context, record, {
    operation: "checkout.updatePayment",
    method: "PATCH",
    path: `/v1/payments/${encodeURIComponent(paymentId)}`,
    body: { card: { brand: TEST_CARD.brand, bin: TEST_CARD.number.slice(0, 6) } },
    headers: headers.write(),
  });
  const amount = hinted.payload?.amount;
  if (hinted.status !== 200 || typeof amount?.amount !== "string") {
    return stopped("checkout.updatePayment", hinted);
  }
  const checkout = await call(context, record, {
    operation: "checkout.get",
    method: "GET",
    path: checkoutPath,
    headers: headers.read,
  });
  const failedCheckout = unless("checkout.get", checkout, 200);
  if (failedCheckout !== undefined) {
    return failedCheckout;
  }
  await pause();
  const late = kind === "late";
  const completion = await call(context, record, {
    operation: late ? "checkout.completeWithAirlineCard (lost answer)" : "checkout.completeWithAirlineCard",
    method: "POST",
    path: `${checkoutPath}/airline-card-completion`,
    body: {
      paymentId,
      expectedTotal: { amount: amount.amount, currency: amount.currency },
      card: { ...TEST_CARD },
    },
    headers: headers.write(),
  });
  if (late) {
    // The stub wrote the order and lost the answer: the API answers 504 SUPPLIER_TIMEOUT and the worker reconciles.
    return completion.status === 504 && completion.code === "SUPPLIER_TIMEOUT"
      ? { outcome: "completed", booking: "reconciling" }
      : stopped("checkout.completeWithAirlineCard (lost answer)", completion);
  }
  // The hosted storefront gets the guest's booking token in the `__Host-vx_bt` cookie, never in the body (OADR-0006).
  const bookingId = completion.payload?.booking?.id;
  const guestCookie = (completion.headers?.getSetCookie() ?? [])
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith(`${GUEST_COOKIE}=`));
  if (completion.status !== 201 || typeof bookingId !== "string" || guestCookie === undefined) {
    return stopped("checkout.completeWithAirlineCard", completion);
  }
  const ticketing = completion.payload.booking.ticketing?.status;
  if ((kind === "issued") !== (ticketing === "issued")) {
    return {
      outcome: "failed",
      detail: `checkout.completeWithAirlineCard ${kind} booking with ticketing ${ticketing}`,
    };
  }
  await pause();
  const booking = await call(context, record, {
    operation: "bookings.get",
    method: "GET",
    path: `/v1/bookings/${encodeURIComponent(bookingId)}`,
    headers: { ...headers.read, Cookie: guestCookie },
  });
  return unless("bookings.get", booking, 200) ?? { outcome: "completed", booking: kind };
}

/** A staff member's session in the OTA admin: the service key's headers and the member's tokens. */
class StaffSession {
  constructor(context, member, index) {
    this.context = context;
    this.member = member;
    // 198.51.100.0/24 (TEST-NET-2): the staff members' own addresses, apart from the storefront visitors'.
    this.ip = `198.51.100.${index + 1}`;
    this.userAgent = `Mozilla/5.0 (OTA admin load test ${index + 1})`;
    this.accessToken = "";
    this.refreshToken = "";
    this.refreshedAt = 0;
    this.refreshing = undefined;
  }

  headers() {
    return {
      Accept: "application/json",
      "X-Api-Key": this.context.serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      "X-Velexis-Environment": "test",
    };
  }

  /** Stores the answer's tokens; false when the answer has none. */
  keep(answer) {
    const session = answer.payload?.session;
    if (typeof session?.accessToken !== "string" || typeof session?.refreshToken !== "string") {
      return false;
    }
    this.accessToken = session.accessToken;
    this.refreshToken = session.refreshToken;
    this.refreshedAt = performance.now();
    return true;
  }

  /** console.auth.signIn with a portal token the platform would have stored in Redis (PADR-0007 item 1). */
  async signIn(record) {
    // `ptk_` and 43 base62 characters, as the platform issues it.
    const portalToken = `ptk_${Array.from(randomBytes(43), (byte) => BASE62[byte % BASE62.length]).join("")}`;
    const value = JSON.stringify({
      v: 1,
      accountId: this.member.accountId,
      tenantId: this.member.tenantId,
      membershipId: this.member.staffId,
      role: STAFF_ROLE,
      mfa: true,
      issuedAt: new Date().toISOString(),
      requestId: randomUUID(),
    });
    const key = this.context.redisKeys.portalToken(
      createHash("sha256").update(portalToken).digest("hex"),
    ).key;
    await this.context.redis.set(key, value, "EX", PORTAL_TOKEN_TTL_SECONDS, "NX");
    const answer = await call(this.context, record, {
      operation: "console.auth.signIn",
      method: "POST",
      path: "/v1/console/auth/sign-in",
      body: { grantType: "portal_token", portalToken },
      headers: { ...this.headers(), "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    });
    if (answer.status !== 200 || !this.keep(answer)) {
      throw new Error(`console.auth.signIn answered ${answer.status} ${answer.code ?? ""}`.trim());
    }
  }

  /** console.auth.refresh once the access token is SESSION_REFRESH_MS old; one refresh at a time (rotating token). */
  async fresh(record) {
    if (performance.now() - this.refreshedAt < SESSION_REFRESH_MS) {
      return undefined;
    }
    this.refreshing ??= (async () => {
      const answer = await call(this.context, record, {
        operation: "console.auth.refresh",
        method: "POST",
        path: "/v1/console/auth/refresh",
        body: { refreshToken: this.refreshToken },
        headers: { ...this.headers(), "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      });
      return answer.status === 200 && this.keep(answer) ? undefined : stopped("console.auth.refresh", answer);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return await this.refreshing;
  }

  get(record, operation, path) {
    return call(this.context, record, {
      operation,
      method: "GET",
      path,
      headers: { ...this.headers(), Authorization: `Bearer ${this.accessToken}` },
    });
  }
}

/** A staff journey: the bookings list, the first booking, the payments list and the Amadeus calls. */
async function staffJourney(context, session, record) {
  const pause = () => pauseFor(context.thinkMs);
  const refused = await session.fresh(record);
  if (refused !== undefined) {
    return refused;
  }
  const bookings = await session.get(record, "console.bookings.list", "/v1/console/bookings");
  if (bookings.status !== 200 || !Array.isArray(bookings.payload?.data)) {
    return stopped("console.bookings.list", bookings);
  }
  const first = bookings.payload.data[0]?.id;
  if (typeof first === "string") {
    await pause();
    const booking = await session.get(
      record,
      "console.bookings.get",
      `/v1/console/bookings/${encodeURIComponent(first)}`,
    );
    const failed = unless("console.bookings.get", booking, 200);
    if (failed !== undefined) {
      return failed;
    }
  }
  await pause();
  const payments = await session.get(record, "console.payments.list", "/v1/console/payments");
  const failedPayments = unless("console.payments.list", payments, 200);
  if (failedPayments !== undefined) {
    return failedPayments;
  }
  await pause();
  const calls = await session.get(record, "console.supplierRequests.list", "/v1/console/supplier-requests");
  return unless("console.supplierRequests.list", calls, 200) ?? { outcome: "completed" };
}

/** The kind of the booker journey with this sequence number (1, 2, …): every n-th deferred or late (header step 2). */
function bookingKind(options, sequence) {
  if (options.timeoutEvery > 0 && sequence % options.timeoutEvery === 0) {
    return "late";
  }
  if (options.deferredTicketingEvery > 0 && sequence % options.deferredTicketingEvery === 0) {
    return "deferred";
  }
  return "issued";
}

// ---- Sampling ----------------------------------------------------------------------------------------------------

/** `INFO` of Redis as an object of its `name:value` lines. */
function infoOf(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line.includes(":") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)]),
  );
}

/** The prefix of the BullMQ keys (`BULLMQ_PREFIX` of @velexis/api-types/jobs). */
const BULLMQ_PREFIX = "vx";

/**
 * The kind of a key of the run's Redis database: a BullMQ job (`vx:<queue>:<job id>`, a hash), a queue's events
 * stream (`vx:<queue>:events`), another BullMQ key (the queue's lists, sets, schedulers and meta) or an application
 * key (caches, tokens, limits).
 */
function redisKindOf(key, type) {
  const parts = key.split(":");
  if (parts[0] !== BULLMQ_PREFIX || parts.length < 3) {
    return "application";
  }
  if (type === "stream" && parts.length === 3 && parts[2] === "events") {
    return "bullmqEvents";
  }
  // The hashes of a queue are its jobs (a job id may hold colons, as `repeat:<scheduler>:<millis>` does), its meta and
  // its schedulers (`repeat:<scheduler>`).
  const meta = parts.length === 3 && parts[2] === "meta";
  const scheduler = parts.length === 4 && parts[2] === "repeat";
  return type === "hash" && !meta && !scheduler ? "bullmqJobs" : "bullmqOther";
}

/**
 * Redis's memory by kind of key of the run's database (redisKindOf), from `MEMORY USAGE` of every key (all samples of
 * a key's values, `SAMPLES 0`): the keys and bytes of each kind, and of the BullMQ jobs by queue and job name (the
 * job hash's `name` field). Key names and job names only, never a job's data or another value.
 */
async function redisBreakdown(redis) {
  const kinds = {
    bullmqJobs: { keys: 0, bytes: 0 },
    bullmqEvents: { keys: 0, bytes: 0 },
    bullmqOther: { keys: 0, bytes: 0 },
    application: { keys: 0, bytes: 0 },
  };
  const jobNames = {};
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "COUNT", 1000);
    cursor = next;
    if (keys.length > 0) {
      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.type(key);
        pipeline.memory("USAGE", key, "SAMPLES", "0");
        // A WRONGTYPE answer for a key that is no hash stays in its result: only the job hashes' names are read.
        pipeline.hget(key, "name");
      }
      const results = await pipeline.exec();
      keys.forEach((key, index) => {
        const kind = redisKindOf(key, results[3 * index]?.[1]);
        const bytes = Number(results[3 * index + 1]?.[1] ?? 0);
        kinds[kind].keys += 1;
        kinds[kind].bytes += bytes;
        if (kind === "bullmqJobs") {
          const name = `${key.split(":")[1]} ${String(results[3 * index + 2]?.[1] ?? "?")}`;
          const entry = (jobNames[name] ??= { keys: 0, bytes: 0 });
          entry.keys += 1;
          entry.bytes += bytes;
        }
      });
    }
  } while (cursor !== "0");
  return { kinds, jobNames };
}

/** The worker's `/health/ready` queues: `{queue: {waiting, oldestWaitingSeconds, failedLastHour}}`, or undefined. */
async function workerQueues(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    const body = await response.json();
    return body !== null && typeof body.queues === "object" ? body.queues : undefined;
  } catch {
    return undefined;
  }
}

/** One sample of the processes, PostgreSQL, Redis and the machine (header step 6); a part that failed is left out. */
async function takeSample({ api, worker, monitor, redis, workerReadyUrl, startedAt }) {
  const [apiSample, workerSample, connections, memory, clients, keys, queues] = await Promise.all([
    api.sample().catch(() => undefined),
    worker.sample().catch(() => undefined),
    monitor
      .query(
        // Client connections only: PostgreSQL's own processes (autovacuum workers) use no connection slot.
        `SELECT coalesce(application_name, '') AS app, state, count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
         GROUP BY 1, 2`,
      )
      .then((result) => result.rows)
      .catch(() => undefined),
    redis
      .info("memory")
      .then(infoOf)
      .catch(() => undefined),
    redis
      .info("clients")
      .then(infoOf)
      .catch(() => undefined),
    redis.dbsize().catch(() => undefined),
    workerQueues(workerReadyUrl),
  ]);
  const byApp = {};
  let total = 0;
  let active = 0;
  for (const row of connections ?? []) {
    byApp[row.app] = (byApp[row.app] ?? 0) + row.n;
    total += row.n;
    active += row.state === "active" ? row.n : 0;
  }
  return {
    at: performance.now() - startedAt,
    load1: os.loadavg()[0],
    apiRssBytes: apiSample?.rssBytes,
    workerRssBytes: workerSample?.rssBytes,
    apiHeapBytes: apiSample?.heapUsedBytes,
    workerHeapBytes: workerSample?.heapUsedBytes,
    connections: connections === undefined ? undefined : { total, active, byApp },
    redisUsedBytes: memory === undefined ? undefined : Number(memory.used_memory),
    redisRssBytes: memory === undefined ? undefined : Number(memory.used_memory_rss),
    redisClients: clients === undefined ? undefined : Number(clients.connected_clients),
    redisKeys: keys,
    queues,
  };
}

/**
 * The card-paid issuance retries (header step 5): the bookings whose Create Orders came back without tickets
 * (`confirmed`, ticketing `manual_review`, paid by airline card: the ticketing job leaves those to the staff) are
 * rewritten as the Stripe path leaves a booking whose Flight Order Issue failed after the capture: the payment
 * `stripe`/`card`, captured (manual capture, a made-up PaymentIntent id of this run), the booking paid, ticketing
 * `failed` and due now. The ticketing scan then enqueues `ticketing.issue` for them, which issues the stub's order. The
 * load test cannot reach Stripe, so no booking of the run takes the card path; this is the work that path gives the
 * `ota-ticketing` queue. Returns the bookings changed.
 */
async function deferredToRetries(packages, tenantDb, tenants, connections) {
  const { sql, tenantTx } = packages.db;
  let changed = 0;
  for (const tenant of tenants) {
    changed += await tenantTx(tenantDb, tenant.schema, async (trx) => {
      const result = await sql`
        WITH due AS (
          SELECT b.id FROM bookings b
          WHERE b.status = 'confirmed' AND b.ticketing_status = 'manual_review' AND b.amadeus_order_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.method = 'airline_card')
          FOR NO KEY UPDATE OF b SKIP LOCKED
        ), paid AS (
          UPDATE payments p
          SET provider = 'stripe', method = 'card', capture_method = 'manual',
              provider_connection_id = ${connections.get(tenant.key)},
              provider_payment_id = 'pi_load_' || substr(p.id, 5), status = 'captured',
              amount_authorized = p.amount, amount_captured = p.amount, authorized_at = now(), captured_at = now(),
              updated_at = now()
          FROM due WHERE p.booking_id = due.id AND p.method = 'airline_card'
          RETURNING p.booking_id
        )
        UPDATE bookings b
        SET ticketing_status = 'failed', ticketing_next_attempt_at = now(), ticketing_error_code = 'TICKETING_FAILED',
            amount_paid = b.total_amount, updated_at = now()
        FROM due WHERE b.id = due.id AND b.id IN (SELECT booking_id FROM paid)
      `.execute(trx);
      return Number(result.numAffectedRows ?? 0);
    });
  }
  return changed;
}

/**
 * Makes every booking with an order due for the booking sync (header step 5): last synchronised 7 hours ago, and its
 * last sync claim, if it has one, as old. The sync scan skips a booking claimed in the last 30 minutes
 * (`BOOKING_SYNC_RETRY_MS`, src/bookings/sync-schedule.ts), so without the claim each scan would find only the bookings
 * made since the scan before. A claim younger than SYNC_CLAIM_IN_FLIGHT_MS, a sync that may still run, is left alone.
 * The rows changed.
 */
async function ageBookings(packages, tenantDb, tenants) {
  const { sql, tenantTx } = packages.db;
  let changed = 0;
  for (const tenant of tenants) {
    changed += await tenantTx(tenantDb, tenant.schema, async (trx) => {
      const result = await sql`
        UPDATE bookings
        SET last_synced_at = now() - interval '7 hours',
            sync_claimed_at = CASE WHEN sync_claimed_at IS NULL THEN NULL ELSE now() - interval '7 hours' END
        WHERE amadeus_order_id IS NOT NULL
          AND (last_synced_at IS NULL OR last_synced_at > now() - interval '6 hours'
               OR sync_claimed_at > now() - interval '30 minutes')
          AND (sync_claimed_at IS NULL
               OR sync_claimed_at < now() - make_interval(secs => ${SYNC_CLAIM_IN_FLIGHT_MS / 1000}))
      `.execute(trx);
      return Number(result.numAffectedRows ?? 0);
    });
  }
  return changed;
}

// ---- Figures -----------------------------------------------------------------------------------------------------

/** The size of a folder's files, in bytes, and their number. */
function folderSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        bytes += statSync(child).size;
        files += 1;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** The database's size, the tenant tables' sizes by name (all tenants together), and the bookings' outcomes. */
async function databaseFigures(packages, pool, tenantDb, tenants) {
  const { sql, tenantTx } = packages.db;
  const size = await pool.query("SELECT pg_database_size(current_database())::float8 AS bytes");
  const tables = await pool.query(
    `SELECT c.relname AS name, sum(pg_total_relation_size(c.oid))::float8 AS bytes,
            sum(greatest(c.reltuples, 0))::float8 AS rows
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname LIKE 'tenant\\_%' AND c.relkind = 'r'
     GROUP BY c.relname ORDER BY 2 DESC`,
  );
  // Exact rows of the largest tables (reltuples is an estimate until the tables are analysed), counted in each
  // tenant's tenantTx as velexis_ota_app, below.
  const largest = tables.rows.slice(0, TABLES_SHOWN).map((table) => table.name);
  const counts = new Map(largest.map((name) => [name, 0]));
  const outcomes = {};
  const notifications = {};
  const documents = {};
  for (const tenant of tenants) {
    await tenantTx(tenantDb, tenant.schema, async (trx) => {
      for (const name of largest) {
        const counted = await sql`SELECT count(*)::float8 AS n FROM ${sql.table(name)}`.execute(trx);
        counts.set(name, counts.get(name) + Number(counted.rows[0]?.n ?? 0));
      }
      const { rows } = await sql`
        SELECT status, ticketing_status, reconcile_outcome, count(*)::int AS n FROM bookings GROUP BY 1, 2, 3
      `.execute(trx);
      for (const row of rows) {
        const key = `${row.status} / ticketing ${row.ticketing_status}${row.reconcile_outcome === null ? "" : ` / reconcile ${row.reconcile_outcome}`}`;
        outcomes[key] = (outcomes[key] ?? 0) + row.n;
      }
      const sent = await sql`SELECT status, count(*)::int AS n FROM notifications GROUP BY 1`.execute(trx);
      for (const row of sent.rows) {
        notifications[row.status] = (notifications[row.status] ?? 0) + row.n;
      }
      const rendered = await sql`SELECT kind, count(*)::int AS n FROM booking_documents GROUP BY 1`.execute(
        trx,
      );
      for (const row of rendered.rows) {
        documents[row.kind] = (documents[row.kind] ?? 0) + row.n;
      }
    });
  }
  return {
    databaseBytes: Number(size.rows[0]?.bytes ?? 0),
    tables: tables.rows.map((row) => ({
      name: row.name,
      rows: counts.get(row.name) ?? Number(row.rows),
      bytes: Number(row.bytes),
    })),
    bookings: outcomes,
    notifications,
    documents,
  };
}

/** The 2xx (or the asked-for 504) answers of `operation`, in ms. */
function okTimes(records, operation) {
  return records
    .filter(
      (r) =>
        r.operation === operation &&
        ((r.status >= 200 && r.status < 300) || (r.status === 504 && operation.endsWith("(lost answer)"))),
    )
    .map((r) => r.ms);
}

/** The worker's jobs per queue and per queue and name: first-attempt waits, retries, runs, failures. */
function jobFigures(jobs, options) {
  const queues = {};
  const names = {};
  const entry = (map, key) =>
    (map[key] ??= { started: 0, retries: 0, waits: [], runs: [], completed: 0, failed: 0 });
  for (const [queue, name, , wait] of jobs.starts) {
    for (const target of [entry(queues, queue), entry(names, `${queue} ${name}`)]) {
      target.started += 1;
      if (wait === null) {
        target.retries += 1;
      } else {
        target.waits.push(wait);
      }
    }
  }
  for (const [queue, name, , run, completed] of jobs.ends) {
    for (const target of [entry(queues, queue), entry(names, `${queue} ${name}`)]) {
      target.runs.push(run);
      target[completed === 1 ? "completed" : "failed"] += 1;
    }
  }
  const shape = (value) => ({
    started: value.started,
    retries: value.retries,
    completed: value.completed,
    failed: value.failed,
    waitMs: rounded(summarize(value.waits)),
    runMs: rounded(summarize(value.runs)),
  });
  const byQueue = Object.fromEntries(
    [...new Set([...OTA_QUEUES, ...Object.keys(queues)])].map((queue) => [
      queue,
      shape(queues[queue] ?? { started: 0, retries: 0, waits: [], runs: [], completed: 0, failed: 0 }),
    ]),
  );
  const byName = Object.fromEntries(
    Object.entries(names)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, shape(value)]),
  );
  const budgetMs = options.queueBudgetS * 1000;
  const critical = Object.fromEntries(
    BOOKING_CRITICAL_QUEUES.map((queue) => [
      queue,
      {
        jobs: byQueue[queue].started,
        maxWaitMs: byQueue[queue].waitMs.max ?? 0,
        within: (byQueue[queue].waitMs.max ?? 0) <= budgetMs,
      },
    ]),
  );
  return { byQueue, byName, critical, budgetMs };
}

/** The most of `key` over the samples, or undefined. */
const most = (samples, pick) => {
  const values = samples.map(pick).filter((value) => typeof value === "number");
  return values.length === 0 ? undefined : Math.max(...values);
};

/** The timeline (header step 7): one row per --window-minutes of the measured phase. */
function timelineOf(options, records, outcomes, samples, jobs, phaseMs) {
  const windowMs = options.windowMinutes * 60_000;
  const windows = Math.max(1, Math.ceil(phaseMs / windowMs));
  const rows = [];
  for (let index = 0; index < windows; index += 1) {
    const from = index * windowMs;
    const to = from + windowMs;
    const inWindow = (at) => at >= from && at < to;
    const recordsIn = records.filter((r) => inWindow(r.at));
    const samplesIn = samples.filter((s) => inWindow(s.at));
    const p95 = (operation) => summarize(okTimes(recordsIn, operation)).p95;
    const loads = samplesIn.map((s) => s.load1);
    const waitsOf = (queue) =>
      jobs.starts
        .filter(([q, , at, wait]) => q === queue && wait !== null && inWindow(at - jobs.startedAtEpoch))
        .map(([, , , wait]) => wait);
    rows.push({
      // The last window may be partial: it holds the end of the traffic and the journeys still in flight then.
      minutes: `${options.windowMinutes * index}-${to <= phaseMs ? options.windowMinutes * (index + 1) : "end"}`,
      journeys: outcomes.filter((o) => inWindow(o.startedAt) && o.outcome === "completed").length,
      bookings: outcomes.filter((o) => inWindow(o.startedAt) && o.booking !== undefined).length,
      searchP95: round1(p95("flights.search")),
      priceP95: round1(p95("flights.price")),
      completionP95: round1(p95("checkout.completeWithAirlineCard")),
      consoleListP95: round1(p95("console.bookings.list")),
      apiRssMiB: mib(most(samplesIn, (s) => s.apiRssBytes)),
      workerRssMiB: mib(most(samplesIn, (s) => s.workerRssBytes)),
      connections: most(samplesIn, (s) => s.connections?.total),
      redisMiB: mib(most(samplesIn, (s) => s.redisUsedBytes)),
      maxWaitMs: Object.fromEntries(
        ["ota-ticketing", "ota-bookings", "ota-notifications", "ota-documents", "ota-maintenance"].map(
          (q) => [q, round1(most(waitsOf(q), (value) => value))],
        ),
      ),
      load1: {
        mean: loads.length === 0 ? undefined : round1(loads.reduce((a, b) => a + b, 0) / loads.length),
        max: loads.length === 0 ? undefined : round1(Math.max(...loads)),
      },
    });
  }
  return rows;
}

const OPERATIONS = Object.freeze([
  "flights.search",
  "flights.listResults",
  "flights.price",
  "checkout.create",
  "checkout.setTravelers",
  "checkout.setContacts",
  "checkout.createPayment",
  "checkout.updatePayment",
  "checkout.get",
  "checkout.completeWithAirlineCard",
  "checkout.completeWithAirlineCard (lost answer)",
  "bookings.get",
  "console.auth.signIn",
  "console.auth.refresh",
  "console.bookings.list",
  "console.bookings.get",
  "console.payments.list",
  "console.supplierRequests.list",
]);

/** The figures of a run (header step 7). */
function figuresOf(input) {
  const {
    options,
    tenants,
    phaseMs,
    context,
    visits,
    amadeus,
    mail,
    apiStart,
    apiEnd,
    workerStart,
    workerEnd,
  } = input;
  const { samples, database, storage, redisStart, redisEnd, redisKinds, maxConnections, skipped } = input;
  const { unfinished, maxStartLateMs } = input;
  const { records, outcomes } = visits;
  const latency = Object.fromEntries(
    OPERATIONS.filter((operation) => records.some((r) => r.operation === operation)).map((operation) => [
      operation,
      rounded(summarize(okTimes(records, operation))),
    ]),
  );
  latency["flights.search without the stub delay"] = rounded(
    summarize(okTimes(records, "flights.search").map((ms) => ms - options.stubDelayMs)),
  );
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
  const journeys = {};
  for (const o of outcomes) {
    const entry = (journeys[o.kind] ??= { started: 0, completed: 0, refused: 0, failed: 0 });
    entry.started += 1;
    entry[o.outcome] += 1;
  }
  const bookingsMade = {};
  for (const o of outcomes.filter((x) => x.booking !== undefined)) {
    bookingsMade[o.booking] = (bookingsMade[o.booking] ?? 0) + 1;
  }
  const expected = (r) =>
    (r.status >= 200 && r.status < 300) ||
    (r.status === 429 && r.code === "RATE_LIMITED") ||
    (r.status === 504 && r.code === "SUPPLIER_TIMEOUT" && r.operation.endsWith("(lost answer)"));
  const unexpected = [
    ...new Set(outcomes.filter((o) => o.outcome === "failed").map((o) => `${o.kind}: ${o.detail}`)),
    ...new Set(
      records
        .filter((r) => !expected(r))
        .map((r) =>
          `${r.operation} ${r.status === 0 ? r.code : r.status} ${r.status === 0 ? "" : (r.code ?? "")}`.trim(),
        ),
    ),
    ...(amadeus.searchOffers.moreThanAsked > 0
      ? [`${amadeus.searchOffers.moreThanAsked} search answers of the proxy with more offers than asked for`]
      : []),
    ...(skipped > 0 ? [`${skipped} journeys not started: --max-in-flight journeys were in flight`] : []),
    ...(unfinished > 0
      ? [`${unfinished} journeys still running ${DRAIN_MS / 1000} s after the last one started`]
      : []),
    ...[...new Set(context.fixtureErrors)].map((message) => `a fixture of the run failed: ${message}`),
  ];
  const processFigures = (start, end, budget, rssKey, heapKey) => {
    const peak = Math.max(end.peakRssBytes, end.maxRssBytes, most(samples, (s) => s[rssKey]) ?? 0);
    const cpuMs = end.cpuMs.user + end.cpuMs.system;
    return {
      cpuSeconds: round1(cpuMs / 1000),
      cpuShareOfOneCore: round1((cpuMs / phaseMs) * 100),
      rssPhaseStartMiB: mib(start.rssBytes),
      rssPeakMiB: mib(peak),
      rssEndMiB: mib(end.rssBytes),
      heapUsedPeakMiB: mib(most(samples, (s) => s[heapKey])),
      memoryMaxMiB: mib(budget),
      peakShareOfMemoryMax: round1((peak / budget) * 100),
      within: peak <= budget,
      poolWaitMs: rounded(summarize(end.poolWaitsMs)),
      poolMaxWaiting: end.maxWaiting,
      eventLoopDelayMs: rounded(end.eventLoopDelayMs),
    };
  };
  const jobs = jobFigures(workerEnd.jobs ?? { starts: [], ends: [] }, options);
  const health = {};
  for (const sample of samples) {
    for (const [queue, value] of Object.entries(sample.queues ?? {})) {
      const entry = (health[queue] ??= { maxWaiting: 0, maxOldestWaitingSeconds: 0, maxFailedLastHour: 0 });
      entry.maxWaiting = Math.max(entry.maxWaiting, value?.waiting ?? 0);
      entry.maxOldestWaitingSeconds = Math.max(
        entry.maxOldestWaitingSeconds,
        value?.oldestWaitingSeconds ?? 0,
      );
      entry.maxFailedLastHour = Math.max(entry.maxFailedLastHour, value?.failedLastHour ?? 0);
    }
  }
  for (const queue of BOOKING_CRITICAL_QUEUES) {
    const oldest = (health[queue]?.maxOldestWaitingSeconds ?? 0) * 1000;
    jobs.critical[queue].maxOldestWaitingMs = oldest;
    jobs.critical[queue].within = jobs.critical[queue].within && oldest <= jobs.budgetMs;
    // No job measured is no proof: when a fixture made the queue's work due long enough before the end, a queue
    // without a job means the preload missed the worker's jobs or the work never ran.
    const dueAt = context.workDueAt[queue];
    const expected = dueAt !== undefined && phaseMs - dueAt >= EXPECT_JOBS_AFTER_MS[queue];
    jobs.critical[queue].expected = expected;
    if (expected && jobs.critical[queue].jobs === 0) {
      unexpected.push(
        `no ${queue} job was measured, ${round1((phaseMs - dueAt) / 60_000)} min after a fixture made its work due`,
      );
    }
  }
  if (Object.values(jobs.byQueue).every((q) => q.started === 0)) {
    unexpected.push("the worker's preload measured no job at all: the queue latency was not measured");
  }
  const byApp = {};
  for (const sample of samples) {
    for (const [app, n] of Object.entries(sample.connections?.byApp ?? {})) {
      byApp[app] = Math.max(byApp[app] ?? 0, n);
    }
  }
  const loads = samples.map((s) => s.load1);
  const api = processFigures(apiStart, apiEnd, MEMORY_MAX.api, "apiRssBytes", "apiHeapBytes");
  const worker = processFigures(
    workerStart,
    workerEnd,
    MEMORY_MAX.worker,
    "workerRssBytes",
    "workerHeapBytes",
  );
  return {
    load: {
      tenants: tenants.map((t) => t.key),
      minutes: options.minutes,
      shoppersPerMinute: options.shoppersPerMinute,
      bookingsPerMinute: options.bookingsPerMinute,
      staffPerMinute: options.staffPerMinute,
      thinkMs: options.thinkMs,
      offersPerSearch: options.offers === 0 ? "stub (5)" : options.offers,
      stubDelayMs: options.stubDelayMs,
      deferredTicketingEvery: options.deferredTicketingEvery,
      timeoutEvery: options.timeoutEvery,
      appEnv: options.appEnv,
    },
    phase: {
      seconds: round1(phaseMs / 1000),
      journeys,
      bookingsMade,
      skipped,
      unfinished,
      maxStartLateMs: round1(maxStartLateMs),
      inFlightRequests: { mean: round1(context.busyMs / phaseMs), max: context.maxInFlight },
      maxJourneysInFlight: context.maxJourneys,
      bookingsAgedForSync: context.aged,
      deferredTurnedIntoIssuanceRetries: context.retried,
      load1: {
        mean: loads.length === 0 ? undefined : round1(loads.reduce((a, b) => a + b, 0) / loads.length),
        max: loads.length === 0 ? undefined : round1(Math.max(...loads)),
      },
    },
    latencyMs: latency,
    answers,
    amadeus,
    mail,
    api,
    worker,
    postgres: {
      maxConnections: {
        total: most(samples, (s) => s.connections?.total),
        active: most(samples, (s) => s.connections?.active),
        byApp,
      },
      poolMax: POOL_MAX,
      serverMaxConnections: maxConnections,
      vmMaxConnections: VM_MAX_CONNECTIONS,
    },
    redis: {
      usedStartMiB: mib(Number(redisStart.used_memory)),
      usedPeakMiB: mib(most(samples, (s) => s.redisUsedBytes)),
      usedEndMiB: mib(Number(redisEnd.used_memory)),
      rssPeakMiB: mib(most(samples, (s) => s.redisRssBytes)),
      maxClients: most(samples, (s) => s.redisClients),
      keysEnd: samples.at(-1)?.redisKeys,
      vmMaxmemoryMiB: mib(VM_REDIS_MAXMEMORY),
      maxmemoryMiB: mib(Number(redisEnd.maxmemory ?? 0)),
      // MEMORY USAGE of the run's keys by kind at the end, and of one BullMQ job on average: the completed jobs stay in
      // Redis for a day (KEEP_COMPLETED_JOBS, ADR-0009 item 7), so a day of jobs at the phase's rate is what they hold.
      byKind: Object.fromEntries(
        Object.entries(redisKinds.kinds).map(([kind, k]) => [kind, { keys: k.keys, MiB: mib(k.bytes) }]),
      ),
      bytesPerJob:
        redisKinds.kinds.bullmqJobs.keys === 0
          ? undefined
          : Math.round(redisKinds.kinds.bullmqJobs.bytes / redisKinds.kinds.bullmqJobs.keys),
      // The kept jobs by queue and name: how many, and the bytes of one on average.
      bytesPerJobByName: Object.fromEntries(
        Object.entries(redisKinds.jobNames)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, k]) => [name, { jobs: k.keys, bytesPerJob: Math.round(k.bytes / k.keys) }]),
      ),
      jobsPerMinute: round1(
        (Object.values(jobs.byQueue).reduce((n, q) => n + q.completed, 0) / phaseMs) * 60_000,
      ),
    },
    queues: {
      jobs: jobs.byQueue,
      perJob: jobs.byName,
      health,
      critical: jobs.critical,
      budgetMs: jobs.budgetMs,
    },
    database: {
      sizeStartMiB: mib(database.start.databaseBytes),
      sizeEndMiB: mib(database.end.databaseBytes),
      tables: database.end.tables.slice(0, TABLES_SHOWN).map((t) => {
        const before = database.start.tables.find((s) => s.name === t.name);
        return {
          name: t.name,
          rows: Math.round(t.rows),
          totalMiB: mib(t.bytes),
          grewMiB: mib(t.bytes - (before?.bytes ?? 0)),
        };
      }),
      bookings: database.end.bookings,
      notifications: database.end.notifications,
      documents: database.end.documents,
      storage: { files: storage.files, MiB: mib(storage.bytes) },
    },
    timeline: timelineOf(
      options,
      records,
      outcomes,
      samples,
      workerEnd.jobs ?? { starts: [], ends: [] },
      phaseMs,
    ),
    verdict: {
      apiWithinMemoryMax: api.within,
      workerWithinMemoryMax: worker.within,
      bookingCriticalQueuesWithinBudget: Object.values(jobs.critical).every((q) => q.within),
    },
    unexpected,
  };
}

// ---- The report --------------------------------------------------------------------------------------------------

const pad = (value, width) => String(value ?? "-").padStart(width);
const SUMMARY_HEADER = `${pad("count", 7)}${pad("p50", 9)}${pad("p95", 9)}${pad("p99", 9)}${pad("max", 9)}`;
const summaryLine = (label, s, width) =>
  `  ${label.padEnd(width)}${pad(s.count, 7)}${pad(s.p50, 9)}${pad(s.p95, 9)}${pad(s.p99, 9)}${pad(s.max, 9)}\n`;

function report(run, figures) {
  const lines = [];
  const add = (text) => lines.push(text);
  const { load, phase } = figures;
  add("\nOTA mixed-traffic load test with the worker (OBE-088)\n");
  add(
    `  run       ${run.date}, commit ${run.commit}, Node ${run.node}, PostgreSQL ${run.postgres}, Redis ${run.redis}\n`,
  );
  add(
    `  machine   nproc ${run.machine.nproc} (${run.machine.cpuModel}), ${run.machine.memoryGiB} GiB, ${run.machine.os}\n`,
  );
  add(
    `  load avg  ${run.loadAverage.start.join(" ")} at the start, ${run.loadAverage.end.join(" ")} at the end; ` +
      `1-minute over the phase: mean ${phase.load1.mean}, max ${phase.load1.max} (nproc ${run.machine.nproc})\n`,
  );
  add(
    `  load      ${load.tenants.length} tenants, ${load.minutes} min: ${load.shoppersPerMinute} shoppers, ` +
      `${load.bookingsPerMinute} bookings and ${load.staffPerMinute} staff journeys a minute; think ${load.thinkMs} ms; ` +
      `${load.offersPerSearch} offers per search answer (at most what the search asks for); stub delay ` +
      `${load.stubDelayMs} ms; bookings issued by the worker: ${load.deferredTicketingEvery === 0 ? "none" : `1 in ${load.deferredTicketingEvery}`}, ` +
      `reconciled by the worker: ${load.timeoutEvery === 0 ? "none" : `1 in ${load.timeoutEvery}`}; APP_ENV ${load.appEnv}\n`,
  );
  const kinds = Object.entries(phase.journeys)
    .map(([kind, j]) => `${kind} ${j.completed}/${j.started} (${j.refused} refused, ${j.failed} failed)`)
    .join("; ");
  add(
    `  phase     ${phase.seconds} s: journeys completed/started: ${kinds}; skipped ${phase.skipped}, still running ` +
      `at the end ${phase.unfinished}, started at most ${phase.maxStartLateMs} ms after their time; bookings: ` +
      `${Object.entries(phase.bookingsMade)
        .map(([kind, n]) => `${kind} ${n}`)
        .join(", ")}; journeys in flight max ${phase.maxJourneysInFlight}, requests in flight mean ` +
      `${phase.inFlightRequests.mean}, max ${phase.inFlightRequests.max}; fixtures: ${phase.bookingsAgedForSync} ` +
      `bookings made due for the sync, ${phase.deferredTurnedIntoIssuanceRetries} deferred bookings made card-paid ` +
      `issuance retries\n`,
  );
  const width = 48;
  add(`\nLatency of the expected answers (ms)${" ".repeat(width - 34)}${SUMMARY_HEADER}\n`);
  for (const [label, summary] of Object.entries(figures.latencyMs)) {
    add(summaryLine(label, summary, width));
  }
  add("\nAnswers per operation (every attempt)\n");
  for (const [operation, entry] of Object.entries(figures.answers)) {
    const statuses = Object.entries(entry.statuses)
      .map(([status, n]) => `${status}: ${n}`)
      .join(", ");
    add(`  ${operation.padEnd(width)}${pad(entry.attempts, 6)} attempts (${statuses})\n`);
  }
  add(`\nAmadeus calls through the proxy (${figures.amadeus.seconds} s)\n`);
  for (const [operation, entry] of Object.entries(figures.amadeus.operations)) {
    const scenarios =
      entry.scenarios === undefined
        ? ""
        : `, scenarios ${Object.entries(entry.scenarios)
            .map(([name, n]) => `${name} ${n}`)
            .join(", ")}`;
    const statuses = Object.entries(entry.statuses)
      .map(([status, n]) => `${status}: ${n}`)
      .join(", ");
    add(`  ${operation.padEnd(20)}${pad(entry.calls, 7)} calls (${statuses})${scenarios}\n`);
  }
  const rate = figures.amadeus.shoppingCallsPerSecond;
  add(`  search and price: ${rate.mean} calls/s on average, ${rate.peak} in the busiest second\n`);
  const { asked, answered } = figures.amadeus.searchOffers;
  add(
    `  offers asked for per search p50 ${asked.p50 ?? "-"}, max ${asked.max ?? "-"}; answered p50 ` +
      `${answered.p50 ?? "-"}, max ${answered.max ?? "-"}\n`,
  );
  add(
    `\nE-mails (SMTP sink): ${figures.mail.messages} messages, ${figures.mail.recipients} recipients, ` +
      `${mib(figures.mail.bytes)} MiB, ${figures.mail.sessions} sessions\n`,
  );
  for (const [name, p] of [
    ["API", figures.api],
    ["Worker", figures.worker],
  ]) {
    add(
      `\n${name}: CPU ${p.cpuSeconds} s (${p.cpuShareOfOneCore} % of one core); RSS ${p.rssPhaseStartMiB} MiB at the ` +
        `start of the phase (after the warm-up), ${p.rssPeakMiB} MiB peak (${p.peakShareOfMemoryMax} % of MemoryMax ${p.memoryMaxMiB} MiB: ` +
        `${p.within ? "within" : "OVER"}), ${p.rssEndMiB} MiB at the end, heap used peak ${p.heapUsedPeakMiB} MiB; ` +
        `pool wait p95 ${p.poolWaitMs.p95 ?? "-"} ms, max ${p.poolWaitMs.max ?? "-"} ms, at most ${p.poolMaxWaiting} ` +
        `waiting; event-loop delay p99 ${p.eventLoopDelayMs.p99} ms, max ${p.eventLoopDelayMs.max} ms\n`,
    );
  }
  const pg = figures.postgres;
  add(
    `\nPostgreSQL connections of the run's database: at most ${pg.maxConnections.total} (${pg.maxConnections.active} ` +
      `active); by application: ${Object.entries(pg.maxConnections.byApp)
        .map(([app, n]) => `${app || "(none)"} ${n}`)
        .join(", ")}; pools ota-api ${pg.poolMax["ota-api"]}, ota-worker ${pg.poolMax["ota-worker"]}; ` +
      `max_connections ${pg.serverMaxConnections} here, ${pg.vmMaxConnections} on the VM\n`,
  );
  const r = figures.redis;
  add(
    `Redis: used memory ${r.usedStartMiB} MiB at the start, ${r.usedPeakMiB} MiB peak, ${r.usedEndMiB} MiB at the ` +
      `end (RSS peak ${r.rssPeakMiB} MiB; maxmemory ${r.maxmemoryMiB} MiB here, ${r.vmMaxmemoryMiB} MiB on the ` +
      `VM); clients at most ${r.maxClients}; keys of the run's database at the end ${r.keysEnd}\n`,
  );
  add(
    `  by kind (MEMORY USAGE): ${Object.entries(r.byKind)
      .map(([kind, k]) => `${kind} ${k.keys} keys, ${k.MiB} MiB`)
      .join(
        "; ",
      )}; ${r.bytesPerJob ?? "-"} bytes per job kept; ${r.jobsPerMinute} jobs completed a minute, ` +
      `so a day of completed jobs at this rate holds about ${mib((r.bytesPerJob ?? 0) * r.jobsPerMinute * 1_440)} MiB\n`,
  );
  add(
    `  jobs kept by queue and name (jobs, bytes per job): ${Object.entries(r.bytesPerJobByName)
      .map(([name, k]) => `${name} ${k.jobs}, ${k.bytesPerJob}`)
      .join("; ")}\n`,
  );
  add(
    `\nQueue latency: from due to the first attempt (ms), every job of the phase; retries are counted, not timed\n`,
  );
  add(
    `  ${"queue".padEnd(44)}${pad("jobs", 7)}${pad("retry", 7)}${pad("fail", 6)}${pad("wait p50", 10)}${pad("p95", 9)}` +
      `${pad("max", 9)}${pad("run p95", 10)}${pad("max", 9)}  health: waiting max, oldest s max\n`,
  );
  for (const [queue, q] of Object.entries(figures.queues.jobs)) {
    const h = figures.queues.health[queue];
    add(
      `  ${queue.padEnd(44)}${pad(q.started, 7)}${pad(q.retries, 7)}${pad(q.failed, 6)}${pad(q.waitMs.p50, 10)}` +
        `${pad(q.waitMs.p95, 9)}${pad(q.waitMs.max, 9)}${pad(q.runMs.p95, 10)}${pad(q.runMs.max, 9)}  ` +
        `${h === undefined ? "-" : `${h.maxWaiting}, ${h.maxOldestWaitingSeconds}`}\n`,
    );
  }
  add("  per job:\n");
  for (const [name, q] of Object.entries(figures.queues.perJob)) {
    add(
      `  ${`  ${name}`.padEnd(44)}${pad(q.started, 7)}${pad(q.retries, 7)}${pad(q.failed, 6)}${pad(q.waitMs.p50, 10)}` +
        `${pad(q.waitMs.p95, 9)}${pad(q.waitMs.max, 9)}${pad(q.runMs.p95, 10)}${pad(q.runMs.max, 9)}\n`,
    );
  }
  const d = figures.database;
  add(
    `\nDatabase: ${d.sizeStartMiB} MiB after the warm-up, ${d.sizeEndMiB} MiB at the end; documents stored ` +
      `${d.storage.files} files, ${d.storage.MiB} MiB\n`,
  );
  add(
    `  ${"table (all tenants)".padEnd(28)}${pad("rows", 9)}${pad("total MiB", 11)}${pad("grew MiB", 10)}\n`,
  );
  for (const t of d.tables) {
    add(`  ${t.name.padEnd(28)}${pad(t.rows, 9)}${pad(t.totalMiB, 11)}${pad(t.grewMiB, 10)}\n`);
  }
  add(
    `  bookings: ${Object.entries(d.bookings)
      .map(([k, n]) => `${k}: ${n}`)
      .join("; ")}\n`,
  );
  add(
    `  notifications: ${Object.entries(d.notifications)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}; documents: ${Object.entries(d.documents)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}\n`,
  );
  add(
    `\nTimeline (max per window; latency p95 in ms; queue waits max in ms; load average 1-minute, nproc ` +
      `${run.machine.nproc})\n`,
  );
  add(
    `  ${"minutes".padEnd(9)}${pad("jrn", 5)}${pad("bkg", 5)}${pad("search", 8)}${pad("price", 7)}${pad("compl", 7)}` +
      `${pad("con.lst", 8)}${pad("API MiB", 8)}${pad("wrk MiB", 8)}${pad("pg", 4)}${pad("redis", 7)}${pad("tkt", 7)}` +
      `${pad("bkgq", 7)}${pad("notif", 7)}${pad("docs", 7)}${pad("maint", 7)}${pad("load", 11)}\n`,
  );
  for (const w of figures.timeline) {
    add(
      `  ${w.minutes.padEnd(9)}${pad(w.journeys, 5)}${pad(w.bookings, 5)}${pad(w.searchP95, 8)}${pad(w.priceP95, 7)}` +
        `${pad(w.completionP95, 7)}${pad(w.consoleListP95, 8)}${pad(w.apiRssMiB, 8)}${pad(w.workerRssMiB, 8)}` +
        `${pad(w.connections, 4)}${pad(w.redisMiB, 7)}${pad(w.maxWaitMs["ota-ticketing"], 7)}` +
        `${pad(w.maxWaitMs["ota-bookings"], 7)}${pad(w.maxWaitMs["ota-notifications"], 7)}` +
        `${pad(w.maxWaitMs["ota-documents"], 7)}${pad(w.maxWaitMs["ota-maintenance"], 7)}` +
        `${pad(`${w.load1.mean}/${w.load1.max}`, 11)}\n`,
    );
  }
  const v = figures.verdict;
  const critical = Object.entries(figures.queues.critical)
    .map(
      ([queue, q]) =>
        `${queue} ${q.jobs} jobs, longest wait ${round1(q.maxWaitMs / 1000)} s (health: oldest ` +
        `${round1(q.maxOldestWaitingMs / 1000)} s)`,
    )
    .join(", ");
  add(
    `\nVerdict: API RSS ${v.apiWithinMemoryMax ? "within" : "OVER"} its MemoryMax, worker RSS ` +
      `${v.workerWithinMemoryMax ? "within" : "OVER"} its MemoryMax; ${critical}: ` +
      `${v.bookingCriticalQueuesWithinBudget ? "within" : "OVER"} the budget of ${figures.queues.budgetMs / 1000} s\n`,
  );
  if (figures.unexpected.length > 0) {
    add(`Unexpected: ${figures.unexpected.join("; ")}\n`);
  }
  return lines.join("");
}

// ---- The run -----------------------------------------------------------------------------------------------------

/**
 * Runs the journeys of `plan` (each `{at, kind, tenant, start}`, `at` in ms from the phase's start) at their times;
 * a journey that would start while `maxInFlight` are in flight is skipped. Resolves when every started one is over or
 * DRAIN_MS after the last start, with the outcomes, the journeys skipped, the journeys still running then
 * (`unfinished`) and the most a journey started after its time (`maxStartLateMs`: the run's own delay).
 */
async function runPlan(context, plan, { maxInFlight, record }) {
  const outcomes = [];
  const running = new Set();
  let skipped = 0;
  let maxStartLateMs = 0;
  for (const item of plan) {
    if (interruption.signal.aborted) {
      break;
    }
    const wait = item.at - (performance.now() - context.startedAt);
    if (wait > 0) {
      await pauseFor(wait);
      if (interruption.signal.aborted) {
        break;
      }
    }
    if (running.size >= maxInFlight) {
      skipped += 1;
      continue;
    }
    const startedAt = performance.now() - context.startedAt;
    maxStartLateMs = Math.max(maxStartLateMs, startedAt - item.at);
    const promise = item
      .start((r) => record({ ...r, tenant: item.tenant.key }))
      .catch((error) => ({
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        outcomes.push({ ...result, kind: item.kind, tenant: item.tenant.key, startedAt });
        running.delete(promise);
      });
    running.add(promise);
    context.maxJourneys = Math.max(context.maxJourneys, running.size);
  }
  let timer;
  await Promise.race([
    Promise.all(running),
    new Promise((resolveDrain) => {
      timer = setTimeout(resolveDrain, DRAIN_MS);
    }),
  ]);
  clearTimeout(timer);
  return { outcomes, skipped, unfinished: running.size, maxStartLateMs };
}

/** The journeys of the measured phase at fixed rates (header step 5), each kind spread evenly over the minutes. */
function planOf(options, context, tenants, sessions) {
  const plan = [];
  const phaseMs = options.minutes * 60_000;
  let visitor = 0;
  let bookings = 0;
  let staff = 0;
  const every = (perMinute, add) => {
    if (perMinute === 0) {
      return;
    }
    const gap = 60_000 / perMinute;
    for (let at = gap / 2; at < phaseMs; at += gap) {
      add(at);
    }
  };
  every(options.shoppersPerMinute, (at) => {
    const index = (visitor += 1);
    const tenant = tenants[index % tenants.length];
    plan.push({
      at,
      kind: "shopper",
      tenant,
      start: (record) => shopperJourney(context, tenant, index, false, record),
    });
  });
  every(options.bookingsPerMinute, (at) => {
    const index = (visitor += 1);
    const sequence = (bookings += 1);
    const tenant = tenants[sequence % tenants.length];
    const kind = bookingKind(options, sequence);
    plan.push({
      at,
      kind: "booker",
      tenant,
      start: (record) => bookerJourney(context, tenant, index, false, record, kind),
    });
  });
  every(options.staffPerMinute, (at) => {
    const sequence = (staff += 1);
    const tenant = tenants[sequence % tenants.length];
    const session = sessions.get(tenant.key)[Math.floor(sequence / tenants.length) % STAFF_PER_TENANT];
    plan.push({ at, kind: "staff", tenant, start: (record) => staffJourney(context, session, record) });
  });
  return plan.sort((a, b) => a.at - b.at);
}

async function run(options) {
  checkBuilt(BOOKING_BUILT_FILES);
  const packages = loadPackages();
  const { defineConfig, env, loadDevEnvFiles } = packages.config;
  loadDevEnvFiles({ appDir: BACKEND_DIR });
  const settings = defineConfig({
    TEST_DATABASE_ADMIN_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
    REDIS_URL: env.url({ protocols: ["redis:", "rediss:"] }),
  });
  const { databaseUrl, redisUrlWithDatabase, TEST_ROLES } = packages.testing;
  const { redisKeys } = require(join(BACKEND_DIR, "dist", "common", "redis", "redis.keys.js"));
  const cpus = os.cpus();
  const runInfo = {
    date: new Date().toISOString(),
    commit: commitOf(),
    node: process.version,
    machine: {
      nproc: os.availableParallelism(),
      cpuModel: (cpus[0]?.model ?? "unknown").trim(),
      memoryGiB: Math.round((os.totalmem() / 1_073_741_824) * 10) / 10,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
    },
    loadAverage: { start: loadAverage(), end: [] },
  };
  out(
    `booking-load: ${options.tenants} tenants, ${options.minutes} min (load average ` +
      `${runInfo.loadAverage.start.join(" ")}, nproc ${runInfo.machine.nproc}); setting up…\n`,
  );

  const runDir = mkdtempSync(join(os.tmpdir(), "velexis-booking-load-"));
  const cleanups = [];
  let cleaning;
  const cleanup = () => {
    cleaning ??= (async () => {
      for (const step of cleanups.reverse()) {
        await step().catch((error) => err(`booking-load: clean-up step failed: ${error.message}\n`));
      }
      rmSync(runDir, { recursive: true, force: true });
    })();
    return cleaning;
  };
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals === 1) {
      err("booking-load: interrupted, stopping and cleaning up…\n");
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
    const amadeus = await startAmadeus(options, runDir, {
      script: SCRIPT,
      args: [
        "--role",
        AMADEUS_ROLE,
        "--stub-delay-ms",
        String(options.stubDelayMs),
        "--offers",
        String(options.offers),
      ],
    });
    cleanups.push(() => amadeus.stop());
    const mail = await startMail(runDir);
    cleanups.push(() => mail.stop());
    throwIfInterrupted();
    const run = {
      dir: runDir,
      keys,
      redisUrl,
      migratorUrl: databaseUrl(settings.TEST_DATABASE_ADMIN_URL, database.name, TEST_ROLES.migrator),
      otaUrl: databaseUrl(settings.TEST_DATABASE_ADMIN_URL, database.name, TEST_ROLES.ota),
      provisionerUrl: databaseUrl(settings.TEST_DATABASE_ADMIN_URL, database.name, TEST_ROLES.provisioner),
      apiPort: await freePort(),
      healthPort: await freePort(),
      workerHealthPort: await freePort(),
      smtpPort: mail.port,
      amadeusUrl: amadeus.url,
    };
    const members = new Map();
    const connections = new Map();
    const tenants = await seedTenants(packages, run, options.tenants, {
      amadeusBaseUrl: amadeus.url,
      platformRows: platformRowsOf(packages.crypto.newId, members, connections),
      tenantRows: tenantRowsOf,
    });
    throwIfInterrupted();
    const api = await startApi(options, run);
    cleanups.push(() => api.stop());
    throwIfInterrupted();
    const workerReadyUrl = `http://127.0.0.1:${run.workerHealthPort}/health/ready`;
    const worker = await startService(run, {
      name: "worker",
      entry: "worker.js",
      nodeOptions: WORKER_NODE_OPTIONS,
      env: workerEnv(options, run),
      pool: WORKER_POOL,
      bullmq: true,
      readyUrl: workerReadyUrl,
    });
    cleanups.push(() => worker.stop());
    throwIfInterrupted();
    const quiet = { error: () => undefined };
    // As velexis_ota_app, the API's and the worker's role: pg_stat_activity shows the state of that role's sessions.
    const monitor = packages.db.createPool(run.otaUrl, {
      applicationName: "ota-load-monitor",
      logger: quiet,
      max: 1,
    });
    cleanups.push(() => monitor.end());
    const fixturePool = packages.db.createPool(run.otaUrl, {
      applicationName: "ota-load-fixture",
      logger: quiet,
      max: 1,
    });
    cleanups.push(() => fixturePool.end());
    const tenantDb = packages.db.createTenantDb(fixturePool, { appEnv: "test" });
    const context = {
      apiUrl: api.url,
      edgeSecret: keys.edgeSecret,
      serviceKey: keys.serviceKey,
      redis,
      redisKeys,
      maxRetries: options.maxRetries,
      thinkMs: options.thinkMs,
      inFlight: 0,
      maxInFlight: 0,
      maxJourneys: 0,
      busyMs: 0,
      aged: 0,
      retried: 0,
      workDueAt: {},
      fixtureErrors: [],
      startedAt: performance.now(),
    };
    const ignore = () => undefined;
    const sessions = new Map();
    let staffIndex = 0;
    for (const tenant of tenants) {
      const list = [];
      for (const member of members.get(tenant.key)) {
        const session = new StaffSession(context, member, staffIndex);
        staffIndex += 1;
        await session.signIn(ignore);
        list.push(session);
      }
      sessions.set(tenant.key, list);
    }
    throwIfInterrupted();

    // The warm-up: one journey of each kind at every tenant, at once, not counted; then the buckets refill.
    const warmup = await Promise.all(
      tenants.flatMap((tenant, index) => [
        shopperJourney(context, tenant, index, true, ignore).then((r) => ({ ...r, tenant: tenant.key })),
        bookerJourney(context, tenant, 100 + index, true, ignore, "issued").then((r) => ({
          ...r,
          tenant: tenant.key,
        })),
        staffJourney(context, sessions.get(tenant.key)[0], ignore).then((r) => ({
          ...r,
          tenant: tenant.key,
        })),
      ]),
    );
    throwIfInterrupted();
    const failures = warmup.filter((o) => o.outcome !== "completed");
    if (failures.length > 0) {
      throw new Error(
        `the warm-up failed: ${failures.map((o) => `${o.tenant}: ${o.detail}`).join("; ")}\n` +
          `API:\n${tail(api.logFile, LOG_TAIL_LINES)}`,
      );
    }
    await pauseFor(BUCKET_REFILL_MS);
    throwIfInterrupted();

    const databaseStart = await databaseFigures(packages, monitor, tenantDb, tenants);
    const redisStart = { ...infoOf(await redis.info("memory")) };
    const maxConnections = Number((await monitor.query("SHOW max_connections")).rows[0]?.max_connections);
    out(
      `booking-load: warm-up done; ${options.minutes} min of traffic (load average ${loadAverage().join(" ")})…\n`,
    );
    await Promise.all([amadeus.reset(), mail.reset(), api.reset(), worker.reset()]);
    const [apiStart, workerStart] = await Promise.all([api.stats(), worker.stats()]);
    Object.assign(context, {
      inFlight: 0,
      maxInFlight: 0,
      maxJourneys: 0,
      busyMs: 0,
      startedAt: performance.now(),
    });
    const phaseStarted = performance.now();
    const startedAtEpoch = Date.now();
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling && !interruption.signal.aborted) {
        samples.push(
          await takeSample({ api, worker, monitor, redis, workerReadyUrl, startedAt: phaseStarted }),
        );
        await pauseFor(options.sampleS * 1000);
      }
    })();
    const fixtureFailed = (error) => {
      context.fixtureErrors.push(error instanceof Error ? error.message : String(error));
      return 0;
    };
    const ageing = (async () => {
      while (sampling && !interruption.signal.aborted) {
        await pauseFor(FIXTURE_TICK_MS);
        if (sampling) {
          const at = performance.now() - phaseStarted;
          const aged = await ageBookings(packages, tenantDb, tenants).catch(fixtureFailed);
          const retried = await deferredToRetries(packages, tenantDb, tenants, connections).catch(
            fixtureFailed,
          );
          context.aged += aged;
          context.retried += retried;
          // When a fixture first made work due for each booking-critical queue (EXPECT_JOBS_AFTER_MS).
          context.workDueAt["ota-bookings"] ??= aged > 0 ? at : undefined;
          context.workDueAt["ota-ticketing"] ??= retried > 0 ? at : undefined;
        }
      }
    })();
    const records = [];
    const plan = planOf(options, context, tenants, sessions);
    const { outcomes, skipped, unfinished, maxStartLateMs } = await runPlan(context, plan, {
      maxInFlight: options.maxInFlight,
      record: (r) => records.push(r),
    });
    throwIfInterrupted();
    const phaseMs = performance.now() - phaseStarted;
    samples.push(await takeSample({ api, worker, monitor, redis, workerReadyUrl, startedAt: phaseStarted }));
    sampling = false;
    interruption.signal.aborted || (await Promise.all([sampler, ageing]).catch(() => undefined));
    const [amadeusFigures, mailFigures, apiEnd, workerEnd] = await Promise.all([
      amadeus.stats(),
      mail.stats(),
      api.stats(),
      worker.stats(),
    ]);
    runInfo.loadAverage.end = loadAverage();
    runInfo.postgres = (await monitor.query("SHOW server_version")).rows[0]?.server_version ?? "unknown";
    runInfo.redis = redisVersion;
    if (workerEnd.jobs !== undefined) {
      workerEnd.jobs.startedAtEpoch = startedAtEpoch;
    }
    const redisEnd = infoOf(await redis.info("memory"));
    const redisKinds = await redisBreakdown(redis);
    const figures = figuresOf({
      options,
      tenants,
      phaseMs,
      context,
      visits: { records, outcomes },
      amadeus: amadeusFigures,
      mail: mailFigures,
      apiStart,
      apiEnd,
      workerStart,
      workerEnd,
      samples,
      database: { start: databaseStart, end: await databaseFigures(packages, monitor, tenantDb, tenants) },
      storage: folderSize(join(runDir, "storage")),
      redisStart,
      redisEnd,
      redisKinds,
      maxConnections,
      skipped,
      unfinished,
      maxStartLateMs,
    });
    out(report(runInfo, figures));
    if (options.json !== undefined) {
      const file = resolve(options.json);
      const attempts = records.map(({ operation, tenant, status, code, attempt, at, ms }) => ({
        operation,
        tenant,
        status,
        code,
        attempt,
        at: round1(at),
        ms: round1(ms),
      }));
      writeFileSync(
        file,
        `${JSON.stringify({ run: runInfo, ...figures, samples, records: attempts }, null, 2)}\n`,
      );
      out(`booking-load: figures written to ${file}\n`);
    }
    const { verdict } = figures;
    return figures.unexpected.length === 0 &&
      verdict.apiWithinMemoryMax &&
      verdict.workerWithinMemoryMax &&
      verdict.bookingCriticalQueuesWithinBudget
      ? 0
      : 1;
  } catch (error) {
    if (interruption.signal.aborted) {
      return 130;
    }
    err(`booking-load: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await cleanup();
    if (interruption.signal.aborted) {
      err("booking-load: cleaned up\n");
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
      err(`booking-load: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  if (options.role === AMADEUS_ROLE) {
    await serveAmadeus(options, { scenarioOf: createOrderScenario });
    return undefined;
  }
  if (options.role === MAIL_ROLE) {
    serveMail();
    return undefined;
  }
  return await run(options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT) {
  const code = await main();
  if (code !== undefined) {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 5_000).unref();
  }
}
