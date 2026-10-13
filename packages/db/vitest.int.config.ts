import { defineConfig } from "vitest/config";

// Integration tests against PostgreSQL 16 (`pnpm test:int`). They need TEST_DATABASE_ADMIN_URL (root
// .env.example, CI services); test/integration/helpers.ts reads it through @velexis/config.
export default defineConfig({
  test: {
    name: "@velexis/db (integration)",
    include: ["test/integration/**/*.int.test.ts"],
    environment: "node",
  },
});
