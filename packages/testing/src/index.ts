// @velexis/testing: test support only, never a runtime dependency (ADR-0022). X-015 adds the test databases, Redis,
// the fake clock, builders and the OpenAPI response check; X-025, X-027 and X-028 add ./mailpit, ./amadeus and
// ./stripe. The Vitest global setup is the subpath @velexis/testing/vitest-global-setup.
export { defineBuilder, type Builder, type BuilderDefaults, type BuilderOverrides } from "./builders.js";
export { FAKE_CLOCK_DEFAULT_START, FakeClock } from "./clock.js";
export {
  API_DOCUMENTS,
  createResponseChecker,
  expectResponseToMatch,
  responseChecker,
  ResponseMismatchError,
  type ApiDocumentName,
  type ExpectResponseOptions,
  type ResponseChecker,
  type ResponseLike,
  type ResponseProblem,
} from "./openapi-response.js";
export {
  REDIS_TEST_DATABASES,
  redisDatabaseIndex,
  redisUrlWithDatabase,
  useRedis,
  type TestRedis,
} from "./redis.js";
export { databaseUrl, TEST_ROLE_NAMES, TEST_ROLES, type TestRole, type TestRoleLogin } from "./roles.js";
export {
  createTemplateDatabase,
  createTestDatabase,
  databaseGrantStatements,
  dropDatabase,
  dropRunClones,
  REFERENCE_FIXTURE,
  runIdOfTemplate,
  TEMPLATE_DATABASE_KEY,
  TEMPLATE_DATABASE_PREFIX,
  TEST_DATABASE_PREFIX,
  TEST_TENANTS,
  testDatabaseAdminUrl,
  type CreateTemplateDatabaseOptions,
  type CreateTestDatabaseOptions,
  type TemplateDatabase,
  type TestDatabase,
  type TestTenant,
} from "./test-database.js";
