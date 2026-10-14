import { defineConfig } from "vitest/config";

// Integration tests against PostgreSQL 16, Redis 7 and Mailpit (`pnpm test:int`), with the package's own global setup,
// as every consumer uses it (`globalSetup: ["@velexis/testing/vitest-global-setup"]`; here the source, so no build is
// needed). They need TEST_DATABASE_ADMIN_URL, REDIS_URL, SMTP_URL and MAILPIT_API_URL (root .env.example, CI
// services). The files run in parallel, two workers at least, so the two test-database files and the two mailpit
// files prove isolation between files running at the same time.
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
