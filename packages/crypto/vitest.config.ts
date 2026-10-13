import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@velexis/crypto",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
