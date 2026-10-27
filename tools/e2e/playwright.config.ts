// Playwright configuration of the Velexis end-to-end suite (ADR-0015, PADR-0017; tools/e2e/README.md).
//
// One global setup (support/stack.ts) starts the built stack on a fresh database for the whole run and stops it at
// the end. Projects select their spec files by name; a spec shared by several projects (specs/smoke.e2e.ts) pins each
// test to its project with a tag. The OTA plan adds its projects here: `storefront` (OFE-008) and `ota-admin`
// (OAD-016).
import { defineConfig, devices, type Project } from "@playwright/test";
import { loadDevEnvFiles } from "@velexis/config";
import { PROJECT_TAGS } from "./support/fixtures";
import { PLATFORM_ADMIN_URL, PORTAL_URL, STOREFRONT_URL } from "./support/stack";

/** Matches `name` as a whole tag: `@portal` does not match `@portal-stripe`. */
const tag = (name: string): RegExp => new RegExp(`${name}(?![\\w-])`);

// The same sources as the harness settings of support/stack.ts: the environment, then the `.env.local` files.
loadDevEnvFiles({ appDir: __dirname });
const isTrue = (value: string | undefined): boolean => value === "1" || value === "true";
const CI = isTrue(process.env["CI"]);
/** Set by the nightly job when the Stripe test secrets are configured (PADR-0017 item 4). */
const WITH_STRIPE = isTrue(process.env["E2E_STRIPE"]);
/** The stack also runs the OTA backend, the storefront previews and the demo OTA (support/stack.ts). */
const WITH_OTA = isTrue(process.env["E2E_WITH_OTA"]);
/** A Chromium binary to use instead of the revision the pinned Playwright installs (a machine image that has another). */
const CHROMIUM = process.env["E2E_CHROMIUM_EXECUTABLE"];

const desktopChrome = devices["Desktop Chrome"];

const projects: Project[] = [
  {
    name: "portal",
    testMatch: ["specs/smoke.e2e.ts", "specs/portal-*.e2e.ts", "specs/console-*.e2e.ts"],
    // Stripe journeys run in `portal-stripe` only; admin tests of the smoke spec in `platform-admin`.
    grepInvert: [tag(PROJECT_TAGS.stripe), tag(PROJECT_TAGS.platformAdmin)],
    use: { ...desktopChrome, baseURL: PORTAL_URL },
  },
  {
    name: "platform-admin",
    testMatch: ["specs/smoke.e2e.ts", "specs/admin-*.e2e.ts"],
    grepInvert: [tag(PROJECT_TAGS.portal)],
    use: { ...desktopChrome, baseURL: PLATFORM_ADMIN_URL },
  },
];

if (WITH_OTA) {
  // The hosted storefront's journeys (OFE-008, and the M3 journeys of ota/frontend/README.md §13): the production build
  // in `vite preview` for the demo OTA, with the preview proxy to the OTA API and the Caddyfile's headers. Without
  // E2E_WITH_OTA=1 nothing serves it, so the project does not exist and `--project=storefront` fails at once.
  projects.push({
    name: "storefront",
    testMatch: ["specs/storefront/**/*.e2e.ts"],
    use: { ...desktopChrome, baseURL: STOREFRONT_URL },
  });
}

if (WITH_STRIPE) {
  // Nightly only: Stripe Checkout and the Customer Portal in Stripe's test mode, over the network. Without
  // E2E_STRIPE=1 the project does not exist, so `--project=portal-stripe` fails instead of running without Stripe.
  projects.push({
    name: "portal-stripe",
    testMatch: ["specs/portal-*.e2e.ts"],
    grep: tag(PROJECT_TAGS.stripe),
    use: { ...desktopChrome, baseURL: PORTAL_URL },
  });
}

export default defineConfig({
  testDir: ".",
  testMatch: "specs/**/*.e2e.ts",
  outputDir: "test-results",
  globalSetup: "./support/stack.ts",
  // Spec files run in parallel, the tests of one file in order in one worker (a journey may build on its
  // beforeAll). No test depends on another file or on the order of files: each creates its own accounts and data.
  fullyParallel: false,
  forbidOnly: CI,
  // A failure is a finding, not something to retry away (AGENTS.md §7).
  retries: 0,
  // Locally Playwright's default (half the CPU cores); two in CI (a GitHub-hosted runner has 2 or 4 cores), next to
  // the processes of the stack (nine with E2E_WITH_OTA=1).
  ...(CI ? { workers: 2 } : {}),
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...(CHROMIUM === undefined || CHROMIUM === "" ? {} : { launchOptions: { executablePath: CHROMIUM } }),
  },
  projects,
});
