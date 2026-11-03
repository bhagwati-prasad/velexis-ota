// Cross-backend tests of the OTA backend (`pnpm test:xb`, README §8, PADR-0017 item 2, OBE-083):
// `test/cross-backend/*.xb.test.ts`, each on a stack of its own (test/cross-backend/stack.ts): the BUILT platform API,
// worker and `dev:seed` (`platform/backend/dist/`) and the BUILT OTA API and worker (`ota/backend/dist/`) as child
// processes, against PostgreSQL 16, Redis 7 and Mailpit, with the Amadeus stubs and the fake Stripe API in the test
// process. In CI the script runs after the `Build` step, because `pnpm test:int` builds only each package's
// dependencies; without the builds the stack fails at once and says what to run. TypeScript is compiled as for the
// unit tests (vitest.config.ts), with decorator metadata. The global setup of @velexis/testing builds the migrated
// template database once per run (TEST_DATABASE_ADMIN_URL), so each test file clones its own with
// `createTestDatabase()`.
import { defineConfig } from "vitest/config";
import { typescriptWithDecoratorMetadata } from "./vitest.config";

export default defineConfig({
  esbuild: false,
  plugins: [typescriptWithDecoratorMetadata()],
  test: {
    name: "@velexis/ota-backend (cross-backend)",
    include: ["test/cross-backend/**/*.xb.test.ts"],
    environment: "node",
    globalSetup: ["@velexis/testing/vitest-global-setup"],
    // Each file starts four processes of the two backends: one file at a time keeps them from competing for the CPU
    // and from sharing a Redis database index.
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
