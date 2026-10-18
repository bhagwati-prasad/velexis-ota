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
