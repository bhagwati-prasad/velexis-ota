// Vitest for the SDK (ota/sdk/README.md §8): the unit tests in test/unit/ and, from SDK-006, the contract tests in
// test/contract/. The SDK runs in browsers and in Node 22, so tests run in Node by default; cookie-mode tests opt
// into a DOM with `// @vitest-environment happy-dom`. The smoke tests in test/smoke/ need a running OTA backend and
// are not part of `test` (`test:smoke`, vitest.smoke.config.js; SDK-014). Requests go to test/helpers/fake-fetch.js,
// never the network.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.js", "test/contract/**/*.test.js"],
    // Vitest 4's restoreMocks restores vi.spyOn spies only; mockReset also clears every vi.fn() and resets its
    // implementation before each test, as restoreMocks did under Vitest 3 (PBE-070).
    restoreMocks: true,
    mockReset: true,
    unstubGlobals: true,
  },
});
