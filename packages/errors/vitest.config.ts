import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@velexis/errors",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
