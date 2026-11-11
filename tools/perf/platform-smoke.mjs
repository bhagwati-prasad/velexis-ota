#!/usr/bin/env node
// platform-smoke.mjs: the M6 performance smoke test of the platform API (PBE-063). How to run it is in README.md next to
// this file; the recorded runs and what was decided from them are in platform/docs/performance.md.
//
//   node tools/perf/platform-smoke.mjs --base http://127.0.0.1:3100
//
// Plain Node 22: `fetch`, a small concurrency limiter and the standard library. No dependency, no workspace package,
// no database connection: it talks to a RUNNING platform API (a production build, `node dist/main.js`, with its worker)
// as the portal and Caddy do, and reads the RSS of both processes from /proc. Point it only at a scratch stack (README
// "Run it"): it signs up accounts and creates OTAs on the API it is given.
//
// One run:
//   1. Set-up (not measured). It checks `GET /health/ready`, finds the processes that listen on the API's port and on
//      the worker's health port (--worker-port, 3101) and starts sampling their RSS once a second. Then it makes
//      --accounts portal accounts through the public operations, four at a time: `signUp`, the verification link from
//      the e-mail the worker sends to Mailpit (MAILPIT_API_URL or --mailpit), `verifyEmail`, `signIn` and `createTenant`
//      (one OTA each, `provisioning`). Every account has its own end-user IP in 198.18.0.0/15 (RFC 2544, never routed),
//      sent as `X-Velexis-End-User-IP` with the BFF key (PLATFORM_BFF_KEY from the environment), as the portal sends it
//      (PADR-0019), so no per-IP limit of api-inventory §2 answers.
//   2. Six measured phases, one after the other, each --duration seconds (60) after --warmup seconds (5) of the same
//      traffic that is not counted. Requests start at a fixed rate (open loop); at most --concurrency (50) are in
//      flight, and a start more than 50 ms after its planned time counts as late. A phase that starts more than 1 % of
//      its requests late did not keep its rate, so it cannot count as met.
//        signIn            10/s   a sign-in of the accounts in turn (Argon2id), each with an end-user IP of its own
//        getTenant         50/s   an account reads its OTA
//        listApiKeys       50/s   an account lists its OTA's API keys
//        tlsAsk cached    100/s   Caddy's `GET /internal/tls/ask` for the OTAs' sub-domains (Redis, `200`) and for as
//                                 many unknown sub-domains (the in-process LRU, `404`), each asked again and again
//        tlsAsk uncached  100/s   `ask` for a sub-domain never asked before: one PostgreSQL lookup each (`404`)
//        createTenant       1/s   an account creates one more OTA (`Idempotency-Key`), up to MAX_TENANTS_PER_ACCOUNT
//      --rate-scale x runs every phase at x times its rate, to see the headroom above the plan's rates.
//      --accounts defaults to what keeps every account under the `authenticated` limit (300 per account per minute)
//      and under --max-tenants-per-account (3, the API's MAX_TENANTS_PER_ACCOUNT) for the run's createTenant calls.
//   3. The report: per phase the requests sent, the rate reached, the expected answers, the errors by status and code,
//      p50, p95, p99 and the slowest answer of the expected answers (client side, from sending to the last byte), the
//      p95 target and whether it was met, the CPU seconds the API and the worker used, and the load average at the
//      phase's start and end; then the RSS of the API and the worker (after start-up, peak, end, VmHWM) against their
//      MemoryMax budgets (768 MiB and 512 MiB, docs/mvp/architecture.md §3). --json <file> writes the same as JSON.
//
// Targets (PBE-063): p95 below 300 ms for the reads (getTenant, listApiKeys, an uncached ask), below 800 ms for signIn
// (Argon2id), below 20 ms for a cached ask; RSS within the budgets. createTenant is reported without a target.
//
// Exit codes: 0 every answer was expected, every phase kept its rate, every target met and both processes measured and
// within their budgets; 1 an unexpected answer, a missed target, a phase that did not keep its rate, a process over its
// budget or not measured, or a set-up that failed; 2 a usage error; 130 interrupted (the report shows what was measured
// until then). Nothing it prints or writes carries a password, a token, the BFF key or a request or response body:
// errors are the operation, the HTTP status and the error code.
import { execFileSync } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The measured phases of PBE-063 step 1, in order: the rate each runs at and its p95 target. */
const PHASES = Object.freeze([
  { id: "signIn", label: "signIn", rate: 10, targetP95Ms: 800 },
  { id: "getTenant", label: "getTenant", rate: 50, targetP95Ms: 300 },
  { id: "listApiKeys", label: "listApiKeys", rate: 50, targetP95Ms: 300 },
  { id: "tlsAskCached", label: "tlsAsk cached", rate: 100, targetP95Ms: 20 },
  { id: "tlsAskUncached", label: "tlsAsk uncached", rate: 100, targetP95Ms: 300 },
  { id: "createTenant", label: "createTenant", rate: 1, targetP95Ms: undefined },
]);
const PHASE_IDS = PHASES.map((phase) => phase.id);
/** The MemoryMax of each unit (deploy/systemd, docs/mvp/architecture.md §3), in MiB. */
const RSS_BUDGET_MIB = Object.freeze({ api: 768, worker: 512 });
/** The `authenticated` limit of api-inventory §2: 300 requests per account per fixed 60-second window. */
const ACCOUNT_LIMIT_PER_MINUTE = 300;
/** The share of that limit a run may use, so the set-up's calls and a window spanning two phases stay below it. */
const ACCOUNT_LIMIT_USE = 0.8;
/** Accounts the set-up makes at the same time. */
const SETUP_CONCURRENCY = 4;
/** A portal access token lives 15 minutes (ACCESS_TOKEN_TTL_SECONDS of platform/backend/src/auth/token.service.ts). */
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
/**
 * Before a phase, an account signs in again unless its token outlives the phase by this much (the sign-ins of the
 * refresh run one after the other, so the first tokens age while the last are made).
 */
const TOKEN_MARGIN_MS = 60 * 1000;
/** The longest --duration and --warmup: a fresh token must outlive a whole phase (11 of its 15 minutes at most). */
const MAX_DURATION_S = 600;
const MAX_WARMUP_S = 60;
const REQUEST_TIMEOUT_MS = 10_000;
const MAIL_TIMEOUT_MS = 30_000;
const MAIL_POLL_MS = 200;
const RSS_SAMPLE_MS = 1000;
/** A start this much after its planned time counts as late (the limiter was full or the event loop busy). */
const LATE_START_MS = 50;
/**
 * The share of a phase's requests that may start late. Above it the phase did not keep its rate: the latencies are
 * then those of a lower rate (a request waiting for a free slot is not timed), so the phase cannot count as met.
 */
const LATE_START_SHARE = 0.01;
/** The terms version the set-up accepts at sign-up (the sign-up page's, as tools/e2e/support/fixtures.ts sends it). */
const TERMS_VERSION = "2026-10-01";
/** The OTA the set-up and createTenant create: values of the reference data, as the portal's wizard sends them. */
const TENANT_DEFAULTS = Object.freeze({ countryCode: "NO", defaultCurrency: "EUR", timeZone: "Europe/Oslo" });
const USER_AGENT = "velexis-platform-smoke";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const USAGE = `Usage: node tools/perf/platform-smoke.mjs [options]

Measures the platform API at --base (a production build with its worker, on this machine) and prints the table of
PBE-063: p50, p95 and errors per operation, CPU, load average and the RSS of the API and the worker.
It signs up accounts and creates OTAs: point it only at a scratch stack (tools/perf/README.md).

Options:
  --base <url>                     The API (loopback only). Default http://127.0.0.1:3100
  --duration <seconds>             Measured seconds of each phase (at most ${MAX_DURATION_S}). Default 60
  --warmup <seconds>               Seconds of the same traffic before each phase, not counted (at most ${MAX_WARMUP_S}).
                                   Default 5
  --phases <list>                  Comma-separated subset of ${PHASE_IDS.join(",")}. Default all
  --accounts <n>                   Portal accounts of the set-up. Default: what the rates and limits need
  --max-tenants-per-account <n>    The API's MAX_TENANTS_PER_ACCOUNT. Default 3
  --concurrency <n>                Requests in flight at most. Default 50
  --rate-scale <x>                 Every phase at x times its rate (0.1 to 20), for headroom. Default 1
  --worker-port <port>             The worker's health port, to find its process. Default 3101
  --api-pid <pid>, --worker-pid <pid>   The processes to sample, instead of finding them by port
  --mailpit <url>                  Mailpit's API. Default MAILPIT_API_URL or http://127.0.0.1:8025
  --json <file>                    Also write the figures as JSON
  --help                           This text

Environment: PLATFORM_BFF_KEY (required), the API's value; it is never printed.
Exit codes: 0 all targets met, 1 an error, a missed target, a rate not kept, an RSS over budget or not measured, or a
set-up failure, 2 usage, 130 interrupted.`;

class UsageError extends Error {}

// ---- Options --------------------------------------------------------------------------------------------------

function positiveInt(name, value, { min = 1, max = 1_000_000 } = {}) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new UsageError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return Number(value);
}

function decimal(name, value, { min, max }) {
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new UsageError(`${name} must be a number from ${min} to ${max}`);
  }
  return Number(value);
}

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        base: { type: "string", default: "http://127.0.0.1:3100" },
        duration: { type: "string", default: "60" },
        warmup: { type: "string", default: "5" },
        phases: { type: "string", default: PHASE_IDS.join(",") },
        accounts: { type: "string" },
        "max-tenants-per-account": { type: "string", default: "3" },
        concurrency: { type: "string", default: "50" },
        "rate-scale": { type: "string", default: "1" },
        "worker-port": { type: "string", default: "3101" },
        "api-pid": { type: "string" },
        "worker-pid": { type: "string" },
        mailpit: { type: "string", default: process.env.MAILPIT_API_URL || "http://127.0.0.1:8025" },
        json: { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const values = parsed.values;
  if (values.help) {
    return { help: true };
  }
  let base;
  try {
    base = new URL(values.base);
  } catch {
    throw new UsageError("--base must be a URL such as http://127.0.0.1:3100");
  }
  if (base.protocol !== "http:" || !LOOPBACK_HOSTS.has(base.hostname) || base.pathname !== "/") {
    throw new UsageError(
      "--base must be http://<loopback>:<port> without a path: `ask` answers loopback callers only and the RSS is " +
        "read from /proc, so the test runs on the API's machine",
    );
  }
  let mailpit;
  try {
    mailpit = new URL(values.mailpit);
  } catch {
    throw new UsageError("--mailpit must be a URL such as http://127.0.0.1:8025");
  }
  const phases = values.phases.split(",").map((id) => id.trim());
  for (const id of phases) {
    if (!PHASE_IDS.includes(id)) {
      throw new UsageError(`--phases: unknown phase "${id}" (known: ${PHASE_IDS.join(", ")})`);
    }
  }
  const options = {
    help: false,
    base: base.origin,
    durationS: positiveInt("--duration", values.duration, { max: MAX_DURATION_S }),
    warmupS: positiveInt("--warmup", values.warmup, { min: 0, max: MAX_WARMUP_S }),
    rateScale: decimal("--rate-scale", values["rate-scale"], { min: 0.1, max: 20 }),
    maxTenantsPerAccount: positiveInt("--max-tenants-per-account", values["max-tenants-per-account"], {
      min: 2,
    }),
    concurrency: positiveInt("--concurrency", values.concurrency, { max: 1000 }),
    workerPort: positiveInt("--worker-port", values["worker-port"], { max: 65535 }),
    apiPid: values["api-pid"] === undefined ? undefined : positiveInt("--api-pid", values["api-pid"]),
    workerPid:
      values["worker-pid"] === undefined ? undefined : positiveInt("--worker-pid", values["worker-pid"]),
    mailpit: mailpit.origin,
    json: values.json,
  };
  // Each phase at its plan rate times --rate-scale.
  options.phases = PHASES.filter((phase) => phases.includes(phase.id)).map((phase) => ({
    ...phase,
    rate: round(phase.rate * options.rateScale, 2),
  }));
  const needed = accountsNeeded(options);
  options.accounts = values.accounts === undefined ? needed : positiveInt("--accounts", values.accounts);
  if (options.accounts < needed) {
    throw new UsageError(
      `--accounts ${options.accounts} is too few for these phases: ${needed} keep every account under the ` +
        `authenticated limit and under --max-tenants-per-account`,
    );
  }
  const key = process.env.PLATFORM_BFF_KEY;
  if (key === undefined || key.trim() === "") {
    throw new UsageError("PLATFORM_BFF_KEY must be set to the API's value (it is never printed)");
  }
  options.bffKey = key;
  return options;
}

/**
 * The accounts a run needs: the read phases spread their calls so that one 60-second window of an account holds at
 * most ACCOUNT_LIMIT_USE of the `authenticated` limit (a window can span the end of one phase and the start of the
 * next, but never more than 60 seconds of traffic), and the createTenant phase needs room for one more OTA per call
 * next to the one each account owns from the set-up.
 */
function accountsNeeded(options) {
  const accountPhases = options.phases.filter((phase) =>
    ["getTenant", "listApiKeys", "createTenant"].includes(phase.id),
  );
  const accountRate = Math.max(0, ...accountPhases.map((phase) => phase.rate));
  const windowS = Math.min(60, 2 * (options.durationS + options.warmupS));
  let needed = Math.max(
    2,
    Math.ceil((accountRate * windowS) / (ACCOUNT_LIMIT_PER_MINUTE * ACCOUNT_LIMIT_USE)),
  );
  const create = options.phases.find((phase) => phase.id === "createTenant");
  if (create !== undefined) {
    needed = Math.max(needed, Math.ceil(phaseRequests(create, options) / (options.maxTenantsPerAccount - 1)));
  }
  return needed;
}

/** The requests of a phase with its warm-up. */
function phaseRequests(phase, options) {
  return Math.round(phase.rate * options.warmupS) + Math.round(phase.rate * options.durationS);
}

// ---- Figures --------------------------------------------------------------------------------------------------

/** Nearest-rank percentile of sorted numbers, or undefined for none. */
function percentile(sorted, p) {
  if (sorted.length === 0) {
    return undefined;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function round(value, digits = 1) {
  return value === undefined ? undefined : Number(value.toFixed(digits));
}

function fmt(value, digits = 1) {
  return value === undefined ? "—" : value.toFixed(digits);
}

function loadAverage() {
  return os.loadavg().map((value) => round(value, 2));
}

/** A fixed-width table: text columns left-aligned, the others right-aligned. */
function table(headers, rows, leftColumns = 1) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) =>
        index < leftColumns ? String(cell).padEnd(widths[index]) : String(cell).padStart(widths[index]),
      )
      .join("  ")
      .trimEnd();
  return [line(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)].join("\n");
}

// ---- Processes ----------------------------------------------------------------------------------------------------

/** The socket inodes that listen on `port` (TCP state 0A), from /proc/net/tcp and tcp6. */
function listeningInodes(port) {
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) {
        continue;
      }
      const portHex = fields[1].split(":").pop();
      if (fields[3] === "0A" && Number.parseInt(portHex, 16) === port && fields[9] !== "0") {
        inodes.add(fields[9]);
      }
    }
  }
  return inodes;
}

/** The pid of the process that holds a socket listening on `port`, or undefined (none, or not visible to this user). */
function pidListeningOn(port) {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) {
    return undefined;
  }
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let fds;
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${entry}/fd/${fd}`));
        if (match !== null && inodes.has(match[1])) {
          return Number(entry);
        }
      } catch {
        // The descriptor closed meanwhile.
      }
    }
  }
  return undefined;
}

/** VmRSS and VmHWM of `pid` in MiB, or undefined when the process is gone. */
function memoryOf(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kib = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(status)?.[1]);
    return { rss: kib("VmRSS") / 1024, hwm: kib("VmHWM") / 1024 };
  } catch {
    return undefined;
  }
}

/** The clock ticks per second of /proc/<pid>/stat (`getconf CLK_TCK`, 100 on Linux). */
function clockTicks() {
  try {
    return Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
  } catch {
    return 100;
  }
}
const CLK_TCK = clockTicks();

/** User plus system CPU seconds `pid` has used, or undefined when the process is gone. */
function cpuSecondsOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / CLK_TCK;
  } catch {
    return undefined;
  }
}

/** Samples the RSS of the processes once a second; `mark()` starts a new window for a phase. */
class MemorySampler {
  constructor(targets) {
    this.targets = targets.filter((target) => target.pid !== undefined);
    this.state = new Map();
    for (const target of this.targets) {
      const memory = memoryOf(target.pid);
      this.state.set(target.name, {
        first: memory?.rss,
        peak: memory?.rss,
        last: memory?.rss,
        hwm: memory?.hwm,
        windowPeak: memory?.rss,
      });
    }
    this.timer = setInterval(() => this.sample(), RSS_SAMPLE_MS);
    this.timer.unref();
  }

  sample() {
    for (const target of this.targets) {
      const memory = memoryOf(target.pid);
      const state = this.state.get(target.name);
      if (memory === undefined || state === undefined) {
        continue;
      }
      state.last = memory.rss;
      state.hwm = memory.hwm;
      state.peak = Math.max(state.peak ?? 0, memory.rss);
      state.windowPeak = Math.max(state.windowPeak ?? 0, memory.rss);
    }
  }

  /** The RSS now and the peak since the last mark, per process; starts the next window. */
  mark() {
    this.sample();
    const figures = {};
    for (const [name, state] of this.state) {
      figures[name] = { now: round(state.last), peak: round(state.windowPeak) };
      state.windowPeak = state.last;
    }
    return figures;
  }

  stop() {
    clearInterval(this.timer);
    this.sample();
  }
}

// ---- HTTP -----------------------------------------------------------------------------------------------------

/** The error key of an answer: `<status> <code>`, or what kept it from arriving. Never a body. */
function errorKey(status, text) {
  let code;
  try {
    code = JSON.parse(text)?.error?.code;
  } catch {
    code = undefined;
  }
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? `${status} ${code}` : String(status);
}

function failureKey(error) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause !== null && typeof cause === "object" ? cause.code : undefined;
  return typeof code === "string" ? `network ${code}` : "network error";
}

/**
 * One request. Resolves (never rejects) to `{ status, ms, text }` or `{ failure, ms }`; `ms` runs from sending to the
 * last byte of the answer.
 */
async function send(url, init) {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    return { status: response.status, ms: performance.now() - started, text };
  } catch (error) {
    return { failure: failureKey(error), ms: performance.now() - started };
  }
}

/** The headers of a call the portal's server makes for the person at `ip` (PADR-0019). */
function portalHeaders(context, ip, accessToken) {
  const headers = {
    Accept: "application/json",
    "X-Velexis-Bff-Key": context.options.bffKey,
    "X-Velexis-End-User-IP": ip,
    "X-Velexis-End-User-Agent": USER_AGENT,
  };
  if (accessToken !== undefined) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

function portalCall(context, { method, path, ip, accessToken, body, headers = {} }) {
  return send(`${context.options.base}${path}`, {
    method,
    headers: {
      ...headers,
      ...portalHeaders(context, ip, accessToken),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * A body parsed as JSON. A body that is not JSON throws a message that names `what` and holds none of the body: V8's
 * own SyntaxError quotes the text, which may be a token or a verification link.
 */
function parseJson(what, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`set-up: ${what} answered a body that is not JSON`);
  }
}

/** A set-up step's answer as JSON; anything but `expected` throws, naming the step, the status and the code. */
function expectAnswer(step, result, expected) {
  if (result.failure !== undefined) {
    throw new Error(`set-up: ${step} failed (${result.failure})`);
  }
  if (result.status !== expected) {
    throw new Error(`set-up: ${step} answered ${errorKey(result.status, result.text)}, expected ${expected}`);
  }
  return result.text === "" ? undefined : parseJson(step, result.text);
}

// ---- Set-up ---------------------------------------------------------------------------------------------------

/** End-user IPs of the run in 198.18.0.0/15: index i is the i-th address after a random start, unique within a run. */
function ipPool() {
  const seed = randomInt(0, 1 << 17);
  let next = 0;
  return () => {
    const n = seed + next++;
    return `198.${18 + ((n >> 16) & 1)}.${(n >> 8) & 255}.${n & 255}`;
  };
}

/** The `token` of the verification link in the newest e-mail to `email`, waiting for the worker and SMTP. */
async function verificationToken(context, email) {
  const deadline = performance.now() + MAIL_TIMEOUT_MS;
  const query = new URLSearchParams({ query: `to:"${email}"`, limit: "5" });
  while (performance.now() < deadline) {
    const search = await send(`${context.options.mailpit}/api/v1/search?${query}`, {
      headers: { Accept: "application/json" },
    });
    if (search.status === 200) {
      const messages = parseJson("Mailpit's search", search.text)?.messages ?? [];
      const id = messages.find((message) =>
        (message.To ?? []).some((to) => String(to.Address).toLowerCase() === email),
      )?.ID;
      if (typeof id === "string") {
        const message = await send(`${context.options.mailpit}/api/v1/message/${encodeURIComponent(id)}`, {
          headers: { Accept: "application/json" },
        });
        const text =
          message.status === 200 ? String(parseJson("Mailpit's message", message.text)?.Text ?? "") : "";
        for (const match of text.matchAll(/https?:\/\/\S+/g)) {
          try {
            const url = new URL(match[0]);
            const token = url.searchParams.get("token");
            if (url.pathname === "/verify-email" && token !== null && token !== "") {
              return token;
            }
          } catch {
            // Not a URL.
          }
        }
        throw new Error(`set-up: the verification e-mail to ${email} has no /verify-email link`);
      }
    } else if (search.failure !== undefined || search.status >= 400) {
      throw new Error(
        `set-up: Mailpit at ${context.options.mailpit} answered ${search.failure ?? search.status}; is it running?`,
      );
    }
    await sleep(MAIL_POLL_MS);
  }
  throw new Error(
    `set-up: no verification e-mail to ${email} in Mailpit within ${MAIL_TIMEOUT_MS / 1000} s: is the platform ` +
      "worker running, and does the stack's SMTP_URL point at this Mailpit?",
  );
}

async function signIn(context, account, ip) {
  const result = await portalCall(context, {
    method: "POST",
    path: "/v1/auth/sign-in",
    ip,
    body: { email: account.email, password: account.password },
  });
  const session = expectAnswer("signIn", result, 200);
  if (typeof session?.accessToken !== "string") {
    throw new Error("set-up: signIn answered without a session (does the account have MFA?)");
  }
  account.accessToken = session.accessToken;
  account.signedInAt = performance.now();
}

function tenantRequest(key, name) {
  return { key, name, ...TENANT_DEFAULTS };
}

/** One account: sign-up, verification through Mailpit, sign-in and its first OTA. */
async function makeAccount(context, index) {
  const account = {
    index,
    email: `platform-smoke-${context.runId}-${index}@example.com`,
    // A letter and a digit whatever the random part is: the platform's password rule (12+ characters, ADR-0008).
    password: `Perf-${randomBytes(18).toString("base64url")}-7`,
    ip: context.nextIp(),
    tenants: 0,
  };
  expectAnswer(
    "signUp",
    await portalCall(context, {
      method: "POST",
      path: "/v1/auth/sign-up",
      ip: account.ip,
      body: {
        email: account.email,
        password: account.password,
        fullName: `Smoke Test ${index}`,
        acceptTerms: true,
        termsVersion: TERMS_VERSION,
      },
    }),
    202,
  );
  const token = await verificationToken(context, account.email);
  expectAnswer(
    "verifyEmail",
    await portalCall(context, {
      method: "POST",
      path: "/v1/auth/verify-email",
      ip: account.ip,
      body: { token },
    }),
    200,
  );
  await signIn(context, account, account.ip);
  const created = expectAnswer(
    "createTenant",
    await portalCall(context, {
      method: "POST",
      path: "/v1/tenants",
      ip: account.ip,
      accessToken: account.accessToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: tenantRequest(`ps${context.runId}${index}`, `Smoke OTA ${index}`),
    }),
    202,
  );
  account.tenantId = created.tenant.id;
  account.primaryHost = created.tenant.primaryHost;
  account.tenants = 1;
  return account;
}

async function setUp(context) {
  const started = performance.now();
  const accounts = new Array(context.options.accounts);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < accounts.length && !context.stopping && !failed) {
      const index = next++;
      try {
        accounts[index] = await makeAccount(context, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  // allSettled first, so no account is still being made when the first failure is reported.
  const outcomes = await Promise.allSettled(Array.from({ length: SETUP_CONCURRENCY }, worker));
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  if (rejected !== undefined) {
    throw rejected.reason;
  }
  if (context.stopping) {
    throw new Interrupted();
  }
  context.accounts = accounts;
  const first = accounts[0];
  context.baseDomain = first.primaryHost.slice(`ps${context.runId}${first.index}.`.length);
  return { accounts: accounts.length, seconds: round((performance.now() - started) / 1000) };
}

/**
 * Signs in again every account whose access token would not outlive the coming phase (its warm-up and measured
 * seconds) by TOKEN_MARGIN_MS, so no token expires while the phase uses it.
 */
async function refreshTokens(context) {
  const phaseMs = (context.options.warmupS + context.options.durationS) * 1000;
  const oldestAgeMs = ACCESS_TOKEN_TTL_MS - TOKEN_MARGIN_MS - phaseMs;
  for (const account of context.accounts) {
    if (performance.now() - account.signedInAt > oldestAgeMs) {
      await signIn(context, account, context.nextIp());
    }
  }
}

// ---- Phases ---------------------------------------------------------------------------------------------------

class Interrupted extends Error {}

/** At most `limit` tasks in flight: `slot()` waits until one more may start, `start()` starts it without waiting. */
class Limiter {
  constructor(limit) {
    this.limit = limit;
    this.inFlight = new Set();
  }

  async slot() {
    while (this.inFlight.size >= this.limit) {
      await Promise.race(this.inFlight);
    }
  }

  /** `task` must not reject (`send` never does). */
  start(task) {
    const promise = task().finally(() => this.inFlight.delete(promise));
    this.inFlight.add(promise);
  }

  async drain() {
    await Promise.all(this.inFlight);
  }
}

/**
 * Starts `count` requests at `rate` per second (request i is due at i / rate seconds) and hands every answer to
 * `record`. A start more than LATE_START_MS after its due time counts as late.
 */
async function drive(context, rate, count, makeRequest, record) {
  const limiter = new Limiter(context.options.concurrency);
  const intervalMs = 1000 / rate;
  const started = performance.now();
  let late = 0;
  let sent = 0;
  let lastStart = started;
  for (let index = 0; index < count && !context.stopping; index++) {
    const due = started + index * intervalMs;
    const wait = due - performance.now();
    if (wait > 1) {
      await sleep(wait);
    }
    await limiter.slot();
    if (performance.now() - due > LATE_START_MS) {
      late++;
    }
    sent++;
    lastStart = performance.now();
    const request = makeRequest(index);
    limiter.start(async () => record(request.expected, await request.answer));
  }
  await limiter.drain();
  // The rate reached: the starts over the time they took, counting the last one's interval as the plan does.
  const startsS = sent === 0 ? undefined : (lastStart - started) / 1000 + 1 / rate;
  return { sent, late, rateReached: startsS === undefined ? undefined : sent / startsS };
}

/** The request maker of each phase: `{ expected, answer }`, where `answer` is the pending `send`. */
function requestMaker(context, phase) {
  const accounts = context.accounts;
  const api = context.options.base;
  switch (phase.id) {
    case "signIn":
      return (index) => {
        const account = accounts[index % accounts.length];
        return {
          expected: 200,
          answer: portalCall(context, {
            method: "POST",
            path: "/v1/auth/sign-in",
            ip: context.nextIp(),
            body: { email: account.email, password: account.password },
          }),
        };
      };
    case "getTenant":
    case "listApiKeys":
      return (index) => {
        const account = accounts[index % accounts.length];
        const suffix = phase.id === "listApiKeys" ? "/api-keys" : "";
        return {
          expected: 200,
          answer: portalCall(context, {
            method: "GET",
            path: `/v1/tenants/${encodeURIComponent(account.tenantId)}${suffix}`,
            ip: account.ip,
            accessToken: account.accessToken,
          }),
        };
      };
    case "tlsAskCached":
      return (index) => {
        const slot = index % (2 * accounts.length);
        const allowed = slot < accounts.length;
        const host = allowed
          ? accounts[slot].primaryHost
          : `nx${context.runId}${slot - accounts.length}.${context.baseDomain}`;
        return { expected: allowed ? 200 : 404, answer: ask(api, host) };
      };
    case "tlsAskUncached":
      return () => ({
        expected: 404,
        answer: ask(api, `nu${context.runId}${context.uncachedHosts++}.${context.baseDomain}`),
      });
    case "createTenant":
      return () => {
        const number = context.createdTenants++;
        const account = accounts.find(
          (candidate) => candidate.tenants < context.options.maxTenantsPerAccount,
        );
        if (account === undefined) {
          throw new Error("every account owns MAX_TENANTS_PER_ACCOUNT OTAs; raise --accounts");
        }
        account.tenants++;
        return {
          expected: 202,
          answer: portalCall(context, {
            method: "POST",
            path: "/v1/tenants",
            ip: account.ip,
            accessToken: account.accessToken,
            headers: { "Idempotency-Key": randomUUID() },
            body: tenantRequest(`pc${context.runId}${number}`, `Smoke OTA c${number}`),
          }),
        };
      };
    default:
      throw new Error(`no request maker for ${phase.id}`);
  }
}

/** Caddy's on-demand TLS question: loopback, no X-Forwarded-For, no other header. */
function ask(api, host) {
  return send(`${api}/internal/tls/ask?domain=${encodeURIComponent(host)}`, { method: "GET" });
}

async function runPhase(context, phase) {
  if (["getTenant", "listApiKeys", "createTenant"].includes(phase.id)) {
    await refreshTokens(context);
  }
  const makeRequest = requestMaker(context, phase);
  const { options } = context;
  if (options.warmupS > 0) {
    await drive(context, phase.rate, Math.round(phase.rate * options.warmupS), makeRequest, () => undefined);
  }
  const latencies = [];
  const errors = {};
  let expectedAnswers = 0;
  const record = (expected, answer) => {
    if (answer.failure === undefined && answer.status === expected) {
      expectedAnswers++;
      latencies.push(answer.ms);
      return;
    }
    const key = answer.failure ?? errorKey(answer.status, answer.text);
    errors[key] = (errors[key] ?? 0) + 1;
  };
  const loadStart = loadAverage();
  const cpuStart = cpuOf(context);
  context.sampler?.mark();
  const driven = await drive(
    context,
    phase.rate,
    Math.round(phase.rate * options.durationS),
    makeRequest,
    record,
  );
  const memory = context.sampler?.mark() ?? {};
  const cpuEnd = cpuOf(context);
  const loadEnd = loadAverage();
  latencies.sort((a, b) => a - b);
  const p95 = percentile(latencies, 95);
  const errorCount = Object.values(errors).reduce((sum, count) => sum + count, 0);
  const cpu = {};
  for (const name of Object.keys(cpuStart)) {
    if (cpuStart[name] !== undefined && cpuEnd[name] !== undefined) {
      cpu[name] = round(cpuEnd[name] - cpuStart[name], 2);
    }
  }
  return {
    id: phase.id,
    label: phase.label,
    rate: phase.rate,
    seconds: options.durationS,
    sent: driven.sent,
    rateReached: round(driven.rateReached, 1),
    lateStarts: driven.late,
    rateKept: driven.late <= Math.floor(driven.sent * LATE_START_SHARE),
    expected: expectedAnswers,
    errors,
    errorCount,
    p50Ms: round(percentile(latencies, 50)),
    p95Ms: round(p95),
    p99Ms: round(percentile(latencies, 99)),
    maxMs: round(latencies.at(-1)),
    meanMs: round(
      latencies.length === 0 ? undefined : latencies.reduce((a, b) => a + b, 0) / latencies.length,
    ),
    targetP95Ms: phase.targetP95Ms,
    targetMet: phase.targetP95Ms === undefined ? undefined : p95 !== undefined && p95 < phase.targetP95Ms,
    cpuSeconds: cpu,
    loadAverage: { start: loadStart, end: loadEnd },
    rssMiB: memory,
  };
}

function cpuOf(context) {
  const figures = {};
  for (const target of context.processes) {
    figures[target.name] = target.pid === undefined ? undefined : cpuSecondsOf(target.pid);
  }
  return figures;
}

// ---- Report ---------------------------------------------------------------------------------------------------

function loadText(load) {
  return load === undefined ? "—" : load.map((value) => fmt(value, 2)).join(", ");
}

/** `met`, `no target`, or what went wrong: `MISSED`, `errors`, `rate not kept`. */
function phaseVerdict(result) {
  const problems = [];
  if (result.targetMet === false) {
    problems.push("MISSED");
  }
  if (result.errorCount > 0) {
    problems.push("errors");
  }
  if (!result.rateKept) {
    problems.push("rate not kept");
  }
  if (problems.length > 0) {
    return problems.join(", ");
  }
  return result.targetMet === undefined ? "no target" : "met";
}

/** Why a finished run is not a pass, one short line each; empty when every target was met. */
function problemsOf(run) {
  const problems = [];
  for (const result of run.phases) {
    if (result.targetMet === false) {
      problems.push(`${result.label} p95 ${fmt(result.p95Ms)} ms is not below ${result.targetP95Ms} ms`);
    }
    if (result.errorCount > 0) {
      problems.push(`${result.label} had ${result.errorCount} unexpected answers`);
    }
    if (!result.rateKept) {
      problems.push(`${result.label} started ${result.lateStarts} of ${result.sent} requests late`);
    }
  }
  for (const process_ of run.processes) {
    if (process_.withinBudget === false) {
      problems.push(`the ${process_.name}'s RSS went over ${process_.budgetMiB} MiB`);
    } else if (process_.withinBudget === undefined) {
      problems.push(`the ${process_.name}'s RSS was not measured`);
    }
  }
  return problems;
}

function report(context, run) {
  const lines = [];
  const { options } = context;
  lines.push(
    `Platform API smoke test (PBE-063): ${options.base}, started ${run.startedAt}`,
    `Machine: nproc ${run.machine.nproc}, ${run.machine.cpu}, ${run.machine.memoryGiB} GiB RAM, Node ` +
      `${run.machine.node}, script ${run.commit}`,
    `Options: --duration ${options.durationS} --warmup ${options.warmupS} --accounts ${options.accounts} ` +
      `--concurrency ${options.concurrency} --rate-scale ${options.rateScale} --phases ${options.phases.map((phase) => phase.id).join(",")}`,
    `Load average (1, 5, 15 min) at start: ${loadText(run.loadAverage.start)}; at end: ` +
      `${loadText(run.loadAverage.end)} (nproc ${run.machine.nproc})`,
  );
  if (run.setup !== undefined) {
    lines.push(
      `Set-up: ${run.setup.accounts} accounts signed up, verified through Mailpit and signed in, one OTA each ` +
        `(provisioning), in ${run.setup.seconds} s`,
    );
  }
  lines.push("");
  const rows = run.phases.map((result) => [
    result.label,
    result.rate,
    result.sent,
    fmt(result.rateReached),
    result.expected,
    result.errorCount,
    fmt(result.p50Ms),
    fmt(result.p95Ms),
    fmt(result.p99Ms),
    fmt(result.maxMs),
    result.targetP95Ms === undefined ? "—" : `< ${result.targetP95Ms}`,
    phaseVerdict(result),
    fmt(result.cpuSeconds.api, 1),
    fmt(result.cpuSeconds.worker, 1),
    `${fmt(result.loadAverage.start[0], 2)} → ${fmt(result.loadAverage.end[0], 2)}`,
  ]);
  lines.push(
    table(
      [
        "Operation",
        "Rate/s",
        "Sent",
        "Reached/s",
        "Expected",
        "Errors",
        "p50 ms",
        "p95 ms",
        "p99 ms",
        "Max ms",
        "p95 target",
        "Result",
        "API CPU s",
        "Worker CPU s",
        "Load 1m",
      ],
      rows,
    ),
  );
  const errorRows = run.phases.flatMap((result) =>
    Object.entries(result.errors).map(([key, count]) => [result.label, key, count]),
  );
  if (errorRows.length > 0) {
    lines.push("", "Errors (status and code, or what kept the answer from arriving):", "");
    lines.push(table(["Operation", "Answer", "Count"], errorRows, 2));
  }
  const late = run.phases.filter((result) => result.lateStarts > 0);
  if (late.length > 0) {
    lines.push(
      "",
      `Late starts (more than ${LATE_START_MS} ms after their planned time): ` +
        late.map((result) => `${result.label} ${result.lateStarts}`).join(", "),
    );
  }
  lines.push("");
  const memoryRows = run.processes.map((process) => [
    process.name,
    process.pid ?? "not found",
    fmt(process.rssMiB.first, 0),
    fmt(process.rssMiB.peak, 0),
    fmt(process.rssMiB.last, 0),
    fmt(process.rssMiB.hwm, 0),
    process.budgetMiB,
    process.withinBudget === undefined ? "not measured" : process.withinBudget ? "within" : "OVER",
  ]);
  lines.push(
    table(["Process (RSS MiB)", "PID", "Start", "Peak", "End", "VmHWM", "Budget", "Result"], memoryRows, 2),
  );
  const perPhase = run.phases.map((result) => [
    result.label,
    ...run.processes.map((process) => {
      const figures = result.rssMiB[process.name];
      return figures === undefined ? "—" : `${fmt(figures.now, 0)} (${fmt(figures.peak, 0)})`;
    }),
  ]);
  if (run.processes.some((process) => process.pid !== undefined) && perPhase.length > 0) {
    lines.push(
      "",
      table(["RSS MiB at phase end (peak)", ...run.processes.map((process) => process.name)], perPhase),
    );
  }
  lines.push("", `Result: ${run.result}`);
  return lines.join("\n");
}

function machine() {
  const cpus = os.cpus();
  return {
    nproc: os.availableParallelism(),
    cpu: `${cpus[0]?.model.trim() ?? "unknown CPU"}`,
    memoryGiB: round(os.totalmem() / 1024 ** 3),
    node: process.version,
    kernel: `${os.type()} ${os.release()}`,
  };
}

function commitOfScript() {
  try {
    const cwd = new URL(".", import.meta.url).pathname;
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd, encoding: "utf8" }).trim();
    return dirty === "" ? sha : `${sha}+changes`;
  } catch {
    return "unknown";
  }
}

// ---- Main -----------------------------------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`platform-smoke: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const context = {
    options,
    runId: randomBytes(3).toString("hex"),
    nextIp: ipPool(),
    stopping: false,
    uncachedHosts: 0,
    createdTenants: 0,
    accounts: [],
    processes: [],
  };
  let signals = 0;
  const onSignal = () => {
    signals++;
    if (signals > 1) {
      process.exit(130);
    }
    context.stopping = true;
    process.stderr.write(
      "platform-smoke: stopping after the requests in flight (a second signal stops at once)\n",
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const run = {
    startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    machine: machine(),
    commit: commitOfScript(),
    loadAverage: { start: loadAverage() },
    phases: [],
    processes: [],
    interrupted: false,
  };
  let failure;
  try {
    const health = await send(`${options.base}/health/ready`, { headers: { Accept: "application/json" } });
    if (health.status !== 200) {
      throw new Error(
        `GET ${options.base}/health/ready answered ${health.failure ?? health.status}: start the API and its ` +
          "worker first (tools/perf/README.md)",
      );
    }
    const apiPort = Number(new URL(options.base).port || 80);
    context.processes = [
      { name: "api", pid: options.apiPid ?? pidListeningOn(apiPort), budgetMiB: RSS_BUDGET_MIB.api },
      {
        name: "worker",
        pid: options.workerPid ?? pidListeningOn(options.workerPort),
        budgetMiB: RSS_BUDGET_MIB.worker,
      },
    ];
    for (const process_ of context.processes) {
      if (process_.pid === undefined) {
        process.stderr.write(
          `platform-smoke: no visible process listens on the ${process_.name}'s port; its RSS and CPU are not ` +
            `measured (give --${process_.name}-pid)\n`,
        );
      }
    }
    context.sampler = new MemorySampler(context.processes);
    process.stderr.write(`platform-smoke: set-up of ${options.accounts} accounts…\n`);
    run.setup = await setUp(context);
    for (const phase of options.phases) {
      if (context.stopping) {
        break;
      }
      process.stderr.write(
        `platform-smoke: ${phase.label} at ${phase.rate}/s for ${options.warmupS} + ${options.durationS} s…\n`,
      );
      run.phases.push(await runPhase(context, phase));
    }
  } catch (error) {
    if (!(error instanceof Interrupted)) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  context.sampler?.stop();
  run.interrupted = context.stopping;
  run.loadAverage.end = loadAverage();
  run.processes = context.processes.map((process_) => {
    const state = context.sampler?.state.get(process_.name);
    const rssMiB = {
      first: round(state?.first),
      peak: round(state?.peak),
      last: round(state?.last),
      hwm: round(state?.hwm),
    };
    const peak = Math.max(rssMiB.peak ?? 0, rssMiB.hwm ?? 0);
    return {
      name: process_.name,
      pid: process_.pid,
      budgetMiB: process_.budgetMiB,
      rssMiB,
      withinBudget: state?.first === undefined ? undefined : peak <= process_.budgetMiB,
    };
  });
  const problems = problemsOf(run);
  if (failure !== undefined) {
    run.result = `failed: ${failure}`;
  } else if (run.interrupted) {
    run.result = `interrupted after ${run.phases.length} of ${options.phases.length} phases`;
  } else {
    run.result = problems.length > 0 ? `not met: ${problems.join("; ")}` : "every target met";
  }
  process.stdout.write(`${report(context, run)}\n`);
  if (options.json !== undefined) {
    writeFileSync(
      options.json,
      `${JSON.stringify({ ...run, base: options.base, options: publicOptions(options) }, null, 2)}\n`,
    );
  }
  if (run.interrupted) {
    return 130;
  }
  return failure !== undefined || problems.length > 0 ? 1 : 0;
}

/** The options as the JSON report keeps them: never the BFF key. */
function publicOptions(options) {
  return {
    durationS: options.durationS,
    warmupS: options.warmupS,
    phases: options.phases.map((phase) => phase.id),
    accounts: options.accounts,
    maxTenantsPerAccount: options.maxTenantsPerAccount,
    concurrency: options.concurrency,
    rateScale: options.rateScale,
    workerPort: options.workerPort,
  };
}

// The pure helpers, for the unit tests next to this file (platform-smoke.test.mjs, lead decision (13c) of 2026-11-10).
export {
  PHASES,
  UsageError,
  accountsNeeded,
  decimal,
  errorKey,
  failureKey,
  fmt,
  loadText,
  parseOptions,
  percentile,
  phaseRequests,
  phaseVerdict,
  positiveInt,
  problemsOf,
  publicOptions,
  round,
  table,
};

// Run only as a program (`node tools/perf/platform-smoke.mjs ...`), never when a test imports the helpers above.
if (isProgram()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`platform-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

/** True when Node runs this file itself: it is the script Node was started with (symbolic links resolved). */
function isProgram() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
