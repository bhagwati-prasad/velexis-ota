import { randomUUID } from "node:crypto";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  continueToPayment,
  getSetupProgress,
  retryPayment,
  retrySetup,
  revealSetupKeys,
  type SetupProgress,
} from "@/app/(app)/otas/[tenantId]/setup/actions";
import { CheckoutForm } from "@/app/(app)/otas/[tenantId]/setup/checkout-form";
import { ProvisioningProgress } from "@/components/provisioning-progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { platformApi } from "@/lib/api";
import { errorMessage, isPlatformErrorCode } from "@/lib/errors";
import { can, otaPath, type TenantRole } from "@/lib/roles";
import { SETUP_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: SETUP_STRINGS.title };

type Subscription = components["schemas"]["Subscription"];

/** The query of the page: `checkout=success` (back from Stripe), `payment=<code>` (a payment that did not start). */
type SearchParams = Record<string, string | string[] | undefined>;

/** An OTA id as the platform issues it (`ten_` + ULID); anything else is not an OTA of the account. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Answers that mean the session is over. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** Leaves the page for an ended session, an unverified account or an OTA the account is no member of. */
function leaveOn(code: PlatformErrorCode, tenantId: string): void {
  if (SESSION_ENDED.has(code)) {
    redirect(`/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/setup") }).toString()}`);
  }
  if (code === "EMAIL_NOT_VERIFIED") {
    redirect("/verify-pending");
  }
  if (code === "NOT_FOUND") {
    // The API answers 404 for an OTA the account is not a member of, so ids cannot be probed.
    notFound();
  }
}

/** The page's frame: one `h1` (the OTA's name once it is known) and the introduction. */
function SetupFrame({
  name,
  children,
}: {
  readonly name?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-2">
        <p className="text-sm font-medium text-muted-foreground">{SETUP_STRINGS.title}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{name ?? SETUP_STRINGS.title}</h1>
        <p className="text-muted-foreground">{SETUP_STRINGS.intro}</p>
      </div>
      {children}
    </div>
  );
}

/** The page when the OTA or its progress could not be read. */
function SetupUnavailable({ name, message }: { readonly name?: string; readonly message: string }) {
  return (
    <SetupFrame name={name}>
      <Alert variant="destructive">
        <AlertTitle>{SETUP_STRINGS.unavailableTitle}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </SetupFrame>
  );
}

// ---- The payment of an OTA created from M5 (PFE-020) ----------------------------------------------------------------

/** Where the OTA's payment stands, as far as the page shows it (M5). */
type Payment =
  | { readonly kind: "none" }
  /** The OTA waits for its first payment: the subscription is an unpaid `incomplete` Stripe row. */
  | { readonly kind: "waiting"; readonly subscription: Subscription }
  /** The OTA failed because its Checkout was abandoned: the subscription is `incomplete_expired` (billing flow §H). */
  | { readonly kind: "abandoned" };

const NO_PAYMENT: Payment = Object.freeze({ kind: "none" });

/** The one value of a query parameter. */
function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Where the OTA's payment stands (M5). Only the subscription tells (`getSubscription`, owners and finance members),
 * and it is read only when the progress leaves the question open: a `provisioning` OTA whose job never went out
 * (`queued`, no attempt: the dispatch gate stays closed while the subscription is `incomplete`), unless the person
 * is back from Stripe (`checkoutReturn`: the page then follows the progress), or a `failed` OTA whose job was
 * canceled (the abandoned-Checkout job, billing flow §H). Before M5 the subscription is a manual trial, and nothing
 * waits. A subscription that cannot be read leaves the page as in M1; an ended session signs in again.
 */
async function paymentOf(
  tenantId: string,
  role: TenantRole,
  progress: SetupProgress,
  checkoutReturn: boolean,
): Promise<Payment> {
  const mayWait =
    !checkoutReturn &&
    progress.tenantStatus === "provisioning" &&
    progress.jobStatus === "queued" &&
    progress.attempt === 0;
  const mayBeAbandoned = progress.tenantStatus === "failed" && progress.jobStatus === "canceled";
  if (!can(role, "viewBilling") || (!mayWait && !mayBeAbandoned)) {
    return NO_PAYMENT;
  }
  const api = await platformApi();
  const result = await api.GET("/v1/tenants/{tenantId}/subscription", { params: { path: { tenantId } } });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (SESSION_ENDED.has(code) || code === "EMAIL_NOT_VERIFIED") {
      leaveOn(code, tenantId);
    }
    return NO_PAYMENT;
  }
  const subscription = result.data;
  if (subscription.billingProvider !== "stripe") {
    return NO_PAYMENT;
  }
  if (mayWait && subscription.status === "incomplete") {
    return { kind: "waiting", subscription };
  }
  if (mayBeAbandoned && subscription.status === "incomplete_expired") {
    return { kind: "abandoned" };
  }
  return NO_PAYMENT;
}

/** The portal's words for the reason a payment did not start (`?payment=<code>`); other codes get their message. */
const PAYMENT_NOTICES: Readonly<Partial<Record<PlatformErrorCode, string>>> = {
  PROVIDER_ERROR: SETUP_STRINGS.paymentUnavailable,
  SERVICE_UNAVAILABLE: SETUP_STRINGS.paymentUnavailable,
  INTERNAL_ERROR: SETUP_STRINGS.paymentUnavailable,
  // createCheckoutSession: the OTA has a current Stripe subscription (details.reason stripe_subscription_active).
  CONFLICT: SETUP_STRINGS.paymentAlreadyDone,
  PLAN_NOT_AVAILABLE: SETUP_STRINGS.planUnavailable,
  PROVISIONING_NOT_RETRYABLE: SETUP_STRINGS.notRetryable,
  VALIDATION_FAILED: SETUP_STRINGS.paymentFormExpired,
  IDEMPOTENCY_KEY_REUSED: SETUP_STRINGS.paymentFormExpired,
};

/** Codes that report where things stand rather than a failure: a status message, not an alert. */
const INFORMATIVE: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "CONFLICT",
  "PROVISIONING_NOT_RETRYABLE",
]);

/**
 * Why the last payment attempt did not leave for Stripe (`?payment=<code>`, written by the wizard and the page's
 * actions). Only a code of the catalogue counts, and only the portal's text for it is shown; a plan that is no
 * longer available links to the billing page for the roles that see it.
 */
function PaymentNotice({
  code,
  tenantId,
  role,
}: {
  readonly code: PlatformErrorCode;
  readonly tenantId: string;
  readonly role: TenantRole;
}) {
  const informative = INFORMATIVE.has(code);
  return (
    <Alert
      {...(informative ? { role: "status" } : { variant: "destructive" as const })}
      data-payment-notice={code}
    >
      <AlertDescription>
        <p>
          {PAYMENT_NOTICES[code] ?? errorMessage(code)}{" "}
          {code === "PLAN_NOT_AVAILABLE" && can(role, "viewBilling") ? (
            <Link href={otaPath(tenantId, "/billing")} className="font-medium underline underline-offset-4">
              {SETUP_STRINGS.billingLink}
            </Link>
          ) : null}
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * "Payment needed": the OTA waits for the payment of its plan, so the page shows this instead of the steps (PFE-020
 * AC2). Owners get "Continue to payment", a form posting to `continueToPayment` with the plan and interval of the
 * `incomplete` subscription and the page's `Idempotency-Key`; finance members read who can continue.
 */
function PaymentPanel({
  tenantId,
  subscription,
  canPay,
  idempotencyKey,
}: {
  readonly tenantId: string;
  readonly subscription: Subscription;
  readonly canPay: boolean;
  readonly idempotencyKey: string;
}) {
  return (
    <section aria-labelledby="setup-payment-title" className="grid gap-4 rounded-xl border p-5">
      <h2 id="setup-payment-title" className="text-xl font-semibold tracking-tight">
        {SETUP_STRINGS.paymentTitle}
      </h2>
      <p className="text-muted-foreground">{SETUP_STRINGS.paymentText}</p>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{SETUP_STRINGS.plan}</dt>
        <dd>{subscription.planName}</dd>
        <dt className="text-muted-foreground">{SETUP_STRINGS.billing}</dt>
        <dd>{SETUP_STRINGS.intervals[subscription.billingInterval]}</dd>
      </dl>
      {canPay ? (
        <CheckoutForm action={continueToPayment.bind(null, tenantId)} className="grid gap-2">
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <input type="hidden" name="planCode" value={subscription.planCode} />
          <input type="hidden" name="billingInterval" value={subscription.billingInterval} />
          <div>
            <Button type="submit">{SETUP_STRINGS.continueToPayment}</Button>
          </div>
          <p className="text-sm text-muted-foreground">{SETUP_STRINGS.paymentHint}</p>
        </CheckoutForm>
      ) : (
        <p className="text-sm text-muted-foreground">{SETUP_STRINGS.paymentOwnerOnly}</p>
      )}
    </section>
  );
}

/**
 * The OTA failed because its Checkout was abandoned (billing flow §H): owners get "Retry", a form posting to
 * `retryPayment`, which sends the browser to a new Checkout; other roles read who can retry.
 */
function AbandonedPanel({ tenantId, canRetry }: { readonly tenantId: string; readonly canRetry: boolean }) {
  return (
    <section
      aria-labelledby="setup-abandoned-title"
      className="grid gap-3 rounded-xl border border-destructive/40 p-5"
    >
      <h2 id="setup-abandoned-title" className="text-xl font-semibold tracking-tight text-destructive">
        {SETUP_STRINGS.abandonedTitle}
      </h2>
      <p>{SETUP_STRINGS.abandonedText}</p>
      {canRetry ? (
        <CheckoutForm action={retryPayment.bind(null, tenantId)} className="grid gap-2">
          <div>
            <Button type="submit">{SETUP_STRINGS.retryPayment}</Button>
          </div>
          <p className="text-sm text-muted-foreground">{SETUP_STRINGS.retryPaymentHint}</p>
        </CheckoutForm>
      ) : (
        <p className="text-sm text-muted-foreground">{SETUP_STRINGS.retryPaymentOwnerOnly}</p>
      )}
    </section>
  );
}

/**
 * `/otas/[tenantId]/setup` (README §2 Signed in; flow provisioning.md §4 and "Failure handling"; PF-11): the set-up
 * progress of a new OTA for any member. The page reads the OTA (`getTenant`: its name, primary host and the caller's
 * role) and the progress (`getSetupProgress`, i.e. `getProvisioning`) on the server; `ProvisioningProgress` then polls
 * every 2 seconds until the set-up is over. Owners get "Retry the set-up" on a failed OTA and "Reveal the test keys"
 * once it is active. The keys are never read here: they come only from the owner's click, so a reload never shows
 * them again.
 *
 * From M5 (PFE-020; flow signup-and-create-ota.md steps 7–8 and "Failure handling", PF-71), for owners and finance
 * members (the roles that read the subscription):
 *
 * - an OTA that waits for its payment shows "Payment needed" with "Continue to payment" instead of the steps;
 * - back from Stripe (`?checkout=success`) the page follows the progress and says that Stripe's confirmation can take
 *   a minute: the webhook, not the redirect, starts the set-up (PF-71 AC1); an OTA that is not in set-up and has no
 *   test keys waiting goes on to the billing page, which confirms the payment (PFE-021);
 * - an OTA failed by an abandoned Checkout offers "Retry", which opens a new Checkout;
 * - `?payment=<code>` says why the last payment attempt did not leave for Stripe.
 */
export default async function SetupPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ tenantId: string }>;
  readonly searchParams?: Promise<SearchParams>;
}) {
  const { tenantId } = await params;
  if (!TENANT_ID.test(tenantId)) {
    notFound();
  }
  const api = await platformApi();
  const [tenant, progress, query] = await Promise.all([
    api.GET("/v1/tenants/{tenantId}", { params: { path: { tenantId } } }),
    getSetupProgress(tenantId),
    searchParams ?? Promise.resolve<SearchParams>({}),
  ]);
  if (tenant.error !== undefined) {
    leaveOn(tenant.error.code, tenantId);
  }
  if (progress.status === "failed") {
    leaveOn(progress.code, tenantId);
  }
  // Rate limit, API unavailable and the like: the portal's message for the code, never the API's text.
  if (tenant.error !== undefined) {
    return <SetupUnavailable message={errorMessage(tenant.error)} />;
  }
  if (progress.status === "failed") {
    return <SetupUnavailable name={tenant.data.name} message={progress.message} />;
  }

  const role = tenant.data.myRole;
  const checkoutReturn = single(query["checkout"]) === "success";
  if (
    checkoutReturn &&
    progress.progress.tenantStatus !== "provisioning" &&
    !progress.progress.initialKeysAvailable &&
    can(role, "viewBilling")
  ) {
    // Stripe's success URL is this page for every Checkout (billing flow §B step 3), but only an OTA in set-up (or one
    // whose new test keys wait for their reveal) is followed here. The billing page confirms the payment of the others,
    // such as an OTA failed by an abandoned Checkout and paid from the billing page (PFE-021, lead decision (2i) of
    // 2026-11-03), and then leads back here when its set-up starts again.
    redirect(`${otaPath(tenantId, "/billing")}?checkout=success`);
  }
  const noticeCode = single(query["payment"]);
  const notice = isPlatformErrorCode(noticeCode) ? (
    <PaymentNotice code={noticeCode} tenantId={tenantId} role={role} />
  ) : null;
  const payment = await paymentOf(tenantId, role, progress.progress, checkoutReturn);

  if (payment.kind === "waiting") {
    return (
      <SetupFrame name={tenant.data.name}>
        {notice}
        <PaymentPanel
          tenantId={tenantId}
          subscription={payment.subscription}
          canPay={can(role, "manageBilling")}
          // One key per rendering of the page: a double click opens one Checkout, a later visit a fresh one.
          idempotencyKey={randomUUID()}
        />
      </SetupFrame>
    );
  }
  if (payment.kind === "abandoned") {
    return (
      <SetupFrame name={tenant.data.name}>
        {notice}
        <AbandonedPanel tenantId={tenantId} canRetry={can(role, "manageBilling")} />
      </SetupFrame>
    );
  }

  return (
    <SetupFrame name={tenant.data.name}>
      {notice}
      {checkoutReturn && progress.progress.tenantStatus === "provisioning" ? (
        <Alert role="status" data-checkout="success">
          <AlertDescription>
            <p>{SETUP_STRINGS.checkoutConfirming}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      <ProvisioningProgress
        initial={progress.progress}
        isOwner={tenant.data.myRole === "owner"}
        storefrontUrl={`https://${tenant.data.primaryHost}/`}
        dashboardHref={otaPath(tenantId)}
        apiKeysHref={otaPath(tenantId, "/api-keys")}
        poll={getSetupProgress.bind(null, tenantId)}
        retry={retrySetup.bind(null, tenantId)}
        reveal={revealSetupKeys.bind(null, tenantId)}
      />
    </SetupFrame>
  );
}
