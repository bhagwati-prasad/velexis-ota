"use server";

import type { PlatformErrorCode } from "@velexis/errors";
import { redirect } from "next/navigation";

import { followableUrl, isConfirmedSubscription } from "@/app/(app)/otas/[tenantId]/billing/billing-rules";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { BILLING_STRINGS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";

/**
 * The server actions of the billing page (PFE-021; README §2 `/otas/[tenantId]/billing` and §5; flows/subscription-
 * billing.md §B, §F; PF-72):
 *
 * - `startCheckout` ("Continue to payment" of "Choose a plan", owners): `createCheckoutSession` with the chosen plan and
 *   billing interval and the `Idempotency-Key` the page made when it rendered (a double click opens one Checkout; the
 *   next visit makes a new key), then `redirect()` to the answer's Checkout URL;
 * - `openCustomerPortal` ("Manage in Stripe", owners of a Stripe subscription): `createCustomerPortalSession`, then
 *   `redirect()` to the session's URL. The router follows a server action's `redirect()` as a `303` and a top-level
 *   navigation (README §7: the policy restricts frames and form posts, not navigations);
 * - `getCheckoutSync` (back from Stripe, `?checkout=success`): one read of `getSubscription`, saying whether the
 *   completed Checkout has reached Velexis yet; the page's `CheckoutConfirmation` calls it every 2 seconds.
 *
 * Each takes the OTA id the page bound to it and checks it first. They call the API with the session's bearer token
 * and the end-user headers (`platformApi()`), send an ended session to sign-in and back to the billing page and an
 * unverified account to `/verify-pending`, and answer the portal's own text only, never the API's. They follow a URL of
 * the API's answer only when it is an absolute `https:` URL without credentials (`followableUrl`), never one built
 * here; the Customer Portal URL signs its holder in to Stripe, so it is neither logged nor stored.
 */

/** The fields of "Choose a plan" that the API can refuse. */
export type ChoosePlanField = "planCode" | "billingInterval";

/** What "Choose a plan" shows after an attempt that did not leave for Stripe. */
export interface ChoosePlanState {
  readonly status: "idle" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  readonly fieldErrors?: Readonly<Partial<Record<ChoosePlanField, string>>>;
  /** The page is out of date: the form offers "Reload the page". */
  readonly reload?: true;
}

/** What "Manage in Stripe" shows after an attempt that did not leave for Stripe. */
export interface PortalState {
  readonly status: "idle" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  readonly message?: string;
  readonly reload?: true;
}

/** One read of the subscription while the page confirms a Checkout. */
export type CheckoutSyncPoll =
  | { readonly status: "ok"; readonly confirmed: boolean }
  | {
      readonly status: "failed";
      /** The error code, for tests; never shown. */
      readonly code: PlatformErrorCode;
      readonly message: string;
      /** The read may work when tried again (rate limit, API unavailable): polling goes on. */
      readonly transient: boolean;
      /** The wait of `Retry-After`, when the API sent one. */
      readonly retryAfterSeconds?: number;
    };

/** `PlanCode` and `IdempotencyKey` of the platform document. */
const PLAN_CODE = /^[a-z][a-z0-9_]{1,39}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** Read failures that may pass: polling goes on. */
const TRANSIENT: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Ends the request when the session is over: sign in again and come back to the billing page (the middleware renews
 * an access token that is only expired); an unverified account goes to `/verify-pending`.
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/billing") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

// ---- Choose a plan: Stripe Checkout for an existing OTA (§B step 2) ---------------------------------------------

const CHECKOUT = BILLING_STRINGS.checkoutFailures;

function checkoutFailed(
  code: PlatformErrorCode,
  problem: Omit<ChoosePlanState, "status" | "code">,
): ChoosePlanState {
  return { status: "failed", code, ...problem };
}

/** The field of a `VALIDATION_FAILED` field error, when it is one of the form's (a JSON pointer into the body). */
function choosePlanField(path: string): ChoosePlanField | undefined {
  if (path === "/planCode") {
    return "planCode";
  }
  if (path === "/billingInterval") {
    return "billingInterval";
  }
  return undefined;
}

/** The portal's words for the refusals of `createCheckoutSession` that are not about one field. */
const CHECKOUT_REFUSALS: Readonly<
  Partial<Record<PlatformErrorCode, Omit<ChoosePlanState, "status" | "code">>>
> = {
  FEATURE_DISABLED: { message: CHECKOUT.featureDisabled, reload: true },
  IDEMPOTENCY_KEY_REUSED: { message: CHECKOUT.formExpired, reload: true },
  FORBIDDEN: { message: CHECKOUT.forbidden, reload: true },
  NOT_FOUND: { message: CHECKOUT.notFound, reload: true },
  PROVIDER_ERROR: { message: CHECKOUT.unavailable },
  SERVICE_UNAVAILABLE: { message: CHECKOUT.unavailable },
  INTERNAL_ERROR: { message: CHECKOUT.unavailable },
};

/** The portal's words for a refused `createCheckoutSession`, at a field where the refusal is about one. */
function checkoutRefusal(error: ApiError): ChoosePlanState {
  if (error.code === "PLAN_NOT_AVAILABLE") {
    return checkoutFailed(error.code, { fieldErrors: { planCode: CHECKOUT.planNotAvailable } });
  }
  if (error.code === "CONFLICT") {
    return checkoutFailed(error.code, {
      message:
        error.details["reason"] === "stripe_subscription_active"
          ? CHECKOUT.subscriptionActive
          : CHECKOUT.conflict,
      reload: true,
    });
  }
  if (error.code === "VALIDATION_FAILED") {
    const fieldErrors: Partial<Record<ChoosePlanField, string>> = {};
    for (const fieldError of error.fieldErrors) {
      const field = choosePlanField(fieldError.path);
      if (field !== undefined) {
        fieldErrors[field] = field === "planCode" ? CHECKOUT.planNotAvailable : CHECKOUT.formExpired;
      }
    }
    // A refusal of another part of the request (the Idempotency-Key, the OTA id) means the form is not the page's.
    return error.fieldErrors.length > 0 && Object.keys(fieldErrors).length === error.fieldErrors.length
      ? checkoutFailed(error.code, { fieldErrors })
      : checkoutFailed(error.code, { message: CHECKOUT.formExpired, reload: true });
  }
  return checkoutFailed(error.code, CHECKOUT_REFUSALS[error.code] ?? { message: errorMessage(error) });
}

/**
 * "Continue to payment" (`POST /v1/tenants/{tenantId}/billing/checkout-session`, owners): opens a Stripe Checkout for
 * the chosen plan (`planCode`) and billing interval (`billingInterval`) with the page's `Idempotency-Key` (the hidden
 * field `idempotencyKey`), and sends the browser to the answer's URL. Returns only when it did not leave for Stripe: a
 * form that is not the page's (no key, no plan, an interval that is neither `month` nor `year`) makes no call.
 */
export async function startCheckout(
  tenantId: string,
  _previous: ChoosePlanState,
  formData: FormData,
): Promise<ChoosePlanState> {
  if (!isTenantId(tenantId)) {
    return checkoutFailed("VALIDATION_FAILED", { message: CHECKOUT.formExpired, reload: true });
  }
  const idempotencyKey = text(formData, "idempotencyKey");
  const planCode = text(formData, "planCode");
  const billingInterval = text(formData, "billingInterval");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey) || (billingInterval !== "month" && billingInterval !== "year")) {
    // The page always renders both fields: without them the form is not the page's.
    return checkoutFailed("VALIDATION_FAILED", { message: CHECKOUT.formExpired, reload: true });
  }
  if (!PLAN_CODE.test(planCode)) {
    return checkoutFailed("VALIDATION_FAILED", { fieldErrors: { planCode: BILLING_STRINGS.planRequired } });
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/billing/checkout-session", {
    params: { path: { tenantId }, header: { "Idempotency-Key": idempotencyKey } },
    body: { planCode, billingInterval },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return checkoutRefusal(result.error);
  }
  const target = followableUrl(result.data.url);
  if (target === undefined) {
    return checkoutFailed("INTERNAL_ERROR", { message: CHECKOUT.unavailable });
  }
  redirect(target);
}

// ---- Manage in Stripe: the Stripe Customer Portal (§F) ----------------------------------------------------------

const PORTAL = BILLING_STRINGS.portalFailures;

function portalFailed(code: PlatformErrorCode, problem: Omit<PortalState, "status" | "code">): PortalState {
  return { status: "failed", code, ...problem };
}

/** The portal's words for each refusal of `createCustomerPortalSession`; any other code has its general message. */
const PORTAL_REFUSALS: Readonly<Partial<Record<PlatformErrorCode, Omit<PortalState, "status" | "code">>>> = {
  // `no_stripe_customer`: a manual trial that never went through Checkout.
  CONFLICT: { message: PORTAL.noCustomer, reload: true },
  FEATURE_DISABLED: { message: PORTAL.featureDisabled, reload: true },
  FORBIDDEN: { message: PORTAL.forbidden, reload: true },
  NOT_FOUND: { message: PORTAL.notFound, reload: true },
  PROVIDER_ERROR: { message: PORTAL.unavailable },
  SERVICE_UNAVAILABLE: { message: PORTAL.unavailable },
  INTERNAL_ERROR: { message: PORTAL.unavailable },
};

/**
 * "Manage in Stripe" (`POST /v1/tenants/{tenantId}/billing/portal-session`, owners): opens the Stripe Customer Portal,
 * where the owner changes the plan or the card, sees Stripe's receipts and cancels at the end of the period, and sends
 * the browser there. Returns only when it did not leave for Stripe.
 */
export async function openCustomerPortal(
  tenantId: string,
  _previous: PortalState,
  _formData: FormData,
): Promise<PortalState> {
  if (!isTenantId(tenantId)) {
    return portalFailed("VALIDATION_FAILED", { message: PORTAL.notFound, reload: true });
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/billing/portal-session", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return portalFailed(
      result.error.code,
      PORTAL_REFUSALS[result.error.code] ?? { message: errorMessage(result.error) },
    );
  }
  const target = followableUrl(result.data.url);
  if (target === undefined) {
    return portalFailed("INTERNAL_ERROR", { message: PORTAL.unavailable });
  }
  redirect(target);
}

// ---- Back from Stripe: following the Checkout's confirmation ----------------------------------------------------

/**
 * One read of the OTA's subscription (`GET /v1/tenants/{tenantId}/subscription`, owners and finance members) while the
 * page confirms a Checkout: `confirmed` once the completed Checkout's webhook made it a Stripe subscription that is
 * `trialing` or `active` (`isConfirmedSubscription`). An OTA without a subscription yet reads as not confirmed. Each
 * call is a request of its own, so it reads the API afresh.
 */
export async function getCheckoutSync(tenantId: string): Promise<CheckoutSyncPoll> {
  if (!isTenantId(tenantId)) {
    return { status: "failed", code: "NOT_FOUND", message: errorMessage("NOT_FOUND"), transient: false };
  }
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/subscription", { params: { path: { tenantId } } });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    if (result.error.code === "NOT_FOUND") {
      // The layout found the OTA: no subscription row yet, before the webhook writes the Stripe one.
      return { status: "ok", confirmed: false };
    }
    const { retryAfterSeconds } = result.error;
    return {
      status: "failed",
      code: result.error.code,
      message: errorMessage(result.error),
      transient: TRANSIENT.has(result.error.code),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  return { status: "ok", confirmed: isConfirmedSubscription(result.data) };
}
