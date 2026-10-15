// Contract tests of the platform OpenAPI document, openapi/velexis-platform-api.openapi.yaml (ADR-0006, PADR-0016).
//
// PBE-005 wrote its first slice (identity, plans, internal: 24 operations, the conventions and the error catalogue),
// PBE-006 the second (tenants, team, API keys and the M1 reads: 27 operations), PBE-007 the first admin slice
// (admin auth and dashboard, tenants, provisioning jobs and queues: 21 operations) and PBE-066 the second (plans and
// subscriptions, Amadeus accounts and offices, accounts, platform admins and audit: 26 operations). The tests of a
// slice name its operations by operationId and never count the document, so the later slices (PBE-037, PBE-041,
// PBE-042) only add operations and tests of their own. The convention checks run on every operation of the
// document: x-scope and the matching security scheme, `platform_admin` on every `/v1/admin/` path but the public
// sign-in steps, X-Request-Id on every response, x-platform-tables, Idempotency-Key exactly on x-idempotent
// operations, a 5–500 character `reason` exactly on x-reason-required operations, closed request bodies,
// `Cache-Control: no-store` on secret-bearing responses, error examples that agree with x-error-codes and the
// catalogue, and examples that validate with the Ajv checker of @velexis/testing that the integration tests use
// (a body that is not JSON, such as the audit CSV export, only where NON_JSON_RESPONSES lists it, and its slice test
// checks it). `pnpm contracts:lint` (Redocly, X-007) and the generators' tests (X-008, X-009) cover the lint and the
// generated files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OTA_QUEUES,
  PLATFORM_QUEUES,
  TENANT_MIGRATION_VERSION_PATTERN,
  TENANT_OPS_JOB_NAMES,
  TENANT_SUSPENSION_REASONS,
  bullmqJobId,
} from "@velexis/api-types/jobs";
import { platformOperations, type PlatformOperationId } from "@velexis/api-types/operations";
import { ERROR_CATALOGUE, PLATFORM_ERROR_CODES, type PlatformErrorCode } from "@velexis/errors";
import { createResponseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { APP_DIR } from "../../src/config";
import { HealthService } from "../../src/health/health.service";

const REPO_ROOT = join(APP_DIR, "..", "..");
const PLATFORM_DOCUMENT = join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml");
const OTA_DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
const INVENTORY = join(REPO_ROOT, "platform", "docs", "api-inventory.md");
const INVENTORY_RESOURCES = join(REPO_ROOT, "platform", "docs", "api-inventory-resources.md");
const INVENTORY_ADMIN = join(REPO_ROOT, "platform", "docs", "api-inventory-admin.md");
const PLATFORM_MIGRATIONS = join(APP_DIR, "migrations", "platform");
const ONBOARDING_ADR = join(REPO_ROOT, "platform", "docs", "adr", "0018-onboarding-checklist-computation.md");
const GENERATED_PLATFORM_TYPES = join(REPO_ROOT, "packages", "api-types", "src", "generated", "platform.ts");

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** The `x-scope` values of the platform document (PADR-0009 item 1, api-inventory §2). */
const SCOPES = ["public", "portal_unverified", "portal", "platform_admin", "internal", "webhook"] as const;

/** Response properties that hold a secret: a 2xx response with one must document `Cache-Control: no-store`. */
const SECRET_PROPERTIES = new Set([
  "accessToken",
  "refreshToken",
  "mfaChallengeToken",
  "portalToken",
  "secret",
  "otpauthUrl",
  "recoveryCodes",
]);

/**
 * Schemas that hold a secret whatever the property is called: an API key shown once is answered as `key`, a name the
 * OTA key of `Tenant` shares, so the no-store check follows the reference rather than the name.
 */
const SECRET_SCHEMAS = new Set(["#/components/schemas/ApiKeySecret"]);

type Json = Record<string, unknown>;

interface Operation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly spec: Json;
}

/** One slice operation as the operations index lists it. */
interface SliceOperation {
  readonly operationId: PlatformOperationId;
  readonly method: string;
  readonly path: string;
  readonly scope: (typeof SCOPES)[number];
  readonly internal: boolean;
}

/**
 * The PBE-005 slice: api-inventory §4 (auth, 11), §5 (account, 9), §6 (`listPlans`) and api-inventory-admin §9
 * (`tlsAsk`, `healthLive`, `healthReady`). The `PlatformOperationId` type makes a misspelt id fail to compile.
 */
const SLICE: readonly SliceOperation[] = [
  { operationId: "signUp", method: "post", path: "/v1/auth/sign-up", scope: "public", internal: false },
  {
    operationId: "verifyEmail",
    method: "post",
    path: "/v1/auth/verify-email",
    scope: "public",
    internal: false,
  },
  {
    operationId: "resendVerification",
    method: "post",
    path: "/v1/auth/resend-verification",
    scope: "public",
    internal: false,
  },
  { operationId: "signIn", method: "post", path: "/v1/auth/sign-in", scope: "public", internal: false },
  { operationId: "verifyMfa", method: "post", path: "/v1/auth/mfa/verify", scope: "public", internal: false },
  {
    operationId: "refreshSession",
    method: "post",
    path: "/v1/auth/refresh",
    scope: "public",
    internal: false,
  },
  {
    operationId: "signOut",
    method: "post",
    path: "/v1/auth/sign-out",
    scope: "portal_unverified",
    internal: false,
  },
  {
    operationId: "signOutEverywhere",
    method: "post",
    path: "/v1/auth/sign-out-everywhere",
    scope: "portal_unverified",
    internal: false,
  },
  {
    operationId: "requestPasswordReset",
    method: "post",
    path: "/v1/auth/password-reset",
    scope: "public",
    internal: false,
  },
  {
    operationId: "confirmPasswordReset",
    method: "post",
    path: "/v1/auth/password-reset/confirm",
    scope: "public",
    internal: false,
  },
  { operationId: "stepUp", method: "post", path: "/v1/auth/step-up", scope: "portal", internal: false },
  { operationId: "getMe", method: "get", path: "/v1/me", scope: "portal_unverified", internal: false },
  { operationId: "updateMe", method: "patch", path: "/v1/me", scope: "portal_unverified", internal: false },
  {
    operationId: "changePassword",
    method: "post",
    path: "/v1/me/password",
    scope: "portal",
    internal: false,
  },
  {
    operationId: "startMfaSetup",
    method: "post",
    path: "/v1/me/mfa/setup",
    scope: "portal_unverified",
    internal: false,
  },
  {
    operationId: "enableMfa",
    method: "post",
    path: "/v1/me/mfa/enable",
    scope: "portal_unverified",
    internal: false,
  },
  { operationId: "disableMfa", method: "post", path: "/v1/me/mfa/disable", scope: "portal", internal: false },
  {
    operationId: "regenerateRecoveryCodes",
    method: "post",
    path: "/v1/me/mfa/recovery-codes",
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listSessions",
    method: "get",
    path: "/v1/me/sessions",
    scope: "portal_unverified",
    internal: false,
  },
  {
    operationId: "revokeSession",
    method: "delete",
    path: "/v1/me/sessions/{familyId}",
    scope: "portal_unverified",
    internal: false,
  },
  { operationId: "listPlans", method: "get", path: "/v1/plans", scope: "public", internal: false },
  { operationId: "tlsAsk", method: "get", path: "/internal/tls/ask", scope: "internal", internal: true },
  { operationId: "healthLive", method: "get", path: "/health/live", scope: "public", internal: true },
  { operationId: "healthReady", method: "get", path: "/health/ready", scope: "internal", internal: true },
];

/** The slice operations whose 2xx answer carries a secret and so documents `Cache-Control: no-store`. */
const SLICE_NO_STORE = [
  "signIn",
  "verifyMfa",
  "refreshSession",
  "stepUp",
  "startMfaSetup",
  "enableMfa",
  "regenerateRecoveryCodes",
] as const satisfies readonly PlatformOperationId[];

/** The tenant path prefix that api-inventory-resources.md writes as `…`. */
const TENANT_PATH = "/v1/tenants/{tenantId}";

/**
 * The PBE-006 slice: api-inventory §7 without `goLive` (9), §8 without `createConsoleToken` (9), the API keys of
 * api-inventory-resources §1 (5) and the M1 reads of §2, §3, §4 and §6 (4).
 */
const SLICE_PBE006: readonly SliceOperation[] = [
  {
    operationId: "checkTenantKey",
    method: "get",
    path: "/v1/tenants/key-availability",
    scope: "portal",
    internal: false,
  },
  { operationId: "createTenant", method: "post", path: "/v1/tenants", scope: "portal", internal: false },
  {
    operationId: "listTenants",
    method: "get",
    path: "/v1/tenants",
    scope: "portal_unverified",
    internal: false,
  },
  { operationId: "getTenant", method: "get", path: TENANT_PATH, scope: "portal", internal: false },
  { operationId: "updateTenant", method: "patch", path: TENANT_PATH, scope: "portal", internal: false },
  {
    operationId: "getProvisioning",
    method: "get",
    path: `${TENANT_PATH}/provisioning`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "retryProvisioning",
    method: "post",
    path: `${TENANT_PATH}/provisioning/retry`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "revealInitialKeys",
    method: "post",
    path: `${TENANT_PATH}/initial-keys/reveal`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "getOnboarding",
    method: "get",
    path: `${TENANT_PATH}/onboarding`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listMembers",
    method: "get",
    path: `${TENANT_PATH}/members`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "updateMember",
    method: "patch",
    path: `${TENANT_PATH}/members/{memberId}`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "removeMember",
    method: "delete",
    path: `${TENANT_PATH}/members/{memberId}`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listInvitations",
    method: "get",
    path: `${TENANT_PATH}/invitations`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "createInvitation",
    method: "post",
    path: `${TENANT_PATH}/invitations`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "resendInvitation",
    method: "post",
    path: `${TENANT_PATH}/invitations/{invitationId}/resend`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "revokeInvitation",
    method: "delete",
    path: `${TENANT_PATH}/invitations/{invitationId}`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "lookupInvitation",
    method: "post",
    path: "/v1/invitations/lookup",
    scope: "public",
    internal: false,
  },
  {
    operationId: "acceptInvitation",
    method: "post",
    path: "/v1/invitations/accept",
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listApiKeys",
    method: "get",
    path: `${TENANT_PATH}/api-keys`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "createApiKey",
    method: "post",
    path: `${TENANT_PATH}/api-keys`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "updateApiKey",
    method: "patch",
    path: `${TENANT_PATH}/api-keys/{keyId}`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "rollApiKey",
    method: "post",
    path: `${TENANT_PATH}/api-keys/{keyId}/roll`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "revokeApiKey",
    method: "post",
    path: `${TENANT_PATH}/api-keys/{keyId}/revoke`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listDomains",
    method: "get",
    path: `${TENANT_PATH}/domains`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listAmadeusConnections",
    method: "get",
    path: `${TENANT_PATH}/amadeus-connections`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listPaymentConnections",
    method: "get",
    path: `${TENANT_PATH}/payment-connections`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "getSubscription",
    method: "get",
    path: `${TENANT_PATH}/subscription`,
    scope: "portal",
    internal: false,
  },
];

/** The PBE-006 operations whose 2xx answer carries a key shown once and so documents `Cache-Control: no-store`. */
const SLICE_PBE006_NO_STORE = [
  "revealInitialKeys",
  "createApiKey",
  "rollApiKey",
] as const satisfies readonly PlatformOperationId[];

/** The PBE-006 operations that need a step-up only in some cases (a live secret key, granting `owner`). */
const SLICE_PBE006_CONDITIONAL_STEP_UP = [
  "updateMember",
  "createApiKey",
  "rollApiKey",
] as const satisfies readonly PlatformOperationId[];

/** The admin tenant path prefix. */
const ADMIN_TENANT_PATH = "/v1/admin/tenants/{tenantId}";

/**
 * The PBE-007 slice: api-inventory-admin §2 (admin auth and dashboard, 7) and §3 (tenants, provisioning jobs and
 * queues, 14). Only the password, MFA and refresh steps of the admin sign-in are `public`.
 */
const SLICE_PBE007: readonly SliceOperation[] = [
  {
    operationId: "adminSignIn",
    method: "post",
    path: "/v1/admin/auth/sign-in",
    scope: "public",
    internal: false,
  },
  {
    operationId: "adminVerifyMfa",
    method: "post",
    path: "/v1/admin/auth/mfa/verify",
    scope: "public",
    internal: false,
  },
  {
    operationId: "adminRefresh",
    method: "post",
    path: "/v1/admin/auth/refresh",
    scope: "public",
    internal: false,
  },
  {
    operationId: "adminStepUp",
    method: "post",
    path: "/v1/admin/auth/step-up",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminSignOut",
    method: "post",
    path: "/v1/admin/auth/sign-out",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminGetMe",
    method: "get",
    path: "/v1/admin/me",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminGetDashboard",
    method: "get",
    path: "/v1/admin/dashboard",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminListTenants",
    method: "get",
    path: "/v1/admin/tenants",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminGetTenant",
    method: "get",
    path: ADMIN_TENANT_PATH,
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminUpdateTenant",
    method: "patch",
    path: ADMIN_TENANT_PATH,
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminSuspendTenant",
    method: "post",
    path: `${ADMIN_TENANT_PATH}/suspend`,
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminResumeTenant",
    method: "post",
    path: `${ADMIN_TENANT_PATH}/resume`,
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminMigrateTenant",
    method: "post",
    path: `${ADMIN_TENANT_PATH}/migrate`,
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminSetConnectionStatus",
    method: "post",
    path: `${ADMIN_TENANT_PATH}/connections/{kind}/{environment}/status`,
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminListProvisioningJobs",
    method: "get",
    path: "/v1/admin/provisioning-jobs",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminGetProvisioningJob",
    method: "get",
    path: "/v1/admin/provisioning-jobs/{jobId}",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminRetryProvisioningJob",
    method: "post",
    path: "/v1/admin/provisioning-jobs/{jobId}/retry",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminCancelProvisioningJob",
    method: "post",
    path: "/v1/admin/provisioning-jobs/{jobId}/cancel",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminListQueues",
    method: "get",
    path: "/v1/admin/queues",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminListFailedQueueJobs",
    method: "get",
    path: "/v1/admin/queues/{queue}/failed",
    scope: "platform_admin",
    internal: false,
  },
  {
    operationId: "adminRetryQueueJob",
    method: "post",
    path: "/v1/admin/queues/{queue}/jobs/{jobId}/retry",
    scope: "platform_admin",
    internal: false,
  },
];

/** The PBE-007 operations marked **reason** in api-inventory-admin §3. */
const SLICE_PBE007_REASON = [
  "adminSuspendTenant",
  "adminResumeTenant",
  "adminSetConnectionStatus",
  "adminCancelProvisioningJob",
] as const satisfies readonly PlatformOperationId[];

/** The PBE-007 operations whose 2xx answer carries admin tokens or an admin MFA challenge. */
const SLICE_PBE007_NO_STORE = [
  "adminSignIn",
  "adminVerifyMfa",
  "adminRefresh",
  "adminStepUp",
] as const satisfies readonly PlatformOperationId[];

/** The only `/v1/admin/` operations without an admin token: the steps that obtain one (PADR-0006 item 1). */
const ADMIN_PUBLIC_OPERATIONS = ["adminSignIn", "adminVerifyMfa", "adminRefresh"] as const;

/** One PBE-066 operation: every one of them is `platform_admin`. */
interface AdminSliceOperation {
  readonly operationId: PlatformOperationId;
  readonly method: string;
  readonly path: string;
}

/**
 * The PBE-066 slice: the M1 rows of api-inventory-admin §4 (plans and subscriptions, 6), §5 (Amadeus accounts and
 * offices, 9) and §7 (accounts, platform admins and audit, 11).
 */
const SLICE_PBE066: readonly AdminSliceOperation[] = [
  { operationId: "adminListPlans", method: "get", path: "/v1/admin/plans" },
  { operationId: "adminCreatePlan", method: "post", path: "/v1/admin/plans" },
  { operationId: "adminUpdatePlan", method: "patch", path: "/v1/admin/plans/{planCode}" },
  { operationId: "adminListSubscriptions", method: "get", path: "/v1/admin/subscriptions" },
  { operationId: "adminGetSubscription", method: "get", path: "/v1/admin/subscriptions/{subscriptionId}" },
  {
    operationId: "adminUpdateManualSubscription",
    method: "patch",
    path: "/v1/admin/subscriptions/{subscriptionId}",
  },
  { operationId: "adminListAmadeusAccounts", method: "get", path: "/v1/admin/amadeus-accounts" },
  { operationId: "adminCreateAmadeusAccount", method: "post", path: "/v1/admin/amadeus-accounts" },
  {
    operationId: "adminUpdateAmadeusAccount",
    method: "patch",
    path: "/v1/admin/amadeus-accounts/{accountId}",
  },
  {
    operationId: "adminVerifyAmadeusAccount",
    method: "post",
    path: "/v1/admin/amadeus-accounts/{accountId}/verify",
  },
  { operationId: "adminListAmadeusOffices", method: "get", path: "/v1/admin/amadeus-offices" },
  { operationId: "adminAddAmadeusOffices", method: "post", path: "/v1/admin/amadeus-offices" },
  {
    operationId: "adminUpdateAmadeusOffice",
    method: "patch",
    path: "/v1/admin/amadeus-offices/{officeRowId}",
  },
  {
    operationId: "adminAssignAmadeusOffice",
    method: "post",
    path: "/v1/admin/amadeus-offices/{officeRowId}/assign",
  },
  {
    operationId: "adminRetireAmadeusOffice",
    method: "post",
    path: "/v1/admin/amadeus-offices/{officeRowId}/retire",
  },
  { operationId: "adminListAccounts", method: "get", path: "/v1/admin/accounts" },
  { operationId: "adminGetAccount", method: "get", path: "/v1/admin/accounts/{accountId}" },
  { operationId: "adminDisableAccount", method: "post", path: "/v1/admin/accounts/{accountId}/disable" },
  { operationId: "adminEnableAccount", method: "post", path: "/v1/admin/accounts/{accountId}/enable" },
  { operationId: "adminUnlockAccount", method: "post", path: "/v1/admin/accounts/{accountId}/unlock" },
  { operationId: "adminResetAccountMfa", method: "post", path: "/v1/admin/accounts/{accountId}/reset-mfa" },
  { operationId: "adminListAdmins", method: "get", path: "/v1/admin/admins" },
  { operationId: "adminGrantAdmin", method: "post", path: "/v1/admin/admins" },
  { operationId: "adminRevokeAdmin", method: "delete", path: "/v1/admin/admins/{accountId}" },
  { operationId: "adminListAudit", method: "get", path: "/v1/admin/audit-log" },
  { operationId: "adminExportAudit", method: "get", path: "/v1/admin/audit-log.csv" },
];

/** The PBE-066 operations marked **reason** in api-inventory-admin §4, §5 and §7. */
const SLICE_PBE066_REASON = [
  "adminUpdateManualSubscription",
  "adminRetireAmadeusOffice",
  "adminDisableAccount",
  "adminEnableAccount",
  "adminResetAccountMfa",
  "adminGrantAdmin",
] as const satisfies readonly PlatformOperationId[];

/** The PBE-066 operations marked MFA↑ for every call (PADR-0006 item 4). */
const SLICE_PBE066_STEP_UP = [
  "adminCreateAmadeusAccount",
  "adminResetAccountMfa",
  "adminGrantAdmin",
  "adminRevokeAdmin",
] as const satisfies readonly PlatformOperationId[];

/** The PBE-066 operation that needs a step-up only in some calls: "MFA↑ when the secret changes". */
const SLICE_PBE066_CONDITIONAL_STEP_UP = ["adminUpdateAmadeusAccount"] as const;

/** The columns of the audit CSV export, in file order. */
const AUDIT_CSV_COLUMNS = [
  "id",
  "createdAt",
  "tenantId",
  "tenantKey",
  "actorType",
  "actorAccountId",
  "actorLabel",
  "action",
  "targetType",
  "targetId",
  "requestId",
  "ipAddress",
  "userAgent",
  "details",
] as const;

/**
 * The responses whose body is not JSON, by operation and status. The Ajv checker of @velexis/testing refuses to check
 * them ("check its body another way"), so the slice test of each checks it instead; any other non-JSON response fails
 * the example check of every operation.
 */
const NON_JSON_RESPONSES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  adminExportAudit: { "200": ["text/csv"] },
};

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readYaml(file: string): Json {
  const document: unknown = parse(readFileSync(file, "utf8"));
  if (!isObject(document)) {
    throw new Error(`${file} is not a YAML mapping`);
  }
  return document;
}

function objectAt(value: unknown, key: string): Json {
  const child = isObject(value) ? value[key] : undefined;
  return isObject(child) ? child : {};
}

/** The value of a local `$ref` (`#/components/…`), following chained references. */
function resolve(document: Json, value: unknown): unknown {
  let current = value;
  for (let depth = 0; isObject(current) && typeof current["$ref"] === "string"; depth += 1) {
    if (depth > 10) {
      throw new Error(`$ref cycle at ${String(current["$ref"])}`);
    }
    const ref = current["$ref"];
    if (!ref.startsWith("#/")) {
      throw new Error(`non-local $ref ${ref}`);
    }
    current = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((node, segment) => (isObject(node) ? node[segment] : undefined), document);
    if (current === undefined) {
      throw new Error(`unresolved $ref ${ref}`);
    }
  }
  return current;
}

function operationsOf(document: Json): Operation[] {
  return Object.entries(objectAt(document, "paths")).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const spec = isObject(item) ? item[method] : undefined;
      return isObject(spec) ? [{ operationId: String(spec["operationId"]), method, path, spec }] : [];
    }),
  );
}

/** The responses of an operation, `$ref`s resolved: `[status, response]`. */
function responsesOf(document: Json, operation: Operation): Array<[string, Json]> {
  return Object.entries(objectAt(operation.spec, "responses")).map(([status, response]) => {
    const resolved = resolve(document, response);
    return [status, isObject(resolved) ? resolved : {}];
  });
}

/** Every example body of a media type (`example`, or each of `examples` with `$ref`s resolved). */
function examplesOf(document: Json, media: Json): unknown[] {
  if ("example" in media) {
    return [media["example"]];
  }
  return Object.values(objectAt(media, "examples")).map((example) => {
    const resolved = resolve(document, example);
    return isObject(resolved) ? resolved["value"] : undefined;
  });
}

function jsonMedia(response: Json): Json | undefined {
  const media = objectAt(response, "content")["application/json"];
  return isObject(media) ? media : undefined;
}

/** True when a request schema accepts no unknown property: closed objects, or a oneOf/anyOf of closed objects. */
function isClosed(document: Json, schema: unknown): boolean {
  const resolved = resolve(document, schema);
  if (!isObject(resolved)) {
    return false;
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    const branches = resolved[keyword];
    if (Array.isArray(branches)) {
      return branches.length > 0 && branches.every((branch) => isClosed(document, branch));
    }
  }
  return resolved["type"] === "object" && resolved["additionalProperties"] === false;
}

/** Every property name a schema can answer, through `$ref`s, compositions, nested objects and arrays. */
function propertyNames(
  document: Json,
  schema: unknown,
  found = new Set<string>(),
  seen = new Set<unknown>(),
) {
  const resolved = resolve(document, schema);
  if (!isObject(resolved) || seen.has(resolved)) {
    return found;
  }
  seen.add(resolved);
  for (const [name, child] of Object.entries(objectAt(resolved, "properties"))) {
    found.add(name);
    propertyNames(document, child, found, seen);
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    const branches = resolved[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch) => propertyNames(document, branch, found, seen));
    }
  }
  for (const keyword of ["items", "additionalProperties"]) {
    if (isObject(resolved[keyword])) {
      propertyNames(document, resolved[keyword], found, seen);
    }
  }
  return found;
}

/** Every local `$ref` a schema reaches, through `$ref`s and the subschemas of any keyword (examples left out). */
function referencesOf(document: Json, schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    schema.forEach((item) => referencesOf(document, item, found));
    return found;
  }
  if (!isObject(schema)) {
    return found;
  }
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (!found.has(ref)) {
      found.add(ref);
      referencesOf(document, resolve(document, schema), found);
    }
    return found;
  }
  for (const [keyword, child] of Object.entries(schema)) {
    if (keyword !== "example" && keyword !== "examples") {
      referencesOf(document, child, found);
    }
  }
  return found;
}

/** Schema annotations, left out when the shapes of the two documents are compared. */
const ANNOTATIONS = new Set(["description", "examples", "example", "additionalProperties"]);

/** A schema without its annotations, at any depth; `$ref`s stay as they are. */
function shape(schema: unknown): unknown {
  return JSON.parse(
    JSON.stringify(schema, (key, value: unknown) => (ANNOTATIONS.has(key) ? undefined : value)),
  );
}

/** The rows of a Markdown table section of the inventory, keyed by the operationId of the first cell. */
function inventoryRows(file: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const id = /^`([a-z][A-Za-z]+)`$/.exec(cells[1] ?? "")?.[1];
    if (id !== undefined && cells.length > 4) {
      rows.set(id, cells.slice(1, -1));
    }
  }
  return rows;
}

/** The error catalogue of api-inventory §3: code -> status. */
function inventoryCatalogue(): Map<string, number> {
  const text = readFileSync(INVENTORY, "utf8");
  const section = text.slice(text.indexOf("## 3. Error catalogue"), text.indexOf("## 4. "));
  const codes = new Map<string, number>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const status = Number(cells[2]);
    if (Number.isInteger(status) && status >= 400) {
      for (const [, code] of (cells[1] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
        codes.set(code ?? "", status);
      }
    }
  }
  return codes;
}

let platform: Json;
let ota: Json;
let operations: Operation[];
let checker: ResponseChecker;

beforeAll(() => {
  platform = readYaml(PLATFORM_DOCUMENT);
  ota = readYaml(OTA_DOCUMENT);
  operations = operationsOf(platform);
  checker = createResponseChecker(structuredClone(platform), { label: "platform" });
});

function operation(operationId: string): Operation {
  const found = operations.find((candidate) => candidate.operationId === operationId);
  if (found === undefined) {
    throw new Error(`the platform document has no operation ${operationId}`);
  }
  return found;
}

describe("the identity, plans and internal slice (PBE-005)", () => {
  it("lists the 24 operations of the slice in the operations index, each with its scope [PBE-005 AC2]", () => {
    expect(SLICE).toHaveLength(24);
    expect(new Set(SLICE.map((entry) => entry.operationId)).size).toBe(24);
    for (const entry of SLICE) {
      expect(platformOperations).toContainEqual(expect.objectContaining({ ...entry, sdkMethod: null }));
    }
    for (const entry of platformOperations) {
      expect(SCOPES).toContain(entry.scope);
    }
    // The index is generated from the document: both list the same operations in the same order.
    expect(platformOperations.map((entry) => entry.operationId)).toEqual(
      operations.map((entry) => entry.operationId),
    );
  });

  it("puts REAUTH_REQUIRED, TENANT_KEY_UNAVAILABLE and LIVE_PRECONDITIONS_UNMET in PlatformErrorCode [PBE-005 AC2]", () => {
    // Compiles only while the three codes are members of the generated union.
    const required: readonly PlatformErrorCode[] = [
      "REAUTH_REQUIRED",
      "TENANT_KEY_UNAVAILABLE",
      "LIVE_PRECONDITIONS_UNMET",
    ];
    expect(PLATFORM_ERROR_CODES).toEqual(expect.arrayContaining([...required]));
    expect(required.map((code) => [ERROR_CATALOGUE[code].status, ERROR_CATALOGUE[code].source])).toEqual([
      [401, "platform"],
      [409, "platform"],
      [422, "platform"],
    ]);
  });

  it("documents each slice operation with the method, path, scope and flags of the API inventory", () => {
    const rows = new Map([...inventoryRows(INVENTORY), ...inventoryRows(INVENTORY_ADMIN)]);
    for (const entry of SLICE) {
      const row = rows.get(entry.operationId);
      expect(row, entry.operationId).toBeDefined();
      const [, route = "", auth = ""] = row ?? [];
      const [method = "", path = ""] = route.replaceAll("`", "").split(" ");
      expect([entry.method, entry.path], entry.operationId).toEqual([
        method.toLowerCase(),
        path.split("?")[0],
      ]);

      const marks = auth.replaceAll("`", "").split(/,\s*/);
      const scope = marks.includes("portal*")
        ? "portal_unverified"
        : marks.find((mark) => (SCOPES as readonly string[]).includes(mark));
      const spec = operation(entry.operationId).spec;
      expect([spec["x-scope"], entry.scope], entry.operationId).toEqual([scope, scope]);
      expect(spec["x-mfa-step-up"] === true, `${entry.operationId} x-mfa-step-up`).toBe(
        marks.includes("MFA↑"),
      );
      expect(spec["x-idempotent"] === true, `${entry.operationId} x-idempotent`).toBe(marks.includes("Idem"));
      expect("x-feature" in spec, `${entry.operationId} x-feature`).toBe(
        marks.some((mark) => mark.startsWith("F:")),
      );
      expect(spec["x-reason-required"], `${entry.operationId} x-reason-required`).toBeUndefined();
      expect(spec["x-internal"] === true, `${entry.operationId} x-internal`).toBe(entry.internal);
    }
  });

  it("documents Cache-Control: no-store on the slice answers that carry tokens, the TOTP secret or recovery codes", () => {
    const noStore = SLICE.filter((entry) =>
      responsesOf(platform, operation(entry.operationId)).some(
        ([status, response]) =>
          status.startsWith("2") &&
          objectAt(objectAt(response, "headers"), "Cache-Control")["$ref"] === "#/components/headers/NoStore",
      ),
    ).map((entry) => entry.operationId);
    expect(noStore).toEqual([...SLICE_NO_STORE]);
  });

  it("documents the health answers that HealthService gives today", async () => {
    const up = new HealthService(
      { query: () => Promise.resolve({}) },
      { ping: () => Promise.resolve("PONG") },
    );
    const redisDown = new HealthService(
      { query: () => Promise.resolve({}) },
      { ping: () => Promise.reject(new Error("connection refused")) },
    );
    const ready = (await up.ready()).report;
    const unavailable = (await redisDown.ready()).report;

    expect(checker.check("healthLive", { status: 200, body: up.live() })).toEqual([]);
    expect(checker.check("healthReady", { status: 200, body: ready })).toEqual([]);
    expect(checker.check("healthReady", { status: 503, body: unavailable })).toEqual([]);
    expect(unavailable.checks.redis).toBe("down");
  });
});

/** The auth marks of an inventory row: its Auth cell split at commas and semicolons, without backticks. */
function authMarks(auth: string): string[] {
  return auth
    .replaceAll("`", "")
    .split(/[,;]\s*/)
    .map((mark) => mark.trim());
}

/** The `x-scope` an inventory Auth cell stands for: `portal*` is `portal_unverified`, `portal: roles` is `portal`. */
function scopeOf(marks: readonly string[]): string | undefined {
  const [first = ""] = marks;
  if (first === "portal*") {
    return "portal_unverified";
  }
  return first.startsWith("portal") ? "portal" : first;
}

describe("the tenants, team, API keys and M1 reads slice (PBE-006)", () => {
  it("lists the 27 operations of the slice in the operations index, each with an x-scope [PBE-006 AC1]", () => {
    expect(SLICE_PBE006).toHaveLength(27);
    const ids = new Set(SLICE_PBE006.map((entry) => entry.operationId));
    expect(ids.size).toBe(27);
    // 27 more operations: none of them belongs to the PBE-005 slice.
    expect(SLICE.filter((entry) => ids.has(entry.operationId))).toEqual([]);
    for (const entry of SLICE_PBE006) {
      expect(platformOperations).toContainEqual(expect.objectContaining({ ...entry, sdkMethod: null }));
      expect([entry.operationId, operation(entry.operationId).spec["x-scope"]]).toEqual([
        entry.operationId,
        entry.scope,
      ]);
    }
  });

  it("documents each slice operation with the method, path, scope and flags of the API inventory [PBE-006 AC1]", () => {
    const rows = new Map([...inventoryRows(INVENTORY), ...inventoryRows(INVENTORY_RESOURCES)]);
    const authOf = (operationId: string): string => {
      const auth = rows.get(operationId)?.[2] ?? "";
      // `rollApiKey` is authorised "as `createApiKey`".
      const same = /^as `([a-z][A-Za-z]+)`$/.exec(auth)?.[1];
      return same === undefined ? auth : authOf(same);
    };
    for (const entry of SLICE_PBE006) {
      const row = rows.get(entry.operationId);
      expect(row, entry.operationId).toBeDefined();
      const [, route = ""] = row ?? [];
      const [method = "", path = ""] = route.replaceAll("`", "").split(" ");
      expect([entry.operationId, entry.method, entry.path]).toEqual([
        entry.operationId,
        method.toLowerCase(),
        (path.split("?")[0] ?? "").replace(/^…/, TENANT_PATH),
      ]);

      const auth = authOf(entry.operationId);
      const marks = authMarks(auth);
      const spec = operation(entry.operationId).spec;
      expect([entry.operationId, spec["x-scope"]]).toEqual([entry.operationId, scopeOf(marks)]);
      expect([entry.operationId, spec["x-idempotent"] === true]).toEqual([
        entry.operationId,
        marks.includes("Idem"),
      ]);
      expect([entry.operationId, "x-feature" in spec]).toEqual([
        entry.operationId,
        marks.some((mark) => mark.startsWith("F:")),
      ]);
      expect([entry.operationId, spec["x-reason-required"], spec["x-internal"]]).toEqual([
        entry.operationId,
        undefined,
        undefined,
      ]);
      // A step-up for every call is `x-mfa-step-up`; one for some calls only ("live secret keys MFA↑",
      // "granting owner: MFA↑") is enforced by the service and shows in the error codes instead.
      expect([entry.operationId, spec["x-mfa-step-up"] === true]).toEqual([
        entry.operationId,
        marks.includes("MFA↑"),
      ]);
      const conditional = auth.includes("MFA↑") && !marks.includes("MFA↑");
      expect([entry.operationId, conditional]).toEqual([
        entry.operationId,
        (SLICE_PBE006_CONDITIONAL_STEP_UP as readonly string[]).includes(entry.operationId),
      ]);
      if (conditional) {
        expect([entry.operationId, spec["x-error-codes"]]).toEqual([
          entry.operationId,
          expect.arrayContaining(["REAUTH_REQUIRED", "MFA_REQUIRED"]),
        ]);
      }
    }
  });

  it("makes createTenant idempotent and documents no-store on the answers of createApiKey, rollApiKey and revealInitialKeys [PBE-006 AC2]", () => {
    expect(operation("createTenant").spec["x-idempotent"]).toBe(true);
    expect(
      SLICE_PBE006.filter((entry) => operation(entry.operationId).spec["x-idempotent"] === true),
    ).toEqual([expect.objectContaining({ operationId: "createTenant" })]);

    const noStore = SLICE_PBE006.filter((entry) =>
      responsesOf(platform, operation(entry.operationId)).some(
        ([status, response]) =>
          status.startsWith("2") &&
          objectAt(objectAt(response, "headers"), "Cache-Control")["$ref"] === "#/components/headers/NoStore",
      ),
    ).map((entry) => entry.operationId);
    expect([...noStore].sort()).toEqual([...SLICE_PBE006_NO_STORE].sort());

    // Each of them answers the full key, and every 2xx answer of the three documents no-store.
    for (const operationId of SLICE_PBE006_NO_STORE) {
      for (const [status, response] of responsesOf(platform, operation(operationId))) {
        if (status.startsWith("2")) {
          const header = resolve(platform, objectAt(response, "headers")["Cache-Control"]);
          expect([operationId, status, objectAt(header, "schema")["const"]]).toEqual([
            operationId,
            status,
            "no-store",
          ]);
          expect([operationId, propertyNames(platform, jsonMedia(response)?.["schema"]).has("key")]).toEqual([
            operationId,
            true,
          ]);
        }
      }
    }
  });

  it("answers no property ending in Ciphertext or Hash in any response of the slice [PBE-006 AC3]", () => {
    const leaky = (name: string): boolean => /(ciphertext|hash)$/i.test(name);
    // The walker sees nested and referenced properties, so the check cannot pass by not looking.
    const probe = { type: "object", properties: { apiKey: { $ref: "#/components/schemas/ApiKey" } } };
    expect(propertyNames(platform, probe)).toContain("lastUsedAt");
    expect([
      ...propertyNames(platform, { properties: { a: { items: { properties: { keyHash: {} } } } } }),
    ]).toEqual(["a", "keyHash"]);

    for (const { operationId } of SLICE_PBE006) {
      for (const [status, response] of responsesOf(platform, operation(operationId))) {
        const names = [...propertyNames(platform, jsonMedia(response)?.["schema"])];
        expect([operationId, status, names.filter(leaky)]).toEqual([operationId, status, []]);
      }
    }
  });

  it("generates no property ending in Ciphertext or Hash in @velexis/api-types/platform [PBE-006 AC3]", () => {
    const generated = readFileSync(GENERATED_PLATFORM_TYPES, "utf8");
    expect(generated).toContain("revealInitialKeys");
    // A property line of openapi-typescript, with or without `readonly`, quotes or `?`, in any case.
    const property = /^\s*(?:readonly\s+)?"?[A-Za-z0-9_]*(?:ciphertext|hash)"?\??:/gim;
    expect("    keyHash: string;\n    readonly secretCiphertext?: string;\n".match(property)).toHaveLength(2);
    expect(generated.match(property) ?? []).toEqual([]);
  });

  it("defines the shared schemas of step 4, none with a property for a secret, ciphertext or hash", () => {
    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    const shared = [
      "Tenant",
      "TenantSummary",
      "ProvisioningStatus",
      "OnboardingItem",
      "Member",
      "Invitation",
      "ApiKey",
      "Domain",
      "AmadeusConnection",
      "PaymentConnection",
      "Subscription",
    ];
    for (const name of shared) {
      expect([
        name,
        objectAt(schemas, name)["type"],
        objectAt(schemas, name)["additionalProperties"],
      ]).toEqual([name, "object", false]);
      const names = [...propertyNames(platform, { $ref: `#/components/schemas/${name}` })];
      expect([
        name,
        names.filter((property) => /(secret|ciphertext|hash|password|token)$/i.test(property)),
      ]).toEqual([name, []]);
    }
    expect(propertyNames(platform, { $ref: "#/components/schemas/Domain" })).toContain("dnsRecords");
  });

  it("refuses an API key answer that leaks a hash, and keeps the M5 fields of createTenant", () => {
    const [, created = {}] =
      responsesOf(platform, operation("createApiKey")).find(([status]) => status === "201") ?? [];
    const [body] = examplesOf(platform, jsonMedia(created) ?? {});
    expect(checker.check("createApiKey", { status: 201, body })).toEqual([]);
    const leaky = {
      ...(isObject(body) ? body : {}),
      apiKey: { ...objectAt(body, "apiKey"), keyHash: "0".repeat(64) },
    };
    expect(checker.check("createApiKey", { status: 201, body: leaky })).toEqual([
      expect.objectContaining({ path: "/apiKey/keyHash", keyword: "additionalProperties" }),
    ]);

    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    expect(Object.keys(objectAt(objectAt(schemas, "CreateTenantRequest"), "properties"))).toEqual(
      expect.arrayContaining(["planCode", "billingInterval"]),
    );
    const createdTenant = objectAt(schemas, "TenantCreated");
    expect(createdTenant["required"]).toContain("checkoutUrl");
    expect(createdTenant["required"]).not.toContain("checkoutError");
    expect(objectAt(objectAt(createdTenant, "properties"), "checkoutUrl")["type"]).toEqual([
      "string",
      "null",
    ]);
  });

  it("accepts every ConsoleApiKeyScope and StaffPermission of the OTA contract as an API key scope", () => {
    // The service validates scopes against the generated OTA types (PADR-0005 item 6); the schema must never
    // refuse one of them first.
    const otaSchemas = objectAt(objectAt(ota, "components"), "schemas");
    const values = ["ConsoleApiKeyScope", "StaffPermission"].flatMap((name) => {
      const list: unknown = objectAt(otaSchemas, name)["enum"];
      return Array.isArray(list) ? list.map(String) : [];
    });
    expect(values).toEqual(expect.arrayContaining(["storefront", "console:automation", "bookings:issue"]));
    const scope = objectAt(objectAt(objectAt(platform, "components"), "schemas"), "ApiKeyScope");
    expect(scope["enum"]).toBeUndefined();
    const pattern = new RegExp(String(scope["pattern"]), "u");
    expect(values.filter((value) => !pattern.test(value))).toEqual([]);
  });

  it("lists the onboarding items of PADR-0018 in its order", () => {
    const adr = readFileSync(ONBOARDING_ADR, "utf8");
    const ids = [...adr.matchAll(/^\| `([a-z_]+)` \|/gm)].map(([, id]) => id);
    expect(ids).toHaveLength(11);
    const item = objectAt(objectAt(objectAt(platform, "components"), "schemas"), "OnboardingItem");
    expect(objectAt(objectAt(item, "properties"), "id")["enum"]).toEqual(ids);
  });
});

/** The JSON request body schema of an operation, `$ref`s of the request body resolved. */
function requestSchemaOf(operationId: string): unknown {
  const body = resolve(platform, operation(operationId).spec["requestBody"]);
  return objectAt(objectAt(body, "content"), "application/json")["schema"];
}

/**
 * The Ajv checker of @velexis/testing applied to request bodies: a document whose operations answer their request
 * body schema, so a body is checked exactly as the integration tests check a response (Ajv 2020, strict).
 */
function requestBodyChecker(operationIds: readonly string[]): ResponseChecker {
  const paths = Object.fromEntries(
    operationIds.map((operationId) => [
      `/${operationId}`,
      {
        post: {
          operationId,
          responses: {
            "200": {
              description: `The request body of ${operationId}.`,
              content: { "application/json": { schema: requestSchemaOf(operationId) } },
            },
          },
        },
      },
    ]),
  );
  const document = { openapi: "3.1.0", paths, components: platform["components"] };
  return createResponseChecker(structuredClone(document), { label: "platform requests" });
}

/** The marks of an api-inventory-admin row: `(public)` in the route cell, **reason** and MFA↑ in either cell. */
function adminRowMarks(row: readonly string[]): { scope: string; reason: boolean; stepUp: boolean } {
  const [, route = "", purpose = ""] = row;
  return {
    scope: route.includes("(public)") ? "public" : "platform_admin",
    reason: purpose.includes("**reason**"),
    stepUp: route.includes("MFA↑") || purpose.includes("MFA↑"),
  };
}

describe("the admin auth, dashboard, tenants, jobs and queues slice (PBE-007)", () => {
  it("lists the 21 operations of the slice in the operations index, each with an x-scope [PBE-007 AC1]", () => {
    expect(SLICE_PBE007).toHaveLength(21);
    const ids = new Set(SLICE_PBE007.map((entry) => entry.operationId));
    expect(ids.size).toBe(21);
    // 21 more operations: none of them belongs to an earlier slice.
    expect([...SLICE, ...SLICE_PBE006].filter((entry) => ids.has(entry.operationId))).toEqual([]);
    for (const entry of SLICE_PBE007) {
      expect(platformOperations).toContainEqual(expect.objectContaining({ ...entry, sdkMethod: null }));
      expect([entry.operationId, operation(entry.operationId).spec["x-scope"]]).toEqual([
        entry.operationId,
        entry.scope,
      ]);
    }
  });

  it("documents each slice operation with the method, path, scope and marks of api-inventory-admin [PBE-007 AC1]", () => {
    const rows = inventoryRows(INVENTORY_ADMIN);
    for (const entry of SLICE_PBE007) {
      const row = rows.get(entry.operationId);
      expect(row, entry.operationId).toBeDefined();
      const [, route = ""] = row ?? [];
      const [method = "", path = ""] = (/`([^`]+)`/.exec(route)?.[1] ?? "").split(" ");
      expect([entry.operationId, entry.method, entry.path]).toEqual([
        entry.operationId,
        method.toLowerCase(),
        path.split("?")[0],
      ]);

      const marks = adminRowMarks(row ?? []);
      const spec = operation(entry.operationId).spec;
      expect([entry.operationId, spec["x-scope"]]).toEqual([entry.operationId, marks.scope]);
      expect([entry.operationId, spec["x-reason-required"] === true]).toEqual([
        entry.operationId,
        marks.reason,
      ]);
      expect([entry.operationId, spec["x-mfa-step-up"] === true]).toEqual([entry.operationId, marks.stepUp]);
      expect([entry.operationId, spec["x-idempotent"], spec["x-feature"], spec["x-internal"]]).toEqual([
        entry.operationId,
        undefined,
        undefined,
        undefined,
      ]);
    }
  });

  it("gives every /v1/admin/ operation x-scope platform_admin and the admin bearer, except the three sign-in steps [PBE-007 AC2]", () => {
    const admin = operations.filter((op) => op.path.startsWith("/v1/admin/"));
    // The check sees the whole slice, so it cannot pass by not looking.
    expect(admin.map((op) => op.operationId)).toEqual(
      expect.arrayContaining(SLICE_PBE007.map((entry) => entry.operationId)),
    );
    for (const op of admin) {
      const isPublic = (ADMIN_PUBLIC_OPERATIONS as readonly string[]).includes(op.operationId);
      expect([op.operationId, op.spec["x-scope"], op.spec["security"]]).toEqual([
        op.operationId,
        isPublic ? "public" : "platform_admin",
        isPublic ? [] : [{ adminBearer: [] }],
      ]);
    }
    // Every platform_admin operation lives under /v1/admin/.
    for (const op of operations.filter((candidate) => candidate.spec["x-scope"] === "platform_admin")) {
      expect([op.operationId, op.path.startsWith("/v1/admin/")]).toEqual([op.operationId, true]);
    }
  });

  it("requires a reason of 5–500 characters on adminSuspendTenant, adminResumeTenant, adminSetConnectionStatus and adminCancelProvisioningJob [PBE-007 AC3]", () => {
    expect(
      SLICE_PBE007.filter((entry) => operation(entry.operationId).spec["x-reason-required"] === true).map(
        (entry) => entry.operationId,
      ),
    ).toEqual([...SLICE_PBE007_REASON]);

    const bodies: Record<(typeof SLICE_PBE007_REASON)[number], Json> = {
      adminSuspendTenant: { suspensionReason: "abuse" },
      adminResumeTenant: {},
      adminSetConnectionStatus: { status: "disabled" },
      adminCancelProvisioningJob: {},
    };
    const requests = requestBodyChecker(SLICE_PBE007_REASON);
    for (const operationId of SLICE_PBE007_REASON) {
      const body = bodies[operationId];
      const check = (reason?: string) =>
        requests.check(operationId, { status: 200, body: reason === undefined ? body : { ...body, reason } });
      expect([operationId, operation(operationId).spec["requestBody"]]).toEqual([
        operationId,
        expect.objectContaining({ required: true }),
      ]);
      expect([operationId, check("Abuse")]).toEqual([operationId, []]);
      expect([operationId, check("x".repeat(500))]).toEqual([operationId, []]);
      expect([operationId, check()]).toEqual([
        operationId,
        [expect.objectContaining({ keyword: "required" })],
      ]);
      expect([operationId, check("Spam")]).toEqual([
        operationId,
        [expect.objectContaining({ path: "/reason", keyword: "minLength" })],
      ]);
      expect([operationId, check("x".repeat(501))]).toEqual([
        operationId,
        [expect.objectContaining({ path: "/reason", keyword: "maxLength" })],
      ]);
    }
    // A billing suspension is set only by billing sync (PADR-0014 item 1).
    expect(
      requests.check("adminSuspendTenant", {
        status: 200,
        body: { suspensionReason: "billing", reason: "Unpaid invoice" },
      }),
    ).toEqual([expect.objectContaining({ path: "/suspensionReason", keyword: "enum" })]);
  });

  it("answers adminGetMe with the features of getMe, also inside AdminSession, and notes it in the inventory", () => {
    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    const features = objectAt(objectAt(schemas, "Account"), "properties")["features"];
    expect(objectAt(objectAt(schemas, "AdminMe"), "properties")["features"]).toEqual(features);
    expect(objectAt(schemas, "AdminMe")["required"]).toEqual(["id", "email", "fullName", "features"]);
    expect(objectAt(objectAt(schemas, "AdminSession"), "properties")["admin"]).toEqual({
      $ref: "#/components/schemas/AdminMe",
    });

    const [, , , exchange = ""] = inventoryRows(INVENTORY_ADMIN).get("adminGetMe") ?? [];
    expect(exchange).toContain("features");
  });

  it("documents no-store exactly on the slice answers with admin tokens or an MFA challenge", () => {
    const noStore = SLICE_PBE007.filter((entry) =>
      responsesOf(platform, operation(entry.operationId)).some(
        ([status, response]) =>
          status.startsWith("2") &&
          objectAt(objectAt(response, "headers"), "Cache-Control")["$ref"] === "#/components/headers/NoStore",
      ),
    ).map((entry) => entry.operationId);
    expect(noStore).toEqual([...SLICE_PBE007_NO_STORE]);
  });

  it("keeps the M5 counters of the dashboard present and nullable", () => {
    const [, , , exchange = ""] = inventoryRows(INVENTORY_ADMIN).get("adminGetDashboard") ?? [];
    const flat = exchange.replace(/\[[^\]]*\]/g, "");
    const names = [...flat.matchAll(/(?:\{|,\s*)([a-z][A-Za-z0-9]*)/g)].map(([, name = ""]) => name);
    const m5 = [...flat.matchAll(/([a-z][A-Za-z0-9]*) \(M5\)/g)].map(([, name = ""]) => name);
    expect(m5).toEqual([
      "domainsPending",
      "settlementsToReview",
      "stripeEventsFailed",
      "subscriptionsPastDue",
    ]);

    const dashboard = objectAt(objectAt(objectAt(platform, "components"), "schemas"), "AdminDashboard");
    expect(dashboard["required"]).toEqual(names);
    for (const name of m5) {
      expect([name, objectAt(objectAt(dashboard, "properties"), name)["type"]]).toEqual([
        name,
        ["integer", "null"],
      ]);
    }
    const [, ok = {}] =
      responsesOf(platform, operation("adminGetDashboard")).find(([status]) => status === "200") ?? [];
    const [beforeM5] = examplesOf(platform, jsonMedia(ok) ?? {});
    const counters = isObject(beforeM5) ? beforeM5 : {};
    expect(m5.map((name) => counters[name])).toEqual([null, null, null, null]);
    expect(checker.check("adminGetDashboard", { status: 200, body: beforeM5 })).toEqual([]);
    const withoutCounter = { ...counters };
    delete withoutCounter["settlementsToReview"];
    expect(checker.check("adminGetDashboard", { status: 200, body: withoutCounter })).toEqual([
      expect.objectContaining({ keyword: "required" }),
    ]);
  });

  it("answers no property ending in Secret, Ciphertext or Hash in any response of the slice", () => {
    const leaky = (name: string): boolean => /(secret|ciphertext|hash)$/i.test(name);
    // The tenant detail reaches the masked connections, so the walk covers the shapes most likely to leak.
    expect(propertyNames(platform, { $ref: "#/components/schemas/AdminTenantDetail" })).toContain(
      "pendingSubmission",
    );
    for (const { operationId } of SLICE_PBE007) {
      for (const [status, response] of responsesOf(platform, operation(operationId))) {
        const names = [...propertyNames(platform, jsonMedia(response)?.["schema"])];
        expect([operationId, status, names.filter(leaky)]).toEqual([operationId, status, []]);
      }
    }
    // The tenant detail refuses a connection answer that leaks a ciphertext.
    const [, ok = {}] =
      responsesOf(platform, operation("adminGetTenant")).find(([status]) => status === "200") ?? [];
    const [detail] = examplesOf(platform, jsonMedia(ok) ?? {});
    const body = isObject(detail) ? detail : {};
    const connections: unknown = body["amadeusConnections"];
    const [first] = Array.isArray(connections) ? (connections as unknown[]) : [];
    expect(checker.check("adminGetTenant", { status: 200, body })).toEqual([]);
    const leakyDetail = {
      ...body,
      amadeusConnections: [{ ...(isObject(first) ? first : {}), clientSecretCiphertext: "AAAA" }],
    };
    expect(checker.check("adminGetTenant", { status: 200, body: leakyDetail })).toEqual([
      expect.objectContaining({ path: "/amadeusConnections/0/clientSecretCiphertext" }),
    ]);
  });

  it("lists the queue names of @velexis/api-types/jobs in its examples, with the OTA queues owned by ota", () => {
    const pattern = new RegExp(
      String(objectAt(objectAt(objectAt(platform, "components"), "schemas"), "QueueName")["pattern"]),
      "u",
    );
    for (const name of [...PLATFORM_QUEUES, ...OTA_QUEUES]) {
      expect([name, pattern.test(name)]).toEqual([name, true]);
    }
    const [, ok = {}] =
      responsesOf(platform, operation("adminListQueues")).find(([status]) => status === "200") ?? [];
    const [example] = examplesOf(platform, jsonMedia(ok) ?? {});
    const data: unknown = isObject(example) ? example["data"] : undefined;
    const known: readonly string[] = [...PLATFORM_QUEUES, ...OTA_QUEUES];
    expect(Array.isArray(data) && data.length > 0).toBe(true);
    for (const queue of Array.isArray(data) ? (data as unknown[]) : []) {
      const name = isObject(queue) ? String(queue["name"]) : "";
      const owner = (OTA_QUEUES as readonly string[]).includes(name) ? "ota" : "platform";
      expect([name, known.includes(name), isObject(queue) ? queue["owner"] : undefined]).toEqual([
        name,
        true,
        owner,
      ]);
    }
    const [, dashboard = {}] =
      responsesOf(platform, operation("adminGetDashboard")).find(([status]) => status === "200") ?? [];
    for (const body of examplesOf(platform, jsonMedia(dashboard) ?? {})) {
      expect(Object.keys(objectAt(body, "jobsFailedByQueue"))).toEqual([...PLATFORM_QUEUES]);
    }
  });

  it("follows @velexis/api-types/jobs for migration versions, suspension reasons, job kinds and tenant job ids", () => {
    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    // targetVersion goes into tenant.migrate unchanged, and schemaVersion mirrors the same migration ledger.
    expect(objectAt(schemas, "TenantMigrationVersion")["pattern"]).toBe(TENANT_MIGRATION_VERSION_PATTERN);
    const tenantProperties = objectAt(objectAt(schemas, "AdminTenant"), "properties");
    expect(objectAt(tenantProperties, "schemaVersion")["pattern"]).toBe(TENANT_MIGRATION_VERSION_PATTERN);
    // An admin suspends for any reason of tenant.suspend but billing, which billing sync sets (PADR-0014 item 1).
    const suspendProperties = objectAt(objectAt(schemas, "SuspendTenantRequest"), "properties");
    expect(objectAt(suspendProperties, "suspensionReason")["enum"]).toEqual(
      TENANT_SUSPENSION_REASONS.filter((reason) => reason !== "billing"),
    );
    // Every job kind is dispatched as the tenant.<kind> message of ota-tenant-ops.
    expect(objectAt(schemas, "ProvisioningJobKind")["enum"]).toEqual(
      TENANT_OPS_JOB_NAMES.map((name) => name.replace(/^tenant\./u, "")),
    );
    // A failed attempt of a tenant job is addressable by its BullMQ id, so adminRetryQueueJob reaches its 403.
    const parameters = objectAt(objectAt(platform, "components"), "parameters");
    const jobIdPattern = new RegExp(
      String(objectAt(objectAt(parameters, "QueueJobId"), "schema")["pattern"]),
      "u",
    );
    expect(jobIdPattern.test(bullmqJobId("job_01JB3K9R4T8W2Y6A0C4E8G2J6M", 5))).toBe(true);
    expect(jobIdPattern.test("1843")).toBe(true);
  });

  it("answers 503 SERVICE_UNAVAILABLE on every slice operation that reads BullMQ", () => {
    const readsBullmq = [
      "adminGetDashboard",
      "adminListQueues",
      "adminListFailedQueueJobs",
      "adminRetryQueueJob",
    ] as const satisfies readonly PlatformOperationId[];
    for (const operationId of readsBullmq) {
      const statuses = responsesOf(platform, operation(operationId)).map(([status]) => status);
      expect([operationId, operation(operationId).spec["x-error-codes"], statuses]).toEqual([
        operationId,
        expect.arrayContaining(["SERVICE_UNAVAILABLE"]),
        expect.arrayContaining(["503"]),
      ]);
    }
  });
});

/** One operation of an api-inventory-admin row of §4, §5 or §7. */
interface AdminInventoryRow {
  readonly method: string;
  readonly path: string;
  /** The names of the query of the route cell (`?q=&status=` gives `q`, `status`). */
  readonly query: readonly string[];
  readonly reason: boolean;
  /** MFA↑ on every call. */
  readonly stepUp: boolean;
  /** MFA↑ in some calls only ("MFA↑ when the secret changes"). */
  readonly conditionalStepUp: boolean;
  readonly exchange: string;
  readonly milestone: string;
}

/**
 * The rows of api-inventory-admin §4, §5 and §7 by operationId. One row may name two operations
 * (`adminDisableAccount` / `adminEnableAccount` with `POST …/disable` / `enable`): the second route replaces the last
 * segment of the first path.
 */
function adminSectionRows(): Map<string, AdminInventoryRow> {
  const text = readFileSync(INVENTORY_ADMIN, "utf8");
  const sections = ["## 4. ", "## 5. ", "## 7. "].map((heading) => {
    const start = text.indexOf(heading);
    expect([heading, start >= 0]).toEqual([heading, true]);
    return text.slice(start, text.indexOf("\n## ", start + 1));
  });
  const rows = new Map<string, AdminInventoryRow>();
  for (const line of sections.join("\n").split("\n")) {
    // A pipe escaped as `\|` (`"trialing" \| "canceled"`) belongs to its cell.
    const cells = line.split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));
    const [, first = "", route = "", purpose = "", exchange = "", , , milestone = ""] = cells;
    if (cells.length < 9 || !first.startsWith("`")) {
      continue;
    }
    const ids = [...first.matchAll(/`([a-z][A-Za-z]+)`/g)].map(([, id = ""]) => id);
    const routes = [...route.matchAll(/`([^`]+)`/g)].map(([, value = ""]) => value);
    const [method = "", target = ""] = (routes[0] ?? "").split(" ");
    const [basePath = "", query = ""] = target.split("?");
    const marks = `${route} ${purpose}`;
    ids.forEach((id, index) => {
      rows.set(id, {
        method: method.toLowerCase(),
        path: index === 0 ? basePath : basePath.replace(/[^/]+$/, routes[index] ?? ""),
        query: [...query.matchAll(/([A-Za-z]+)=/g)].map(([, name = ""]) => name),
        reason: purpose.includes("**reason**"),
        stepUp: /MFA↑(?! when)/u.test(marks),
        conditionalStepUp: /MFA↑ when/u.test(marks),
        exchange,
        milestone,
      });
    });
  }
  return rows;
}

/** The cells of one RFC 4180 CSV line: quoted cells may hold commas and doubled quotes. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quoted && character === '"' && line.charAt(index + 1) === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

/** The parameters of an operation (its own, not the path item's), `$ref`s resolved. */
function parametersOf(operationId: string): Json[] {
  const list: unknown = operation(operationId).spec["parameters"];
  return (Array.isArray(list) ? (list as unknown[]) : []).map((parameter) => {
    const resolved = resolve(platform, parameter);
    return isObject(resolved) ? resolved : {};
  });
}

/** The 2xx response of an operation with that status. */
function successOf(operationId: string, status: string): Json {
  const [, response = {}] =
    responsesOf(platform, operation(operationId)).find(([candidate]) => candidate === status) ?? [];
  return response;
}

describe("the admin plans, Amadeus, accounts, admins and audit slice (PBE-066)", () => {
  it("lists the 26 operations of the slice in the operations index, each with x-scope platform_admin [PBE-066 AC1]", () => {
    expect(SLICE_PBE066).toHaveLength(26);
    const ids = new Set(SLICE_PBE066.map((entry) => entry.operationId));
    expect(ids.size).toBe(26);
    // 26 more operations: none of them belongs to an earlier slice.
    expect(
      [...SLICE, ...SLICE_PBE006, ...SLICE_PBE007].filter((entry) => ids.has(entry.operationId)),
    ).toEqual([]);
    for (const entry of SLICE_PBE066) {
      expect(platformOperations).toContainEqual(
        expect.objectContaining({ ...entry, scope: "platform_admin", internal: false, sdkMethod: null }),
      );
      expect([entry.operationId, operation(entry.operationId).spec["x-scope"]]).toEqual([
        entry.operationId,
        "platform_admin",
      ]);
    }
    // With the PBE-007 slice, the 47 M1 admin operations, every one under /v1/admin/.
    const admin = new Set([...SLICE_PBE007, ...SLICE_PBE066].map((entry) => entry.operationId));
    expect(admin.size).toBe(47);
    for (const operationId of admin) {
      expect([operationId, operation(operationId).path.startsWith("/v1/admin/")]).toEqual([
        operationId,
        true,
      ]);
    }
  });

  it("documents each slice operation with the method, path, query and marks of the M1 rows of api-inventory-admin §4, §5 and §7 [PBE-066 AC1]", () => {
    const rows = adminSectionRows();
    // The slice is exactly the M1 rows of the three sections; the M5 rows follow in PBE-042.
    const m1 = [...rows]
      .filter(([, row]) => row.milestone.startsWith("M1"))
      .map(([operationId]) => operationId);
    expect([...m1].sort()).toEqual(SLICE_PBE066.map((entry) => entry.operationId).sort());
    for (const entry of SLICE_PBE066) {
      const row = rows.get(entry.operationId);
      expect(row, entry.operationId).toBeDefined();
      expect([entry.operationId, entry.method, entry.path]).toEqual([
        entry.operationId,
        row?.method,
        row?.path,
      ]);
      const query = parametersOf(entry.operationId)
        .filter((parameter) => parameter["in"] === "query")
        .map((parameter) => parameter["name"]);
      expect([entry.operationId, query]).toEqual([
        entry.operationId,
        expect.arrayContaining([...(row?.query ?? [])]),
      ]);

      const spec = operation(entry.operationId).spec;
      expect([entry.operationId, spec["x-reason-required"] === true]).toEqual([
        entry.operationId,
        row?.reason,
      ]);
      expect([entry.operationId, spec["x-mfa-step-up"] === true]).toEqual([entry.operationId, row?.stepUp]);
      expect([entry.operationId, spec["x-idempotent"], spec["x-feature"], spec["x-internal"]]).toEqual([
        entry.operationId,
        undefined,
        undefined,
        undefined,
      ]);
      // A step-up in some calls only is enforced by the service and shows in the error codes instead.
      expect([entry.operationId, row?.conditionalStepUp]).toEqual([
        entry.operationId,
        (SLICE_PBE066_CONDITIONAL_STEP_UP as readonly string[]).includes(entry.operationId),
      ]);
      if (row?.conditionalStepUp === true) {
        expect([entry.operationId, spec["x-error-codes"]]).toEqual([
          entry.operationId,
          expect.arrayContaining(["REAUTH_REQUIRED"]),
        ]);
      }
    }
  });

  it("documents a text/csv answer for adminExportAudit whose rows are audit entries [PBE-066 AC2]", () => {
    const op = operation("adminExportAudit");
    const ok = successOf("adminExportAudit", "200");
    const content = objectAt(ok, "content");
    expect(Object.keys(content)).toEqual(["text/csv"]);
    const media = objectAt(content, "text/csv");
    expect(objectAt(media, "schema")["type"]).toBe("string");

    // Never cached, and downloaded as a file named after the period.
    const headers = objectAt(ok, "headers");
    expect(objectAt(resolve(platform, headers["Cache-Control"]), "schema")["const"]).toBe("no-store");
    const disposition = objectAt(objectAt(headers, "Content-Disposition"), "schema");
    const filenames: unknown = disposition["examples"];
    expect(Array.isArray(filenames) && filenames.length > 0).toBe(true);
    for (const filename of Array.isArray(filenames) ? (filenames as unknown[]) : []) {
      expect(new RegExp(String(disposition["pattern"]), "u").test(String(filename))).toBe(true);
    }

    // The header row names the columns: the properties of AuditEntry, which the description lists too.
    const [header = "", ...lines] = String(media["example"]).trimEnd().split("\n");
    expect(csvCells(header)).toEqual([...AUDIT_CSV_COLUMNS]);
    const entry = objectAt(objectAt(objectAt(platform, "components"), "schemas"), "AuditEntry");
    expect([...AUDIT_CSV_COLUMNS].sort()).toEqual(Object.keys(objectAt(entry, "properties")).sort());
    for (const column of AUDIT_CSV_COLUMNS) {
      expect([column, String(op.spec["description"]).includes(`\`${column}\``)]).toEqual([column, true]);
    }

    // Each example row is an audit entry: an empty cell is null and `details` is the JSON object.
    expect(lines.length).toBeGreaterThan(0);
    const data = lines.map((line) => {
      const cells = csvCells(line);
      expect(cells).toHaveLength(AUDIT_CSV_COLUMNS.length);
      const row: Json = Object.fromEntries(
        AUDIT_CSV_COLUMNS.map((column, index) => [column, cells[index] === "" ? null : cells[index]]),
      );
      return { ...row, details: JSON.parse(String(row["details"])) as unknown };
    });
    const page = { nextCursor: null, limit: 50 };
    expect(checker.check("adminListAudit", { status: 200, body: { data, page } })).toEqual([]);
    // No example cell could run as a formula in a spreadsheet: the description's rule against CSV injection.
    expect(String(op.spec["description"])).toContain(
      "A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`",
    );
    for (const cell of lines.flatMap((line) => csvCells(line))) {
      expect([cell, /^[=+\-@\t\r]/u.test(cell)]).toEqual([cell, false]);
    }

    // The response checker reads JSON only, so it refuses the CSV instead of passing it.
    expect(() => checker.check("adminExportAudit", { status: 200, body: media["example"] })).toThrow(
      /no JSON content \(text\/csv\)/,
    );
    expect(NON_JSON_RESPONSES).toEqual({ adminExportAudit: { "200": ["text/csv"] } });
    // The inventory names the same representation.
    expect(adminSectionRows().get("adminExportAudit")?.exchange).toContain("text/csv");
  });

  it("filters the audit export like the audit search, with a required period and without the cursor", () => {
    const search = parametersOf("adminListAudit");
    expect(search.map((parameter) => parameter["name"])).toEqual(expect.arrayContaining(["cursor", "limit"]));
    const filters = search.filter(
      (parameter) => parameter["name"] !== "cursor" && parameter["name"] !== "limit",
    );
    const exported = parametersOf("adminExportAudit");
    expect(exported.map((parameter) => parameter["name"])).toEqual(
      filters.map((parameter) => parameter["name"]),
    );
    expect(filters.filter((parameter) => parameter["required"] === true)).toEqual([]);
    expect(
      exported.filter((parameter) => parameter["required"] === true).map((parameter) => parameter["name"]),
    ).toEqual(["from", "to"]);
    // A range over one year is the service's VALIDATION_FAILED.
    expect(operation("adminExportAudit").spec["x-error-codes"]).toContain("VALIDATION_FAILED");
  });

  it("marks adminCreateAmadeusAccount, adminGrantAdmin and adminResetAccountMfa x-mfa-step-up [PBE-066 AC2]", () => {
    for (const operationId of [
      "adminCreateAmadeusAccount",
      "adminGrantAdmin",
      "adminResetAccountMfa",
    ] as const) {
      expect([operationId, operation(operationId).spec["x-mfa-step-up"]]).toEqual([operationId, true]);
    }
    // Exactly the MFA↑ rows of the slice, adminRevokeAdmin included (PADR-0006 item 4).
    expect(
      SLICE_PBE066.filter((entry) => operation(entry.operationId).spec["x-mfa-step-up"] === true).map(
        (entry) => entry.operationId,
      ),
    ).toEqual([...SLICE_PBE066_STEP_UP]);
    // Each, and the conditional adminUpdateAmadeusAccount, answers 401 REAUTH_REQUIRED without a fresh step-up.
    // Every platform admin has MFA (PADR-0006 item 2), so none answers 403 MFA_REQUIRED.
    for (const operationId of [...SLICE_PBE066_STEP_UP, ...SLICE_PBE066_CONDITIONAL_STEP_UP]) {
      const [, unauthorized = {}] =
        responsesOf(platform, operation(operationId)).find(([status]) => status === "401") ?? [];
      const codes = examplesOf(platform, jsonMedia(unauthorized) ?? {}).map(
        (example) => objectAt(example, "error")["code"],
      );
      expect([operationId, codes]).toEqual([
        operationId,
        ["UNAUTHENTICATED", "TOKEN_EXPIRED", "REAUTH_REQUIRED"],
      ]);
      expect([operationId, operation(operationId).spec["x-error-codes"]]).toEqual([
        operationId,
        expect.not.arrayContaining(["MFA_REQUIRED"]),
      ]);
    }
    expect(operation("adminUpdateAmadeusAccount").spec["x-mfa-step-up"]).toBeUndefined();
    // Its step-up covers every credential field, the host included: the stored secret is sent to that host, so a
    // new baseUrl without a step-up would hand the secret to whoever runs it (PADR-0006 item 4).
    const update = objectAt(
      objectAt(objectAt(platform, "components"), "schemas"),
      "UpdateAmadeusAccountRequest",
    );
    expect(Object.keys(objectAt(update, "properties"))).toEqual(
      expect.arrayContaining(["baseUrl", "clientId", "clientSecret"]),
    );
    expect(String(operation("adminUpdateAmadeusAccount").spec["description"])).toContain(
      "A change of `clientSecret`, `clientId` or `baseUrl` needs a TOTP step-up",
    );
  });

  it("answers no property ending in Secret, Ciphertext or Hash in any response of the slice [PBE-066 AC2]", () => {
    const leaky = (name: string): boolean => /(secret|ciphertext|hash)$/i.test(name);
    // The walk reaches the masked connection of an assignment and the account shapes, so it cannot pass by not looking.
    expect(propertyNames(platform, { $ref: "#/components/schemas/AmadeusOfficeAssigned" })).toContain(
      "pendingSubmission",
    );
    expect(propertyNames(platform, { $ref: "#/components/schemas/AdminAmadeusAccount" })).toContain(
      "clientId",
    );
    // The Amadeus client secret is a request property only, and write-only.
    expect(propertyNames(platform, requestSchemaOf("adminCreateAmadeusAccount"))).toContain("clientSecret");
    const secret = objectAt(objectAt(objectAt(platform, "components"), "schemas"), "AmadeusClientSecret");
    expect(secret["writeOnly"]).toBe(true);

    for (const { operationId } of SLICE_PBE066) {
      for (const [status, response] of responsesOf(platform, operation(operationId))) {
        const names = [...propertyNames(platform, jsonMedia(response)?.["schema"])];
        expect([operationId, status, names.filter(leaky)]).toEqual([operationId, status, []]);
      }
    }

    // The checker refuses an Amadeus account answer with the secret's ciphertext, and an account with a hash.
    const [account] = examplesOf(platform, jsonMedia(successOf("adminCreateAmadeusAccount", "201")) ?? {});
    const created = isObject(account) ? account : {};
    expect(checker.check("adminCreateAmadeusAccount", { status: 201, body: created })).toEqual([]);
    expect(
      checker.check("adminCreateAmadeusAccount", {
        status: 201,
        body: { ...created, clientSecretCiphertext: "AAAA" },
      }),
    ).toEqual([
      expect.objectContaining({ path: "/clientSecretCiphertext", keyword: "additionalProperties" }),
    ]);
    const [detail] = examplesOf(platform, jsonMedia(successOf("adminGetAccount", "200")) ?? {});
    const body = isObject(detail) ? detail : {};
    expect(checker.check("adminGetAccount", { status: 200, body })).toEqual([]);
    expect(
      checker.check("adminGetAccount", {
        status: 200,
        body: { ...body, account: { ...objectAt(body, "account"), passwordHash: "not-a-hash" } },
      }),
    ).toEqual([expect.objectContaining({ path: "/account/passwordHash", keyword: "additionalProperties" })]);
  });

  it("requires a reason of 5–500 characters on the six reason actions, and takes an optional one on adminRevokeAdmin", () => {
    expect(
      SLICE_PBE066.filter((entry) => operation(entry.operationId).spec["x-reason-required"] === true).map(
        (entry) => entry.operationId,
      ),
    ).toEqual([...SLICE_PBE066_REASON]);

    const bodies: Record<(typeof SLICE_PBE066_REASON)[number], Json> = {
      adminUpdateManualSubscription: { trialEndsAt: "2027-02-12T08:20:11Z" },
      adminRetireAmadeusOffice: {},
      adminDisableAccount: {},
      adminEnableAccount: {},
      adminResetAccountMfa: {},
      adminGrantAdmin: { email: "jonas.dahl@velexis.example.com" },
    };
    const requests = requestBodyChecker(SLICE_PBE066_REASON);
    for (const operationId of SLICE_PBE066_REASON) {
      const body = bodies[operationId];
      const check = (reason?: string) =>
        requests.check(operationId, { status: 200, body: reason === undefined ? body : { ...body, reason } });
      expect([operationId, operation(operationId).spec["requestBody"]]).toEqual([
        operationId,
        expect.objectContaining({ required: true }),
      ]);
      expect([operationId, check("Abuse")]).toEqual([operationId, []]);
      expect([operationId, check("x".repeat(500))]).toEqual([operationId, []]);
      expect([operationId, check()]).toEqual([
        operationId,
        expect.arrayContaining([expect.objectContaining({ path: "/reason", keyword: "required" })]),
      ]);
      expect([operationId, check("Spam")]).toEqual([
        operationId,
        [expect.objectContaining({ path: "/reason", keyword: "minLength" })],
      ]);
      expect([operationId, check("x".repeat(501))]).toEqual([
        operationId,
        [expect.objectContaining({ path: "/reason", keyword: "maxLength" })],
      ]);
    }
    // A manual subscription edit names at least one change besides the reason.
    expect(
      requests.check("adminUpdateManualSubscription", { status: 200, body: { reason: "Extend the pilot" } }),
    ).toEqual([expect.objectContaining({ keyword: "minProperties" })]);

    // A revocation has no body and takes an optional reason in the query: PADR-0006 item 5 does not require one.
    expect(operation("adminRevokeAdmin").spec["requestBody"]).toBeUndefined();
    expect(parametersOf("adminRevokeAdmin")).toContainEqual(
      expect.objectContaining({
        name: "reason",
        in: "query",
        required: false,
        schema: { $ref: "#/components/schemas/AdminReason" },
      }),
    );
  });

  it("answers AdminPlan as Plan plus the admin fields, and keeps code, currency and the Stripe ids out of adminUpdatePlan", () => {
    const rows = adminSectionRows();
    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    const plan = objectAt(objectAt(schemas, "Plan"), "properties");
    const adminPlan = objectAt(objectAt(schemas, "AdminPlan"), "properties");
    // `…Plan`: every field of the public plan, with the same schema apart from annotations.
    for (const [name, schema] of Object.entries(plan)) {
      expect([name, shape(resolve(platform, adminPlan[name]))]).toEqual([
        name,
        shape(resolve(platform, schema)),
      ]);
    }
    const extra = /AdminPlan \{…Plan, ([^}]+)\}/u.exec(rows.get("adminListPlans")?.exchange ?? "")?.[1] ?? "";
    const names = extra.split(", ").map((name) => name.replace("[]", ""));
    expect(names).toHaveLength(8);
    for (const name of names) {
      expect([name, name in adminPlan]).toEqual([name, true]);
    }
    expect(objectAt(schemas, "AdminPlan")["required"]).toEqual(Object.keys(adminPlan));

    // The create body has the inventory's fields, only annualPrice optional.
    const fields = (/`\{([^}]+)\}`/u.exec(rows.get("adminCreatePlan")?.exchange ?? "")?.[1] ?? "").split(
      ", ",
    );
    expect(fields).toHaveLength(12);
    const create = objectAt(schemas, "CreatePlanRequest");
    expect(Object.keys(objectAt(create, "properties"))).toEqual(
      fields.map((field) => field.replace("?", "")),
    );
    expect(create["required"]).toEqual(fields.filter((field) => !field.endsWith("?")));

    // The update takes any field but code and currency, and retires with isActive; PBE-042 adds the Stripe ids.
    const update = Object.keys(objectAt(objectAt(schemas, "UpdatePlanRequest"), "properties"));
    expect([...update].sort()).toEqual(
      [
        ...fields
          .map((field) => field.replace("?", ""))
          .filter((field) => field !== "code" && field !== "currency"),
        "isActive",
      ].sort(),
    );
    expect(update.filter((name) => name.startsWith("stripe"))).toEqual([]);
  });

  it("follows the CHECK constraints of migrations 0001 and 0002 for the statuses of the slice", () => {
    const baseline = readFileSync(join(PLATFORM_MIGRATIONS, "0001_baseline.sql"), "utf8");
    const deltas = readFileSync(join(PLATFORM_MIGRATIONS, "0002_add_mvp_platform_deltas.sql"), "utf8");
    const values = (sql: string, anchor: RegExp): string[] => {
      const list = anchor.exec(sql)?.[1];
      expect([String(anchor), list === undefined]).toEqual([String(anchor), false]);
      return [...(list ?? "").matchAll(/'([^']+)'/g)].map(([, value = ""]) => value);
    };
    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    const enumOf = (name: string, property?: string): unknown =>
      property === undefined
        ? objectAt(schemas, name)["enum"]
        : objectAt(objectAt(objectAt(schemas, name), "properties"), property)["enum"];
    const checks: Array<[string, unknown, string[]]> = [
      [
        "AmadeusAccountStatus",
        enumOf("AmadeusAccountStatus"),
        values(deltas, /CREATE TABLE platform\.amadeus_accounts \([\s\S]*?CHECK \(status IN \(([^)]*)\)\)/u),
      ],
      [
        "AmadeusOfficeStatus",
        enumOf("AmadeusOfficeStatus"),
        values(deltas, /CREATE TABLE platform\.amadeus_offices \([\s\S]*?CHECK \(status IN \(([^)]*)\)\)/u),
      ],
      [
        "SubscriptionStatus",
        enumOf("SubscriptionStatus"),
        values(deltas, /subscriptions_status_ck\s+CHECK \(status IN \(([^)]*)\)\)/u),
      ],
      [
        "BillingProvider",
        enumOf("BillingProvider"),
        values(baseline, /CHECK \(billing_provider IN \(([^)]*)\)\)/u),
      ],
      [
        "AccountStatus",
        enumOf("AccountStatus"),
        values(baseline, /CREATE TABLE platform\.accounts \([\s\S]*?CHECK \(status IN \(([^)]*)\)\)/u),
      ],
      ["AuditActorType", enumOf("AuditActorType"), values(baseline, /CHECK \(actor_type IN \(([^)]*)\)\)/u)],
      [
        "AdminInvoice.status",
        enumOf("AdminInvoice", "status"),
        values(baseline, /CREATE TABLE platform\.invoices \([\s\S]*?CHECK \(status IN \(([^)]*)\)\)/u),
      ],
      [
        "AdminStripeEvent.endpoint",
        enumOf("AdminStripeEvent", "endpoint"),
        values(deltas, /CHECK \(endpoint IN \(([^)]*)\)\)/u),
      ],
      [
        "AdminStripeEvent.status",
        enumOf("AdminStripeEvent", "status"),
        values(deltas, /CREATE TABLE platform\.stripe_events \([\s\S]*?CHECK \(status IN \(([^)]*)\)\)/u),
      ],
    ];
    for (const [name, documented, constraint] of checks) {
      expect([name, documented]).toEqual([name, constraint]);
    }
    // The audit search filters on the same actor types as the audit rows.
    const entry = objectAt(objectAt(schemas, "AuditEntry"), "properties");
    expect(entry["actorType"]).toEqual({ $ref: "#/components/schemas/AuditActorType" });
  });

  it("paginates the long lists, answers the short ones whole, and takes If-Match on every versioned PATCH", () => {
    const refs = (operationId: string): unknown[] => {
      const list: unknown = operation(operationId).spec["parameters"];
      return (Array.isArray(list) ? (list as unknown[]) : []).map((parameter) =>
        isObject(parameter) ? parameter["$ref"] : undefined,
      );
    };
    const okSchema = (operationId: string): Json => {
      const schema = resolve(platform, jsonMedia(successOf(operationId, "200"))?.["schema"]);
      return isObject(schema) ? schema : {};
    };
    const paginated = [
      "adminListSubscriptions",
      "adminListAmadeusOffices",
      "adminListAccounts",
      "adminListAudit",
    ] as const satisfies readonly PlatformOperationId[];
    for (const operationId of paginated) {
      expect([operationId, refs(operationId)]).toEqual([
        operationId,
        expect.arrayContaining(["#/components/parameters/Cursor", "#/components/parameters/Limit"]),
      ]);
      expect([operationId, okSchema(operationId)["required"]]).toEqual([operationId, ["data", "page"]]);
    }
    const whole = [
      "adminListPlans",
      "adminListAmadeusAccounts",
      "adminListAdmins",
    ] as const satisfies readonly PlatformOperationId[];
    for (const operationId of whole) {
      expect([operationId, refs(operationId)]).toEqual([operationId, []]);
      expect([operationId, okSchema(operationId)["required"]]).toEqual([operationId, ["data"]]);
    }
    const versioned = [
      "adminUpdatePlan",
      "adminUpdateManualSubscription",
      "adminUpdateAmadeusAccount",
      "adminUpdateAmadeusOffice",
    ] as const satisfies readonly PlatformOperationId[];
    for (const operationId of versioned) {
      const statuses = responsesOf(platform, operation(operationId)).map(([status]) => status);
      expect([operationId, refs(operationId), statuses]).toEqual([
        operationId,
        ["#/components/parameters/IfMatch"],
        expect.arrayContaining(["200", "412"]),
      ]);
      expect([operationId, objectAt(objectAt(successOf(operationId, "200"), "headers"), "ETag")]).toEqual([
        operationId,
        { $ref: "#/components/headers/ETag" },
      ]);
      expect([operationId, propertyNames(platform, okSchema(operationId)).has("version")]).toEqual([
        operationId,
        true,
      ]);
    }
  });
});

describe("the error catalogue", () => {
  it("lists every code of api-inventory §3 with its status", () => {
    const catalogue = objectAt(platform, "x-error-catalogue");
    const inventory = inventoryCatalogue();
    expect(inventory.size).toBeGreaterThanOrEqual(52);
    for (const [code, status] of inventory) {
      expect([code, objectAt(catalogue, code)["status"]]).toEqual([code, status]);
    }
  });

  it("lists no code that api-inventory §3 does not list", () => {
    // A new code goes into api-inventory §3 and the document in the same task (openapi/README.md §5).
    const inventory = inventoryCatalogue();
    const missing = Object.keys(objectAt(platform, "x-error-catalogue")).filter(
      (code) => !inventory.has(code),
    );
    expect(missing).toEqual([]);
  });

  it("gives a code of both catalogues the OTA status, and every code a message", () => {
    const catalogue = objectAt(platform, "x-error-catalogue");
    const otaCatalogue = objectAt(ota, "x-error-catalogue");
    for (const [code, entry] of Object.entries(catalogue)) {
      expect(
        isObject(entry) && typeof entry["description"] === "string" && entry["description"].length > 0,
      ).toBe(true);
      if (code in otaCatalogue) {
        expect([code, objectAt(catalogue, code)["status"]]).toEqual([
          code,
          objectAt(otaCatalogue, code)["status"],
        ]);
      }
    }
  });

  it("uses the error envelope and the money of the OTA document, without the console-only supplier field", () => {
    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    const otaSchemas = objectAt(objectAt(ota, "components"), "schemas");
    const otaError = objectAt(otaSchemas, "Error");
    const { supplier, ...otaErrorProperties } = objectAt(otaError, "properties");

    expect(supplier).toBeDefined();
    expect(shape(schemas["Error"])).toEqual(shape({ ...otaError, properties: otaErrorProperties }));
    for (const name of ["ErrorResponse", "FieldError", "Money"]) {
      expect([name, shape(schemas[name])]).toEqual([name, shape(otaSchemas[name])]);
    }
    // The platform closes them: a body with a field outside the envelope does not match.
    for (const name of ["ErrorResponse", "Error", "FieldError", "Money"]) {
      expect([name, objectAt(schemas, name)["additionalProperties"]]).toEqual([name, false]);
    }
  });
});

describe("the conventions of every operation", () => {
  it("gives every operation an x-scope of the platform list and marks internal and webhook ones x-internal", () => {
    for (const { operationId, spec } of operations) {
      expect([operationId, (SCOPES as readonly unknown[]).includes(spec["x-scope"])]).toEqual([
        operationId,
        true,
      ]);
      if (spec["x-scope"] === "internal" || spec["x-scope"] === "webhook") {
        expect([operationId, spec["x-internal"]]).toEqual([operationId, true]);
      }
      if (spec["x-scope"] === "public" || spec["x-scope"] === "internal" || spec["x-scope"] === "webhook") {
        expect([operationId, spec["security"]]).toEqual([operationId, []]);
      }
    }
  });

  it("asks the bearer of its surface: adminBearer on platform_admin operations, portalBearer on portal ones", () => {
    const bearers: Record<string, unknown> = {
      platform_admin: [{ adminBearer: [] }],
      portal: [{ portalBearer: [] }],
      portal_unverified: [{ portalBearer: [] }],
    };
    for (const { operationId, spec } of operations) {
      const scope = String(spec["x-scope"]);
      if (scope in bearers) {
        expect([operationId, spec["security"]]).toEqual([operationId, bearers[scope]]);
      }
    }
  });

  it("requires a reason of 5–500 characters exactly on the x-reason-required operations", () => {
    const reason = objectAt(objectAt(objectAt(platform, "components"), "schemas"), "AdminReason");
    expect([reason["type"], reason["minLength"], reason["maxLength"]]).toEqual(["string", 5, 500]);
    for (const { operationId, spec } of operations) {
      const body = resolve(platform, spec["requestBody"]);
      const schema = resolve(platform, requestSchemaOf(operationId));
      const required: unknown = isObject(schema) ? schema["required"] : undefined;
      const takesReason =
        Array.isArray(required) &&
        required.includes("reason") &&
        objectAt(objectAt(schema, "properties"), "reason")["$ref"] === "#/components/schemas/AdminReason";
      expect([operationId, takesReason]).toEqual([operationId, spec["x-reason-required"] === true]);
      if (takesReason) {
        // The body itself is required, so a request without one cannot skip the reason.
        expect([operationId, isObject(body) ? body["required"] : undefined]).toEqual([operationId, true]);
      }
    }
  });

  it("answers REAUTH_REQUIRED on every x-mfa-step-up operation", () => {
    for (const { operationId, spec } of operations) {
      if (spec["x-mfa-step-up"] === true) {
        expect([operationId, spec["x-error-codes"]]).toEqual([
          operationId,
          expect.arrayContaining(["REAUTH_REQUIRED"]),
        ]);
      }
    }
  });

  it("documents X-Request-Id on every response and lists x-platform-tables on every operation", () => {
    for (const op of operations) {
      const tables: unknown = op.spec["x-platform-tables"];
      const listed =
        Array.isArray(tables) &&
        tables.every((table: unknown) => typeof table === "string" && /^[a-z][a-z_]*$/.test(table));
      expect([op.operationId, listed]).toEqual([op.operationId, true]);
      for (const [status, response] of responsesOf(platform, op)) {
        const header = objectAt(objectAt(response, "headers"), "X-Request-Id");
        expect([op.operationId, status, header["$ref"]]).toEqual([
          op.operationId,
          status,
          "#/components/headers/X-Request-Id",
        ]);
      }
    }
  });

  it("takes the Idempotency-Key parameter exactly on the x-idempotent operations", () => {
    const reference = "#/components/parameters/IdempotencyKey";
    for (const op of operations) {
      const pathItem = objectAt(objectAt(platform, "paths"), op.path);
      const parameters = [pathItem["parameters"], op.spec["parameters"]].flatMap((list: unknown) =>
        Array.isArray(list) ? (list as unknown[]) : [],
      );
      const takesKey = parameters.some((parameter) => isObject(parameter) && parameter["$ref"] === reference);
      expect([op.operationId, takesKey]).toEqual([op.operationId, op.spec["x-idempotent"] === true]);
    }
  });

  it("closes every request body with additionalProperties: false", () => {
    for (const { operationId, spec } of operations) {
      const body = resolve(platform, spec["requestBody"]);
      if (body !== undefined) {
        const media = objectAt(objectAt(body, "content"), "application/json");
        expect([operationId, isClosed(platform, media["schema"])]).toEqual([operationId, true]);
      }
    }
  });

  it("documents Cache-Control: no-store on every 2xx answer that carries a secret", () => {
    // The reference walker sees a secret schema behind nested references, so the check cannot pass by not looking.
    expect([...referencesOf(platform, { $ref: "#/components/schemas/ApiKeyRolled" })]).toEqual(
      expect.arrayContaining([...SECRET_SCHEMAS]),
    );
    for (const op of operations) {
      for (const [status, response] of responsesOf(platform, op)) {
        const media = jsonMedia(response);
        if (!status.startsWith("2") || media === undefined) {
          continue;
        }
        const secrets = [
          ...[...propertyNames(platform, media["schema"])].filter((name) => SECRET_PROPERTIES.has(name)),
          ...[...referencesOf(platform, media["schema"])].filter((ref) => SECRET_SCHEMAS.has(ref)),
        ];
        if (secrets.length > 0) {
          const header = resolve(platform, objectAt(response, "headers")["Cache-Control"]);
          expect([op.operationId, status, objectAt(header, "schema")["const"]]).toEqual([
            op.operationId,
            status,
            "no-store",
          ]);
        }
      }
    }
  });

  it("answers errors with catalogue codes of the response's status, exactly the codes of x-error-codes", () => {
    const catalogue = objectAt(platform, "x-error-catalogue");
    for (const op of operations) {
      const answered = new Set<string>();
      for (const [status, response] of responsesOf(platform, op)) {
        const media = jsonMedia(response);
        const schema = media?.["schema"];
        if (
          Number(status) < 400 ||
          !isObject(schema) ||
          schema["$ref"] !== "#/components/schemas/ErrorResponse"
        ) {
          continue;
        }
        const examples = examplesOf(platform, media ?? {});
        expect([op.operationId, status, examples.length > 0]).toEqual([op.operationId, status, true]);
        for (const example of examples) {
          const error = objectAt(example, "error");
          const code = String(error["code"]);
          answered.add(code);
          expect([op.operationId, code, error["status"], objectAt(catalogue, code)["status"]]).toEqual([
            op.operationId,
            code,
            Number(status),
            Number(status),
          ]);
        }
      }
      const listed = op.spec["x-error-codes"];
      expect([op.operationId, Array.isArray(listed)]).toEqual([op.operationId, true]);
      expect([op.operationId, [...answered].sort()]).toEqual([
        op.operationId,
        [...(listed as string[])].sort(),
      ]);
    }
  });

  it("validates every response example with the Ajv response checker of @velexis/testing", () => {
    let checked = 0;
    for (const op of operations) {
      for (const [status, response] of responsesOf(platform, op)) {
        const media = jsonMedia(response);
        const types = Object.keys(objectAt(response, "content"));
        if (media === undefined && types.length > 0) {
          // A body that is not JSON: only the representations of NON_JSON_RESPONSES, checked by their slice test.
          expect([op.operationId, status, types]).toEqual([
            op.operationId,
            status,
            NON_JSON_RESPONSES[op.operationId]?.[status] ?? [],
          ]);
          continue;
        }
        for (const body of media === undefined ? [undefined] : examplesOf(platform, media)) {
          expect([
            op.operationId,
            status,
            checker.check(op.operationId, { status: Number(status), body }),
          ]).toEqual([op.operationId, status, []]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(operations.length);
  });

  it("refuses answers with an undocumented field, a number for money or an undocumented status", () => {
    const session = objectAt(resolve(platform, { $ref: "#/components/examples/PortalSession" }), "value");
    const leaky = { ...session, account: { ...objectAt(session, "account"), passwordHash: "not-a-hash" } };
    expect(checker.check("verifyMfa", { status: 200, body: leaky })).toEqual([
      expect.objectContaining({ path: "/account/passwordHash", keyword: "additionalProperties" }),
    ]);

    const [, ok = {}] =
      responsesOf(platform, operation("listPlans")).find(([status]) => status === "200") ?? [];
    const [plans] = examplesOf(platform, jsonMedia(ok) ?? {});
    const data = isObject(plans) ? plans["data"] : undefined;
    const plan = Array.isArray(data) && isObject(data[0]) ? data[0] : {};
    expect(plan).toMatchObject({ code: "early_access", monthlyPrice: { amount: "0.00" } });
    const numeric = { data: [{ ...plan, monthlyPrice: { amount: 49, currency: "EUR" } }] };
    expect(checker.check("listPlans", { status: 200, body: numeric })).toEqual([
      expect.objectContaining({ path: "/data/0/monthlyPrice/amount", keyword: "type" }),
    ]);

    expect(checker.check("getMe", { status: 418, body: {} })).toEqual([
      expect.objectContaining({ keyword: "status" }),
    ]);
  });
});
