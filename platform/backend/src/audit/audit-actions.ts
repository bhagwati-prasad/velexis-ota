// The names of every `platform_audit_log` row (PADR-0006, Audit item 6): one list, so a typo in an action fails to
// compile and the admin's audit filter offers the same names. The actions come from the flows (platform/docs/flows,
// "Tables touched" and the steps that audit) and the API inventories: every state change of the platform API and
// worker, and the sensitive reads of PADR-0006 item 2. New actions are added here first, in their group.
//
// Names are dotted, `<object>.<what happened>` in the past tense (`tenant.suspended`, `api_key.revoked`), and match the
// `action` pattern of the OpenAPI document (`AuditEntry.action`, `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, at most 100
// characters). The comment after a name says which operation (`operationId`), job or command writes it.

export const AUDIT_ACTIONS = Object.freeze([
  // Accounts: the portal's own account (§4 and §5 of the inventory) and the admin's account support (admin §7).
  "account.signed_up", // signUp
  "account.email_verified", // verifyEmail
  "account.updated", // updateMe
  "account.password_changed", // changePassword
  "account.password_reset", // confirmPasswordReset
  "account.mfa_enabled", // enableMfa
  "account.mfa_disabled", // disableMfa
  "account.recovery_codes_regenerated", // regenerateRecoveryCodes
  "account.disabled", // adminDisableAccount
  "account.enabled", // adminEnableAccount
  "account.unlocked", // adminUnlockAccount
  "account.mfa_reset", // adminResetAccountMfa, cli admin:reset-mfa

  // Portal sign-in and sessions.
  "auth.sign_in", // signIn (no MFA), verifyMfa
  "auth.sign_in_failed", // signIn with a wrong password, verifyMfa with a wrong code
  "auth.locked", // signIn: the fifth failure locks the account for 15 minutes
  "auth.recovery_code_used", // verifyMfa with a recovery code
  "auth.signed_out_everywhere", // signOutEverywhere
  "auth.session_revoked", // revokeSession

  // Platform admins (PADR-0006, Access).
  "admin.sign_in", // adminVerifyMfa
  "admin.sign_in_failed", // adminSignIn, adminVerifyMfa
  "admin.granted", // adminGrantAdmin, cli admin:grant
  "admin.revoked", // adminRevokeAdmin

  // OTA lifecycle (provisioning flow, PADR-0001, PADR-0014).
  "tenant.created", // createTenant
  "tenant.updated", // updateTenant, adminUpdateTenant
  "tenant.activated", // provisioning step activate (system)
  "tenant.provisioning_failed", // provision job failed (system), abandoned Checkout (system)
  "tenant.initial_keys_revealed", // revealInitialKeys (sensitive read)
  "tenant.suspended", // adminSuspendTenant, billing sync (system)
  "tenant.resumed", // adminResumeTenant, billing sync (system)
  "tenant.migration_requested", // adminMigrateTenant
  "tenant.migrated", // tenant.migrated event (system)
  "tenant.migration_failed", // tenant.migration_failed event (system)
  "tenant.went_live", // goLive

  // Jobs and queues (admin §3).
  "provisioning_job.retried", // retryProvisioning, adminRetryProvisioningJob, billing sync (system, a paid failed OTA)
  "provisioning_job.canceled", // adminCancelProvisioningJob
  "queue_job.retried", // adminRetryQueueJob
  "stripe_event.reprocessed", // adminReprocessStripeEvent

  // Team and OTA admin SSO (team flow, PADR-0007).
  "membership.created", // acceptInvitation
  "membership.role_changed", // updateMember
  "membership.removed", // removeMember (also a member who leaves)
  "invitation.created", // createInvitation
  "invitation.resent", // resendInvitation
  "invitation.revoked", // revokeInvitation
  "invitation.expired", // invitations.expire scheduler (system)
  "console.token_issued", // createConsoleToken (sensitive: the token itself is never stored)

  // API keys (API keys flow, PADR-0005).
  "api_key.created", // createApiKey, provisioning post-step (system)
  "api_key.updated", // updateApiKey
  "api_key.rolled", // rollApiKey
  "api_key.revoked", // revokeApiKey

  // Domains (custom domains flow, PADR-0004).
  "domain.added", // addDomain
  "domain.verification_restarted", // checkDomain on a failed domain
  "domain.verified", // domain.verify job (system)
  "domain.verification_failed", // domain.verify job past the 72 h deadline (system)
  "domain.primary_changed", // makeDomainPrimary
  "domain.removed", // removeDomain, adminRemoveDomain

  // Amadeus: the OTA's connections (Amadeus flow, PADR-0010) and the Velexis account and office pool (PADR-0012).
  "amadeus.settings_updated", // updateAmadeusConnection
  "amadeus.live_requested", // requestLiveAmadeus
  "amadeus.credentials_submitted", // submitAmadeusCredentials (never the secret)
  "amadeus.credentials_applied", // credentials.verify job, success (system)
  "amadeus.credentials_rejected", // credentials.verify job, failure (system)
  "amadeus_account.created", // adminCreateAmadeusAccount (never the secret)
  "amadeus_account.updated", // adminUpdateAmadeusAccount (rotation and disabling included)
  "amadeus_account.verification_requested", // adminVerifyAmadeusAccount
  "amadeus_account.verified", // amadeus_account.verify job, success (system)
  "amadeus_account.verification_failed", // amadeus_account.verify job, failure (system)
  "amadeus_office.added", // adminAddAmadeusOffices
  "amadeus_office.updated", // adminUpdateAmadeusOffice
  "amadeus_office.assigned", // adminAssignAmadeusOffice, provisioning post-step (system)
  "amadeus_office.released", // adminReleaseAmadeusOffice, credentials.verify job (system)
  "amadeus_office.retired", // adminRetireAmadeusOffice
  "connection.status_changed", // adminSetConnectionStatus (Amadeus or payment connection)

  // Payments: the OTA's Stripe connection (Stripe payments flow, PADR-0011) and its payout account (PADR-0003).
  "payments.descriptor_updated", // updatePaymentConnection
  "payments.connect_connected", // completeStripeConnect
  "payments.connect_status_changed", // account.updated Connect event (system)
  "payments.connect_disconnected", // account.application.deauthorized Connect event (system)
  "payments.connect_deauthorized_while_disabled", // the same event for a connection an admin disabled: recorded only
  "payments.api_keys_submitted", // submitStripeApiKeys (never the keys)
  "payments.api_keys_applied", // credentials.verify job, success (system)
  "payments.api_keys_rejected", // credentials.verify job, failure (system)
  "payments.switched_to_velexis", // useVelexisPayments
  "payout_account.updated", // setPayoutAccount (never the numbers)
  "payout_account.revealed", // adminRevealPayoutAccount (sensitive read)
  "payout_account.reviewed", // adminReviewPayoutAccount

  // Settlements (PADR-0003).
  "settlement.generation_requested", // adminGenerateSettlements
  "settlement.generated", // settlement.generate job (system)
  "settlement.adjusted", // adminAddSettlementAdjustment
  "settlement.approved", // adminApproveSettlement (also when carried forward)
  "settlement.paid", // adminMarkSettlementPaid
  "settlement.voided", // adminVoidSettlement

  // Plans and subscriptions (subscription billing flow, PADR-0002).
  "plan.created", // adminCreatePlan
  "plan.updated", // adminUpdatePlan
  "billing.checkout_started", // createCheckoutSession, createTenant with a paid plan (M5)
  "subscription.updated", // Stripe Billing sync (system)
  "subscription.resynced", // adminResyncSubscription
  "subscription.manually_updated", // adminUpdateManualSubscription

  // The audit log itself (sensitive read, PADR-0006 Audit item 2).
  "audit.exported", // adminExportAudit
] as const);

/** One audit action: a name of AUDIT_ACTIONS. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The kinds of object an audit row is about (`target_type`): the platform tables the actions above change, by the
 * singular name the OpenAPI examples use (`tenant`, `api_key`, `invitation`), plus `queue_job` (a BullMQ job) and
 * `audit_log` (the export). Each matches the `targetType` parameter of `adminListAudit` (`^[a-z][a-z0-9_]*$`).
 */
export const AUDIT_TARGET_TYPES = Object.freeze([
  "account",
  "session",
  "tenant",
  "provisioning_job",
  "queue_job",
  "stripe_event",
  "membership",
  "invitation",
  "api_key",
  "domain",
  "supplier_connection",
  "payment_connection",
  "credential_submission",
  "amadeus_account",
  "amadeus_office",
  "payout_account",
  "settlement",
  "plan",
  "subscription",
  "audit_log",
] as const);

/** One kind of audit target: a name of AUDIT_TARGET_TYPES. */
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

const ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);
const TARGET_TYPES: ReadonlySet<string> = new Set(AUDIT_TARGET_TYPES);

/** True when `value` is a name of AUDIT_ACTIONS (for values that reach the service past the compiler). */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && ACTIONS.has(value);
}

/** True when `value` is a name of AUDIT_TARGET_TYPES. */
export function isAuditTargetType(value: unknown): value is AuditTargetType {
  return typeof value === "string" && TARGET_TYPES.has(value);
}
