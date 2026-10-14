import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Unit, route and middleware tests run in Node; component tests (`*.test.tsx` with Testing Library) opt into a DOM
// with a `// @vitest-environment happy-dom` comment (README §9).
export default defineConfig({
  // tsconfig.json keeps JSX for Next.js (`"jsx": "preserve"`); tests compile it with the React 19 runtime.
  esbuild: { jsx: "automatic" },
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
    name: "@velexis/platform-frontend",
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
    unstubGlobals: true,
  },
});
