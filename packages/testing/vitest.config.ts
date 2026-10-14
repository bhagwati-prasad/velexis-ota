import { defineConfig } from "vitest/config";

// Unit tests next to the code: no PostgreSQL, Redis or Mailpit needed. The integration tests (test/integration,
// PostgreSQL, Redis and Mailpit) run with vitest.int.config.ts through `pnpm test:int`.
export default defineConfig({
  test: {
    name: "@velexis/testing",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
