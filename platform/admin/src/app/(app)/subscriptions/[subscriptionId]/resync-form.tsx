"use client";

import { resyncSubscription, type ResyncState } from "@/app/(app)/subscriptions/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status-badge";
import { isStepUpRequired, useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RESYNC_STRINGS as S, SUBSCRIPTION_DETAIL_STRINGS as D } from "@/lib/strings";

/**
 * "Resync from Stripe" on `/subscriptions/[subscriptionId]` (README §2; subscription-billing flow §D note of PBE-048;
 * PF-89, PAD-012): offered by the page on a Stripe-billed subscription with a Stripe subscription only, the one state in
 * which `adminResyncSubscription` resyncs. `ConfirmDialog` says what the resync does (no reason: the operation asks for
 * none); the outcome shows the status and period Stripe has now while the revalidated page shows the whole row, and a
 * `409` (billing sync could not apply the subscription, an event holds its lock) or a Stripe failure is worded. The
 * props are the two ids the action needs.
 */

const IDLE: ResyncState = { status: "idle" };

export interface ResyncFormProps {
  readonly subscriptionId: string;
  readonly tenantId: string;
}

export function ResyncForm({ subscriptionId, tenantId }: ResyncFormProps) {
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(resyncSubscription, IDLE);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ConfirmDialog
          trigger={
            <Button variant="outline" disabled={isPending}>
              {S.resync}
            </Button>
          }
          title={S.confirmTitle}
          description={S.confirmDescription}
          confirmLabel={S.confirm}
          destructive={false}
          onConfirm={() => {
            const formData = new FormData();
            formData.set("subscriptionId", subscriptionId);
            formData.set("tenantId", tenantId);
            dispatch(formData);
          }}
        />
        {isPending ? <span className="text-sm text-muted-foreground">{S.working}</span> : null}
      </div>
      <Outcome state={state} />
      {stepUpDialog}
    </div>
  );
}

/** The outcome of the last resync; a step-up request is no answer yet. */
function Outcome({ state }: { readonly state: ResyncState }) {
  if (state.status === "idle" || isStepUpRequired(state)) {
    return null;
  }
  if (state.status === "failed") {
    return (
      <Alert variant="destructive" data-notice="failed" data-code={state.code}>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  const { subscription } = state;
  return (
    <div role="status" data-notice="done" className="grid gap-1 rounded-lg border px-4 py-3 text-sm">
      <p className="font-medium">{S.done}</p>
      <p className="flex flex-wrap items-center gap-2">
        {S.doneStatus} <StatusBadge kind="subscription" status={subscription.status} />
      </p>
      <p>
        {S.donePeriodEnd}{" "}
        {subscription.currentPeriodEnd === null ? D.none : <DateTime value={subscription.currentPeriodEnd} />}
      </p>
    </div>
  );
}
