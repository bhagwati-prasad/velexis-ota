// The projects of playwright.config.ts (PFE-014, OFE-008, OFE-017): which exist with and without E2E_WITH_OTA=1 and
// E2E_STRIPE=1, and which tests each selects. `playwright test --list` shows the same against the specs themselves.
import { type PlaywrightTestConfig, type Project } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectsFor } from "../playwright.config";
import { PROJECT_TAGS } from "../support/fixtures";
import { PORTAL_URL, STOREFRONT_URL } from "../support/stack";

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
      "portal-stripe",
      "storefront-stripe",
    ]);
  });

  it("runs the storefront's @stripe tests in storefront-stripe only, against the demo OTA's storefront [OFE-017 AC1]", () => {
    const projects = projectsFor({ withOta: true, withStripe: true });
    const storefront = byName(projects, "storefront");
    const storefrontStripe = byName(projects, "storefront-stripe");
    expect(storefrontStripe).toMatchObject({
      testMatch: ["specs/storefront/**/*.e2e.ts"],
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
});

describe("the configuration's projects from the environment", () => {
  /** The project names of playwright.config.ts loaded afresh with `env`. */
  const loadWith = async (env: Record<string, string>): Promise<(string | undefined)[]> => {
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
    return names(config.projects ?? []);
  };

  let withStripe: (string | undefined)[] = [];
  let withoutStripe: (string | undefined)[] = [];
  let stripeWithoutOta: (string | undefined)[] = [];

  // Loading the configuration three times compiles it and its support files afresh each time (a second or so idle):
  // here, once, with this budget, not inside the tests' 5 s.
  beforeAll(async () => {
    withStripe = await loadWith({ E2E_WITH_OTA: "1", E2E_STRIPE: "1" });
    withoutStripe = await loadWith({ E2E_WITH_OTA: "1", E2E_STRIPE: "0" });
    stripeWithoutOta = await loadWith({ E2E_WITH_OTA: "0", E2E_STRIPE: "1" });
  }, 30_000);
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defines storefront-stripe with E2E_STRIPE=1 and E2E_WITH_OTA=1, and not without either [OFE-017 AC1]", () => {
    expect(withStripe).toContain("storefront-stripe");
    expect(withoutStripe).toEqual(["portal", "platform-admin", "storefront"]);
    expect(stripeWithoutOta).toEqual(["portal", "platform-admin", "portal-stripe"]);
  });
});
