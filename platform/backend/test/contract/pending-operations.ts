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
  // PBE-005: identity, plans and internal are all bound (healthLive and healthReady since PBE-001 and PBE-008, signUp,
  // verifyEmail and resendVerification since PBE-013, signIn, refreshSession, signOut and signOutEverywhere since
  // PBE-014, verifyMfa, stepUp and the four MFA settings since PBE-015, listPlans since PBE-017, the password reset,
  // the account, the password change and the sessions since PBE-016, tlsAsk since PBE-027).

  // PBE-006: tenants, team, API keys and the M1 reads are all bound (the tenant reads and getSubscription since PBE-017,
  // createTenant since PBE-018, the API key operations since PBE-021, the member routes since PBE-025, the invitations
  // since PBE-026, the setup progress, retry and key reveal since PBE-023, getOnboarding since PBE-024, listDomains,
  // listAmadeusConnections and listPaymentConnections since PBE-027).

  // PBE-007: admin auth and dashboard, tenants, provisioning jobs and queues are all bound (the admin auth operations
  // since PBE-028, the dashboard and the tenant search, detail and edit since PBE-029, suspend, resume, migrate and the
  // connection status since PBE-030, the provisioning jobs and queues since PBE-031).

  // PBE-066: admin plans and subscriptions, Amadeus accounts and offices, accounts, platform admins and audit are all
  // bound (the Amadeus accounts and offices since PBE-020, the accounts, platform admins and audit since PBE-032, the
  // plans and subscriptions since PBE-033).

  // PBE-037: the M3–M4 connection updates and the console token are all bound (updatePaymentConnection since PBE-038,
  // createConsoleToken since PBE-039, updateAmadeusConnection since PBE-040).

  // PBE-041: the M5 tenant resources (go-live, custom domains, own Amadeus credentials, Stripe Connect and API keys,
  // the payout account and settlements, and invoices). createCheckoutSession and createCustomerPortalSession are bound
  // since PBE-044, getPayoutAccount and setPayoutAccount since PBE-058, startStripeConnect and completeStripeConnect
  // since PBE-055, listSettlements, getSettlement and downloadSettlementLines since PBE-060.
  { operationId: "goLive", task: "PBE-061" },
  { operationId: "addDomain", task: "PBE-049" },
  { operationId: "removeDomain", task: "PBE-049" },
  { operationId: "checkDomain", task: "PBE-050" },
  { operationId: "makeDomainPrimary", task: "PBE-049" },
  { operationId: "requestLiveAmadeus", task: "PBE-054" },
  { operationId: "submitAmadeusCredentials", task: "PBE-053" },
  { operationId: "getCredentialSubmission", task: "PBE-052" },
  { operationId: "submitStripeApiKeys", task: "PBE-057" },
  { operationId: "useVelexisPayments", task: "PBE-057" },
  { operationId: "listInvoices", task: "PBE-046" },

  // PBE-042: the M5 admin operations (billing, the office release, settlements and payout accounts, domains) and the
  // two Stripe webhook receivers. adminUpdatePlan, extended with the Stripe ids, stays bound by PBE-033; PBE-048
  // implements its M5 part. receiveStripeBillingEvent is bound since PBE-043, the three payout account operations
  // (adminGetPayoutAccount, adminRevealPayoutAccount, adminReviewPayoutAccount) since PBE-058, adminGenerateSettlements
  // since PBE-059, the settlement review (list, detail, lines and their CSV, adjustments, approval, payment, void) since
  // PBE-060.
  { operationId: "adminCheckPlanPrices", task: "PBE-048" },
  { operationId: "adminResyncSubscription", task: "PBE-048" },
  { operationId: "adminListInvoices", task: "PBE-048" },
  { operationId: "adminListStripeEvents", task: "PBE-048" },
  { operationId: "adminReprocessStripeEvent", task: "PBE-048" },
  { operationId: "adminReleaseAmadeusOffice", task: "PBE-054" },
  { operationId: "adminListDomains", task: "PBE-051" },
  { operationId: "adminRecheckDomain", task: "PBE-051" },
  { operationId: "adminRemoveDomain", task: "PBE-051" },
  { operationId: "receiveStripeConnectAccountEvent", task: "PBE-056" },
] satisfies PendingOperation[]);
