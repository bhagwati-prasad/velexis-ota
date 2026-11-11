// Tests of the link between deploy.yml and e2e.yml (lead decision (15c) of 2026-11-11, approved by the owner;
// FIX-W48-SHARED): Deploy calls the E2E workflow for the commit it deploys and deploys only after it is green; the
// nightly, on-demand and deploy-called E2E runs do not cancel each other; traces are kept when a run is cancelled;
// a failed earlier step no longer skips the Stripe steps, and each Playwright step keeps its own results folder.
// Run: node --test tools/ci/*.test.mjs. tools/e2e/test/workflow.test.ts tests what the E2E job runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { childBlock, jobKeyOf, mapOf, parseWorkflow, scalar, stepKey, topLevel } from "./workflow-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const E2E_YML = readFileSync(join(ROOT, ".github/workflows/e2e.yml"), "utf8");
const DEPLOY_YML = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
const E2E = parseWorkflow(E2E_YML);
const DEPLOY = parseWorkflow(DEPLOY_YML);
const E2E_STEPS = E2E.get("e2e")?.steps ?? [];
/** The three Stripe test secrets the E2E workflow reads (tools/e2e/README.md, CI). */
const STRIPE_SECRETS = [
  "E2E_STRIPE_SECRET_KEY",
  "E2E_STRIPE_BILLING_WEBHOOK_SECRET",
  "E2E_STRIPE_PUBLISHABLE_KEY",
];
/** deploy.yml's own condition on the refs it deploys. */
const DEPLOY_REFS = "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')";

// ---- A small evaluator of the GitHub expressions these workflows use -------------------------------------
// Enough of the expression language for the conditions and the concurrency group: `||`, `&&`, `!`, `==`, `!=`,
// string literals, context paths and the status functions; a missing property is null, `||` and `&&` return an
// operand, and `==` compares strings without case, as GitHub does.

function tokenize(source) {
  const tokens = [];
  const re = /\s*(?:(\|\||&&|==|!=|!|\(|\)|,)|'((?:[^']|'')*)'|([A-Za-z_][\w.-]*))/y;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) {
      break;
    }
    re.lastIndex = at;
    const m = re.exec(source);
    assert.ok(m, `cannot read the expression at: ${source.slice(at)}`);
    at = re.lastIndex;
    tokens.push(m[1] ? { op: m[1] } : m[2] !== undefined ? { str: m[2].replace(/''/g, "'") } : { id: m[3] });
  }
  return tokens;
}

/** Evaluates `source` (without `${{ }}`) with `context`: { github, env, inputs, steps, status }. */
function evaluate(source, context) {
  const tokens = tokenize(source);
  let i = 0;
  const peek = (op) => tokens[i]?.op === op;
  const take = (op) => {
    assert.equal(tokens[i]?.op, op, `expected ${op} in ${source}`);
    i += 1;
  };
  const lookup = (path) =>
    path
      .split(".")
      .reduce((value, key) => (value === null || value === undefined ? null : (value[key] ?? null)), context);
  const call = (name, args) => {
    if (name === "startsWith") {
      return String(args[0] ?? "")
        .toLowerCase()
        .startsWith(String(args[1] ?? "").toLowerCase());
    }
    assert.ok(["success", "failure", "cancelled", "always"].includes(name), `unknown function ${name}`);
    return name === "always" ? true : context.status === name;
  };
  const primary = () => {
    const token = tokens[(i += 1) - 1];
    if (token?.op === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token?.str !== undefined) {
      return token.str;
    }
    assert.ok(token?.id, `unexpected token in ${source}`);
    if (peek("(")) {
      take("(");
      const args = [];
      while (!peek(")")) {
        args.push(or());
        if (peek(",")) {
          take(",");
        }
      }
      take(")");
      return call(token.id, args);
    }
    return token.id === "true" ? true : token.id === "false" ? false : lookup(token.id);
  };
  const unary = () => {
    if (peek("!")) {
      take("!");
      return !unary();
    }
    return primary();
  };
  const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  const comparison = () => {
    let left = unary();
    while (peek("==") || peek("!=")) {
      const op = tokens[i].op;
      i += 1;
      const right = unary();
      left = op === "==" ? same(left, right) : !same(left, right);
    }
    return left;
  };
  const and = () => {
    let left = comparison();
    while (peek("&&")) {
      take("&&");
      const right = comparison();
      left = left ? right : left;
    }
    return left;
  };
  function or() {
    let left = and();
    while (peek("||")) {
      take("||");
      const right = and();
      left = left ? left : right;
    }
    return left;
  }
  const value = or();
  assert.equal(i, tokens.length, `unread tokens in ${source}`);
  return value;
}

/** A string with `${{ … }}` parts, each evaluated with `context`. */
const interpolate = (text, context) =>
  text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr) => String(evaluate(expr, context) ?? ""));
/** A step's or job's `if`, without the quotes or `${{ }}` around it. */
const condition = (value) => scalar(value ?? "").replace(/^\$\{\{\s*(.*?)\s*\}\}$/, "$1");
/**
 * Whether a step with the `if` `source` runs, as GitHub decides it: a condition that calls none of the status
 * functions gets `success() &&` in front of it, so such a step never runs after a failed or cancelled step.
 */
const stepRuns = (source, context) =>
  Boolean(
    evaluate(
      /\b(?:success|failure|cancelled|always)\(\)/.test(source) ? source : `success() && (${source})`,
      context,
    ),
  );

// The events of the runs: the caller's event is the run's event inside a called workflow.
const REF = "refs/heads/main";
const RUNS = {
  nightly: { github: { event_name: "schedule", ref: REF, event: {} }, inputs: {} },
  onDemand: { github: { event_name: "workflow_dispatch", ref: REF, event: {} }, inputs: {} },
  deployCalled: {
    github: { event_name: "workflow_dispatch", ref: REF, event: {} },
    inputs: { caller: "deploy" },
  },
  pullRequest: {
    github: { event_name: "pull_request", ref: "refs/pull/7/merge", event: { pull_request: { number: 7 } } },
    inputs: {},
  },
  otherPullRequest: {
    github: { event_name: "pull_request", ref: "refs/pull/8/merge", event: { pull_request: { number: 8 } } },
    inputs: {},
  },
};

describe("e2e.yml: called by Deploy, runs that do not cancel each other, every step's traces kept", () => {
  it("[FIX-W48-SHARED AC4] can be called (workflow_call) with the caller's name and the three Stripe test secrets, none required", () => {
    const on = topLevel(E2E_YML, "on");
    // The triggers it had stay.
    for (const trigger of ["schedule", "workflow_dispatch", "pull_request"]) {
      assert.ok(childBlock(on, trigger).length > 0, `on.${trigger}`);
    }
    const call = childBlock(on, "workflow_call");
    assert.ok(call.length > 0, "on.workflow_call");
    const caller = childBlock(childBlock(call, "inputs"), "caller");
    assert.deepEqual(
      { type: mapOf(caller).type, required: mapOf(caller).required },
      { type: "string", required: "true" },
    );
    const secrets = childBlock(call, "secrets");
    assert.deepEqual(Object.keys(mapOf(secrets)), STRIPE_SECRETS, "exactly the three Stripe test secrets");
    for (const name of STRIPE_SECRETS) {
      assert.equal(mapOf(childBlock(secrets, name)).required, "false", `${name} is not required`);
    }
    // Every secret the workflow reads is one of them, so a called run has all it needs.
    const read = new Set([...E2E_YML.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    assert.deepEqual([...read].sort(), [...STRIPE_SECRETS].sort());
  });

  it("[FIX-W48-SHARED AC4] puts the event (or the caller) in the concurrency group: nightly, on-demand and deploy-called runs never cancel each other", () => {
    const concurrency = mapOf(topLevel(E2E_YML, "concurrency"));
    const group = (run) => interpolate(concurrency.group, run);
    const cancels = (run) => interpolate(concurrency["cancel-in-progress"], run) === "true";
    const groups = [RUNS.nightly, RUNS.onDemand, RUNS.deployCalled].map(group);
    assert.equal(new Set(groups).size, 3, `three groups for one ref: ${groups.join(", ")}`);
    assert.equal(group(RUNS.deployCalled), "e2e-deploy-refs/heads/main");
    for (const run of [RUNS.nightly, RUNS.onDemand, RUNS.deployCalled]) {
      assert.equal(cancels(run), false, `${group(run)} cancels nothing in progress`);
    }
    // A newer run of the same pull request still cancels the one in progress; another pull request has its own group.
    assert.equal(cancels(RUNS.pullRequest), true);
    assert.notEqual(group(RUNS.pullRequest), group(RUNS.otherPullRequest));
    assert.notEqual(group(RUNS.pullRequest), group(RUNS.onDemand));
  });

  it("[FIX-W48-SHARED AC4] runs the Stripe steps after a failed Playwright step, never after a failed set-up or a cancellation", () => {
    const browsers = E2E_STEPS.findIndex((s) => /playwright install --with-deps chromium/.test(s.run ?? ""));
    const projects = E2E_STEPS.findIndex((s) => s.id === "projects");
    assert.equal(E2E_STEPS[browsers]?.id, "browsers", "the last set-up step has the id the conditions read");
    assert.equal(projects, browsers + 1, "the first Playwright step follows it");
    const portal = E2E_STEPS.find((s) => /--project=portal-stripe/.test(s.run ?? ""));
    const storefront = E2E_STEPS.find((s) => /--project=storefront-stripe/.test(s.run ?? ""));
    const env = { STRIPE_CONFIGURED: "true", STOREFRONT_STRIPE_CONFIGURED: "true" };
    const runs = (step, run, { status, browsersOutcome, configured = env }) =>
      stepRuns(condition(step.if), {
        ...run,
        env: configured,
        status,
        steps: { browsers: { outcome: browsersOutcome } },
      });
    // The step of the four projects failed: both still run (portal-stripe at night only).
    const afterFailure = { status: "failure", browsersOutcome: "success" };
    assert.equal(runs(portal, RUNS.nightly, afterFailure), true, "portal-stripe after a failed earlier step");
    assert.equal(
      runs(storefront, RUNS.nightly, afterFailure),
      true,
      "storefront-stripe after a failed earlier step",
    );
    // A failed set-up (the install, the build or the browsers) or a cancelled run skips them.
    for (const state of [
      { status: "failure", browsersOutcome: "skipped" },
      { status: "failure", browsersOutcome: "failure" },
      { status: "cancelled", browsersOutcome: "success" },
    ]) {
      assert.equal(runs(portal, RUNS.nightly, state), false, JSON.stringify(state));
      assert.equal(runs(storefront, RUNS.nightly, state), false, JSON.stringify(state));
    }
    // Their secret checks and events stay: without the secrets neither runs; never on a pull request.
    const green = { status: "success", browsersOutcome: "success" };
    const none = { STRIPE_CONFIGURED: "false", STOREFRONT_STRIPE_CONFIGURED: "false" };
    assert.equal(runs(portal, RUNS.nightly, { ...green, configured: none }), false);
    assert.equal(runs(storefront, RUNS.nightly, { ...green, configured: none }), false);
    assert.equal(runs(storefront, RUNS.pullRequest, green), false);
    assert.equal(runs(portal, RUNS.pullRequest, green), false);
    // A run Deploy calls (the caller's event, workflow_dispatch) runs storefront-stripe (OFE-026: before each deploy),
    // not portal-stripe (PADR-0017 item 4: nightly only), as an on-demand run does.
    assert.equal(runs(storefront, RUNS.deployCalled, green), true);
    assert.equal(runs(portal, RUNS.deployCalled, green), false);
    assert.equal(runs(portal, RUNS.onDemand, green), false);
  });

  it("[FIX-W48-SHARED AC4] gives every Playwright step a results folder of its own and uploads them all on failure or cancellation", () => {
    const playwright = E2E_STEPS.filter((s) => /pnpm test:e2e/.test(s.run ?? ""));
    assert.equal(playwright.length, 3);
    const folders = playwright.map((s) => mapOf(stepKey(s, "env")).E2E_RESULTS_SUBDIR);
    assert.deepEqual(folders, ["projects", "portal-stripe", "storefront-stripe"]);
    for (const folder of folders) {
      assert.match(
        folder,
        /^[a-z0-9][a-z0-9-]*$/,
        "one folder name, which tools/e2e/support/stack.ts accepts",
      );
    }
    // The job sets none for all of them.
    assert.equal(mapOf(jobKeyOf(E2E, "e2e", "env")).E2E_RESULTS_SUBDIR, undefined);
    const uploadAt = E2E_STEPS.findIndex((s) => (s.uses ?? "").startsWith("actions/upload-artifact@"));
    const upload = E2E_STEPS[uploadAt];
    assert.equal(condition(upload.if), "failure() || cancelled()");
    for (const status of ["failure", "cancelled"]) {
      assert.equal(stepRuns(condition(upload.if), { status }), true, `uploads when the run ends ${status}`);
    }
    assert.equal(stepRuns(condition(upload.if), { status: "success" }), false);
    // Every step's folder is under the two paths it uploads, and no Playwright step runs after it.
    const paths = stepKey(upload, "with").join("\n");
    assert.match(paths, /^\s+tools\/e2e\/test-results\/$/m);
    assert.match(paths, /^\s+tools\/e2e\/playwright-report\/$/m);
    assert.ok(playwright.every((s) => E2E_STEPS.indexOf(s) < uploadAt));
  });

  it("[FIX-W48-SHARED AC4] gives the job 45 minutes for the four projects and both Stripe steps", () => {
    assert.deepEqual(jobKeyOf(E2E, "e2e", "timeout-minutes"), ["    timeout-minutes: 45"]);
  });
});

describe("deploy.yml: nothing is deployed before a green E2E run of the same commit", () => {
  it("[FIX-W48-SHARED AC4] calls e2e.yml for the commit being deployed, with only the three Stripe test secrets", () => {
    assert.deepEqual([...DEPLOY.keys()], ["build", "e2e", "deploy"]);
    const key = (name) => jobKeyOf(DEPLOY, "e2e", name);
    assert.deepEqual(key("uses"), ["    uses: ./.github/workflows/e2e.yml"]);
    assert.deepEqual(mapOf(key("with")), { caller: "deploy" });
    // Passed one by one, never `secrets: inherit`: the production environment's secrets never reach it.
    const secrets = mapOf(key("secrets"));
    assert.deepEqual(
      secrets,
      Object.fromEntries(STRIPE_SECRETS.map((name) => [name, `\${{ secrets.${name} }}`])),
    );
    assert.doesNotMatch(DEPLOY_YML, /secrets:\s*inherit/);
    // No environment, and the refs Deploy accepts only: a wrong ref spends no end-to-end run.
    assert.deepEqual(key("environment"), []);
    assert.equal(condition(scalar(key("if")[0]?.replace(/^ {4}if: /, "") ?? "")), DEPLOY_REFS);
    // e2e.yml checks out the run's commit (github.sha), which build packs: neither names another ref.
    const checkout = E2E_STEPS.find((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    assert.ok(checkout && !stepKey(checkout, "with").some((line) => /\bref:/.test(line)));
  });

  it("[FIX-W48-SHARED AC4] deploys only after build and e2e passed, and refuses a release of another commit than the one tested", () => {
    assert.deepEqual(jobKeyOf(DEPLOY, "deploy", "needs"), ["    needs: [build, e2e]"]);
    // A job whose needs did not all succeed is skipped (no status function in its `if`).
    const deployIf = condition(scalar(jobKeyOf(DEPLOY, "deploy", "if")[0]?.replace(/^ {4}if: /, "") ?? ""));
    assert.equal(deployIf, DEPLOY_REFS);
    assert.doesNotMatch(deployIf, /always\(\)|failure\(\)|cancelled\(\)/);
    // The release id check: the build's sha must be the run's commit, which the e2e job tested.
    const check = DEPLOY.get("deploy").steps.find((s) => s.name === "Check the release id");
    const sha = "a".repeat(40);
    const runCheck = (env) =>
      execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", check.run], {
        env: { PATH: process.env.PATH ?? "", ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    assert.equal(runCheck({ SHA: sha, GITHUB_SHA: sha }), "");
    assert.throws(() => runCheck({ SHA: sha, GITHUB_SHA: "b".repeat(40) }), /which the e2e job tested/);
    assert.throws(() => runCheck({ SHA: "", GITHUB_SHA: sha }), /published no release sha/);
  });

  it("[FIX-W48-SHARED AC4] keeps the deploy job's environment, secrets and SSH push as they were", () => {
    assert.deepEqual(mapOf(jobKeyOf(DEPLOY, "deploy", "environment")), {
      name: "production",
      url: "https://platform.example.com",
    });
    const steps = DEPLOY.get("deploy").steps;
    assert.deepEqual(
      steps.map((s) => s.name ?? s.uses?.split("@")[0]),
      [
        "Check the release id",
        "actions/download-artifact",
        "Verify the artefact",
        "Configure SSH",
        "Upload to /srv/velexis/incoming/${{ needs.build.outputs.sha }}",
        "Activate on the VM",
        "Smoke check",
        "Remove the SSH key",
      ],
    );
    // The SSH secrets are the deploy job's alone, and the build job reads none.
    const ssh = mapOf(
      stepKey(
        steps.find((s) => s.name === "Configure SSH"),
        "env",
      ),
    );
    assert.deepEqual(Object.keys(ssh), [
      "DEPLOY_HOST",
      "DEPLOY_USER",
      "DEPLOY_SSH_KEY",
      "DEPLOY_KNOWN_HOSTS",
    ]);
    assert.doesNotMatch(DEPLOY.get("build").lines.join("\n"), /secrets\./);
    const deployJob = DEPLOY.get("deploy").lines.join("\n");
    const deploySecrets = [...deployJob.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(deploySecrets)],
      ["DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"],
    );
    assert.match(
      steps.find((s) => s.name === "Activate on the VM").run,
      /ssh velexis-vm "sudo \/usr\/local\/sbin\/velexis-deploy \$\{SHA\}"/,
    );
    // Deploys still queue behind each other, never cancel one in progress.
    assert.deepEqual(mapOf(topLevel(DEPLOY_YML, "concurrency")), {
      group: "deploy-production",
      "cancel-in-progress": "false",
    });
  });
});
