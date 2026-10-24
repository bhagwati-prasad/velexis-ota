import { defineConfig } from "vitest/config";

// `pnpm test` (`vitest run`, mode "test"): the unit tests next to the loader code and the tests of the fetch and
// validation scripts. `pnpm test:int` (`vitest run --mode integration`): the loader against PostgreSQL 16 in
// test/integration; it needs TEST_DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL and DATABASE_URL (root .env.example,
// CI services). A scenario loads the full datasets up to four times on a fresh database, and task X-018 bounds one
// full load at 30 s: that work runs in each scenario's setup hook, with the budget the hook names
// (test/integration/load.int.test.ts), and the tests, which assert on what it recorded, keep Vitest's 5 s default
// (FIX-W28-FOLLOWUPS: until then every test had a 60 s budget here).
export default defineConfig(({ mode }) =>
  mode === "integration"
    ? {
        test: {
          name: "@velexis/reference-data (integration)",
          include: ["test/integration/**/*.int.test.ts"],
          environment: "node",
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
