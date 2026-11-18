// Unit tests of the pure helpers of platform-smoke.mjs (PBE-063): the options, the account count, the percentiles, the
// error keys and the verdicts; since PBE-076 also the garbage-collection preload gc-observer.cjs, run in child
// processes that allocate, and the report's reading of its lines. Lead decision (13c) of 2026-11-10, approved by the
// owner: CI's build-test job runs them with the tools/ci tests. Run: node --test tools/perf/*.test.mjs (plain Node, the
// `.nvmrc` major; no install, no running API).
//
// Importing the script runs nothing: it starts its measurement only when Node runs the file itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PHASES,
  UsageError,
  accountsNeeded,
  decimal,
  errorKey,
  failureKey,
  fmt,
  gcFigures,
  gcObserverLines,
  gcOfProcess,
  gcVerdict,
  loadText,
  nodeOptionsOf,
  parseOptions,
  percentile,
  phaseRequests,
  phaseVerdict,
  positiveInt,
  problemsOf,
  publicOptions,
  round,
  rssVerdict,
  table,
} from "./platform-smoke.mjs";

const GC_OBSERVER = fileURLToPath(new URL("./gc-observer.cjs", import.meta.url));

const BFF_KEY = "test-bff-key-of-the-unit-tests";
let savedKey;
beforeEach(() => {
  savedKey = process.env.PLATFORM_BFF_KEY;
  process.env.PLATFORM_BFF_KEY = BFF_KEY;
});
afterEach(() => {
  if (savedKey === undefined) {
    delete process.env.PLATFORM_BFF_KEY;
  } else {
    process.env.PLATFORM_BFF_KEY = savedKey;
  }
});

/** A phase result as runPhase reports it, with every check passing unless overridden. */
const result = (overrides = {}) => ({
  label: "getTenant",
  targetP95Ms: 300,
  p95Ms: 12.3,
  targetMet: true,
  errorCount: 0,
  rateKept: true,
  lateStarts: 0,
  sent: 3000,
  ...overrides,
});

describe("percentile (nearest rank)", () => {
  it("[FIX-W47-SHARED AC6] is undefined for no values", () => {
    assert.equal(percentile([], 50), undefined);
  });

  it("[FIX-W47-SHARED AC6] takes the value at rank ceil(p/100 * n)", () => {
    const tens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(tens, 50), 50);
    assert.equal(percentile(tens, 95), 100);
    assert.equal(percentile(tens, 99), 100);
    assert.equal(percentile(tens, 90), 90);
    assert.equal(percentile(tens, 91), 100);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(hundred, 95), 95);
    assert.equal(percentile(hundred, 99), 99);
  });

  it("[FIX-W47-SHARED AC6] stays inside the list at both ends", () => {
    assert.equal(percentile([7], 50), 7);
    assert.equal(percentile([7], 99), 7);
    assert.equal(percentile([1, 2, 3], 0), 1);
    assert.equal(percentile([1, 2, 3], 100), 3);
  });
});

describe("accounts and requests", () => {
  it("[FIX-W47-SHARED AC6] phaseRequests counts the warm-up and the measured seconds at the phase's rate", () => {
    assert.equal(phaseRequests({ rate: 10 }, { warmupS: 5, durationS: 60 }), 650);
    assert.equal(phaseRequests({ rate: 1 }, { warmupS: 5, durationS: 10 }), 15);
    assert.equal(phaseRequests({ rate: 0.5 }, { warmupS: 0, durationS: 3 }), 2);
  });

  it("[FIX-W47-SHARED AC6] accountsNeeded keeps the defaults at 33 accounts and --duration 10 at 8 (README)", () => {
    const at = (durationS, warmupS = 5, maxTenantsPerAccount = 3, rateScale = 1) =>
      accountsNeeded({
        durationS,
        warmupS,
        maxTenantsPerAccount,
        phases: PHASES.map((phase) => ({ ...phase, rate: phase.rate * rateScale })),
      });
    assert.equal(at(60), 33);
    assert.equal(at(10), 8);
    // The read phases' 50/s over one 60-second window, at 80 % of the limit of 300: 13 accounts; createTenant's
    // 65 calls at 1/s need 33, two more OTAs per account next to the one of the set-up.
    assert.equal(at(60, 5, 6), 13);
    assert.equal(at(60, 5, 3, 2), 65);
  });

  it("[FIX-W47-SHARED AC6] accountsNeeded asks for at least 2 accounts and ignores the phases that use none", () => {
    const only = (ids) =>
      accountsNeeded({
        durationS: 60,
        warmupS: 5,
        maxTenantsPerAccount: 3,
        phases: PHASES.filter((phase) => ids.includes(phase.id)),
      });
    assert.equal(only(["signIn"]), 2);
    assert.equal(only(["tlsAskCached", "tlsAskUncached"]), 2);
    assert.equal(only(["getTenant"]), 13);
  });
});

describe("options", () => {
  it("[FIX-W47-SHARED AC6] the defaults: every phase at its rate, 60 s after 5 s of warm-up, 33 accounts", () => {
    const options = parseOptions([]);
    assert.equal(options.base, "http://127.0.0.1:3100");
    assert.equal(options.durationS, 60);
    assert.equal(options.warmupS, 5);
    assert.equal(options.accounts, 33);
    assert.deepEqual(
      options.phases.map((phase) => [phase.id, phase.rate]),
      [
        ["signIn", 10],
        ["getTenant", 50],
        ["listApiKeys", 50],
        ["tlsAskCached", 100],
        ["tlsAskUncached", 100],
        ["createTenant", 1],
      ],
    );
    assert.equal(options.bffKey, BFF_KEY);
    assert.deepEqual(parseOptions(["--help"]), { help: true });
  });

  it("[FIX-W47-SHARED AC6] --rate-scale multiplies every rate and the accounts follow", () => {
    const options = parseOptions(["--rate-scale", "2", "--phases", "getTenant,createTenant"]);
    assert.deepEqual(
      options.phases.map((phase) => [phase.id, phase.rate]),
      [
        ["getTenant", 100],
        ["createTenant", 2],
      ],
    );
    assert.equal(options.accounts, 65);
  });

  it("[FIX-W47-SHARED AC6] usage errors: a remote --base, an unknown phase, too few accounts, out-of-range numbers", () => {
    const refused = [
      [["--base", "http://api.platform.example.com"], /--base must be http:\/\/<loopback>/],
      [["--base", "https://127.0.0.1:3100"], /--base must be http:\/\/<loopback>/],
      [["--base", "http://127.0.0.1:3100/v1"], /without a path/],
      [["--phases", "signIn,deleteEverything"], /unknown phase "deleteEverything"/],
      [["--accounts", "2"], /--accounts 2 is too few for these phases: 33/],
      [["--duration", "601"], /--duration must be a whole number from 1 to 600/],
      [["--warmup", "61"], /--warmup must be a whole number from 0 to 60/],
      [["--rate-scale", "21"], /--rate-scale must be a number from 0.1 to 20/],
      [["--max-tenants-per-account", "1"], /--max-tenants-per-account must be a whole number from 2/],
      [["--bogus"], /Unknown option '--bogus'/],
    ];
    for (const [argv, message] of refused) {
      assert.throws(
        () => parseOptions(argv),
        (error) => error instanceof UsageError && message.test(error.message),
        argv.join(" "),
      );
    }
  });

  it("[FIX-W47-SHARED AC6] PLATFORM_BFF_KEY is required, and neither the error nor publicOptions holds it", () => {
    delete process.env.PLATFORM_BFF_KEY;
    assert.throws(
      () => parseOptions([]),
      (error) => error instanceof UsageError && /PLATFORM_BFF_KEY must be set/.test(error.message),
    );
    process.env.PLATFORM_BFF_KEY = "   ";
    assert.throws(() => parseOptions([]), UsageError);
    process.env.PLATFORM_BFF_KEY = BFF_KEY;
    const kept = publicOptions(parseOptions(["--duration", "10"]));
    assert.deepEqual(kept, {
      durationS: 10,
      warmupS: 5,
      phases: PHASES.map((phase) => phase.id),
      accounts: 8,
      maxTenantsPerAccount: 3,
      concurrency: 50,
      rateScale: 1,
      workerPort: 3101,
    });
    assert.doesNotMatch(JSON.stringify(kept), new RegExp(BFF_KEY));
  });

  it("[FIX-W47-SHARED AC6] positiveInt and decimal accept plain numbers in range only", () => {
    assert.equal(positiveInt("--n", "7"), 7);
    assert.equal(positiveInt("--n", "0", { min: 0 }), 0);
    for (const bad of ["0", "-1", "1.5", "1e3", " 7", "", "0x10"]) {
      assert.throws(() => positiveInt("--n", bad), UsageError, bad);
    }
    assert.equal(decimal("--x", "0.5", { min: 0.1, max: 20 }), 0.5);
    assert.equal(decimal("--x", "20", { min: 0.1, max: 20 }), 20);
    for (const bad of ["0.05", "20.5", ".5", "1,5", "-1"]) {
      assert.throws(() => decimal("--x", bad, { min: 0.1, max: 20 }), UsageError, bad);
    }
  });
});

describe("answers and errors", () => {
  it("[FIX-W47-SHARED AC6] errorKey is the status and the error code, never the body", () => {
    assert.equal(
      errorKey(404, JSON.stringify({ error: { code: "TENANT_NOT_FOUND", message: "secret detail" } })),
      "404 TENANT_NOT_FOUND",
    );
    assert.equal(errorKey(500, "<html>token=abc</html>"), "500");
    assert.equal(errorKey(429, JSON.stringify({ error: { code: "rate limited; token=abc" } })), "429");
    assert.equal(errorKey(400, JSON.stringify({ error: { code: 42 } })), "400");
    assert.equal(errorKey(401, ""), "401");
  });

  it("[FIX-W47-SHARED AC6] failureKey names a timeout or the network error code", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    assert.equal(failureKey(timeout), "timeout");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(failureKey(abort), "timeout");
    assert.equal(
      failureKey(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })),
      "network ECONNREFUSED",
    );
    assert.equal(failureKey(new TypeError("fetch failed")), "network error");
    assert.equal(failureKey("not an error"), "network error");
  });
});

describe("verdicts and report", () => {
  it("[FIX-W47-SHARED AC6] phaseVerdict: met, no target, or every problem", () => {
    assert.equal(phaseVerdict(result()), "met");
    assert.equal(phaseVerdict(result({ targetMet: undefined })), "no target");
    assert.equal(phaseVerdict(result({ targetMet: false })), "MISSED");
    assert.equal(
      phaseVerdict(result({ targetMet: false, errorCount: 2, rateKept: false })),
      "MISSED, errors, rate not kept",
    );
    assert.equal(phaseVerdict(result({ targetMet: undefined, rateKept: false })), "rate not kept");
  });

  it("[FIX-W47-SHARED AC6] problemsOf lists each missed target, error, rate and RSS budget, and nothing for a pass", () => {
    const within = [
      { name: "API", withinBudget: true, budgetMiB: 768 },
      { name: "worker", withinBudget: true, budgetMiB: 512 },
    ];
    assert.deepEqual(problemsOf({ phases: [result()], processes: within }), []);
    assert.deepEqual(
      problemsOf({
        phases: [
          result({ label: "signIn", targetP95Ms: 800, p95Ms: 912.04, targetMet: false }),
          result({ label: "getTenant", errorCount: 3 }),
          result({ label: "listApiKeys", rateKept: false, lateStarts: 40, sent: 3000 }),
        ],
        processes: [
          { name: "API", withinBudget: false, budgetMiB: 768 },
          { name: "worker", withinBudget: undefined, budgetMiB: 512 },
        ],
      }),
      [
        "signIn p95 912.0 ms is not below 800 ms",
        "getTenant had 3 unexpected answers",
        "listApiKeys started 40 of 3000 requests late",
        "the API's RSS went over 768 MiB",
        "the worker's RSS was not measured",
      ],
    );
  });

  it("[FIX-W47-SHARED AC6] round, fmt and loadText print a dash for what was not measured", () => {
    assert.equal(round(1.25, 1), 1.3);
    assert.equal(round(2.375, 2), 2.38); // values a double holds exactly: no binary rounding in the way
    assert.equal(round(7, 2), 7);
    assert.equal(round(undefined), undefined);
    assert.equal(fmt(12.345), "12.3");
    assert.equal(fmt(0.5, 2), "0.50");
    assert.equal(fmt(undefined), "—");
    assert.equal(loadText([0.5, 1, 1.25]), "0.50, 1.00, 1.25");
    assert.equal(loadText(undefined), "—");
  });

  it("[FIX-W47-SHARED AC6] table left-aligns the text columns and right-aligns the figures", () => {
    assert.equal(
      table(
        ["Phase", "Sent", "p95"],
        [
          ["signIn", 600, "1.0"],
          ["tlsAsk cached", 6000, "12.5"],
        ],
      ),
      [
        "Phase          Sent   p95",
        "-------------  ----  ----",
        "signIn          600   1.0",
        "tlsAsk cached  6000  12.5",
      ].join("\n"),
    );
    assert.equal(
      table(["Process", "Budget"], [["API", "768"]], 2),
      ["Process  Budget", "-------  ------", "API      768"].join("\n"),
    );
  });
});

describe("options of the garbage-collection logs (PBE-076)", () => {
  it("[PBE-076 AC1] --api-gc-log and --worker-gc-log name the processes' log files; without them nothing is read", () => {
    assert.deepEqual(parseOptions([]).gcLogs, { api: undefined, worker: undefined });
    assert.deepEqual(
      parseOptions(["--api-gc-log", "/tmp/platform-api.log", "--worker-gc-log", "/tmp/platform-worker.log"])
        .gcLogs,
      { api: "/tmp/platform-api.log", worker: "/tmp/platform-worker.log" },
    );
  });

  it("[PBE-076 AC1] nodeOptionsOf takes NODE_OPTIONS alone from a process's environment, and '' without it", () => {
    const secret = "a-bff-key-of-the-stack";
    const environ = [
      `PLATFORM_BFF_KEY=${secret}`,
      "MY_NODE_OPTIONS=--not-this-one",
      "NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16",
      `DATABASE_URL=postgres://user:${secret}@127.0.0.1/db`,
      "",
    ].join("\0");
    const options = nodeOptionsOf(environ);
    assert.equal(options, "--max-old-space-size=640 --max-semi-space-size=16");
    assert.ok(!options.includes(secret));
    assert.equal(nodeOptionsOf(`PATH=/usr/bin\0PLATFORM_BFF_KEY=${secret}\0`), "");
    assert.equal(nodeOptionsOf(""), "");
    // An empty NODE_OPTIONS is set but holds nothing.
    assert.equal(nodeOptionsOf("NODE_OPTIONS=\0"), "");
  });
});

/** How long a child of runObserved may run before it is killed: each ends in well under a second by itself. */
const CHILD_DEADLINE_MS = 20_000;

/**
 * A child Node process with the preload, as the README starts the API and the worker: `--require gc-observer.cjs`,
 * an old generation of 64 MiB and a semi-space of 1 MiB (a heap limit of 64 + 3 × 1 = 67 MiB), and lines every 100 ms.
 * Resolves to its exit code or signal, its stdout and the observer's lines on its stderr; rejects when its stderr holds
 * anything but JSON lines. A child still running after CHILD_DEADLINE_MS (an observer that swallows the signal keeps
 * the keep-alive children below running) is killed with SIGKILL, so its test fails on that signal instead of leaving
 * the process behind.
 */
function runObserved(code, { interval = "100", flags = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=64", "--max-semi-space-size=1", ...flags, "--require", GC_OBSERVER, "-e", code],
      { env: { ...process.env, GC_OBSERVER_INTERVAL_MS: interval }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), CHILD_DEADLINE_MS);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(deadline);
      try {
        const lines = stderr
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line));
        resolve({ pid: child.pid, status, signal, stdout, stderr, lines });
      } catch {
        reject(new Error(`the child wrote more than the observer's JSON lines on stderr:\n${stderr}`));
      }
    });
  });
}

/** Allocates in eight rounds of 40 ms, 20 ms apart, keeping a little: scavenges and some full collections. */
const ALLOCATES = `
let rounds = 0;
let keep = [];
const tick = () => {
  const end = Date.now() + 40;
  while (Date.now() < end) {
    keep.push(new Array(64).fill(rounds));
    if (keep.length > 2000) keep = [];
  }
  if (++rounds < 8) setTimeout(tick, 20);
};
tick();`;

describe("gc-observer.cjs, the garbage-collection preload (PBE-076)", () => {
  const children = {};
  // Budget: eight child Node processes in parallel, each about half a second of work after Node's own start-up (well
  // under a second each on an idle machine); 30 s leaves room for a loaded CI runner, and runObserved kills a child
  // that is still running after 20 s. The tests below only read their output.
  before(
    async () => {
      const [allocates, plainSignal, ownHandler, ownExit, pendingAtExit, workerThread, badInterval, idles] =
        await Promise.all([
          runObserved(ALLOCATES),
          // No listener of its own: the observer writes its exit line, and SIGTERM still ends the process.
          runObserved(
            `${ALLOCATES}\nsetTimeout(() => process.kill(process.pid, "SIGTERM"), 600); setInterval(() => {}, 1000);`,
          ),
          // NestJS's shutdown hooks: a listener that ignores a second signal while it cleans up, then, after an
          // asynchronous step, removes itself and sends the signal again. It reports how many signals it was given.
          runObserved(
            `let signals = 0;
           const onTerm = () => {
             if (++signals > 1) return;
             setTimeout(() => {
               process.stdout.write("cleaned up after " + signals + " signal(s)");
               process.removeListener("SIGTERM", onTerm);
               process.kill(process.pid, "SIGTERM");
             }, 30);
           };
           process.on("SIGTERM", onTerm);
           setTimeout(() => process.kill(process.pid, "SIGTERM"), 50); setInterval(() => {}, 1000);`,
          ),
          // A listener of its own that ends the process with process.exit: the `exit` event follows the signal.
          runObserved(
            `process.on("SIGTERM", () => setTimeout(() => process.exit(7), 30));
           setTimeout(() => process.kill(process.pid, "SIGTERM"), 50); setInterval(() => {}, 1000);`,
          ),
          // Collections whose entries the observer's callback has not been handed yet when the process exits: Node
          // makes the entries in an immediate and hands them over in a later one, after this process.exit. The
          // interval is the default minute, so that no timer line takes the entries first on a slow machine.
          runObserved(
            `let keep = [];
           for (let i = 0; i < 300000; i++) { keep.push(new Array(16).fill(i)); if (keep.length > 2000) keep = []; }
           setImmediate(() => process.exit(0));`,
            { interval: "60000" },
          ),
          // A worker thread gets the same preload; only the main thread may write lines.
          runObserved(
            `const { Worker } = require("node:worker_threads");
           new Worker(${JSON.stringify(ALLOCATES)}, { eval: true }).on("exit", () => {});`,
          ),
          // An interval below 50 ms is ignored: the minute stays, so a short run writes only its exit line.
          runObserved(ALLOCATES, { interval: "10" }),
          // One full collection asked for at once (--expose-gc), then three intervals of nothing that allocates enough
          // to collect: the lines after the one that holds the collection report intervals without one.
          runObserved("globalThis.gc(); setTimeout(() => {}, 350);", { flags: ["--expose-gc"] }),
        ]);
      Object.assign(children, {
        allocates,
        plainSignal,
        ownHandler,
        ownExit,
        pendingAtExit,
        workerThread,
        badInterval,
        idles,
      });
    },
    { timeout: 30_000 },
  );

  it("[PBE-076 AC1] writes one JSON line per interval and one at exit, on stderr only, for its own process", () => {
    const { status, signal, stdout, lines, pid } = children.allocates;
    assert.equal(status, 0);
    assert.equal(signal, null);
    assert.equal(stdout, "");
    assert.ok(lines.length >= 3, `${lines.length} lines`);
    assert.deepEqual(
      lines.map((line) => line.at),
      [...Array(lines.length - 1).fill("minute"), "exit"],
    );
    for (const line of lines) {
      assert.equal(line.gcObserver, 1);
      assert.equal(line.pid, pid);
      assert.equal(line.node, process.version);
      // V8's heap limit with both flags: old + 3 × semi-space, as the units' heap check of X-050 expects.
      assert.equal(line.heapLimitMiB, 67);
      assert.ok(!Number.isNaN(Date.parse(line.time)), line.time);
      assert.equal(line.signal, undefined);
    }
    for (const [index, line] of lines.entries()) {
      if (index > 0) {
        const previous = lines[index - 1];
        assert.ok(line.uptimeMs > previous.uptimeMs);
        assert.ok(line.gcMs >= previous.gcMs);
        assert.ok(line.gcCount >= previous.gcCount);
      }
    }
  });

  it("[PBE-076 AC1] counts the child's collections: milliseconds and pauses in total, per kind and per interval", () => {
    const { lines } = children.allocates;
    const last = lines.at(-1);
    assert.ok(last.gcCount > 0, "the child that allocates collected garbage");
    assert.ok(last.gcMs > 0);
    assert.ok(last.gcMs < last.uptimeMs, "garbage collection is part of the process's time");
    assert.ok(last.kinds.minor.count > 0, "a 1 MiB semi-space fills: scavenges");
    const kinds = Object.values(last.kinds);
    assert.equal(
      kinds.reduce((sum, kind) => sum + kind.count, 0),
      last.gcCount,
    );
    // Every figure is rounded to 0.1 ms, so sums may differ from the total by 0.05 ms per figure.
    const kindMs = kinds.reduce((sum, kind) => sum + kind.ms, 0);
    assert.ok(Math.abs(kindMs - last.gcMs) <= 0.05 * (kinds.length + 1) + 1e-9, `${kindMs} vs ${last.gcMs}`);
    assert.equal(
      lines.reduce((sum, line) => sum + line.intervalCount, 0),
      last.gcCount,
    );
    const intervalMs = lines.reduce((sum, line) => sum + line.intervalGcMs, 0);
    assert.ok(
      Math.abs(intervalMs - last.gcMs) <= 0.05 * (lines.length + 1) + 1e-9,
      `${intervalMs} vs ${last.gcMs}`,
    );
    for (const line of lines) {
      assert.ok(line.intervalMaxMs <= line.intervalGcMs + 1e-9);
      assert.ok(line.intervalMs > 0);
    }
    // The intervals follow one another: each starts where the line before ended, so its length is the difference of
    // the two lines' uptimes (three figures rounded to 0.1 ms each).
    for (const [index, line] of lines.entries()) {
      if (index > 0) {
        const between = line.uptimeMs - lines[index - 1].uptimeMs;
        assert.ok(Math.abs(line.intervalMs - between) <= 0.15 + 1e-9, `${line.intervalMs} vs ${between}`);
      }
    }
  });

  it("[PBE-076 AC1] reports an interval without a collection as none: no milliseconds and no longest pause of its own", () => {
    const { status, lines } = children.idles;
    assert.equal(status, 0);
    // Usually the first line holds the collection; on a slow start the timer's first line can come before Node has
    // made its entry, and then the next one holds it.
    const collected = lines.findIndex((line) => line.intervalCount > 0);
    assert.ok(collected >= 0, "a line holds the collection asked for");
    assert.ok(lines[collected].intervalMaxMs > 0);
    assert.ok(lines.at(-1).kinds.major.count > 0, "gc() is a full collection");
    const idleAfter = lines.slice(collected + 1).filter((line) => line.intervalCount === 0);
    assert.ok(
      idleAfter.length > 0,
      `no line without a collection after line ${collected} of ${lines.length}`,
    );
    for (const line of lines.filter((each) => each.intervalCount === 0)) {
      assert.equal(line.intervalGcMs, 0);
      assert.equal(line.intervalMaxMs, 0, "the longest pause of an earlier interval does not carry over");
    }
    const intervalMs = lines.reduce((sum, line) => sum + line.intervalGcMs, 0);
    assert.ok(Math.abs(lines.at(-1).gcMs - intervalMs) <= 0.05 * (lines.length + 1) + 1e-9);
  });

  it("[PBE-076 AC1] writes its exit line at SIGTERM and still lets the signal end a process without a listener", () => {
    const { status, signal, lines } = children.plainSignal;
    assert.equal(status, null);
    assert.equal(signal, "SIGTERM");
    const exits = lines.filter((line) => line.at === "exit");
    assert.equal(exits.length, 1);
    assert.equal(exits[0].signal, "SIGTERM");
    assert.equal(lines.at(-1).at, "exit");
    assert.ok(exits[0].gcCount > 0);
  });

  it("[PBE-076 AC1] leaves a process's own SIGTERM listener (NestJS's shutdown hooks) to end it, with one exit line", () => {
    const { status, signal, stdout, lines } = children.ownHandler;
    // The observer neither sends the signal again while the process's own listener is cleaning up nor ends the process
    // before it: the listener was given the one signal and finished.
    assert.equal(stdout, "cleaned up after 1 signal(s)");
    assert.equal(status, null);
    assert.equal(signal, "SIGTERM");
    assert.deepEqual(
      lines.filter((line) => line.at === "exit").map((line) => line.signal),
      ["SIGTERM"],
    );
  });

  it("[PBE-076 AC1] writes its exit line once when the signal's own listener ends the process with process.exit", () => {
    const { status, signal, lines } = children.ownExit;
    assert.equal(status, 7);
    assert.equal(signal, null);
    assert.deepEqual(
      lines.filter((line) => line.at === "exit").map((line) => line.signal),
      ["SIGTERM"],
    );
  });

  it("[PBE-076 AC1] counts at exit the collections whose entries are still waiting for the observer's callback", () => {
    const { status, lines } = children.pendingAtExit;
    assert.equal(status, 0);
    assert.deepEqual(
      lines.map((line) => line.at),
      ["exit"],
    );
    assert.ok(lines[0].gcCount > 0, "the exit line takes the pending entries");
    assert.ok(lines[0].kinds.minor.count > 0);
  });

  it("[PBE-076 AC1] measures the main thread only: a worker thread with the same preload writes nothing", () => {
    const { status, lines, pid } = children.workerThread;
    assert.equal(status, 0);
    assert.equal(lines.filter((line) => line.at === "exit").length, 1);
    assert.ok(lines.every((line) => line.pid === pid));
  });

  it("[PBE-076 AC1] ignores an interval below 50 ms: a run shorter than a minute writes only its exit line", () => {
    const { status, lines } = children.badInterval;
    assert.equal(status, 0);
    assert.deepEqual(
      lines.map((line) => line.at),
      ["exit"],
    );
    assert.ok(lines[0].gcCount > 0);
  });
});

/** A gc-observer line as the preload writes it, `minutes` after 10:00:00 UTC of a fixed day. */
const observerLine = (pid, minutes, gcMs, gcCount, intervalMaxMs = 1) =>
  JSON.stringify({
    gcObserver: 1,
    at: "minute",
    pid,
    node: "v24.22.3",
    heapLimitMiB: 688,
    time: new Date(Date.UTC(2026, 10, 18, 10, minutes)).toISOString(),
    uptimeMs: 60_000 * (minutes + 1),
    gcMs,
    gcCount,
    intervalMs: 60_000,
    intervalGcMs: 0,
    intervalCount: 0,
    intervalMaxMs,
    kinds: {},
  });
const at = (minutes, seconds = 0) => Date.UTC(2026, 10, 18, 10, minutes, seconds);

describe("reading the garbage-collection lines (PBE-076)", () => {
  const log = [
    '{"level":30,"time":1763460000000,"msg":"request completed","gcObserver":"not first"}',
    observerLine(4242, 0, 100, 10, 9), // before the measured seconds
    observerLine(4242, 1, 160, 20, 3),
    observerLine(7, 1, 999, 99), // another process
    "plain text from the process",
    observerLine(4242, 2, 280, 35, 7),
    '{"gcObserver":1,"at":"minute","pid":4242,"node":"v24', // cut short while being written
    observerLine(4242, 2, 290, 36).replace(/"time":"[^"]*"/, '"time":"not a time"'), // no time to place it by
    observerLine(4242, 3, 310, 41, 2),
    observerLine(4242, 4, 999, 99, 50), // after the measured seconds
  ].join("\n");

  it("[PBE-076 AC1] gcObserverLines keeps the complete lines of one process, in order, with their time", () => {
    const lines = gcObserverLines(log, 4242);
    assert.deepEqual(
      lines.map((line) => [line.gcMs, line.timeMs]),
      [
        [100, at(0)],
        [160, at(1)],
        [280, at(2)],
        [310, at(3)],
        [999, at(4)],
      ],
    );
    assert.deepEqual(
      gcObserverLines(log, 7).map((line) => line.gcMs),
      [999],
    );
    assert.deepEqual(gcObserverLines(log, 1), []);
  });

  it("[PBE-076 AC1] gcFigures gives the share over the lines written in the measured seconds, and the highest minute", () => {
    const figures = gcFigures(gcObserverLines(log, 4242), at(0, 30), at(3, 30));
    assert.deepEqual(figures, {
      node: "v24.22.3",
      heapLimitMiB: 688,
      lines: 3,
      windowS: 120,
      gcMs: 150,
      pauses: 21,
      // 150 ms in 120 s; the minute from 10:01 to 10:02 had 120 ms of garbage collection.
      sharePercent: 0.13,
      highestPercent: 0.2,
      // The longest pause of the intervals that end inside the measured seconds, not of the one before them.
      longestPauseMs: 7,
    });
  });

  it("[PBE-076 AC1] gcFigures is undefined with fewer than two lines in the measured seconds", () => {
    const lines = gcObserverLines(log, 4242);
    assert.equal(gcFigures(lines, at(1, 30), at(2, 30)), undefined);
    assert.equal(gcFigures(lines, at(5), at(6)), undefined);
    assert.equal(gcFigures([], at(0), at(9)), undefined);
  });

  describe("gcOfProcess", () => {
    let folder;
    before(() => {
      folder = mkdtempSync(path.join(tmpdir(), "platform-smoke-test-"));
    });
    after(() => {
      rmSync(folder, { recursive: true, force: true });
    });

    it("[PBE-076 AC1] reads a log file, and says why when it cannot measure; without a log file it is not asked", () => {
      const file = path.join(folder, "platform-api.log");
      writeFileSync(file, `${log}\n`);
      const measured = { fromMs: at(0, 30), toMs: at(3, 30) };
      assert.equal(gcOfProcess(undefined, 4242, measured), undefined);
      assert.equal(gcOfProcess(file, 4242, measured).sharePercent, 0.13);
      assert.deepEqual(gcOfProcess(file, undefined, measured), { notMeasured: "process not found" });
      assert.deepEqual(gcOfProcess(file, 4242, { fromMs: at(0), toMs: undefined }), {
        notMeasured: "no phase measured",
      });
      assert.deepEqual(gcOfProcess(path.join(folder, "missing.log"), 4242, measured), {
        notMeasured: "log not readable (ENOENT)",
      });
      assert.deepEqual(gcOfProcess(file, 1, measured), { notMeasured: "no gc-observer line of pid 1" });
      assert.match(
        gcOfProcess(file, 4242, { fromMs: at(1, 30), toMs: at(2, 30) }).notMeasured,
        /fewer than two gc-observer lines/,
      );
    });
  });
});

describe("the thresholds of ADR-0029 in the verdict (PBE-076)", () => {
  const process_ = (overrides = {}) => ({
    name: "api",
    withinBudget: true,
    budgetMiB: 768,
    headroomMiB: 400,
    gc: { sharePercent: 1.5 },
    ...overrides,
  });

  it("[PBE-076 AC2] a peak RSS less than 64 MiB under its MemoryMax and more than 5 % in garbage collection fail the run", () => {
    assert.deepEqual(problemsOf({ phases: [result()], processes: [process_()] }), []);
    assert.deepEqual(
      problemsOf({
        phases: [result()],
        processes: [process_({ headroomMiB: 64, gc: { sharePercent: 5 } })],
      }),
      [],
    );
    assert.deepEqual(
      problemsOf({
        phases: [result()],
        processes: [
          process_({ headroomMiB: 63.6 }),
          process_({ name: "worker", budgetMiB: 512, gc: { sharePercent: 5.01 } }),
        ],
      }),
      [
        "the api's peak RSS left 63.6 MiB under its 768 MiB, less than 64 MiB",
        "the worker spent 5.01 % of its time in garbage collection, more than 5 %",
      ],
    );
    // Not measured is no failure of its own: a 10-second run has no two observer lines in its measured seconds.
    assert.deepEqual(
      problemsOf({
        phases: [result()],
        processes: [
          process_({ gc: { notMeasured: "fewer than two gc-observer lines" } }),
          process_({ gc: undefined }),
        ],
      }),
      [],
    );
  });

  it("[PBE-076 AC2] rssVerdict and gcVerdict name the result of each process", () => {
    assert.equal(rssVerdict(process_()), "within");
    assert.equal(rssVerdict(process_({ headroomMiB: 12 })), "LOW HEADROOM");
    assert.equal(rssVerdict(process_({ withinBudget: false, headroomMiB: -4 })), "OVER");
    assert.equal(rssVerdict(process_({ withinBudget: undefined, headroomMiB: undefined })), "not measured");
    assert.equal(gcVerdict({ sharePercent: 5 }), "within");
    assert.equal(gcVerdict({ sharePercent: 5.2 }), "OVER");
    assert.equal(gcVerdict({ notMeasured: "process not found" }), "not measured");
    assert.equal(gcVerdict(undefined), "not asked");
  });
});
