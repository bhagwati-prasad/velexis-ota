import { defineConfig } from "vitest/config";

// `pnpm test` (`vitest run`): the unit tests of the harness in test/ (settings, environments, TOTP, the axe report, the
// e2e workflow). They need nothing running and no built app. The journeys themselves run with `pnpm test:e2e`
// (Playwright), never with Vitest: the include pattern leaves specs/**/*.e2e.ts out.
export default defineConfig({
  test: {
    name: "@velexis/e2e",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
