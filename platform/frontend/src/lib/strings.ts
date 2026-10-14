import type { PlatformErrorCode } from "@velexis/errors";

import type { AccountNavId, OtaNavId, TenantRole } from "@/lib/roles";

/**
 * The portal's user-facing text (English). Kept in one module so a translation can be added later (ADR-0014).
 * Messages never contain a value the person submitted, and never the raw message of an API answer.
 */

/** The message for an error code that the catalogue does not know (it should never be shown). */
export const UNKNOWN_ERROR_MESSAGE =
  "Something went wrong. Try again, and contact support if it keeps happening.";

/**
 * One message for every code of the platform API's error catalogue (`x-error-catalogue` of the platform
 * document, generated into `@velexis/errors`). A new code in the document fails `errors.test.ts` (and the type
 * check) until it has a message here.
 */
export const ERROR_MESSAGES: Readonly<Record<PlatformErrorCode, string>> = Object.freeze({
  VALIDATION_FAILED: "Some of the information is missing or not valid. Check the highlighted fields.",
  VERIFICATION_TOKEN_INVALID:
    "This verification link has expired or was already used. Request a new link from the sign-in page.",
  PASSWORD_RESET_TOKEN_INVALID:
    "This password reset link has expired or was already used. Request a new link.",
  INVITATION_INVALID:
    "This invitation has expired, was revoked or was already used. Ask for a new invitation.",
  CONNECT_STATE_INVALID: "The Stripe connection request expired. Start connecting again.",
  MFA_SETUP_EXPIRED: "The two-factor set-up expired. Start the set-up again.",
  WEBHOOK_SIGNATURE_INVALID: "The request could not be verified.",
  UNAUTHENTICATED: "Your session has ended. Sign in again.",
  TOKEN_EXPIRED: "Your session has ended. Sign in again.",
  INVALID_CREDENTIALS: "The e-mail address or password is not correct.",
  REFRESH_TOKEN_INVALID: "Your session has ended. Sign in again.",
  REFRESH_TOKEN_REUSED: "For your security, your session was ended. Sign in again.",
  MFA_CHALLENGE_INVALID: "The two-factor sign-in expired or had too many attempts. Sign in again.",
  MFA_CODE_INVALID: "The code is not correct. Check your authenticator app or recovery code and try again.",
  REAUTH_REQUIRED: "Enter a code from your authenticator app to continue.",
  FORBIDDEN: "You do not have permission to do this.",
  EMAIL_NOT_VERIFIED: "Verify your e-mail address first. Check your inbox for the verification link.",
  ACCOUNT_DISABLED: "This account is disabled. Contact Velexis support.",
  MFA_REQUIRED: "Turn on two-factor authentication in your account security settings first.",
  INVITATION_EMAIL_MISMATCH: "This invitation was sent to another e-mail address. Sign in with that address.",
  FEATURE_DISABLED: "This feature is not available yet, or your plan does not include it.",
  NOT_FOUND: "We could not find what you were looking for.",
  CONFLICT: "This cannot be done in the current state. Reload the page and try again.",
  IDEMPOTENCY_KEY_REUSED:
    "This request was already submitted with different details. Reload the page and try again.",
  TENANT_KEY_UNAVAILABLE: "This OTA key is not available. Choose another one.",
  TENANT_NOT_ACTIVE: "This OTA is not active. It may still be in set-up, suspended or failed.",
  PROVISIONING_NOT_RETRYABLE: "Only a failed set-up can be retried.",
  LAST_OWNER: "An OTA must keep at least one owner. Make someone else an owner first.",
  ALREADY_MEMBER: "This person is already a member of this OTA.",
  INVITATION_PENDING: "An invitation for this e-mail address is already waiting to be accepted.",
  DOMAIN_TAKEN: "This domain is already used by another OTA.",
  DOMAIN_NOT_VERIFIED: "Verify this domain first.",
  AMADEUS_OFFICE_UNAVAILABLE: "No Amadeus office is available right now. Contact Velexis support.",
  STRIPE_ACCOUNT_ALREADY_CONNECTED: "This Stripe account is already connected to another OTA.",
  SETTLEMENT_STATE_INVALID: "This statement does not allow that action in its current status.",
  MFA_ALREADY_ENABLED: "Two-factor authentication is already turned on.",
  KEYS_ALREADY_REVEALED:
    "The initial keys were already shown, or the 24 hours to show them have passed. Create new keys on the API keys page.",
  PRECONDITION_FAILED: "Someone else changed this in the meantime. Reload the page and try again.",
  PASSWORD_TOO_WEAK:
    "Choose a stronger password: at least 10 characters, and not a common or previously leaked password.",
  CURRENT_PASSWORD_INCORRECT: "Your current password is not correct.",
  PLAN_NOT_AVAILABLE: "This plan is not available with the chosen billing interval.",
  PLAN_LIMIT_REACHED: "Your plan's limit is reached. Upgrade the plan or remove something first.",
  LIVE_MODE_NOT_ENABLED: "Your OTA must be live first.",
  LIVE_PRECONDITIONS_UNMET: "Your OTA cannot go live yet. Complete the remaining steps of the checklist.",
  DOMAIN_INVALID: "Enter a valid public domain name that does not belong to Velexis.",
  PAYOUT_ACCOUNT_REQUIRED: "Add and verify a payout account first.",
  UNPROCESSABLE: "This request cannot be completed. Check the details and try again.",
  ACCOUNT_LOCKED: "Too many failed sign-in attempts. Wait a few minutes, then try again.",
  RATE_LIMITED: "Too many attempts. Wait a moment, then try again.",
  INTERNAL_ERROR: "Something went wrong on our side. Try again, and contact support if it keeps happening.",
  PROVIDER_ERROR: "An external service did not respond as expected. Try again later.",
  SERVICE_UNAVAILABLE: "Velexis is temporarily unavailable. Try again in a few minutes.",
});

// ---- App shell and shared components (PFE-003) ----------------------------------------------------------------

/** Membership roles (scope §1.2). */
export const ROLE_LABELS: Readonly<Record<TenantRole, string>> = Object.freeze({
  owner: "Owner",
  admin: "Admin",
  agent: "Agent",
  finance: "Finance",
  viewer: "Viewer",
});

/** Navigation entries of `lib/roles.ts`. */
export const NAV_LABELS: Readonly<Record<OtaNavId | AccountNavId, string>> = Object.freeze({
  overview: "Overview",
  apiKeys: "API keys",
  domains: "Domains",
  amadeus: "Amadeus",
  payments: "Payments",
  payoutAccount: "Payout account",
  settlements: "Settlements",
  team: "Team",
  billing: "Billing",
  settings: "Settings",
  goLive: "Go live",
  dashboard: "My OTAs",
  account: "Profile",
  security: "Security",
});

/** The signed-in shell: header, side navigation and OTA switcher. */
export const SHELL_STRINGS = Object.freeze({
  productName: "Velexis",
  navigationLabel: "Portal",
  accountSection: "Your account",
  otaSection: "This OTA",
  switcherLabel: "Switch OTA",
  switcherPlaceholder: "Choose an OTA",
  switcherMenuLabel: "Your OTAs",
  switcherAll: "All OTAs",
  switcherCreate: "Create an OTA",
  switcherEmpty: "You are not a member of any OTA yet.",
  signOut: "Sign out",
  unavailableTitle: "Your account could not be loaded",
});

/** `StepUpDialog`: a fresh TOTP code before a sensitive action (PADR-0008). */
export const STEP_UP_STRINGS = Object.freeze({
  title: "Confirm it is you",
  description:
    "This action needs a fresh code from your authenticator app. Enter the 6-digit code to continue.",
  codeLabel: "Authentication code",
  codeHint: "The 6-digit code your authenticator app shows now.",
  codeFormat: "Enter the 6 digits of the code from your authenticator app.",
  submit: "Confirm",
  submitting: "Checking…",
  cancel: "Cancel",
});

/** `SecretRevealPanel` and `CopyField`: values shown once (README §5). */
export const SECRET_STRINGS = Object.freeze({
  warningTitle: "Copy this now: it is shown only once",
  warning:
    "Velexis cannot show this again. Store it somewhere safe, such as a password manager, before you leave this page.",
  copy: "Copy",
  copied: "Copied to the clipboard.",
  copyFailed: "Copying did not work. Select the value and copy it yourself.",
  dismiss: "I have stored it",
  dismissed: "The value is hidden now and cannot be shown again.",
});

/** Forms: `FormErrorSummary`. */
export const FORM_STRINGS = Object.freeze({
  errorSummaryTitle: "There is a problem",
});

/** `ConfirmDialog`. */
export const CONFIRM_STRINGS = Object.freeze({
  cancel: "Cancel",
});

/** `DataTable`. */
export const TABLE_STRINGS = Object.freeze({
  empty: "Nothing to show yet.",
});

/** `TenantBanner`: suspension, billing notices and test mode (PADR-0014, ADR-0013). */
export const TENANT_BANNER_STRINGS = Object.freeze({
  label: "OTA notices",
  suspendedTitle: "This OTA is suspended",
  suspendedReasons: Object.freeze({
    billing:
      "A subscription payment failed. The storefront and the OTA admin are paused until the payment is made.",
    abuse: "Velexis suspended this OTA after a report of misuse. Contact Velexis support.",
    request: "This OTA was suspended at your request. Contact Velexis support to resume it.",
    admin: "Velexis suspended this OTA. Contact Velexis support for details.",
    unknown: "Contact Velexis support for details.",
  }),
  suspendedReadOnly: "Settings are read-only while the OTA is suspended.",
  billingLink: "Go to billing",
  pastDueTitle: "A payment failed",
  pastDue: "Update your payment details to keep your OTA running.",
  trialEndingTitle: "Your trial ends soon",
  trialEnding: "Choose a plan to keep your OTA running after the trial.",
  testModeTitle: "Test mode",
  testMode:
    "The storefront uses the Amadeus test system and Stripe test mode: bookings and payments are not real.",
});

/** `StatusBadge`: one label per status of each kind. */
export const STATUS_LABELS = Object.freeze({
  tenant: { provisioning: "Setting up", active: "Active", suspended: "Suspended", failed: "Set-up failed" },
  job: { queued: "Queued", running: "Running", succeeded: "Done", failed: "Failed", canceled: "Canceled" },
  jobStep: { succeeded: "Done", failed: "Failed", skipped: "Skipped" },
  amadeusConnection: {
    pending_verification: "Pending",
    active: "Active",
    invalid_credentials: "Invalid credentials",
    disabled: "Disabled",
  },
  paymentConnection: { pending: "Pending", active: "Active", disabled: "Disabled", error: "Error" },
  credentialSubmission: { pending: "Pending", verifying: "Verifying", failed: "Failed" },
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
  membership: { active: "Active", suspended: "Suspended", removed: "Removed" },
  invitation: { pending: "Pending", accepted: "Accepted", revoked: "Revoked", expired: "Expired" },
  settlement: {
    draft: "Draft",
    approved: "Approved",
    paid: "Paid",
    carried_forward: "Carried forward",
    void: "Void",
  },
});
