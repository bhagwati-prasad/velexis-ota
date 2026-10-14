// Integration tests of the OTA backend (`pnpm test:int`, README §8): `test/integration/<module>/*.int.test.ts` against
// PostgreSQL 16 and Redis 7. They read DATABASE_URL, REDIS_URL and DATABASE_PROVISIONER_URL through @velexis/config
// (CI service containers, or the root and app `.env.local` files locally). TypeScript is compiled as for the unit
// tests (vitest.config.ts), with decorator metadata. The @velexis/testing global setup builds the run's template
// database (TEST_DATABASE_ADMIN_URL), which test files clone with `createTestDatabase()`.
import { defineConfig } from "vitest/config";
import { typescriptWithDecoratorMetadata } from "./vitest.config";

export default defineConfig({
  esbuild: false,
  plugins: [typescriptWithDecoratorMetadata()],
  test: {
    name: "@velexis/ota-backend (integration)",
    include: ["test/integration/**/*.int.test.ts"],
    globalSetup: ["@velexis/testing/vitest-global-setup"],
    environment: "node",
    // The health tests bind the default ports 4000 and 4001 of the units; files must not run them concurrently.
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
