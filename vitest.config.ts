// Vitest projects for editors and ad-hoc runs from the repository root (X-001; ADR-0002 item 6, dated note of
// 2026-11-06). CI keeps running tests per package through Turborepo (`pnpm test`, `pnpm test:int`).
//
// Vitest 4 has no `defineWorkspace` and reads no workspace file (PBE-070), so this root config lists every package's
// own unit-test config as a project: `vitest.config.ts`, or `vitest.config.js` for the storefront and the SDK. A
// project is named after its config's `test.name` or, without one, its package.json name. Run one package with
// `pnpm exec vitest run --config vitest.config.ts --project @velexis/errors`. The integration, cross-backend and smoke
// configs (`vitest.int.config.ts`, `vitest.xb.config.ts`, `vitest.smoke.config.js`) are not projects here: they need
// services and run through their packages' scripts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.{ts,js}",
      "platform/*/vitest.config.{ts,js}",
      "ota/*/vitest.config.{ts,js}",
      "tools/*/vitest.config.{ts,js}",
    ],
  },
});
