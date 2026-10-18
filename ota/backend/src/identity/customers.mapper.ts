// The customer and session answers of the auth operations (OBE-033; the document's `Customer`, `Session`,
// `AuthSessionResult`, `AuthSessionInfo` and `AuthSessionDetails`; OADR-0006 point 4):
//
// - token (bearer) mode, key callers: `AuthSessionResult`, the customer and the session's tokens;
// - edge mode, the hosted storefront: `AuthSessionInfo`, the customer and the session's metadata, never a token (the
//   tokens travel in the httpOnly cookies of the cookie writer). auth.getSession answers it to every caller.
//
// Only the columns of the contract are shown: no password hash, no identity, no internal column. Times are ISO 8601
// instants in UTC.
import type { components } from "@velexis/api-types";
import type { CustomerRecord } from "./customers.repository";
import type { SessionDetails, SessionTokens } from "./sessions.service";

type Schemas = components["schemas"];
export type Customer = Schemas["Customer"];
export type Session = Schemas["Session"];
export type AuthSessionResult = Schemas["AuthSessionResult"];
export type AuthSessionInfo = Schemas["AuthSessionInfo"];
export type AuthSessionDetails = Schemas["AuthSessionDetails"];

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
