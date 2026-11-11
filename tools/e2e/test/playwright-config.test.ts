// The projects of playwright.config.ts (PFE-014, OFE-008, OFE-017, OAD-016, OAD-017, PFE-027): which exist with and
// without E2E_WITH_OTA=1 and E2E_STRIPE=1, and which tests each selects. `playwright test --list` shows the same against
// the specs themselves. OFE-026: what CI keeps of a failed test, and that the OTA projects quarantine nothing.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type PlaywrightTestConfig, type Project } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectsFor } from "../playwright.config";
import { PROJECT_TAGS } from "../support/fixtures";
import { OTA_ADMIN_URL, PORTAL_URL, REPO_ROOT, STOREFRONT_URL } from "../support/stack";

const names = (projects: readonly Project[]): (string | undefined)[] =>
  projects.map((project) => project.name);
const byName = (projects: readonly Project[], name: string): Project | undefined =>
  projects.find((project) => project.name === name);
/** The patterns of a project's `grep` or `grepInvert`, as a list. */
const patterns = (value: Project["grep"]): RegExp[] => (value === undefined ? [] : [value].flat());
/** Whether a test titled `title` with `tag` is selected by `project`'s grep and grepInvert, as Playwright decides. */
function selects(project: Project | undefined, title: string): boolean {
  const grep = patterns(project?.grep);
  const grepInvert = patterns(project?.grepInvert);
  return (
    (grep.length === 0 || grep.some((pattern) => pattern.test(title))) &&
    !grepInvert.some((pattern) => pattern.test(title))
  );
}

describe("projectsFor", () => {
  it("has the storefront-stripe project only with E2E_WITH_OTA=1 and E2E_STRIPE=1 [OFE-017 AC1]", () => {
    expect(names(projectsFor({ withOta: false, withStripe: false }))).toEqual(["portal", "platform-admin"]);
    expect(names(projectsFor({ withOta: true, withStripe: false }))).toEqual([
      "portal",
      "platform-admin",
      "storefront",
      "ota-admin",
    ]);
    expect(names(projectsFor({ withOta: false, withStripe: true }))).toEqual([
      "portal",
      "platform-admin",
      "portal-stripe",
    ]);
    expect(names(projectsFor({ withOta: true, withStripe: true }))).toEqual([
      "portal",
      "platform-admin",
      "storefront",
      "ota-admin",
      "portal-stripe",
      "storefront-stripe",
    ]);
  });

  it("has the ota-admin project only with E2E_WITH_OTA=1: the OTA admin's specs against the built OTA admin [OAD-016 AC1]", () => {
    expect(names(projectsFor({ withOta: false, withStripe: true }))).not.toContain("ota-admin");
    for (const withStripe of [false, true]) {
      const projects = projectsFor({ withOta: true, withStripe });
      const otaAdmin = byName(projects, "ota-admin");
      expect(otaAdmin).toMatchObject({
        testMatch: ["specs/ota-admin/**/*.e2e.ts"],
        use: { baseURL: OTA_ADMIN_URL },
      });
      expect(OTA_ADMIN_URL).toBe("http://127.0.0.1:3002");
      const journey = "the OTA admin's SSO and bookings journey › issues the manual-review booking";
      expect(selects(otaAdmin, journey)).toBe(true);
      // A journey that needs Stripe over the network never runs in it.
      expect(selects(otaAdmin, `a payments journey › captures ${PROJECT_TAGS.stripe}`)).toBe(false);
      // No other project selects the OTA admin's specs: they are no storefront, portal or platform admin spec. The one
      // exception is the nightly payments journey of OAD-017, which needs storefront-stripe's stack (below).
      for (const project of projects.filter((candidate) => candidate.name !== "ota-admin")) {
        const otaAdminSpecs = [project.testMatch]
          .flat()
          .filter((match) => String(match).includes("ota-admin"));
        expect(otaAdminSpecs).toEqual(
          project.name === "storefront-stripe" ? ["specs/ota-admin/payments.e2e.ts"] : [],
        );
      }
    }
  });

  it("runs the storefront's @stripe tests in storefront-stripe only, against the demo OTA's storefront [OFE-017 AC1]", () => {
    const projects = projectsFor({ withOta: true, withStripe: true });
    const storefront = byName(projects, "storefront");
    const storefrontStripe = byName(projects, "storefront-stripe");
    expect(storefrontStripe).toMatchObject({
      testMatch: ["specs/storefront/**/*.e2e.ts", "specs/ota-admin/payments.e2e.ts"],
      use: { baseURL: STOREFRONT_URL },
    });
    expect(storefront?.testMatch).toEqual(["specs/storefront/**/*.e2e.ts"]);

    const stripeTest = `the guest Stripe checkout journey › pays ${PROJECT_TAGS.stripe}`;
    const searchTest = "the M2 search journey › searches";
    expect(selects(storefrontStripe, stripeTest)).toBe(true);
    expect(selects(storefront, stripeTest)).toBe(false);
    expect(selects(storefrontStripe, searchTest)).toBe(false);
    expect(selects(storefront, searchTest)).toBe(true);
    // A whole tag only: a hypothetical `@stripe-connect` is not `@stripe`.
    expect(selects(storefrontStripe, "a test @stripe-connect")).toBe(false);
    // The portal's Stripe project is unchanged: the portal's specs, on the portal.
    expect(byName(projects, "portal-stripe")).toMatchObject({
      testMatch: ["specs/portal-*.e2e.ts"],
      use: { baseURL: PORTAL_URL },
    });
    expect(selects(byName(projects, "portal"), stripeTest)).toBe(false);
  });

  it("runs the portal's M5 journeys in portal and its Checkout journey nightly in portal-stripe only [PFE-027 AC1]", () => {
    const projects = projectsFor({ withOta: true, withStripe: true });
    const portal = byName(projects, "portal");
    const portalStripe = byName(projects, "portal-stripe");
    // Every portal journey's file is in both projects; the tags decide which runs where.
    for (const project of [portal, portalStripe]) {
      expect([project?.testMatch].flat()).toContain("specs/portal-*.e2e.ts");
    }
    for (const journey of [
      "specs/portal-domains.e2e.ts › adding a custom domain shows the pending view with its DNS records and Check now",
      "specs/portal-payments.e2e.ts › saving a valid test IBAN asks for a step-up first",
      "specs/portal-go-live.e2e.ts › once the preconditions are met, Go live switches the OTA to live",
    ]) {
      expect(selects(portal, journey), journey).toBe(true);
      expect(selects(portalStripe, journey), journey).toBe(false);
    }
    const checkout = `the portal's Stripe Checkout and Customer Portal journey ${PROJECT_TAGS.stripe} › the owner pays with the test card`;
    expect(selects(portalStripe, checkout)).toBe(true);
    expect(selects(portal, checkout)).toBe(false);
    // Without E2E_STRIPE=1 nothing runs the Checkout journey: the project does not exist.
    expect(names(projectsFor({ withOta: true, withStripe: false }))).not.toContain("portal-stripe");
  });

  it("finds the tags those projects select in the M5 portal specs themselves: only the Checkout journey is @stripe [PFE-027 AC1]", () => {
    const spec = (file: string): string => readFileSync(join(REPO_ROOT, "tools/e2e/specs", file), "utf8");
    // The three journeys of `portal` carry no `@stripe` anywhere, so `portal` runs them and `portal-stripe` never does.
    for (const file of ["portal-domains.e2e.ts", "portal-payments.e2e.ts", "portal-go-live.e2e.ts"]) {
      const source = spec(file);
      expect(source, file).not.toMatch(/PROJECT_TAGS\.stripe|["'`]@stripe/);
      expect(source, file).toMatch(/\[PFE-027 AC1\]/);
    }
    // Every test of the Checkout journey is in one describe tagged `@stripe` (and none outside it), so it runs only in
    // the nightly `portal-stripe`.
    const checkout = spec("portal-checkout.e2e.ts");
    expect(checkout).toMatch(
      /test\.describe\(\s*"the portal's Stripe Checkout and Customer Portal journey",\s*\{ tag: PROJECT_TAGS\.stripe \},/,
    );
    expect(checkout.match(/^test\(/gm) ?? []).toEqual([]);
    expect((checkout.match(/^ {4}test\("/gm) ?? []).length).toBe(4);
  });

  it("runs the OTA admin's payments journey nightly in storefront-stripe, never in ota-admin [OAD-017 step 1]", () => {
    const projects = projectsFor({ withOta: true, withStripe: true });
    const storefrontStripe = byName(projects, "storefront-stripe");
    const otaAdmin = byName(projects, "ota-admin");
    // The spec is in both projects' files; its tests carry `@stripe`, so only storefront-stripe runs them.
    expect([storefrontStripe?.testMatch].flat()).toContain("specs/ota-admin/payments.e2e.ts");
    expect(otaAdmin?.testMatch).toEqual(["specs/ota-admin/**/*.e2e.ts"]);
    const payments = `the OTA admin's payments journey › the owner refunds part of the captured payment ${PROJECT_TAGS.stripe}`;
    expect(selects(storefrontStripe, payments)).toBe(true);
    expect(selects(otaAdmin, payments)).toBe(false);
    // Only the nightly stack has the project: without E2E_STRIPE=1 nothing runs the journey.
    expect(names(projectsFor({ withOta: true, withStripe: false }))).not.toContain("storefront-stripe");
    // The OTA admin's other journeys stay out of storefront-stripe: they carry no `@stripe`.
    expect(
      selects(storefrontStripe, "the OTA admin's settings › a new primary colour reaches the storefront"),
    ).toBe(false);
  });

  it("runs the platform admin's M5 journeys in platform-admin, and both journeys of the live pool hold it [PAD-015 AC1]", () => {
    const spec = (file: string): string => readFileSync(join(REPO_ROOT, "tools/e2e/specs", file), "utf8");
    for (const withStripe of [false, true]) {
      const projects = projectsFor({ withOta: true, withStripe });
      const platformAdmin = byName(projects, "platform-admin");
      // The files are the platform admin's (`specs/admin-*.e2e.ts`), never the portal's.
      expect([platformAdmin?.testMatch].flat()).toContain("specs/admin-*.e2e.ts");
      expect([byName(projects, "portal")?.testMatch].flat()).not.toContain("specs/admin-*.e2e.ts");
      for (const journey of [
        "specs/admin-settlements.e2e.ts › marking it paid asks for a step-up too, and the owners get the e-mail",
        "specs/admin-live-office.e2e.ts › releasing the office needs the confirmation and a reason",
        "specs/admin-domains.e2e.ts › Remove asks for a reason, removes the domain and e-mails the owners",
      ]) {
        expect(selects(platformAdmin, journey), journey).toBe(true);
      }
    }
    // Every step of the three journeys proves the task's criterion; none is a Stripe journey or skipped.
    for (const file of ["admin-settlements.e2e.ts", "admin-live-office.e2e.ts", "admin-domains.e2e.ts"]) {
      const source = spec(file);
      expect(source, file).not.toMatch(/PROJECT_TAGS\.stripe|["'`]@stripe|\.skip\(|\.only\(/);
      const steps = source.match(/^test\("[^"]+"/gm) ?? [];
      expect(steps.length, file).toBeGreaterThanOrEqual(4);
      for (const step of steps) {
        expect(step, file).toMatch(/\[PAD-015 AC1\]"$/);
      }
      expect(source, file).toContain('test.describe.configure({ mode: "serial" });');
    }
    // The Velexis live pool: the two journeys that use the live account take it before their first step and give it
    // back at their end (support/seed.ts `holdVelexisLivePool`), and the live office journey leaves it as it found it.
    for (const file of ["admin-amadeus-pool.e2e.ts", "admin-live-office.e2e.ts"]) {
      const source = spec(file);
      expect(source, file).toMatch(/test\.beforeAll\([\s\S]*livePool = await holdVelexisLivePool\(\);/);
      expect(source, file).toMatch(/test\.afterAll\([\s\S]*await livePool\?\.release\(\);/);
    }
    expect(spec("admin-live-office.e2e.ts")).toMatch(
      /test\.afterAll\([\s\S]*await restoreVelexisLivePool\(\{/,
    );
  });
});

describe("the configuration's projects from the environment", () => {
  /** playwright.config.ts loaded afresh with `env`. */
  const loadConfig = async (env: Record<string, string>): Promise<PlaywrightTestConfig> => {
    vi.resetModules();
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    // The configuration is a CommonJS module: TypeScript types `default` of its dynamic import as the whole module,
    // while Vitest hands over its default export, the configuration.
    const { default: config } = (await import("../playwright.config.js")) as unknown as {
      readonly default: PlaywrightTestConfig;
    };
    vi.unstubAllEnvs();
    return config;
  };
  /** The project names of playwright.config.ts loaded afresh with `env`. */
  const loadWith = async (env: Record<string, string>): Promise<(string | undefined)[]> =>
    names((await loadConfig(env)).projects ?? []);

  let withStripe: (string | undefined)[] = [];
  let withoutStripe: (string | undefined)[] = [];
  let stripeWithoutOta: (string | undefined)[] = [];
  /** The configuration as the e2e workflow's steps load it: CI set, the OTA stack and the Stripe projects. */
  let inCi: PlaywrightTestConfig = {};
  /** The same as the workflow's storefront-stripe step loads it, with its own results folder (FIX-W48-SHARED). */
  let inCiStep: PlaywrightTestConfig = {};
  /** What loading it with a results folder that is a path threw. */
  let badSubdir: unknown;

  // Loading the configuration four times compiles it and its support files afresh each time (a second or so idle):
  // here, once, with this budget, not inside the tests' 5 s.
  beforeAll(async () => {
    withStripe = await loadWith({ E2E_WITH_OTA: "1", E2E_STRIPE: "1" });
    withoutStripe = await loadWith({ E2E_WITH_OTA: "1", E2E_STRIPE: "0" });
    stripeWithoutOta = await loadWith({ E2E_WITH_OTA: "0", E2E_STRIPE: "1" });
    inCi = await loadConfig({ CI: "true", E2E_WITH_OTA: "1", E2E_STRIPE: "1" });
    inCiStep = await loadConfig({
      CI: "true",
      E2E_WITH_OTA: "1",
      E2E_STRIPE: "1",
      E2E_RESULTS_SUBDIR: "storefront-stripe",
    });
    badSubdir = await loadConfig({ E2E_RESULTS_SUBDIR: "../stack" }).catch((error: unknown) => error);
    vi.unstubAllEnvs();
  }, 30_000);
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defines storefront-stripe with E2E_STRIPE=1 and E2E_WITH_OTA=1, and not without either [OFE-017 AC1]", () => {
    expect(withStripe).toContain("storefront-stripe");
    expect(withoutStripe).toEqual(["portal", "platform-admin", "storefront", "ota-admin"]);
    expect(stripeWithoutOta).toEqual(["portal", "platform-admin", "portal-stripe"]);
  });

  it("defines ota-admin with E2E_WITH_OTA=1 only [OAD-016 AC1]", () => {
    expect(withStripe).toContain("ota-admin");
    expect(withoutStripe).toContain("ota-admin");
    expect(stripeWithoutOta).not.toContain("ota-admin");
  });

  it("[OFE-026 AC1] keeps in CI the trace and screenshot of every failed test, its HTML report, and annotates each failure", () => {
    // What the workflow's upload on failure takes: test-results/ (traces, screenshots, the stack's logs) and
    // playwright-report/ (the HTML report); the `github` reporter names each failed test and its project on the
    // run's page.
    expect(inCi.outputDir).toBe("test-results");
    expect(inCi.use).toMatchObject({ trace: "retain-on-failure", screenshot: "only-on-failure" });
    expect(inCi.reporter).toEqual([
      ["list"],
      ["github"],
      ["html", { open: "never", outputFolder: "playwright-report" }],
    ]);
    // A failure is never retried away, and a `.only` left in a spec fails the run instead of narrowing it.
    expect(inCi.retries).toBe(0);
    expect(inCi.forbidOnly).toBe(true);
    expect(inCi.workers).toBe(2);
    expect(names(inCi.projects ?? [])).toEqual(withStripe);
  });

  it("[FIX-W48-SHARED AC4] keeps a workflow step's traces and HTML report in the folders of its E2E_RESULTS_SUBDIR", () => {
    // Lead decision (15c) of 2026-11-11: each Playwright step of e2e.yml its own folder inside test-results/ and
    // playwright-report/, so no step empties another's and the upload takes them all.
    expect(inCiStep.outputDir).toBe("test-results/storefront-stripe");
    expect(inCiStep.reporter).toEqual([
      ["list"],
      ["github"],
      ["html", { open: "never", outputFolder: "playwright-report/storefront-stripe" }],
    ]);
    expect(names(inCiStep.projects ?? [])).toEqual(withStripe);
    // A path is refused, never resolved outside the two folders.
    expect(String(badSubdir)).toMatch(/E2E_RESULTS_SUBDIR must be one folder name/);
  });
});

describe("the OTA projects quarantine nothing (OFE-026)", () => {
  const SPECS = join(REPO_ROOT, "tools/e2e/specs");
  /** Every file under the folders of the OTA projects' specs, relative to specs/. */
  const files = ["storefront", "ota-admin"].flatMap((folder) =>
    readdirSync(join(SPECS, folder), { recursive: true, encoding: "utf8" })
      .filter((file) => statSync(join(SPECS, folder, file)).isFile())
      .map((file) => `${folder}/${file}`),
  );

  it("[OFE-026 AC1] runs every OTA spec in its project, leaving out only the tests tagged for another project", () => {
    const projects = projectsFor({ withOta: true, withStripe: true });
    // Each file of the two folders is a spec its project's testMatch selects: none is parked under another name.
    expect(files.length).toBeGreaterThanOrEqual(16);
    for (const file of files) {
      expect(file, file).toMatch(/\.e2e\.ts$/);
    }
    expect(byName(projects, "storefront")?.testMatch).toEqual(["specs/storefront/**/*.e2e.ts"]);
    expect(byName(projects, "ota-admin")?.testMatch).toEqual(["specs/ota-admin/**/*.e2e.ts"]);
    // No retries, ignored files or extra filters in any of the three projects: storefront and ota-admin leave out only
    // `@stripe` (storefront-stripe's), and storefront-stripe takes only `@stripe`.
    for (const name of ["storefront", "ota-admin", "storefront-stripe"]) {
      const project = byName(projects, name);
      expect(project, name).toBeDefined();
      expect(Object.keys(project ?? {}).sort(), name).toEqual(
        name === "storefront-stripe"
          ? ["grep", "name", "testMatch", "use"]
          : ["grepInvert", "name", "testMatch", "use"],
      );
      expect([...patterns(project?.grep), ...patterns(project?.grepInvert)].map(String), name).toEqual([
        String(new RegExp(`${PROJECT_TAGS.stripe}(?![\\w-])`)),
      ]);
    }
  });

  it("[OFE-026 AC1] skips, defers, focuses, slows or retries no journey of the OTA projects", () => {
    // The specs, and the support files they import, whose fixtures and helpers could skip a test as well.
    const SUPPORT = join(REPO_ROOT, "tools/e2e/support");
    const support = readdirSync(SUPPORT).filter((file) => file.endsWith(".ts"));
    expect(support).toContain("fixtures.ts");
    const sources = [
      ...files.map((file) => ({
        path: `specs/${file}`,
        spec: true,
        source: readFileSync(join(SPECS, file), "utf8"),
      })),
      ...support.map((file) => ({
        path: `support/${file}`,
        spec: false,
        source: readFileSync(join(SUPPORT, file), "utf8"),
      })),
    ];
    for (const { path, spec, source } of sources) {
      // test.skip / describe.skip / testInfo.skip, test.fixme, .only and test.slow, in any form.
      expect(source, path).not.toMatch(/\.(skip|fixme|only|slow)\s*\(/);
      // The same as an annotation of a test or group: `{ annotation: { type: "skip" } }` skips it too.
      expect(source, path).not.toMatch(/\btype:\s*["'`](skip|fixme|fail|slow)["'`]/);
      if (spec) {
        // Retries of a file or group (`test.describe.configure({ retries: 2 })`) would retry a failure away.
        expect(source, path).not.toMatch(/\bretries\s*:/);
      }
    }
    // The one expected failure is the storefront guards' own proof that they fail a test (OFE-008 AC2), whose
    // unexpected pass would fail the run: no journey is marked as failing to keep the run green (test.fail,
    // testInfo.fail or test.info().fail).
    const expectedFailures = sources.flatMap(({ path, source }) =>
      (source.match(/\.fail\s*\(/g) ?? []).map(() => path),
    );
    expect(expectedFailures).toEqual(["specs/storefront/search.e2e.ts"]);
    const search = readFileSync(join(SPECS, "storefront/search.e2e.ts"), "utf8");
    const start = search.indexOf(
      'test("the inline script fails the test through the guards alone [OFE-008 AC2]"',
    );
    expect(start).toBeGreaterThan(-1);
    expect(search.slice(start, search.indexOf("\n  test(", start))).toMatch(/\btest\.fail\(\);/);
  });
});
