// `GET /connect/stripe/callback` (README §2 route handlers; flows/stripe-payments-account.md §C items 2 and 3 and
// "Failure handling"; PADR-0011 item 2; PF-61 AC1): where Stripe sends the browser back from its Connect OAuth page,
// with `?code=…&state=…` when the owner or admin authorised Velexis, or `?error=…&state=…` when they declined or Stripe
// failed. The handler posts what Stripe sent to `completeStripeConnect` (`{state, code}` or `{state, error}`) with the
// signed-in account's session, server-side, and answers `303 See Other` to the OTA's payments page with the outcome
// as one of the portal's names (`?stripeConnect=connected`, `pending`, `denied`, `state_invalid`, …,
// payments/stripe-connect.ts), which the page turns into its own words.
//
// - The query never leaves this handler: the code and the state go to the API in the request body only, and are never
//   logged (nothing here logs), rendered (the only answers are redirects and a `405`), put in a redirect, a cookie or
//   an error. Stripe's `error_description` is not even read: the API gives the error its own words.
// - The OTA comes from the API's answer after a success. A refusal names no OTA (an unknown state belongs to none),
//   so the handler returns to the OTA whose connection this browser started: the Stripe Connect cookie that
//   `connectStripe` set (an OTA id, not a secret; 1 hour), cleared by every answer here. Without it, the dashboard.
// - A signed-in user is required: without a session the API is not called, and the browser goes to sign-in and then to
//   the payments page with "your session ended" (the middleware has renewed an access token that was only expired).
//   An unverified account goes to `/verify-pending`, and an owner or admin of a live OTA without MFA (the API's MFA
//   enrolment gate, PFE-030) to `/mfa-enrolment` and then to the payments page with "nothing changed, try again".
// - A query that is not one Stripe sends (no state of the document's pattern, neither a code nor an error, or both)
//   makes no call and reads as an expired connection ("try again").
// - Every answer is `Cache-Control: no-store`. `HEAD` answers `405` without a call, so a link checker or a prefetch can
//   never spend the single-use code; Next.js answers `405` to the other methods.
import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { NextResponse, type NextRequest } from "next/server";

import { paymentsPath, type StripeConnectOutcome } from "@/app/(app)/otas/[tenantId]/payments/stripe-connect";
import { createPlatformApi, type ApiError } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { isMfaEnrolmentRequired, mfaEnrolmentPath } from "@/lib/errors";
import { STRIPE_CONNECT_COOKIE, clearedCookie, sessionTokens, writeCookies } from "@/lib/session";
import { isTenantId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

type CompleteStripeConnectRequest = components["schemas"]["CompleteStripeConnectRequest"];
type PaymentConnection = components["schemas"]["PaymentConnection"];

/** `StripeConnectState` of the platform document. */
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** `StripeConnectCode` of the platform document (`ac_…`). */
const CODE = /^[A-Za-z0-9_]{1,255}$/;
/** `StripeConnectRefused.error`: Stripe's OAuth error code, such as `access_denied`. */
const OAUTH_ERROR = /^[a-z][a-z_]{0,99}$/;

/**
 * The body for `completeStripeConnect` of what Stripe sent, or `undefined` when the query is not one Stripe sends:
 * a state of the document's pattern with either a code or an error (never both, never neither).
 */
function callbackBodyOf(query: URLSearchParams): CompleteStripeConnectRequest | undefined {
  const state = query.get("state");
  const code = query.get("code");
  const error = query.get("error");
  if (state === null || !STATE.test(state)) {
    return undefined;
  }
  if (code !== null) {
    return error === null && CODE.test(code) ? { state, code } : undefined;
  }
  return error !== null && OAUTH_ERROR.test(error) ? { state, error } : undefined;
}

/** The outcome of a connection that went through: `pending` while Stripe cannot take payments for the account yet. */
function connectedOutcome(connections: readonly PaymentConnection[]): StripeConnectOutcome {
  const test = connections.find((connection) => connection.environment === "test");
  return test?.status === "pending" ? "pending" : "connected";
}

/** The outcome of each code of a refused `completeStripeConnect` that needs no closer look. */
const REFUSED_OUTCOMES: Readonly<Partial<Record<PlatformErrorCode, StripeConnectOutcome>>> = {
  // Unknown, expired, used, or another account's state (or a body the API does not take): start again.
  CONNECT_STATE_INVALID: "state_invalid",
  VALIDATION_FAILED: "state_invalid",
  STRIPE_ACCOUNT_ALREADY_CONNECTED: "already_connected",
  FEATURE_DISABLED: "feature_disabled",
  TENANT_NOT_ACTIVE: "not_active",
  FORBIDDEN: "forbidden",
  RATE_LIMITED: "rate_limited",
  PROVIDER_ERROR: "provider_error",
};

/**
 * The outcome of a refused `completeStripeConnect` (flows/stripe-payments-account.md "Failure handling"):
 * `UNPROCESSABLE` by its `details.reason` (`access_denied`, `livemode_mismatch`, else `oauth_error`), `CONFLICT` by
 * `connection_disabled`; the API or Redis unavailable, and anything else, "nothing changed, try again later".
 */
function refusedOutcome(error: ApiError): StripeConnectOutcome {
  const reason = error.details["reason"];
  if (error.code === "UNPROCESSABLE") {
    return reason === "access_denied"
      ? "denied"
      : reason === "livemode_mismatch"
        ? "livemode_mismatch"
        : "oauth_error";
  }
  if (error.code === "CONFLICT") {
    return reason === "connection_disabled" ? "connection_disabled" : "unavailable";
  }
  return REFUSED_OUTCOMES[error.code] ?? "unavailable";
}

/** The OTA whose connection this browser started (the Stripe Connect cookie), when it holds an OTA id. */
function startedTenantOf(request: NextRequest): string | undefined {
  const value = request.cookies.get(STRIPE_CONNECT_COOKIE)?.value;
  return isTenantId(value) ? value : undefined;
}

/** The payments page of `tenantId` with the outcome; the dashboard when no OTA is known. */
function returnPath(tenantId: string | undefined, outcome: StripeConnectOutcome): string {
  return tenantId === undefined ? "/dashboard" : paymentsPath(tenantId, outcome);
}

/** Sign-in, then the payments page of the OTA that started with "your session ended", or the dashboard. */
function signInPath(tenantId: string | undefined): string {
  return `/sign-in?${new URLSearchParams({ next: returnPath(tenantId, "signed_out") }).toString()}`;
}

/**
 * A `303 See Other` to `path` on the portal's public URL, which never holds anything of the query, with the Stripe
 * Connect cookie cleared: the connection is over, whatever its outcome.
 */
function seeOther(path: string, portalUrl: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, portalUrl), 303);
  response.headers.set("Cache-Control", "no-store");
  writeCookies(response.cookies, [clearedCookie(STRIPE_CONNECT_COOKIE)]);
  return response;
}

/** `HEAD` answers `405` without a call: Next.js would otherwise run `GET` for it and spend the code. */
export function HEAD(): Response {
  return new Response(null, { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const settings = getConfig();
  const portalUrl = settings.PUBLIC_PORTAL_URL;
  const tenantId = startedTenantOf(request);

  const body = callbackBodyOf(request.nextUrl.searchParams);
  if (body === undefined) {
    return seeOther(returnPath(tenantId, "state_invalid"), portalUrl);
  }
  const { accessToken } = sessionTokens(request.cookies);
  if (accessToken === undefined) {
    // No session (the middleware found no refresh token either): the API would refuse, so it is not asked.
    return seeOther(signInPath(tenantId), portalUrl);
  }

  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: request.headers,
    accessToken,
  });
  const result = await api.POST("/v1/payment-connections/stripe-connect/callback", { body });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      return seeOther(signInPath(tenantId), portalUrl);
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      return seeOther("/verify-pending", portalUrl);
    }
    if (isMfaEnrolmentRequired(result.error)) {
      return seeOther(mfaEnrolmentPath(returnPath(tenantId, refusedOutcome(result.error))), portalUrl);
    }
    return seeOther(returnPath(tenantId, refusedOutcome(result.error)), portalUrl);
  }
  // The OTA of the state, as the API answers it; the cookie's only when the answer names none it could be.
  const connectedTenant = isTenantId(result.data.tenantId) ? result.data.tenantId : tenantId;
  return seeOther(returnPath(connectedTenant, connectedOutcome(result.data.connections)), portalUrl);
}
