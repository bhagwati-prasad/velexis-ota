// Unit tests of the pure helpers of platform-smoke.mjs (PBE-063): the options, the account count, the percentiles, the
// error keys and the verdicts. Lead decision (13c) of 2026-11-10, approved by the owner: CI's build-test job runs them
// with the tools/ci tests. Run: node --test tools/perf/*.test.mjs (plain Node 22, no install, no running API).
//
// Importing the script runs nothing: it starts its measurement only when Node runs the file itself.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
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
} from "./platform-smoke.mjs";

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
