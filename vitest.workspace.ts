// Vitest projects for editors and ad-hoc runs from the repository root (X-001; ADR-0002 item 6).
// CI keeps running tests per package through Turborepo (`pnpm test`, `pnpm test:int`).
//
// Vitest 4 reads no workspace file and has no `defineWorkspace` any more (PBE-070): this file is a root config whose
// `test.projects` lists the same package configs. Vitest finds it only when it is named, as in
// `pnpm exec vitest run --config vitest.workspace.ts --project @velexis/errors`, or in an editor extension's config
// setting.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "platform/*/vitest.config.ts",
      "ota/*/vitest.config.ts",
      "tools/*/vitest.config.ts",
    ],
  },
});
