// The e2e workflow as PFE-014 step 5 and PADR-0017 describe it, with the OTA projects nightly and before each deploy
// and the summary of their launch gate (OFE-026). actionlint checks that the file is a valid workflow
// (tools/e2e/README.md); these tests check what it does. tools/ci/deploy-e2e-workflow.test.mjs checks how deploy.yml
// calls it, its concurrency and the conditions of its Stripe steps and upload (lead decision (15c) of 2026-11-11).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT, resultsFolders } from "../support/stack";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}

interface Workflow {
  readonly on: {
    readonly schedule?: readonly { readonly cron: string }[];
    readonly workflow_dispatch?: unknown;
    readonly workflow_call?: unknown;
    readonly pull_request?: { readonly types?: readonly string[] };
    readonly push?: unknown;
  };
  readonly permissions: Record<string, string>;
  readonly jobs: Record<
    string,
    {
      readonly if?: string;
      readonly "timeout-minutes"?: number;
      readonly services: Record<string, { readonly image: string }>;
      readonly env: Record<string, string>;
      readonly steps: readonly Step[];
    }
  >;
}

const workflow = parse(readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8")) as Workflow;
const job = workflow.jobs["e2e"];
const steps = job?.steps ?? [];
const runs = steps.map((step) => step.run ?? "");
const indexOfRun = (pattern: RegExp): number => runs.findIndex((run) => pattern.test(run));

/** The run of the projects that need no Stripe: the platform's (PFE-014), the storefront (OFE-008), the OTA admin (OAD-016). */
const PROJECTS_RUN =
  "pnpm test:e2e -- --project=portal --project=platform-admin --project=storefront --project=ota-admin";

describe(".github/workflows/e2e.yml", () => {
  it("runs nightly, on demand and on pull requests labelled e2e only [PFE-014 AC2]", () => {
    expect(workflow.on.schedule?.[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on.pull_request?.types).toContain("labeled");
    expect(workflow.on).not.toHaveProperty("push");
    expect(job?.if).toBe(
      "github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'e2e')",
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("has PostgreSQL 16, Redis 7.4 and Mailpit as services [PFE-014 AC2]", () => {
    expect(Object.values(job?.services ?? {}).map((service) => service.image.split(":")[0])).toEqual([
      "postgres",
      "redis",
      "axllent/mailpit",
    ]);
    expect(job?.services["postgres"]?.image).toBe("postgres:16");
    expect(job?.services["redis"]?.image).toBe("redis:7.4");
  });

  it("builds everything, then runs the portal and platform-admin projects [PFE-014 AC2]", () => {
    const bootstrap = indexOfRun(/deploy\/postgres\/bootstrap\.sql/);
    const build = runs.indexOf("pnpm build");
    const browsers = indexOfRun(/playwright install --with-deps chromium/);
    // OFE-008 added the storefront project to the same run.
    const projects = runs.indexOf(PROJECTS_RUN);
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(bootstrap);
    expect(browsers).toBeGreaterThan(build);
    expect(projects).toBeGreaterThan(browsers);
    expect(steps[projects]?.if).toBeUndefined();
    expect(job?.env).toMatchObject({
      TEST_DATABASE_ADMIN_URL: expect.stringMatching(/^postgres:\/\/velexis_test_admin:/),
      REDIS_URL: expect.stringMatching(/^redis:\/\//),
      SMTP_URL: "smtp://127.0.0.1:1025",
      MAILPIT_API_URL: "http://127.0.0.1:8025",
      E2E_WITH_OTA: "1",
    });
  });

  it("runs the storefront project in the same run, against the stack with the OTA backend [OFE-008 AC1]", () => {
    const projects = runs.indexOf(PROJECTS_RUN);
    expect(projects).toBeGreaterThan(runs.indexOf("pnpm build"));
    expect(steps[projects]?.if).toBeUndefined();
    expect(steps[projects]?.name).toContain("[OFE-008 AC1]");
    // The storefront project exists only with E2E_WITH_OTA=1 (playwright.config.ts), which the job sets for every step.
    expect(job?.env["E2E_WITH_OTA"]).toBe("1");
    expect(steps[projects]?.env?.["E2E_WITH_OTA"]).toBeUndefined();
    // `pnpm dev:keys` before the stack: the OTA backend's dev:seed hashes the demo OTA's keys with the pepper.
    expect(indexOfRun(/^pnpm dev:keys$/)).toBeGreaterThanOrEqual(0);
    expect(indexOfRun(/^pnpm dev:keys$/)).toBeLessThan(projects);
    // The project's whole name: `--project=storefront-stripe` (OFE-017, nightly) is another project.
    expect(runs.filter((run) => /--project=storefront(?![\w-])/.test(run))).toHaveLength(1);
  });

  it("runs the ota-admin project in the same run, nightly and on labelled pull requests [OAD-016 AC1]", () => {
    const projects = runs.indexOf(PROJECTS_RUN);
    expect(projects).toBeGreaterThan(runs.indexOf("pnpm build"));
    expect(steps[projects]?.if).toBeUndefined();
    expect(steps[projects]?.name).toContain("[OAD-016 AC1]");
    // The project exists only with E2E_WITH_OTA=1, which the job sets: the stack then starts the built OTA admin.
    expect(job?.env["E2E_WITH_OTA"]).toBe("1");
    expect(runs.filter((run) => /--project=ota-admin(?![\w-])/.test(run))).toHaveLength(1);
  });

  it("runs portal-stripe only at night and only with the Stripe test secrets (PADR-0017 item 4)", () => {
    const stripe = steps.find((step) => /--project=portal-stripe/.test(step.run ?? ""));
    // Since lead decision (15c) of 2026-11-11 also after a failed earlier Playwright step, once the set-up passed.
    expect(stripe?.if).toBe(
      "!cancelled() && steps.browsers.outcome == 'success' && github.event_name == 'schedule' && " +
        "env.STRIPE_CONFIGURED == 'true'",
    );
    expect(stripe?.env?.["E2E_STRIPE"]).toBe("1");
    expect(runs.filter((run) => /portal-stripe/.test(run))).toHaveLength(1);
  });

  it("[PFE-027 AC1] runs portal-stripe with Stripe Billing on and the pinned Stripe CLI, checksum checked as storefront-stripe does", () => {
    // Lead decision 5(l) of 2026-11-05, approved by the owner (FIX-W43-SHARED).
    const portal = steps.find((step) => /--project=portal-stripe/.test(step.run ?? ""));
    const storefront = steps.find((step) => /--project=storefront-stripe/.test(step.run ?? ""));
    // The platform's two Stripe test values, and the harness setting that turns Stripe Billing on for this step's stack
    // and starts the billing forwarder; no OTA key, so the stack starts no forwarder of the OTA's.
    expect(portal?.env).toEqual({
      E2E_STRIPE: "1",
      STRIPE_SECRET_KEY: "${{ secrets.E2E_STRIPE_SECRET_KEY }}",
      STRIPE_BILLING_WEBHOOK_SECRET: "${{ secrets.E2E_STRIPE_BILLING_WEBHOOK_SECRET }}",
      E2E_STRIPE_BILLING: "1",
      // Its own results folder (lead decision (15c) of 2026-11-11).
      E2E_RESULTS_SUBDIR: "portal-stripe",
    });
    // One pinned release for both steps, in the job's environment; neither step names another.
    expect(job?.env).toMatchObject({
      STRIPE_CLI_VERSION: expect.stringMatching(/^1\.\d+\.\d+$/),
      STRIPE_CLI_SHA256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    for (const step of [portal, storefront]) {
      expect(step?.env?.["STRIPE_CLI_VERSION"]).toBeUndefined();
      expect(step?.env?.["STRIPE_CLI_SHA256"]).toBeUndefined();
    }
    // The same download and checksum check as the storefront-stripe step, then the project with that CLI, every test
    // of it counted: no --pass-with-no-tests now that PFE-027's journey is there.
    const portalLines = (portal?.run ?? "").trim().split("\n");
    const storefrontLines = (storefront?.run ?? "").trim().split("\n");
    expect(portalLines.slice(0, -1)).toEqual(storefrontLines.slice(0, -1));
    expect(portalLines[1]).toBe('echo "${STRIPE_CLI_SHA256}  $RUNNER_TEMP/stripe.tgz" | sha256sum -c -');
    expect(portalLines.at(-1)).toBe(
      'E2E_STRIPE_CLI="$RUNNER_TEMP/stripe-cli/stripe" pnpm test:e2e -- --project=portal-stripe',
    );
    expect(portal?.run).not.toContain("--pass-with-no-tests");
    // Stripe Billing stays off in every other step's stack, the storefront-stripe one's among them.
    expect(steps.filter((step) => step.env?.["E2E_STRIPE_BILLING"] !== undefined)).toEqual([portal]);
    expect(job?.env["E2E_STRIPE_BILLING"]).toBeUndefined();
  });

  it("runs storefront-stripe nightly and on demand, never on a pull request, with the Stripe test keys and the Stripe CLI whose checksum it checked [OFE-017 AC1] [OFE-026 AC1]", () => {
    const index = steps.findIndex((step) => /--project=storefront-stripe/.test(step.run ?? ""));
    const step = steps[index];
    // OAD-017's payments journey runs in this project too (lead decision (2e) of 2026-10-31, FIX-W37-OTA): the name says so.
    expect(step?.name).toBe(
      "[OFE-017 AC1] [OFE-017 AC2] [OAD-017] Stripe storefront and OTA admin payment journeys (nightly and on demand, project storefront-stripe)",
    );
    // Nightly and on demand (the run before each deploy, OFE-026; until then nightly only), never on a pull request,
    // and only when the three secrets exist: the platform's two (E2E_STRIPE=1 needs them) and the publishable key of
    // the same test account; since lead decision (15c) of 2026-11-11 also after a failed earlier Playwright step.
    expect(step?.if).toBe(
      "!cancelled() && steps.browsers.outcome == 'success' && github.event_name != 'pull_request' && " +
        "env.STOREFRONT_STRIPE_CONFIGURED == 'true'",
    );
    expect(job?.env["STOREFRONT_STRIPE_CONFIGURED"]).toBe(
      "${{ secrets.E2E_STRIPE_SECRET_KEY != '' && secrets.E2E_STRIPE_BILLING_WEBHOOK_SECRET != '' && " +
        "secrets.E2E_STRIPE_PUBLISHABLE_KEY != '' }}",
    );
    expect(step?.env).toMatchObject({
      E2E_STRIPE: "1",
      STRIPE_SECRET_KEY: "${{ secrets.E2E_STRIPE_SECRET_KEY }}",
      STRIPE_BILLING_WEBHOOK_SECRET: "${{ secrets.E2E_STRIPE_BILLING_WEBHOOK_SECRET }}",
      STRIPE_SECRET_KEY_TEST: "${{ secrets.E2E_STRIPE_SECRET_KEY }}",
      STRIPE_PUBLISHABLE_KEY_TEST: "${{ secrets.E2E_STRIPE_PUBLISHABLE_KEY }}",
    });
    // The pinned release and its SHA-256, in the job's environment since the portal-stripe step downloads the same CLI
    // (lead decision 5(l) of 2026-11-05).
    expect(job?.env).toMatchObject({
      STRIPE_CLI_VERSION: expect.stringMatching(/^1\.\d+\.\d+$/),
      STRIPE_CLI_SHA256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The pinned release binary, its SHA-256 checked before anything runs, then the journeys with that CLI.
    const lines = (step?.run ?? "").trim().split("\n");
    expect(lines[0]).toMatch(
      /^curl -fsSL -o "\$RUNNER_TEMP\/stripe\.tgz" "https:\/\/github\.com\/stripe\/stripe-cli\/releases\/download\/v\$\{STRIPE_CLI_VERSION\}\//,
    );
    expect(lines[1]).toBe('echo "${STRIPE_CLI_SHA256}  $RUNNER_TEMP/stripe.tgz" | sha256sum -c -');
    expect(lines.at(-1)).toBe(
      'E2E_STRIPE_CLI="$RUNNER_TEMP/stripe-cli/stripe" pnpm test:e2e -- --project=storefront-stripe',
    );
    // After the other runs, and the only one of the project; the run of the other projects never selects it.
    expect(index).toBeGreaterThan(runs.indexOf(PROJECTS_RUN));
    expect(index).toBeGreaterThan(
      steps.findIndex((other) => /--project=portal-stripe/.test(other.run ?? "")),
    );
    // (Its project argument: the launch gate's summary, OFE-026, names the project in its table.)
    expect(runs.filter((run) => /--project=storefront-stripe/.test(run))).toHaveLength(1);
    expect(index).toBeLessThan(
      steps.findIndex((other) => other.uses?.startsWith("actions/upload-artifact@")),
    );
  });

  it("runs the SDK's smoke tests last, nightly and on demand, against the OTA backend with dev:seed's keys [SDK-014 AC1]", () => {
    const index = steps.findIndex((step) => /--filter @velexis\/ota-sdk test:smoke/.test(step.run ?? ""));
    const step = steps[index];
    expect(step?.name).toContain("[SDK-014 AC1]");
    // Never on a pull request, labelled or not; on the nightly schedule and on demand, with or without Stripe secrets.
    expect(step?.if).toBe("github.event_name != 'pull_request'");
    // After every Playwright run (they stop their stacks, so the API's and the stub's ports are free), before the upload.
    const playwrightRuns = steps.flatMap((other, at) => (/pnpm test:e2e/.test(other.run ?? "") ? [at] : []));
    expect(playwrightRuns.length).toBeGreaterThanOrEqual(3);
    expect(index).toBeGreaterThan(Math.max(...playwrightRuns));
    expect(index).toBeLessThan(
      steps.findIndex((other) => other.uses?.startsWith("actions/upload-artifact@")),
    );
    const lines = (step?.run ?? "").trim().split("\n");
    // The development values of the .env.example files, the database and seeds, the stub, both dev:seed commands, the API.
    expect(lines[0]).toBe(
      'for dir in . platform/backend ota/backend; do cp "$dir/.env.example" "$dir/.env.local"; done',
    );
    expect(lines).toContain('pnpm db:migrate > "$logs/db-migrate.log"');
    expect(lines).toContain('node tools/amadeus-stub/dist/cli.js > "$logs/amadeus-stub.log" 2>&1 &');
    expect(lines).toContain("node platform/backend/dist/cli.js dev:seed > /dev/null");
    expect(lines).toContain('seed="$(node ota/backend/dist/cli.js dev:seed)"');
    expect(lines).toContain('node ota/backend/dist/main.js > "$logs/ota-api.log" 2>&1 &');
    // The processes stop with the step; their output goes where the upload step finds it.
    expect(lines).toContain("logs=tools/e2e/test-results/sdk-smoke");
    expect(lines).toContain("trap 'jobs -p | xargs -r kill' EXIT");
    // The keys reach the tests in their environment only: no line prints the seed's output. Each key is read from the
    // line of its label (dev-seed.command.ts DEV_SEED_KEY_LABELS; FIX-W37-OTA: two of the three are sk_test keys).
    expect(lines.filter((line) => /\$seed/.test(line))).toEqual([
      `SDK_SMOKE_PUBLISHABLE_KEY="$(printf '%s\\n' "$seed" | grep -E '^  Publishable test key ' | grep -Eo 'pk_test_[A-Za-z0-9]{40}')" \\`,
      `  SDK_SMOKE_SECRET_KEY="$(printf '%s\\n' "$seed" | grep -E '^  Secret test key ' | grep -Eo 'sk_test_[A-Za-z0-9]{40}')" \\`,
      `  SDK_SMOKE_CONSOLE_KEY="$(printf '%s\\n' "$seed" | grep -E '^  Console automation test key ' | grep -Eo 'sk_test_[A-Za-z0-9]{40}')" \\`,
    ]);
    expect(lines.at(-1)).toBe("  pnpm --filter @velexis/ota-sdk test:smoke");
    expect(runs.filter((run) => /test:smoke/.test(run))).toHaveLength(1);
  });

  it("uploads traces, screenshots, the report and the stack's logs when a step fails or the run is cancelled [PFE-014 AC2]", () => {
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    // Also on cancellation (a newer pull-request run, the job's timeout): lead decision (15c) of 2026-11-11.
    expect(upload?.if).toBe("failure() || cancelled()");
    const paths = String(upload?.with?.["path"] ?? "")
      .split("\n")
      .filter(Boolean);
    expect(paths).toEqual(["tools/e2e/test-results/", "tools/e2e/playwright-report/"]);
  });

  it("[FIX-W48-SHARED AC4] gives each Playwright step its own output, report and stack-log folders under the uploaded paths", () => {
    const playwrightSteps = steps.filter((step) => /pnpm test:e2e/.test(step.run ?? ""));
    const subdirs = playwrightSteps.map((step) => step.env?.["E2E_RESULTS_SUBDIR"]);
    expect(subdirs).toEqual(["projects", "portal-stripe", "storefront-stripe"]);
    // What playwright.config.ts and the global setup make of them: three folders of each kind, all different, each
    // inside test-results/ or playwright-report/, which the upload takes; the SDK smoke step keeps its own folder.
    const folders = subdirs.map((subdir) => resultsFolders(subdir));
    for (const kind of ["outputDir", "reportDir", "stackLogDir"] as const) {
      expect(new Set(folders.map((folder) => folder[kind])).size).toBe(3);
    }
    for (const folder of folders) {
      expect(folder.outputDir).toMatch(/^test-results\/[a-z-]+$/);
      expect(folder.reportDir).toMatch(/^playwright-report\/[a-z-]+$/);
      expect(folder.stackLogDir).toBe(join(REPO_ROOT, "tools/e2e", folder.outputDir, "stack"));
    }
    expect(subdirs).not.toContain("sdk-smoke");
    // The job's own environment sets none, so no step inherits another's folder.
    expect(job?.env["E2E_RESULTS_SUBDIR"]).toBeUndefined();
  });

  it("[FIX-W48-SHARED AC4] has a timeout for the four projects and both Stripe steps, and the trigger Deploy calls", () => {
    expect(job?.["timeout-minutes"]).toBe(45);
    expect(workflow.on).toHaveProperty("workflow_call");
  });
});

describe("the OTA projects nightly and before each deploy (OFE-026)", () => {
  const projects = steps.findIndex((step) => step.id === "projects");
  const storefrontStripe = steps.findIndex((step) => step.id === "storefront-stripe");
  const upload = steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const summary = steps.findIndex((step) => step.name?.startsWith("[OFE-026 AC1] "));
  /** The steps that run Playwright. */
  const playwrightSteps = steps.filter((step) => /pnpm test:e2e/.test(step.run ?? ""));

  it("[OFE-026 AC1] runs storefront and ota-admin on every run and storefront-stripe nightly and on demand, before the upload of their traces", () => {
    // Nightly and on demand: the schedule, and the manual run of Actions > E2E > Run workflow before each deploy.
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    // storefront and ota-admin: the step of the four projects, on every run of the job (no condition of its own).
    expect(steps[projects]?.run).toBe(PROJECTS_RUN);
    expect(steps[projects]?.if).toBeUndefined();
    // storefront-stripe: every run but a pull request's, when the Stripe test secrets exist, also after a failed
    // earlier Playwright step (lead decision (15c) of 2026-11-11).
    expect(steps[storefrontStripe]?.run?.trim()).toMatch(/ --project=storefront-stripe$/);
    expect(steps[storefrontStripe]?.if).toBe(
      "!cancelled() && steps.browsers.outcome == 'success' && github.event_name != 'pull_request' && " +
        "env.STOREFRONT_STRIPE_CONFIGURED == 'true'",
    );
    // A failed step's traces, screenshots, report and stack logs are uploaded after both, also when the run is
    // cancelled (lead decision (15c) of 2026-11-11), and nothing runs a Playwright step after the upload.
    expect(upload).toBeGreaterThan(Math.max(projects, storefrontStripe));
    expect(steps[upload]?.if).toBe("failure() || cancelled()");
    expect(steps.slice(upload).filter((step) => /pnpm test:e2e/.test(step.run ?? ""))).toEqual([]);
  });

  it("[OFE-026 AC1] quarantines nothing: no Playwright run retries, filters, tolerates a failure or passes without tests", () => {
    expect(playwrightSteps.length).toBe(3);
    for (const step of playwrightSteps) {
      const run = step.run ?? "";
      expect(run, step.name).not.toMatch(
        /--retries|--grep|--last-failed|--only-changed|--pass-with-no-tests|--max-failures/,
      );
      expect(run, step.name).not.toMatch(/\|\|\s*true|;\s*true\s*$/m);
      expect(step, step.name).not.toHaveProperty("continue-on-error");
    }
    expect(job).not.toHaveProperty("continue-on-error");
  });

  describe("the summary of the launch gate", () => {
    const script = steps[summary]?.run ?? "";
    interface Outcome {
      readonly summary: string;
      readonly stdout: string;
    }
    /** The summary and the annotations the step writes for an event and the outcomes of the two steps. */
    const CASES = {
      nightlyGreen: {
        EVENT: "schedule",
        PROJECTS_OUTCOME: "success",
        STOREFRONT_STRIPE_OUTCOME: "success",
        STOREFRONT_STRIPE_CONFIGURED: "true",
      },
      nightlyNoSecrets: {
        EVENT: "schedule",
        PROJECTS_OUTCOME: "success",
        STOREFRONT_STRIPE_OUTCOME: "skipped",
        STOREFRONT_STRIPE_CONFIGURED: "false",
      },
      nightlyStripeFailed: {
        EVENT: "schedule",
        PROJECTS_OUTCOME: "success",
        STOREFRONT_STRIPE_OUTCOME: "failure",
        STOREFRONT_STRIPE_CONFIGURED: "true",
      },
      nightlyProjectsFailed: {
        EVENT: "schedule",
        PROJECTS_OUTCOME: "failure",
        STOREFRONT_STRIPE_OUTCOME: "skipped",
        STOREFRONT_STRIPE_CONFIGURED: "true",
      },
      // storefront-stripe runs after a failed step of the four projects since lead decision (15c) of 2026-11-11: the
      // run still does not count for the gate.
      nightlyProjectsFailedStripePassed: {
        EVENT: "schedule",
        PROJECTS_OUTCOME: "failure",
        STOREFRONT_STRIPE_OUTCOME: "success",
        STOREFRONT_STRIPE_CONFIGURED: "true",
      },
      // The job's timeout (or a newer run of the same ref) cancelled storefront-stripe while it ran.
      nightlyStripeCancelled: {
        EVENT: "schedule",
        PROJECTS_OUTCOME: "success",
        STOREFRONT_STRIPE_OUTCOME: "cancelled",
        STOREFRONT_STRIPE_CONFIGURED: "true",
      },
      beforeDeploy: {
        EVENT: "workflow_dispatch",
        PROJECTS_OUTCOME: "success",
        STOREFRONT_STRIPE_OUTCOME: "success",
        STOREFRONT_STRIPE_CONFIGURED: "true",
      },
      pullRequest: {
        EVENT: "pull_request",
        PROJECTS_OUTCOME: "success",
        STOREFRONT_STRIPE_OUTCOME: "skipped",
        STOREFRONT_STRIPE_CONFIGURED: "false",
      },
    } as const;
    const outcomes = new Map<keyof typeof CASES, Outcome>();
    const dir = mkdtempSync(join(tmpdir(), "ofe-026-summary-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    // Each case runs the step's script in bash with the options GitHub's `run` uses (`bash --noprofile --norc -eo
    // pipefail`) and a summary file of its own: a few milliseconds idle, more on a loaded runner. They run here, once,
    // with this budget; the tests read what they wrote.
    beforeAll(() => {
      for (const [name, env] of Object.entries(CASES) as [keyof typeof CASES, Record<string, string>][]) {
        const file = join(dir, `${name}.md`);
        writeFileSync(file, "");
        const stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
          env: { PATH: process.env["PATH"] ?? "", GITHUB_STEP_SUMMARY: file, ...env },
          encoding: "utf8",
        });
        outcomes.set(name, { summary: readFileSync(file, "utf8"), stdout });
      }
    }, 30_000);

    it("[OFE-026 AC1] runs after every other step, whatever happened before, and reads the outcomes of the two steps", () => {
      expect(summary).toBe(steps.length - 1);
      expect(steps[summary]?.if).toBe("always()");
      expect(steps[summary]?.env).toEqual({
        EVENT: "${{ github.event_name }}",
        PROJECTS_OUTCOME: "${{ steps.projects.outcome }}",
        STOREFRONT_STRIPE_OUTCOME: "${{ steps.storefront-stripe.outcome }}",
      });
    });

    it("[OFE-026 AC1] counts a nightly run for the gate only when storefront, ota-admin and storefront-stripe all passed", () => {
      const green = outcomes.get("nightlyGreen");
      expect(green?.summary).toContain("| storefront | passed |");
      expect(green?.summary).toContain("| ota-admin | passed |");
      expect(green?.summary).toContain("| storefront-stripe | passed |");
      expect(green?.summary).toContain("Counts for the launch gate: yes.");
      expect(green?.stdout).toBe("");
      for (const name of [
        "nightlyNoSecrets",
        "nightlyStripeFailed",
        "nightlyProjectsFailed",
        "nightlyProjectsFailedStripePassed",
        "nightlyStripeCancelled",
        "beforeDeploy",
        "pullRequest",
      ] as const) {
        expect(outcomes.get(name)?.summary, name).toContain(
          "Counts for the launch gate: no: a nightly run counts only when all three projects ran and passed.",
        );
        expect(outcomes.get(name)?.summary, name).not.toContain("Counts for the launch gate: yes.");
      }
      expect(outcomes.get("nightlyStripeFailed")?.summary).toContain("| storefront-stripe | failed |");
      // A failed step of the four projects says so for both OTA projects, since a failed portal test fails it too.
      const projectsFailed =
        "the step of the four projects failed: its annotations name each failed test and its project";
      expect(outcomes.get("nightlyProjectsFailed")?.summary).toContain(`| storefront | ${projectsFailed} |`);
      expect(outcomes.get("nightlyProjectsFailed")?.summary).toContain(`| ota-admin | ${projectsFailed} |`);
      expect(outcomes.get("nightlyProjectsFailed")?.summary).toContain(
        "| storefront-stripe | not run: an earlier step failed or the run was cancelled |",
      );
      expect(outcomes.get("nightlyProjectsFailedStripePassed")?.summary).toContain(
        `| storefront | ${projectsFailed} |`,
      );
      expect(outcomes.get("nightlyStripeCancelled")?.summary).toContain(
        "| storefront-stripe | cancelled: the run was cancelled or timed out |",
      );
      // The run before a deploy shows the same table, and is no nightly run.
      expect(outcomes.get("beforeDeploy")?.summary).toContain("| storefront-stripe | passed |");
    });

    it("[OFE-026 AC1] warns on the run's page when storefront-stripe could not run for want of the Stripe test secrets", () => {
      const missing = outcomes.get("nightlyNoSecrets");
      expect(missing?.summary).toContain("| storefront | passed |");
      expect(missing?.summary).toContain(
        "| storefront-stripe | not run: the repository has no Stripe test secrets |",
      );
      expect(missing?.stdout).toMatch(
        /^::warning title=storefront-stripe did not run::.*E2E_STRIPE_PUBLISHABLE_KEY/m,
      );
      // A pull request never runs it: no warning there, and no secret's value anywhere (the step names them only).
      expect(outcomes.get("pullRequest")?.summary).toContain(
        "| storefront-stripe | not run: never on a pull request |",
      );
      expect(outcomes.get("pullRequest")?.stdout).toBe("");
      expect(steps[summary]?.run).not.toContain("secrets.");
    });
  });
});

describe("the test:e2e script of @velexis/e2e", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "tools/e2e/package.json"), "utf8")) as {
    readonly scripts: Record<string, string>;
  };
  // `<build> && <run>`: the run part has an `&&` of its own.
  const script = manifest.scripts["test:e2e"] ?? "";
  const build = script.slice(0, script.indexOf(" && "));
  const run = script.slice(script.indexOf(" && ") + " && ".length);
  // A stand-in `playwright` that prints its arguments, one per line.
  const bin = mkdtempSync(join(tmpdir(), "pfe-014-playwright-"));
  writeFileSync(join(bin, "playwright"), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(join(bin, "playwright"), 0o755);
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  /** What `playwright` receives when pnpm appends `args` to the script, as it does for `pnpm test:e2e <args>`. */
  const playwrightArgs = (args: string): string[] =>
    execFileSync("sh", ["-c", `${run} ${args}`], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` },
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

  /** The arguments the tests below append, as the workflow and a developer pass them. */
  const CASES = [
    "",
    "-- --project\\=portal --project\\=platform-admin",
    "--project=portal specs/smoke.e2e.ts",
  ];
  /** What `playwright` received for each of CASES, collected in the setup hook. */
  const received = new Map<string, string[]>();

  // Each case runs the script's shell commands in child processes: milliseconds idle, more on a loaded runner. They
  // run here, once, with this budget, and not inside the tests' 5 s; the tests assert on what they printed.
  beforeAll(() => {
    for (const args of CASES) {
      received.set(args, playwrightArgs(args));
    }
  }, 30_000);

  it("builds the tooling, then runs playwright test", () => {
    expect(build).toBe("pnpm run build:tools");
    expect(received.get("")).toEqual(["test"]);
  });

  it("hands the workflow's --project arguments to playwright test without the -- that pnpm forwards [PFE-014 AC2]", () => {
    expect(received.get("-- --project\\=portal --project\\=platform-admin")).toEqual([
      "test",
      "--project=portal",
      "--project=platform-admin",
    ]);
    expect(received.get("--project=portal specs/smoke.e2e.ts")).toEqual([
      "test",
      "--project=portal",
      "specs/smoke.e2e.ts",
    ]);
  });
});
