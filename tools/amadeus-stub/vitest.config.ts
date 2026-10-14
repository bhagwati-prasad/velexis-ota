import { defineConfig } from "vitest/config";

// `pnpm test` (`vitest run`): the stub's tests in test/. They start the stub in-process on a free port of
// 127.0.0.1 and need nothing else running: no database, no Redis, no network beyond the loopback interface.
export default defineConfig({
  test: {
    name: "@velexis/amadeus-stub",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
