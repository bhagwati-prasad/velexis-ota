// The operations of the platform document that have no route yet, each with the task of
// platform/docs/plans/agent-tasks.md that implements it (PADR-0016 item 2). The route parity test fails when a
// documented operation is neither bound with @OpenApiOperation nor listed here, and when one is both.
//
// The implementing task removes its own entries in the pull request that binds the route. A task that adds operations
// to the document (PBE-037, PBE-041, PBE-042) adds them here with their implementing tasks. The list is empty at the
// M5 exit (PADR-0016 item 2).
import type { PlatformOperationId } from "@velexis/api-types/operations";

/** A documented operation without a route, and the plan task that implements it. */
export interface PendingOperation {
  readonly operationId: PlatformOperationId;
  /** The task id of the platform plan, `PBE-<nnn>`. */
  readonly task: `PBE-${string}`;
}

export const PENDING_OPERATIONS: readonly PendingOperation[] = Object.freeze([
  // PBE-005: identity, plans and internal (healthLive and healthReady are bound since PBE-001 and PBE-008).
  { operationId: "signUp", task: "PBE-013" },
  { operationId: "verifyEmail", task: "PBE-013" },
  { operationId: "resendVerification", task: "PBE-013" },
  { operationId: "signIn", task: "PBE-014" },
  { operationId: "verifyMfa", task: "PBE-015" },
  { operationId: "refreshSession", task: "PBE-014" },
  { operationId: "signOut", task: "PBE-014" },
  { operationId: "signOutEverywhere", task: "PBE-014" },
  { operationId: "requestPasswordReset", task: "PBE-016" },
  { operationId: "confirmPasswordReset", task: "PBE-016" },
  { operationId: "stepUp", task: "PBE-015" },
  { operationId: "getMe", task: "PBE-016" },
  { operationId: "updateMe", task: "PBE-016" },
  { operationId: "changePassword", task: "PBE-016" },
  { operationId: "startMfaSetup", task: "PBE-015" },
  { operationId: "enableMfa", task: "PBE-015" },
  { operationId: "disableMfa", task: "PBE-015" },
  { operationId: "regenerateRecoveryCodes", task: "PBE-015" },
  { operationId: "listSessions", task: "PBE-016" },
  { operationId: "revokeSession", task: "PBE-016" },
  { operationId: "listPlans", task: "PBE-017" },
  { operationId: "tlsAsk", task: "PBE-027" },

  // PBE-006: tenants, team, API keys and the M1 reads.
  { operationId: "checkTenantKey", task: "PBE-017" },
  { operationId: "listTenants", task: "PBE-017" },
  { operationId: "createTenant", task: "PBE-018" },
  { operationId: "getTenant", task: "PBE-017" },
  { operationId: "updateTenant", task: "PBE-017" },
  { operationId: "getProvisioning", task: "PBE-023" },
  { operationId: "retryProvisioning", task: "PBE-023" },
  { operationId: "revealInitialKeys", task: "PBE-023" },
  { operationId: "getOnboarding", task: "PBE-024" },
  { operationId: "listMembers", task: "PBE-025" },
  { operationId: "removeMember", task: "PBE-025" },
  { operationId: "updateMember", task: "PBE-025" },
  { operationId: "listInvitations", task: "PBE-026" },
  { operationId: "createInvitation", task: "PBE-026" },
  { operationId: "revokeInvitation", task: "PBE-026" },
  { operationId: "resendInvitation", task: "PBE-026" },
  { operationId: "lookupInvitation", task: "PBE-026" },
  { operationId: "acceptInvitation", task: "PBE-026" },
  { operationId: "listApiKeys", task: "PBE-021" },
  { operationId: "createApiKey", task: "PBE-021" },
  { operationId: "updateApiKey", task: "PBE-021" },
  { operationId: "rollApiKey", task: "PBE-021" },
  { operationId: "revokeApiKey", task: "PBE-021" },
  { operationId: "listDomains", task: "PBE-027" },
  { operationId: "listAmadeusConnections", task: "PBE-027" },
  { operationId: "listPaymentConnections", task: "PBE-027" },
  { operationId: "getSubscription", task: "PBE-017" },

  // PBE-007: admin auth and dashboard, tenants, provisioning jobs and queues.
  { operationId: "adminSignIn", task: "PBE-028" },
  { operationId: "adminVerifyMfa", task: "PBE-028" },
  { operationId: "adminRefresh", task: "PBE-028" },
  { operationId: "adminStepUp", task: "PBE-028" },
  { operationId: "adminSignOut", task: "PBE-028" },
  { operationId: "adminGetMe", task: "PBE-028" },
  { operationId: "adminGetDashboard", task: "PBE-029" },
  { operationId: "adminListTenants", task: "PBE-029" },
  { operationId: "adminGetTenant", task: "PBE-029" },
  { operationId: "adminUpdateTenant", task: "PBE-029" },
  { operationId: "adminSuspendTenant", task: "PBE-030" },
  { operationId: "adminResumeTenant", task: "PBE-030" },
  { operationId: "adminMigrateTenant", task: "PBE-030" },
  { operationId: "adminSetConnectionStatus", task: "PBE-030" },
  { operationId: "adminListProvisioningJobs", task: "PBE-031" },
  { operationId: "adminGetProvisioningJob", task: "PBE-031" },
  { operationId: "adminRetryProvisioningJob", task: "PBE-031" },
  { operationId: "adminCancelProvisioningJob", task: "PBE-031" },
  { operationId: "adminListQueues", task: "PBE-031" },
  { operationId: "adminListFailedQueueJobs", task: "PBE-031" },
  { operationId: "adminRetryQueueJob", task: "PBE-031" },

  // PBE-066: admin plans and subscriptions, Amadeus accounts and offices, accounts, platform admins and audit.
  { operationId: "adminListPlans", task: "PBE-033" },
  { operationId: "adminCreatePlan", task: "PBE-033" },
  { operationId: "adminUpdatePlan", task: "PBE-033" },
  { operationId: "adminListSubscriptions", task: "PBE-033" },
  { operationId: "adminGetSubscription", task: "PBE-033" },
  { operationId: "adminUpdateManualSubscription", task: "PBE-033" },
  { operationId: "adminListAmadeusAccounts", task: "PBE-020" },
  { operationId: "adminCreateAmadeusAccount", task: "PBE-020" },
  { operationId: "adminUpdateAmadeusAccount", task: "PBE-020" },
  { operationId: "adminVerifyAmadeusAccount", task: "PBE-020" },
  { operationId: "adminListAmadeusOffices", task: "PBE-020" },
  { operationId: "adminAddAmadeusOffices", task: "PBE-020" },
  { operationId: "adminUpdateAmadeusOffice", task: "PBE-020" },
  { operationId: "adminAssignAmadeusOffice", task: "PBE-020" },
  { operationId: "adminRetireAmadeusOffice", task: "PBE-020" },
  { operationId: "adminListAccounts", task: "PBE-032" },
  { operationId: "adminGetAccount", task: "PBE-032" },
  { operationId: "adminDisableAccount", task: "PBE-032" },
  { operationId: "adminEnableAccount", task: "PBE-032" },
  { operationId: "adminUnlockAccount", task: "PBE-032" },
  { operationId: "adminResetAccountMfa", task: "PBE-032" },
  { operationId: "adminListAdmins", task: "PBE-032" },
  { operationId: "adminGrantAdmin", task: "PBE-032" },
  { operationId: "adminRevokeAdmin", task: "PBE-032" },
  { operationId: "adminListAudit", task: "PBE-032" },
  { operationId: "adminExportAudit", task: "PBE-032" },
] satisfies PendingOperation[]);
