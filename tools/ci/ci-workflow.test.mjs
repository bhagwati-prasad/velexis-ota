// Tests of the CI workflow's own rules (task X-019). Run: node --test tools/ci/*.test.mjs (after pnpm install,
// because the lint test loads ESLint with the repository's eslint.config.mjs).
//
// The "Repository guards" step is read from .github/workflows/ci.yml and run with `bash -e`, as GitHub runs a
// `run:` script, inside small git repositories whose last commit plays the pull request's merge commit.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { jobKeyOf, mapOf, parseWorkflow, withOf } from "./workflow-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_YML = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
// Built at run time, so that this file does not trip the guard it tests.
const SESSION_SET = ["SET", "search_path"].join(" ");
const SESSION_SET_CONFIG = (value) => `set_config('search_path', ${value}, ${["fal", "se"].join("")})`;

const scratch = mkdtempSync(join(tmpdir(), "x019-ci-workflow-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// ---- The shape of ci.yml (workflow-reader.mjs) -----------------------------------------------------------

const JOBS = parseWorkflow(CI_YML);
const stepIndex = (job, predicate) => JOBS.get(job).steps.findIndex(predicate);
/** The lines of a job's own key (`services`, `env`, `timeout-minutes`, ...) as written, or [] when it has none. */
const jobKey = (job, key) => jobKeyOf(JOBS, job, key);
const GUARDS = JOBS.get("build-test")?.steps.find((s) => s.name === "Repository guards")?.run;

// ---- Scratch git repositories ----------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "CI test",
  GIT_AUTHOR_EMAIL: "ci-test@example.invalid",
  GIT_COMMITTER_NAME: "CI test",
  GIT_COMMITTER_EMAIL: "ci-test@example.invalid",
};
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV });

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

let count = 0;
/** A repository with a base commit and a head commit, as `actions/checkout` with fetch-depth 2 leaves a PR. */
function repo(base, head) {
  const dir = join(scratch, `repo-${(count += 1)}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFiles(dir, {
    "README.md": "fixture\n",
    "docs/velexis-sdk/sdk/src/shared.d.ts": "export {};\n",
    ...base,
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  writeFiles(dir, head);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "head");
  return dir;
}

/** Runs the guards step the way GitHub runs a `run:` script without `shell:` (bash -e). */
function guards(cwd, event = "pull_request") {
  const script = join(scratch, `guards-${(count += 1)}.sh`);
  writeFileSync(script, `${GUARDS}\n`);
  const result = spawnSync("bash", ["-e", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: event },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

// ---- Tests -------------------------------------------------------------------------------------------------

describe("workflow shape", () => {
  it("[X-019 AC3] the plan-lint job runs without pnpm install", () => {
    const job = JOBS.get("plan-lint");
    assert.ok(job, "ci.yml has a plan-lint job");
    assert.ok(
      job.steps.some((s) => s.run === "node tools/plan-lint/plan-lint.mjs"),
      "it runs plan-lint",
    );
    for (const step of job.steps) {
      assert.doesNotMatch(step.uses ?? "", /pnpm\/action-setup/);
      assert.doesNotMatch(step.run ?? "", /\bpnpm\b|\bnpm (?:ci|install)\b/);
    }
    const code = job.lines.filter((line) => !/^\s*#/.test(line)).join("\n");
    assert.doesNotMatch(code, /cache: pnpm|pnpm install|pnpm\/action-setup/);
  });

  it("[X-019 AC2] build-test runs the guards and check-package-json before the install and the tests", () => {
    const guardsAt = stepIndex("build-test", (s) => s.name === "Repository guards");
    const checkAt = stepIndex("build-test", (s) => s.run === "node tools/ci/check-package-json.mjs");
    const installAt = stepIndex("build-test", (s) => s.run === "pnpm install --frozen-lockfile");
    const ciTestsAt = stepIndex("build-test", (s) =>
      /node --test tools\/ci\/\*\.test\.mjs/.test(s.run ?? ""),
    );
    const lintAt = stepIndex("build-test", (s) => s.run === "pnpm lint");
    const testAt = stepIndex("build-test", (s) => s.run === "pnpm test");
    // The integration tests run in their own job since lead decision (5o) of 2026-11-05 (the next test).
    const intInstallAt = stepIndex("integration", (s) => s.run === "pnpm install --frozen-lockfile");
    const intAt = stepIndex("integration", (s) => s.run === "pnpm test:int");
    for (const [name, at] of Object.entries({
      guardsAt,
      checkAt,
      installAt,
      ciTestsAt,
      lintAt,
      testAt,
      intInstallAt,
      intAt,
    })) {
      assert.ok(at >= 0, `step ${name} exists`);
    }
    assert.ok(guardsAt < installAt && checkAt < installAt, "guards and package checks need no install");
    assert.ok(installAt < ciTestsAt && ciTestsAt < testAt, "CI-script tests run before the tests");
    assert.ok(intInstallAt < intAt, "the integration tests run after their job's install");
    assert.ok(lintAt < testAt);
  });

  it("[X-019 AC2] the integration tests and the PAN-absence proof run in their own job beside build-test, set up as it is", () => {
    // Lead decision (5o) of 2026-11-05, approved by the owner.
    assert.ok(JOBS.get("integration"), "ci.yml has an integration job");
    assert.deepEqual(jobKey("integration", "name"), ["    name: Integration tests"]);
    // In parallel: neither job waits for the other (no `needs`), and the same 45-minute budget.
    assert.deepEqual(jobKey("integration", "needs"), []);
    assert.deepEqual(jobKey("build-test", "needs"), []);
    assert.deepEqual(jobKey("integration", "timeout-minutes"), ["    timeout-minutes: 45"]);
    assert.deepEqual(jobKey("build-test", "timeout-minutes"), ["    timeout-minutes: 45"]);
    // The same runner, service containers and environment as build-test, line for line.
    for (const key of ["runs-on", "services", "env"]) {
      assert.ok(jobKey("integration", key).length > 0, `integration has ${key}`);
      assert.deepEqual(jobKey("integration", key), jobKey("build-test", key), key);
    }

    // Its steps: the setup of build-test (the same pinned actions and the same commands), then the tests and the proof.
    const steps = JOBS.get("integration").steps;
    const buildTest = JOBS.get("build-test").steps;
    const uses = (list, action) => list.find((s) => (s.uses ?? "").startsWith(`${action}@`));
    const same = (list, run) => list.find((s) => s.run === run);
    const bootstrap = (list) => list.find((s) => /deploy\/postgres\/bootstrap\.sql/.test(s.run ?? ""));
    const pan = steps.find((s) => (s.name ?? "").startsWith("PAN-absence proof"));
    const order = [
      uses(steps, "actions/checkout"),
      uses(steps, "pnpm/action-setup"),
      uses(steps, "actions/setup-node"),
      same(steps, "pnpm install --frozen-lockfile"),
      uses(steps, "actions/cache/restore"),
      bootstrap(steps),
      same(steps, "pnpm dev:keys"),
      same(steps, "pnpm test:int"),
      pan,
    ];
    assert.ok(order.every(Boolean), "every step of the integration job is there");
    assert.deepEqual(order, steps, "and nothing else, in this order");
    for (const action of ["actions/checkout", "pnpm/action-setup", "actions/setup-node"]) {
      assert.equal(uses(steps, action).uses, uses(buildTest, action).uses, action);
    }
    assert.ok(withOf(uses(steps, "actions/checkout")).includes("persist-credentials: false"));
    assert.deepEqual(
      withOf(uses(steps, "actions/setup-node")),
      withOf(uses(buildTest, "actions/setup-node")),
    );
    assert.equal(bootstrap(steps).run, bootstrap(buildTest).run);
    assert.ok(same(buildTest, "pnpm dev:keys"));
    // The Turborepo cache of build-test, restored only (build-test saves it), at the same pinned commit.
    const cache = uses(buildTest, "actions/cache");
    const restore = uses(steps, "actions/cache/restore");
    assert.equal(restore.uses.split("@")[1], cache.uses.split("@")[1]);
    assert.deepEqual(withOf(restore), withOf(cache));

    // The proof reads the report that pnpm test:int leaves, after it, and fails without it (OBE-052).
    assert.match(pan.run, /ota\/backend\/node_modules\/\.cache\/pan-absence\/report\.json/);
    assert.match(pan.run, /The PAN-absence test did not run/);
    assert.equal(pan.if, undefined, "it runs whenever the tests passed");

    // build-test keeps everything else: no integration tests or proof there any more; Build, then the cross-backend
    // tests and the release dry run.
    assert.equal(
      stepIndex("build-test", (s) => s.run === "pnpm test:int"),
      -1,
    );
    assert.equal(
      stepIndex("build-test", (s) => /pan-absence/.test(s.run ?? "")),
      -1,
    );
    const buildAt = stepIndex("build-test", (s) => s.run === "pnpm build");
    const xbAt = stepIndex("build-test", (s) => s.run === "pnpm --filter @velexis/platform-backend test:xb");
    const packAt = stepIndex("build-test", (s) => /pack-release\.sh/.test(s.run ?? ""));
    assert.ok(buildAt > stepIndex("build-test", (s) => s.run === "pnpm test"));
    assert.ok(buildAt < xbAt && xbAt < packAt);
    // Only build-test saves the Turborepo cache.
    assert.ok(cache, "build-test restores and saves the cache with actions/cache");
    assert.equal(uses(steps, "actions/cache"), undefined);
  });

  it("[FIX-W46-SHARED AC5] deploy-files runs the health check test and keeps velexis-healthcheck in the sandbox loop", () => {
    // Lead decision (11i) of 2026-11-06, approved by the owner.
    const node = stepIndex("deploy-files", (s) => (s.uses ?? "").startsWith("actions/setup-node@"));
    const deployTest = stepIndex("deploy-files", (s) => s.run === "bash deploy/scripts/test/deploy.test.sh");
    const healthTest = stepIndex("deploy-files", (s) =>
      /^bash deploy\/scripts\/test\/healthcheck\.test\.sh$/m.test(s.run ?? ""),
    );
    assert.ok(
      node >= 0 && deployTest >= 0 && healthTest >= 0,
      "setup-node, deploy.test.sh and healthcheck.test.sh",
    );
    assert.ok(node < healthTest, "the fake endpoints of healthcheck.test.sh need Node");
    const healthStep = JOBS.get("deploy-files").steps[healthTest];
    // A failing health check test fails the job: the step runs on every pull request and is never allowed to fail.
    assert.equal(healthStep.if, undefined, "the health check test always runs");
    assert.equal(healthStep["continue-on-error"], undefined, "a failing health check test fails the job");
    assert.deepEqual(jobKey("deploy-files", "continue-on-error"), [], "and the job with it");
    const run = healthStep.run;
    assert.match(run, /for tool in curl jq openssl; do/, "it checks the tools the runner image must have");
    assert.match(
      run,
      /apt-get install -y --no-install-recommends "\$\{missing\[@\]\}"/,
      "and installs only a missing one",
    );

    // The unit list of the sandboxing loop, expanded by bash as the step expands it.
    const sandbox = JOBS.get("deploy-files").steps.find((s) => /systemd-analyze security/.test(s.run ?? ""));
    assert.ok(sandbox, "deploy-files has the unit sandboxing step");
    assert.equal(sandbox.if, undefined, "the sandboxing step always runs");
    assert.equal(sandbox["continue-on-error"], undefined, "an exposure above 2.0 fails the job");
    const list = sandbox.run.match(/for unit in ([\s\S]*?); do/)?.[1];
    assert.ok(list, "the step loops over a unit list");
    const units = execFileSync("bash", ["-c", `printf '%s\\n' ${list.replace(/\\\n/g, " ")}`], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    const apps = [
      "platform-api",
      "platform-worker",
      "portal",
      "platform-admin",
      "ota-api",
      "ota-worker",
      "ota-admin",
    ];
    // velexis-egress-refresh since lead decision (17a) of 2026-11-11 (FIX-W49-SHARED AC4).
    assert.deepEqual(units, [
      ...apps.map((app) => `deploy/systemd/velexis-${app}.service`),
      "deploy/systemd/velexis-alert@.service",
      "deploy/systemd/velexis-healthcheck.service",
      "deploy/systemd/velexis-egress-refresh.service",
    ]);
    for (const unit of units) {
      assert.ok(readFileSync(join(ROOT, unit), "utf8").includes("[Service]"), `${unit} exists`);
    }
    assert.match(sandbox.name, /velexis-healthcheck/);
    assert.match(sandbox.name, /velexis-egress-refresh/);
  });

  it("[FIX-W47-SHARED AC6] build-test lints and tests tools/perf with the CI checks, before the tests", () => {
    // Lead decision (13c) of 2026-11-10, approved by the owner.
    const at = stepIndex("build-test", (s) => /node --test tools\/ci\/\*\.test\.mjs/.test(s.run ?? ""));
    assert.ok(at >= 0, "build-test has the step of the CI checks");
    const step = JOBS.get("build-test").steps[at];
    const lines = step.run.split("\n");
    for (const line of [
      "pnpm exec eslint tools/ci",
      "node --test tools/ci/*.test.mjs",
      "pnpm exec eslint tools/perf",
      "node --test tools/perf/*.test.mjs",
    ]) {
      assert.ok(lines.includes(line), `the step runs: ${line}`);
    }
    assert.equal(step.if, undefined, "it always runs");
    assert.equal(step["continue-on-error"], undefined, "a failing perf test fails the job");
    assert.ok(
      at > stepIndex("build-test", (s) => s.run === "pnpm install --frozen-lockfile"),
      "after the install",
    );
    assert.ok(at < stepIndex("build-test", (s) => s.run === "pnpm test"), "before the tests");
    // The glob matches the unit tests of the smoke script's helpers.
    const perfTests = readdirSync(join(ROOT, "tools/perf")).filter((f) => f.endsWith(".test.mjs"));
    assert.ok(perfTests.includes("platform-smoke.test.mjs"), "tools/perf/platform-smoke.test.mjs exists");
  });

  it("[FIX-W47-SHARED AC7] a job of its own runs check-vm.test.sh as root on ubuntu-24.04 with a real sshd", () => {
    // Lead decision (13l) of 2026-11-10, approved by the owner.
    const job = JOBS.get("check-vm");
    assert.ok(job, "ci.yml has a check-vm job");
    assert.deepEqual(jobKey("check-vm", "name"), ["    name: VM check test"]);
    assert.deepEqual(jobKey("check-vm", "runs-on"), ["    runs-on: ubuntu-24.04"]);
    const timeout = jobKey("check-vm", "timeout-minutes")[0]?.match(/^ {4}timeout-minutes: (\d+)$/)?.[1];
    assert.ok(
      timeout !== undefined && Number(timeout) > 0 && Number(timeout) <= 30,
      "a timeout of at most 30 minutes",
    );
    // It always runs and a failure fails it: no condition, no continue-on-error, on the job or any step.
    assert.deepEqual(jobKey("check-vm", "if"), [], "no condition on the job");
    assert.deepEqual(jobKey("check-vm", "continue-on-error"), [], "no continue-on-error on the job");
    assert.deepEqual(jobKey("check-vm", "needs"), [], "it waits for no other job");
    const code = job.lines.filter((line) => !/^\s*#/.test(line)).join("\n");
    assert.doesNotMatch(
      code,
      /^\s*(?:if|continue-on-error):/m,
      "no condition and no continue-on-error anywhere",
    );

    const steps = job.steps;
    const checkout = steps.find((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    assert.ok(checkout, "it checks out the repository");
    assert.ok(withOf(checkout).includes("persist-credentials: false"));
    const ssh = steps.findIndex((s) =>
      /apt-get install -y --no-install-recommends openssh-server/.test(s.run ?? ""),
    );
    const test = steps.findIndex((s) =>
      /^sudo bash deploy\/scripts\/test\/check-vm\.test\.sh\b/m.test(s.run ?? ""),
    );
    assert.ok(ssh >= 0, "it installs openssh-server when the image lacks it");
    // Without /run/sshd, sshd -t fails ("Missing privilege separation directory") and the real-sshd checks are skipped.
    assert.match(
      steps[ssh].run,
      /^sudo install -d -m 0755 -o root -g root \/run\/sshd$/m,
      "it creates sshd's privilege separation folder",
    );
    assert.ok(test > ssh, "and then runs check-vm.test.sh as root");
    const run = steps[test].run;
    assert.match(run, /^set -o pipefail$/m, "a failing test fails the step through the pipe");
    // The real-sshd checks must have run: the test's last line says so only when they did.
    assert.match(run, /grep -qx 'check-vm\.test: all checks passed'/);
    assert.ok(
      readFileSync(join(ROOT, "deploy/scripts/test/check-vm.test.sh"), "utf8").includes(
        'echo "check-vm.test: all checks passed"',
      ),
      "check-vm.test.sh prints that line",
    );
  });

  it("[FIX-W49-SHARED AC4] the VM check job installs nftables when the image lacks it, and the test needs the real nft", () => {
    // Lead decision (17a) of 2026-11-11, approved by the owner: the real-nftables part of check-vm.test.sh always runs.
    const steps = JOBS.get("check-vm").steps;
    const nft = steps.findIndex((s) =>
      /apt-get install -y --no-install-recommends nftables$/m.test(s.run ?? ""),
    );
    const test = steps.findIndex((s) =>
      /^sudo bash deploy\/scripts\/test\/check-vm\.test\.sh\b/m.test(s.run ?? ""),
    );
    assert.ok(nft >= 0, "it installs nftables");
    assert.match(steps[nft].run, /^if \[ ! -x \/usr\/sbin\/nft \]; then$/m, "only when the image lacks it");
    assert.match(steps[nft].run, /^dpkg-query -W nftables$/m, "and fails the step when it is not installed");
    assert.equal(steps[nft].if, undefined, "the install always runs");
    assert.ok(test > nft, "before check-vm.test.sh");
    assert.match(steps[test].run, /grep -qx 'check-vm\.test: all checks passed'/);
    // The test fails when its real-nft part cannot run, and its last line names it, as the sshd case's does.
    const script = readFileSync(join(ROOT, "deploy/scripts/test/check-vm.test.sh"), "utf8");
    assert.match(script, /^REAL_NFT_RAN=0$/m);
    assert.match(
      script,
      /^ {2}REAL_NFT_RAN=1$/m,
      "set only where the real nft works in a private network namespace",
    );
    assert.match(
      script,
      /^ {2}fail "the real-nft checks of step 6b did not run: .*\[FIX-W49-SHARED AC4\]"$/m,
      "a FAIL line, which sets FAILED, when it cannot run",
    );
    assert.doesNotMatch(script, /NOTE the real-nft checks did not run/, "no longer a NOTE");
    const end = script.slice(script.lastIndexOf("\necho\n"));
    assert.match(
      end,
      /^if \[ "\$REAL_NFT_RAN" != 1 \]; then\n {2}echo "check-vm\.test: FAILED \(the real-nft checks of step 6b did not run: /m,
      "its last line names the real-nft checks first",
    );
    assert.match(end, /\[ "\$FAILED" = 0 \]\s*$/, "and the test exits 1");
  });

  it("[FIX-W49-SHARED AC4] the units smoke test rates and starts velexis-egress-refresh.service, with nftables on the runner", () => {
    // Lead decision (17a) of 2026-11-11, approved by the owner.
    const steps = JOBS.get("systemd-units").steps;
    const nft = steps.findIndex((s) =>
      /apt-get install -y --no-install-recommends nftables$/m.test(s.run ?? ""),
    );
    const smoke = steps.findIndex((s) => /deploy\/systemd\/test\/units-smoke\.sh/.test(s.run ?? ""));
    assert.ok(nft >= 0 && smoke > nft, "nftables is installed before the units smoke test");
    assert.match(steps[nft].run, /^if \[ ! -x \/usr\/sbin\/nft \]; then$/m);
    assert.equal(steps[nft].if, undefined);
    const script = readFileSync(join(ROOT, "deploy/systemd/test/units-smoke.sh"), "utf8");
    const rated = script.match(/^SANDBOXED_UNITS=\(([^)]*)\)$/m)?.[1] ?? "";
    assert.ok(rated.split(/\s+/).includes("velexis-egress-refresh"), "rated with the other units (step 1)");
    assert.match(
      script,
      /render_unit "\$UNITS\/velexis-egress-refresh\.service" "\$E_UNIT"/,
      "a test copy of the unit",
    );
    assert.match(script, /egress\.sh" "\$SBIN\/velexis-egress"/, "running the real velexis-egress");
    // It never starts without a network namespace of its own: the table's policy drop would cut the runner off.
    const guard = script.indexOf('grep -qx "NetworkNamespacePath=/run/netns/$NETNS" "$E_FILE" || die');
    const netns = script.indexOf('ip netns add "$NETNS"');
    const start = script.indexOf('systemctl start "$E_UNIT"');
    assert.ok(
      guard > 0 && netns > guard && start > netns,
      "the namespace is checked and made before the start",
    );
    assert.match(script, /^for tool in nft ip; do /m, "it needs nft and ip");
    for (const unit of ["velexis-egress-refresh.service", "velexis-egress-refresh.timer"]) {
      assert.ok(readFileSync(join(ROOT, "deploy/systemd", unit), "utf8").length > 0, `${unit} exists`);
    }
  });

  it("[X-032 AC2] alt-hosts runs the integration tests with PostgreSQL and Redis on other hosts and ports, over TLS", () => {
    const job = JOBS.get("alt-hosts");
    assert.ok(job, "ci.yml has an alt-hosts job");
    assert.deepEqual(jobKey("alt-hosts", "name"), ["    name: Integration tests on other hosts and ports"]);
    assert.deepEqual(jobKey("alt-hosts", "runs-on"), jobKey("integration", "runs-on"));
    assert.deepEqual(jobKey("alt-hosts", "timeout-minutes"), ["    timeout-minutes: 45"]);
    assert.deepEqual(jobKey("alt-hosts", "needs"), [], "in parallel with the other jobs");
    const code = job.lines.filter((line) => !/^\s*#/.test(line)).join("\n");
    assert.doesNotMatch(
      code,
      /^\s*(?:if|continue-on-error):/m,
      "no condition and no continue-on-error anywhere",
    );

    // The services of the integration job, published on 6543 and 6380 instead of the default ports.
    const services = jobKey("alt-hosts", "services").join("\n");
    assert.equal(
      services
        .replace('ports: ["6543:5432"]', 'ports: ["5432:5432"]')
        .replace('ports: ["6380:6379"]', 'ports: ["6379:6379"]'),
      jobKey("integration", "services").join("\n"),
      "the integration job's services, on other host ports",
    );
    assert.match(services, /ports: \["6543:5432"\]/);
    assert.match(services, /ports: \["6380:6379"\]/);

    // The integration job's variables; the DSNs name other hosts and ports and carry the TLS parameters.
    const env = mapOf(jobKey("alt-hosts", "env"));
    const integrationEnv = mapOf(jobKey("integration", "env"));
    assert.deepEqual(Object.keys(env).sort(), Object.keys(integrationEnv).sort(), "the same variables");
    const dsns = [
      "DATABASE_URL",
      "DATABASE_MIGRATOR_URL",
      "DATABASE_PROVISIONER_URL",
      "TEST_DATABASE_ADMIN_URL",
    ];
    for (const name of dsns) {
      const url = new URL(env[name]);
      const original = new URL(integrationEnv[name]);
      assert.equal(url.host, "pg.internal.test:6543", name);
      assert.equal(
        `${url.username}:${url.password}${url.pathname}`,
        `${original.username}:${original.password}${original.pathname}`,
      );
      assert.equal(url.search, "?sslmode=verify-full&sslrootcert=/tmp/pg-tls/ca.crt", name);
    }
    assert.equal(env.REDIS_URL, "redis://redis.internal.test:6380/0");
    for (const [name, value] of Object.entries(env)) {
      if (![...dsns, "REDIS_URL"].includes(name)) {
        assert.equal(value, integrationEnv[name], name);
      }
    }
    assert.doesNotMatch(
      code,
      /127\.0\.0\.1:(?:5432|6379)|localhost|-h 127\.0\.0\.1/,
      "no default host or port",
    );

    // Its steps, in this order and nothing else: the host names, PostgreSQL's TLS, the integration job's setup with
    // check-no-hardcoded-hosts.mjs after the install, then the tests.
    const steps = job.steps;
    const integration = JOBS.get("integration").steps;
    const uses = (list, action) => list.find((s) => (s.uses ?? "").startsWith(`${action}@`));
    const same = (list, run) => list.find((s) => s.run === run);
    const hosts = steps.find((s) => /sudo tee -a \/etc\/hosts/.test(s.run ?? ""));
    const tls = steps.find((s) => /ALTER SYSTEM SET ssl = on/.test(s.run ?? ""));
    const bootstrap = steps.find((s) => /deploy\/postgres\/bootstrap\.sql/.test(s.run ?? ""));
    const order = [
      uses(steps, "actions/checkout"),
      hosts,
      tls,
      uses(steps, "pnpm/action-setup"),
      uses(steps, "actions/setup-node"),
      same(steps, "pnpm install --frozen-lockfile"),
      same(steps, "node tools/ci/check-no-hardcoded-hosts.mjs"),
      uses(steps, "actions/cache/restore"),
      bootstrap,
      same(steps, "pnpm dev:keys"),
      same(steps, "pnpm test:int"),
    ];
    assert.ok(order.every(Boolean), "every step of the alt-hosts job is there");
    assert.deepEqual(order, steps, "and nothing else, in this order");
    for (const action of [
      "actions/checkout",
      "pnpm/action-setup",
      "actions/setup-node",
      "actions/cache/restore",
    ]) {
      assert.equal(uses(steps, action).uses, uses(integration, action).uses, action);
      assert.deepEqual(withOf(uses(steps, action)), withOf(uses(integration, action)), action);
    }
    const integrationBootstrap = integration.find((s) =>
      /deploy\/postgres\/bootstrap\.sql/.test(s.run ?? ""),
    );
    assert.equal(
      bootstrap.run,
      integrationBootstrap.run.replaceAll("psql -h 127.0.0.1 ", "psql -h pg.internal.test -p 6543 "),
      "the integration job's bootstrap, on the other host and port",
    );

    // Both names resolve to the runner, and nothing may answer on the default ports.
    assert.match(
      hosts.run,
      /^echo "127\.0\.0\.1 pg\.internal\.test redis\.internal\.test" \| sudo tee -a \/etc\/hosts$/m,
    );
    assert.match(hosts.run, /for port in 5432 6379; do/);
    assert.match(hosts.run, /\/dev\/tcp\/127\.0\.0\.1\/\$port/);
    // PostgreSQL refuses every TCP connection without TLS and serves a certificate for pg.internal.test of the CA
    // that the DSNs name; the step proves both before the tests start.
    assert.match(tls.run, /echo "hostnossl all all all reject"; cat "\$PGDATA\/pg_hba\.conf"/);
    assert.match(tls.run, /-subj "\/CN=pg\.internal\.test"/);
    assert.match(tls.run, /subjectAltName=DNS:pg\.internal\.test/);
    assert.match(tls.run, /-c "SELECT pg_reload_conf\(\)"/);
    assert.match(tls.run, /sslmode=verify-full sslrootcert=\/tmp\/pg-tls\/ca\.crt/);
    assert.match(
      tls.run,
      /sslmode=disable" .*then\n\s*echo "::error::PostgreSQL accepted a connection without TLS"/,
    );
    assert.match(tls.raw.join("\n"), /PG_CONTAINER: \$\{\{ job\.services\.postgres\.id \}\}/);
    assert.ok(existsSync(join(ROOT, "tools/ci/check-no-hardcoded-hosts.mjs")), "the checker exists");
  });

  it("[X-019 AC5] every uses: in .github/workflows is pinned to a 40-character commit SHA", () => {
    const dir = join(ROOT, ".github/workflows");
    let uses = 0;
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
        if (m) {
          uses += 1;
          assert.match(m[1], /^(?:\.\/|[\w.-]+\/[\w./-]+@[0-9a-f]{40}$)/, `${file}: ${line.trim()}`);
        }
      }
    }
    assert.ok(uses > 0);
  });

  it("[X-019 AC2] the guards step uses no ${{ }} expression, so it runs here exactly as in CI", () => {
    assert.ok(GUARDS, "build-test has a Repository guards step");
    assert.doesNotMatch(GUARDS, /\$\{\{/);
  });
});

describe("dependabot.yml", () => {
  // GitHub validates the file when it is pushed (AC4); this keeps the agreed policy from drifting.
  const text = readFileSync(join(ROOT, ".github/dependabot.yml"), "utf8");
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  /** The `ignore` entry of one dependency name: its line and its update-types line. */
  const ignoreRule = (name) =>
    text.match(
      new RegExp(`^ {6}- dependency-name: ${escape(name)}(?: #.*)?\\n {8}update-types: .*$`, "m"),
    )?.[0] ?? "";

  it("[X-019 AC4] weekly npm updates, minor and patch only, in the four groups", () => {
    assert.match(text, /^version: 2$/m);
    assert.match(text, /- package-ecosystem: npm\n {4}directory: \/\n {4}schedule:\n {6}interval: weekly/);
    assert.match(text, /^ {4}versioning-strategy: increase$/m);
    for (const group of ["nestjs", "next-react", "tooling", "types"]) {
      const at = text.search(new RegExp(`^ {6}${group}:$`, "m"));
      assert.ok(at > 0, `group ${group}`);
      assert.match(text.slice(at).split(/\n {6}\S/)[0], /update-types: \[minor, patch\]/, group);
    }
    for (const pattern of ["eslint", "prettier", "turbo", "vitest", "typescript-eslint"]) {
      assert.match(text, new RegExp(`^ {10}- ${pattern}$`, "m"), `tooling: ${pattern}`);
    }
    assert.match(ignoreRule('"*"'), /version-update:semver-major/);
  });

  it("[X-019 AC4] the ignore rules keep TypeScript 5.6, Node types 22, Next.js 15 and NestJS 11", () => {
    assert.match(ignoreRule("typescript"), /semver-major.*semver-minor/);
    for (const name of ['"@types/node"', "next", '"@next/*"', '"@nestjs/*"']) {
      assert.match(ignoreRule(name), /"version-update:semver-major"/, name);
    }
  });

  it("[X-019 AC4] the ignore rules keep the other minor lines of tech-stack.md (patches only)", () => {
    for (const name of [
      "kysely",
      "kysely-codegen",
      "openapi-fetch",
      "esbuild",
      "pdfmake",
      "handlebars",
      "cookie-parser",
      "tailwindcss",
      '"@tailwindcss/*"',
    ]) {
      assert.match(ignoreRule(name), /"version-update:semver-minor"/, name);
    }
  });

  it("[X-019 AC4] weekly github-actions updates", () => {
    assert.match(
      text,
      /- package-ecosystem: github-actions\n {4}directory: \/\n {4}schedule:\n {6}interval: weekly/,
    );
  });
});

describe("repository guards", () => {
  it("[X-019 AC2] a pull request adding a session-level search_path change in platform/ fails the guards", () => {
    const pr = repo(
      {},
      { "platform/backend/src/tenant.ts": `await sql.raw("${SESSION_SET} TO tenant_alpha");\n` },
    );
    const { status, out } = guards(pr);
    assert.notEqual(status, 0, out);
    assert.match(out, /platform\/backend\/src\/tenant\.ts:1:/);
    assert.ok(out.includes(`::error::Session-level ${SESSION_SET} outside packages/db`), out);
  });

  it("[X-019 AC2] the search_path guard covers every app and package, any case, SQL and JS too", () => {
    const lower = SESSION_SET.toLowerCase().replace(" ", " session ");
    for (const [path, content] of Object.entries({
      "ota/backend/migrations/tenant/0002_x.sql": `${lower} = tenant_alpha;\n`,
      "packages/testing/src/db.ts": `${SESSION_SET} TO tenant_alpha\n`,
      "tools/reference-data/src/load.mjs": `${SESSION_SET} TO reference\n`,
      "platform/frontend/src/page.tsx": `${SESSION_SET} TO platform\n`,
    })) {
      const { status, out } = guards(repo({}, { [path]: content }));
      assert.notEqual(status, 0, `${path}: ${out}`);
      assert.ok(out.includes(`${path}:1:`), out);
    }
  });

  it("[X-019 AC2] the session-level forms set_config(..., false) and a quoted search_path fail the guards", () => {
    for (const [path, content] of Object.entries({
      "platform/backend/src/a.ts": `await sql\`select ${SESSION_SET_CONFIG("${schema}")}\`;\n`,
      "ota/backend/src/b.ts": `db.query("SELECT ${SESSION_SET_CONFIG("quote_ident($1)")}");\n`,
      "packages/testing/src/c.sql": `${SESSION_SET.replace("search_path", '"search_path"')} TO x;\n`,
    })) {
      const { status, out } = guards(repo({}, { [path]: content }));
      assert.notEqual(status, 0, `${path}: ${out}`);
      assert.ok(out.includes(`${path}:1:`), out);
    }
    // packages/db (the migration runner and its leak-guard tests) stays exempt.
    const db = repo({}, { "packages/db/src/migrate.ts": `${SESSION_SET_CONFIG("$1")}\n` });
    const dbRun = guards(db);
    assert.equal(dbRun.status, 0, dbRun.out);
  });

  it("[X-019 AC2] packages/db, transaction-level SET LOCAL and set_config(..., true) pass the guards", () => {
    const pr = repo(
      {},
      {
        "packages/db/src/tenant-tx.ts": `${SESSION_SET} TO pg_catalog\n`,
        "ota/backend/src/a.ts": `${SESSION_SET.replace(" ", " LOCAL ")} TO tenant_alpha\n`,
        "ota/backend/src/b.ts": "select set_config('search_path', $1, true)\n",
        "ota/backend/node_modules/x/index.ts": `${SESSION_SET} TO x\n`,
      },
    );
    const { status, out } = guards(pr);
    assert.equal(status, 0, out);
  });

  it("[X-019 AC2] a pull request editing docs/velexis-sdk/ or docs/amadeus-api/ fails the guards", () => {
    for (const path of ["docs/velexis-sdk/sdk/src/shared.d.ts", "docs/amadeus-api/flight-offers.json"]) {
      const pr = repo({ "docs/amadeus-api/flight-offers.json": "{}\n" }, { [path]: "changed\n" });
      const { status, out } = guards(pr);
      assert.notEqual(status, 0, `${path}: ${out}`);
      assert.ok(out.includes(path), out);
      assert.match(out, /::error::docs\/velexis-sdk and docs\/amadeus-api are reference material/);
    }
  });

  it("[X-019 AC2] the reference-material guard applies to pull requests only", () => {
    const push = repo({}, { "docs/velexis-sdk/sdk/src/shared.d.ts": "changed\n" });
    assert.equal(guards(push, "push").status, 0);
    assert.equal(guards(push, "workflow_dispatch").status, 0);
  });

  it("[X-019 AC2] a baseline migration that differs from the reference DDL fails the guards", () => {
    const reference = { "docs/velexis-sdk/db/platform.sql": "create table a ();\n" };
    const same = repo(reference, {
      "platform/backend/migrations/platform/0001_baseline.sql": "create table a ();\n",
    });
    assert.equal(guards(same, "push").status, 0);
    const differs = repo(reference, {
      "platform/backend/migrations/platform/0001_baseline.sql": "create table b ();\n",
    });
    const { status, out } = guards(differs, "push");
    assert.notEqual(status, 0, out);
    assert.match(out, /::error::platform\/backend\/migrations\/platform\/0001_baseline\.sql differs from/);
  });

  it("[X-019 AC2] a clean pull request and this repository pass the guards", () => {
    const clean = repo({}, { "packages/config/src/index.ts": "export const ok = true;\n" });
    assert.equal(guards(clean).status, 0);
    const self = guards(ROOT, "push");
    assert.equal(self.status, 0, self.out);
  });
});

describe("lint", () => {
  it("[X-019 AC2] a test containing it.only fails lint", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: ROOT });
    const code = 'import { describe, it, test } from "vitest";\n';
    for (const [file, focused] of [
      ["ota/sdk/test/client.test.js", 'it.only("x", () => {});'],
      ["ota/frontend/test/search.test.js", 'describe.only("x", () => {});'],
      ["tools/e2e/specs/booking.e2e.ts", 'test.only("x", () => {});'],
    ]) {
      const [result] = await eslint.lintText(`${code}${focused}\n`, { filePath: join(ROOT, file) });
      const errors = result.messages.filter((m) => m.severity === 2);
      assert.ok(
        errors.some((m) => m.ruleId === "no-restricted-properties" && /focused tests/.test(m.message)),
        `${file}: ${JSON.stringify(result.messages)}`,
      );
    }
    // Type-aware sources (packages/*/src, apps' src and test) need their tsconfig to parse; the rule is the same.
    for (const file of [
      "packages/config/src/env.test.ts",
      "packages/db/test/integration/tenant.int.test.ts",
      "platform/backend/test/health.test.ts",
      "platform/frontend/src/components/button.test.tsx",
    ]) {
      const config = await eslint.calculateConfigForFile(join(ROOT, file));
      const [severity, ...options] = config.rules["no-restricted-properties"];
      assert.ok(severity === 2 || severity === "error", `${file}: severity ${severity}`);
      for (const object of ["it", "test", "describe"]) {
        assert.ok(
          options.some((o) => o.object === object && o.property === "only"),
          `${file}: ${object}.only`,
        );
      }
    }
  });
});
