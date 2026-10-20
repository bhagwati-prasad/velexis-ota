// Cross-backend tests of the platform backend (`pnpm test:xb`, README §8, PADR-0017 item 2):
// `test/cross-backend/*.xb.test.ts`, each on a stack of its own (test/cross-backend/stack.ts): the platform API and
// worker from their sources, as in `pnpm test:int`, and the BUILT OTA backend (`ota/backend/dist/`) as child
// processes, against PostgreSQL 16, Redis 7 and Mailpit. In CI the script runs after the `Build` step, because
// `pnpm test:int` builds only each package's dependencies and ota/backend is none of this package's; without the
// build the stack fails at once and says what to run. TypeScript is compiled as for the unit tests
// (vitest.config.ts), with decorator metadata. The global setup of @velexis/testing builds the migrated template
// database once per run (TEST_DATABASE_ADMIN_URL), so each test file clones its own with `createTestDatabase()`.
import { defineConfig } from "vitest/config";
import { typescriptWithDecoratorMetadata } from "./vitest.config";

export default defineConfig({
  esbuild: false,
  plugins: [typescriptWithDecoratorMetadata()],
  test: {
    name: "@velexis/platform-backend (cross-backend)",
    include: ["test/cross-backend/**/*.xb.test.ts"],
    environment: "node",
    globalSetup: ["@velexis/testing/vitest-global-setup"],
    // Each file starts an OTA worker and the platform's worker graph: one file at a time keeps them from competing
    // for the CPU and from sharing a Redis database index.
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
