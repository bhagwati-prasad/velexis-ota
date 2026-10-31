"use client";

import Link from "next/link";
import { startTransition, useActionState, useId, useRef, useState } from "react";

import { generateSettlements, type GenerateSettlementsState } from "@/app/(app)/settlements/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { GENERATE_SETTLEMENTS_STRINGS as G } from "@/lib/strings";

/** A closed month the form offers: its URL value (`YYYY-MM`) and its name ("February 2027"). */
export interface MonthOption {
  readonly value: string;
  readonly label: string;
}

export interface GenerateDraftsFormProps {
  /** The months that have ended, newest first; the first one is preselected. */
  readonly months: readonly MonthOption[];
  /** The OTA the list is limited to (`tenantId` of the URL), whose drafts alone may be rebuilt; `null` for none. */
  readonly tenantId: string | null;
}

const IDLE: GenerateSettlementsState = { status: "idle" };

const SELECT_CLASS =
  "h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";

/**
 * "Generate drafts" on `/settlements` (README §2, PF-91): the month (a closed calendar month, UTC) and, on a list
 * limited to one OTA, whether to rebuild that OTA's drafts only. `ConfirmDialog` says what the generation does first:
 * the month's drafts are rebuilt from scratch and lose their adjustments, while approved, paid and carried-forward
 * statements stay. The outcome says the job is queued and links the month's drafts; `period_not_closed` shows at the
 * month. The component gets the month names and the OTA's id only.
 */
export function GenerateDraftsForm({ months, tenantId }: GenerateDraftsFormProps) {
  const [state, dispatch, isPending] = useActionState(generateSettlements, IDLE);
  const [period, setPeriod] = useState(months[0]?.value ?? "");
  const [onlyTenant, setOnlyTenant] = useState(tenantId !== null);
  const formRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const monthId = useId();
  const onlyId = useId();
  const monthLabel = months.find((month) => month.value === period)?.label ?? period;
  const monthError = state.status === "failed" ? state.monthError : undefined;
  const queuedLabel =
    state.status === "queued"
      ? (months.find((month) => month.value === state.period)?.label ?? state.period)
      : "";

  function run(): void {
    const form = formRef.current;
    if (form === null) {
      return;
    }
    const formData = new FormData(form);
    startTransition(() => dispatch(formData));
  }

  return (
    <section
      aria-labelledby={titleId}
      className="grid gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xs"
    >
      <div className="grid gap-1">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {G.title}
        </h2>
        <p className="text-sm text-muted-foreground">{G.intro}</p>
      </div>
      <form
        ref={formRef}
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          // The confirmation dialog runs the generation; Enter in the form only opens nothing.
          event.preventDefault();
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor={monthId}>{G.monthLabel}</Label>
          <p id={`${monthId}-hint`} className="text-sm text-muted-foreground">
            {G.monthHint}
          </p>
          <select
            id={monthId}
            name="period"
            value={period}
            className={SELECT_CLASS}
            aria-describedby={
              monthError === undefined ? `${monthId}-hint` : `${monthId}-hint ${monthId}-error`
            }
            {...(monthError === undefined ? {} : { "aria-invalid": true })}
            onChange={(event) => setPeriod(event.currentTarget.value)}
          >
            {months.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
          {monthError === undefined ? null : (
            <p id={`${monthId}-error`} className="text-sm font-medium text-destructive">
              {monthError}
            </p>
          )}
        </div>
        {tenantId === null ? null : (
          <div className="flex items-start gap-3">
            <input
              id={onlyId}
              type="checkbox"
              name="tenantId"
              value={tenantId}
              checked={onlyTenant}
              className="mt-1 size-4"
              aria-describedby={`${onlyId}-hint`}
              onChange={(event) => setOnlyTenant(event.currentTarget.checked)}
            />
            <div className="grid gap-1">
              <Label htmlFor={onlyId}>{G.onlyTenantLabel}</Label>
              <p id={`${onlyId}-hint`} className="text-sm text-muted-foreground">
                {G.onlyTenantHint(tenantId)}
              </p>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <ConfirmDialog
            trigger={
              <Button type="button" disabled={isPending || months.length === 0}>
                {G.submit}
              </Button>
            }
            title={G.confirmTitle(monthLabel)}
            description={
              tenantId !== null && onlyTenant
                ? G.confirmOneTenant(monthLabel)
                : G.confirmEveryTenant(monthLabel)
            }
            confirmLabel={G.confirm}
            destructive={false}
            onConfirm={run}
          />
          {isPending ? <span className="text-sm text-muted-foreground">{G.working}</span> : null}
        </div>
      </form>
      {state.status === "failed" && state.message !== undefined ? (
        <Alert variant="destructive" data-notice="failed" data-code={state.code}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      {state.status === "queued" ? (
        <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">{G.queued(queuedLabel)}</p>
          <p>
            <Link
              href={`/settlements?${new URLSearchParams({
                status: "draft",
                period: state.period,
                ...(state.tenantId === null ? {} : { tenantId: state.tenantId }),
              }).toString()}`}
              className="font-medium underline underline-offset-4"
            >
              {G.showDrafts}
            </Link>
          </p>
        </div>
      ) : null}
    </section>
  );
}
