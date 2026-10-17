// Test support: the OTA document's one-time cost, paid in a setup hook instead of inside a test's time bound.
import { loadOpenApiDocument } from "../../src/common/http/openapi-validation.interceptor";

/**
 * The budget of a setup hook that runs `preloadOpenApiDocument`. The first application a test file starts parses the
 * OTA document and compiles its request validators: about 1.5 s alone, several times that while every package's tests
 * run at once on a 4-CPU runner, enough to push the first test that starts an application past Vitest's 5 s bound
 * (CI run 38752280673). The budget only stops a load that hangs.
 */
export const OPENAPI_SETUP_TIMEOUT_MS = 60_000;

/**
 * Parses and compiles the OTA document, which `loadOpenApiDocument` keeps for the rest of the test process, so the
 * applications the tests start afterwards (`createTestApp`, `startApi`, `AppModule`) reuse it:
 *
 *   beforeAll(preloadOpenApiDocument, OPENAPI_SETUP_TIMEOUT_MS);
 */
export function preloadOpenApiDocument(): void {
  loadOpenApiDocument();
}
