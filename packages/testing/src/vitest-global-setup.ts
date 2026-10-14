// @velexis/testing/vitest-global-setup (X-015; ADR-0022 item 4): builds the migrated template database once per
// Vitest run and drops it when the run ends, together with any clone a crashed test file left behind. Add it to the
// integration-test config of a package or app:
//
//   export default defineConfig({
//     test: { include: ["test/integration/**/*.int.test.ts"], globalSetup: ["@velexis/testing/vitest-global-setup"] },
//   });
//
// Each test file then clones the template with `createTestDatabase()`; the template's name reaches the files through
// Vitest's `provide` / `inject`, never through the environment.
import { createTemplateDatabase, TEMPLATE_DATABASE_KEY } from "./test-database.js";

/**
 * The part of Vitest's `TestProject`, the argument of a global setup, that this setup uses. Typed by hand: Vitest is
 * ESM-only and types `provide` through `ProvidedContext`, which this CommonJS package cannot augment.
 */
export interface GlobalSetupProject {
  provide(key: string, value: string): void;
}

/**
 * Vitest global setup: creates `velexis_test_tpl_<runId>` (platform and reference migrated, `tenant_alpha` and
 * `tenant_beta` provisioned, the reference fixture loaded), provides its name to the test files and returns the
 * teardown that drops it and the run's leftover clones.
 */
export default async function setup(project: GlobalSetupProject): Promise<() => Promise<void>> {
  const template = await createTemplateDatabase();
  project.provide(TEMPLATE_DATABASE_KEY, template.name);
  return async () => {
    await template.drop();
  };
}
