// Contract tests of the platform OpenAPI document, openapi/velexis-platform-api.openapi.yaml (ADR-0006, PADR-0016).
//
// PBE-005 wrote its first slice (identity, plans, internal: 24 operations, the conventions and the error catalogue),
// PBE-006 the second (tenants, team, API keys and the M1 reads: 27 operations), PBE-007 the first admin slice
// (admin auth and dashboard, tenants, provisioning jobs and queues: 21 operations), PBE-066 the second (plans and
// subscriptions, Amadeus accounts and offices, accounts, platform admins and audit: 26 operations), PBE-037 the M3
// and M4 slice (the statement descriptor, the console token and the Amadeus settings: 3 operations), PBE-041 the M5
// portal slice (go-live, custom domains, own credentials, Stripe Connect and API keys, the payout account,
// settlements, Checkout, the Customer Portal and invoices: 20 operations) and PBE-042 the last one, the M5 admin and
// webhook slice (the Stripe billing admin, the office release, settlements and payout accounts, domains and the two
// Stripe webhook receivers: 23 operations, and the Stripe ids of adminUpdatePlan). The tests of a slice name its
// operations by operationId and never count the document. The convention checks run on every operation of the
// document: x-scope and the matching security scheme, `platform_admin` on every `/v1/admin/` path but the public
// sign-in steps, X-Request-Id on every response, x-platform-tables, Idempotency-Key exactly on x-idempotent
// operations, a 5–500 character `reason` exactly on x-reason-required operations, closed request bodies (an open one,
// the Stripe event of the webhook receivers, only where OPEN_REQUEST_BODIES lists it), `Cache-Control: no-store` on
// secret-bearing responses, error examples that agree with x-error-codes and the catalogue, and examples that
// validate with the Ajv checker of @velexis/testing that the integration tests use (a body that is not JSON, such as
// the CSV exports, only where NON_JSON_RESPONSES lists it, and its slice test checks it). The PBE-041 slice test also
// checks every operation: no answer reaches a write-only schema, and a request property named like a secret, a
// password or a bank identifier is write-only. `pnpm contracts:lint` (Redocly, X-007) and the generators' tests (X-008,
// X-009) cover the lint and the generated files.
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
import {
  STRIPE_FIXTURE_EVENT_TYPES,
  STRIPE_SIGNATURE_HEADER,
  stripeFixture,
  type StripeFixtureEventType,
} from "@velexis/testing/stripe";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { OperationPolicies } from "../../src/common/auth/decorators";
import { FEATURES, type Feature } from "../../src/common/features";
import { PlatformOpenApi } from "../../src/common/http/openapi-validation.interceptor";
import { WEBHOOK_BODY_LIMIT, WEBHOOK_PATH_PREFIX } from "../../src/common/http/raw-body";
import { KEEP_COMPLETED_JOBS, KEEP_FAILED_JOBS } from "../../src/common/queues/queue-names";
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

/**
 * Response properties that hold a secret: a 2xx response with one must document `Cache-Control: no-store`. The bank
 * identifiers of a payout account are answered only when an admin reveals them (PBE-042).
 */
const SECRET_PROPERTIES = new Set([
  "accessToken",
  "refreshToken",
  "mfaChallengeToken",
  "portalToken",
  "secret",
  "otpauthUrl",
  "recoveryCodes",
  "iban",
  "bic",
  "accountNumber",
  "routingNumber",
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
  // The callback refuses too while the switch is off (FIX-W36-PLATFORM, lead decision (2h) of 2026-10-30).
  completeStripeConnect: "own_stripe",
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

const ADMIN_SETTLEMENT_PATH = "/v1/admin/settlements/{settlementId}";
const ADMIN_PAYOUT_PATH = "/v1/admin/tenants/{tenantId}/payout-account";

/**
 * The PBE-042 slice: the M5 rows of api-inventory-admin §4 (Stripe billing admin, 5), §5 (the office release), §6
 * (settlements and payout accounts, 12, with `adminDownloadSettlementLines` of PADR-0016 item 4) and §7 (domains, 3),
 * and the two webhook receivers of §8.
 */
const SLICE_PBE042: readonly SliceOperation[] = [
  ...(
    [
      ["adminCheckPlanPrices", "post", "/v1/admin/plans/{planCode}/check-prices"],
      ["adminResyncSubscription", "post", "/v1/admin/subscriptions/{subscriptionId}/resync"],
      ["adminListInvoices", "get", "/v1/admin/invoices"],
      ["adminListStripeEvents", "get", "/v1/admin/stripe-events"],
      ["adminReprocessStripeEvent", "post", "/v1/admin/stripe-events/{eventId}/reprocess"],
      ["adminReleaseAmadeusOffice", "post", "/v1/admin/amadeus-offices/{officeRowId}/release"],
      ["adminListSettlements", "get", "/v1/admin/settlements"],
      ["adminGenerateSettlements", "post", "/v1/admin/settlements/generate"],
      ["adminGetSettlement", "get", ADMIN_SETTLEMENT_PATH],
      ["adminListSettlementLines", "get", `${ADMIN_SETTLEMENT_PATH}/lines`],
      ["adminDownloadSettlementLines", "get", `${ADMIN_SETTLEMENT_PATH}/lines.csv`],
      ["adminAddSettlementAdjustment", "post", `${ADMIN_SETTLEMENT_PATH}/adjustments`],
      ["adminApproveSettlement", "post", `${ADMIN_SETTLEMENT_PATH}/approve`],
      ["adminMarkSettlementPaid", "post", `${ADMIN_SETTLEMENT_PATH}/mark-paid`],
      ["adminVoidSettlement", "post", `${ADMIN_SETTLEMENT_PATH}/void`],
      ["adminGetPayoutAccount", "get", ADMIN_PAYOUT_PATH],
      ["adminRevealPayoutAccount", "post", `${ADMIN_PAYOUT_PATH}/reveal`],
      ["adminReviewPayoutAccount", "post", `${ADMIN_PAYOUT_PATH}/review`],
      ["adminListDomains", "get", "/v1/admin/domains"],
      ["adminRecheckDomain", "post", "/v1/admin/domains/{domainId}/recheck"],
      ["adminRemoveDomain", "post", "/v1/admin/domains/{domainId}/remove"],
    ] as const
  ).map(([operationId, method, path]): SliceOperation => ({
    operationId,
    method,
    path,
    scope: "platform_admin",
    internal: false,
  })),
  {
    operationId: "receiveStripeBillingEvent",
    method: "post",
    path: "/webhooks/stripe/billing",
    scope: "webhook",
    internal: true,
  },
  {
    operationId: "receiveStripeConnectAccountEvent",
    method: "post",
    path: "/webhooks/stripe/connect-accounts",
    scope: "webhook",
    internal: true,
  },
];

/**
 * The PBE-042 operations marked **reason** in api-inventory-admin (PADR-0006 item 5, PADR-0012 item 5, PADR-0003
 * item 10).
 */
const SLICE_PBE042_REASON = [
  "adminReleaseAmadeusOffice",
  "adminAddSettlementAdjustment",
  "adminVoidSettlement",
  "adminRevealPayoutAccount",
  "adminRemoveDomain",
] as const satisfies readonly PlatformOperationId[];

/** The PBE-042 operations marked MFA↑: approving and paying settlements, revealing a payout account (PADR-0006 item 4). */
const SLICE_PBE042_STEP_UP = [
  "adminApproveSettlement",
  "adminMarkSettlementPaid",
  "adminRevealPayoutAccount",
] as const satisfies readonly PlatformOperationId[];

/**
 * The request bodies that are open on purpose: the Stripe event of the webhook receivers, which Stripe extends without
 * notice, so a closed schema would refuse correctly signed events. Every other request body is closed.
 */
const OPEN_REQUEST_BODIES: Readonly<Record<string, string>> = {
  receiveStripeBillingEvent: "#/components/schemas/StripeEvent",
  receiveStripeConnectAccountEvent: "#/components/schemas/StripeConnectAccountEvent",
};

/**
 * The signed Stripe fixtures of X-028 (@velexis/testing/stripe) that each receiver takes, as the fixtures' README
 * routes them: the receivers of PBE-043 and PBE-056 must store every one of them.
 */
const WEBHOOK_FIXTURES = {
  receiveStripeBillingEvent: ["checkout.session.completed", "customer.subscription.updated", "invoice.paid"],
  receiveStripeConnectAccountEvent: ["account.updated", "account.application.deauthorized"],
} as const satisfies Partial<Record<PlatformOperationId, readonly StripeFixtureEventType[]>>;

/** The columns of the admin's settlement lines CSV, in file order (api-inventory-admin §6). */
const ADMIN_SETTLEMENT_CSV_COLUMNS = [
  "id",
  "type",
  "occurredAt",
  "amount",
  "stripeFee",
  "originalAmount",
  "originalCurrency",
  "balanceTransactionId",
  "sourceId",
  "paymentIntentId",
  "velexisPaymentId",
  "checkoutId",
  "description",
  "createdByAccountId",
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
  adminDownloadSettlementLines: { "200": ["text/csv"] },
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
  /** The Errors cell. */
  readonly errors: string;
  readonly milestone: string;
}

/**
 * The rows of api-inventory-admin §4, §5 and §7 (or of the sections given) by operationId. One row may name two
 * operations (`adminDisableAccount` / `adminEnableAccount` with `POST …/disable` / `enable`): the second route
 * replaces the last segment of the first path.
 */
function adminSectionRows(
  headings: readonly string[] = ["## 4. ", "## 5. ", "## 7. "],
): Map<string, AdminInventoryRow> {
  const text = readFileSync(INVENTORY_ADMIN, "utf8");
  const sections = headings.map((heading) => {
    const start = text.indexOf(heading);
    expect([heading, start >= 0]).toEqual([heading, true]);
    return text.slice(start, text.indexOf("\n## ", start + 1));
  });
  const rows = new Map<string, AdminInventoryRow>();
  for (const line of sections.join("\n").split("\n")) {
    // A pipe escaped as `\|` (`"trialing" \| "canceled"`) belongs to its cell.
    const cells = line.split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));
    const [, first = "", route = "", purpose = "", exchange = "", , errors = "", milestone = ""] = cells;
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
        errors,
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

  it("answers AdminPlan as Plan plus the admin fields, and keeps code and currency out of adminUpdatePlan", () => {
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

    // The update takes any field but code and currency, and retires with isActive. The M1 request had no Stripe id;
    // PBE-042 adds exactly the three of AdminPlan for M5 (its slice test checks them).
    const update = Object.keys(objectAt(objectAt(schemas, "UpdatePlanRequest"), "properties"));
    const stripeIds = ["stripeProductId", "stripePriceIdMonth", "stripePriceIdYear"];
    expect([...update].sort()).toEqual(
      [
        ...fields
          .map((field) => field.replace("?", ""))
          .filter((field) => field !== "code" && field !== "currency"),
        "isActive",
        ...stripeIds,
      ].sort(),
    );
    expect(update.filter((name) => name.startsWith("stripe"))).toEqual(stripeIds);
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

  it("[FIX-W32-PLATFORM AC1] bounds a monitored queue's number to 0–99, as the OTA document's queue reads and the OTA poller do", () => {
    const bounds = (document: Json, schema: unknown) => {
      const resolved = resolve(document, schema);
      return isObject(resolved)
        ? { type: resolved["type"], minimum: resolved["minimum"], maximum: resolved["maximum"] }
        : {};
    };
    const queue = objectAt(objectAt(objectAt(platform, "components"), "schemas"), "AmadeusMonitoredQueue");
    const properties = objectAt(queue, "properties");
    expect(bounds(platform, properties["queueId"])).toEqual({ type: "integer", minimum: 0, maximum: 99 });
    expect(bounds(platform, properties["category"])).toEqual({ type: "integer", minimum: 0, maximum: 254 });

    // Every `queueId` parameter of the OTA document (the console's two Queue List reads and the snapshot filter) has
    // the same bounds, so every queue the portal can store is one the OTA backend reads (its poller counts any other
    // as invalid: parseMonitoredQueues of ota/backend's platform-read.repository.ts).
    const otaQueueIds: string[] = [];
    for (const item of Object.values(objectAt(ota, "paths"))) {
      for (const method of HTTP_METHODS) {
        const parameters = objectAt(item, method)["parameters"];
        for (const parameter of Array.isArray(parameters) ? parameters : []) {
          const resolved = resolve(ota, parameter);
          if (isObject(resolved) && resolved["name"] === "queueId") {
            otaQueueIds.push(JSON.stringify(bounds(ota, resolved["schema"])));
          }
        }
      }
    }
    expect(otaQueueIds.length).toBeGreaterThanOrEqual(3);
    expect(new Set(otaQueueIds)).toEqual(
      new Set([JSON.stringify({ type: "integer", minimum: 0, maximum: 99 })]),
    );

    // A request body with a number outside the bounds is refused, naming the queue's field.
    const requests = requestBodyChecker(["updateAmadeusConnection"]);
    const check = (queueId: unknown) =>
      requests
        .check("updateAmadeusConnection", {
          status: 200,
          body: { monitoredQueues: [{ officeId: "NCE1A0955", queueId, category: 0 }] },
        })
        .map((problem) => `${problem.path} ${problem.keyword}`);
    expect(check(0)).toEqual([]);
    expect(check(99)).toEqual([]);
    expect(check(100)).toEqual(["/monitoredQueues/0/queueId maximum"]);
    expect(check(999)).toEqual(["/monitoredQueues/0/queueId maximum"]);
    expect(check(-1)).toEqual(["/monitoredQueues/0/queueId minimum"]);

    // The answer shares the schema, so the response checks of the integration tests refuse such a stored queue too.
    const [example] = examplesOf(platform, jsonMedia(successOf("updateAmadeusConnection", "200")) ?? {});
    const answered = (queueId: number) =>
      checker
        .check("updateAmadeusConnection", {
          status: 200,
          body: { ...(example as Json), monitoredQueues: [{ officeId: "NCE1A0955", queueId, category: 0 }] },
        })
        .map((problem) => `${problem.path} ${problem.keyword}`);
    expect(answered(99)).toEqual([]);
    expect(answered(100)).toEqual(["/monitoredQueues/0/queueId maximum"]);
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
    // The outcomes of the inventory: the declined case, another Stripe error or a code Stripe refuses
    // (FIX-W36-PLATFORM), and the mode mismatch name their reason.
    expect(
      errorExamples("completeStripeConnect", "422").map((error) => objectAt(error, "details")["reason"]),
    ).toEqual(["access_denied", "oauth_error", "livemode_mismatch"]);
    // A connection a platform admin disabled is never re-enabled by a callback (FIX-W36-PLATFORM).
    expect(
      errorExamples("completeStripeConnect", "409")
        .filter((error) => error["code"] === "CONFLICT")
        .map((error) => objectAt(error, "details")["reason"]),
    ).toEqual(["connection_disabled"]);
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
    // The response checker reads JSON only, so it refuses the CSV; the list of non-JSON answers is exactly these
    // three, the admin's CSV of the same lines (PBE-042, PADR-0016 item 4) included.
    expect(() => checker.check("downloadSettlementLines", { status: 200, body: media["example"] })).toThrow(
      /no JSON content \(text\/csv\)/,
    );
    expect(NON_JSON_RESPONSES).toEqual({
      adminExportAudit: { "200": ["text/csv"] },
      downloadSettlementLines: { "200": ["text/csv"] },
      adminDownloadSettlementLines: { "200": ["text/csv"] },
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

/** The backticked catalogue codes of an inventory cell, also after a status (`400 WEBHOOK_SIGNATURE_INVALID`). */
function statusCodesOf(cell: string): string[] {
  return [...cell.matchAll(/`(?:[0-9]{3} )?([A-Z][A-Z0-9_]+)`/g)].map(([, code = ""]) => code);
}

/**
 * The rows of api-inventory-admin §8 by operationId: Operation, Method and path, Auth, Purpose, Behaviour, Tables,
 * Errors and M.
 */
function webhookRows(): Map<string, string[]> {
  const text = readFileSync(INVENTORY_ADMIN, "utf8");
  const start = text.indexOf("## 8. ");
  expect(start).toBeGreaterThanOrEqual(0);
  const rows = new Map<string, string[]>();
  for (const line of text.slice(start, text.indexOf("\n## ", start + 1)).split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const id = /^`([a-z][A-Za-z]+)`$/.exec(cells[1] ?? "")?.[1];
    if (id !== undefined) {
      rows.set(id, cells.slice(1, -1));
    }
  }
  return rows;
}

describe("the M5 admin and webhook slice: Stripe billing, office release, settlements, payout accounts, domains and webhooks (PBE-042)", () => {
  const schemaOf = (name: string): Json =>
    objectAt(objectAt(objectAt(platform, "components"), "schemas"), name);
  const propertiesOf = (name: string): Json => objectAt(schemaOf(name), "properties");
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
  const statusesOf = (operationId: string): string[] =>
    responsesOf(platform, operation(operationId)).map(([status]) => status);
  const checkValues = (sql: string, anchor: RegExp): string[] => {
    const list = anchor.exec(sql)?.[1];
    expect([String(anchor), list === undefined]).toEqual([String(anchor), false]);
    return [...(list ?? "").matchAll(/'([^']+)'/g)].map(([, value = ""]) => value);
  };
  const deltas = (): string =>
    readFileSync(join(PLATFORM_MIGRATIONS, "0002_add_mvp_platform_deltas.sql"), "utf8");
  const filterOf = (operationId: string, name: string): Json =>
    objectAt(
      parametersOf(operationId).find((parameter) => parameter["name"] === name),
      "schema",
    );
  const asJson = (value: unknown): Json => (isObject(value) ? value : {});

  let policies: OperationPolicies;
  let otaPatterns: Set<unknown>;

  /**
   * The budget of the slice's setup: the guards' policies read the whole platform document again (PlatformOpenApi,
   * as the API does at start-up), and the OTA document's patterns are collected once; both take a second or two
   * under a full parallel `pnpm test`. The budget only stops a hook that hangs.
   */
  const SLICE_SETUP_TIMEOUT_MS = 30_000;

  beforeAll(() => {
    policies = new OperationPolicies(PlatformOpenApi.load());
    otaPatterns = new Set(schemasOf(ota, objectAt(ota, "components")).map((schema) => schema["pattern"]));
  }, SLICE_SETUP_TIMEOUT_MS);

  it("[PBE-042 AC1] lists the 23 operations of the slice in the operations index, each with x-scope platform_admin or webhook", () => {
    expect(SLICE_PBE042).toHaveLength(23);
    const ids = new Set(SLICE_PBE042.map((entry) => entry.operationId));
    expect(ids.size).toBe(23);
    // 23 more operations: none of them belongs to an earlier slice.
    expect(
      [...SLICE, ...SLICE_PBE006, ...SLICE_PBE007, ...SLICE_PBE066, ...SLICE_PBE037, ...SLICE_PBE041].filter(
        (entry) => ids.has(entry.operationId),
      ),
    ).toEqual([]);
    for (const entry of SLICE_PBE042) {
      expect(platformOperations).toContainEqual(expect.objectContaining({ ...entry, sdkMethod: null }));
      const spec = operation(entry.operationId).spec;
      expect([entry.operationId, spec["x-scope"], spec["x-internal"], spec["security"]]).toEqual([
        entry.operationId,
        entry.scope,
        entry.internal ? true : undefined,
        entry.scope === "webhook" ? [] : [{ adminBearer: [] }],
      ]);
    }
    // With PBE-007 and PBE-066, the 68 admin operations, every one under /v1/admin/.
    const admin = new Set(
      [
        ...SLICE_PBE007,
        ...SLICE_PBE066,
        ...SLICE_PBE042.filter((entry) => entry.scope === "platform_admin"),
      ].map((entry) => entry.operationId),
    );
    expect(admin.size).toBe(68);
    for (const operationId of admin) {
      expect([operationId, operation(operationId).path.startsWith("/v1/admin/")]).toEqual([
        operationId,
        true,
      ]);
    }
    // The two receivers are the document's only webhook operations, under the prefix where the API keeps the raw
    // body for the signature check (raw-body.ts).
    const webhooks = operations.filter((op) => op.spec["x-scope"] === "webhook");
    expect(webhooks.map((op) => op.operationId)).toEqual([
      "receiveStripeBillingEvent",
      "receiveStripeConnectAccountEvent",
    ]);
    for (const op of webhooks) {
      expect([op.operationId, op.path.startsWith(`${WEBHOOK_PATH_PREFIX}stripe/`)]).toEqual([
        op.operationId,
        true,
      ]);
    }
  });

  it("[PBE-042 AC1] documents each slice operation with the method, path, query, marks and errors of the M5 rows of api-inventory-admin §4–§8", () => {
    const rows = adminSectionRows(["## 4. ", "## 5. ", "## 6. ", "## 7. "]);
    const webhooks = webhookRows();
    // The slice is exactly the M5 rows of §4 to §7 and the two receivers of §8.
    const m5 = [...rows]
      .filter(([, row]) => row.milestone.startsWith("M5"))
      .map(([operationId]) => operationId);
    expect([...m5, ...webhooks.keys()].sort()).toEqual(SLICE_PBE042.map((entry) => entry.operationId).sort());

    for (const entry of SLICE_PBE042) {
      const { operationId } = entry;
      const spec = operation(operationId).spec;
      const row = rows.get(operationId);
      if (row === undefined) {
        const [, route = "", auth = "", , , tables = "", errors = ""] = webhooks.get(operationId) ?? [];
        const [method = "", path = ""] = route.replaceAll("`", "").split(" ");
        expect([operationId, entry.method, entry.path, auth.startsWith("`webhook`")]).toEqual([
          operationId,
          method.toLowerCase(),
          path,
          true,
        ]);
        expect([operationId, spec["x-error-codes"]]).toEqual([
          operationId,
          expect.arrayContaining(statusCodesOf(errors)),
        ]);
        expect([operationId, spec["x-platform-tables"]]).toEqual([
          operationId,
          [...tables.matchAll(/`([a-z_]+)`/g)].map(([, table = ""]) => table),
        ]);
      } else {
        expect([operationId, entry.method, entry.path]).toEqual([operationId, row.method, row.path]);
        const query = parametersOf(operationId)
          .filter((parameter) => parameter["in"] === "query")
          .map((parameter) => parameter["name"]);
        expect([operationId, query]).toEqual([operationId, expect.arrayContaining([...row.query])]);
        expect([
          operationId,
          spec["x-reason-required"] === true,
          spec["x-mfa-step-up"] === true,
          row.conditionalStepUp,
        ]).toEqual([operationId, row.reason, row.stepUp, false]);
        // Every code of the inventory's Errors cell is answered; the operation answers the generic codes too.
        expect([operationId, spec["x-error-codes"]]).toEqual([
          operationId,
          expect.arrayContaining(codesOf(row.errors)),
        ]);
      }
      // No milestone switch (the admin rows have no `F:`, and PADR-0015 item 4 receives webhooks with the switches
      // off) and no idempotency.
      expect([operationId, spec["x-feature"], spec["x-idempotent"]]).toEqual([
        operationId,
        undefined,
        undefined,
      ]);
    }
    // adminUpdatePlan, an M1 row with its M5 Stripe ids, answers the codes of its row, the M5 ones included.
    const updatePlan = rows.get("adminUpdatePlan");
    expect(updatePlan?.milestone).toBe("M1 (Stripe ids M5)");
    expect(codesOf(updatePlan?.errors ?? "")).toEqual(expect.arrayContaining(["CONFLICT", "PROVIDER_ERROR"]));
    expect(operation("adminUpdatePlan").spec["x-error-codes"]).toEqual(
      expect.arrayContaining(codesOf(updatePlan?.errors ?? "")),
    );
  });

  it("[PBE-042 AC1] requires the reasons and step-ups of the inventory, as the guards read them", () => {
    for (const { operationId, scope } of SLICE_PBE042) {
      const spec = operation(operationId).spec;
      const stepUp = (SLICE_PBE042_STEP_UP as readonly string[]).includes(operationId);
      const reason = (SLICE_PBE042_REASON as readonly string[]).includes(operationId);
      expect([operationId, spec["x-mfa-step-up"] === true, spec["x-reason-required"] === true]).toEqual([
        operationId,
        stepUp,
        reason,
      ]);
      // RecentMfaGuard and FeatureGuard read these flags from the document (PBE-012).
      expect([operationId, policies.forOperation(operationId)]).toEqual([
        operationId,
        { scope, mfaStepUp: stepUp, features: [] },
      ]);
    }
    // A step-up answers 401 REAUTH_REQUIRED; never 403 MFA_REQUIRED, since every platform admin has MFA (PADR-0006).
    for (const operationId of SLICE_PBE042_STEP_UP) {
      expect([operationId, errorExamples(operationId, "401").map((error) => error["code"])]).toEqual([
        operationId,
        ["UNAUTHENTICATED", "TOKEN_EXPIRED", "REAUTH_REQUIRED"],
      ]);
      expect([operationId, operation(operationId).spec["x-error-codes"]]).toEqual([
        operationId,
        expect.not.arrayContaining(["MFA_REQUIRED"]),
      ]);
    }

    // A reason of 5–500 characters, in a required body.
    const bodies: Record<(typeof SLICE_PBE042_REASON)[number], Json> = {
      adminReleaseAmadeusOffice: { confirmNoOpenBookings: true },
      adminAddSettlementAdjustment: {
        amount: { amount: "-25.00", currency: "EUR" },
        description: "Fee correction",
      },
      adminVoidSettlement: {},
      adminRevealPayoutAccount: {},
      adminRemoveDomain: {},
    };
    const requests = requestBodyChecker(SLICE_PBE042_REASON);
    for (const operationId of SLICE_PBE042_REASON) {
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
        [expect.objectContaining({ path: "/reason", keyword: "required" })],
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
  });

  it("links a plan to its Stripe prices in adminUpdatePlan and compares them in adminCheckPlanPrices", () => {
    // The three ids of AdminPlan, each nullable to unlink, with the patterns of AdminPlan and the plans CHECKs.
    const update = propertiesOf("UpdatePlanRequest");
    const plan = propertiesOf("AdminPlan");
    const sql = deltas();
    for (const [name, column] of [
      ["stripeProductId", "stripe_product_id"],
      ["stripePriceIdMonth", "stripe_price_id_month"],
      ["stripePriceIdYear", "stripe_price_id_year"],
    ] as const) {
      const property = objectAt(update, name);
      const constraint = new RegExp(`${column}\\s+text CHECK \\(${column} ~ '([^']+)'\\)`, "u").exec(
        sql,
      )?.[1];
      expect([name, property["type"], property["pattern"], property["pattern"]]).toEqual([
        name,
        ["string", "null"],
        objectAt(plan, name)["pattern"],
        constraint,
      ]);
    }
    const requests = requestBodyChecker(["adminUpdatePlan"]);
    const check = (body: unknown) =>
      requests
        .check("adminUpdatePlan", { status: 200, body })
        .map((problem) => `${problem.path} ${problem.keyword}`);
    const examples = requestExamples("adminUpdatePlan");
    expect(examples).toContainEqual(expect.objectContaining({ stripePriceIdMonth: expect.any(String) }));
    for (const example of examples) {
      expect(check(example)).toEqual([]);
    }
    expect(check({ stripePriceIdMonth: null })).toEqual([]);
    expect(check({ stripePriceIdMonth: "prod_QxGrowth01" })).toEqual(
      expect.arrayContaining(["/stripePriceIdMonth pattern"]),
    );
    expect(check({ stripeProductId: "price_1QxGrowthMonthEur" })).toEqual(
      expect.arrayContaining(["/stripeProductId pattern"]),
    );
    // A price that another plan links conflicts (unique indexes of migration 0002); a Stripe failure saves nothing.
    expect(sql).toContain("CREATE UNIQUE INDEX plans_stripe_price_month_uq");
    expect(
      errorExamples("adminUpdatePlan", "409").map((error) => objectAt(error, "details")["reason"]),
    ).toEqual(["stripe_price_taken"]);
    for (const operationId of ["adminUpdatePlan", "adminCheckPlanPrices"]) {
      expect([operationId, objectAt(operation(operationId).spec, "responses")["502"]]).toEqual([
        operationId,
        { $ref: "#/components/responses/ProviderError" },
      ]);
    }
    // The linked plan answers the warnings of its comparison; it can start Checkout for both intervals.
    expect(examplesAt("adminUpdatePlan", "200")).toContainEqual(
      expect.objectContaining({
        stripePriceIdMonth: expect.any(String),
        checkoutAvailable: { month: true, year: true },
        priceWarnings: [expect.objectContaining({ field: "stripePriceIdMonth.currency" })],
      }),
    );

    // adminCheckPlanPrices takes no body and answers the inventory's {field, expected, actual}, the items of
    // priceWarnings, each naming a linked price and one of the four attributes the flow compares.
    expect(operation("adminCheckPlanPrices").spec["requestBody"]).toBeUndefined();
    const exchange = adminSectionRows().get("adminCheckPlanPrices")?.exchange ?? "";
    expect(Object.keys(propertiesOf("PlanPriceWarning"))).toEqual(
      inventoryFieldLists(exchange, "{warnings: [")[0],
    );
    expect(objectAt(propertiesOf("PlanPriceCheck"), "warnings")["items"]).toEqual(
      objectAt(plan, "priceWarnings")["items"],
    );
    const checks = examplesAt("adminCheckPlanPrices", "200");
    expect(checks).toContainEqual({ warnings: [] });
    const warnings = [...checks, ...examplesAt("adminUpdatePlan", "200")].flatMap((example) => {
      const list: unknown = asJson(example)["warnings"] ?? asJson(example)["priceWarnings"];
      return Array.isArray(list) ? (list as unknown[]) : [];
    });
    expect(warnings.length).toBeGreaterThan(1);
    for (const warning of warnings) {
      expect(String(asJson(warning)["field"])).toMatch(
        /^stripePriceId(Month|Year)\.(amount|currency|interval|active)$/u,
      );
    }
  });

  it("resyncs a Stripe subscription, lists the invoices and the Stripe inbox, and reprocesses a failed event", () => {
    // Resync: the subscription with its new version; a manual one has nothing to fetch; Stripe may fail.
    const resynced = successOf("adminResyncSubscription", "200");
    expect([jsonMedia(resynced)?.["schema"], objectAt(resynced, "headers")["ETag"]]).toEqual([
      { $ref: "#/components/schemas/AdminSubscription" },
      { $ref: "#/components/headers/ETag" },
    ]);
    expect(
      errorExamples("adminResyncSubscription", "409").map((error) => objectAt(error, "details")["reason"]),
    ).toEqual(["manual"]);
    expect(statusesOf("adminResyncSubscription")).toContain("502");

    // The two lists answer the items of adminGetSubscription, filtered as the inventory says.
    const items = (name: string): unknown => objectAt(propertiesOf(name)["data"], "items");
    expect([items("AdminInvoiceList"), items("AdminStripeEventList")]).toEqual([
      { $ref: "#/components/schemas/AdminInvoice" },
      { $ref: "#/components/schemas/AdminStripeEvent" },
    ]);
    const invoice = propertiesOf("AdminInvoice");
    const event = propertiesOf("AdminStripeEvent");
    expect(filterOf("adminListInvoices", "status")["enum"]).toEqual(objectAt(invoice, "status")["enum"]);
    expect(filterOf("adminListInvoices", "tenantId")).toEqual({ $ref: "#/components/schemas/TenantId" });
    expect(filterOf("adminListStripeEvents", "status")["enum"]).toEqual(objectAt(event, "status")["enum"]);
    expect(filterOf("adminListStripeEvents", "type")["pattern"]).toBe(objectAt(event, "type")["pattern"]);
    expect(schemaOf("StripeEventType")["pattern"]).toBe(objectAt(event, "type")["pattern"]);
    const exchange = adminSectionRows().get("adminListStripeEvents")?.exchange ?? "";
    expect(Object.keys(event)).toEqual(inventoryFieldLists(exchange, "{data: [")[0]);

    // Event ids: Stripe's, and the synthetic ones of the X-028 fixtures, as the CHECK of stripe_events.id allows; the
    // inbox list, the reprocess path and the receivers share the schema.
    expect(deltas()).toMatch(
      /CREATE TABLE platform\.stripe_events \(\s*id\s+text PRIMARY KEY CHECK \(id LIKE 'evt\\_%'\)/u,
    );
    const eventId = new RegExp(String(schemaOf("StripeEventId")["pattern"]), "u");
    for (const type of STRIPE_FIXTURE_EVENT_TYPES) {
      const { id } = stripeFixture(type);
      expect([id, eventId.test(id)]).toEqual([id, true]);
    }
    for (const [id, valid] of [
      ["evt_1QyMn3Oq0Su5WxZ7Ab9Cd1Ef", true],
      ["evt_", false],
      ["in_1QyMn3Oq0Su5Wx", false],
      ["evt_1Qy-Mn3", false],
    ] as const) {
      expect([id, eventId.test(id)]).toEqual([id, valid]);
    }
    const reference = { $ref: "#/components/schemas/StripeEventId" };
    expect([
      event["id"],
      objectAt(resolve(platform, { $ref: "#/components/parameters/StripeEventId" }), "schema"),
      propertiesOf("StripeEvent")["id"],
      propertiesOf("StripeConnectAccountEvent")["id"],
    ]).toEqual([reference, reference, reference, reference]);

    // Reprocess: 202 without a body; an event that is not failed or ignored conflicts with its status as the reason.
    expect(operation("adminReprocessStripeEvent").spec["requestBody"]).toBeUndefined();
    expect(objectAt(successOf("adminReprocessStripeEvent", "202"), "content")).toEqual({});
    expect(
      errorExamples("adminReprocessStripeEvent", "409").map((error) => objectAt(error, "details")["reason"]),
    ).toEqual(["processing"]);
    const description = String(operation("adminReprocessStripeEvent").spec["description"]);
    for (const status of ["failed", "ignored", "received", "processing", "processed"]) {
      expect([status, description.includes(`\`${status}\``)]).toEqual([status, true]);
    }
    // BullMQ keeps a failed job 30 days and a completed one 1 day (ADR-0009 item 7, queue-names.ts) and ignores a
    // job id it holds: queuing the event again under its id needs that job removed, or the sweep counting it missing.
    expect([KEEP_FAILED_JOBS, KEEP_COMPLETED_JOBS]).toEqual([{ age: 30 * 86_400 }, { age: 86_400 }]);
    expect(description).toContain("ignores a new job with an id it still holds");
    expect(description).toContain("a job that BullMQ holds as failed or completed counts as missing");
  });

  it("releases an office to the pool only with the confirmation of no open bookings and a reason", () => {
    const requests = requestBodyChecker(["adminReleaseAmadeusOffice"]);
    const check = (body: unknown) =>
      requests
        .check("adminReleaseAmadeusOffice", { status: 200, body })
        .map((problem) => `${problem.path} ${problem.keyword}`);
    for (const example of requestExamples("adminReleaseAmadeusOffice")) {
      expect(check(example)).toEqual([]);
    }
    const reason = "Acme confirmed that no booking with future travel remains.";
    expect(check({ confirmNoOpenBookings: true, reason })).toEqual([]);
    expect(check({ confirmNoOpenBookings: false, reason })).toEqual(["/confirmNoOpenBookings const"]);
    expect(check({ reason })).toEqual(["/confirmNoOpenBookings required"]);
    // The inventory's request, and an office that is available again, with no OTA.
    const exchange = adminSectionRows().get("adminReleaseAmadeusOffice")?.exchange ?? "";
    expect(Object.keys(propertiesOf("ReleaseAmadeusOfficeRequest"))).toEqual(
      inventoryFieldLists(exchange)[0],
    );
    expect(examplesAt("adminReleaseAmadeusOffice", "200")).toEqual([
      expect.objectContaining({ status: "available", assignedTenant: null, releasedAt: expect.any(String) }),
    ]);
    // An office that backs an active connection stays assigned; one that is not assigned has nothing to release.
    expect(
      errorExamples("adminReleaseAmadeusOffice", "409").map((error) => objectAt(error, "details")["reason"]),
    ).toEqual(["connection_active"]);
    // The statuses it releases (PADR-0012 items 1 and 8), and both conflict reasons.
    const description = String(operation("adminReleaseAmadeusOffice").spec["description"]);
    for (const name of [
      "`releasing`",
      "`assigned`",
      "`details.reason = connection_active`",
      "`details.reason = not_assigned`",
    ]) {
      expect([name, description.includes(name)]).toEqual([name, true]);
    }
  });

  it("[PBE-042 AC1] lists adminDownloadSettlementLines in api-inventory-admin §6 and answers the lines of a statement as CSV", () => {
    // PADR-0016 item 4: one operation per representation, each with its own row of §6.
    const rows = adminSectionRows(["## 6. "]);
    expect(rows.get("adminDownloadSettlementLines")).toMatchObject({
      method: "get",
      path: `${ADMIN_SETTLEMENT_PATH}/lines.csv`,
      milestone: "M5",
    });
    expect(rows.get("adminListSettlementLines")).toMatchObject({
      method: "get",
      path: `${ADMIN_SETTLEMENT_PATH}/lines`,
      query: ["cursor"],
    });
    expect(rows.get("adminListSettlementLines")?.exchange).not.toContain("CSV");

    const ok = successOf("adminDownloadSettlementLines", "200");
    expect(Object.keys(objectAt(ok, "content"))).toEqual(["text/csv"]);
    // Never cached, and downloaded as a file named after the OTA, the month and the currency.
    const headers = objectAt(ok, "headers");
    expect(objectAt(resolve(platform, headers["Cache-Control"]), "schema")["const"]).toBe("no-store");
    const disposition = objectAt(objectAt(headers, "Content-Disposition"), "schema");
    const filenames: unknown = disposition["examples"];
    expect(Array.isArray(filenames) && filenames.length > 0).toBe(true);
    for (const filename of Array.isArray(filenames) ? (filenames as unknown[]) : []) {
      expect(new RegExp(String(disposition["pattern"]), "u").test(String(filename))).toBe(true);
    }
    // The header row is the inventory's column list, which the description names too.
    const columns = (
      /`text\/csv` \(([^)]+)\)/u.exec(rows.get("adminDownloadSettlementLines")?.exchange ?? "")?.[1] ?? ""
    ).split(/,\s*/u);
    expect(columns).toEqual([...ADMIN_SETTLEMENT_CSV_COLUMNS]);
    const description = String(operation("adminDownloadSettlementLines").spec["description"]);
    for (const column of ADMIN_SETTLEMENT_CSV_COLUMNS) {
      expect([column, description.includes(`\`${column}\``)]).toEqual([column, true]);
    }
    const media = objectAt(objectAt(ok, "content"), "text/csv");
    const [header = "", ...lines] = String(media["example"]).trimEnd().split("\n");
    expect(csvCells(header)).toEqual([...ADMIN_SETTLEMENT_CSV_COLUMNS]);

    // Each row is a line of adminListSettlementLines in the statement's currency: the rows of its example, so the
    // two representations agree.
    const [listed] = examplesAt("adminListSettlementLines", "200");
    const listedLines: unknown = asJson(listed)["data"];
    const currency = String(
      asJson(asJson(Array.isArray(listedLines) ? listedLines[0] : {})["amount"])["currency"],
    );
    expect(currency).toBe("EUR");
    expect(lines.length).toBeGreaterThan(0);
    const data = lines.map((line) => {
      const cells = csvCells(line);
      expect([line, cells.length]).toEqual([line, ADMIN_SETTLEMENT_CSV_COLUMNS.length]);
      const cell = Object.fromEntries(
        ADMIN_SETTLEMENT_CSV_COLUMNS.map((column, index) => [
          column,
          cells[index] === "" ? null : cells[index],
        ]),
      );
      const { amount, stripeFee, originalAmount, originalCurrency, ...rest } = cell;
      return {
        ...rest,
        amount: { amount, currency },
        stripeFee: { amount: stripeFee, currency },
        originalAmount:
          originalAmount === null ? null : { amount: originalAmount, currency: originalCurrency },
      };
    });
    expect(data).toEqual(listedLines);
    const page = { nextCursor: null, limit: 50 };
    expect(checker.check("adminListSettlementLines", { status: 200, body: { data, page } })).toEqual([]);
    // Signed amounts as they are; no text cell that a spreadsheet would run as a formula.
    expect(description).toContain(
      "a text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`",
    );
    const amountColumns = new Set(["amount", "stripeFee", "originalAmount"]);
    for (const line of lines) {
      csvCells(line).forEach((cell, index) => {
        const column = ADMIN_SETTLEMENT_CSV_COLUMNS[index] ?? "";
        expect([
          column,
          cell,
          amountColumns.has(column) ? /^(-?[0-9]+\.[0-9]{2})?$/u.test(cell) : !/^[=+\-@\t\r]/u.test(cell),
        ]).toEqual([column, cell, true]);
      });
    }
    // The response checker reads JSON only, so it refuses the CSV; NON_JSON_RESPONSES names this answer.
    expect(() =>
      checker.check("adminDownloadSettlementLines", { status: 200, body: media["example"] }),
    ).toThrow(/no JSON content \(text\/csv\)/);
    expect(NON_JSON_RESPONSES["adminDownloadSettlementLines"]).toEqual({ "200": ["text/csv"] });
  });

  it("follows PADR-0003 and migration 0002 for the statuses, totals, lines and transitions of a statement", () => {
    const sql = deltas();
    const settlements = /CREATE TABLE platform\.settlements \(([\s\S]*?)\n\);/u.exec(sql)?.[1] ?? "";
    expect(schemaOf("AdminSettlementStatus")["enum"]).toEqual(
      checkValues(settlements, /CHECK \(status IN \(([^)]*)\)\)/u),
    );
    expect(schemaOf("SettlementLineType")["enum"]).toEqual(
      checkValues(sql, /CHECK \(line_type IN \(([^)]*)\)\)/u),
    );

    // The admin shapes share the portal's (annotations apart): the summary's properties but `status`, which has
    // every value here, and the statement's totals. The statement extends the summary with the same schemas.
    const summary = propertiesOf("AdminSettlementSummary");
    const statement = propertiesOf("AdminSettlement");
    for (const [portal, admin] of [
      ["SettlementSummary", summary],
      ["Settlement", statement],
    ] as const) {
      for (const [name, schema] of Object.entries(propertiesOf(portal))) {
        if (name !== "status") {
          expect([portal, name, shape(admin[name])]).toEqual([portal, name, shape(schema)]);
        }
      }
    }
    expect(Object.keys(statement).slice(0, Object.keys(summary).length)).toEqual(Object.keys(summary));
    for (const name of Object.keys(summary)) {
      expect([name, statement[name]]).toEqual([name, summary[name]]);
    }
    for (const name of ["AdminSettlementSummary", "AdminSettlement", "AdminSettlementLine"]) {
      expect([name, schemaOf(name)["required"]]).toEqual([name, Object.keys(propertiesOf(name))]);
    }

    // Every statement example keeps the formula of PADR-0003 item 5, its Velexis fee and the CHECKs of its status.
    const examples = [
      ...examplesAt("adminGetSettlement", "200"),
      ...examplesAt("adminAddSettlementAdjustment", "200"),
      ...examplesAt("adminApproveSettlement", "200"),
      ...examplesAt("adminMarkSettlementPaid", "200"),
      ...examplesAt("adminVoidSettlement", "200"),
    ].map(asJson);
    expect(examples.map((example) => example["status"]).sort()).toEqual([
      "approved",
      "carried_forward",
      "draft",
      "draft",
      "paid",
      "void",
    ]);
    for (const example of examples) {
      const value = (name: string): bigint => cents(example[name]);
      const net = value("netAmount");
      expect([example["id"], net]).toEqual([
        example["id"],
        value("grossAmount") -
          value("refundsAmount") -
          value("disputesAmount") -
          value("stripeFeesAmount") -
          value("velexisFeesAmount") +
          value("adjustmentsAmount"),
      ]);
      expect(value("velexisFeesAmount") * 10_000n).toBe(
        BigInt(Number(example["feeBps"])) * (value("grossAmount") - value("refundsAmount")),
      );
      // settlements_paid_ck, settlements_carry_ck and settlements_void_ck, and the transitions of item 9.
      const states: Readonly<Record<string, Json>> = {
        draft: { approvedAt: null, paidAt: null, voidedAt: null, voidReason: null },
        approved: { approvedAt: expect.any(String), paidAt: null },
        paid: {
          approvedAt: expect.any(String),
          paidAt: expect.any(String),
          payoutReference: expect.any(String),
        },
        carried_forward: { approvedAt: expect.any(String), paidAt: null },
        void: {
          approvedAt: null,
          voidedAt: expect.any(String),
          voidReason: expect.any(String),
          lineCount: 0,
        },
      };
      const status = String(example["status"]);
      expect([example["id"], example]).toEqual([example["id"], expect.objectContaining(states[status])]);
      if (status === "approved" || status === "paid") {
        expect([example["id"], net > 0n]).toEqual([example["id"], true]);
      }
      if (status === "carried_forward") {
        expect([example["id"], net <= 0n]).toEqual([example["id"], true]);
      }
    }

    // Approving and paying need If-Match, a step-up and a verified payout account for a positive net (PADR-0003 item
    // 9); every action on a statement in the wrong status answers SETTLEMENT_STATE_INVALID.
    for (const operationId of ["adminApproveSettlement", "adminMarkSettlementPaid"]) {
      expect([operationId, parametersOf(operationId).map((parameter) => parameter["name"])]).toEqual([
        operationId,
        ["If-Match"],
      ]);
      expect([operationId, statusesOf(operationId)]).toEqual([
        operationId,
        expect.arrayContaining(["200", "401", "409", "412", "422"]),
      ]);
      expect([operationId, errorExamples(operationId, "422").map((error) => error["code"])]).toEqual([
        operationId,
        ["PAYOUT_ACCOUNT_REQUIRED"],
      ]);
    }
    for (const operationId of [
      "adminGetSettlement",
      "adminAddSettlementAdjustment",
      "adminApproveSettlement",
      "adminMarkSettlementPaid",
      "adminVoidSettlement",
    ]) {
      const ok = successOf(operationId, "200");
      expect([operationId, objectAt(ok, "headers")["ETag"], jsonMedia(ok)?.["schema"]]).toEqual([
        operationId,
        { $ref: "#/components/headers/ETag" },
        { $ref: "#/components/schemas/AdminSettlement" },
      ]);
      if (operationId !== "adminGetSettlement") {
        expect([operationId, errorExamples(operationId, "409").map((error) => error["code"])]).toEqual([
          operationId,
          ["SETTLEMENT_STATE_INVALID"],
        ]);
      }
    }

    // Adjustments are signed, never zero, with two decimals at most; a period is the first instant of a month.
    const requests = requestBodyChecker(["adminAddSettlementAdjustment", "adminGenerateSettlements"]);
    const adjustment = (amount: string) =>
      requests
        .check("adminAddSettlementAdjustment", {
          status: 200,
          body: {
            amount: { amount, currency: "EUR" },
            description: "Correction",
            reason: "Agreed with the OTA",
          },
        })
        .map((problem) => `${problem.path} ${problem.keyword}`);
    for (const amount of ["-25.00", "100", "0.01", "-0.5"]) {
      expect([amount, adjustment(amount)]).toEqual([amount, []]);
    }
    for (const amount of ["0", "0.00", "-0.0", "1.001", "12345678901", "1e3"]) {
      expect([amount, adjustment(amount)]).toEqual([amount, ["/amount/amount pattern"]]);
    }
    const generate = (periodStart: string) =>
      requests.check("adminGenerateSettlements", { status: 200, body: { periodStart } }).length;
    expect(generate("2027-02-01T00:00:00Z")).toBe(0);
    for (const periodStart of [
      "2027-02-02T00:00:00Z",
      "2027-13-01T00:00:00Z",
      "2027-02-01T05:00:00Z",
      "2027-02",
    ]) {
      expect([periodStart, generate(periodStart) > 0]).toEqual([periodStart, true]);
    }
    expect(filterOf("adminListSettlements", "periodStart")).toEqual({
      $ref: "#/components/schemas/SettlementPeriodStart",
    });
    // A month that has not ended is the service's 400, with its field error; the job is the whole effect.
    expect(errorExamples("adminGenerateSettlements", "400")[0]?.["fieldErrors"]).toEqual([
      expect.objectContaining({ path: "/periodStart", code: "period_not_closed" }),
    ]);
    expect(objectAt(successOf("adminGenerateSettlements", "202"), "content")).toEqual({});
    expect(statusesOf("adminGenerateSettlements")).toContain("503");

    // The OTA's payment and checkout ids on a line follow the OTA booking API's patterns.
    const line = propertiesOf("AdminSettlementLine");
    for (const name of ["velexisPaymentId", "checkoutId"]) {
      expect([name, otaPatterns.has(objectAt(line, name)["pattern"])]).toEqual([name, true]);
    }
  });

  it("[PBE-042 AC1] reveals bank details only with a reason, a step-up and no-store, and reviews a payout account with a note", () => {
    // The masked account is the portal's.
    for (const operationId of ["adminGetPayoutAccount", "adminReviewPayoutAccount"]) {
      const ok = successOf(operationId, "200");
      expect([operationId, jsonMedia(ok)?.["schema"], objectAt(ok, "headers")["ETag"]]).toEqual([
        operationId,
        jsonMedia(successOf("getPayoutAccount", "200"))?.["schema"],
        { $ref: "#/components/headers/ETag" },
      ]);
    }

    // The reveal: no-store, the IBAN (and BIC) or the local numbers, and never a write-only schema of the request.
    const reveal = successOf("adminRevealPayoutAccount", "200");
    expect(objectAt(reveal, "headers")["Cache-Control"]).toEqual({ $ref: "#/components/headers/NoStore" });
    const revealed = jsonMedia(reveal)?.["schema"];
    expect(schemasOf(platform, revealed).filter((schema) => schema["writeOnly"] === true)).toEqual([]);
    expect([...propertyNames(platform, revealed)].sort()).toEqual([...BANK_FIELDS].sort());
    const [, revealedFields = []] = inventoryFieldLists(
      adminSectionRows(["## 6. "]).get("adminRevealPayoutAccount")?.exchange ?? "",
    );
    expect([...revealedFields].sort()).toEqual([...BANK_FIELDS].sort());
    for (const example of examplesAt("adminRevealPayoutAccount", "200")) {
      expect(checker.check("adminRevealPayoutAccount", { status: 200, body: example })).toEqual([]);
    }
    for (const body of [
      { iban: "NO9386011117947", accountNumber: "000123456789", routingNumber: "110000000" },
      { iban: "NO93 8601 1117 947" },
      { bic: "DNBANOKK" },
      {},
    ]) {
      expect([body, checker.check("adminRevealPayoutAccount", { status: 200, body }).length > 0]).toEqual([
        body,
        true,
      ]);
    }
    // Only the reveal answers bank identifiers, in the whole document; a sensitive read, audited, never replayed.
    const answering = operations
      .filter((op) =>
        responsesOf(platform, op).some(([, response]) =>
          [...propertyNames(platform, jsonMedia(response)?.["schema"])].some((name) => BANK_FIELDS.has(name)),
        ),
      )
      .map((op) => op.operationId);
    expect(answering).toEqual(["adminRevealPayoutAccount"]);
    const spec = operation("adminRevealPayoutAccount").spec;
    expect([spec["x-idempotent"], spec["x-platform-tables"]]).toEqual([
      undefined,
      ["tenant_payout_accounts", "platform_audit_log"],
    ]);

    // The review: `verified` alone, or `rejected` with the note the owner sees.
    const requests = requestBodyChecker(["adminReviewPayoutAccount"]);
    const review = (body: unknown) =>
      requests.check("adminReviewPayoutAccount", { status: 200, body }).length;
    for (const example of requestExamples("adminReviewPayoutAccount")) {
      expect(review(example)).toBe(0);
    }
    expect(review({ decision: "verified" })).toBe(0);
    expect(review({ decision: "rejected", note: "The holder name differs from the legal name." })).toBe(0);
    for (const body of [
      { decision: "rejected" },
      { decision: "verified", note: "Checked by phone" },
      { decision: "approved" },
      { decision: "rejected", note: "" },
    ]) {
      expect([body, review(body) > 0]).toEqual([body, true]);
    }
    expect(parametersOf("adminReviewPayoutAccount").map((parameter) => parameter["name"])).toEqual([
      "If-Match",
    ]);
    expect(statusesOf("adminReviewPayoutAccount")).toContain("412");
  });

  it("lists every storefront host with the portal's domain schemas, re-checks one and removes only custom domains", () => {
    const domain = propertiesOf("Domain");
    const admin = propertiesOf("AdminDomain");
    // The properties of the portal's Domain but its DNS records, with the same schemas, and the admin's own.
    const shared = Object.keys(admin).filter((name) => name in domain);
    expect(shared).toEqual(Object.keys(domain).filter((name) => name !== "dnsRecords"));
    for (const name of shared) {
      expect([name, admin[name]]).toEqual([name, domain[name]]);
    }
    expect(Object.keys(admin).filter((name) => !(name in domain))).toEqual([
      "tenantId",
      "tenantKey",
      "verifiedAt",
      "checkFailures",
      "tlsCheckedAt",
    ]);
    // The filters take the values of the portal's Domain, which are the CHECKs of tenant_domains.
    const baseline = readFileSync(join(PLATFORM_MIGRATIONS, "0001_baseline.sql"), "utf8");
    const table = /CREATE TABLE platform\.tenant_domains \(([\s\S]*?)\n\);/u.exec(baseline)?.[1] ?? "";
    for (const [name, column] of [
      ["kind", "kind"],
      ["verificationStatus", "verification_status"],
      ["tlsStatus", "tls_status"],
    ] as const) {
      const values = filterOf("adminListDomains", name)["enum"];
      expect([name, values, values]).toEqual([
        name,
        objectAt(domain, name)["enum"],
        checkValues(table, new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`, "u")),
      ]);
    }
    // Re-check: 202 without a body, 503 without Redis. Removal: 204, for any OTA status, never the sub-domain.
    expect(objectAt(successOf("adminRecheckDomain", "202"), "content")).toEqual({});
    expect(objectAt(operation("adminRecheckDomain").spec, "responses")["503"]).toEqual({
      $ref: "#/components/responses/ServiceUnavailable",
    });
    expect(objectAt(successOf("adminRemoveDomain", "204"), "content")).toEqual({});
    expect(
      errorExamples("adminRemoveDomain", "409").map((error) => objectAt(error, "details")["reason"]),
    ).toEqual(["subdomain"]);
    expect(operation("adminRemoveDomain").spec["x-error-codes"]).not.toContain("TENANT_NOT_ACTIVE");
    expect(operation("adminRemoveDomain").spec["x-platform-tables"]).toEqual(
      expect.arrayContaining(["tenant_domains", "email_outbox", "platform_audit_log"]),
    );
  });

  it("[PBE-042 AC1] receives Stripe events with Stripe-Signature, open to what Stripe adds, and takes every X-028 fixture of its endpoint", () => {
    const rows = webhookRows();
    const requests = requestBodyChecker(Object.keys(WEBHOOK_FIXTURES));
    for (const [operationId, fixtures] of Object.entries(WEBHOOK_FIXTURES)) {
      const spec = operation(operationId).spec;
      // The signature header @velexis/testing signs with; no bearer, no rate limit, no switch.
      expect([operationId, parametersOf(operationId)]).toEqual([
        operationId,
        [expect.objectContaining({ name: STRIPE_SIGNATURE_HEADER, in: "header", required: true })],
      ]);
      expect([operationId, statusesOf(operationId), spec["x-error-codes"]]).toEqual([
        operationId,
        ["200", "400", "500"],
        ["VALIDATION_FAILED", "WEBHOOK_SIGNATURE_INVALID", "INTERNAL_ERROR"],
      ]);
      // The answer Stripe waits for, and the two refusals: a bad signature, and an event of the other mode.
      expect([
        operationId,
        jsonMedia(successOf(operationId, "200"))?.["schema"],
        examplesAt(operationId, "200"),
      ]).toEqual([operationId, { $ref: "#/components/schemas/StripeEventReceived" }, [{ received: true }]]);
      expect(checker.check(operationId, { status: 200, body: { received: false } }).length).toBeGreaterThan(
        0,
      );
      const refused = errorExamples(operationId, "400");
      expect([operationId, refused.map((error) => error["code"]), refused[0]?.["fieldErrors"]]).toEqual([
        operationId,
        ["VALIDATION_FAILED", "WEBHOOK_SIGNATURE_INVALID"],
        [expect.objectContaining({ path: "/livemode", code: "livemode_mismatch" })],
      ]);
      // Every fixture of the endpoint, and every example, is a valid body: the receivers store them (PBE-043,
      // PBE-056), and the operation and the inventory row name their types.
      const description = String(spec["description"]);
      const [, , , , behaviour = ""] = rows.get(operationId) ?? [];
      for (const type of fixtures) {
        expect(STRIPE_FIXTURE_EVENT_TYPES).toContain(type);
        expect([
          operationId,
          type,
          requests.check(operationId, { status: 200, body: stripeFixture(type) }),
        ]).toEqual([operationId, type, []]);
        expect([operationId, type, description.includes(`\`${type}\``)]).toEqual([operationId, type, true]);
      }
      // The examples are rendered in the API version of the pinned `stripe` package, as the fixtures are.
      const apiVersion = stripeFixture(fixtures[0]).api_version;
      for (const example of requestExamples(operationId)) {
        expect([operationId, requests.check(operationId, { status: 200, body: example })]).toEqual([
          operationId,
          [],
        ]);
        expect([operationId, asJson(example)["api_version"]]).toEqual([operationId, apiVersion]);
      }
      expect([operationId, behaviour]).toEqual([operationId, expect.stringContaining(`\`${fixtures[0]}\``)]);
    }

    // The inbox endpoints of migration 0002, which the descriptions use.
    expect(checkValues(deltas(), /CHECK \(endpoint IN \(([^)]*)\)\)/u)).toEqual([
      "billing",
      "connect_accounts",
    ]);
    expect(String(operation("receiveStripeBillingEvent").spec["description"])).toContain("endpoint: billing");
    expect(String(operation("receiveStripeConnectAccountEvent").spec["description"])).toContain(
      "`endpoint: connect_accounts`",
    );
    // The raw body is kept on /webhooks/* only, up to the limit the description names.
    expect(WEBHOOK_BODY_LIMIT).toBe("1mb");
    expect(String(operation("receiveStripeBillingEvent").spec["description"])).toContain("up to 1 MB");

    // The Connect receiver needs the connected account; both refuse what is not a Stripe event of their shape.
    const { account, ...withoutAccount } = stripeFixture("account.application.deauthorized");
    expect(account).toBe("acct_test_alpha");
    expect(requests.check("receiveStripeConnectAccountEvent", { status: 200, body: withoutAccount })).toEqual(
      [expect.objectContaining({ path: "/account", keyword: "required" })],
    );
    const event = stripeFixture("invoice.paid");
    const { data, ...withoutData } = event;
    expect(data).toBeDefined();
    for (const body of [
      withoutData,
      { ...event, object: "charge" },
      { ...event, type: "Invoice.Paid" },
      { ...event, id: "in_test_alpha_1" },
      { ...event, livemode: "false" },
      { ...event, created: "1791795899" },
    ]) {
      expect([body, requests.check("receiveStripeBillingEvent", { status: 200, body }).length > 0]).toEqual([
        body,
        true,
      ]);
    }
    // Open on purpose: a property Stripe adds tomorrow does not refuse a signed event (OPEN_REQUEST_BODIES).
    expect(
      requests.check("receiveStripeBillingEvent", {
        status: 200,
        body: { ...event, context: "acct_test_alpha", data: { ...data, added_by_stripe: { nested: true } } },
      }),
    ).toEqual([]);
    expect(Object.keys(OPEN_REQUEST_BODIES).sort()).toEqual(Object.keys(WEBHOOK_FIXTURES).sort());
    // The Connect event is the billing event with `account` required, property for property.
    const billing = schemaOf("StripeEvent");
    const connect = schemaOf("StripeConnectAccountEvent");
    expect([...(connect["required"] as string[])].sort()).toEqual(
      [...(billing["required"] as string[]), "account"].sort(),
    );
    expect(Object.keys(propertiesOf("StripeConnectAccountEvent")).sort()).toEqual(
      Object.keys(propertiesOf("StripeEvent")).sort(),
    );
    for (const [name, schema] of Object.entries(propertiesOf("StripeEvent"))) {
      expect([name, shape(propertiesOf("StripeConnectAccountEvent")[name])]).toEqual([name, shape(schema)]);
    }
  });

  it("answers no property ending in Secret, Ciphertext or Hash in any response of the slice", () => {
    const leaky = (name: string): boolean => /(secret|ciphertext|hash)$/i.test(name);
    // The walk reaches the statements, the lines and the payout account, so it cannot pass by not looking.
    expect(propertyNames(platform, { $ref: "#/components/schemas/AdminSettlement" })).toContain(
      "payoutAccountStatus",
    );
    for (const { operationId } of SLICE_PBE042) {
      for (const [status, response] of responsesOf(platform, operation(operationId))) {
        const names = [...propertyNames(platform, jsonMedia(response)?.["schema"])];
        expect([operationId, status, names.filter(leaky)]).toEqual([operationId, status, []]);
      }
    }
    // The checker refuses a statement with a ciphertext, and a masked payout account with an IBAN.
    const [statement] = examplesAt("adminGetSettlement", "200");
    expect(
      checker.check("adminGetSettlement", {
        status: 200,
        body: { ...asJson(statement), bankDetailsCiphertext: "AAAA" },
      }),
    ).toEqual([expect.objectContaining({ path: "/bankDetailsCiphertext", keyword: "additionalProperties" })]);
    const [payout] = examplesAt("adminGetPayoutAccount", "200");
    expect(
      checker.check("adminGetPayoutAccount", {
        status: 200,
        body: { ...asJson(payout), iban: "NO9386011117947" },
      }),
    ).toEqual([expect.objectContaining({ path: "/iban", keyword: "additionalProperties" })]);
  });

  it("paginates the long lists of the slice and gives every request body examples that the request checker accepts", () => {
    for (const operationId of [
      "adminListInvoices",
      "adminListStripeEvents",
      "adminListSettlements",
      "adminListSettlementLines",
      "adminListDomains",
    ]) {
      const list: unknown = operation(operationId).spec["parameters"];
      const refs = (Array.isArray(list) ? (list as unknown[]) : []).map(
        (parameter) => asJson(parameter)["$ref"],
      );
      expect([operationId, refs]).toEqual([
        operationId,
        expect.arrayContaining(["#/components/parameters/Cursor", "#/components/parameters/Limit"]),
      ]);
      const schema = asJson(resolve(platform, jsonMedia(successOf(operationId, "200"))?.["schema"]));
      expect([operationId, schema["required"]]).toEqual([operationId, ["data", "page"]]);
    }
    // The slice's operations with a body; approval, the reads, the re-checks and reprocessing take none.
    const withBody = SLICE_PBE042.map(({ operationId }) => operationId).filter(
      (operationId) => operation(operationId).spec["requestBody"] !== undefined,
    );
    expect(withBody).toEqual([
      "adminReleaseAmadeusOffice",
      "adminGenerateSettlements",
      "adminAddSettlementAdjustment",
      "adminMarkSettlementPaid",
      "adminVoidSettlement",
      "adminRevealPayoutAccount",
      "adminReviewPayoutAccount",
      "adminRemoveDomain",
      "receiveStripeBillingEvent",
      "receiveStripeConnectAccountEvent",
    ]);
    const requests = requestBodyChecker(withBody);
    for (const operationId of withBody) {
      expect([operationId, operation(operationId).spec["requestBody"]]).toEqual([
        operationId,
        expect.objectContaining({ required: true }),
      ]);
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

  it("closes every request body with additionalProperties: false, but the Stripe events of OPEN_REQUEST_BODIES", () => {
    const open: string[] = [];
    for (const { operationId, spec } of operations) {
      const body = resolve(platform, spec["requestBody"]);
      if (body !== undefined) {
        const media = objectAt(objectAt(body, "content"), "application/json");
        const openSchema = OPEN_REQUEST_BODIES[operationId];
        if (openSchema !== undefined) {
          // Open on purpose, and only there: the PBE-042 slice test checks that these are the webhook receivers.
          open.push(operationId);
          const schema = objectAt({ schema: resolve(platform, media["schema"]) }, "schema");
          expect([operationId, media["schema"], schema["additionalProperties"]]).toEqual([
            operationId,
            { $ref: openSchema },
            true,
          ]);
          continue;
        }
        expect([operationId, isClosed(platform, media["schema"])]).toEqual([operationId, true]);
      }
    }
    expect(open.sort()).toEqual(Object.keys(OPEN_REQUEST_BODIES).sort());
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
