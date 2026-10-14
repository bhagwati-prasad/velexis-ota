// Integration tests of the platform backend (`pnpm test:int`, README §8): `test/integration/<module>/*.int.test.ts`
// against PostgreSQL 16 and Redis 7. They read DATABASE_URL and REDIS_URL through @velexis/config (CI service
// containers, or the root and app `.env.local` files locally). TypeScript is compiled as for the unit tests
// (vitest.config.ts), with decorator metadata. The global setup of @velexis/testing builds the migrated template
// database once per run (TEST_DATABASE_ADMIN_URL), so each test file clones its own with `createTestDatabase()`.
import { defineConfig } from "vitest/config";
import { typescriptWithDecoratorMetadata } from "./vitest.config";

export default defineConfig({
  esbuild: false,
  plugins: [typescriptWithDecoratorMetadata()],
  test: {
    name: "@velexis/platform-backend (integration)",
    include: ["test/integration/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["@velexis/testing/vitest-global-setup"],
    // The health tests bind the default ports 3100 and 3101 of the units: files never run concurrently.
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
