"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { notFound, redirect } from "next/navigation";

import type { SecretValue } from "@/components/secret-reveal-panel";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { otaPath } from "@/lib/roles";
import { SETUP_STRINGS } from "@/lib/strings";

/**
 * The server actions of the set-up page (README §2 `/otas/[tenantId]/setup` and §5; flow provisioning.md §4 and
 * "Failure handling"; PF-11):
 *
 * - `getSetupProgress` reads `getProvisioning`; the page calls it for the first render, and `ProvisioningProgress`
 *   every 2 seconds until the set-up reaches a final state;
 * - `retrySetup` calls `retryProvisioning` (owners; only for a failed OTA), which starts a new set-up job;
 * - `revealSetupKeys` calls `revealInitialKeys` (owners) and returns the two test keys exactly once.
 *
 * From M5 (PFE-020; flow signup-and-create-ota.md step 7 and "Failure handling", billing flow §B and §H, PF-71) two
 * form actions hand an OTA that waits for its payment over to Stripe Checkout:
 *
 * - `continueToPayment` ("Continue to payment", owners): `createCheckoutSession` for the plan and interval of the
 *   OTA's `incomplete` subscription, then `redirect()` to the answer's URL;
 * - `retryPayment` ("Retry", owners, an OTA failed by an abandoned Checkout): `retryProvisioning`, then `redirect()` to
 *   the new Checkout URL of its answer.
 *
 * Both follow a URL of the API's answer only (an `https:` URL), never one built here (README §5, external
 * navigations). When they do not leave for Stripe they come back to the set-up page with `?payment=<code>`, an error
 * code of the catalogue the page shows in the portal's words, because a form action has no state to return. The
 * page's forms call them through `CheckoutForm` (`checkout-form.tsx`), never as a native form post: the `303` to
 * Stripe that would end such a post is blocked by the policy's `form-action 'self'` (README §7).
 *
 * Each takes the OTA id from the browser, so it is checked first. They call the API with the session's bearer token
 * and the end-user headers (`platformApi()`), and return the portal's own text only: the job's error text and the
 * steps' error messages stay on the server (README §5, "raw messages from the API are never shown"). The keys of
 * `revealSetupKeys` go to the browser in its answer only; they are never logged, stored or cached (PADR-0005).
 */

type Schemas = components["schemas"];

/** One finished set-up step. */
export interface SetupStep {
  /** The step name (`create_schema` … `notify`). */
  readonly step: string;
  readonly status: Schemas["ProvisioningStep"]["status"];
}

/** The set-up progress as the page shows it: `getProvisioning` without the API's error texts. */
export interface SetupProgress {
  readonly tenantStatus: Schemas["TenantStatus"];
  /** The latest `provision` job: its id is the reference for support. */
  readonly jobId: string;
  readonly jobStatus: Schemas["ProvisioningJobStatus"];
  /** The current or last step; `null` before dispatch. */
  readonly currentStep: string | null;
  /** The finished steps, in order. */
  readonly steps: readonly SetupStep[];
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The job recorded an error (a failed attempt); its text is not passed on. */
  readonly hasError: boolean;
  /** The test keys of the set-up wait for their one-time reveal. */
  readonly initialKeysAvailable: boolean;
}

/** A call that did not succeed, in the portal's words. */
export interface SetupFailure {
  readonly status: "failed";
  /** The error code, for tests; never shown. */
  readonly code: PlatformErrorCode;
  readonly message: string;
}

/** The answer of one progress read. */
export type SetupPoll =
  | { readonly status: "ok"; readonly progress: SetupProgress }
  | (SetupFailure & {
      /** The read may work when tried again (rate limit, API unavailable): polling goes on. */
      readonly transient: boolean;
      /** The wait of `Retry-After`, when the API sent one. */
      readonly retryAfterSeconds?: number;
    });

/** The answer of a retry: the progress of the new job. */
export type SetupRetry = { readonly status: "ok"; readonly progress: SetupProgress } | SetupFailure;

/** The answer of the reveal: the two keys, once. */
export type SetupReveal =
  | { readonly status: "revealed"; readonly keys: readonly SecretValue[] }
  | (SetupFailure & {
      /** `KEYS_ALREADY_REVEALED`: shown already, or the 24 hours passed; new keys come from the API keys page. */
      readonly alreadyRevealed: boolean;
    });

/** An OTA id as the platform issues it (`TenantId` of the platform document: `ten_` + ULID). */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

/** Read failures that may pass: polling goes on. */
const TRANSIENT: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

/**
 * Ends the request when the session is over: an ended session signs in again and comes back to the set-up page,
 * an unverified account goes to `/verify-pending` (the middleware renews an access token that is only expired).
 */
function leaveOnSessionEnd(error: ApiError, tenantId: string): void {
  if (error.code === "UNAUTHENTICATED" || error.code === "TOKEN_EXPIRED") {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/setup") }).toString()}`);
  }
  if (error.code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
}

function failure(error: Pick<ApiError, "code">): SetupFailure {
  return { status: "failed", code: error.code, message: errorMessage(error) };
}

/** The page's view of `ProvisioningStatus`: everything but the job's error text and the steps' error messages. */
function progressOf(status: Schemas["ProvisioningStatus"]): SetupProgress {
  const { job } = status;
  return {
    tenantStatus: status.tenantStatus,
    jobId: job.id,
    jobStatus: job.status,
    currentStep: job.step,
    steps: job.steps.map((entry) => ({ step: entry.step, status: entry.status })),
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    hasError: job.error !== null,
    initialKeysAvailable: status.initialKeysAvailable,
  };
}

/** The progress of the OTA's set-up (`GET /v1/tenants/{tenantId}/provisioning`, any member). */
export async function getSetupProgress(tenantId: unknown): Promise<SetupPoll> {
  if (!isTenantId(tenantId)) {
    return { ...failure({ code: "NOT_FOUND" }), transient: false };
  }
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/provisioning", { params: { path: { tenantId } } });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    const { retryAfterSeconds } = result.error;
    return {
      ...failure(result.error),
      transient: TRANSIENT.has(result.error.code),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  return { status: "ok", progress: progressOf(result.data) };
}

/**
 * Retries a failed set-up (`POST /v1/tenants/{tenantId}/provisioning/retry`, owners): the OTA goes back to
 * `provisioning` and a new job starts, whose progress the answer carries. From M5, an OTA whose Checkout was
 * abandoned gets a new Checkout instead, and the browser goes there (README §5, external navigations).
 */
export async function retrySetup(tenantId: unknown): Promise<SetupRetry> {
  if (!isTenantId(tenantId)) {
    return failure({ code: "NOT_FOUND" });
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/provisioning/retry", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return failure(result.error);
  }
  const target = checkoutTarget(result.data.checkoutUrl);
  if (target !== undefined) {
    redirect(target);
  }
  return {
    status: "ok",
    progress: progressOf({ tenantStatus: "provisioning", job: result.data.job, initialKeysAvailable: false }),
  };
}

// ---- The Stripe Checkout of an OTA that waits for its payment (M5, PFE-020) ---------------------------------------

/**
 * The URL of a Checkout answer when it can be followed: an absolute `https:` URL without credentials, exactly as the
 * API answered it (Stripe's Checkout URLs carry a fragment the page needs). Anything else is never followed.
 */
function checkoutTarget(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" ? value : undefined;
}

/** The set-up page, with `?payment=<code>` when a payment attempt did not leave for Stripe. */
function setupPath(tenantId: string, code?: PlatformErrorCode): string {
  const path = otaPath(tenantId, "/setup");
  return code === undefined ? path : `${path}?${new URLSearchParams({ payment: code }).toString()}`;
}

/** `PlanCode` and `IdempotencyKey` of the platform document. */
const PLAN_CODE = /^[a-z][a-z0-9_]{1,39}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * "Continue to payment" (`POST /v1/tenants/{tenantId}/billing/checkout-session`, owners): opens a Stripe Checkout for
 * the plan and interval of the OTA's `incomplete` subscription (the hidden fields `planCode` and `billingInterval`)
 * with the `Idempotency-Key` the page made when it rendered (the hidden field `idempotencyKey`), so a double click
 * opens one Checkout; the next visit of the page makes a new key, and so a fresh Checkout once the last one expired.
 * The browser goes to the answer's URL (PFE-020 AC2); otherwise back to the set-up page with the reason.
 */
export async function continueToPayment(tenantId: unknown, formData: FormData): Promise<void> {
  if (!isTenantId(tenantId)) {
    notFound();
  }
  const idempotencyKey = text(formData, "idempotencyKey");
  const planCode = text(formData, "planCode");
  const billingInterval = text(formData, "billingInterval");
  if (
    !IDEMPOTENCY_KEY.test(idempotencyKey) ||
    !PLAN_CODE.test(planCode) ||
    (billingInterval !== "month" && billingInterval !== "year")
  ) {
    // The page always renders the three fields: without them the form is not the page's.
    redirect(setupPath(tenantId, "VALIDATION_FAILED"));
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/billing/checkout-session", {
    params: { path: { tenantId }, header: { "Idempotency-Key": idempotencyKey } },
    body: { planCode, billingInterval },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    redirect(setupPath(tenantId, result.error.code));
  }
  const target = checkoutTarget(result.data.url);
  redirect(target ?? setupPath(tenantId, "INTERNAL_ERROR"));
}

/**
 * "Retry" of an OTA failed by an abandoned Checkout (`POST /v1/tenants/{tenantId}/provisioning/retry`, owners): the
 * OTA goes back to `provisioning` with a new `incomplete` subscription, and the browser goes to the answer's new
 * Checkout URL. Without one (Stripe failed, or the plan is no longer available) the set-up page shows "Continue to
 * payment" for the new subscription; a refusal comes back with its reason.
 */
export async function retryPayment(tenantId: unknown, _formData: FormData): Promise<void> {
  if (!isTenantId(tenantId)) {
    notFound();
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/provisioning/retry", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    redirect(setupPath(tenantId, result.error.code));
  }
  const target = checkoutTarget(result.data.checkoutUrl);
  redirect(target ?? setupPath(tenantId));
}

/** The label of each kind of key; the publishable key comes first. */
const KEY_LABELS: Readonly<Record<Schemas["ApiKeyKind"], string>> = {
  publishable: SETUP_STRINGS.publishableKeyLabel,
  secret: SETUP_STRINGS.secretKeyLabel,
};

const KEY_ORDER: Readonly<Record<Schemas["ApiKeyKind"], number>> = { publishable: 0, secret: 1 };

/**
 * Reveals the test keys issued at set-up (`POST /v1/tenants/{tenantId}/initial-keys/reveal`, owners). The API
 * answers them once and erases them; a second call, or one 24 hours after the set-up, answers
 * `KEYS_ALREADY_REVEALED`. The keys are returned to the browser and nowhere else: not logged, not stored, not cached.
 */
export async function revealSetupKeys(tenantId: unknown): Promise<SetupReveal> {
  if (!isTenantId(tenantId)) {
    return { ...failure({ code: "NOT_FOUND" }), alreadyRevealed: false };
  }
  const api = await platformApi();
  const result = await api.POST("/v1/tenants/{tenantId}/initial-keys/reveal", {
    params: { path: { tenantId } },
  });
  if (result.error !== undefined) {
    leaveOnSessionEnd(result.error, tenantId);
    return { ...failure(result.error), alreadyRevealed: result.error.code === "KEYS_ALREADY_REVEALED" };
  }
  const keys = [...result.data.keys]
    .sort((left, right) => KEY_ORDER[left.kind] - KEY_ORDER[right.kind])
    .map((key) => ({ label: KEY_LABELS[key.kind], value: key.key }));
  return { status: "revealed", keys };
}
