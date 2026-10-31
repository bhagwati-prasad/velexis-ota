import type { components as OtaComponents } from "@velexis/api-types";
import type { PlatformErrorCode } from "@velexis/errors";

import type { AccountNavId, OtaNavId, TenantRole } from "@/lib/roles";

/** `ConsoleApiKeyScope` and `StaffPermission` of the OTA contract (the scopes of a secret API key, PADR-0005). */
type ConsoleApiKeyScope = OtaComponents["schemas"]["ConsoleApiKeyScope"];
type StaffPermission = OtaComponents["schemas"]["StaffPermission"];

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
  payoutAccount: { pending_review: "Pending review", verified: "Verified", rejected: "Rejected" },
});

// ---- Sign-up and e-mail verification (PFE-005) ---------------------------------------------------------------

/** `/sign-up`: the sign-up form (PF-01). */
export const SIGN_UP_STRINGS = Object.freeze({
  title: "Create your Velexis account",
  intro: "Sign up to create your own OTA. After this step you verify your e-mail address.",
  fullNameLabel: "Full name",
  emailLabel: "E-mail address",
  emailHint: "We send a verification link to this address.",
  passwordLabel: "Password",
  passwordHint: "At least 10 characters. Avoid common passwords and passwords you use elsewhere.",
  termsBefore: "I accept the ",
  termsLink: "terms of service",
  termsBetween: " and the ",
  privacyLink: "privacy notice",
  submit: "Create account",
  submitting: "Creating your account…",
  haveAccount: "Already have an account?",
  signIn: "Sign in",
  fullNameRequired: "Enter your full name.",
  fullNameTooLong: "Enter a name of at most 200 characters.",
  emailRequired: "Enter your e-mail address.",
  emailInvalid: "Enter a valid e-mail address, like name@example.com.",
  passwordTooShort: "Use at least 10 characters.",
  passwordTooLong: "Use at most 256 characters.",
  passwordBreached: "This password is too common or has appeared in a data breach. Choose another one.",
  termsRequired: "Accept the terms of service and the privacy notice to create an account.",
  rateLimited: "Too many sign-ups from your network in the last hour. Try again later.",
});

/** `/sign-up/check-email`, `/verify-pending` and the "send a new link" form (PF-02). */
export const VERIFICATION_STRINGS = Object.freeze({
  checkEmailTitle: "Check your e-mail",
  checkEmailIntro:
    "We sent a message to the address you entered. Open the link in it within 24 hours to verify your address and activate your account.",
  checkEmailExisting:
    "If you already have an account with this address, the message explains how to sign in or reset your password instead.",
  checkEmailSpam: "Nothing after a few minutes? Check your spam folder, or ask for a new link below.",
  pendingTitle: "Verify your e-mail address",
  pendingSignedIn: "Before you can create an OTA, open the verification link we sent to",
  pendingSignedInHint:
    "The link works for 24 hours. Nothing arrived? Check your spam folder, or send a new link.",
  pendingAnonymous:
    "Open the verification link we sent when you signed up. If it expired or did not arrive, ask for a new one below.",
  verifiedTitle: "Your e-mail address is verified",
  verifiedIntro: "Your account is active. Continue to your dashboard to create your OTA.",
  continue: "Continue to your dashboard",
  tokenInvalid: "This verification link has expired or was already used. Ask for a new link below.",
  verifyUnavailable:
    "We could not check your link just now. Open the link in the e-mail again in a few minutes.",
  continueUnavailable: "We could not continue just now. Try again in a few minutes.",
  sessionUnavailable: "Your account could not be loaded right now. You can still ask for a new link.",
  resendTitle: "Need a new link?",
  resendEmailLabel: "E-mail address",
  resendEmailHint: "The address you signed up with.",
  resend: "Send a new link",
  resending: "Sending…",
  resentAnonymous:
    "If an account that still needs verifying uses this address, we sent a new link to it. The link works for 24 hours.",
  resentSignedIn: "We sent a new link. It works for 24 hours.",
  resendRateLimited:
    "You can ask for a new link 3 times per hour. Use the newest e-mail you received, or try again later.",
  signIn: "Sign in",
  backToSignIn: "Back to sign in",
  notYou: "Not your account?",
  signOut: "Sign out",
});

/** Counts in the portal's English: "1 API key", "10 API keys", "1,000 API keys". */
const COUNT_FORMAT = new Intl.NumberFormat("en");

function counted(count: number, one: string, other: string): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? one : other}`;
}

// ---- Sign-in, MFA, password reset and sign-out (PFE-006) -----------------------------------------------------

/**
 * A wait of `seconds` in words: whole seconds under a minute, otherwise minutes rounded up ("45 seconds",
 * "1 minute", "15 minutes"), so the person never tries again too early.
 */
export function waitTime(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  return whole < 60
    ? counted(whole, "second", "seconds")
    : counted(Math.ceil(whole / 60), "minute", "minutes");
}

/** `/sign-in`: e-mail and password (PF-03). */
export const SIGN_IN_STRINGS = Object.freeze({
  title: "Sign in to Velexis",
  intro: "Use the e-mail address and password of your Velexis account.",
  emailLabel: "E-mail address",
  passwordLabel: "Password",
  forgotPassword: "Forgot your password?",
  submit: "Sign in",
  submitting: "Signing in…",
  noAccount: "New to Velexis?",
  signUp: "Create an account",
  emailRequired: "Enter your e-mail address.",
  emailInvalid: "Enter a valid e-mail address, like name@example.com.",
  passwordRequired: "Enter your password.",
  passwordTooLong: "Enter a password of at most 256 characters.",
  /** `ACCOUNT_LOCKED` with the wait of its `Retry-After` header (PF-03 AC2). */
  lockedFor: (seconds: number) =>
    `Too many failed sign-in attempts. Your account is locked: try again in ${waitTime(seconds)}, or reset your password.`,
  rateLimited: "Too many sign-in attempts from your network. Wait a minute, then try again.",
  verified: "Your e-mail address is verified. Sign in to continue.",
  passwordChanged:
    "Your password is changed and every session of your account was signed out. Sign in with your new password.",
  signedOut: "You are signed out.",
});

/** `/sign-in/mfa`: the second step of a sign-in with MFA (PF-04 AC2). */
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
  lostDevice: "Lost your device and your recovery codes? Contact Velexis support to regain access.",
  /** `RATE_LIMITED` of verifyMfa (10 attempts per account per 10 minutes), with the wait of `Retry-After`. */
  rateLimitedFor: (seconds: number) => `Too many codes were tried. Try again in ${waitTime(seconds)}.`,
});

/** `/forgot-password` and `/reset-password` (PF-05). */
export const PASSWORD_RESET_STRINGS = Object.freeze({
  forgotTitle: "Reset your password",
  forgotIntro: "Enter the e-mail address of your account. We send you a link to choose a new password.",
  emailLabel: "E-mail address",
  requestSubmit: "Send the reset link",
  requestSubmitting: "Sending…",
  /** The same confirmation for every address (PF-05 AC1): it never says whether an account exists. */
  sent: "If an account uses this address, we sent it a link to choose a new password. The link works for 1 hour, once. Nothing arrived after a few minutes? Check your spam folder.",
  requestRateLimited:
    "You can ask for 3 reset links per hour. Use the newest e-mail you received, or try again later.",
  backToSignIn: "Back to sign in",
  resetTitle: "Choose a new password",
  resetIntro:
    "Choose a new password for your Velexis account. Saving it signs out every session of your account, on every device.",
  newPasswordLabel: "New password",
  newPasswordHint: "At least 10 characters. Avoid common passwords and passwords you use elsewhere.",
  resetSubmit: "Save the new password",
  resetSubmitting: "Saving…",
  linkMissingTitle: "Open the link from your e-mail",
  linkMissing:
    "To choose a new password, open the link in the password reset e-mail. A link works for 1 hour and only once; if yours expired, ask for a new one.",
  requestNewLink: "Ask for a new link",
});

/**
 * The page `middleware.ts` answers to a link with `?token=` (`/reset-password?token=…`): it moves on to the page
 * without the token at once, and shows this link only to a browser that does not follow the refresh.
 */
export const TOKEN_LINK_STRINGS = Object.freeze({
  title: "Velexis",
  continue: "Continue to Velexis",
});

// ---- Public pages: landing, pricing and legal (PFE-004) ------------------------------------------------------

/** The header and footer of the public pages (`(marketing)/layout.tsx`). */
export const MARKETING_STRINGS = Object.freeze({
  productName: "Velexis",
  homeLink: "Velexis home",
  navigationLabel: "Main",
  pricing: "Pricing",
  signIn: "Sign in",
  getStarted: "Get started",
  footerLabel: "Legal",
  terms: "Terms of service",
  privacy: "Privacy notice",
  footerNote: "Velexis: online travel agencies, ready to sell flights.",
});

/** `/`: the landing page (scope §2.2). */
export const LANDING_STRINGS = Object.freeze({
  eyebrow: "Velexis",
  title: "Your own online travel agency, ready to sell flights.",
  intro:
    "Create an OTA, connect Amadeus and Stripe, and open a hosted storefront for your customers, all from one portal.",
  getStarted: "Get started",
  seePricing: "See pricing",
  stepsTitle: "From sign-up to your first booking",
  steps: Object.freeze([
    Object.freeze({
      title: "Create your OTA",
      text: "Sign up, verify your e-mail address and choose a name and a key for your OTA. Velexis sets up its storefront, its OTA admin and its test keys for you.",
    }),
    Object.freeze({
      title: "Connect flights and payments",
      text: "Every OTA starts with an Amadeus test office and Stripe test mode, so you can search, book and pay before anything is real.",
    }),
    Object.freeze({
      title: "Sell on your storefront",
      text: "Your customers search, book and pay on your own storefront, while you manage bookings, markups and branding in the OTA admin.",
    }),
  ]),
  featuresTitle: "What every OTA gets",
  features: Object.freeze([
    Object.freeze({
      title: "Flights from Amadeus",
      text: "Flight search, pricing and booking through Amadeus, with your own markups and fees.",
    }),
    Object.freeze({
      title: "Payments with Stripe",
      text: "Card payments through Stripe, collected by Velexis for you or in your own Stripe account.",
    }),
    Object.freeze({
      title: "A storefront in your name",
      text: "A hosted storefront on its own address with your branding, or your own front end built on the Velexis API and SDK.",
    }),
    Object.freeze({
      title: "Your team, with roles",
      text: "Invite owners, admins, agents, finance staff and viewers, each with the access their role needs.",
    }),
  ]),
  closingTitle: "Ready to open your OTA?",
  closingText:
    "Every OTA starts in test mode: the Amadeus test system and Stripe test mode, so no booking or payment is real until you go live.",
});

/** `/pricing`: the public plans of `listPlans` (PF-70). */
export const PRICING_STRINGS = Object.freeze({
  title: "Pricing",
  intro:
    "Choose the plan for your OTA. Every plan comes with a hosted storefront, the OTA admin and test mode, so you can try everything before you go live.",
  plansLabel: "Plans",
  monthly: "Monthly",
  perMonth: "per month",
  annual: "Annual",
  perYear: "per year",
  noAnnual: "Monthly billing only",
  trial: "Free trial",
  trialDays: (days: number) => counted(days, "day", "days"),
  noTrial: "None",
  includedTitle: "Included",
  staffSeats: (seats: number) => `Up to ${counted(seats, "team member", "team members")}`,
  apiKeys: (keys: number) => counted(keys, "API key", "API keys"),
  customDomains: (domains: number) =>
    domains === 0 ? "No custom domains" : counted(domains, "custom domain", "custom domains"),
  liveMode: "Live bookings and payments",
  testModeOnly: "Test mode only",
  start: "Start",
  /** Read after "Start" by screen readers only, so each plan's link has its own name. */
  startWith: (planName: string) => ` with ${planName}`,
  empty: "No plans are open for sign-up right now. Check back soon.",
  unavailableTitle: "The plans could not be loaded",
  signUpAnyway: "You can still create your account now.",
  signUp: "Create your account",
});

/** One section of a legal page. */
export interface LegalSection {
  readonly title: string;
  readonly text: string;
}

/** `/legal/terms` and `/legal/privacy`: static legal pages, versioned by `termsVersion` of `lib/terms.ts`. */
export const LEGAL_STRINGS = Object.freeze({
  version: (version: string) => `Version ${version}`,
  placeholderTitle: "Placeholder text",
  placeholder:
    "This page holds placeholder text. The final text will be published here before Velexis opens to the public, under a new version.",
  termsTitle: "Terms of service",
  termsIntro:
    "These terms govern the use of the Velexis portal, the OTA admin, the hosted storefront and the Velexis API by the people and companies who create an OTA with Velexis.",
  termsSections: Object.freeze<readonly LegalSection[]>([
    {
      title: "Your account",
      text: "Placeholder: who may create an account, how to keep it secure, and what happens when it is disabled.",
    },
    {
      title: "Your OTA and your customers",
      text: "Placeholder: your responsibilities towards the travellers who book on your storefront, and what Velexis provides.",
    },
    {
      title: "Plans, trials and billing",
      text: "Placeholder: how plans, free trials, invoices and cancellations work.",
    },
    {
      title: "Acceptable use",
      text: "Placeholder: what an OTA may not do with Velexis, Amadeus and Stripe, and when Velexis may suspend an OTA.",
    },
    {
      title: "Liability",
      text: "Placeholder: the limits of each party's liability.",
    },
    {
      title: "Changes to these terms",
      text: "Placeholder: how Velexis announces a new version, and when it applies.",
    },
  ]),
  privacyTitle: "Privacy notice",
  privacyIntro:
    "This notice explains which personal data Velexis processes when you use the portal, and why.",
  privacySections: Object.freeze<readonly LegalSection[]>([
    {
      title: "What we collect",
      text: "Placeholder: account data (name, e-mail address), security data (sessions, sign-in attempts) and the data of your OTA.",
    },
    {
      title: "Why we use it",
      text: "Placeholder: the purposes and legal bases of each kind of processing.",
    },
    {
      title: "Who we share it with",
      text: "Placeholder: the processors Velexis relies on, such as payment, flight content and e-mail providers.",
    },
    {
      title: "How long we keep it",
      text: "Placeholder: the retention period of each kind of data.",
    },
    {
      title: "Your rights",
      text: "Placeholder: how to access, correct, export or delete your data, and how to complain.",
    },
  ]),
});

// ---- Dashboard and the create-OTA wizard (PFE-008) -----------------------------------------------------------

/** `/dashboard`: the OTAs of the signed-in account (README §2 Signed in). */
export const DASHBOARD_STRINGS = Object.freeze({
  title: "My OTAs",
  intro: "Every OTA you are a member of, with its status, its plan and your role in it.",
  createOta: "Create an OTA",
  listLabel: "Your OTAs",
  key: "Key",
  plan: "Plan",
  role: "Your role",
  storefront: "Storefront",
  testMode: "Test mode",
  emptyTitle: "You have no OTA yet",
  empty:
    "Create your first OTA: choose its name and key, and Velexis sets up its storefront, its OTA admin and its test keys. Every OTA starts in test mode.",
  emptyInvited: "Invited to someone else's OTA? Open the link in the invitation e-mail.",
  verifyFirst: "Verify your e-mail address before you create an OTA.",
  verifyLink: "Verify your e-mail address",
  unavailableTitle: "Your OTAs could not be loaded",
});

/** The steps of the create-OTA wizard, in order. */
export const WIZARD_STEP_LABELS = Object.freeze({
  details: "OTA details",
  plan: "Plan",
  review: "Review",
});

/** `/otas/new`: the create-OTA wizard (PF-10). */
export const WIZARD_STRINGS = Object.freeze({
  title: "Create an OTA",
  intro:
    "Three short steps: your OTA's details, its plan and a last check. Your OTA starts in test mode, so no booking or payment is real until you go live.",
  progressLabel: "Steps",
  stepOf: (step: number, total: number) => `Step ${step} of ${total}`,
  nameLabel: "OTA name",
  nameHint: "The name your customers see. You can change it later.",
  nameRequired: "Enter a name for your OTA.",
  nameTooLong: "Use at most 100 characters for the name.",
  keyLabel: "OTA key",
  keyHint:
    "3 to 30 lower-case letters and digits, starting with a letter. It is part of your storefront address and cannot be changed later.",
  keyRequired: "Enter a key for your OTA.",
  keyInvalid: "Use 3 to 30 lower-case letters (a–z) and digits, starting with a letter.",
  /** The storefront address the key gets: `<key>.<STOREFRONT_BASE_DOMAIN>`. */
  keyAddress: (host: string) => `Storefront address: ${host}`,
  keyPlaceholder: "yourkey",
  keyChecking: "Checking whether this key is free…",
  keyAvailable: "This key is available.",
  keyTaken: "This key is taken: another OTA already uses it. Choose another one.",
  keyReserved: "This key is reserved by Velexis. Choose another one.",
  keyUnchecked: "This key could not be checked just now. It is checked again when you create the OTA.",
  keyUnavailable:
    "This key is not available any more: another OTA took it in the meantime, or it is reserved. Choose another one.",
  countryLabel: "Country",
  countryHint: "Where your business is registered. You can change it later.",
  countryPlaceholder: "Choose a country",
  countryRequired: "Choose the country of your business.",
  countryUnknown: "Choose a country from the list.",
  currencyLabel: "Default currency",
  currencyHint: "The currency your storefront sells in. It cannot be changed later.",
  currencyPlaceholder: "Choose a currency",
  currencyRequired: "Choose the default currency of your OTA.",
  currencyUnknown: "Choose a currency from the list.",
  timeZoneLabel: "Time zone",
  timeZoneHint: "For the dates and times of your OTA admin. You can change it later.",
  timeZonePlaceholder: "Choose a time zone",
  timeZoneRequired: "Choose the time zone of your OTA.",
  timeZoneUnknown: "Choose a time zone from the list.",
  planLegend: "Choose a plan",
  earlyAccessOnly:
    "While Velexis is in early access, every new OTA starts on the early access plan. When paid plans open, you choose one on the billing page.",
  plansUnavailable:
    "The plan details could not be loaded just now. Your OTA starts on the early access plan all the same.",
  plansMissing: "The plans could not be loaded just now. Reload the page to try again.",
  planRequired: "Choose a plan.",
  price: "Price",
  perMonth: "per month",
  reviewIntro:
    "Check the details before you create the OTA. The key and the default currency cannot be changed afterwards.",
  storefrontAddress: "Storefront address",
  change: "Change",
  /** Read after "Change" by screen readers only, so each button has its own name. */
  changeWhat: (what: string) => ` ${what}`,
  back: "Back",
  next: "Continue",
  submit: "Create OTA",
  submitting: "Creating your OTA…",
  /** `UNPROCESSABLE` with `details.reason = "tenant_limit"` (PF-10 AC4), with `details.limit` when the API sent it. */
  tenantLimit: (limit: number | undefined) =>
    limit === undefined
      ? "You already own the most OTAs one account can have. An OTA whose set-up failed does not count. Contact Velexis support if you need more."
      : `You already own ${counted(limit, "OTA", "OTAs")}, the most one account can have. An OTA whose set-up failed does not count. Contact Velexis support if you need more.`,
  formExpired: "This form has expired. Reload the page and try again.",
  rateLimited: "Too many requests in a short time. Wait a minute, then try again.",
});

// ---- The set-up page (PFE-009) -------------------------------------------------------------------------------

/**
 * The set-up steps of `getProvisioning`, in the order they run: the OTA worker's, then the platform's post-steps
 * (platform/docs/flows/provisioning.md §2 and §3). A step the portal does not know yet shows its own name.
 */
export const SETUP_STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  create_schema: "Create the OTA's database",
  run_migrations: "Build the database tables",
  seed_defaults: "Add the default settings",
  record_migrations: "Record the database version",
  assign_amadeus_office: "Connect an Amadeus test office",
  create_payment_connection: "Set up Stripe test payments",
  issue_api_keys: "Create the test API keys",
  activate: "Activate the OTA",
  notify: "Send the welcome e-mail",
});

/** `/otas/[tenantId]/setup` and `ProvisioningProgress` (PF-11). */
export const SETUP_STRINGS = Object.freeze({
  title: "OTA set-up",
  intro:
    "Velexis builds your OTA: its database, an Amadeus test office, Stripe test payments and its test API keys. This usually takes less than a minute. You can leave this page and come back.",
  stepsTitle: "Set-up steps",
  stepRunning: "In progress",
  stepWaiting: "Waiting",
  stepNotRun: "Not run",
  /** The live summary of the progress, announced when it changes. */
  summaryQueued: "Waiting for the set-up to start.",
  summaryRunning: (done: number, total: number) => `Setting up your OTA: ${done} of ${total} steps done.`,
  summaryRetrying: (attempt: number, maxAttempts: number) =>
    `Attempt ${attempt} of ${maxAttempts} did not finish. Velexis tries again automatically in a moment.`,
  summaryActive: "Your OTA is ready.",
  summaryFailed: "The set-up failed.",
  summaryCanceled: "The set-up was canceled.",
  summarySuspended: "This OTA is suspended.",
  pollFailed: "The progress could not be refreshed just now. Trying again…",
  pollStoppedTitle: "The progress could not be loaded",
  readyTitle: "Your OTA is ready",
  readyText:
    "Your storefront runs in test mode: bookings and payments are not real until your OTA goes live.",
  storefrontLink: "Open your storefront",
  dashboardLink: "Go to the OTA dashboard",
  keysTitle: "Test API keys",
  keysIntro:
    "During the set-up Velexis created a publishable and a secret test key for your OTA. They can be shown once, within 24 hours of the set-up.",
  reveal: "Reveal the test keys",
  revealing: "Revealing…",
  revealedTitle: "Your test API keys",
  revealedHint:
    "The publishable key goes into your storefront's browser code; keep the secret key on your server.",
  publishableKeyLabel: "Publishable test key",
  secretKeyLabel: "Secret test key",
  apiKeysLink: "Go to API keys",
  keysOwnerOnly: "An owner of this OTA can reveal the test API keys made during the set-up.",
  failedTitle: "The set-up failed",
  /** The step the set-up stopped at, by its label. */
  failedAt: (step: string) => `It stopped at the step “${step}”.`,
  failedAttempts: (attempt: number, maxAttempts: number) => `Attempts made: ${attempt} of ${maxAttempts}.`,
  failedHelp: "Velexis has been told and is looking into it.",
  failedReference: (jobId: string) => `Reference for support: ${jobId}`,
  retry: "Retry the set-up",
  retrying: "Starting a new attempt…",
  retryHint: "A retry starts a new set-up attempt and shows its progress here.",
  retryOwnerOnly: "Only an owner of this OTA can retry the set-up.",
  canceledText: "Contact Velexis support to finish the set-up of this OTA.",
  suspendedText: "The OTA dashboard has the details.",
  unavailableTitle: "The set-up could not be loaded",
});

// ---- OTA dashboard, onboarding checklist and settings (PFE-010) ----------------------------------------------

/** `otas/[tenantId]/layout.tsx` and the pages below it (README §2 Signed in). */
export const OTA_STRINGS = Object.freeze({
  unavailableTitle: "This OTA could not be loaded",
});

/** `/otas/[tenantId]`: the OTA dashboard (README §2, PF-12). */
export const OTA_DASHBOARD_STRINGS = Object.freeze({
  intro: "The status of your OTA, its storefront and the steps that are left before your first booking.",
  detailsLabel: "About this OTA",
  key: "Key",
  role: "Your role",
  defaultCurrency: "Default currency",
  editProfile: "Edit the OTA profile",
  storefrontTitle: "Storefront",
  storefrontIntro: "Where your customers search, book and pay.",
  storefrontPending: "The storefront opens when the set-up is done.",
  setupInProgress: "Velexis is still setting up this OTA.",
  setupFailed: "The set-up of this OTA failed.",
  setupLink: "Open the set-up page",
  checklistUnavailableTitle: "The checklist could not be loaded",
});

/** `OnboardingChecklist`: the items of `getOnboarding` (PADR-0018, PF-12). */
export const ONBOARDING_STRINGS = Object.freeze({
  title: "Get your OTA ready",
  intro: "The steps from set-up to your first booking. Each one links to the page where you do it.",
  progress: (done: number, total: number) =>
    `${COUNT_FORMAT.format(done)} of ${COUNT_FORMAT.format(total)} done`,
  done: "Done",
  toDo: "To do",
  allDone: "Every step is done. Your OTA is ready.",
  empty: "There is nothing to do right now.",
});

/** `NotAllowed`: a page of an OTA that the caller's role may not open (scope §1.2). */
export const NOT_ALLOWED_STRINGS = Object.freeze({
  title: "You cannot open this page",
  /** The caller's role in words (`ROLE_LABELS`). */
  intro: (role: string) => `Your role in this OTA is ${role}, and this page is not part of it.`,
  askOwner: "If you need it, ask an owner or an admin of this OTA to change your role.",
  backToOverview: "Back to the OTA overview",
});

/** `/otas/[tenantId]/settings`: the OTA profile (PF-13). */
export const SETTINGS_STRINGS = Object.freeze({
  title: "OTA settings",
  intro:
    "The profile of your OTA. The storefront's branding and currencies are set in the OTA admin, not here.",
  profileLegend: "Profile",
  nameLabel: "OTA name",
  nameHint: "The name your customers see.",
  nameRequired: "Enter a name for your OTA.",
  nameTooLong: "Use at most 100 characters for the name.",
  legalNameLabel: "Legal name",
  legalNameHint:
    "The company behind the OTA, as it appears on invoices. Leave it empty if there is none yet.",
  legalNameTooLong: "Use at most 200 characters for the legal name.",
  supportEmailLabel: "Support e-mail address",
  supportEmailHint: "Where your customers can reach you. Leave it empty if there is none yet.",
  supportEmailInvalid: "Enter a valid e-mail address, like support@example.com.",
  countryLabel: "Country",
  countryHint: "Where your business is registered.",
  countryPlaceholder: "Choose a country",
  countryRequired: "Choose the country of your business.",
  countryUnknown: "Choose a country from the list.",
  timeZoneLabel: "Time zone",
  timeZoneHint: "For the dates and times of your OTA admin.",
  timeZoneRequired: "Choose the time zone of your OTA.",
  timeZoneUnknown: "Choose a time zone from the list.",
  fixedTitle: "Set when the OTA was created",
  fixedIntro: "These cannot be changed.",
  keyLabel: "OTA key",
  keyHint: "Part of the storefront address.",
  currencyLabel: "Default currency",
  currencyHint: "The currency the storefront sells in.",
  submit: "Save changes",
  submitting: "Saving…",
  saved: "The profile is saved.",
  readOnlyTitle: "The profile cannot be changed right now",
  /** Why the profile is read-only, for each status but `active` (only an active OTA can be edited). */
  readOnly: Object.freeze({
    provisioning: "Velexis is still setting up this OTA. You can change its profile once the set-up is done.",
    suspended: "This OTA is suspended, so its profile is read-only until it is resumed.",
    failed: "The set-up of this OTA failed, so its profile cannot be changed.",
  }),
  notActive: "This OTA is not active any more, so its profile cannot be changed. Reload the page to see why.",
  stale:
    "Someone else changed this profile in the meantime. Reload the page to see their changes, then make yours again.",
  reload: "Reload the page",
  forbidden: "Your role in this OTA does not allow changing its profile any more. Reload the page.",
  removed: "You are not a member of this OTA any more.",
  formExpired: "This form has expired. Reload the page and try again.",
  rateLimited: "Too many changes in a short time. Wait a minute, then try again.",
});

// ---- API keys (PFE-011) ----------------------------------------------------------------------------------------

/** The environments of a key, as its tab and its texts name them. */
const KEY_ENVIRONMENT_WORDS: Readonly<Record<"test" | "live", string>> = Object.freeze({
  test: "test",
  live: "live",
});

/** The kinds of a key (`ApiKeyKind` of the platform document). */
export const API_KEY_KIND_LABELS: Readonly<Record<"publishable" | "secret", string>> = Object.freeze({
  publishable: "Publishable",
  secret: "Secret",
});

/** The uses of a secret key: the `ConsoleApiKeyScope` values of the OTA contract (PADR-0005 item 6). */
export const API_KEY_SCOPE_STRINGS: Readonly<
  Record<ConsoleApiKeyScope, { readonly label: string; readonly hint: string }>
> = Object.freeze({
  storefront: Object.freeze({
    label: "Storefront",
    hint: "Customer operations only: search, book and pay. Every console operation refuses the key, even with a staff token. For the server of a storefront.",
  }),
  console: Object.freeze({
    label: "Console with a staff token",
    hint: "Console operations for a staff member who signed in: their role decides what they may do. For a back office of your own.",
  }),
  "console:automation": Object.freeze({
    label: "Console automation",
    hint: "Console operations without a staff token, with exactly the permissions you choose below. For one job or integration.",
  }),
});

/** The `StaffPermission` values of the OTA contract, in words; a new value fails the type check until it has one. */
export const STAFF_PERMISSION_LABELS: Readonly<Record<StaffPermission, string>> = Object.freeze({
  "bookings:read": "Read bookings",
  "bookings:write": "Change bookings",
  "bookings:issue": "Issue tickets",
  "bookings:cancel": "Cancel bookings",
  "customers:read": "Read customers",
  "queues:read": "Read the work queues",
  "supplier_requests:read": "Read the supplier request log",
  "amadeus:read": "Read the Amadeus settings",
  "amadeus:write": "Change the Amadeus settings",
  "settings:read": "Read the OTA settings",
  "settings:write": "Change the OTA settings",
  "payments:read": "Read payments",
  "payments:capture": "Capture payments",
  "payments:refund": "Refund payments",
});

/** How long the old key keeps working after a roll (`expireOldIn` of `rollApiKey`). */
export const ROLL_EXPIRY_LABELS: Readonly<Record<"now" | "1h" | "24h" | "7d", string>> = Object.freeze({
  now: "Now: the old key stops working at once",
  "1h": "In 1 hour",
  "24h": "In 24 hours",
  "7d": "In 7 days",
});

/** The optional expiry of a new key. */
export const KEY_EXPIRY_LABELS: Readonly<Record<"never" | "7d" | "30d" | "90d" | "365d", string>> =
  Object.freeze({
    never: "No expiry",
    "7d": "In 7 days",
    "30d": "In 30 days",
    "90d": "In 90 days",
    "365d": "In 1 year",
  });

/** `/otas/[tenantId]/api-keys`: the API keys of an OTA (PF-30). */
export const API_KEYS_STRINGS = Object.freeze({
  title: "API keys",
  intro:
    "Keys for the Velexis booking API, for your own storefront, back office or automation. Each key is shown once, when it is created or rolled; Velexis keeps only a fingerprint of it.",
  environmentsLabel: "Environment",
  /** The tab of an environment's keys. */
  tab: (environment: "test" | "live") => (environment === "test" ? "Test keys" : "Live keys"),
  listTitle: (environment: "test" | "live") => (environment === "test" ? "Test keys" : "Live keys"),
  listIntro:
    "“Last used” comes from the booking API and can be up to 5 minutes behind. Revoked keys stay listed, because the audit log refers to them.",
  listCaption: (environment: "test" | "live") => `${KEY_ENVIRONMENT_WORDS[environment]} API keys`,
  empty: "There is no key yet. Create one below.",
  listUnavailableTitle: "The keys could not be loaded",
  readOnlyTitle: "The keys cannot be changed right now",
  /** Why the keys are read-only, for each status but `active` (PADR-0014 item 5). */
  readOnly: Object.freeze({
    provisioning:
      "Velexis is still setting up this OTA. You can create and change keys once the set-up is done.",
    suspended:
      "This OTA is suspended, so its keys are read-only until it is resumed. The keys stay valid, but the booking API refuses requests while the OTA is suspended.",
    failed: "The set-up of this OTA failed, so it has no keys to change.",
  }),
  // The table
  columnName: "Name",
  columnKind: "Kind",
  columnKey: "Key",
  columnAccess: "Access",
  columnCreated: "Created",
  columnLastUsed: "Last used",
  columnExpires: "Expires",
  columnStatus: "Status",
  columnActions: "Actions",
  /** The visible part of a key: its prefix and its last four characters. */
  maskedKey: (prefix: string, last4: string) => `${prefix}…${last4}`,
  noOrigins: "No browser origin: works only from a server",
  createdBy: (fullName: string) => `by ${fullName}`,
  createdAtSetup: "at set-up",
  neverUsed: "Never",
  noExpiry: "No expiry",
  stateActive: "Active",
  stateExpired: "Expired",
  stateRevoked: "Revoked",
  edit: "Edit",
  roll: "Roll",
  revoke: "Revoke",
  /** Read after the action's name by screen readers only, so each row's buttons have their own names. */
  actionTarget: (name: string, masked: string) => ` ${name} (${masked})`,
  // Create
  createTitle: (environment: "test" | "live") => `Create a ${KEY_ENVIRONMENT_WORDS[environment]} key`,
  createIntro:
    "Choose a publishable key for code that runs in a browser, or a secret key for a server. Kind and access cannot change later: roll or create a new key instead.",
  nameLabel: "Name",
  nameHint: "For you and your team, such as “Storefront production”.",
  nameRequired: "Enter a name for the key.",
  nameTooLong: "Use at most 100 characters for the name.",
  kindLegend: "Kind",
  kindSecret: "Secret key",
  kindSecretHint: "For servers only (sk_). Never put it in a browser or an app.",
  kindPublishable: "Publishable key",
  kindPublishableHint:
    "Safe in a browser (pk_): it can only search, book and pay as a customer, and only from the origins you list.",
  kindRequired: "Choose the kind of key.",
  expiryLabel: "Expiry",
  expiryHint: "Optional. The key stops working at that time; you can roll it before.",
  expiryInvalid: "Choose an expiry from the list.",
  submit: "Create the key",
  submitting: "Creating the key…",
  createdTitle: (kind: "publishable" | "secret", environment: "test" | "live") =>
    `Your new ${API_KEY_KIND_LABELS[kind].toLowerCase()} ${KEY_ENVIRONMENT_WORDS[environment]} key`,
  createdKeyLabel: (name: string) => `Key “${name}”`,
  createdListed: (masked: string) => `In the list it shows as ${masked}.`,
  recommendedTitle: "Recommended set-ups",
  recommended: Object.freeze([
    "A storefront deployment: a secret key scoped Storefront, on the storefront's server.",
    "A back office of your own: a secret key scoped Console with a staff token; staff sign in, and their role decides what they may do.",
    "Each automation job: its own secret key scoped Console automation, with the fewest permissions the job needs.",
    "Code in a browser: a publishable key that lists the exact origins of your site.",
  ]),
  // Origins
  originsLegend: "Allowed origins",
  originsHint: (environment: "test" | "live") =>
    environment === "test"
      ? "The exact addresses of the sites that may use the key from a browser, such as https://www.example.com. On test keys http://localhost:<port> and http://127.0.0.1:<port> work too. At most 20. With none, the key works only without a browser (from a server)."
      : "The exact addresses of the sites that may use the key from a browser, such as https://www.example.com (https only). At most 20. With none, the key works only without a browser (from a server).",
  originLabel: (position: number) => `Origin ${position}`,
  addOrigin: "Add an origin",
  removeOrigin: "Remove",
  /** Read after "Remove" by screen readers only. */
  removeOriginTarget: (position: number) => ` origin ${position}`,
  originWildcard: "Wildcards are not allowed: list each origin exactly, like https://www.example.com.",
  originInvalid:
    "Enter an origin only: the scheme and the host, with a port if needed, and nothing after it (no path or trailing slash).",
  originInsecure: (environment: "test" | "live") =>
    environment === "test"
      ? "Use https. Plain http works only for http://localhost:<port> and http://127.0.0.1:<port>."
      : "Use https: live keys accept https origins only.",
  originNotCanonical:
    "Write the origin as a browser sends it: in lower case, without the default port and without a trailing slash.",
  originDuplicate: "This origin is listed twice.",
  originsTooMany: "List at most 20 origins.",
  // Scopes
  scopesLegend: "What the key may do",
  scopesHint: "These cannot change later. Choose the least the key needs.",
  permissionsLegend: "Permissions",
  permissionsHint: "Only for Console automation: the key acts with exactly these permissions, nothing more.",
  permissionsWithoutAutomation:
    "Permissions apply only to Console automation keys. Choose Console automation, or clear the permissions.",
  automationNeedsPermission: "Choose at least one permission for a Console automation key.",
  scopeRequired: "Choose what the key may do.",
  scopeCombination:
    "This combination is not allowed. Choose one use and, for Console automation, its permissions.",
  scopeUnknown: "One of the chosen permissions is not known. Reload the page and try again.",
  // Edit
  editTitle: (name: string) => `Edit “${name}”`,
  editIntro:
    "You can change the name and, for a publishable key, its origins. Kind and access stay as they are.",
  editSubmit: "Save changes",
  editSubmitting: "Saving…",
  saved: "The key is saved.",
  cancel: "Cancel",
  // Roll
  rollTitle: (name: string) => `Roll “${name}”`,
  rollIntro:
    "Rolling creates a new key with the same name, kind and access, shown once, and sets when the old key stops working, so you can switch your deployments without downtime.",
  rollLegend: "The old key stops working",
  rollSubmit: "Roll the key",
  rollSubmitting: "Rolling…",
  rolledTitle: (name: string) => `The new key for “${name}”`,
  rolledKeyLabel: (kind: "publishable" | "secret") => `New ${API_KEY_KIND_LABELS[kind].toLowerCase()} key`,
  /** The old key's expiry after a roll; `at` is the formatted `previous.expiresAt`. */
  oldKeyStopped: (masked: string) => `The old key ${masked} stopped working at `,
  oldKeyWorksUntil: (masked: string) => `The old key ${masked} keeps working until `,
  oldKeySwitch: "Switch your deployments to the new key before then.",
  // Revoke
  revokeTitle: (name: string) => `Revoke “${name}”?`,
  revokeDescription: (masked: string) =>
    `Requests with ${masked} stop working within a minute. A revoked key can never be used again: create a new key if you need one.`,
  revokeConfirm: "Revoke the key",
  revoking: "Revoking…",
  revoked: "The key is revoked.",
  // Failures
  planLimit: (limit: number | undefined, used: number | undefined) =>
    limit === undefined
      ? "Your plan's limit of API keys is reached. Revoke a key you no longer need, or upgrade the plan."
      : `Your plan allows ${counted(limit, "working API key", "working API keys")}${used === undefined ? "" : `, and ${COUNT_FORMAT.format(used)} ${used === 1 ? "is" : "are"} in use`}. Keys that are revoked or expired do not count. Revoke a key you no longer need, or upgrade the plan.`,
  rollPlanLimit: (limit: number | undefined) =>
    `While the old key keeps working, both keys count against your plan${limit === undefined ? "" : `'s ${counted(limit, "key", "keys")}`}. Roll with “Now”, or revoke a key you no longer need first.`,
  revokedMeanwhile: "This key was revoked in the meantime, so it cannot be changed. Reload the page.",
  notActive: "This OTA is not active any more, so its keys cannot be changed. Reload the page to see why.",
  forbidden: "Your role in this OTA does not allow managing its API keys any more. Reload the page.",
  removed: "This key or this OTA is not available to you any more. Reload the page.",
  formExpired: "This form has expired. Reload the page and try again.",
  rateLimited: "Too many changes in a short time. Wait a minute, then try again.",
});

// ---- The team page and invitation acceptance (PFE-012) ------------------------------------------------------

/** `/otas/[tenantId]/team`, `MembersTable` and `InviteForm` (PF-20, PF-21). */
export const TEAM_STRINGS = Object.freeze({
  title: "Team",
  intro: "The people who work on this OTA, in the portal and in the OTA admin, each with a role.",
  readOnly:
    "Only owners and admins invite people, change roles or remove members. You can leave the OTA yourself.",
  membersTitle: "Members",
  membersCaption: "Members of this OTA",
  membersEmpty: "This OTA has no members to show.",
  name: "Name",
  email: "E-mail address",
  role: "Role",
  mfa: "Two-factor",
  joined: "Joined",
  actions: "Actions",
  you: "(you)",
  mfaOn: "On",
  mfaOff: "Off",
  /** The label of a member's role selector, for screen readers. */
  roleOf: (name: string) => `Role of ${name}`,
  changeRole: "Change role",
  changingRole: "Changing…",
  /** Read after "Change role" by screen readers only, so each row's button has its own name. */
  changeRoleOf: (name: string) => ` of ${name}`,
  roleChanged: (name: string, role: string) => `${name} is now ${role}.`,
  remove: "Remove",
  /** Read after "Remove" by screen readers only, so each row's button has its own name. */
  removeWho: (name: string) => ` ${name}`,
  removeTitle: (name: string) => `Remove ${name} from the team?`,
  removeDescription:
    "They lose access to this OTA in the portal at once, and in the OTA admin within a minute. You can invite them again later.",
  removeConfirm: "Remove member",
  removed: "The member was removed from the team.",
  leave: "Leave this OTA",
  leaveTitle: "Leave this OTA?",
  leaveDescription:
    "You lose access to this OTA in the portal at once, and in the OTA admin within a minute. An owner or an admin can invite you again.",
  leaveConfirm: "Leave the OTA",
  stale: "Someone else changed this member in the meantime. Reload the page, then try again.",
  memberGone: "This person is not a member of this OTA any more. Reload the page to see the current team.",
  notMember: "You are not a member of this OTA any more.",
  forbidden: "Your role in this OTA does not allow this change. Reload the page to see what you can do.",
  mfaRequired:
    "Making someone an owner needs a code from your authenticator app: turn on two-factor authentication first.",
  mfaLink: "Set up two-factor authentication",
  stepUpCancelled: "The role was not changed: it needs a code from your authenticator app.",
  reload: "Reload the page",
  formExpired: "This form has expired. Reload the page and try again.",
  rateLimited: "Too many changes in a short time. Wait a minute, then try again.",
  membersUnavailableTitle: "The members could not be loaded",
  invitationsTitle: "Pending invitations",
  invitationsIntro: "Invitations that are waiting to be accepted. Each one holds a seat of your plan.",
  invitationsCaption: "Pending invitations",
  invitationsEmpty: "No invitation is waiting to be accepted.",
  invitedBy: "Invited by",
  formerMember: "A former member",
  expires: "Link expires",
  resend: "Send again",
  resending: "Sending…",
  /** Read after "Send again" or "Revoke" by screen readers only, so each row's buttons have their own names. */
  invitationTo: (email: string) => ` the invitation to ${email}`,
  resent:
    "The invitation was sent again with a new link that works for 7 days. The old link no longer works.",
  revoke: "Revoke",
  revokeTitle: "Revoke this invitation?",
  revokeDescription: (email: string) =>
    `The link sent to ${email} stops working at once, and its seat becomes free. You can invite the address again later.`,
  revokeConfirm: "Revoke invitation",
  revoked: "The invitation was revoked.",
  notPending: "This invitation is no longer waiting to be accepted. Reload the page to see the current list.",
  invitationGone: "This invitation does not exist any more. Reload the page to see the current list.",
  invitationsUnavailableTitle: "The invitations could not be loaded",
  inviteTitle: "Invite someone",
  inviteIntro:
    "We e-mail them a link that works for 7 days. They sign in, or create an account, with this address to join.",
  emailLabel: "E-mail address",
  emailHint: "The address the invitation goes to. Only an account with this verified address can accept it.",
  emailRequired: "Enter the e-mail address to invite.",
  emailInvalid: "Enter a valid e-mail address, like name@example.com.",
  roleLabel: "Role",
  roleHint:
    "Owners and admins manage the OTA and its team; agents work on bookings in the OTA admin; finance members see billing and payments; viewers only read.",
  roleHintAdmin: "Only an owner can invite owners and admins.",
  roleRequired: "Choose a role.",
  roleNotAllowed: "Choose one of the roles in the list.",
  invite: "Send the invitation",
  inviting: "Sending…",
  invited: "The invitation is on its way. It shows under pending invitations until it is accepted.",
  /** `PLAN_LIMIT_REACHED` with `details.limit` and `details.used` (PF-20 AC2). */
  seatLimit: (used: number, limit: number) =>
    `Your plan includes ${counted(limit, "team seat", "team seats")}, and ${COUNT_FORMAT.format(used)} ${
      used === 1 ? "is" : "are"
    } taken by members and pending invitations. Revoke an invitation or remove a member to free a seat.`,
});

/** `/invitations/accept`: one invitation, before and after sign-in (PF-20 AC3). */
export const INVITATION_STRINGS = Object.freeze({
  pageTitle: "Your invitation",
  /** The page's heading, with the OTA's name from `lookupInvitation`. */
  title: (tenantName: string) => `Join ${tenantName}`,
  intro: (inviter: string | null, tenantName: string) =>
    inviter === null
      ? `You are invited to join the team of ${tenantName} on Velexis.`
      : `${inviter} invited you to join the team of ${tenantName} on Velexis.`,
  detailsLabel: "The invitation",
  ota: "OTA",
  role: "Role",
  invitedAddress: "Invited address",
  expires: "Link expires",
  signedOut: "Sign in, or create an account, with the invited address to accept the invitation.",
  signIn: "Sign in to accept",
  signUp: "Create an account",
  signUpHint:
    "New to Velexis? Create an account with the invited address and verify it, then sign in and open the invitation link again.",
  signedInAs: (email: string) => `You are signed in as ${email}.`,
  accept: "Accept the invitation",
  /** `INVITATION_EMAIL_MISMATCH`, naming the address the invitation was sent to (PF-20 AC3). */
  mismatchTitle: "This invitation is for another address",
  mismatch: (invited: string) =>
    `This invitation was sent to ${invited}. Sign in with that address to accept it.`,
  switchAccount: "Sign out and sign in with the invited address",
  unverifiedTitle: "Verify your e-mail address first",
  unverified:
    "Verify the address of your account before you accept the invitation, then open this page again.",
  verifyLink: "Verify your e-mail address",
  alreadyMember: "You are already a member of this OTA.",
  dashboardLink: "Go to my OTAs",
  invalidTitle: "This invitation cannot be used",
  invalid:
    "This invitation has expired, was revoked or was already used. Ask the person who invited you to send it again.",
  linkMissingTitle: "Open the link from your invitation e-mail",
  linkMissing:
    "To accept an invitation, open the link in the invitation e-mail. This page keeps it for 15 minutes; after that, open the link again.",
  unavailableTitle: "The invitation could not be loaded",
  failedTitle: "The invitation could not be accepted",
  rateLimited: "Too many attempts from your network. Wait a few minutes, then open the page again.",
});

// ---- Domains, Amadeus, payments and billing (PFE-013) ---------------------------------------------------------

/** What the last DNS check of a custom domain found missing (`lastCheckError`, flows/custom-domains.md step 3). */
export const DNS_CHECK_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  txt_missing: "The TXT record was not found yet.",
  txt_mismatch: "The TXT record was found, but its value is not the one above.",
  cname_missing: "The CNAME record was not found yet.",
  cname_wrong_target: "The CNAME record points to another address than the one above.",
  a_wrong_address: "The A or AAAA record points to another address than the ones above.",
  dns_timeout: "The DNS servers of the domain did not answer in time. Velexis checks again soon.",
});

/** `/otas/[tenantId]/domains` and `DnsRecordsTable` (PF-40; the custom domains of PF-41 with PFE-022). */
export const DOMAINS_STRINGS = Object.freeze({
  title: "Domains",
  intro: "The addresses of your storefront. Links and e-mails to your customers use the primary address.",
  subdomainTitle: "Velexis address",
  subdomainIntro:
    "Every OTA gets its own address on Velexis. Velexis manages its DNS records and its certificate, so there is nothing to set up.",
  subdomainMissing: "This OTA has no Velexis address to show.",
  primary: "Primary",
  added: "Added",
  customTitle: "Custom domains",
  customIntro:
    "Your own domains for the storefront, such as travel.example.com, each with the DNS records to create at your DNS provider.",
  customEmpty: "This OTA has no custom domain.",
  unavailableTitle: "The domains could not be loaded",
  recordsCaption: (hostname: string) => `DNS records for ${hostname}`,
  recordType: "Type",
  recordName: "Name",
  recordValue: "Value",
  recordsNone: "No DNS record is needed for this address.",
  verifyBy: "Verify by",
  lastCheck: "Last check",
  notChecked: "Not checked yet.",
  checkPassed: "The records are in place.",
  /** A `lastCheckError` the portal has no words for yet. */
  checkFailed: "The records were not found yet.",
});

/** The environment of a connection in its summary ("test", "live"). */
const CONNECTION_ENVIRONMENT_WORDS: Readonly<Record<string, string>> = KEY_ENVIRONMENT_WORDS;

/**
 * An environment in lower-case words; one the portal does not know yet (a newer API) in its raw form, so a card
 * never reads "undefined" or calls another environment live.
 */
function connectionEnvironmentWords(environment: string): string {
  return Object.hasOwn(CONNECTION_ENVIRONMENT_WORDS, environment)
    ? (CONNECTION_ENVIRONMENT_WORDS[environment] ?? environment)
    : environment.replaceAll("_", " ");
}

/** `ConnectionCard`: the Amadeus or Stripe connection of one environment (PF-50, PF-60; M5 parts with PFE-023/024). */
export const CONNECTION_STRINGS = Object.freeze({
  /** The card's heading: "Test environment", "Live environment". */
  title: (environment: "test" | "live") => {
    const words = connectionEnvironmentWords(environment);
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} environment`;
  },
  environment: (environment: "test" | "live") => connectionEnvironmentWords(environment),
  /** The card's one-line summary: "Velexis test account, office NCE1A0955, active". */
  summary: (parts: readonly string[]) => parts.join(", "),
  account: "Account",
  // Amadeus (supplier_connections).
  amadeusAccount: (credentialSource: "velexis" | "tenant", environment: "test" | "live") =>
    credentialSource === "velexis"
      ? `Velexis ${connectionEnvironmentWords(environment)} account`
      : "Your own Amadeus credentials",
  amadeusOffices: (officeIds: readonly string[]) =>
    officeIds.length === 0
      ? "no office yet"
      : `${officeIds.length === 1 ? "office" : "offices"} ${officeIds.join(", ")}`,
  clientId: "Client id",
  offices: "Offices",
  officesNone: "None yet",
  defaultOffice: "Default office",
  queuingOffice: "Queuing office",
  ownerOffice: "Owner office",
  officeNotSet: "Not set",
  lastVerified: "Last verified",
  /** A Velexis connection without an office (PF-50 AC2: the office pool was empty at set-up). */
  pendingOffice:
    "Velexis assigns an Amadeus office to your OTA soon. Flight searches and bookings in this environment start working once it is assigned; you do not need to do anything.",
  pendingCredentials: "Velexis is verifying the credentials of this connection.",
  amadeusInvalid:
    "Amadeus refused the credentials of this connection, so flight searches and bookings in this environment do not work. Contact Velexis support.",
  amadeusDisabled:
    "This connection is disabled, so flight searches and bookings in this environment do not work. Contact Velexis support.",
  // Stripe (payment_provider_connections).
  paymentAccount: Object.freeze({
    velexis: "Velexis Stripe account",
    connect_standard: "Your Stripe account (Stripe Connect)",
    api_keys: "Your Stripe account (your API keys)",
  }),
  stripeAccount: "Stripe account id",
  publishableKey: "Publishable key",
  descriptor: "Card statement suffix",
  descriptorNotSet: "Not set",
  chargesEnabled: "Takes card payments",
  payoutsEnabled: "Receives payouts",
  detailsSubmitted: "Business details complete",
  yes: "Yes",
  no: "No",
  connectedAt: "Connected",
  disconnectedAt: "Disconnected",
  webhookUrl: "Webhook URL",
  velexisMode:
    "Velexis takes your customers' card payments on its own Stripe account and transfers the money to you each month.",
  testPayments: "In the test environment, payments use Stripe's test cards and no money moves.",
  paymentPending: "Stripe has not finished setting up this account, so it cannot take payments yet.",
  paymentDisabled:
    "This connection is disabled, so the storefront cannot take card payments in this environment.",
  paymentError:
    "Stripe reported a problem with this account, so the storefront cannot take card payments in this environment. Contact Velexis support.",
  // A submission of the OTA's own credentials or keys (M5).
  submissionTitle: "Credentials you submitted",
  submissionOpen:
    "Velexis is verifying the credentials you submitted. The connection above stays in use until they are verified.",
  submissionFailed: "The credentials you submitted could not be verified. The connection above stays in use.",
});

/** `/otas/[tenantId]/amadeus` (PF-50; live access and own credentials with PFE-023). */
export const AMADEUS_STRINGS = Object.freeze({
  title: "Amadeus",
  intro:
    "The Amadeus connection your storefront searches and books flights through, one per environment. Velexis connects the test environment when it sets up your OTA.",
  empty: "This OTA has no Amadeus connection yet.",
  unavailableTitle: "The Amadeus connections could not be loaded",
});

/**
 * The settings of an Amadeus connection on `/otas/[tenantId]/amadeus` (PFE-018; flows/amadeus-connection.md §E; PF-53):
 * the office defaults, the ticketing defaults of new flight orders and the monitored queues, their rules (those of the
 * platform document's `UpdateAmadeusConnectionRequest`) and the answers of `updateAmadeusConnection`.
 */
export const AMADEUS_SETTINGS_STRINGS = Object.freeze({
  /** The heading of one connection's settings: "Settings of the test connection". */
  title: (environment: "test" | "live") =>
    `Settings of the ${connectionEnvironmentWords(environment)} connection`,
  intro:
    "The offices and defaults Velexis uses for the Amadeus calls of your storefront and OTA admin in this environment.",
  noOffices:
    "These settings can be changed once the connection has an Amadeus office. Velexis assigns one soon.",
  // Offices.
  officesLegend: "Offices",
  defaultOfficeLabel: "Default office",
  defaultOfficeHint: "Used for flight searches and bookings that name no office.",
  queuingOfficeLabel: "Queuing office",
  queuingOfficeHint: "The office whose queues receive new flight orders.",
  ownerOfficeLabel: "Owner office",
  ownerOfficeHint: "The office that owns new flight orders.",
  /** The first option of an office select whose value is not set, or not one of the connection's offices. */
  officePlaceholder: "Choose an office",
  // Ticketing defaults.
  ticketingLegend: "Ticketing defaults of new flight orders",
  ticketingIntro:
    "What Amadeus does with a new flight order that is not issued at once. Orders made before a change keep their own settings.",
  agreementLabel: "Ticketing agreement",
  /** The ticketing agreement options, and "Not set" for none. */
  agreementOptions: Object.freeze({
    "": "Not set",
    CONFIRM: "Confirm the order",
    DELAY_TO_QUEUE: "Place the order on a queue after a delay",
    DELAY_TO_CANCEL: "Cancel the order after a delay",
  }) as Readonly<Record<string, string>>,
  delayLabel: "Days before the automatic step",
  delayHint: "0 to 999. Only the delayed agreements use it.",
  issueLabel: "Issue tickets when the order is created",
  /** The `issue` options, and "Not set" for none. */
  issueOptions: Object.freeze({ "": "Not set", true: "Yes", false: "No" }) as Readonly<
    Record<string, string>
  >,
  automatedTitle: "Automated processes",
  automatedIntro:
    "The automatic steps Amadeus applies to new orders, each with the queue and office it uses.",
  automatedNone: "No automated process is set.",
  /** The legend of one automated process row: "Automated process 1". */
  automatedRow: (position: number) => `Automated process ${position}`,
  automatedCodeLabel: "When",
  /** The `automatedProcess` codes. */
  automatedCodes: Object.freeze({
    IMMEDIATE: "At once",
    DELAYED: "After a delay",
    ERROR: "On an error",
  }) as Readonly<Record<string, string>>,
  queueNumberLabel: "Queue number",
  queueCategoryLabel: "Queue category",
  officeLabel: "Office",
  /** The first option of an automated process's office select: the process names no office. */
  officeNone: "No office",
  automatedDelayLabel: "Delay in days",
  textLabel: "Remark",
  addAutomated: "Add an automated process",
  /** The visible text of a row's remove button; its name for screen readers names the row. */
  remove: "Remove",
  /** The name of a row's remove button: "Remove automated process 2". */
  removeAutomated: (position: number) => `Remove automated process ${position}`,
  // Monitored queues.
  queuesTitle: "Monitored queues",
  queuesIntro:
    "The Amadeus queues your OTA admin reads into its queue lists, at most 20. Each queue is listed once.",
  queuesNone: "No queue is monitored.",
  /** The legend of one monitored queue row: "Queue 1". */
  queueRow: (position: number) => `Queue ${position}`,
  queueIdLabel: "Queue number",
  queueIdHint: "0 to 99",
  categoryLabel: "Category",
  categoryHint: "0 to 254",
  addQueue: "Add a queue",
  /** The name of a row's remove button: "Remove queue 2". */
  removeQueue: (position: number) => `Remove queue ${position}`,
  queuesFull: "A connection monitors at most 20 queues. Remove one to add another.",
  /** One message per rule a value breaks (the action's checks and the API's field errors). */
  problems: Object.freeze({
    office: "Choose one of this connection's offices.",
    agreementOption: "Choose a ticketing agreement from the list.",
    delay: "Enter a number of days from 0 to 999.",
    issue: "Choose yes, no or not set.",
    automatedCode: "Choose when the process runs.",
    queueNumber: "Enter a queue number from 0 to 999, or leave it empty.",
    queueCategory: "Enter a queue category from 0 to 999, or leave it empty.",
    text: "Use at most 200 characters.",
    monitoredQueueId: "Enter a queue number from 0 to 99.",
    monitoredCategory: "Enter a category from 0 to 254.",
    duplicate: "This queue is already in the list. Remove one of them.",
    tooManyQueues: "Monitor at most 20 queues.",
    /** The API refused a value by a rule the portal has no own words for. */
    rules: "Check this value: it does not follow the rules of the setting.",
  }),
  submit: "Save the settings",
  submitting: "Saving…",
  saved: "The settings are saved. Flight searches and bookings use them within a minute.",
  readOnlyTitle: "The settings cannot be changed right now",
  /** Why the settings are read-only, for each OTA status but `active` (PADR-0014 item 5). */
  readOnly: Object.freeze({
    provisioning:
      "Velexis is still setting up this OTA. You can change the settings once the set-up is done.",
    suspended: "This OTA is suspended, so its Amadeus settings are read-only until it is resumed.",
    failed: "The set-up of this OTA failed, so its Amadeus settings cannot be changed.",
  }),
  /** Finance members read the settings, without the form. */
  roleNote: "Only owners and admins can change these settings.",
  stale:
    "Someone else changed these settings in the meantime. Reload the page to see them, then make your change again.",
  reload: "Reload the page",
  notActive:
    "This OTA is not active any more, so its Amadeus settings cannot be changed. Reload the page to see why.",
  forbidden: "Your role in this OTA does not allow changing the Amadeus settings any more. Reload the page.",
  removed:
    "This Amadeus connection is not there any more, or you are not a member of this OTA any more. Reload the page.",
  formExpired: "This form has expired. Reload the page and try again.",
  rateLimited: "Too many changes in a short time. Wait a minute, then try again.",
  // The read-only view of finance members.
  notSet: "Not set",
  /** The parts of an automated process or an agreement in words, joined: "At once, queue 8, category 0". */
  joined: (parts: readonly string[]) => parts.join(", "),
  viewQueue: (number: string) => `queue ${number}`,
  viewCategory: (category: string) => `category ${category}`,
  viewOffice: (officeId: string) => `office ${officeId}`,
  /** A stored delay (`"2D"`) in words; one of another shape as it is. */
  viewDelay: (delay: string) => {
    const days = /^([0-9]{1,3})D$/.exec(delay)?.[1];
    return days === undefined ? delay : `after ${days} ${days === "1" ? "day" : "days"}`;
  },
  viewText: (text: string) => `remark “${text}”`,
  monitoredCaption: (environment: "test" | "live") =>
    `Monitored queues of the ${connectionEnvironmentWords(environment)} connection`,
});

/** `/otas/[tenantId]/payments` (PF-60; your own Stripe account with PFE-024). */
export const PAYMENTS_STRINGS = Object.freeze({
  title: "Payments",
  intro: "The Stripe account that takes your customers' card payments, one per environment.",
  empty: "This OTA has no payment connection yet.",
  unavailableTitle: "The payment connections could not be loaded",
});

/**
 * The card statement suffix form of a Velexis-mode payment connection on `/otas/[tenantId]/payments` (PFE-016; PF-60):
 * its rules (those of the API's `StatementDescriptorSuffix`), the statement line preview and the answers of
 * `updatePaymentConnection`.
 */
export const DESCRIPTOR_STRINGS = Object.freeze({
  title: "Change the card statement suffix",
  intro:
    "Your customers' card statements show this suffix after Velexis's name, so they recognise the payment for your OTA.",
  label: "New suffix",
  hint: "2 to 22 characters: the letters A to Z, digits and spaces, with at least one letter.",
  previewTitle: "How a card statement shows it",
  previewEmpty: "Type a suffix to see the statement line.",
  previewInvalid: "The statement line shows here once the suffix follows the rules.",
  /** The length of the suffix as typed (trimmed), against the API's limit. */
  length: (count: number) => `${count} of 22 characters`,
  /** A statement line longer than 22 characters loses the end of the suffix. */
  previewCut: (fits: number) =>
    `A card statement shows at most 22 characters, so the end of this suffix is cut. Up to ${fits} characters show in full.`,
  previewHint: "Banks print the line in their own way, most of them in capital letters.",
  /** One message per rule a suffix breaks (`DescriptorProblem` and the API's field error codes). */
  problems: Object.freeze({
    required: "Enter a card statement suffix.",
    forbiddenCharacter: "Card statements cannot show the characters < > \\ ' \" or *. Remove them.",
    characters: "Use only the letters A to Z, digits and spaces: no accents, punctuation or other symbols.",
    minLength: "Use at least 2 characters.",
    maxLength: "Use at most 22 characters.",
    letter: "Include at least one letter.",
    start: "Start the suffix with a letter or a digit.",
    /** The API refused the suffix by a rule the portal has no own words for (its `pattern`). */
    rules:
      "Use 2 to 22 characters: the letters A to Z, digits and spaces, starting with a letter or a digit and with at least one letter.",
  }),
  submit: "Save the suffix",
  submitting: "Saving…",
  saved:
    "The card statement suffix is saved. New card payments show it within a minute; payments made before keep the suffix they had.",
  readOnlyTitle: "The suffix cannot be changed right now",
  /** Why the suffix is read-only, for each OTA status but `active` (PADR-0014 item 5). */
  readOnly: Object.freeze({
    provisioning: "Velexis is still setting up this OTA. You can change the suffix once the set-up is done.",
    suspended: "This OTA is suspended, so its payment settings are read-only until it is resumed.",
    failed: "The set-up of this OTA failed, so its payment settings cannot be changed.",
  }),
  /** Finance members read the suffix in the card, without the form. */
  roleNote: "Only owners and admins can change the card statement suffix.",
  stale:
    "Someone else changed this suffix in the meantime. Reload the page to see it, then make your change again.",
  reload: "Reload the page",
  notActive:
    "This OTA is not active any more, so its payment settings cannot be changed. Reload the page to see why.",
  forbidden:
    "Your role in this OTA does not allow changing the card statement suffix any more. Reload the page.",
  removed:
    "This payment connection is not there any more, or you are not a member of this OTA any more. Reload the page.",
  formExpired: "This form has expired. Reload the page and try again.",
  rateLimited: "Too many changes in a short time. Wait a minute, then try again.",
});

// ---- Payout account and settlements (PFE-025) ------------------------------------------------------------------

/**
 * `/otas/[tenantId]/payments/payout-account` (PFE-025; flows/stripe-payments-account.md §B; PF-64): the masked payout
 * account with its review status, and the owners' form behind a step-up (`setPayoutAccount`).
 */
export const PAYOUT_ACCOUNT_STRINGS = Object.freeze({
  title: "Payout account",
  intro:
    "The bank account Velexis transfers your monthly settlements to: the card payments Velexis takes for your OTA on its own Stripe account.",
  currentTitle: "Your payout account",
  none: "This OTA has no payout account yet. Velexis needs one, verified, before it can pay a settlement, and before an OTA that uses Velexis payments can go live.",
  unavailableTitle: "The payout account could not be loaded",
  holder: "Account holder",
  country: "Bank country",
  currency: "Currency",
  scheme: "Account type",
  schemes: Object.freeze({ iban: "IBAN", local: "Local account number" }) as Readonly<Record<string, string>>,
  number: "Account number",
  /** Read before the masked number: "Ending in 7947". */
  endingIn: "Ending in ",
  /** The dots shown before the last 4 characters (hidden from screen readers). */
  maskDots: "•••• ",
  status: "Review status",
  updatedAt: "Last changed",
  /** What each review status means for the OTA. */
  statusExplanations: Object.freeze({
    pending_review:
      "Velexis checks this account before it pays a settlement to it. The owners get an e-mail with the outcome.",
    verified: "Velexis pays your settlements to this account.",
    rejected:
      "Velexis cannot pay settlements to this account. Read the reviewer's note, then enter the account again.",
  }) as Readonly<Record<string, string>>,
  reviewNote: "Reviewer's note",
  /** Finance members read the account, without the form. */
  roleNote: "Only owners can change the payout account.",
  // The form (owners).
  formTitleAdd: "Add a payout account",
  formTitleChange: "Change the payout account",
  formIntro:
    "Saving asks for a code from your authenticator app. The account then goes back to pending review: Velexis pays settlements only to an account it has verified. Saving a rejected account again asks for a new review too, even with the same details.",
  holderLabel: "Account holder",
  holderHint: "The legal name on the bank account, as your bank has it.",
  countryLabel: "Bank country",
  countryHint: "The country of the bank that holds the account.",
  countryPlaceholder: "Choose a country",
  currencyLabel: "Currency",
  currencyHint: "The currency the account is held in.",
  currencyPlaceholder: "Choose a currency",
  schemeLegend: "How the bank identifies the account",
  schemeIban: "An IBAN",
  schemeIbanHint: "An international bank account number, with the bank's BIC if you have it.",
  schemeLocal: "A local account number",
  schemeLocalHint: "An account number and the bank's routing number (sort code, ABA or bank code).",
  ibanLabel: "IBAN",
  ibanHint:
    "Spaces are fine. Velexis never shows the full number again, so enter it in full each time you save.",
  bicLabel: "BIC (optional)",
  bicHint: "The bank's SWIFT code: 8 or 11 letters and digits.",
  accountNumberLabel: "Account number",
  accountNumberHint: "Velexis never shows the full number again, so enter it in full each time you save.",
  routingNumberLabel: "Routing number",
  routingNumberHint: "The sort code, ABA routing number or bank code of the bank.",
  submit: "Save the payout account",
  submitting: "Saving…",
  /** After a save, by the review status the API answered. */
  savedPending:
    "The payout account is saved and pending review. Velexis checks it before the next payout and e-mails the owners the outcome.",
  savedVerified: "These are the details Velexis already verified, so nothing changed.",
  /** One message per rule a field breaks (the action's checks and the API's field errors). */
  problems: Object.freeze({
    holderRequired: "Enter the legal name on the bank account.",
    holderTooLong: "Use at most 200 characters for the account holder.",
    country: "Choose the bank's country from the list.",
    currency: "Choose the account's currency from the list.",
    scheme: "Choose IBAN or a local account number.",
    ibanRequired: "Enter the IBAN.",
    ibanFormat:
      "Enter the IBAN as two letters, two check digits and 11 to 30 letters or digits. Spaces are fine.",
    ibanChecksum: "Check the IBAN: its check digits do not match. Copy it again from your bank's documents.",
    bicFormat: "Enter the BIC as 8 or 11 letters and digits, or leave it empty.",
    accountNumberRequired: "Enter the account number.",
    accountNumberFormat:
      "Enter the account number with at least 4 letters or digits (4 to 34 characters; spaces and hyphens are fine).",
    routingNumberRequired: "Enter the routing number.",
    routingNumberFormat:
      "Enter the routing number with 3 to 20 letters, digits, spaces or hyphens, starting with a letter or a digit.",
  }),
  stepUpCancelled: "The payout account was not saved: saving it needs a code from your authenticator app.",
  mfaRequired:
    "Saving the payout account needs a code from your authenticator app: turn on two-factor authentication first.",
  mfaLink: "Set up two-factor authentication",
  featureDisabled: "Payout accounts can be set once Velexis settlements are available for your OTA.",
  forbidden: "Only owners can change the payout account. Reload the page to see what your role allows.",
  removed: "You are not a member of this OTA any more.",
  formExpired: "This form has expired. Reload the page and try again.",
  rateLimited: "Too many changes in a short time. Wait a minute, then try again.",
  reload: "Reload the page",
});

/**
 * `/otas/[tenantId]/payments/settlements` and a statement's page (PFE-025; flows/stripe-payments-account.md §F; PF-63):
 * the statements Velexis approved, their totals and the CSV of their lines.
 */
export const SETTLEMENTS_STRINGS = Object.freeze({
  title: "Settlements",
  intro:
    "The monthly statements of the card payments Velexis took for your OTA on its own Stripe account, once Velexis has approved them. Velexis transfers each approved statement to your payout account.",
  payoutLink: "See the payout account",
  unavailableTitle: "The statements could not be loaded",
  empty:
    "No statement yet. At the start of each month Velexis prepares one for the payments it took in the month before.",
  caption: "Settlement statements, newest first",
  period: "Period",
  currency: "Currency",
  status: "Status",
  net: "Net amount",
  paidOn: "Paid on",
  /** The paid date of an approved statement, not transferred yet. */
  notPaidYet: "Not yet",
  /** The paid date of a carried-forward statement: nothing is transferred. */
  noTransfer: "No transfer",
  /** Statements cover calendar months in UTC; their periods and paid dates are shown in UTC. */
  periodNote: "Periods are calendar months in UTC, and dates are shown in UTC.",
  // A statement's page.
  backToList: "All statements",
  statementTitle: (period: string, currency: string) => `Statement for ${period}, ${currency}`,
  /** What each status means for the OTA. */
  statusExplanations: Object.freeze({
    approved: "Velexis approved this statement and transfers the net amount to your payout account.",
    paid: "Velexis transferred the net amount of this statement to your payout account.",
    carried_forward:
      "The net amount of this statement was zero or less, so nothing is transferred: the next statement takes it into account.",
  }) as Readonly<Record<string, string>>,
  summaryLabel: "About this statement",
  payoutReference: "Bank transfer reference",
  feeRate: "Velexis fee rate",
  notSet: "Not set",
  totalsCaption: "How the net amount is made up",
  item: "Item",
  amount: "Amount",
  gross: "Card payments captured",
  refunds: "Refunds (subtracted)",
  disputes: "Disputes (subtracted)",
  stripeFees: "Stripe fees (subtracted)",
  velexisFees: (rate: string) => `Velexis fee, ${rate} of the payments net of refunds (subtracted)`,
  adjustments: "Adjustments and balances carried from earlier statements (added)",
  formula: "Net amount = card payments − refunds − disputes − Stripe fees − Velexis fee + adjustments.",
  linesTitle: "Lines",
  lineCount: (count: number) => counted(count, "line", "lines"),
  linesIntro:
    "Every payment, refund, dispute, adjustment and carried balance of the statement, to reconcile it with your bookings.",
  download: "Download the lines as CSV",
  notesTitle: "Notes from Velexis",
  // The CSV route handler's answers when there is no file (plain text, the portal's words).
  csvNotFound: "This statement does not exist, or you cannot see it.",
  csvForbidden: "Your role in this OTA does not include settlements.",
  csvFailed: (message: string) => `The lines could not be downloaded. ${message}`,
});

/** `/otas/[tenantId]/billing` (PF-75; plans, Checkout and invoices with PFE-021). */
export const BILLING_STRINGS = Object.freeze({
  title: "Billing",
  intro: "Your OTA's plan and its subscription with Velexis.",
  subscriptionTitle: "Subscription",
  plan: "Plan",
  status: "Status",
  billedBy: "Payment",
  provider: Object.freeze({
    manual: "Free trial, no payment details needed",
    stripe: "By card, through Stripe",
  }),
  interval: "Billing interval",
  intervals: Object.freeze({ month: "Monthly", year: "Yearly" }),
  trialEnds: "Trial ends",
  periodEnds: "Current period ends",
  cancelAtPeriodEnd: "The subscription ends at the end of the current period.",
  /** For a manual trial before M5 (PF-75). */
  manualTrialTitle: "Paid plans arrive soon",
  manualTrial:
    "Until then your OTA runs on a free trial. Velexis e-mails the owners before the trial ends, so there is time to choose a plan.",
  banners: Object.freeze({
    past_due: Object.freeze({
      title: "A payment failed",
      text: "Update your payment details to keep your OTA running.",
    }),
    trial_ending: Object.freeze({
      title: "Your trial ends soon",
      text: "Choose a plan to keep your OTA running after the trial.",
    }),
    canceled: Object.freeze({
      title: "The subscription is canceled",
      text: "Choose a plan to keep using your OTA.",
    }),
  }),
  none: "This OTA has no subscription. Contact Velexis support.",
  unavailableTitle: "The subscription could not be loaded",
});

// ---- Account profile and security (PFE-007) ------------------------------------------------------------------

/** `/account`: the profile of the signed-in account (PF-07). */
export const ACCOUNT_STRINGS = Object.freeze({
  title: "Your profile",
  intro: "Your name and how Velexis shows dates to you. These settings are yours alone, in every OTA.",
  profileLegend: "Profile",
  fullNameLabel: "Full name",
  fullNameHint: "Shown to the other members of your OTAs and in the e-mails Velexis sends you.",
  fullNameRequired: "Enter your full name.",
  fullNameTooLong: "Use at most 200 characters for your name.",
  emailLabel: "E-mail address",
  emailHint:
    "You sign in with this address, and invitations are sent to it. To change it, contact Velexis support.",
  localeLabel: "Language and region",
  localeHint: "Velexis is in English for now. Your choice is kept for e-mails and later translations.",
  localeUnknown: "Choose a language from the list.",
  timeZoneLabel: "Time zone",
  timeZoneHint: "The portal shows your own dates and times in this zone.",
  timeZoneRequired: "Choose your time zone.",
  timeZoneUnknown: "Choose a time zone from the list.",
  submit: "Save changes",
  submitting: "Saving…",
  saved: "Your profile is saved.",
  /** `PRECONDITION_FAILED` of updateMe (PF-07 AC1): the profile changed since the page was loaded. */
  stale:
    "Your profile was changed in another tab or session since this page was loaded. Reload the page to see the current profile, then make your change again.",
  reload: "Reload the page",
  formExpired: "This form has expired. Reload the page and try again.",
  rateLimited: "Too many changes in a short time. Wait a minute, then try again.",
  unavailableTitle: "Your profile could not be loaded",
});

/** `/account/security`: password, two-factor authentication and sessions (PF-04, PF-06). */
export const SECURITY_STRINGS = Object.freeze({
  title: "Security",
  intro: "Your password, two-factor authentication and the places where your account is signed in.",
  // Password
  passwordTitle: "Password",
  passwordIntro:
    "Changing your password signs out every other session of your account, OTA admin sessions included. This browser stays signed in.",
  currentPasswordLabel: "Current password",
  currentPasswordRequired: "Enter your current password.",
  currentPasswordTooLong: "Enter a password of at most 256 characters.",
  currentPasswordIncorrect: "Your current password is not correct.",
  newPasswordLabel: "New password",
  newPasswordHint: "At least 10 characters. Avoid common passwords and passwords you use elsewhere.",
  passwordSubmit: "Change password",
  passwordSubmitting: "Changing…",
  passwordChanged:
    "Your password is changed. Every other session of your account was signed out, and Velexis sent you an e-mail about it.",
  passwordRateLimited: "Too many attempts in a short time. Wait a minute, then try again.",
  // Two-factor authentication
  mfaTitle: "Two-factor authentication",
  mfaOffIntro:
    "Protect your account with a code from an authenticator app, in addition to your password. Members of live OTAs need it to open the OTA admin.",
  mfaStart: "Set up two-factor authentication",
  mfaStarting: "Starting…",
  mfaScanTitle: "1. Scan the QR code",
  mfaScanIntro:
    "Open your authenticator app (such as 1Password, Google Authenticator or Microsoft Authenticator), add an account and scan this code.",
  mfaQrLabel: "QR code for your authenticator app",
  mfaSecretLabel: "Or enter this key in the app",
  mfaSecretHint: "Time-based, 6 digits, every 30 seconds.",
  /** The pending set-up lives for `expiresIn` seconds (10 minutes, PADR-0008 MFA item 2). */
  mfaExpiresIn: (minutes: number) =>
    `Finish within ${minutes === 1 ? "1 minute" : `${minutes} minutes`}, or start again.`,
  mfaConfirmTitle: "2. Enter the code from the app",
  mfaCodeLabel: "Authentication code",
  mfaCodeHint: "The 6-digit code your authenticator app shows now for Velexis.",
  mfaCodeFormat: "Enter the 6 digits of the code from your authenticator app.",
  mfaCodeInvalid:
    "The code is not correct. Check that you scanned this QR code, that your phone's clock is right, and enter the newest code.",
  mfaConfirm: "Turn on two-factor authentication",
  mfaConfirming: "Checking…",
  mfaCancel: "Cancel the set-up",
  mfaSetupExpired: "The set-up expired before it was confirmed. Start it again to get a new QR code.",
  mfaStartAgain: "Start again",
  mfaAlreadyEnabled:
    "Two-factor authentication was turned on in the meantime, maybe in another tab. Reload the page to see it.",
  mfaOnIntro: "Two-factor authentication is on. Sign-ins and sensitive actions ask for a code from your app.",
  mfaOnSince: "On since",
  recoveryCodesTitle: "Your recovery codes",
  recoveryCodesIntro:
    "Each code signs you in once if you lose your phone. Keep them somewhere safe, apart from your phone, such as a password manager.",
  recoveryCodeLabel: (position: number) => `Recovery code ${position}`,
  replaceCodes: "Replace the recovery codes",
  replaceCodesTitle: "Replace your recovery codes?",
  replaceCodesDescription:
    "You get ten new recovery codes, and your current codes stop working at once. You confirm it with a code from your authenticator app.",
  replaceCodesConfirm: "Replace the codes",
  replacingCodes: "Replacing…",
  newRecoveryCodesTitle: "Your new recovery codes",
  codesReplaced: "Your recovery codes are replaced. The old codes no longer work.",
  turnOff: "Turn off two-factor authentication",
  turnOffTitle: "Turn off two-factor authentication?",
  turnOffDescription:
    "Your account is then protected by your password alone, your recovery codes stop working, and you cannot open the OTA admin of a live OTA. You confirm it with a code from your authenticator app.",
  turnOffConfirm: "Turn it off",
  turningOff: "Turning off…",
  turnedOff: "Two-factor authentication is off. You can set it up again at any time.",
  turnOffCancelled:
    "Two-factor authentication is still on: turning it off needs a code from your authenticator app.",
  replaceCancelled: "Your recovery codes were not replaced: it needs a code from your authenticator app.",
  platformAdminKeepsMfa: "As a Velexis platform admin, you must keep two-factor authentication on.",
  mfaNotEnabled:
    "Two-factor authentication is not on any more, maybe turned off in another tab. Reload the page to see it.",
  mfaRateLimited: "Too many codes were tried. Wait a few minutes, then try again.",
  mfaUnavailableTitle: "Your two-factor settings could not be loaded",
  // Sessions
  sessionsTitle: "Where you are signed in",
  sessionsIntro:
    "Every browser that is signed in to the portal or the platform admin with your account. Revoke a session you do not recognise, and change your password.",
  sessionsCaption: "Active sessions",
  sessionsEmpty: "No active session.",
  device: "Device",
  signedInTo: "Signed in to",
  audiences: Object.freeze({ portal: "Portal", platform_admin: "Platform admin" }),
  ipAddress: "IP address",
  signedInAt: "Signed in",
  lastUsed: "Last used",
  notUsedYet: "Not since signing in",
  actions: "Actions",
  unknownDevice: "Unknown device",
  unknownIp: "Unknown",
  /** A device in words, from the browser's user agent ("Firefox on Windows"). */
  deviceOn: (browser: string, system: string) => `${browser} on ${system}`,
  thisBrowser: "This browser",
  revoke: "Revoke",
  revokeWhich: (device: string) => ` the session of ${device}`,
  revokeTitle: "Revoke this session?",
  revokeDescription: (device: string) =>
    `${device} is signed out the next time it renews its session, within 15 minutes at most. To keep someone out, change your password too.`,
  revokeConfirm: "Revoke session",
  revoked: "The session is revoked.",
  alreadyEnded: "That session had already ended.",
  sessionsReload: "Reload the page",
  sessionsUnavailableTitle: "Your sessions could not be loaded",
  signOutEverywhere: "Sign out everywhere",
  signOutEverywhereTitle: "Sign out everywhere?",
  signOutEverywhereDescription:
    "Every session of your account ends, this browser included: the portal, the platform admin and every OTA admin. You then sign in again here.",
  signOutEverywhereConfirm: "Sign out everywhere",
  signingOutEverywhere: "Signing out…",
  rateLimited: "Too many changes in a short time. Wait a minute, then try again.",
  formExpired: "This form has expired. Reload the page and try again.",
});

// ---- Open console: the hand-off to the OTA admin and the console picker (PFE-017) ------------------------------

/** "Open console" (PADR-0007): the button, the hand-off page, the picker and why a launch was refused. */
export const CONSOLE_STRINGS = Object.freeze({
  openConsole: "Open console",
  /** Read after the button's visible text by screen readers, so each button of a list names its OTA. */
  openConsoleFor: (otaName: string) => ` for ${otaName}`,
  // The hand-off page of the launch route handler (plain HTML, no React).
  handOffTitle: "Opening the OTA admin",
  handOffHeading: "Opening the OTA admin…",
  handOffFallback: "If the OTA admin does not open by itself, select Continue.",
  handOffContinue: "Continue",
  // `/console`: the picker the OTA admin sends people to without a session (PADR-0007 point 5).
  pickerTitle: "Open the OTA admin",
  pickerIntro:
    "Choose the OTA whose console you want to open. The OTA admin opens signed in with your role in that OTA.",
  pickerListLabel: "Your OTAs",
  pickerSelected: "Selected",
  pickerRole: "Your role",
  pickerNotMember:
    "You are not a member of the OTA the OTA admin asked for, or no longer are. Ask an owner of that OTA to invite you again, or choose one of your OTAs.",
  pickerEmptyTitle: "You are not a member of any OTA",
  pickerEmpty: "Create an OTA, or open the link in an invitation e-mail to join someone else's OTA.",
  pickerDashboardLink: "Go to My OTAs",
  pickerUnavailableTitle: "Your OTAs could not be loaded",
  // Why the console could not be opened (the launch's redirect back to the OTA dashboard or the security page).
  problemTitle: "The console could not be opened",
  problems: Object.freeze({
    provisioning: "Velexis is still setting up this OTA. Its console opens when the set-up is done.",
    failed: "The set-up of this OTA failed, so it has no console yet. The set-up page shows what happened.",
    suspended: "This OTA is suspended, and its console stays closed until the OTA is resumed.",
    not_active: "This OTA is not active, so its console cannot be opened.",
    rate_limited: "The console was opened too often in a short time. Wait a minute, then try again.",
    unavailable: "The console could not be opened just now. Try again in a moment.",
    mfa_required:
      "This OTA is live, so its console needs two-factor authentication on your account. Turn it on below, then open the console again.",
  }),
  /** A billing suspension, for roles that cannot open the billing page. */
  billingAskOwner: "Ask an owner or a finance member of this OTA to settle the payment.",
  openAgain: "Open the console again",
});
