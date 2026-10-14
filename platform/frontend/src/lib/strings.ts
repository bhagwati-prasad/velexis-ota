import type { PlatformErrorCode } from "@velexis/errors";

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
