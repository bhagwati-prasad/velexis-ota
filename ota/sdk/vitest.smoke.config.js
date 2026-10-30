// Vitest for the SDK's smoke tests (SDK-014; ota/sdk/README.md §8.1): `pnpm --filter @velexis/ota-sdk test:smoke`
// calls a running OTA API (OTA_API_URL) with the test keys the OTA backend's dev:seed printed, one call per namespace in
// token mode and in server mode. Not part of `test`: the nightly e2e workflow runs it after it has started the OTA
// backend (.github/workflows/e2e.yml), and a developer runs it against the local stack.
//
// The global setup (test/smoke/smoke-env.js) checks the API before any file runs: when it does not answer within a few
// seconds, or a setting is missing, the run fails at once with what to start or set, instead of waiting on each call.
// The two files run one after the other: they sign up customers and open a staff session on the same demo OTA, whose
// rate limits count per end user.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/smoke/**/*.smoke.test.js"],
    globalSetup: ["test/smoke/smoke-env.js"],
    fileParallelism: false,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
