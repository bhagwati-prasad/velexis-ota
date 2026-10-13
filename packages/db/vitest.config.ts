import { defineConfig } from "vitest/config";

// Unit tests next to the code. The integration tests (test/integration, PostgreSQL) run with
// vitest.int.config.ts through `pnpm test:int`.
export default defineConfig({
  test: {
    name: "@velexis/db",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
