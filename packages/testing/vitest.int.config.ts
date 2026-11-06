import { defineConfig } from "vitest/config";

// Integration tests against PostgreSQL 16, Redis 7, Mailpit and the in-process Amadeus stub (`pnpm test:int`), with the
// package's own global setup, as every consumer uses it (`globalSetup: ["@velexis/testing/vitest-global-setup"]`; here
// the source, so no build is needed). They need TEST_DATABASE_ADMIN_URL, REDIS_URL, SMTP_URL and MAILPIT_API_URL (root
// .env.example, CI services). The files run in parallel, so the two test-database files and the two mailpit files
// prove isolation between files running at the same time: each waits up to 60 s for its partner.
//
// Four forks: each file runs in a fresh fork. Vitest 4 runs its own pool (no Tinypool, and `maxWorkers` replaces
// `poolOptions`, PBE-070), which starts the next queued file whenever fewer than `maxWorkers` files run, so a file that
// waits for its partner never keeps the partner queued. Under Vitest 3, Tinypool also needed `minForks: 4`: with fewer,
// the fast files (redis, amadeus) could end while two files waited for their queued partners, and no new fork started
// until the waiting files gave up after 60 s (X-027).
export default defineConfig({
  test: {
    name: "@velexis/testing (integration)",
    include: ["test/integration/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["./src/vitest-global-setup.ts"],
    fileParallelism: true,
    pool: "forks",
    maxWorkers: 4,
  },
});
