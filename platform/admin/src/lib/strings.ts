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

// ---- Provisioning jobs and queues (PAD-006) ---------------------------------------------------------------------

/**
 * How long something has waited, in words: whole seconds under a minute, then minutes, then hours and minutes, then
 * days and hours ("45 seconds", "4 minutes", "2 hours 5 minutes", "3 days 2 hours").
 */
export function formatAge(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (whole < 60) {
    return counted(whole, "second", "seconds");
  }
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) {
    return counted(minutes, "minute", "minutes");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0
      ? counted(hours, "hour", "hours")
      : `${counted(hours, "hour", "hours")} ${counted(rest, "minute", "minutes")}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0
    ? counted(days, "day", "days")
    : `${counted(days, "day", "days")} ${counted(rest, "hour", "hours")}`;
}

/** `/provisioning-jobs`: the tenant jobs of `adminListProvisioningJobs` (PF-83). */
export const JOB_LIST_STRINGS = Object.freeze({
  title: "Provisioning jobs",
  intro:
    "The tenant jobs of every OTA (set-up, migration, suspension, resumption), newest first. The address of this page keeps the filters, so a list can be shared.",
  filtersLabel: "Job filters",
  statusLabel: "Status",
  kindLabel: "Kind",
  caption: "Provisioning jobs, newest first",
  empty: "No job matches these filters.",
  columnJob: "Job",
  columnOta: "OTA",
  columnKind: "Kind",
  columnStatus: "Status",
  columnStep: "Step",
  columnAttempts: "Attempts",
  columnError: "Last error",
  columnScheduled: "Scheduled",
  columnStarted: "Started",
  columnFinished: "Finished",
  attemptsOf: TENANT_DETAIL_STRINGS.attemptsOf,
  notYet: "Not yet",
  none: "None",
  /** The list is limited to one OTA (`tenantId` in the address, from the jobs tab of a tenant). */
  oneTenant: "Only the jobs of one OTA are shown.",
  openTenant: "Open the OTA",
  everyTenant: "Show the jobs of every OTA",
  invalidFilters: "The filters in this address are not valid. Clear them and try again.",
  showAll: "Show every job",
  unavailableTitle: "The provisioning jobs could not be loaded",
});

/** `/provisioning-jobs/[jobId]`: one job of `adminGetProvisioningJob` with its step log (PF-83). */
export const JOB_DETAIL_STRINGS = Object.freeze({
  title: "Provisioning job",
  backToList: "All provisioning jobs",
  unavailableTitle: "This job could not be loaded",
  none: "None",
  notYet: "Not yet",
  summaryTitle: "Job",
  id: "Job id",
  ota: "OTA",
  kind: "Kind",
  status: "Status",
  step: "Current or last step",
  attempts: "Attempts",
  attemptsOf: TENANT_DETAIL_STRINGS.attemptsOf,
  error: "Last error",
  scheduled: "Scheduled",
  scheduledHint: "The earliest start of the next attempt (the retry backoff).",
  started: "First dispatch",
  finished: "Finished",
  lease: "Lease",
  leaseUntil: "Held until",
  noLease: "None: only a running job holds one.",
  bullmqState: "BullMQ state",
  notDispatched: "Not dispatched yet",
  bullmqJob: "BullMQ job",
  bullmqJobOn: "on",
  stepsTitle: "Step log",
  stepsIntro: "The finished steps of the OTA worker, then the platform's own steps after it, in order.",
  stepsCaption: "Finished steps, in order",
  stepsEmpty: "No step has finished yet.",
  stepName: "Step",
  stepStatus: "Status",
  stepStarted: "Started",
  stepFinished: "Finished",
  stepError: "Error",
  payloadTitle: "Input",
  payloadIntro: "The job's input: ids and options only.",
  payloadLabel: (jobId: string) => `Input of job ${jobId}`,
  resultTitle: "Result",
  resultIntro:
    "The job's output, for example the ids of the API keys issued at set-up; none until the job ends. Keys that are shown once are never part of it.",
  resultLabel: (jobId: string) => `Result of job ${jobId}`,
});

/** The actions of `/provisioning-jobs/[jobId]`: retry a failed job, cancel a queued one (PF-83). */
export const JOB_ACTION_STRINGS = Object.freeze({
  sectionTitle: "Actions",
  noAction:
    "Nothing to do here: only a failed job can be retried and only a queued job can be canceled. A running job ends on its own.",
  working: "Working…",
  retry: "Retry",
  retryTitle: "Retry this job?",
  retryDescription:
    "A new job of the same kind starts for this OTA with the same input. This failed job stays as it is, as history.",
  retryProvisionDescription:
    "A new set-up job starts with the same input, and the OTA goes back to “Setting up”. When its schema already exists, only the platform's own steps run again. This failed job stays as it is, as history.",
  retryConfirm: "Retry job",
  retried: "A new job was started.",
  cancel: "Cancel job",
  cancelTitle: "Cancel this queued job?",
  cancelDescription:
    "The job is canceled and nothing more is sent to the OTA worker. The OTA's status does not change.",
  cancelConfirm: "Cancel job",
  keepJob: "Keep the job",
  canceled: "The job is canceled.",
  job: "Job",
  stepOf: (step: string) => `step ${step}`,
  /** A form field the admin cannot change (the hidden job id) is missing or invalid. */
  formExpired: "This form is out of date. Reload the page and try again.",
  jobGone: "This job no longer exists. Go back to the list of jobs.",
  /** `PROVISIONING_NOT_RETRYABLE` by its `details.reason`. */
  notFailed: "This job is no longer failed. Reload the page to see its status.",
  tenantNotFailed:
    "The OTA of this set-up job is no longer in the “Set-up failed” status, so its set-up cannot run again.",
  jobActive:
    "A job of this kind is already queued or running for this OTA. Wait for it to end, and retry only if it fails.",
  /** `CONFLICT` (`not_queued`) of a cancel. */
  notQueued:
    "Only a queued job can be canceled. This one was dispatched or ended in the meantime: reload the page.",
  rateLimitedFor: (seconds: number) => `Too many attempts. Try again in ${waitTime(seconds)}.`,
});

/** `/queues`: the BullMQ counts of `adminListQueues` (PF-84). */
export const QUEUE_LIST_STRINGS = Object.freeze({
  title: "Queues",
  intro:
    "The BullMQ queues of both backends right now: jobs waiting, running, delayed and failed, and how long the oldest waiting job has waited. Each queue opens its failed jobs.",
  platformTitle: "Platform queues",
  platformIntro: "Consumed by the platform worker. Their failed jobs can be retried here.",
  otaTitle: "OTA queues",
  otaIntro:
    "Consumed by the OTA worker, ota-tenant-ops included. View only: their failed jobs are retried in the OTA admin or by the developer.",
  columnQueue: "Queue",
  columnWaiting: "Waiting",
  columnActive: "Active",
  columnDelayed: "Delayed",
  columnFailed: "Failed",
  columnOldest: "Oldest waiting",
  noneWaiting: "None waiting",
  empty: "No queue.",
  unavailableTitle: "The queues could not be read",
  /** `SERVICE_UNAVAILABLE`: the API is unreachable, or it cannot reach Redis. */
  unavailable:
    "The queues cannot be read right now: the platform API or its Redis does not answer. Try again in a few minutes.",
});

/** `/queues/[queue]`: the failed jobs of `adminListFailedQueueJobs` and the retry of platform jobs (PF-84). */
export const QUEUE_DETAIL_STRINGS = Object.freeze({
  backToList: "All queues",
  platformOwner: "Platform queue",
  otaOwner: "OTA queue, view only",
  platformIntro:
    "A retry moves the job back to waiting with a new attempt budget, and the platform worker runs it again. Every retry is in the audit log.",
  otaNotice:
    "This queue belongs to the OTA backend. Its failed jobs are shown here, but they are retried in the OTA admin or by the developer, not here.",
  failedTitle: "Failed jobs",
  failedIntro: "The most recent failures first, at most 50. A job's data holds ids only.",
  caption: "Failed jobs, most recent failure first",
  empty: "No failed job in this queue.",
  columnId: "Job id",
  columnName: "Name",
  columnReason: "Failure reason",
  columnAttempts: "Attempts made",
  columnFailedAt: "Failed",
  columnData: "Data",
  columnAction: "Action",
  noReason: "No reason recorded",
  unknownTime: "Unknown",
  dataLabel: (jobId: string) => `Data of job ${jobId}`,
  /** A failed `ota-tenant-ops` job (`<jobId>-<attempt>`) links to its provisioning job, which can be retried. */
  provisioningJob: "Provisioning job",
  retry: "Retry",
  /** The rest of the retry button's accessible name, after "Retry", for screen readers. */
  retryJobSuffix: (jobId: string) => ` job ${jobId}`,
  retryTitle: (jobId: string) => `Retry job ${jobId}?`,
  retryDescription:
    "The job goes back to waiting with a new attempt budget, and the platform worker runs it again. The retry is in the audit log.",
  retryConfirm: "Retry job",
  retried: (jobId: string) => `Job ${jobId} waits for the platform worker again.`,
  working: "Working…",
  formExpired: "This form is out of date. Reload the page and try again.",
  /** `FORBIDDEN` (`ota_queue`). */
  otaQueue: "OTA queues are view only here: their jobs are retried in the OTA admin or by the developer.",
  /** `NOT_FOUND` of a retry: retried by someone else, or removed by BullMQ. */
  jobGone:
    "This job is no longer failed in this queue: it was retried or removed in the meantime. Reload the page.",
  rateLimitedFor: (seconds: number) => `Too many attempts. Try again in ${waitTime(seconds)}.`,
  unavailableTitle: "The failed jobs could not be read",
  unavailable: QUEUE_LIST_STRINGS.unavailable,
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

// ---- Tenant actions (PAD-005) -------------------------------------------------------------------------------------

/** What every action form of `/tenants/[tenantId]` says (README §2 tenant key actions). */
export const TENANT_ACTION_STRINGS = Object.freeze({
  sectionTitle: "Actions",
  sectionIntro:
    "Every action is in the audit log with your name; suspending, resuming and changing a connection also keep your reason there.",
  working: "Working…",
  /** A form field the admin cannot change (a hidden id) is missing or invalid: the page is older than the form. */
  formExpired: "This form is out of date. Reload the page and try again.",
  reload: "Reload the page",
  tenantGone: "This OTA no longer exists. Go back to the tenant list.",
  /** `RATE_LIMITED` with the wait of `Retry-After`. */
  rateLimitedFor: (seconds: number) => `Too many attempts. Try again in ${waitTime(seconds)}.`,
  job: "Job",
  stepOf: (step: string) => `step ${step}`,
});

/** Suspend and resume (`adminSuspendTenant`, `adminResumeTenant`; PADR-0014, PF-82). */
export const LIFECYCLE_STRINGS = Object.freeze({
  title: "Suspension",
  suspend: "Suspend",
  suspendTitle: (name: string) => `Suspend ${name}?`,
  suspendDescription:
    "The storefront and the OTA API answer that the OTA is suspended within 60 seconds, the OTA worker expires its open checkouts, and the owners get an e-mail. Paid bookings are still ticketed, and nothing is deleted.",
  suspendConfirm: "Suspend OTA",
  suspensionReasonLabel: "Kind of suspension",
  suspensionReasonHint:
    "Stored on the OTA and shown to its owners. Billing suspensions are set by billing sync only.",
  suspensionReasonInvalid:
    "Choose the kind of suspension: abuse, a request of the OTA, or a Velexis decision.",
  resume: "Resume",
  resumeTitle: (name: string) => `Resume ${name}?`,
  resumeDescription:
    "The storefront and the OTA API serve the OTA again within 60 seconds, and the owners get an e-mail.",
  resumeBillingDescription:
    "This OTA is suspended for billing: it can be resumed only while its subscription is in trial or active. Billing sync also resumes it on its own when the payment arrives.",
  resumeConfirm: "Resume OTA",
  /** Neither action applies to an OTA in set-up or whose set-up failed. */
  notApplicable: "Only an active OTA can be suspended, and only a suspended one resumed.",
  suspended: "The OTA is suspended.",
  resumed: "The OTA is active again.",
  newStatus: "Status now:",
  notActive: "Only an active OTA can be suspended. Reload the page to see its current status.",
  notSuspended: "Only a suspended OTA can be resumed. Reload the page to see its current status.",
  subscriptionNotActive:
    "This OTA is suspended for billing and its subscription is neither in trial nor active, so it cannot be resumed yet.",
});

/** Re-run the tenant migrations (`adminMigrateTenant`). */
export const MIGRATE_STRINGS = Object.freeze({
  title: "Tenant migrations",
  intro: (schemaVersion: string) => `The OTA's schema is at ${schemaVersion}.`,
  noSchema: "This OTA has no schema yet, so there is nothing to migrate.",
  targetVersionLabel: "Target version (optional)",
  targetVersionHint: "For example 0002_add_ticketing_queue. Leave it empty to apply every pending migration.",
  targetVersionInvalid:
    "Enter a migration version such as 0002_add_ticketing_queue, or leave the field empty.",
  migrate: "Migrate",
  migrateTitle: (name: string) => `Run the tenant migrations of ${name}?`,
  migrateAll:
    "A migrate job applies every pending tenant migration to the OTA's schema. Its result shows on the job; a failure never changes the OTA's status.",
  migrateTo: (version: string) =>
    `A migrate job applies the pending tenant migrations up to ${version} to the OTA's schema. Its result shows on the job; a failure never changes the OTA's status.`,
  migrateConfirm: "Start migration",
  started: "The migrate job is on its way to the OTA worker.",
  migrateJobActive: "A migrate job of this OTA is already queued or running. Wait until it ends.",
  schemaMissing: "This OTA has no schema yet, so there is nothing to migrate.",
});

/** Disable or enable a connection (`adminSetConnectionStatus`, **reason**). */
export const CONNECTION_STATUS_STRINGS = Object.freeze({
  disable: "Disable connection",
  enable: "Enable connection",
  /** Read after the button's text, so each button names its connection. */
  of: (connection: string) => ` (${connection})`,
  disableTitle: (connection: string) => `Disable the connection ${connection}?`,
  enableTitle: (connection: string) => `Enable the connection ${connection}?`,
  disableAmadeus:
    "Every Amadeus call of the OTA in this environment stops until the connection is enabled again: searches, bookings, and the ticketing of paid bookings too.",
  disablePayment: "The OTA can take no payment in this environment until the connection is enabled again.",
  enableDescription: "The OTA can use the connection again within 60 seconds.",
  disableConfirm: "Disable connection",
  enableConfirm: "Enable connection",
  statusNow: "The connection is now:",
  notDisabled: "This connection is not disabled, so it cannot be enabled. Reload the page to see its status.",
  /** `no_office`: a disabled Velexis connection without an office; this page offers "Assign office" only while pending. */
  noOffice:
    "This Amadeus connection has no office, so it cannot work again. Assign it an available office on the office pool page: that activates it.",
  deauthorized:
    "The OTA disconnected this Stripe account in Stripe, so the connection cannot work again until the OTA connects it in the portal.",
  connectionGone: "This OTA has no such connection any more. Reload the page.",
});

/** The internal notes and the legal name (`adminUpdateTenant`, `If-Match`). */
export const NOTES_STRINGS = Object.freeze({
  edit: "Edit notes and legal name",
  formTitle: "Edit notes and legal name",
  legalNameLabel: "Legal name",
  legalNameHint: "The legal entity of the OTA, used on invoices. Leave it empty to clear it.",
  legalNameTooLong: "Enter a legal name of at most 200 characters.",
  notesLabel: "Internal notes",
  notesHint: "Only Velexis staff see these notes. Leave the field empty to clear them.",
  notesTooLong: "Enter notes of at most 4,000 characters.",
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  saved: "The notes and the legal name are saved.",
  /** `412 PRECONDITION_FAILED`: the OTA changed since the page was loaded (flows/platform-admin-operations.md, "Stale page"). */
  stale:
    "Someone else changed this OTA since the page was loaded, so your edit was not saved. Reload the page to see the current notes and legal name, then edit them again. Copy your text first if you need it.",
});

/** Assign an office of the pool to an OTA whose Amadeus connection waits for one (`adminAssignAmadeusOffice`). */
export const ASSIGN_OFFICE_STRINGS = Object.freeze({
  title: "Assign an office",
  intro: (environment: string) =>
    `This connection waits for an office: the pool of ${environment} was empty when the OTA was set up. Assign an available office to activate it; the owners get an e-mail.`,
  officeLabel: "Office",
  officeHint: "An available office of the Velexis Amadeus account of this environment.",
  assign: "Assign office",
  assigning: "Assigning…",
  noneAvailable: "No office of this environment is available.",
  poolLink: "Add offices to the pool",
  unavailable: "The available offices could not be loaded. Reload the page, or open the office pool.",
  poolPage: "Open the office pool",
  assigned: (officeId: string) => `Office ${officeId} is assigned to the OTA.`,
  statusNow: "The connection is now:",
  officeInvalid: "Choose an office of the list.",
  officeUnavailable:
    "This office is no longer available: another OTA got it, or it was retired. Reload the page and choose another one.",
  tenantCredentials:
    "This OTA uses its own Amadeus credentials in this environment, so it needs no office of the pool.",
  officeAlreadyAssigned: "This OTA already has an office of this environment. Reload the page to see it.",
  notFound: "The office or the OTA no longer exists. Reload the page.",
});
