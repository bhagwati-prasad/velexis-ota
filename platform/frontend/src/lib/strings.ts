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
