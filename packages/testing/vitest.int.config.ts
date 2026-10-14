import { defineConfig } from "vitest/config";

// Integration tests against PostgreSQL 16, Redis 7, Mailpit and the in-process Amadeus stub (`pnpm test:int`), with the
// package's own global setup, as every consumer uses it (`globalSetup: ["@velexis/testing/vitest-global-setup"]`; here
// the source, so no build is needed). They need TEST_DATABASE_ADMIN_URL, REDIS_URL, SMTP_URL and MAILPIT_API_URL (root
// .env.example, CI services). The files run in parallel, so the two test-database files and the two mailpit files
// prove isolation between files running at the same time: each waits up to 60 s for its partner.
//
// Four forks, and always four (minForks = maxForks): each file runs in a fresh fork, and when a file ends Tinypool starts
// a new fork only while there are fewer forks than minForks or than queued files, busy forks included. With minForks 2,
// the fast files (redis, amadeus) could end while two files waited for their queued partners: two busy forks, two
// queued files, so no new fork until the waiting files gave up after 60 s (X-027).
export default defineConfig({
  test: {
    name: "@velexis/testing (integration)",
    include: ["test/integration/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["./src/vitest-global-setup.ts"],
    fileParallelism: true,
    pool: "forks",
    poolOptions: { forks: { minForks: 4, maxForks: 4 } },
  },
});
