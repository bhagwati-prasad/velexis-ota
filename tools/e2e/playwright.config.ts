// Playwright configuration of the Velexis end-to-end suite (ADR-0015, PADR-0017; tools/e2e/README.md).
//
// One global setup (support/stack.ts) starts the built stack on a fresh database for the whole run and stops it at
// the end. Projects select their spec files by name; a spec shared by several projects (specs/smoke.e2e.ts) pins each
// test to its project with a tag. The OTA plan's projects: `storefront` (OFE-008), the nightly `storefront-stripe`
// (OFE-017) and `ota-admin` (OAD-016), each only with E2E_WITH_OTA=1.
import { defineConfig, devices, type Project } from "@playwright/test";
import { loadDevEnvFiles } from "@velexis/config";
import { PROJECT_TAGS } from "./support/fixtures";
import { OTA_ADMIN_URL, PLATFORM_ADMIN_URL, PORTAL_URL, STOREFRONT_URL } from "./support/stack";

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

/** Which parts of the stack a run has: E2E_WITH_OTA and E2E_STRIPE. */
export interface ProjectOptions {
  readonly withOta: boolean;
  readonly withStripe: boolean;
}

/** The projects of a run with `options`; a project whose stack part is missing does not exist, so selecting it fails. */
export function projectsFor(options: ProjectOptions): Project[] {
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

  if (options.withOta) {
    // The hosted storefront's journeys (OFE-008, and the M3 journeys of ota/frontend/README.md §13): the production
    // build in `vite preview` for the demo OTA, with the preview proxy to the OTA API and the Caddyfile's headers.
    // Without E2E_WITH_OTA=1 nothing serves it, so the project does not exist and `--project=storefront` fails at once.
    // Its Stripe journeys (tagged `@stripe`) run in `storefront-stripe` only.
    projects.push({
      name: "storefront",
      testMatch: ["specs/storefront/**/*.e2e.ts"],
      grepInvert: [tag(PROJECT_TAGS.stripe)],
      use: { ...desktopChrome, baseURL: STOREFRONT_URL },
    });
    // The OTA admin's journeys (OAD-016, ota/admin/README.md §12): the built OTA admin's standalone server, which the
    // stack starts with the OTA API only with E2E_WITH_OTA=1, so without it the project does not exist and
    // `--project=ota-admin` fails at once. Staff arrive by the portal's single sign-on, as on the VM. A journey that
    // needs Stripe over the network (tagged `@stripe`) never runs here.
    projects.push({
      name: "ota-admin",
      testMatch: ["specs/ota-admin/**/*.e2e.ts"],
      grepInvert: [tag(PROJECT_TAGS.stripe)],
      use: { ...desktopChrome, baseURL: OTA_ADMIN_URL },
    });
  }

  if (options.withStripe) {
    // Nightly only: Stripe Checkout and the Customer Portal in Stripe's test mode, over the network. Without
    // E2E_STRIPE=1 the project does not exist, so `--project=portal-stripe` fails instead of running without Stripe.
    projects.push({
      name: "portal-stripe",
      testMatch: ["specs/portal-*.e2e.ts"],
      grep: tag(PROJECT_TAGS.stripe),
      use: { ...desktopChrome, baseURL: PORTAL_URL },
    });
  }

  if (options.withOta && options.withStripe) {
    // Nightly only (OFE-017): the storefront's journeys tagged `@stripe`, with Stripe.js, the Payment Element and
    // 3-D Secure in Stripe's test mode over the network, and the Stripe CLI forwarder of the stack (support/stripe.ts)
    // that the OTA's test keys turn on. Without both E2E_WITH_OTA=1 and E2E_STRIPE=1 the project does not exist, so
    // `--project=storefront-stripe` fails instead of running without Stripe.
    projects.push({
      name: "storefront-stripe",
      testMatch: ["specs/storefront/**/*.e2e.ts"],
      grep: tag(PROJECT_TAGS.stripe),
      use: { ...desktopChrome, baseURL: STOREFRONT_URL },
    });
  }
  return projects;
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
  // the processes of the stack (eleven with E2E_WITH_OTA=1).
  ...(CI ? { workers: 2 } : {}),
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...(CHROMIUM === undefined || CHROMIUM === "" ? {} : { launchOptions: { executablePath: CHROMIUM } }),
  },
  projects: projectsFor({ withOta: WITH_OTA, withStripe: WITH_STRIPE }),
});
