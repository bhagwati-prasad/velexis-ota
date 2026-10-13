import { defineConfig } from "vitest/config";

// `pnpm test` (`vitest run`, mode "test"): the unit tests next to the loader code and the tests of the fetch and
// validation scripts. `pnpm test:int` (`vitest run --mode integration`): the loader against PostgreSQL 16 in
// test/integration; it needs TEST_DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL and DATABASE_URL (root .env.example,
// CI services). An integration test loads the full datasets up to five times on fresh databases, and task X-018
// bounds one full load at 30 s, so those tests get a 60 s budget instead of Vitest's 5 s default.
export default defineConfig(({ mode }) =>
  mode === "integration"
    ? {
        test: {
          name: "@velexis/reference-data (integration)",
          include: ["test/integration/**/*.int.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      }
    : {
        test: {
          name: "@velexis/reference-data",
          include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
          environment: "node",
        },
      },
);
