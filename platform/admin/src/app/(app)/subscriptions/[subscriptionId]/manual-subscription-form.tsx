"use client";

import type { components } from "@velexis/api-types/platform";
import { useId, useState } from "react";

import {
  updateManualSubscription,
  type ManualSubscriptionField,
  type ManualSubscriptionState,
} from "@/app/(app)/subscriptions/actions";
import { DateTime, formatDateTime } from "@/components/date-time";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MANUAL_SUBSCRIPTION_STRINGS as M,
  STATUS_LABELS,
  SUBSCRIPTION_DETAIL_STRINGS as D,
} from "@/lib/strings";

/**
 * "Edit the manual subscription" on `/subscriptions/[subscriptionId]` (README §2; subscription-billing flow §G, PF-75):
 * the plan, the day the trial ends and the status of a manual subscription, saved with the mandatory reason of
 * `ReasonDialog` and the version the page was rendered with (`If-Match`). Only what the admin changed is sent: a new
 * trial end keeps the time of day of the current one, in UTC (`2027-01-12T08:20:11Z` → `2027-02-12T08:20:11Z`). The
 * page renders this form for manual subscriptions only; Stripe-billed ones have none. The props are the fields the form
 * shows and the active plans it offers.
 */

type SubscriptionStatus = components["schemas"]["SubscriptionStatus"];

/** A plan the subscription can move to. */
export interface PlanChoice {
  readonly code: string;
  readonly name: string;
}

export interface ManualSubscriptionFormProps {
  readonly subscriptionId: string;
  /** The subscription version the page was rendered with (`AdminSubscription.version`). */
  readonly version: number;
  readonly planCode: string;
  readonly planName: string;
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: string | null;
  /** The active plans (`adminListPlans`); `null` when they could not be loaded, so only the current plan is kept. */
  readonly plans: readonly PlanChoice[] | null;
}

/** The statuses an admin may set (`UpdateManualSubscriptionRequest.status`). */
const EDITABLE_STATUSES = ["trialing", "canceled"] as const;

const STATUS_NAMES: Readonly<Record<SubscriptionStatus, string>> = STATUS_LABELS.subscription;

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** The UTC day of an instant (`2027-01-12`), or `""`. */
function dayOf(instant: string | null): string {
  if (instant === null) {
    return "";
  }
  const time = Date.parse(instant);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
}

/** The UTC time of day of an instant (`08:20:11`, or `08:20:11.250` with milliseconds); midnight for none. */
function timeOfDay(instant: string | null): string {
  const time = instant === null ? Number.NaN : Date.parse(instant);
  if (!Number.isFinite(time)) {
    return "00:00:00";
  }
  const clock = new Date(time).toISOString().slice(11, 23);
  return clock.endsWith(".000") ? clock.slice(0, 8) : clock;
}

/** The instant the trial ends on `day`, at `clock` UTC, or `undefined` when `day` is no calendar day. */
function trialEndOn(day: string, clock: string): string | undefined {
  if (!DATE.test(day)) {
    return undefined;
  }
  const instant = `${day}T${clock}Z`;
  const time = Date.parse(instant);
  // `Date.parse` rolls 2027-02-30 over to March: the day must come back as it was typed.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? instant : undefined;
}

function statusName(status: string): string {
  return Object.hasOwn(STATUS_NAMES, status)
    ? (STATUS_NAMES[status as SubscriptionStatus] ?? status)
    : status;
}

/** A day in the admin's words (`Feb 12, 2027`). */
function dayText(instant: string | null): string {
  return instant === null ? D.none : (formatDateTime(instant, { mode: "date" }) ?? instant);
}

const IDLE: ManualSubscriptionState = { status: "idle" };

/** A refused save's message at the field it belongs to, with the code for tests. */
function FieldProblem({
  id,
  code,
  message,
}: {
  readonly id: string;
  readonly code: string | undefined;
  readonly message: string | undefined;
}) {
  return (
    <p id={id} data-notice="failed" data-code={code} className="text-sm font-medium text-destructive">
      {message}
    </p>
  );
}

export function ManualSubscriptionForm(props: ManualSubscriptionFormProps) {
  const { subscriptionId, plans } = props;
  const { state, dispatch, isPending, stepUpDialog } = useStepUpAction(updateManualSubscription, IDLE);
  // The newest subscription known here: the page's, or the one the last save answered.
  const saved =
    state.status === "done" && state.subscription.version > props.version ? state.subscription : undefined;
  const current = {
    version: saved?.version ?? props.version,
    planCode: saved?.planCode ?? props.planCode,
    planName: saved?.planName ?? props.planName,
    status: saved?.status ?? props.status,
    trialEndsAt: saved === undefined ? props.trialEndsAt : saved.trialEndsAt,
  };

  const [planCode, setPlanCode] = useState(current.planCode);
  const [day, setDay] = useState(dayOf(current.trialEndsAt));
  const [status, setStatus] = useState<SubscriptionStatus>(current.status);
  const ids = { plan: useId(), day: useId(), status: useId() } as const;

  const choices: PlanChoice[] = (plans ?? []).filter((plan) => plan.code !== current.planCode);
  const planNames = new Map<string, string>([
    [current.planCode, current.planName],
    ...choices.map((plan): [string, string] => [plan.code, plan.name]),
  ]);
  const currentPlanActive = (plans ?? []).some((plan) => plan.code === current.planCode);
  const statuses = EDITABLE_STATUSES.filter((value) => value !== current.status);

  const newTrialEnd =
    day === dayOf(current.trialEndsAt) ? undefined : trialEndOn(day, timeOfDay(current.trialEndsAt));
  const dayInvalid = day !== dayOf(current.trialEndsAt) && newTrialEnd === undefined;
  const changes: {
    readonly field: ManualSubscriptionField;
    readonly value: string;
    readonly text: string;
  }[] = [];
  if (planCode !== current.planCode) {
    changes.push({
      field: "planCode",
      value: planCode,
      text: M.changePlan(current.planName, planNames.get(planCode) ?? planCode),
    });
  }
  if (newTrialEnd !== undefined) {
    changes.push({
      field: "trialEndsAt",
      value: newTrialEnd,
      text: M.changeTrialEnd(dayText(current.trialEndsAt), dayText(newTrialEnd)),
    });
  }
  if (status !== current.status) {
    changes.push({
      field: "status",
      value: status,
      text: M.changeStatus(statusName(current.status), statusName(status)),
    });
  }

  const failure = state.status === "failed" ? state : undefined;
  const fieldError = (field: ManualSubscriptionField): string | undefined =>
    failure?.field === field ? failure.message : undefined;
  const described = (field: ManualSubscriptionField, id: string) =>
    fieldError(field) === undefined
      ? { "aria-describedby": `${id}-hint` }
      : { "aria-describedby": `${id}-hint ${id}-error`, "aria-invalid": true as const };
  const dayHint =
    current.trialEndsAt === null
      ? M.trialEndHintMidnight
      : M.trialEndHint(timeOfDay(current.trialEndsAt).slice(0, 5));

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="grid content-start gap-2">
          <Label htmlFor={ids.plan}>{M.planLabel}</Label>
          <p id={`${ids.plan}-hint`} className="text-sm text-muted-foreground">
            {plans === null ? M.plansUnavailable : M.planHint}
          </p>
          <select
            id={ids.plan}
            value={planCode}
            className={SELECT_CLASS}
            {...described("planCode", ids.plan)}
            onChange={(event) => setPlanCode(event.currentTarget.value)}
          >
            <option value={current.planCode}>
              {currentPlanActive || plans === null
                ? M.currentPlan(current.planName)
                : M.retiredPlan(current.planName)}
            </option>
            {choices.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
          {fieldError("planCode") === undefined ? null : (
            <FieldProblem id={`${ids.plan}-error`} code={failure?.code} message={fieldError("planCode")} />
          )}
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor={ids.day}>{M.trialEndLabel}</Label>
          <p id={`${ids.day}-hint`} className="text-sm text-muted-foreground">
            {dayHint}
          </p>
          <Input
            id={ids.day}
            type="date"
            value={day}
            {...(dayInvalid || fieldError("trialEndsAt") !== undefined
              ? { "aria-describedby": `${ids.day}-hint ${ids.day}-error`, "aria-invalid": true }
              : { "aria-describedby": `${ids.day}-hint` })}
            onChange={(event) => setDay(event.currentTarget.value)}
          />
          {dayInvalid ? (
            <p id={`${ids.day}-error`} className="text-sm font-medium text-destructive">
              {M.trialEndInvalid}
            </p>
          ) : fieldError("trialEndsAt") === undefined ? null : (
            <FieldProblem id={`${ids.day}-error`} code={failure?.code} message={fieldError("trialEndsAt")} />
          )}
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor={ids.status}>{M.statusLabel}</Label>
          <p id={`${ids.status}-hint`} className="text-sm text-muted-foreground">
            {M.statusHint}
          </p>
          <select
            id={ids.status}
            value={status}
            className={SELECT_CLASS}
            {...described("status", ids.status)}
            onChange={(event) => setStatus(event.currentTarget.value as SubscriptionStatus)}
          >
            <option value={current.status}>{M.statusUnchanged(statusName(current.status))}</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {statusName(value)}
              </option>
            ))}
          </select>
          {fieldError("status") === undefined ? null : (
            <FieldProblem id={`${ids.status}-error`} code={failure?.code} message={fieldError("status")} />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ReasonDialog
          trigger={<Button disabled={isPending || changes.length === 0 || dayInvalid}>{M.save}</Button>}
          title={M.confirmTitle}
          description={
            <span className="grid gap-2">
              <span>{M.confirmDescription}</span>
              <span className="grid gap-1">
                {changes.map((change) => (
                  <span key={change.field} className="block font-medium text-foreground">
                    {change.text}
                  </span>
                ))}
              </span>
            </span>
          }
          confirmLabel={M.confirm}
          destructive={status === "canceled" && current.status !== "canceled"}
          onConfirm={dispatch}
        >
          <input type="hidden" name="subscriptionId" value={subscriptionId} />
          <input type="hidden" name="version" value={String(current.version)} />
          {changes.map((change) => (
            <input key={change.field} type="hidden" name={change.field} value={change.value} />
          ))}
        </ReasonDialog>
        {isPending ? <span className="text-sm text-muted-foreground">{M.working}</span> : null}
        {changes.length === 0 && !isPending ? (
          <span className="text-sm text-muted-foreground">{M.noChange}</span>
        ) : null}
      </div>

      {failure !== undefined && failure.field === undefined ? (
        <Alert variant="destructive" data-notice="failed" data-code={failure.code}>
          <AlertDescription>
            <p>{failure.message}</p>
            {failure.code === "PRECONDITION_FAILED" || failure.code === "CONFLICT" ? (
              // A full reload, so the page shows the subscription as it is now, with its new version.
              <a
                href={`/subscriptions/${encodeURIComponent(subscriptionId)}`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                {M.reload}
              </a>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {state.status === "done" ? (
        <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">{M.saved}</p>
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{M.savedPlan}</span>
            <span>
              {state.subscription.planName}{" "}
              <span className="font-mono text-xs text-muted-foreground">{state.subscription.planCode}</span>
            </span>
          </p>
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{M.savedTrialEnd}</span>
            {state.subscription.trialEndsAt === null ? (
              D.none
            ) : (
              <DateTime value={state.subscription.trialEndsAt} />
            )}
          </p>
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{M.savedStatus}</span>
            <StatusBadge kind="subscription" status={state.subscription.status} />
          </p>
        </div>
      ) : null}
      {stepUpDialog}
    </div>
  );
}
