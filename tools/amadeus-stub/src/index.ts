// @velexis/amadeus-stub: the Amadeus stub server for development and tests (X-026, ADR-0015). A devDependency only
// (ADR-0022): @velexis/testing/amadeus starts it in-process, `pnpm stub:amadeus` runs src/cli.ts on 127.0.0.1:4900.
export {
  createStubServer,
  DEFAULT_HOST,
  MAX_BODY_BYTES,
  MAX_RECORDED_REQUESTS,
  TOKEN_OPERATION,
  type RecordedRequest,
  type StubServer,
  type StubServerOptions,
  type StubTimers,
} from "./server";
export { OAUTH_TOKEN_PATH, TOKEN_EXPIRES_IN, type StubClock, type StubCredentials } from "./oauth";
export {
  AMADEUS_SPEC_FILES,
  FIXTURE_DIR,
  loadFixture,
  matchRoute,
  STUB_OPERATIONS,
  type AmadeusApi,
  type Fixture,
  type FixtureHeader,
  type HandlerContext,
  type OperationHandler,
  type OperationName,
  type RouteMatch,
  type StubOperation,
} from "./routes";
export {
  AMADEUS_ERROR_CODES,
  NO_OFFERS_DESTINATION,
  SCENARIO_HEADER,
  STUB_ERROR_CODES,
  STUB_SCENARIOS,
  TIMEOUT_HOLD_MS,
  isStubScenario,
  type AmadeusIssue,
  type StubResponse,
  type StubScenario,
} from "./scenarios";
export {
  AMADEUS_SPEC_DIR,
  AmadeusSpecs,
  type OperationSpec,
  type RequestParts,
  type ResponseProblem,
  type ValidationResult,
} from "./validate";
