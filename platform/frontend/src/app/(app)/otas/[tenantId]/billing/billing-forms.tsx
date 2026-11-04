"use client";

import { LoaderCircle } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { startTransition, useActionState, useCallback, useEffect, useState, type FormEvent } from "react";

import type {
  CheckoutSyncPoll,
  ChoosePlanState,
  PortalState,
} from "@/app/(app)/otas/[tenantId]/billing/actions";
import {
  DEFAULT_BILLING_INTERVAL,
  PlanPicker,
  checkoutAvailable,
  type BillingInterval,
  type Plan,
} from "@/app/(app)/otas/new/plan-picker";
import { fieldId } from "@/components/form-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { otaPath } from "@/lib/roles";
import { BILLING_STRINGS } from "@/lib/strings";

/**
 * The client parts of the billing page (PFE-021; README §2 `/otas/[tenantId]/billing`, §5 polling and external
 * navigations, §7; flows/subscription-billing.md §B, §F; PF-72):
 *
 * - `ChoosePlanForm` ("Choose a plan", owners): the public plans Stripe Checkout can start (`PlanPicker` with the
 *   "Annual billing" switch, as in the create-OTA wizard) and "Continue to payment", which calls `startCheckout`;
 * - `ManageInStripeForm` ("Manage in Stripe", owners of a Stripe subscription): one button calling
 *   `openCustomerPortal`;
 * - `CheckoutConfirmation` (back from Stripe, `?checkout=success`): reads the subscription every 2 seconds with
 *   `getCheckoutSync` until the completed Checkout has reached Velexis, then renders the page again.
 *
 * The forms' action is a function of this module that dispatches the page's server action in a transition, never the
 * server action itself: React renders a server action passed straight to `<form action>` as a form the browser can
 * post natively before hydration, and that post would end with the action's `303` to Stripe, which the policy's
 * `form-action 'self'` blocks. A submit made before hydration is replayed once React has hydrated, and the action's
 * `redirect()` to Stripe is followed by the router as a top-level navigation. Nothing here is secret, no URL is built
 * here, and a refusal shows the portal's words only.
 */

/** The state before the first submission. */
const CHOOSE_PLAN_IDLE: ChoosePlanState = Object.freeze({ status: "idle" });
const PORTAL_IDLE: PortalState = Object.freeze({ status: "idle" });

/** A server action of the page, bound to the OTA, as `useActionState` takes it. */
type StateAction<State> = (previous: State, formData: FormData) => Promise<State>;

/** "Reload the page": a full reload of the billing page, for refusals that mean the page is out of date. */
function ReloadLink({ tenantId }: { readonly tenantId: string }) {
  return (
    <p className="text-sm">
      <a href={otaPath(tenantId, "/billing")} className="font-medium underline underline-offset-4">
        {BILLING_STRINGS.reload}
      </a>
    </p>
  );
}

/**
 * `dispatch` of `useActionState`, called in a transition, for a form's action and its submit handler (see the module
 * comment).
 */
function useFormDispatch<State>(action: StateAction<State>, initialState: Awaited<State>) {
  const [state, dispatchAction, isPending] = useActionState(action, initialState);
  const dispatch = useCallback(
    (formData: FormData) => {
      startTransition(() => dispatchAction(formData));
    },
    [dispatchAction],
  );
  return { state, dispatch, isPending };
}

// ---- Choose a plan ------------------------------------------------------------------------------------------------

export interface ChoosePlanFormProps {
  readonly tenantId: string;
  /** The public plans Stripe Checkout can start with at least one billing interval, in `listPlans`' order. */
  readonly plans: readonly Plan[];
  /** Shown instead of the plans when there is none to choose (`listPlans` failed, or no plan has a Stripe price). */
  readonly unavailable?: string | undefined;
  /** The `Idempotency-Key` the page made when it rendered: one Checkout per rendering of the page. */
  readonly idempotencyKey: string;
  /** `startCheckout`, bound to the OTA. */
  readonly action: StateAction<ChoosePlanState>;
}

/** The plan the form starts with: the only plan, when it can be billed monthly (the interval the form starts on). */
function initialPlanCode(plans: readonly Plan[]): string {
  const [only] = plans;
  return plans.length === 1 && only !== undefined && checkoutAvailable(only, DEFAULT_BILLING_INTERVAL)
    ? only.code
    : "";
}

/**
 * "Choose a plan": the plans under the "Annual billing" switch (a plan Checkout cannot start with the chosen interval
 * is shown disabled with the reason), and "Continue to payment". A chosen plan the new interval cannot bill is no
 * longer chosen, so the submit asks for one; "Choose a plan." shows at the plans without a call.
 */
export function ChoosePlanForm({
  tenantId,
  plans,
  unavailable,
  idempotencyKey,
  action,
}: ChoosePlanFormProps) {
  const { state, dispatch, isPending } = useFormDispatch(action, CHOOSE_PLAN_IDLE);
  const [planCode, setPlanCode] = useState(() => initialPlanCode(plans));
  const [interval, setBillingInterval] = useState<BillingInterval>(DEFAULT_BILLING_INTERVAL);
  /** "Choose a plan." after a submit without a plan; cleared when a plan is chosen. */
  const [planMissing, setPlanMissing] = useState(false);

  function onIntervalChange(next: BillingInterval): void {
    setBillingInterval(next);
    const plan = plans.find((candidate) => candidate.code === planCode);
    if (plan !== undefined && !checkoutAvailable(plan, next)) {
      setPlanCode("");
    }
  }

  function onPlanChange(code: string): void {
    setPlanCode(code);
    setPlanMissing(false);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      return;
    }
    if (planCode === "") {
      setPlanMissing(true);
      document.getElementById(fieldId("planCode"))?.focus();
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  const planError = planMissing ? BILLING_STRINGS.planRequired : state.fieldErrors?.planCode;
  return (
    <form action={dispatch} onSubmit={onSubmit} noValidate className="grid gap-4" data-form="choose-plan">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <PlanPicker
        plans={plans}
        value={planCode}
        onChange={onPlanChange}
        interval={interval}
        onIntervalChange={onIntervalChange}
        note={BILLING_STRINGS.trialNote}
        unavailable={unavailable}
        error={planError}
        intervalError={state.fieldErrors?.billingInterval}
      />
      {unavailable === undefined ? (
        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? (
              <>
                <LoaderCircle aria-hidden="true" className="animate-spin" />
                {BILLING_STRINGS.openingCheckout}
              </>
            ) : (
              BILLING_STRINGS.continueToPayment
            )}
          </Button>
        </div>
      ) : null}
      {state.message === undefined ? null : (
        <Alert variant="destructive" data-checkout-problem={state.code}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {state.reload === true ? <ReloadLink tenantId={tenantId} /> : null}
    </form>
  );
}

// ---- Manage in Stripe ---------------------------------------------------------------------------------------------

export interface ManageInStripeFormProps {
  readonly tenantId: string;
  /** `openCustomerPortal`, bound to the OTA. */
  readonly action: StateAction<PortalState>;
}

/** "Manage in Stripe": opens the Stripe Customer Portal; a refusal shows its message under the button. */
export function ManageInStripeForm({ tenantId, action }: ManageInStripeFormProps) {
  const { state, dispatch, isPending } = useFormDispatch(action, PORTAL_IDLE);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      return;
    }
    dispatch(new FormData(event.currentTarget));
  }

  return (
    <form
      action={dispatch}
      onSubmit={onSubmit}
      noValidate
      className="grid gap-3"
      data-form="manage-in-stripe"
    >
      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <>
              <LoaderCircle aria-hidden="true" className="animate-spin" />
              {BILLING_STRINGS.openingPortal}
            </>
          ) : (
            BILLING_STRINGS.manageInStripe
          )}
        </Button>
      </div>
      {state.message === undefined ? null : (
        <Alert variant="destructive" data-portal-problem={state.code}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {state.reload === true ? <ReloadLink tenantId={tenantId} /> : null}
    </form>
  );
}

// ---- Back from Stripe ---------------------------------------------------------------------------------------------

/** How long the page waits between two reads of the subscription (README §5). */
export const CHECKOUT_POLL_INTERVAL_MS = 2_000;

/** The longest wait a `Retry-After` may ask for between two reads. */
const MAX_POLL_DELAY_MS = 60_000;

/**
 * The call of a server action was rejected with Next.js's `redirect()` or `notFound()`, which the router must handle,
 * rather than failing on its own (the portal could not be reached).
 */
function isNavigation(error: unknown): boolean {
  try {
    unstable_rethrow(error);
  } catch {
    return true;
  }
  return false;
}

export interface CheckoutConfirmationProps {
  /** One read of the subscription: `getCheckoutSync`, bound to the OTA. */
  readonly poll: () => Promise<CheckoutSyncPoll>;
}

/**
 * Back from Stripe (`?checkout=success`) before the completed Checkout has reached Velexis (PFE-021 note of
 * 2026-11-03, lead decision (2i); flows/subscription-billing.md §B, §D): the page does not show a success yet. It says
 * that the payment is being confirmed and reads the subscription every 2 seconds, one read at a time, until it is a
 * Stripe subscription that is `trialing` or `active`; then the router renders the page again, which shows the
 * subscription (and, for an OTA whose set-up starts again, the way to its set-up page). A read that may pass (rate
 * limit, API unavailable, the portal unreachable) is tried again with a note, after its `Retry-After` (at most a
 * minute); any other failure stops with the portal's message. An ended session's `redirect()` is thrown again while
 * rendering, so the router's redirect boundary navigates.
 */
export function CheckoutConfirmation({ poll }: CheckoutConfirmationProps) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  /** A read that failed but is tried again. */
  const [pollNote, setPollNote] = useState<string | undefined>(undefined);
  /** A read that failed for good: polling stopped. */
  const [pollStopped, setPollStopped] = useState<string | undefined>(undefined);
  /** The `redirect()` an action ended with, thrown again while rendering. */
  const [navigation, setNavigation] = useState<{ readonly error: unknown } | undefined>(undefined);

  const polling = !confirmed && pollStopped === undefined && navigation === undefined;

  useEffect(() => {
    if (!polling) {
      return undefined;
    }
    // One read at a time: the next one is scheduled when the previous answer arrived. The cleanup (the component going
    // away) cancels the chain, and a late answer of the old chain changes nothing.
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        poll().then(
          (result) => {
            if (!current) {
              return;
            }
            if (result.status === "ok") {
              setPollNote(undefined);
              if (result.confirmed) {
                setConfirmed(true);
                router.refresh();
                return;
              }
              schedule(CHECKOUT_POLL_INTERVAL_MS);
              return;
            }
            if (result.transient) {
              setPollNote(BILLING_STRINGS.pollFailed);
              const wait = (result.retryAfterSeconds ?? 0) * 1_000;
              schedule(Math.min(Math.max(CHECKOUT_POLL_INTERVAL_MS, wait), MAX_POLL_DELAY_MS));
              return;
            }
            setPollNote(undefined);
            setPollStopped(result.message);
          },
          (error: unknown) => {
            if (!current) {
              return;
            }
            if (isNavigation(error)) {
              // The session ended: the router leaves the page, and no read follows.
              setNavigation({ error });
              return;
            }
            // The portal itself could not be reached: try again.
            setPollNote(BILLING_STRINGS.pollFailed);
            schedule(CHECKOUT_POLL_INTERVAL_MS);
          },
        );
      }, delay);
    };
    schedule(CHECKOUT_POLL_INTERVAL_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [polling, poll, router]);

  if (navigation !== undefined) {
    // While rendering, where the router's redirect boundary catches it and navigates.
    throw navigation.error;
  }

  return (
    <div className="grid gap-3">
      {/* A live region from the first render, so the confirmation and the notes are read out when they change. */}
      <Alert role="status" data-checkout={confirmed ? "confirmed" : "confirming"}>
        {confirmed ? null : <LoaderCircle aria-hidden="true" className="animate-spin" />}
        <AlertTitle>
          {confirmed ? BILLING_STRINGS.checkoutConfirmedTitle : BILLING_STRINGS.checkoutConfirmingTitle}
        </AlertTitle>
        <AlertDescription>
          <p>{confirmed ? BILLING_STRINGS.checkoutConfirmed : BILLING_STRINGS.checkoutConfirming}</p>
          {pollNote === undefined ? null : <p data-poll-note="">{pollNote}</p>}
        </AlertDescription>
      </Alert>
      {pollStopped === undefined ? null : (
        <Alert variant="destructive" data-poll-stopped="">
          <AlertTitle>{BILLING_STRINGS.pollStoppedTitle}</AlertTitle>
          <AlertDescription>{pollStopped}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
