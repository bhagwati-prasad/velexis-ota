import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@velexis/api-types",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
