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
  // PBE-005: identity, plans and internal (healthLive and healthReady are bound since PBE-001 and PBE-008, signUp,
  // verifyEmail and resendVerification since PBE-013, signIn, refreshSession, signOut and signOutEverywhere since
  // PBE-014, listPlans since PBE-017).
  { operationId: "verifyMfa", task: "PBE-015" },
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
  { operationId: "tlsAsk", task: "PBE-027" },

  // PBE-006: tenants, team, API keys and the M1 reads (the tenant reads and getSubscription are bound since PBE-017,
  // the API key operations since PBE-021, the member routes since PBE-025).
  { operationId: "createTenant", task: "PBE-018" },
  { operationId: "getProvisioning", task: "PBE-023" },
  { operationId: "retryProvisioning", task: "PBE-023" },
  { operationId: "revealInitialKeys", task: "PBE-023" },
  { operationId: "getOnboarding", task: "PBE-024" },
  { operationId: "listInvitations", task: "PBE-026" },
  { operationId: "createInvitation", task: "PBE-026" },
  { operationId: "revokeInvitation", task: "PBE-026" },
  { operationId: "resendInvitation", task: "PBE-026" },
  { operationId: "lookupInvitation", task: "PBE-026" },
  { operationId: "acceptInvitation", task: "PBE-026" },
  { operationId: "listDomains", task: "PBE-027" },
  { operationId: "listAmadeusConnections", task: "PBE-027" },
  { operationId: "listPaymentConnections", task: "PBE-027" },

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

  // PBE-037: the M4 console token and Amadeus settings, and the M3 statement descriptor.
  { operationId: "createConsoleToken", task: "PBE-039" },
  { operationId: "updateAmadeusConnection", task: "PBE-040" },
  { operationId: "updatePaymentConnection", task: "PBE-038" },

  // PBE-041: the M5 tenant resources (go-live, custom domains, own Amadeus credentials, Stripe Connect and API keys,
  // the payout account and settlements, Checkout, the Customer Portal and invoices).
  { operationId: "goLive", task: "PBE-061" },
  { operationId: "addDomain", task: "PBE-049" },
  { operationId: "removeDomain", task: "PBE-049" },
  { operationId: "checkDomain", task: "PBE-050" },
  { operationId: "makeDomainPrimary", task: "PBE-049" },
  { operationId: "requestLiveAmadeus", task: "PBE-054" },
  { operationId: "submitAmadeusCredentials", task: "PBE-053" },
  { operationId: "getCredentialSubmission", task: "PBE-052" },
  { operationId: "startStripeConnect", task: "PBE-055" },
  { operationId: "completeStripeConnect", task: "PBE-055" },
  { operationId: "submitStripeApiKeys", task: "PBE-057" },
  { operationId: "useVelexisPayments", task: "PBE-057" },
  { operationId: "createCheckoutSession", task: "PBE-044" },
  { operationId: "createCustomerPortalSession", task: "PBE-044" },
  { operationId: "listInvoices", task: "PBE-046" },
  { operationId: "getPayoutAccount", task: "PBE-058" },
  { operationId: "setPayoutAccount", task: "PBE-058" },
  { operationId: "listSettlements", task: "PBE-060" },
  { operationId: "getSettlement", task: "PBE-060" },
  { operationId: "downloadSettlementLines", task: "PBE-060" },
] satisfies PendingOperation[]);
