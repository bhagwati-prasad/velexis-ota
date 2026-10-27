// The e2e workflow as PFE-014 step 5 and PADR-0017 describe it. actionlint checks that the file is a valid workflow
// (tools/e2e/README.md); these tests check what it does.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "../support/stack";

interface Step {
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
    readonly pull_request?: { readonly types?: readonly string[] };
    readonly push?: unknown;
  };
  readonly permissions: Record<string, string>;
  readonly jobs: Record<
    string,
    {
      readonly if?: string;
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

/** The run of the projects that need no Stripe: the platform's (PFE-014) and the storefront (OFE-008). */
const PROJECTS_RUN = "pnpm test:e2e -- --project=portal --project=platform-admin --project=storefront";

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
    expect(runs.filter((run) => /--project=storefront/.test(run))).toHaveLength(1);
  });

  it("runs portal-stripe only at night and only with the Stripe test secrets (PADR-0017 item 4)", () => {
    const stripe = steps.find((step) => /--project=portal-stripe/.test(step.run ?? ""));
    expect(stripe?.if).toBe("github.event_name == 'schedule' && env.STRIPE_CONFIGURED == 'true'");
    expect(stripe?.env?.["E2E_STRIPE"]).toBe("1");
    expect(runs.filter((run) => /portal-stripe/.test(run))).toHaveLength(1);
  });

  it("uploads traces, screenshots, the report and the stack's logs when a step fails [PFE-014 AC2]", () => {
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("failure()");
    const paths = String(upload?.with?.["path"] ?? "")
      .split("\n")
      .filter(Boolean);
    expect(paths).toEqual(["tools/e2e/test-results/", "tools/e2e/playwright-report/"]);
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
