// The customer and session answers of the auth operations (OBE-033 for sign-in, OBE-032 for sign-up and e-mail
// verification; the document's `Customer`, `Session`, `AuthSessionResult`, `AuthSessionInfo`, `AuthSessionDetails`,
// `AuthSignUpResult`, `EmailVerificationResult` and `AuthAcceptedResult`; OADR-0006 point 4):
//
// - token (bearer) mode, key callers: `AuthSessionResult`, the customer and the session's tokens; sign-up's
//   `AuthSignUpResult` holds the tokens in `session`;
// - edge mode, the hosted storefront: `AuthSessionInfo`, the customer and the session's metadata, never a token (the
//   tokens travel in the httpOnly cookies of the cookie writer); sign-up's `session` is `null`. auth.getSession answers
//   `AuthSessionInfo` to every caller.
//
// Only the columns of the contract are shown: no password hash, no identity, no internal column, no verification
// token. Times are ISO 8601 instants in UTC. The address a verification e-mail went to is shown masked
// (`a***.b***@example.com`).
import type { components } from "@velexis/api-types";
import type { CustomerRecord } from "./customers.repository";
import type { SessionDetails, SessionTokens } from "./sessions.service";

type Schemas = components["schemas"];
export type Customer = Schemas["Customer"];
export type Session = Schemas["Session"];
export type AuthSessionResult = Schemas["AuthSessionResult"];
export type AuthSessionInfo = Schemas["AuthSessionInfo"];
export type AuthSessionDetails = Schemas["AuthSessionDetails"];
export type AuthSignUpResult = Schemas["AuthSignUpResult"];
export type EmailVerificationStatus = Schemas["EmailVerificationStatus"];
export type EmailVerificationResult = Schemas["EmailVerificationResult"];
export type AuthAcceptedResult = Schemas["AuthAcceptedResult"];

type MarketingConsentSource = Customer["marketingConsent"]["source"];

const MARKETING_CONSENT_SOURCES: readonly MarketingConsentSource[] = [
  "sign_up",
  "account",
  "unsubscribe_link",
  "console",
];

const CUSTOMER_STATUSES: readonly Customer["status"][] = [
  "pending_verification",
  "active",
  "disabled",
  "deleted",
];

/** The contract's `Customer` of a row (`customers`). */
export function toCustomer(row: CustomerRecord): Customer {
  if (!(CUSTOMER_STATUSES as readonly string[]).includes(row.status)) {
    // The CHECK of `customers.status` rules this out; a new status needs a contract change first.
    throw new TypeError(`customer ${row.id} has a status the contract does not know`);
  }
  const source = (MARKETING_CONSENT_SOURCES as readonly string[]).includes(row.marketing_consent_source ?? "")
    ? (row.marketing_consent_source as MarketingConsentSource)
    : "sign_up";
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    pendingEmail: row.pending_email,
    firstName: row.first_name ?? "",
    lastName: row.last_name ?? "",
    phone:
      row.phone_country_code !== null && row.phone_number !== null
        ? { countryCallingCode: row.phone_country_code, number: row.phone_number }
        : null,
    dateOfBirth: row.date_of_birth,
    status: row.status as Customer["status"],
    marketingConsent: {
      granted: row.marketing_consent,
      // Never changed since sign-up: the account's creation is when it was given or refused.
      updatedAt: (row.marketing_consent_updated_at ?? row.created_at).toISOString(),
      source,
    },
    termsAcceptedVersion: row.terms_accepted_version,
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

/** The contract's `Session`: the tokens of token mode (never answered to the storefront edge). */
export function toSession(tokens: SessionTokens): Session {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    tokenType: "Bearer",
    subject: { type: "customer", id: tokens.customerId },
  };
}

/** The contract's `AuthSessionDetails`: a session's metadata and the expiry of the access token of the answer. */
export function toSessionDetails(details: SessionDetails, accessTokenExpiresAt: Date): AuthSessionDetails {
  return {
    id: details.sessionId,
    createdAt: details.createdAt.toISOString(),
    lastUsedAt: details.lastUsedAt.toISOString(),
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: details.refreshTokenExpiresAt.toISOString(),
    rememberMe: details.rememberMe,
    authMethod: details.authMethod,
    userAgent: details.userAgent,
    ipCountry: details.ipCountry,
  };
}

/** Token mode's answer of auth.signIn and auth.refresh: the tokens and the customer. */
export function toAuthSessionResult(tokens: SessionTokens, customer: CustomerRecord): AuthSessionResult {
  return { session: toSession(tokens), customer: toCustomer(customer) };
}

/** Edge mode's answer of auth.signIn and auth.refresh, and auth.getSession's: no token anywhere. */
export function toAuthSessionInfo(
  customer: CustomerRecord,
  details: SessionDetails,
  accessTokenExpiresAt: Date,
): AuthSessionInfo {
  return { customer: toCustomer(customer), session: toSessionDetails(details, accessTokenExpiresAt) };
}

/**
 * `address` as a verification answer shows it: the first character of each dot-separated part of the local part, then
 * `***`, and the domain (`anna.berg@example.com` → `a***.b***@example.com`).
 */
export function maskedAddress(address: string): string {
  const at = address.lastIndexOf("@");
  const local = at < 0 ? address : address.slice(0, at);
  const domain = at < 0 ? "" : address.slice(at);
  const masked = local
    .split(".")
    .map((part) => (part === "" ? "" : `${[...part][0] ?? ""}***`))
    .join(".");
  return `${masked}${domain}`;
}

/** What the answers say about the verification e-mail of a sign-up. */
export interface VerificationSent {
  readonly policy: EmailVerificationStatus["policy"];
  /** The address the e-mail went to (shown masked). */
  readonly sentTo: string;
  /** When the link expires (24 hours after it was issued). */
  readonly expiresAt: Date;
}

/**
 * auth.signUp's answer: the customer, the session's tokens for a key caller (`null` for the edge, whose tokens are in
 * the cookies, or when no session was opened) and the verification e-mail.
 */
export function toAuthSignUpResult(
  customer: CustomerRecord,
  tokens: SessionTokens | null,
  verification: VerificationSent,
): AuthSignUpResult {
  return {
    customer: toCustomer(customer),
    session: tokens === null ? null : toSession(tokens),
    emailVerification: {
      policy: verification.policy,
      verified: customer.email_verified_at !== null,
      sentTo: maskedAddress(verification.sentTo),
      expiresAt: verification.expiresAt.toISOString(),
    },
  };
}

/** A confirmed address: what auth.verifyEmail answers. */
export interface VerifiedEmail {
  readonly customer: CustomerRecord;
  readonly verifiedEmail: string;
  readonly emailChanged: boolean;
  readonly claimedGuestBookings: number;
  /** The `returnPath` of sign-up or resend; this OTA keeps none (the storefront's pages carry their own `next`). */
  readonly returnPath: string | null;
}

/** auth.verifyEmail's answer. */
export function toEmailVerificationResult(verified: VerifiedEmail): EmailVerificationResult {
  return {
    customer: toCustomer(verified.customer),
    verifiedEmail: verified.verifiedEmail,
    emailChanged: verified.emailChanged,
    claimedGuestBookings: verified.claimedGuestBookings,
    returnPath: verified.returnPath,
  };
}

/**
 * auth.resendVerification's one answer, whether or not the address has an account, is verified already or got an
 * e-mail (the document's anti-enumeration rule).
 */
export const RESEND_ACCEPTED: AuthAcceptedResult = Object.freeze({
  status: "accepted",
  message: "If an unverified account exists for this address, we have sent a new verification link.",
});
