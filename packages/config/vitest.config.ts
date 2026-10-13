import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@velexis/config",
    include: ["src/**/*.test.ts"],
    // The type tests (expectTypeOf) fail the run when an inferred config type is wrong.
    typecheck: {
      enabled: true,
      include: ["src/**/*.test.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
