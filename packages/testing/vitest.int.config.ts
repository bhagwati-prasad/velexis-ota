import { defineConfig } from "vitest/config";

// Integration tests against PostgreSQL 16 and Redis 7 (`pnpm test:int`), with the package's own global setup, as every
// consumer uses it (`globalSetup: ["@velexis/testing/vitest-global-setup"]`; here the source, so no build is needed).
// They need TEST_DATABASE_ADMIN_URL and REDIS_URL (root .env.example, CI services). The files run in parallel, two
// workers at least, so the two test-database files prove isolation between files running at the same time.
export default defineConfig({
  test: {
    name: "@velexis/testing (integration)",
    include: ["test/integration/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["./src/vitest-global-setup.ts"],
    fileParallelism: true,
    pool: "forks",
    poolOptions: { forks: { minForks: 2, maxForks: 4 } },
  },
});
