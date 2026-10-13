// Vitest for the storefront (ota/frontend/README.md §13): page modules and components run in happy-dom; tests of
// the build, the budgets and the dev and preview servers opt into Node with `// @vitest-environment node`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.js"],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
