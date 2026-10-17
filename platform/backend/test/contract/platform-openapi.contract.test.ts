// Contract tests of the platform OpenAPI document, openapi/velexis-platform-api.openapi.yaml (ADR-0006, PADR-0016).
//
// PBE-005 wrote its first slice (identity, plans, internal: 24 operations, the conventions and the error catalogue),
// PBE-006 the second (tenants, team, API keys and the M1 reads: 27 operations), PBE-007 the first admin slice
// (admin auth and dashboard, tenants, provisioning jobs and queues: 21 operations), PBE-066 the second (plans and
// subscriptions, Amadeus accounts and offices, accounts, platform admins and audit: 26 operations), PBE-037 the M3
// and M4 slice (the statement descriptor, the console token and the Amadeus settings: 3 operations) and PBE-041 the M5
// portal slice (go-live, custom domains, own credentials, Stripe Connect and API keys, the payout account,
// settlements, Checkout, the Customer Portal and invoices: 20 operations). The tests of a slice name its operations
// by operationId and never count the document, so the last slice (PBE-042) only adds operations and tests of its own.
// The convention checks run on every operation of the document: x-scope and the matching security scheme,
// `platform_admin` on every `/v1/admin/` path but the public sign-in steps, X-Request-Id on every response,
// x-platform-tables, Idempotency-Key exactly on x-idempotent operations, a 5–500 character `reason` exactly on
// x-reason-required operations, closed request bodies, `Cache-Control: no-store` on secret-bearing responses, error
// examples that agree with x-error-codes and the catalogue, and examples that validate with the Ajv checker of
// @velexis/testing that the integration tests use (a body that is not JSON, such as the CSV exports, only where
// NON_JSON_RESPONSES lists it, and its slice test checks it). The PBE-041 slice test also checks every operation: no
// answer reaches a write-only schema, and a request property named like a secret, a password or a bank identifier is
// write-only. `pnpm contracts:lint` (Redocly, X-007) and the generators' tests (X-008, X-009) cover the lint and the
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
import { OperationPolicies } from "../../src/common/auth/decorators";
import { FEATURES, type Feature } from "../../src/common/features";
import { PlatformOpenApi } from "../../src/common/http/openapi-validation.interceptor";
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

/**
 * The PBE-037 slice (M3 and M4): `createConsoleToken` of api-inventory §8 and the connection updates of
 * api-inventory-resources §3 and §4, the only M3 and M4 rows of the three inventory parts.
 */
const SLICE_PBE037: readonly SliceOperation[] = [
  {
    operationId: "createConsoleToken",
    method: "post",
    path: `${TENANT_PATH}/console-token`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "updateAmadeusConnection",
    method: "patch",
    path: `${TENANT_PATH}/amadeus-connections/{environment}`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "updatePaymentConnection",
    method: "patch",
    path: `${TENANT_PATH}/payment-connections/{environment}`,
    scope: "portal",
    internal: false,
  },
];

/** The versioned PATCH operations of the PBE-037 slice, each with the masked connection it answers. */
const SLICE_PBE037_UPDATES = {
  updateAmadeusConnection: "#/components/schemas/AmadeusConnection",
  updatePaymentConnection: "#/components/schemas/PaymentConnection",
} as const satisfies Partial<Record<PlatformOperationId, string>>;

/**
 * The PBE-041 slice (M5 portal): `goLive` of api-inventory §7 and the M5 rows of api-inventory-resources §2 to §6
 * (custom domains, own Amadeus credentials and live access, Stripe Connect and API keys, the payout account and
 * settlements, Checkout, the Customer Portal and invoices).
 */
const SLICE_PBE041: readonly SliceOperation[] = [
  { operationId: "goLive", method: "post", path: `${TENANT_PATH}/go-live`, scope: "portal", internal: false },
  {
    operationId: "addDomain",
    method: "post",
    path: `${TENANT_PATH}/domains`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "removeDomain",
    method: "delete",
    path: `${TENANT_PATH}/domains/{domainId}`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "checkDomain",
    method: "post",
    path: `${TENANT_PATH}/domains/{domainId}/check`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "makeDomainPrimary",
    method: "post",
    path: `${TENANT_PATH}/domains/{domainId}/make-primary`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "requestLiveAmadeus",
    method: "post",
    path: `${TENANT_PATH}/amadeus-connections/live/request`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "submitAmadeusCredentials",
    method: "put",
    path: `${TENANT_PATH}/amadeus-connections/{environment}/credentials`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "getCredentialSubmission",
    method: "get",
    path: `${TENANT_PATH}/credential-submissions/{submissionId}`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "startStripeConnect",
    method: "post",
    path: `${TENANT_PATH}/payment-connections/stripe-connect/start`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "completeStripeConnect",
    method: "post",
    path: "/v1/payment-connections/stripe-connect/callback",
    scope: "portal",
    internal: false,
  },
  {
    operationId: "submitStripeApiKeys",
    method: "put",
    path: `${TENANT_PATH}/payment-connections/{environment}/api-keys`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "useVelexisPayments",
    method: "post",
    path: `${TENANT_PATH}/payment-connections/{environment}/use-velexis`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "createCheckoutSession",
    method: "post",
    path: `${TENANT_PATH}/billing/checkout-session`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "createCustomerPortalSession",
    method: "post",
    path: `${TENANT_PATH}/billing/portal-session`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listInvoices",
    method: "get",
    path: `${TENANT_PATH}/invoices`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "getPayoutAccount",
    method: "get",
    path: `${TENANT_PATH}/payout-account`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "setPayoutAccount",
    method: "put",
    path: `${TENANT_PATH}/payout-account`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "listSettlements",
    method: "get",
    path: `${TENANT_PATH}/settlements`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "getSettlement",
    method: "get",
    path: `${TENANT_PATH}/settlements/{settlementId}`,
    scope: "portal",
    internal: false,
  },
  {
    operationId: "downloadSettlementLines",
    method: "get",
    path: `${TENANT_PATH}/settlements/{settlementId}/lines.csv`,
    scope: "portal",
    internal: false,
  },
];

/** The milestone switch of each PBE-041 operation that has one: the inventory's `F:<switch>` (PADR-0015). */
const SLICE_PBE041_FEATURES = {
  goLive: "live_switch",
  addDomain: "custom_domains",
  requestLiveAmadeus: "live_switch",
  submitAmadeusCredentials: "own_amadeus",
  startStripeConnect: "own_stripe",
  submitStripeApiKeys: "own_stripe",
  setPayoutAccount: "settlements",
  createCheckoutSession: "stripe_billing",
  createCustomerPortalSession: "stripe_billing",
} as const satisfies Partial<Record<PlatformOperationId, Feature>>;

/** The PBE-041 operations that need a TOTP step-up on every call: the inventory's MFA↑ (PADR-0008). */
const SLICE_PBE041_STEP_UP = [
  "goLive",
  "submitAmadeusCredentials",
  "startStripeConnect",
  "submitStripeApiKeys",
  "useVelexisPayments",
  "setPayoutAccount",
] as const satisfies readonly PlatformOperationId[];

/** The secret request fields of the PBE-041 slice by operation: each is write-only and never answered. */
const SLICE_PBE041_SECRETS = {
  submitAmadeusCredentials: ["clientSecret"],
  completeStripeConnect: ["state", "code"],
  submitStripeApiKeys: ["secretKey", "webhookSecret"],
  setPayoutAccount: ["iban", "bic", "accountNumber", "routingNumber"],
} as const satisfies Partial<Record<PlatformOperationId, readonly string[]>>;

/** The bank identifiers of a payout account: write-only in every request, never in a response. */
const BANK_FIELDS = new Set(["iban", "bic", "accountNumber", "routingNumber"]);

/**
 * The writes that a suspended OTA cannot make (PADR-0014 item 5: domains and connections are read-only), plus
 * `goLive`, which needs an active OTA; they answer `409 TENANT_NOT_ACTIVE`.
 */
const SLICE_PBE041_ACTIVE_ONLY = [
  "goLive",
  "addDomain",
  "removeDomain",
  "checkDomain",
  "makeDomainPrimary",
  "requestLiveAmadeus",
  "submitAmadeusCredentials",
  "startStripeConnect",
  "completeStripeConnect",
  "submitStripeApiKeys",
  "useVelexisPayments",
] as const satisfies readonly PlatformOperationId[];

/** The columns of the settlement lines CSV, in file order (api-inventory-resources §5). */
const SETTLEMENT_CSV_COLUMNS = [
  "type",
  "occurredAt",
  "amount",
  "stripeFee",
  "paymentIntentId",
  "velexisPaymentId",
  "checkoutId",
  "description",
] as const;

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
  downloadSettlementLines: { "200": ["text/csv"] },
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

/**
 * The budget of the setup hook below. Parsing both documents and compiling an Ajv validator for every documented JSON
 * response takes a few seconds alone, several times that under a full parallel `pnpm test` on four CPUs (past the 10 s
 * hook default), and it grows with every operation. The budget only stops a hook that hangs.
 */
const SETUP_TIMEOUT_MS = 60_000;

beforeAll(() => {
  platform = readYaml(PLATFORM_DOCUMENT);
  ota = readYaml(OTA_DOCUMENT);
  operations = operationsOf(platform);
  checker = createResponseChecker(structuredClone(platform), { label: "platform" });
  // The checker compiles each response's validator on its first use and keeps it: compiling them all here keeps that
  // one-time work out of the 5 s bound of the tests that check responses.
  for (const op of operations) {
    for (const [status, response] of responsesOf(platform, op)) {
      if (jsonMedia(response) !== undefined) {
        checker.check(op.operationId, { status: Number(status), body: undefined });
      }
    }
  }
}, SETUP_TIMEOUT_MS);

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
    // Its entry of NON_JSON_RESPONSES; the PBE-041 slice test checks the whole list, which its CSV extends.
    expect(NON_JSON_RESPONSES["adminExportAudit"]).toEqual({ "200": ["text/csv"] });
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

/** The backticked catalogue codes of an inventory cell (`officeIds` and other camelCase names are not codes). */
function codesOf(cell: string): string[] {
  return [...cell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map(([, code = ""]) => code);
}

/** The field names of the first `{…}` of an inventory cell that follows `prefix`, without `?` and `: …` values. */
function inventoryFields(cell: string, prefix = ""): string[] {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fields = new RegExp(`\`${escaped}\\{([^}]+)\\}`, "u").exec(cell)?.[1] ?? "";
  return fields.split(/,\s*/u).map((field) => field.split(":")[0]?.trim() ?? "");
}

describe("the M3 and M4 slice: statement descriptor, console token and Amadeus settings (PBE-037)", () => {
  /** The rows of the three inventory parts by operationId. */
  const allRows = (): Map<string, string[]> =>
    new Map([
      ...inventoryRows(INVENTORY),
      ...inventoryRows(INVENTORY_RESOURCES),
      ...inventoryRows(INVENTORY_ADMIN),
    ]);

  it("lists the 3 operations of the slice in the operations index, each with x-scope portal [PBE-037 AC1]", () => {
    expect(SLICE_PBE037).toHaveLength(3);
    const ids = new Set(SLICE_PBE037.map((entry) => entry.operationId));
    expect(ids.size).toBe(3);
    // 3 more operations: none of them belongs to an earlier slice.
    expect(
      [...SLICE, ...SLICE_PBE006, ...SLICE_PBE007, ...SLICE_PBE066].filter((entry) =>
        ids.has(entry.operationId),
      ),
    ).toEqual([]);
    for (const entry of SLICE_PBE037) {
      expect(platformOperations).toContainEqual(expect.objectContaining({ ...entry, sdkMethod: null }));
      expect([entry.operationId, operation(entry.operationId).spec["x-scope"]]).toEqual([
        entry.operationId,
        "portal",
      ]);
    }
  });

  it("documents each slice operation with the method, path, marks and errors of the M3 and M4 inventory rows [PBE-037 AC1]", () => {
    const rows = allRows();
    // The slice is exactly the M3 and M4 rows of the inventory; the milestone is the last cell of a row.
    const later = [...rows]
      .filter(([, cells]) => /^M[34]\b/u.test(cells[cells.length - 1] ?? ""))
      .map(([operationId]) => operationId);
    expect([...later].sort()).toEqual(SLICE_PBE037.map((entry) => entry.operationId).sort());

    for (const entry of SLICE_PBE037) {
      const [, route = "", auth = "", , , , errors = ""] = rows.get(entry.operationId) ?? [];
      const [method = "", path = ""] = route.replaceAll("`", "").split(" ");
      expect([entry.operationId, entry.method, entry.path]).toEqual([
        entry.operationId,
        method.toLowerCase(),
        path.replace(/^…/u, TENANT_PATH),
      ]);
      const marks = authMarks(auth);
      expect([entry.operationId, scopeOf(marks), marks.join(" ")]).toEqual([
        entry.operationId,
        "portal",
        expect.not.stringMatching(/MFA↑|Idem|F:/u),
      ]);
      const spec = operation(entry.operationId).spec;
      expect([
        entry.operationId,
        spec["x-mfa-step-up"],
        spec["x-idempotent"],
        spec["x-feature"],
        spec["x-reason-required"],
        spec["x-internal"],
      ]).toEqual([entry.operationId, undefined, undefined, undefined, undefined, undefined]);
      // Every code of the inventory's Errors cell is answered; the operation answers the generic codes too.
      expect([entry.operationId, codesOf(errors).length > 0]).toEqual([entry.operationId, true]);
      expect([entry.operationId, spec["x-error-codes"]]).toEqual([
        entry.operationId,
        expect.arrayContaining(codesOf(errors)),
      ]);
    }
  });

  it("answers createConsoleToken with a one-time portal token in a no-store 201 that the OTA contract accepts [PBE-037 AC1]", () => {
    const op = operation("createConsoleToken");
    const [, , , , exchange = ""] = allRows().get("createConsoleToken") ?? [];
    // No body, no Idempotency-Key: a token is never stored for a replay.
    expect([op.spec["requestBody"], op.spec["parameters"], op.spec["x-idempotent"]]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const success = responsesOf(platform, op).filter(([status]) => status.startsWith("2"));
    expect(success.map(([status]) => status)).toEqual(["201"]);
    const created = successOf("createConsoleToken", "201");
    expect(exchange).toContain("(no-store)");
    expect(objectAt(created, "headers")["Cache-Control"]).toEqual({ $ref: "#/components/headers/NoStore" });
    expect(jsonMedia(created)?.["schema"]).toEqual({ $ref: "#/components/schemas/ConsoleToken" });

    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    const consoleToken = objectAt(schemas, "ConsoleToken");
    const fields = inventoryFields(exchange, "201 ");
    expect(fields).toEqual(["portalToken", "expiresAt", "consoleSsoUrl"]);
    expect([consoleToken["required"], Object.keys(objectAt(consoleToken, "properties"))]).toEqual([
      fields,
      fields,
    ]);
    expect(consoleToken["additionalProperties"]).toBe(false);

    // `ptk_` and 43 base62 characters (PADR-0007 item 1), within the pattern the OTA backend redeems.
    const platformPattern = new RegExp(String(objectAt(schemas, "PortalToken")["pattern"]), "u");
    const otaSignIn = objectAt(objectAt(ota, "components"), "schemas")["ConsolePortalTokenSignIn"];
    const otaPattern = new RegExp(
      String(objectAt(objectAt(otaSignIn, "properties"), "portalToken")["pattern"]),
      "u",
    );
    const [example] = examplesOf(platform, jsonMedia(created) ?? {});
    const token = String(isObject(example) ? example["portalToken"] : "");
    const base62 = `${"aZ09".repeat(10)}xY7`;
    expect(base62).toHaveLength(43);
    for (const valid of [token, `ptk_${base62}`]) {
      expect([valid, platformPattern.test(valid), otaPattern.test(valid)]).toEqual([valid, true, true]);
    }
    for (const invalid of [`ptk_${base62.slice(1)}`, `ptk_${base62}a`, `ptk_${base62.slice(1)}-`, base62]) {
      expect([invalid, platformPattern.test(invalid)]).toEqual([invalid, false]);
    }
    expect(checker.check("createConsoleToken", { status: 201, body: example })).toEqual([]);
    expect(
      checker.check("createConsoleToken", {
        status: 201,
        body: { ...(example as Json), tokenHash: "0".repeat(64) },
      }),
    ).toEqual([expect.objectContaining({ path: "/tokenHash", keyword: "additionalProperties" })]);

    // Any member may ask (no FORBIDDEN); the MFA policy of a live OTA is not a step-up (no REAUTH_REQUIRED).
    expect(op.spec["x-error-codes"]).toEqual(
      expect.arrayContaining(["TENANT_NOT_ACTIVE", "MFA_REQUIRED", "RATE_LIMITED", "EMAIL_NOT_VERIFIED"]),
    );
    expect(op.spec["x-error-codes"]).not.toContain("FORBIDDEN");
    expect(op.spec["x-error-codes"]).not.toContain("REAUTH_REQUIRED");
    // The token lives only in Redis: while Redis is down no token is issued (the SSO flow's failure handling).
    expect([op.spec["x-error-codes"], objectAt(op.spec, "responses")["503"]]).toEqual([
      expect.arrayContaining(["SERVICE_UNAVAILABLE"]),
      { $ref: "#/components/responses/ServiceUnavailable" },
    ]);
    // TENANT_NOT_ACTIVE names the status and the suspension reason, so the portal can explain it.
    const [, conflict = {}] = responsesOf(platform, op).find(([status]) => status === "409") ?? [];
    const [notActive] = examplesOf(platform, jsonMedia(conflict) ?? {});
    expect(Object.keys(objectAt(objectAt(notActive, "error"), "details"))).toEqual([
      "status",
      "suspensionReason",
    ]);
  });

  it("takes If-Match on the connection updates and answers the masked connection with its ETag, 412 and TENANT_NOT_ACTIVE [PBE-037 AC1]", () => {
    const rows = allRows();
    for (const [operationId, masked] of Object.entries(SLICE_PBE037_UPDATES)) {
      const op = operation(operationId);
      const pathItem = objectAt(objectAt(platform, "paths"), op.path);
      expect([operationId, pathItem["parameters"], op.spec["parameters"]]).toEqual([
        operationId,
        [
          { $ref: "#/components/parameters/TenantId" },
          { $ref: "#/components/parameters/ConnectionEnvironment" },
        ],
        [{ $ref: "#/components/parameters/IfMatch" }],
      ]);
      const statuses = responsesOf(platform, op).map(([status]) => status);
      expect([operationId, statuses]).toEqual([operationId, expect.arrayContaining(["200", "409", "412"])]);
      const ok = successOf(operationId, "200");
      expect([operationId, objectAt(ok, "headers")["ETag"], jsonMedia(ok)?.["schema"]]).toEqual([
        operationId,
        { $ref: "#/components/headers/ETag" },
        { $ref: masked },
      ]);
      expect([operationId, propertyNames(platform, { $ref: masked }).has("version")]).toEqual([
        operationId,
        true,
      ]);
      // A suspended OTA's connections are read-only (PADR-0014 item 5); only owners and admins write them.
      expect([operationId, op.spec["x-error-codes"]]).toEqual([
        operationId,
        expect.arrayContaining(["PRECONDITION_FAILED", "TENANT_NOT_ACTIVE", "FORBIDDEN", "NOT_FOUND"]),
      ]);
      // The request fields are those of the inventory row; the ones without `?` are required.
      const [, , , , exchange = ""] = rows.get(operationId) ?? [];
      expect(exchange).toContain("`If-Match`");
      const fields = inventoryFields(exchange);
      const body = resolve(platform, requestSchemaOf(operationId));
      expect([operationId, Object.keys(objectAt(body, "properties"))]).toEqual([
        operationId,
        fields.map((field) => field.replace(/\?$/u, "")),
      ]);
      const required = fields.filter((field) => !field.endsWith("?"));
      expect([operationId, isObject(body) ? body["required"] : undefined]).toEqual([
        operationId,
        required.length > 0 ? required : undefined,
      ]);
    }
    const environment = resolve(platform, { $ref: "#/components/parameters/ConnectionEnvironment" });
    expect(
      isObject(environment)
        ? [environment["name"], environment["in"], environment["required"], environment["schema"]]
        : [],
    ).toEqual(["environment", "path", true, { $ref: "#/components/schemas/Environment" }]);

    // The checker refuses a connection answer that leaks a ciphertext.
    for (const [operationId, leak] of [
      ["updateAmadeusConnection", "clientSecretCiphertext"],
      ["updatePaymentConnection", "secretKeyCiphertext"],
    ] as const) {
      const [example] = examplesOf(platform, jsonMedia(successOf(operationId, "200")) ?? {});
      expect(checker.check(operationId, { status: 200, body: example })).toEqual([]);
      expect(
        checker.check(operationId, { status: 200, body: { ...(example as Json), [leak]: "AAAA" } }),
      ).toEqual([expect.objectContaining({ path: `/${leak}`, keyword: "additionalProperties" })]);
    }
  });

  it("accepts only the statement descriptor suffixes that Stripe and the database CHECK accept", () => {
    const requests = requestBodyChecker(["updatePaymentConnection"]);
    const check = (suffix: unknown) =>
      requests
        .check("updatePaymentConnection", { status: 200, body: { statementDescriptorSuffix: suffix } })
        .map((problem) => `${problem.path} ${problem.keyword}`);
    const migration = readFileSync(join(PLATFORM_MIGRATIONS, "0002_add_mvp_platform_deltas.sql"), "utf8");
    const databaseCheck = new RegExp(
      /statement_descriptor_suffix ~ '([^']+)'/u.exec(migration)?.[1] ?? "(?!)",
      "u",
    );
    const answered = new RegExp(
      String(
        objectAt(
          objectAt(objectAt(objectAt(platform, "components"), "schemas")["PaymentConnection"], "properties"),
          "statementDescriptorSuffix",
        )["pattern"],
      ),
      "u",
    );

    const accepted = ["ACME TRAVEL", "ACME TRAVEL 24", "A1", "7 SEAS", "x".repeat(22), "Fjord Reisen"];
    for (const suffix of accepted) {
      expect([suffix, check(suffix)]).toEqual([suffix, []]);
      // Every accepted suffix can be stored and answered.
      expect([suffix, databaseCheck.test(suffix), answered.test(suffix)]).toEqual([suffix, true, true]);
    }
    const refused: ReadonlyArray<readonly [unknown, string]> = [
      // The two refusals of PBE-038's acceptance: a forbidden character, and 23 characters.
      ["ACME*TRAVEL", "pattern"],
      ["x".repeat(23), "maxLength"],
      ["A", "minLength"],
      ["", "minLength"],
      ["12345", "pattern"],
      ["2 4 6", "pattern"],
      [" ACME", "pattern"],
      ["ACME<TRAVEL", "pattern"],
      ["ACME>TRAVEL", "pattern"],
      ["ACME\\TRAVEL", "pattern"],
      ["ACME'S", "pattern"],
      ['ACME"S', "pattern"],
      ["ACMÉ TRAVEL", "pattern"],
      ["ACME-TRAVEL", "pattern"],
      ["ACME.TRAVEL", "pattern"],
      ["A&B TRAVEL", "pattern"],
      ["ACME\tTRAVEL", "pattern"],
      [null, "type"],
      [24, "type"],
    ];
    for (const [suffix, keyword] of refused) {
      expect([suffix, check(suffix)]).toEqual([
        suffix,
        expect.arrayContaining([`/statementDescriptorSuffix ${keyword}`]),
      ]);
    }
    expect(requests.check("updatePaymentConnection", { status: 200, body: {} })).toEqual([
      expect.objectContaining({ path: "/statementDescriptorSuffix", keyword: "required" }),
    ]);
    expect(
      requests.check("updatePaymentConnection", {
        status: 200,
        body: { statementDescriptorSuffix: "ACME TRAVEL", accountMode: "connect_standard" },
      }),
    ).toEqual([expect.objectContaining({ path: "/accountMode", keyword: "additionalProperties" })]);
  });

  it("validates the Amadeus settings with the schemas that listAmadeusConnections answers", () => {
    const schemas = objectAt(objectAt(platform, "components"), "schemas");
    const answered = objectAt(objectAt(schemas, "AmadeusConnection"), "properties");
    const update = objectAt(objectAt(schemas, "UpdateAmadeusConnectionRequest"), "properties");
    // The same schemas as the answer (openapi/README.md §2, PBE-006 notes); only the list is bounded.
    expect(update["ticketingDefaults"]).toEqual(answered["ticketingDefaults"]);
    expect(objectAt(update, "monitoredQueues")["items"]).toEqual(
      objectAt(answered, "monitoredQueues")["items"],
    );
    for (const office of ["defaultOfficeId", "queuingOfficeId", "ownerOfficeId"]) {
      expect([office, update[office]]).toEqual([office, { $ref: "#/components/schemas/AmadeusOfficeId" }]);
    }

    const requests = requestBodyChecker(["updateAmadeusConnection", "updatePaymentConnection"]);
    // Every request example of the slice is a valid body.
    for (const operationId of Object.keys(SLICE_PBE037_UPDATES)) {
      const body = resolve(platform, operation(operationId).spec["requestBody"]);
      const media = objectAt(objectAt(body, "content"), "application/json");
      const examples = examplesOf(platform, media);
      expect([operationId, examples.length > 0]).toEqual([operationId, true]);
      for (const example of examples) {
        expect([operationId, requests.check(operationId, { status: 200, body: example })]).toEqual([
          operationId,
          [],
        ]);
      }
    }

    const queue = { officeId: "NCE1A0955", queueId: 8, category: 0 };
    const check = (body: unknown) =>
      requests
        .check("updateAmadeusConnection", { status: 200, body })
        .map((problem) => `${problem.path} ${problem.keyword}`);
    expect(check({ monitoredQueues: [] })).toEqual([]);
    expect(check({ ticketingDefaults: {} })).toEqual([]);
    expect(
      check({ monitoredQueues: Array.from({ length: 20 }, (_, queueId) => ({ ...queue, queueId })) }),
    ).toEqual([]);
    // A problem of the whole body has the empty path: " minProperties".
    const refused: ReadonlyArray<readonly [unknown, string]> = [
      [{}, " minProperties"],
      [{ officeIds: ["NCE1A0955"] }, "/officeIds additionalProperties"],
      [{ clientSecret: "not-a-secret" }, "/clientSecret additionalProperties"],
      [{ status: "active" }, "/status additionalProperties"],
      [{ defaultOfficeId: "nce1a0955" }, "/defaultOfficeId pattern"],
      [{ queuingOfficeId: null }, "/queuingOfficeId type"],
      [{ ownerOfficeId: "NCE1A095" }, "/ownerOfficeId pattern"],
      [
        { ticketingDefaults: { ticketingAgreement: { option: "LATER" } } },
        "/ticketingDefaults/ticketingAgreement/option enum",
      ],
      [
        { ticketingDefaults: { issue: true, printer: "P1" } },
        "/ticketingDefaults/printer additionalProperties",
      ],
      [{ monitoredQueues: [{ officeId: "NCE1A0955", queueId: 8 }] }, "/monitoredQueues/0/category required"],
      [{ monitoredQueues: [{ ...queue, category: 255 }] }, "/monitoredQueues/0/category maximum"],
      [{ monitoredQueues: [queue, queue] }, "/monitoredQueues uniqueItems"],
      [
        { monitoredQueues: Array.from({ length: 21 }, (_, queueId) => ({ ...queue, queueId })) },
        "/monitoredQueues maxItems",
      ],
    ];
    for (const [body, problem] of refused) {
      expect([body, check(body)]).toEqual([body, expect.arrayContaining([problem])]);
    }
  });

  it("answers no property ending in Secret, Ciphertext or Hash in any response of the slice", () => {
    const leaky = (name: string): boolean => /(secret|ciphertext|hash)$/i.test(name);
    // The walk reaches the connection shapes, so the check cannot pass by not looking.
    expect(
      propertyNames(platform, jsonMedia(successOf("updateAmadeusConnection", "200"))?.["schema"]),
    ).toContain("pendingSubmission");
    for (const { operationId } of SLICE_PBE037) {
      for (const [status, response] of responsesOf(platform, operation(operationId))) {
        const names = [...propertyNames(platform, jsonMedia(response)?.["schema"])];
        expect([operationId, status, names.filter(leaky)]).toEqual([operationId, status, []]);
      }
    }
  });
});

/** Every schema object a schema reaches, through `$ref`s and the subschemas of any keyword (examples left out). */
function schemasOf(document: Json, schema: unknown, found: Json[] = [], seen = new Set<unknown>()): Json[] {
  if (Array.isArray(schema)) {
    schema.forEach((item) => schemasOf(document, item, found, seen));
    return found;
  }
  if (!isObject(schema) || seen.has(schema)) {
    return found;
  }
  seen.add(schema);
  if (typeof schema["$ref"] === "string") {
    return schemasOf(document, resolve(document, schema), found, seen);
  }
  found.push(schema);
  for (const [keyword, child] of Object.entries(schema)) {
    if (!["example", "examples", "enum", "const", "default"].includes(keyword)) {
      schemasOf(document, child, found, seen);
    }
  }
  return found;
}

/** The top-level properties a request schema accepts, through `$ref`s and every `oneOf`/`anyOf`/`allOf` branch. */
function bodyProperties(document: Json, schema: unknown): Array<[string, Json]> {
  const resolved = resolve(document, schema);
  if (!isObject(resolved)) {
    return [];
  }
  const own = Object.entries(objectAt(resolved, "properties")).map(([name, child]): [string, Json] => {
    const property = resolve(document, child);
    return [name, isObject(property) ? property : {}];
  });
  const branches = ["oneOf", "anyOf", "allOf"].flatMap((keyword) => {
    const list = resolved[keyword];
    return Array.isArray(list) ? (list as unknown[]) : [];
  });
  return [...own, ...branches.flatMap((branch) => bodyProperties(document, branch))];
}

/** The `{…}` field lists of an inventory cell (every one, in order), without `?`, `[]` and `: …` values. */
function inventoryFieldLists(cell: string, prefix = ""): string[][] {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...cell.matchAll(new RegExp(`\`${escaped}\\{([^}]+)\\}`, "gu"))].map(([, fields = ""]) =>
    fields.split(/,\s*/u).map((field) => (field.split(":")[0] ?? "").trim().replace(/(\[\])?\??$/u, "")),
  );
}

/** A `Money` amount with two decimals, in cents. */
function cents(money: unknown): bigint {
  const amount = String(isObject(money) ? money["amount"] : undefined);
  expect([amount, /^-?[0-9]+\.[0-9]{2}$/u.test(amount)]).toEqual([amount, true]);
  return BigInt(amount.replace(".", ""));
}

describe("the M5 portal slice: go-live, domains, own credentials, payments, settlements and billing (PBE-041)", () => {
  /** The rows of api-inventory §4–§8 and api-inventory-resources by operationId (the admin part is PBE-042's). */
  const portalRows = (): Map<string, string[]> =>
    new Map([...inventoryRows(INVENTORY), ...inventoryRows(INVENTORY_RESOURCES)]);
  const schemas = (): Json => objectAt(objectAt(platform, "components"), "schemas");
  const examplesAt = (operationId: string, status: string): unknown[] =>
    examplesOf(platform, jsonMedia(successOf(operationId, status)) ?? {});
  const errorExamples = (operationId: string, status: string): Json[] => {
    const [, response = {}] =
      responsesOf(platform, operation(operationId)).find(([candidate]) => candidate === status) ?? [];
    return examplesOf(platform, jsonMedia(response) ?? {}).map((example) => objectAt(example, "error"));
  };
  const requestExamples = (operationId: string): unknown[] => {
    const body = resolve(platform, operation(operationId).spec["requestBody"]);
    return examplesOf(platform, objectAt(objectAt(body, "content"), "application/json"));
  };
  const checkValues = (sql: string, anchor: RegExp): string[] => {
    const list = anchor.exec(sql)?.[1];
    expect([String(anchor), list === undefined]).toEqual([String(anchor), false]);
    return [...(list ?? "").matchAll(/'([^']+)'/g)].map(([, value = ""]) => value);
  };

  it("lists the 20 operations of the slice in the operations index, each with x-scope portal [PBE-041 AC1]", () => {
    expect(SLICE_PBE041).toHaveLength(20);
    const ids = new Set(SLICE_PBE041.map((entry) => entry.operationId));
    expect(ids.size).toBe(20);
    // 20 more operations: none of them belongs to an earlier slice.
    expect(
      [...SLICE, ...SLICE_PBE006, ...SLICE_PBE007, ...SLICE_PBE066, ...SLICE_PBE037].filter((entry) =>
        ids.has(entry.operationId),
      ),
    ).toEqual([]);
    for (const entry of SLICE_PBE041) {
      expect(platformOperations).toContainEqual(expect.objectContaining({ ...entry, sdkMethod: null }));
      expect([entry.operationId, operation(entry.operationId).spec["x-scope"]]).toEqual([
        entry.operationId,
        "portal",
      ]);
      expect([entry.operationId, operation(entry.operationId).spec["security"]]).toEqual([
        entry.operationId,
        [{ portalBearer: [] }],
      ]);
    }
  });

  it("documents each slice operation with the method, path, marks and errors of the M5 inventory rows [PBE-041 AC1]", () => {
    const rows = portalRows();
    // The slice is exactly the M5 rows of the portal parts of the inventory; the milestone is a row's last cell.
    const m5 = [...rows]
      .filter(([, cells]) => /^M5\b/u.test(cells[cells.length - 1] ?? ""))
      .map(([operationId]) => operationId);
    expect([...m5].sort()).toEqual(SLICE_PBE041.map((entry) => entry.operationId).sort());

    for (const entry of SLICE_PBE041) {
      const [, route = "", auth = "", , , , errors = ""] = rows.get(entry.operationId) ?? [];
      const [method = "", path = ""] = route.replaceAll("`", "").split(" ");
      expect([entry.operationId, entry.method, entry.path]).toEqual([
        entry.operationId,
        method.toLowerCase(),
        (path.split("?")[0] ?? "").replace(/^…/u, TENANT_PATH),
      ]);
      const marks = authMarks(auth);
      const spec = operation(entry.operationId).spec;
      const feature = marks.find((mark) => mark.startsWith("F:"))?.slice(2);
      expect([
        entry.operationId,
        scopeOf(marks),
        spec["x-mfa-step-up"] === true,
        spec["x-idempotent"] === true,
        spec["x-feature"],
        spec["x-reason-required"],
        spec["x-internal"],
      ]).toEqual([
        entry.operationId,
        "portal",
        marks.includes("MFA↑"),
        marks.includes("Idem"),
        feature,
        undefined,
        undefined,
      ]);
      // Every code of the inventory's Errors cell is answered; the operation answers the generic codes too.
      expect([entry.operationId, spec["x-error-codes"]]).toEqual([
        entry.operationId,
        expect.arrayContaining(codesOf(errors)),
      ]);
    }
  });

  it("marks the switches with x-feature and the step-ups with x-mfa-step-up, as the guards read them [PBE-041 AC1]", () => {
    const policies = new OperationPolicies(PlatformOpenApi.load());
    const features = SLICE_PBE041_FEATURES as Partial<Record<string, Feature>>;
    for (const { operationId } of SLICE_PBE041) {
      const spec = operation(operationId).spec;
      const feature = features[operationId];
      const stepUp = (SLICE_PBE041_STEP_UP as readonly string[]).includes(operationId);
      expect([operationId, spec["x-feature"], spec["x-mfa-step-up"] === true]).toEqual([
        operationId,
        feature,
        stepUp,
      ]);
      // RecentMfaGuard and FeatureGuard read these flags from the document (PBE-012).
      expect([operationId, policies.forOperation(operationId)]).toEqual([
        operationId,
        { scope: "portal", mfaStepUp: stepUp, features: feature === undefined ? [] : [feature] },
      ]);
      if (feature !== undefined) {
        // 403 FEATURE_DISABLED names the operation's own switch in details.feature.
        const disabled = errorExamples(operationId, "403").filter(
          (error) => error["code"] === "FEATURE_DISABLED",
        );
        expect([operationId, disabled.map((error) => objectAt(error, "details")["feature"])]).toEqual([
          operationId,
          [feature],
        ]);
      }
      if (stepUp) {
        expect([operationId, errorExamples(operationId, "401").map((error) => error["code"])]).toEqual([
          operationId,
          expect.arrayContaining(["REAUTH_REQUIRED"]),
        ]);
        expect([operationId, errorExamples(operationId, "403").map((error) => error["code"])]).toEqual([
          operationId,
          expect.arrayContaining(["MFA_REQUIRED"]),
        ]);
      }
    }
    // The slice uses every switch of PADR-0015, and only those.
    expect([...new Set(Object.values(SLICE_PBE041_FEATURES))].sort()).toEqual([...FEATURES].sort());
    // Only createCheckoutSession is idempotent.
    expect(
      SLICE_PBE041.filter(({ operationId }) => operation(operationId).spec["x-idempotent"] === true).map(
        ({ operationId }) => operationId,
      ),
    ).toEqual(["createCheckoutSession"]);
  });

  it("answers no secret in any response of the slice, and no write-only schema in any response of the document [PBE-041 AC2]", () => {
    const leaky = (name: string): boolean =>
      /(secret|ciphertext|hash)$/i.test(name) || BANK_FIELDS.has(name) || name === "secretKey";
    // The walk reaches the masked shapes, so the check cannot pass by not looking.
    expect(propertyNames(platform, jsonMedia(successOf("getPayoutAccount", "200"))?.["schema"])).toContain(
      "last4",
    );
    expect(
      propertyNames(platform, jsonMedia(successOf("completeStripeConnect", "200"))?.["schema"]),
    ).toContain("accountReference");
    for (const { operationId } of SLICE_PBE041) {
      for (const [status, response] of responsesOf(platform, operation(operationId))) {
        const names = [...propertyNames(platform, jsonMedia(response)?.["schema"])];
        expect([operationId, status, names.filter(leaky)]).toEqual([operationId, status, []]);
      }
    }

    // A write-only schema is never part of an answer, in this slice or any other operation.
    expect(
      schemasOf(platform, requestSchemaOf("setPayoutAccount")).some((s) => s["writeOnly"] === true),
    ).toBe(true);
    for (const op of operations) {
      for (const [status, response] of responsesOf(platform, op)) {
        for (const [type, media] of Object.entries(objectAt(response, "content"))) {
          const writeOnly = schemasOf(platform, objectAt({ media }, "media")["schema"]).filter(
            (schema) => schema["writeOnly"] === true,
          );
          expect([op.operationId, status, type, writeOnly]).toEqual([op.operationId, status, type, []]);
        }
      }
    }

    // The response checker refuses answers that leak a submitted secret or a ciphertext.
    const leaks: ReadonlyArray<readonly [PlatformOperationId, string, Json, string]> = [
      ["getPayoutAccount", "200", { iban: "NO9386011117947" }, "/iban"],
      ["setPayoutAccount", "200", { bankDetailsCiphertext: "AAAA" }, "/bankDetailsCiphertext"],
      ["submitAmadeusCredentials", "202", { clientSecret: "not-a-secret" }, "/clientSecret"],
      ["submitStripeApiKeys", "202", { secretKey: "sk_test_ExampleOnly" }, "/secretKey"],
      ["completeStripeConnect", "200", { accessToken: "not-a-token" }, "/accessToken"],
    ];
    for (const [operationId, status, extra, path] of leaks) {
      const [example] = examplesAt(operationId, status);
      expect(checker.check(operationId, { status: Number(status), body: example })).toEqual([]);
      expect(
        checker.check(operationId, { status: Number(status), body: { ...(example as Json), ...extra } }),
      ).toEqual([expect.objectContaining({ path, keyword: "additionalProperties" })]);
    }
    const [submitted] = examplesAt("submitAmadeusCredentials", "202");
    expect(
      checker.check("submitAmadeusCredentials", {
        status: 202,
        body: { submission: { ...objectAt(submitted, "submission"), secretCiphertext: "AAAA" } },
      }),
    ).toEqual([expect.objectContaining({ path: "/submission/secretCiphertext" })]);
  });

  it("marks every secret request field write-only and never echoes it or stores it for a replay [PBE-041 AC2]", () => {
    for (const [operationId, fields] of Object.entries(SLICE_PBE041_SECRETS)) {
      const properties = bodyProperties(platform, requestSchemaOf(operationId));
      for (const field of fields) {
        const found = properties.filter(([name]) => name === field);
        expect([operationId, field, found.length > 0]).toEqual([operationId, field, true]);
        for (const [, schema] of found) {
          expect([operationId, field, schema["writeOnly"]]).toEqual([operationId, field, true]);
        }
      }
      // Never idempotent, so a body with a secret is never stored for a replay; no answer repeats a secret.
      expect([operationId, operation(operationId).spec["x-idempotent"]]).toEqual([operationId, undefined]);
      const answers = JSON.stringify(
        responsesOf(platform, operation(operationId)).flatMap(([, response]) =>
          examplesOf(platform, jsonMedia(response) ?? {}),
        ),
      );
      const values = requestExamples(operationId).flatMap((example) =>
        fields.map((field) => objectAt({ example }, "example")[field]).filter((value) => value !== undefined),
      );
      expect([operationId, values.length > 0]).toEqual([operationId, true]);
      for (const value of values) {
        expect([operationId, answers.includes(String(value))]).toEqual([operationId, false]);
      }
    }
    // Across the whole document: a request property named like a secret, a password or a bank identifier is
    // write-only.
    const checked: string[] = [];
    for (const { operationId, spec } of operations) {
      if (spec["requestBody"] === undefined) {
        continue;
      }
      for (const [name, schema] of bodyProperties(platform, requestSchemaOf(operationId))) {
        if (/(secret|password)$/i.test(name) || BANK_FIELDS.has(name) || name === "secretKey") {
          checked.push(`${operationId}.${name}`);
          expect([operationId, name, schema["writeOnly"]]).toEqual([operationId, name, true]);
        }
      }
    }
    expect(checked).toEqual(
      expect.arrayContaining([
        "signIn.password",
        "adminCreateAmadeusAccount.clientSecret",
        "submitAmadeusCredentials.clientSecret",
        "submitStripeApiKeys.webhookSecret",
        "setPayoutAccount.iban",
      ]),
    );
  });

  it("keeps a suspended OTA's domains and connections read-only, and lets it pay", () => {
    for (const operationId of SLICE_PBE041_ACTIVE_ONLY) {
      expect([operationId, operation(operationId).spec["x-error-codes"]]).toEqual([
        operationId,
        expect.arrayContaining(["TENANT_NOT_ACTIVE"]),
      ]);
    }
    // PADR-0014 item 5: the owner of a suspended OTA can pay and download invoices.
    for (const operationId of ["createCheckoutSession", "createCustomerPortalSession", "listInvoices"]) {
      expect([operationId, operation(operationId).spec["x-error-codes"]]).toEqual([
        operationId,
        expect.not.arrayContaining(["TENANT_NOT_ACTIVE"]),
      ]);
    }
  });

  it("gives every request body of the slice examples that the request checker accepts", () => {
    // The slice's operations with a body; the others take none.
    const withBody = SLICE_PBE041.map(({ operationId }) => operationId).filter(
      (operationId) => operation(operationId).spec["requestBody"] !== undefined,
    );
    expect(withBody).toEqual([
      "goLive",
      "addDomain",
      "requestLiveAmadeus",
      "submitAmadeusCredentials",
      "completeStripeConnect",
      "submitStripeApiKeys",
      "createCheckoutSession",
      "setPayoutAccount",
    ]);
    const requests = requestBodyChecker(withBody);
    for (const operationId of withBody) {
      const examples = requestExamples(operationId);
      expect([operationId, examples.length > 0]).toEqual([operationId, true]);
      for (const example of examples) {
        expect([operationId, requests.check(operationId, { status: 200, body: example })]).toEqual([
          operationId,
          [],
        ]);
      }
    }
  });

  it("takes {confirm: true} on goLive and names every missing precondition of the inventory", () => {
    const requests = requestBodyChecker(["goLive"]);
    const check = (body: unknown) =>
      requests.check("goLive", { status: 200, body }).map((problem) => `${problem.path} ${problem.keyword}`);
    expect(check({ confirm: true })).toEqual([]);
    expect(check({ confirm: false })).toEqual(expect.arrayContaining(["/confirm const"]));
    expect(check({})).toEqual(expect.arrayContaining(["/confirm required"]));
    expect(check({ confirm: true, force: true })).toEqual(
      expect.arrayContaining(["/force additionalProperties"]),
    );

    // The preconditions of the inventory's Errors cell, each explained in the description; the example names some.
    const [, , , , , , errors = ""] = portalRows().get("goLive") ?? [];
    const missing = [
      ...(/`details\.missing`:([^)]*)\)/u.exec(errors)?.[1] ?? "").matchAll(/`([a-z_]+)`/gu),
    ].map(([, name = ""]) => name);
    expect(missing).toEqual([
      "amadeus_live",
      "payments_live",
      "payout_account",
      "plan_live_mode",
      "subscription",
      "mfa",
    ]);
    const description = String(operation("goLive").spec["description"]);
    for (const name of missing) {
      expect([name, description.includes(`\`${name}\``)]).toEqual([name, true]);
    }
    const [unmet] = errorExamples("goLive", "422");
    const named: unknown = objectAt(unmet, "details")["missing"];
    expect(Array.isArray(named) && named.length > 0).toBe(true);
    expect(missing).toEqual(expect.arrayContaining(Array.isArray(named) ? named : []));

    // The live tenant comes back with its new version.
    const ok = successOf("goLive", "200");
    expect([objectAt(ok, "headers")["ETag"], jsonMedia(ok)?.["schema"]]).toEqual([
      { $ref: "#/components/headers/ETag" },
      { $ref: "#/components/schemas/Tenant" },
    ]);
    expect(examplesAt("goLive", "200")).toEqual([expect.objectContaining({ storefrontEnvironment: "live" })]);
  });

  it("adds a custom domain with the DNS records of PADR-0004 and never removes or checks the sub-domain", () => {
    // The host name rules are the service's (422 DOMAIN_INVALID), so the schema lets every candidate through.
    const requests = requestBodyChecker(["addDomain"]);
    for (const hostname of ["Travel.Acme.com.", "reisen.bücher.example", "1.2.3.4", "x.github.io"]) {
      expect([hostname, requests.check("addDomain", { status: 200, body: { hostname } })]).toEqual([
        hostname,
        [],
      ]);
    }
    expect(requests.check("addDomain", { status: 200, body: { hostname: "" } })).toEqual([
      expect.objectContaining({ path: "/hostname", keyword: "minLength" }),
    ]);
    expect(requests.check("addDomain", { status: 200, body: { hostname: "a".repeat(255) } })).toEqual([
      expect.objectContaining({ path: "/hostname", keyword: "maxLength" }),
    ]);

    const [domain] = examplesAt("addDomain", "201");
    expect(domain).toMatchObject({ kind: "custom", verificationStatus: "pending", isPrimary: false });
    const hostname = String(objectAt({ domain }, "domain")["hostname"]);
    const records: unknown = objectAt({ domain }, "domain")["dnsRecords"];
    const list = (Array.isArray(records) ? records : []) as Json[];
    expect(list.map((record) => record["type"])).toEqual(["TXT", "CNAME", "A", "AAAA"]);
    expect(list[0]).toMatchObject({ name: `_velexis.${hostname}` });
    // The token: `vx-verify-` and 32 characters of Crockford's base32.
    expect(String(list[0]?.["value"])).toMatch(/^vx-verify-[0-9A-HJKMNP-TV-Z]{32}$/u);
    for (const record of list.slice(1)) {
      expect(record["name"]).toBe(hostname);
    }

    // The sub-domain can be neither removed nor checked; a verified domain needs no check.
    const reasons = (operationId: string) =>
      errorExamples(operationId, "409")
        .filter((error) => error["code"] === "CONFLICT")
        .map((error) => objectAt(error, "details")["reason"]);
    expect(reasons("removeDomain")).toEqual(["subdomain"]);
    expect(reasons("checkDomain")).toEqual(["subdomain", "already_verified"]);
    expect(errorExamples("makeDomainPrimary", "409").map((error) => error["code"])).toEqual([
      "DOMAIN_NOT_VERIFIED",
      "TENANT_NOT_ACTIVE",
    ]);
    // Removal answers 204 without a body; the check is rate limited and needs Redis for its job.
    expect(objectAt(successOf("removeDomain", "204"), "content")).toEqual({});
    expect(operation("checkDomain").spec["x-error-codes"]).toEqual(
      expect.arrayContaining(["RATE_LIMITED", "SERVICE_UNAVAILABLE"]),
    );
    expect(objectAt(operation("checkDomain").spec, "responses")["503"]).toEqual({
      $ref: "#/components/responses/ServiceUnavailable",
    });
  });

  it("verifies own credentials through a submission with the kinds and statuses of migration 0002", () => {
    const deltas = readFileSync(join(PLATFORM_MIGRATIONS, "0002_add_mvp_platform_deltas.sql"), "utf8");
    const submission = objectAt(objectAt(schemas(), "CredentialSubmission"), "properties");
    const table = /CREATE TABLE platform\.credential_submissions \(([\s\S]*?)\n\);/u.exec(deltas)?.[1] ?? "";
    expect([objectAt(submission, "kind")["enum"], objectAt(submission, "status")["enum"]]).toEqual([
      checkValues(table, /CHECK \(kind IN \(([^)]*)\)\)/u),
      checkValues(table, /CHECK \(status IN \(([^)]*)\)\)/u),
    ]);
    // getCredentialSubmission answers the inventory's fields; both submissions answer a pending one.
    const [, , , , exchange = ""] = portalRows().get("getCredentialSubmission") ?? [];
    expect(Object.keys(submission)).toEqual(inventoryFieldLists(exchange)[0]);
    for (const [operationId, kind] of [
      ["submitAmadeusCredentials", "amadeus"],
      ["submitStripeApiKeys", "stripe_api_keys"],
    ] as const) {
      expect(examplesAt(operationId, "202")).toEqual([
        expect.objectContaining({ submission: expect.objectContaining({ kind, status: "pending" }) }),
      ]);
      // The environment needs no connection yet: the success creates it.
      const pathItem = objectAt(objectAt(platform, "paths"), operation(operationId).path);
      expect(pathItem["parameters"]).toEqual([
        { $ref: "#/components/parameters/TenantId" },
        { $ref: "#/components/parameters/CredentialsEnvironment" },
      ]);
      const [, , , , cell = ""] = portalRows().get(operationId) ?? [];
      expect([
        operationId,
        Object.keys(objectAt(resolve(platform, requestSchemaOf(operationId)), "properties")),
      ]).toEqual([operationId, inventoryFieldLists(cell)[0]]);
    }

    const requests = requestBodyChecker(["submitAmadeusCredentials", "submitStripeApiKeys"]);
    const problems = (operationId: string, body: unknown) =>
      requests
        .check(operationId, { status: 200, body })
        .map((problem) => `${problem.path} ${problem.keyword}`);
    for (const operationId of ["submitAmadeusCredentials", "submitStripeApiKeys"]) {
      for (const example of requestExamples(operationId)) {
        expect([operationId, problems(operationId, example)]).toEqual([operationId, []]);
      }
    }
    const amadeus = {
      clientId: "acme-amadeus-client",
      clientSecret: "not-a-secret",
      officeIds: ["OSLN12345"],
      defaultOfficeId: "OSLN12345",
    };
    expect(problems("submitAmadeusCredentials", amadeus)).toEqual([]);
    expect(problems("submitAmadeusCredentials", { ...amadeus, officeIds: ["osln12345"] })).toEqual(
      expect.arrayContaining(["/officeIds/0 pattern"]),
    );
    expect(
      problems("submitAmadeusCredentials", { ...amadeus, officeIds: ["OSLN12345", "OSLN12345"] }),
    ).toEqual(expect.arrayContaining(["/officeIds uniqueItems"]));
    expect(problems("submitAmadeusCredentials", { ...amadeus, officeIds: [] })).toEqual(
      expect.arrayContaining(["/officeIds minItems"]),
    );
    expect(problems("submitAmadeusCredentials", { ...amadeus, baseUrl: "https://example.com" })).toEqual(
      expect.arrayContaining(["/baseUrl additionalProperties"]),
    );
    const { clientSecret, ...withoutSecret } = amadeus;
    expect(clientSecret).toBe("not-a-secret");
    expect(problems("submitAmadeusCredentials", withoutSecret)).toEqual(["/clientSecret required"]);

    const keys = {
      publishableKey: "pk_test_ExampleOnly",
      secretKey: "sk_test_ExampleOnly",
      webhookSecret: "whsec_Ab-1_c",
    };
    expect(problems("submitStripeApiKeys", keys)).toEqual([]);
    expect(problems("submitStripeApiKeys", { ...keys, secretKey: "rk_live_ExampleOnly" })).toEqual([]);
    expect(problems("submitStripeApiKeys", { ...keys, secretKey: "pk_test_ExampleOnly" })).toEqual(
      expect.arrayContaining(["/secretKey pattern"]),
    );
    expect(problems("submitStripeApiKeys", { ...keys, publishableKey: "sk_test_ExampleOnly" })).toEqual(
      expect.arrayContaining(["/publishableKey pattern"]),
    );
    expect(problems("submitStripeApiKeys", { ...keys, webhookSecret: "ExampleOnly" })).toEqual(
      expect.arrayContaining(["/webhookSecret pattern"]),
    );

    // The webhook endpoint the OTA creates in Stripe, with the payment events of the flow (stripe-payments-account §D).
    const [submitted] = examplesAt("submitStripeApiKeys", "202");
    expect(submitted).toMatchObject({
      webhookUrl: expect.stringMatching(/^https:\/\/api\.ota\.example\.com\/webhooks\/stripe\/c\/ppc_/u),
      webhookEvents: [
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "payment_intent.canceled",
        "payment_intent.amount_capturable_updated",
        "charge.refunded",
        "charge.dispute.created",
        "charge.dispute.closed",
      ],
    });
  });

  it("starts Stripe Connect with a no-store authorize URL and takes its callback's state with a code or an error", () => {
    const start = successOf("startStripeConnect", "200");
    expect(objectAt(start, "headers")["Cache-Control"]).toEqual({ $ref: "#/components/headers/NoStore" });
    const [started] = examplesAt("startStripeConnect", "200");
    const url = new URL(String(objectAt({ started }, "started")["authorizeUrl"]));
    expect([
      url.origin + url.pathname,
      url.searchParams.get("response_type"),
      url.searchParams.get("scope"),
    ]).toEqual(["https://connect.stripe.com/oauth/authorize", "code", "read_write"]);
    for (const name of ["client_id", "state", "redirect_uri", "stripe_user[email]"]) {
      expect([name, url.searchParams.has(name)]).toEqual([name, true]);
    }
    // The state lives in Redis only: both steps answer 503 while it is down.
    for (const operationId of ["startStripeConnect", "completeStripeConnect"]) {
      expect([operationId, objectAt(operation(operationId).spec, "responses")["503"]]).toEqual([
        operationId,
        { $ref: "#/components/responses/ServiceUnavailable" },
      ]);
    }

    // The callback names no OTA in its path: the state does.
    expect(operation("completeStripeConnect").path.includes("{tenantId}")).toBe(false);
    const requests = requestBodyChecker(["completeStripeConnect"]);
    const check = (body: unknown) => requests.check("completeStripeConnect", { status: 200, body });
    const state = "Xq7Lm2Np9Rt4Vw8Yb3Dc6Fg1Hj5Kk0Zs2Ae7Ui4Ow9Pq";
    for (const example of requestExamples("completeStripeConnect")) {
      expect(check(example)).toEqual([]);
    }
    expect(check({ state, code: "ac_ExampleAuthorizationCode" })).toEqual([]);
    expect(check({ state, error: "access_denied" })).toEqual([]);
    for (const body of [
      { state, code: "ac_ExampleAuthorizationCode", error: "access_denied" },
      { state },
      { code: "ac_ExampleAuthorizationCode" },
      { state: "short", code: "ac_ExampleAuthorizationCode" },
    ]) {
      expect([body, check(body).length > 0]).toEqual([body, true]);
    }
    // Both outcomes of the inventory: the declined case and the mode mismatch name their reason.
    expect(
      errorExamples("completeStripeConnect", "422").map((error) => objectAt(error, "details")["reason"]),
    ).toEqual(["access_denied", "livemode_mismatch"]);
    const completed = jsonMedia(successOf("completeStripeConnect", "200"))?.["schema"];
    expect(resolve(platform, completed)).toMatchObject({
      required: ["tenantId", "connections"],
      properties: { connections: { items: { $ref: "#/components/schemas/PaymentConnection" } } },
    });
  });

  it("sets the payout account as an IBAN or a local account and answers it masked", () => {
    const deltas = readFileSync(join(PLATFORM_MIGRATIONS, "0002_add_mvp_platform_deltas.sql"), "utf8");
    const table = /CREATE TABLE platform\.tenant_payout_accounts \(([\s\S]*?)\n\);/u.exec(deltas)?.[1] ?? "";
    expect([
      objectAt(schemas(), "PayoutAccountStatus")["enum"],
      objectAt(schemas(), "PayoutScheme")["enum"],
    ]).toEqual([
      checkValues(table, /CHECK \(status IN \(([^)]*)\)\)/u),
      checkValues(table, /CHECK \(scheme IN \(([^)]*)\)\)/u),
    ]);
    // The masked answer has the inventory's fields; the request's two shapes have the inventory's too.
    const [, , , , exchange = ""] = portalRows().get("getPayoutAccount") ?? [];
    expect(Object.keys(objectAt(objectAt(schemas(), "PayoutAccount"), "properties"))).toEqual(
      inventoryFieldLists(exchange, "PayoutAccount ")[0],
    );
    const [, , , , request = ""] = portalRows().get("setPayoutAccount") ?? [];
    const [iban = [], local = []] = inventoryFieldLists(request);
    expect([
      Object.keys(objectAt(objectAt(schemas(), "IbanPayoutAccountRequest"), "properties")),
      Object.keys(objectAt(objectAt(schemas(), "LocalPayoutAccountRequest"), "properties")),
    ]).toEqual([
      iban,
      [...iban.filter((field) => !["scheme", "iban", "bic"].includes(field)), ...local.slice(1)],
    ]);
    for (const operationId of ["getPayoutAccount", "setPayoutAccount"]) {
      expect([operationId, objectAt(successOf(operationId, "200"), "headers")["ETag"]]).toEqual([
        operationId,
        { $ref: "#/components/headers/ETag" },
      ]);
    }

    const requests = requestBodyChecker(["setPayoutAccount"]);
    const check = (body: unknown) => requests.check("setPayoutAccount", { status: 200, body });
    for (const example of requestExamples("setPayoutAccount")) {
      expect(check(example)).toEqual([]);
    }
    const holder = { accountHolderName: "Acme Travel AS", countryCode: "NO", currency: "NOK" };
    expect(check({ ...holder, scheme: "iban", iban: "no93 8601 1117 947" })).toEqual([]);
    expect(check({ ...holder, scheme: "iban", iban: "NO9386011117947", bic: "DNBANOKKXXX" })).toEqual([]);
    for (const body of [
      { ...holder, scheme: "iban", iban: "1234" },
      { ...holder, scheme: "iban", iban: "NO9386011117947", bic: "DNBANOKKX" },
      { ...holder, scheme: "iban", iban: "NO9386011117947", accountNumber: "000123456789" },
      { ...holder, scheme: "local", iban: "NO9386011117947" },
      { ...holder, scheme: "local", accountNumber: "000123456789" },
      { ...holder, scheme: "swift", iban: "NO9386011117947" },
    ]) {
      expect([body, check(body).length > 0]).toEqual([body, true]);
    }
    // The checksum error points at the field and never holds the value.
    const [checksum] = errorExamples("setPayoutAccount", "400");
    expect(checksum?.["fieldErrors"]).toEqual([
      expect.objectContaining({ path: "/iban", code: "iban_checksum" }),
    ]);
  });

  it("lists statements without drafts, answers their totals and downloads their lines as CSV", () => {
    const deltas = readFileSync(join(PLATFORM_MIGRATIONS, "0002_add_mvp_platform_deltas.sql"), "utf8");
    const statuses = checkValues(
      /CREATE TABLE platform\.settlements \(([\s\S]*?)\n\);/u.exec(deltas)?.[1] ?? "",
      /CHECK \(status IN \(([^)]*)\)\)/u,
    );
    const summary = objectAt(objectAt(schemas(), "SettlementSummary"), "properties");
    const settlement = objectAt(objectAt(schemas(), "Settlement"), "properties");
    // Drafts and voided drafts never reach the portal.
    expect(objectAt(summary, "status")["enum"]).toEqual(
      statuses.filter((status) => !["draft", "void"].includes(status)),
    );

    // The inventory's fields: the summary, and the statement as the summary plus its totals, with the same schemas.
    const rows = portalRows();
    const [, , , , list = ""] = rows.get("listSettlements") ?? [];
    const [, , , , detail = ""] = rows.get("getSettlement") ?? [];
    expect(Object.keys(summary)).toEqual(inventoryFieldLists(list, "{data: [SettlementSummary ")[0]);
    const [first = "", ...extra] = inventoryFieldLists(detail, "Settlement ")[0] ?? [];
    expect(first).toBe("…summary");
    expect(Object.keys(settlement)).toEqual([...Object.keys(summary), ...extra]);
    for (const name of Object.keys(summary)) {
      expect([name, settlement[name]]).toEqual([name, summary[name]]);
    }
    // The example keeps the formula of PADR-0003 item 5 and its Velexis fee.
    const [statement] = examplesAt("getSettlement", "200");
    const value = (name: string): bigint => cents(objectAt({ statement }, "statement")[name]);
    expect(value("netAmount")).toBe(
      value("grossAmount") -
        value("refundsAmount") -
        value("disputesAmount") -
        value("stripeFeesAmount") -
        value("velexisFeesAmount") +
        value("adjustmentsAmount"),
    );
    const feeBps = BigInt(Number(objectAt({ statement }, "statement")["feeBps"]));
    expect(value("velexisFeesAmount") * 10_000n).toBe(
      feeBps * (value("grossAmount") - value("refundsAmount")),
    );

    // The CSV: text/csv only, never cached, a file named after the month and currency.
    const ok = successOf("downloadSettlementLines", "200");
    expect(Object.keys(objectAt(ok, "content"))).toEqual(["text/csv"]);
    const headers = objectAt(ok, "headers");
    expect(objectAt(resolve(platform, headers["Cache-Control"]), "schema")["const"]).toBe("no-store");
    const disposition = objectAt(objectAt(headers, "Content-Disposition"), "schema");
    const filenames: unknown = disposition["examples"];
    expect(Array.isArray(filenames) && filenames.length > 0).toBe(true);
    for (const filename of Array.isArray(filenames) ? (filenames as unknown[]) : []) {
      expect(new RegExp(String(disposition["pattern"]), "u").test(String(filename))).toBe(true);
    }
    // Its header row is the inventory's column list, which the description names too.
    const [, , , , csvCell = ""] = rows.get("downloadSettlementLines") ?? [];
    const columns = (/`text\/csv` \(([^)]+)\)/u.exec(csvCell)?.[1] ?? "").split(/,\s*/u);
    expect(columns).toEqual([...SETTLEMENT_CSV_COLUMNS]);
    const description = String(operation("downloadSettlementLines").spec["description"]);
    for (const column of SETTLEMENT_CSV_COLUMNS) {
      expect([column, description.includes(`\`${column}\``)]).toEqual([column, true]);
    }
    const media = objectAt(objectAt(ok, "content"), "text/csv");
    const [header = "", ...lines] = String(media["example"]).trimEnd().split("\n");
    expect(csvCells(header)).toEqual([...SETTLEMENT_CSV_COLUMNS]);
    // Each row: a line type of the CHECK, a time, signed amounts and text cells that cannot run as formulas.
    const lineTypes = checkValues(deltas, /CHECK \(line_type IN \(([^)]*)\)\)/u);
    expect(description).toContain(
      "a text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`",
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const [type = "", occurredAt = "", amount = "", stripeFee = "", ...text] = csvCells(line);
      expect([line, text.length]).toEqual([line, 4]);
      expect([type, lineTypes.includes(type)]).toEqual([type, true]);
      expect([occurredAt, Number.isNaN(Date.parse(occurredAt))]).toEqual([occurredAt, false]);
      expect([amount, stripeFee].every((cell) => /^-?[0-9]+\.[0-9]{2}$/u.test(cell))).toBe(true);
      for (const cell of text) {
        expect([cell, /^[=+\-@\t\r]/u.test(cell)]).toEqual([cell, false]);
      }
    }
    // The response checker reads JSON only, so it refuses the CSV; the list of non-JSON answers is exactly these.
    expect(() => checker.check("downloadSettlementLines", { status: 200, body: media["example"] })).toThrow(
      /no JSON content \(text\/csv\)/,
    );
    expect(NON_JSON_RESPONSES).toEqual({
      adminExportAudit: { "200": ["text/csv"] },
      downloadSettlementLines: { "200": ["text/csv"] },
    });
  });

  it("opens Checkout idempotently and the Customer Portal without storing its URL, and lists invoices like AdminInvoice", () => {
    const rows = portalRows();
    // Checkout: idempotent, so its answer is replayed and is not no-store; the inventory's request and answer.
    const checkout = operation("createCheckoutSession");
    expect(checkout.spec["parameters"]).toEqual([{ $ref: "#/components/parameters/IdempotencyKey" }]);
    const created = successOf("createCheckoutSession", "201");
    expect(objectAt(created, "headers")["Cache-Control"]).toBeUndefined();
    const [, , , , checkoutCell = ""] = rows.get("createCheckoutSession") ?? [];
    expect([
      Object.keys(objectAt(objectAt(schemas(), "CreateCheckoutSessionRequest"), "properties")),
      Object.keys(objectAt(objectAt(schemas(), "CheckoutSession"), "properties")),
    ]).toEqual([inventoryFieldLists(checkoutCell)[0], inventoryFieldLists(checkoutCell, "201 ")[0]]);
    expect(errorExamples("createCheckoutSession", "409").map((error) => error["code"])).toEqual([
      "CONFLICT",
      "IDEMPOTENCY_KEY_REUSED",
    ]);
    expect(objectAt(errorExamples("createCheckoutSession", "409")[0], "details")["reason"]).toBe(
      "stripe_subscription_active",
    );
    for (const status of ["502", "503"]) {
      expect([status, objectAt(checkout.spec, "responses")[status]]).toEqual([status, expect.any(Object)]);
    }
    const requests = requestBodyChecker(["createCheckoutSession"]);
    expect(requests.check("createCheckoutSession", { status: 200, body: { planCode: "growth" } })).toEqual([
      expect.objectContaining({ path: "/billingInterval", keyword: "required" }),
    ]);

    // The Customer Portal: the URL signs its holder in, so it is no-store and never replayed.
    const portal = operation("createCustomerPortalSession");
    expect([portal.spec["x-idempotent"], portal.spec["parameters"]]).toEqual([undefined, undefined]);
    const session = successOf("createCustomerPortalSession", "201");
    expect(objectAt(session, "headers")["Cache-Control"]).toEqual({ $ref: "#/components/headers/NoStore" });
    const [, , , , portalCell = ""] = rows.get("createCustomerPortalSession") ?? [];
    expect(Object.keys(objectAt(objectAt(schemas(), "CustomerPortalSession"), "properties"))).toEqual(
      inventoryFieldLists(portalCell, "201 ")[0],
    );
    expect(objectAt(errorExamples("createCustomerPortalSession", "409")[0], "details")["reason"]).toBe(
      "no_stripe_customer",
    );

    // Invoices: the inventory's fields, each with the schema of AdminInvoice.
    const [, , , , invoicesCell = ""] = rows.get("listInvoices") ?? [];
    const invoice = objectAt(objectAt(schemas(), "Invoice"), "properties");
    const admin = objectAt(objectAt(schemas(), "AdminInvoice"), "properties");
    expect(Object.keys(invoice)).toEqual(inventoryFieldLists(invoicesCell, "{data: [Invoice ")[0]);
    for (const name of Object.keys(invoice)) {
      expect([name, invoice[name]]).toEqual([name, admin[name]]);
    }
    expect(objectAt(schemas(), "Invoice")["required"]).toEqual(Object.keys(invoice));

    // The no-store answers of the slice: the two one-time sign-in URLs, and the masked rest is cacheable data.
    const noStore = SLICE_PBE041.filter((entry) =>
      responsesOf(platform, operation(entry.operationId)).some(
        ([status, response]) =>
          status.startsWith("2") &&
          objectAt(objectAt(response, "headers"), "Cache-Control")["$ref"] === "#/components/headers/NoStore",
      ),
    ).map((entry) => entry.operationId);
    expect(noStore).toEqual(["startStripeConnect", "createCustomerPortalSession"]);
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
