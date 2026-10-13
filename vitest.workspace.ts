// Vitest workspace for editors and ad-hoc runs from the repository root (X-001).
// CI keeps running tests per package through Turborepo (`pnpm test`, `pnpm test:int`).
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "platform/*/vitest.config.ts",
  "ota/*/vitest.config.ts",
  "tools/*/vitest.config.ts",
]);
