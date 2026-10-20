import type { PlatformErrorCode } from "@velexis/errors";

/**
 * The platform admin's user-facing text (English). Kept in one module so a translation can be added later
 * (ADR-0014). Messages never contain a value the admin submitted, and never the raw message of an API answer.
 */

/** The message for an error code that the catalogue does not know (it should never be shown). */
export const UNKNOWN_ERROR_MESSAGE =
  "Something went wrong. Try again, and tell the developer if it keeps happening.";

/**
 * One message for every code of the platform API's error catalogue (`x-error-catalogue` of the platform
 * document, generated into `@velexis/errors`). A new code in the document fails `errors.test.ts` (and the type
 * check) until it has a message here. The admin works on the fleet, so the messages speak about OTAs, accounts and
 * jobs, not about "your" OTA.
 */
export const ERROR_MESSAGES: Readonly<Record<PlatformErrorCode, string>> = Object.freeze({
  VALIDATION_FAILED: "Some of the information is missing or not valid. Check the highlighted fields.",
  VERIFICATION_TOKEN_INVALID: "This verification link has expired or was already used.",
  PASSWORD_RESET_TOKEN_INVALID: "This password reset link has expired or was already used.",
  INVITATION_INVALID: "This invitation has expired, was revoked or was already used.",
  CONNECT_STATE_INVALID: "The Stripe connection request expired. Start it again.",
  MFA_SETUP_EXPIRED: "The two-factor set-up expired. Start the set-up again in the portal.",
  WEBHOOK_SIGNATURE_INVALID: "The request could not be verified.",
  UNAUTHENTICATED: "Your admin session has ended. Sign in again.",
  TOKEN_EXPIRED: "Your admin session has ended. Sign in again.",
  INVALID_CREDENTIALS:
    "The e-mail address or password is not correct, or the account is not an active platform admin.",
  REFRESH_TOKEN_INVALID: "Your admin session has ended. Sign in again.",
  REFRESH_TOKEN_REUSED: "For security, your admin session was ended. Sign in again.",
  MFA_CHALLENGE_INVALID: "The two-factor step expired or had too many attempts. Sign in again.",
  MFA_CODE_INVALID: "The code is not correct. Check your authenticator app or recovery code and try again.",
  REAUTH_REQUIRED: "Enter a code from your authenticator app to confirm this action.",
  FORBIDDEN: "You do not have permission to do this.",
  EMAIL_NOT_VERIFIED: "The e-mail address of this account is not verified yet.",
  ACCOUNT_DISABLED: "This account is disabled.",
  MFA_REQUIRED:
    "Platform admins must use two-factor authentication. Turn it on for your account in the portal first, then sign in here again.",
  INVITATION_EMAIL_MISMATCH: "This invitation was sent to another e-mail address.",
  FEATURE_DISABLED: "This feature is not switched on yet.",
  NOT_FOUND: "We could not find what you were looking for. It may have been removed.",
  CONFLICT: "This cannot be done in the current state. Reload the page and try again.",
  IDEMPOTENCY_KEY_REUSED:
    "This request was already submitted with different details. Reload the page and try again.",
  TENANT_KEY_UNAVAILABLE: "This OTA key is not available.",
  TENANT_NOT_ACTIVE: "This OTA is not active. It may still be in set-up, suspended or failed.",
  PROVISIONING_NOT_RETRYABLE: "Only a failed provisioning job can be retried.",
  LAST_OWNER: "An OTA must keep at least one owner.",
  ALREADY_MEMBER: "This person is already a member of this OTA.",
  INVITATION_PENDING: "An invitation for this e-mail address is already waiting to be accepted.",
  DOMAIN_TAKEN: "This domain is already used by another OTA.",
  DOMAIN_NOT_VERIFIED: "This domain is not verified yet.",
  AMADEUS_OFFICE_UNAVAILABLE:
    "No Amadeus office of this environment is available. Add offices to the pool first.",
  STRIPE_ACCOUNT_ALREADY_CONNECTED: "This Stripe account is already connected to another OTA.",
  SETTLEMENT_STATE_INVALID: "This statement does not allow that action in its current status.",
  MFA_ALREADY_ENABLED: "Two-factor authentication is already turned on for this account.",
  KEYS_ALREADY_REVEALED:
    "The initial keys of this OTA were already shown, or the time to show them has passed.",
  PRECONDITION_FAILED: "Someone else changed this in the meantime. Reload the page and try again.",
  PASSWORD_TOO_WEAK: "This password is too weak.",
  CURRENT_PASSWORD_INCORRECT: "The current password is not correct.",
  PLAN_NOT_AVAILABLE: "This plan is not available with the chosen billing interval.",
  PLAN_LIMIT_REACHED: "The plan's limit is reached for this OTA.",
  LIVE_MODE_NOT_ENABLED: "This OTA is not live yet.",
  LIVE_PRECONDITIONS_UNMET: "This OTA cannot go live yet: steps of its checklist are still open.",
  DOMAIN_INVALID: "Enter a valid public domain name that does not belong to Velexis.",
  PAYOUT_ACCOUNT_REQUIRED: "This OTA has no verified payout account yet.",
  UNPROCESSABLE: "This request cannot be completed. Check the details and try again.",
  ACCOUNT_LOCKED: "Too many failed sign-in attempts. Wait a few minutes, then try again.",
  RATE_LIMITED: "Too many attempts. Wait a moment, then try again.",
  INTERNAL_ERROR:
    "Something went wrong in the platform API. Try again, and check the logs if it keeps happening.",
  PROVIDER_ERROR: "An external service did not respond as expected. Try again later.",
  SERVICE_UNAVAILABLE: "The platform API is not reachable right now. Try again in a few minutes.",
});

/** Forms: the error summary above a form. */
export const FORM_STRINGS = Object.freeze({
  errorSummaryTitle: "There is a problem",
});

/** Counts in the admin's English: "1 minute", "15 minutes", "1,000 seconds". */
const COUNT_FORMAT = new Intl.NumberFormat("en");

function counted(count: number, one: string, other: string): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? one : other}`;
}

/**
 * A wait of `seconds` in words: whole seconds under a minute, otherwise minutes rounded up ("45 seconds",
 * "1 minute", "15 minutes"), so the admin never tries again too early.
 */
export function waitTime(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  return whole < 60
    ? counted(whole, "second", "seconds")
    : counted(Math.ceil(whole / 60), "minute", "minutes");
}

// ---- Sign-in, MFA and sign-out (PAD-002) ----------------------------------------------------------------------

/** `/sign-in`: e-mail and password, the first of the two steps of every admin sign-in (PF-80). */
export const SIGN_IN_STRINGS = Object.freeze({
  eyebrow: "Velexis platform admin",
  title: "Sign in",
  intro:
    "Use the e-mail address and password of your Velexis account. Every admin sign-in also asks for a code from your authenticator app.",
  emailLabel: "E-mail address",
  passwordLabel: "Password",
  submit: "Continue",
  submitting: "Checking…",
  emailRequired: "Enter your e-mail address.",
  emailInvalid: "Enter a valid e-mail address, like name@example.com.",
  passwordRequired: "Enter your password.",
  passwordTooLong: "Enter a password of at most 256 characters.",
  /** `ACCOUNT_LOCKED` with the wait of its `Retry-After` header. */
  lockedFor: (seconds: number) =>
    `Too many failed sign-in attempts. The account is locked: try again in ${waitTime(seconds)}.`,
  rateLimited: "Too many sign-in attempts from your network. Wait a minute, then try again.",
  /** The link next to the `MFA_REQUIRED` message, to the portal's security page. */
  enableMfa: "Turn on two-factor authentication in the portal",
  forgotPassword: "Forgot your password? Reset it in the portal.",
  signedOut: "You are signed out.",
});

/** `/sign-in/mfa`: the TOTP or recovery code step, required on every admin sign-in (PF-80). */
export const MFA_STRINGS = Object.freeze({
  title: "Two-factor authentication",
  totpIntro: "Enter the 6-digit code your authenticator app shows for Velexis.",
  recoveryIntro:
    "Enter one of the recovery codes you stored when you turned on two-factor authentication. Each code works once.",
  codeLabel: "Authentication code",
  codeHint: "The 6-digit code your authenticator app shows now.",
  codeFormat: "Enter the 6 digits of the code from your authenticator app.",
  recoveryLabel: "Recovery code",
  recoveryHint: "Four groups of four letters and digits, with or without the dashes.",
  recoveryFormat: "Enter a recovery code: four groups of four letters and digits.",
  recoveryInvalid: "This recovery code is not correct or was already used. Check it and try again.",
  useRecoveryCode: "Use a recovery code instead",
  useAuthenticator: "Use your authenticator app instead",
  submit: "Verify and sign in",
  submitting: "Checking…",
  backToSignIn: "Back to sign in",
  lostDevice:
    "Lost your device and your recovery codes? Another platform admin, or the developer on the VM, can reset your two-factor authentication.",
  /** `RATE_LIMITED` of adminVerifyMfa (10 attempts per account per 10 minutes), with the wait of `Retry-After`. */
  rateLimitedFor: (seconds: number) => `Too many codes were tried. Try again in ${waitTime(seconds)}.`,
});

// ---- Console shell and shared components (PAD-003) --------------------------------------------------------------

/** The signed-in shell (`AdminShell`, `(app)/layout.tsx`). */
export const SHELL_STRINGS = Object.freeze({
  productName: "Velexis admin",
  navigationLabel: "Admin",
  environmentLabel: "Environment",
  signedInAs: "Signed in as",
  signOut: "Sign out",
  unavailableTitle: "The admin console could not be loaded",
});

/** The badge of `APP_ENV` in the shell, so nobody mistakes production for a test system. */
export const ENVIRONMENT_LABELS = Object.freeze({
  development: "Development",
  test: "Test",
  production: "Production",
});

/** The groups of the navigation, in display order (README §2). */
export const NAV_SECTION_LABELS = Object.freeze({
  overview: "Overview",
  tenants: "OTAs",
  billing: "Plans and billing",
  amadeus: "Amadeus",
  payments: "Payments",
  people: "People and audit",
});

/** One entry per area of README §2. */
export const NAV_LABELS = Object.freeze({
  dashboard: "Dashboard",
  tenants: "Tenants",
  provisioningJobs: "Provisioning jobs",
  queues: "Queues",
  plans: "Plans",
  subscriptions: "Subscriptions",
  invoices: "Invoices",
  stripeEvents: "Stripe events",
  amadeusAccounts: "Amadeus accounts",
  amadeusOffices: "Office pool",
  settlements: "Settlements",
  domains: "Domains",
  accounts: "Accounts",
  admins: "Platform admins",
  audit: "Audit log",
});

/** `StepUpDialog`: the TOTP prompt of a sensitive action (README §4). */
export const STEP_UP_STRINGS = Object.freeze({
  title: "Confirm with your authenticator app",
  description:
    "This action needs a confirmation with your authenticator app in the last 15 minutes. Enter the 6-digit code it shows now to continue.",
  codeLabel: "Authentication code",
  codeHint: "The 6-digit code your authenticator app shows now.",
  codeFormat: "Enter the 6 digits of the code from your authenticator app.",
  submit: "Confirm",
  submitting: "Checking…",
  cancel: "Cancel",
  /** `RATE_LIMITED` of adminStepUp (10 attempts per account per 10 minutes), with the wait of `Retry-After`. */
  rateLimitedFor: (seconds: number) => `Too many codes were tried. Try again in ${waitTime(seconds)}.`,
});

/** The bounds of `AdminReason` in the platform document (PADR-0006 item 5). */
export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 500;

/** `ReasonDialog`: the mandatory reason of a **reason** action, stored in the audit log. */
export const REASON_STRINGS = Object.freeze({
  label: "Reason",
  hint: `Between ${REASON_MIN_LENGTH} and ${REASON_MAX_LENGTH} characters. It is stored in the audit log with your name.`,
  required: "Enter a reason.",
  tooShort: `Enter a reason of at least ${REASON_MIN_LENGTH} characters.`,
  tooLong: `Enter a reason of at most ${REASON_MAX_LENGTH} characters.`,
  counter: (count: number) => `${COUNT_FORMAT.format(count)} of ${REASON_MAX_LENGTH} characters`,
  cancel: "Cancel",
});

/** `ConfirmDialog`. */
export const CONFIRM_STRINGS = Object.freeze({
  cancel: "Cancel",
});

/** `DataTable`: the empty table and the cursor paging. */
export const TABLE_STRINGS = Object.freeze({
  empty: "Nothing matches.",
  paginationLabel: "Pages",
  firstPage: "First page",
  nextPage: "Next page",
});

/** `FilterBar`. */
export const FILTER_STRINGS = Object.freeze({
  label: "Filters",
  search: "Search",
  any: "Any",
  clear: "Clear filters",
});

/** `RevealPanel`: details revealed for a short time (the payout account, README §4). */
export const REVEAL_STRINGS = Object.freeze({
  /** How long the details stay, counted down on screen. */
  hidesIn: (seconds: number) => `Hidden again in ${counted(seconds, "second", "seconds")}.`,
  warning:
    "Read the details from the screen. They are not copied anywhere, and they hide again after 60 seconds. Revealing them is in the audit log.",
  hideNow: "Hide now",
  hidden: "The details are hidden again. Reveal them again if you still need them.",
});

/** `MaskedValue`: what a screen reader says for `•••• 7947`. */
export const MASKED_STRINGS = Object.freeze({
  endingIn: (label: string, last4: string) => `${label} ending in ${last4}`,
  hidden: (label: string) => `${label}, hidden`,
});

/** `JsonView`. */
export const JSON_STRINGS = Object.freeze({
  empty: "None",
  unreadable: "This value cannot be shown.",
});

/**
 * The label of every status `StatusBadge` shows, by kind (`status-badge.tsx` checks that every status of the platform
 * document has one).
 */
export const STATUS_LABELS = Object.freeze({
  tenant: { provisioning: "Setting up", active: "Active", suspended: "Suspended", failed: "Set-up failed" },
  job: { queued: "Queued", running: "Running", succeeded: "Done", failed: "Failed", canceled: "Canceled" },
  jobStep: { succeeded: "Done", failed: "Failed", skipped: "Skipped" },
  bullmq: {
    waiting: "Waiting",
    prioritized: "Prioritized",
    "waiting-children": "Waiting for children",
    delayed: "Delayed",
    active: "Active",
    completed: "Completed",
    failed: "Failed",
    unknown: "Unknown",
  },
  amadeusConnection: {
    pending_verification: "Pending",
    active: "Active",
    invalid_credentials: "Invalid credentials",
    disabled: "Disabled",
  },
  amadeusAccount: {
    pending_verification: "Not verified",
    active: "Active",
    invalid_credentials: "Invalid credentials",
    disabled: "Disabled",
  },
  amadeusOffice: { available: "Available", assigned: "Assigned", releasing: "Releasing", retired: "Retired" },
  paymentConnection: { pending: "Pending", active: "Active", disabled: "Disabled", error: "Error" },
  credentialSubmission: {
    pending: "Pending",
    verifying: "Verifying",
    applied: "Applied",
    failed: "Failed",
    superseded: "Superseded",
  },
  domain: { pending: "Pending", verified: "Verified", failed: "Failed" },
  tls: { pending: "Pending", issued: "Issued", failed: "Failed", expired: "Expired" },
  subscription: {
    trialing: "Trial",
    active: "Active",
    past_due: "Past due",
    paused: "Paused",
    canceled: "Canceled",
    incomplete: "Incomplete",
    incomplete_expired: "Expired",
    unpaid: "Unpaid",
  },
  invoice: { draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Uncollectible" },
  stripeEvent: {
    received: "Received",
    processing: "Processing",
    processed: "Processed",
    ignored: "Ignored",
    failed: "Failed",
  },
  membership: { active: "Active", suspended: "Suspended", removed: "Removed" },
  invitation: { pending: "Pending", accepted: "Accepted", revoked: "Revoked", expired: "Expired" },
  account: {
    pending_verification: "Not verified",
    active: "Active",
    locked: "Locked",
    disabled: "Disabled",
    deleted: "Deleted",
  },
  payoutAccount: { pending_review: "Pending review", verified: "Verified", rejected: "Rejected" },
  settlement: {
    draft: "Draft",
    approved: "Approved",
    paid: "Paid",
    carried_forward: "Carried forward",
    void: "Void",
  },
});

// ---- Dashboard, tenant list and tenant detail (PAD-004) ---------------------------------------------------------

/** A count in the admin's English: "1,042". */
export function formatCount(count: number): string {
  return COUNT_FORMAT.format(count);
}

/** The environments of the office pool and of the Amadeus and payment connections (`Environment`). */
export const SUPPLIER_ENVIRONMENT_LABELS = Object.freeze({ test: "Test", live: "Live" });

/** `/`: the counters of `adminGetDashboard`, each linking to the list behind it (README §2). */
export const DASHBOARD_STRINGS = Object.freeze({
  title: "Dashboard",
  intro: "The state of the fleet right now. Every count opens the list behind it.",
  unavailableTitle: "The dashboard could not be loaded",
  tenantsTitle: "OTAs by status",
  provisioningTitle: "Failed provisioning",
  provisioningFailed: (count: number) =>
    count === 1 ? "tenant job failed in the last 24 hours" : "tenant jobs failed in the last 24 hours",
  provisioningHint: "The list shows every failed tenant job, newest first.",
  queuesTitle: "Failed jobs per queue",
  queuesIntro: "Failed BullMQ jobs of each platform queue.",
  failedJobs: (count: number) => (count === 1 ? "failed job" : "failed jobs"),
  officePoolTitle: "Amadeus office pool",
  officePoolIntro: "The offices of the Velexis Amadeus account of each environment.",
  officePoolEmpty: "There is no Velexis Amadeus account yet, so the office pool is empty.",
  officePoolAccountsLink: "Set up the Amadeus accounts",
  available: "available",
  assigned: "assigned",
  /** Below 3 available offices (PADR-0012): new OTAs would wait for one. */
  poolLow: (environment: string, count: number) =>
    `Only ${counted(count, "office is", "offices are")} available in ${environment}. Add offices to the pool before new OTAs have to wait for one.`,
});

/** `/tenants`: the search of `adminListTenants` (PF-81). */
export const TENANT_LIST_STRINGS = Object.freeze({
  title: "Tenants",
  intro:
    "Every OTA in any status, newest first. Search by key, name or the e-mail address of an owner; the address of this page keeps the filters, so a search can be shared.",
  filtersLabel: "Tenant filters",
  searchLabel: "Search",
  searchPlaceholder: "Key, name or owner e-mail",
  statusLabel: "Status",
  planLabel: "Plan",
  retiredPlan: (name: string) => `${name} (retired)`,
  caption: "Tenants",
  empty: "No OTA matches these filters.",
  columnOta: "OTA",
  columnStatus: "Status",
  columnPlan: "Plan",
  columnOwner: "Owner e-mail",
  columnCreated: "Created",
  columnActivated: "Set up",
  noOwner: "No active owner",
  notYet: "Not yet",
  invalidFilters: "The filters in this address are not valid. Clear them and search again.",
  showAll: "Show every tenant",
  unavailableTitle: "The tenants could not be loaded",
});

/** The tabs of `/tenants/[tenantId]`, in display order (README §2). */
export const TENANT_TAB_LABELS = Object.freeze({
  overview: "Overview",
  members: "Members and invitations",
  subscription: "Subscription and invoices",
  connections: "Connections",
  domains: "Domains",
  jobs: "Provisioning jobs",
  audit: "Audit",
});

/** `/tenants/[tenantId]`: the control-plane view of `adminGetTenant` (PF-81). */
export const TENANT_DETAIL_STRINGS = Object.freeze({
  title: "Tenant",
  backToList: "All tenants",
  unavailableTitle: "This tenant could not be loaded",
  tabsLabel: "Tenant details",
  none: "None",
  notSet: "Not set",
  notYet: "Not yet",
  yes: "Yes",
  no: "No",
  // Overview
  id: "Tenant id",
  key: "Key",
  name: "Name",
  legalName: "Legal name",
  status: "Status",
  suspendedAt: "Suspended",
  suspensionReason: "Suspension reason",
  billingNotice: "Billing notice",
  plan: "Plan",
  defaultCurrency: "Default currency",
  country: "Country",
  timeZone: "Time zone",
  supportEmail: "Support e-mail",
  storefrontEnvironment: "Storefront environment",
  primaryHost: "Primary host",
  schemaVersion: "Schema version",
  created: "Created",
  activated: "Set up",
  liveSince: "Live since",
  version: "Version",
  notesTitle: "Internal notes",
  notesHint: "Only Velexis staff see these notes; the OTA never does.",
  noNotes: "No notes.",
  // Members and invitations
  membersTitle: "Members",
  membersCaption: "Active members, oldest first",
  membersEmpty: "This OTA has no active member.",
  memberName: "Name",
  memberEmail: "E-mail",
  memberRole: "Role",
  memberStatus: "Status",
  memberMfa: "Two-factor",
  memberJoined: "Joined",
  mfaOn: "On",
  mfaOff: "Off",
  invitationsTitle: "Pending invitations",
  invitationsCaption: "Pending invitations, newest first",
  invitationsEmpty: "No invitation is waiting.",
  invitationEmail: "E-mail",
  invitationRole: "Role",
  invitationStatus: "Status",
  invitedBy: "Invited by",
  inviterRemoved: "An account that no longer exists",
  invitationExpires: "Expires",
  invitationSent: "Sent",
  // Subscription and invoices
  subscriptionTitle: "Subscription",
  noSubscription: "This OTA has no subscription.",
  subscriptionId: "Subscription id",
  subscriptionPlan: "Plan",
  subscriptionStatus: "Status",
  billingProvider: "Billing",
  billingInterval: "Interval",
  trialEnds: "Trial ends",
  periodEnds: "Current period ends",
  cancelAtPeriodEnd: "Cancels at period end",
  banner: "Portal banner",
  invoicesTitle: "Invoices",
  invoicesIntro:
    "The invoices and Stripe events of the subscription are on its page. A manual trial has none; Stripe Billing adds them from M5.",
  invoicesLink: "Invoices and Stripe events of this subscription",
  // Connections
  connectionsIntro:
    "The connections are masked as the portal shows them: no secret, ciphertext or token is ever part of this page.",
  amadeusTitle: "Amadeus",
  amadeusEmpty: "This OTA has no Amadeus connection.",
  paymentsTitle: "Payments",
  paymentsEmpty: "This OTA has no payment connection.",
  connectionTitle: (provider: string, environment: string) => `${provider}, ${environment}`,
  connectionId: "Connection id",
  environment: "Environment",
  connectionStatus: "Status",
  credentialSource: "Credentials",
  offices: "Offices",
  defaultOffice: "Default office",
  queuingOffice: "Queuing office",
  ownerOffice: "Owner office",
  clientId: "Client id",
  lastVerified: "Last verified",
  lastError: "Last error",
  pendingSubmission: "Credential submission",
  accountMode: "Account",
  accountReference: "Stripe account",
  publishableKey: "Publishable key",
  statementDescriptor: "Statement descriptor suffix",
  chargesEnabled: "Charges enabled",
  payoutsEnabled: "Payouts enabled",
  detailsSubmitted: "Details submitted",
  connectedAt: "Connected",
  disconnectedAt: "Disconnected",
  // Domains
  domainsCaption: "Storefront hosts",
  domainsEmpty: "This OTA has no domain.",
  hostname: "Host name",
  domainKind: "Kind",
  domainPurpose: "Purpose",
  primary: "Primary",
  verification: "Verification",
  tls: "TLS",
  tlsExpires: "TLS expires",
  lastChecked: "Last checked",
  lastCheckError: "Last check",
  // Provisioning jobs
  jobsCaption: "The last 20 tenant jobs, newest first",
  jobsEmpty: "This OTA has no tenant job yet.",
  job: "Job",
  jobKind: "Kind",
  jobStatus: "Status",
  jobStep: "Step",
  jobAttempts: "Attempts",
  attemptsOf: (attempt: number, maxAttempts: number) =>
    `${COUNT_FORMAT.format(attempt)} of ${COUNT_FORMAT.format(maxAttempts)}`,
  jobError: "Last error",
  jobScheduled: "Scheduled",
  jobStarted: "Started",
  jobFinished: "Finished",
  allJobs: "All jobs of this OTA",
  // Audit
  auditCaption: "The last 50 audit rows of this OTA, newest first",
  auditEmpty: "This OTA has no audit row yet.",
  auditWhen: "When",
  auditActor: "Actor",
  auditAction: "Action",
  auditTarget: "Target",
  auditRequest: "Request id",
  auditIp: "IP address",
  auditDetails: "Details",
  auditDetailsOf: (id: string) => `Details of audit row ${id}`,
  fullAudit: "Full audit log of this OTA",
});

/** The roles of the members and invitations of an OTA (`TenantRole`). */
export const ROLE_LABELS = Object.freeze({
  owner: "Owner",
  admin: "Admin",
  agent: "Agent",
  finance: "Finance",
  viewer: "Viewer",
});

/** Why an OTA is suspended (`SuspensionReason`, PADR-0014). */
export const SUSPENSION_REASON_LABELS = Object.freeze({
  billing: "Billing: the subscription is unpaid",
  abuse: "Abuse",
  request: "The OTA asked for it",
  admin: "Velexis decision",
});

/** The billing banner of the tenant row (`BillingNotice`). */
export const BILLING_NOTICE_LABELS = Object.freeze({
  past_due: "A payment failed",
  trial_ending: "The trial ends soon",
});

/** The billing banner of the portal for a subscription (`Subscription.banner`). */
export const SUBSCRIPTION_BANNER_LABELS = Object.freeze({
  past_due: "A payment failed",
  trial_ending: "The trial ends soon",
  canceled: "Canceled",
});

/** Who bills a subscription (`Subscription.billingProvider`). */
export const BILLING_PROVIDER_LABELS = Object.freeze({
  manual: "Manual (no Stripe)",
  stripe: "Stripe Billing",
});

/** `BillingInterval`. */
export const BILLING_INTERVAL_LABELS = Object.freeze({ month: "Monthly", year: "Yearly" });

/** Whose Amadeus credentials a connection uses (`AmadeusConnection.credentialSource`). */
export const CREDENTIAL_SOURCE_LABELS = Object.freeze({
  velexis: "Velexis account, office from the pool",
  tenant: "The OTA's own credentials",
});

/** Which Stripe account a payment connection charges on (`PaymentConnection.accountMode`). */
export const PAYMENT_ACCOUNT_MODE_LABELS = Object.freeze({
  velexis: "Velexis Stripe account",
  connect_standard: "The OTA's account through Stripe Connect",
  api_keys: "The OTA's account through its own API keys",
});

/** The payment providers of a payment connection (`PaymentConnection.provider`). */
export const PAYMENT_PROVIDER_LABELS = Object.freeze({ stripe: "Stripe" });

/** `Domain.kind`. */
export const DOMAIN_KIND_LABELS = Object.freeze({ subdomain: "Sub-domain", custom: "Custom domain" });

/** `Domain.purpose`. */
export const DOMAIN_PURPOSE_LABELS = Object.freeze({
  storefront: "Storefront",
  api: "API",
  console: "Console",
});

/** `ProvisioningJobKind` (PADR-0001 item 8). */
export const JOB_KIND_LABELS = Object.freeze({
  provision: "Set-up",
  migrate: "Migration",
  suspend: "Suspension",
  resume: "Resumption",
});

/** `AuditActorType`. */
export const AUDIT_ACTOR_LABELS = Object.freeze({
  account: "Portal user",
  platform_admin: "Platform admin",
  api_key: "API key",
  system: "System",
});
