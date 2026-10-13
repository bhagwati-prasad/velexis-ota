import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The tsconfig path alias of the app.
      { find: /^@\//, replacement: `${here("./src")}/` },
      // `server-only` throws outside the react-server export condition, which only Next.js sets. Tests run
      // server modules directly, so they get the package's own empty module, as Next.js server code does.
      { find: /^server-only$/, replacement: here("./node_modules/server-only/empty.js") },
    ],
  },
  test: {
    name: "@velexis/platform-admin",
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
    unstubGlobals: true,
  },
});
