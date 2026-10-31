"use client";

import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { useId, useState, type FormEvent, type ReactNode } from "react";

import {
  addSettlementAdjustment,
  approveSettlement,
  markSettlementPaid,
  voidSettlement,
  type SettlementActionKind,
  type SettlementActionState,
  type SettlementField,
} from "@/app/(app)/settlements/[settlementId]/actions";
import { adjustmentDecimals, amountProblem } from "@/app/(app)/settlements/[settlementId]/adjustment-amount";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { formatMoney } from "@/components/money";
import { normalizeReason, ReasonDialog, reasonLength, reasonProblem } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { useStepUpAction } from "@/components/step-up-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REASON_STRINGS, SETTLEMENT_ACTION_STRINGS as A, SETTLEMENT_DETAIL_STRINGS } from "@/lib/strings";

type Schemas = components["schemas"];

export interface SettlementActionsProps {
  readonly settlementId: string;
  /** The status the page was rendered with: it decides which actions are offered. */
  readonly status: Schemas["AdminSettlementStatus"];
  /** The version the page was rendered with, sent in `If-Match` by approve and mark paid. */
  readonly version: number;
  /** The statement's currency: an adjustment's currency, and the decimals its amount may have. */
  readonly currency: string;
  readonly netAmount: Schemas["Money"];
  readonly payoutAccountStatus: Schemas["PayoutAccountStatus"] | null;
  readonly tenantId: string;
  readonly tenantName: string;
  /** The statement's month in words ("February 2027"), for the dialogs' questions. */
  readonly month: string;
  /** Today in UTC (`YYYY-MM-DD`): the latest transfer date, and the one the form starts with. */
  readonly today: string;
}

const IDLE: SettlementActionState = { status: "idle" };

const DESCRIPTION_MAX = 500;
const REFERENCE_MAX = 200;

/** A decimal string above zero. */
function isPositive(amount: string): boolean {
  return !amount.startsWith("-") && /[1-9]/.test(amount);
}

/** The length of `value` as JSON Schema counts it (code points). */
function codePoints(value: string): number {
  return [...value].length;
}

function payoutHref(tenantId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}?tab=connections`;
}

/** The answer an action form shows: a step-up request is no answer yet (the dialog is open, nothing was saved). */
function answered(state: SettlementActionState): SettlementActionState {
  return state.stepUp === true ? IDLE : state;
}

/** What each action says when it is done. */
function doneMessage(action: SettlementActionKind, status: Schemas["AdminSettlementStatus"]): string {
  switch (action) {
    case "adjust":
      return A.added;
    case "approve":
      return status === "carried_forward" ? A.carriedForward : A.approved;
    case "markPaid":
      return A.paid;
    case "void":
      return A.voided;
  }
}

function Outcome({
  state,
  settlementId,
}: {
  readonly state: SettlementActionState;
  readonly settlementId: string;
}) {
  const shown = answered(state);
  if (shown.status === "idle") {
    return null;
  }
  if (shown.status === "failed") {
    if (shown.message === undefined) {
      return null;
    }
    return (
      <Alert variant="destructive" data-notice="failed" data-code={shown.code}>
        <AlertDescription>
          <p>{shown.message}</p>
          {shown.code === "PRECONDITION_FAILED" ? (
            // A full reload, so the page shows the statement as it is now, with its new version.
            <a
              href={`/settlements/${encodeURIComponent(settlementId)}`}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {A.reload}
            </a>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div role="status" data-notice="done" className="grid gap-2 rounded-lg border px-4 py-3 text-sm">
      <p className="font-medium">{doneMessage(shown.action, shown.settlement.status)}</p>
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{A.statusNow}</span>
        <StatusBadge kind="settlement" status={shown.settlement.status} />
      </p>
    </div>
  );
}

/** The attributes that tie a control to its hint and, when there is one, its problem. */
type Described = { readonly "aria-describedby": string; readonly "aria-invalid"?: true };

/** A labelled field with its hint and its problem, wired for screen readers. */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly error: string | undefined;
  readonly children: (described: Described) => ReactNode;
}) {
  const described: Described =
    error === undefined
      ? { "aria-describedby": `${id}-hint` }
      : { "aria-describedby": `${id}-hint ${id}-error`, "aria-invalid": true };
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {hint}
      </p>
      {children(described)}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

type Problems = Partial<Record<SettlementField, string>>;

/** The problems of the adjustment form, as the server action and the API count them. */
function adjustmentProblems(values: AdjustmentValues, currency: string): Problems {
  const problems: Problems = {};
  const amount = amountProblem(values.amount, currency);
  if (amount !== undefined) {
    problems.amount =
      amount.kind === "required"
        ? A.amountRequired
        : amount.kind === "format"
          ? A.amountFormat
          : amount.kind === "zero"
            ? A.amountZero
            : A.amountDecimals(currency, amount.decimals);
  }
  const description = values.description.trim();
  if (description === "") {
    problems.description = A.descriptionRequired;
  } else if (codePoints(description) > DESCRIPTION_MAX) {
    problems.description = A.descriptionTooLong;
  }
  const reason = reasonProblem(values.reason);
  if (reason !== undefined) {
    problems.reason = reason;
  }
  return problems;
}

interface AdjustmentValues {
  readonly amount: string;
  readonly description: string;
  readonly reason: string;
}

const EMPTY_ADJUSTMENT: AdjustmentValues = { amount: "", description: "", reason: "" };

/**
 * "Add an adjustment" of a draft: the signed amount (its decimals checked against the currency's minor units before
 * anything is sent), the line's description and the reason of the audit row. The problems show at their fields, the
 * API's `422` `amount_precision` too; a saved adjustment empties the form.
 */
function AdjustmentForm({
  settlementId,
  currency,
  state,
  current,
  isPending,
  dispatch,
}: {
  readonly settlementId: string;
  readonly currency: string;
  /** The adjustment action's own state, whichever action ran last. */
  readonly state: SettlementActionState;
  /** The adjustment is the action that ran last, so its problems show at the fields. */
  readonly current: boolean;
  readonly isPending: boolean;
  readonly dispatch: (formData: FormData) => void;
}) {
  const titleId = useId();
  const ids = { amount: useId(), description: useId(), reason: useId() };
  const [values, setValues] = useState<AdjustmentValues>(EMPTY_ADJUSTMENT);
  // The problems found in the browser at the last submission; `undefined` once it went to the server.
  const [local, setLocal] = useState<Problems | undefined>(undefined);
  // A saved adjustment empties the form, once per answer of the adjustment action itself: another action running in
  // between (an approval refused) must not make an earlier answer look new and empty what was just typed.
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.status === "done") {
      setValues(EMPTY_ADJUSTMENT);
    }
  }
  const shown = current ? answered(state) : IDLE;
  const problems: Problems = local ?? (shown.status === "failed" ? shown.fieldErrors : {});
  const decimals = adjustmentDecimals(currency);

  function set(field: keyof AdjustmentValues, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      return;
    }
    const found = adjustmentProblems(values, currency);
    const first = (["amount", "description", "reason"] as const).find((field) => found[field] !== undefined);
    if (first !== undefined) {
      setLocal(found);
      document.getElementById(ids[first])?.focus();
      return;
    }
    setLocal(undefined);
    const formData = new FormData();
    formData.set("settlementId", settlementId);
    formData.set("currency", currency);
    formData.set("amount", values.amount.trim());
    formData.set("description", values.description.trim());
    formData.set("reason", normalizeReason(values.reason));
    dispatch(formData);
  }

  return (
    <form noValidate onSubmit={submit} aria-labelledby={titleId} className="grid gap-4 rounded-lg border p-4">
      <h3 id={titleId} className="text-base font-semibold">
        {A.adjustmentTitle}
      </h3>
      <Field
        id={ids.amount}
        label={A.amountLabel(currency)}
        hint={A.amountHint(currency, decimals)}
        error={problems.amount}
      >
        {(described) => (
          <Input
            id={ids.amount}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            value={values.amount}
            className="max-w-xs"
            {...described}
            onChange={(event) => set("amount", event.currentTarget.value)}
          />
        )}
      </Field>
      <Field
        id={ids.description}
        label={A.descriptionLabel}
        hint={A.descriptionHint}
        error={problems.description}
      >
        {(described) => (
          <Input
            id={ids.description}
            name="description"
            maxLength={DESCRIPTION_MAX}
            autoComplete="off"
            value={values.description}
            {...described}
            onChange={(event) => set("description", event.currentTarget.value)}
          />
        )}
      </Field>
      <Field id={ids.reason} label={REASON_STRINGS.label} hint={REASON_STRINGS.hint} error={problems.reason}>
        {(described) => (
          <>
            <Textarea
              id={ids.reason}
              name="reason"
              rows={3}
              value={values.reason}
              {...described}
              onChange={(event) => set("reason", event.currentTarget.value)}
            />
            <p className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
              {REASON_STRINGS.counter(reasonLength(values.reason))}
            </p>
          </>
        )}
      </Field>
      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? A.adding : A.addAdjustment}
        </Button>
      </div>
    </form>
  );
}

interface PaidValues {
  readonly paidOn: string;
  readonly payoutReference: string;
}

/** The problems of the mark-paid form, as the server action and the API count them. */
function paidProblems(values: PaidValues, today: string): Problems {
  const problems: Problems = {};
  const paidOn = values.paidOn.trim();
  if (paidOn === "") {
    problems.paidOn = A.paidOnRequired;
  } else if (
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(paidOn) ||
    Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))
  ) {
    problems.paidOn = A.paidOnInvalid;
  } else if (paidOn > today) {
    problems.paidOn = A.paidOnFuture;
  }
  const reference = values.payoutReference.trim();
  if (reference === "") {
    problems.payoutReference = A.referenceRequired;
  } else if (codePoints(reference) > REFERENCE_MAX) {
    problems.payoutReference = A.referenceTooLong;
  }
  return problems;
}

/**
 * "Record the bank transfer" of an approved statement: the transfer's day (UTC, not in the future) and the bank's
 * reference, sent with the version in `If-Match`; the API asks for the step-up.
 */
function MarkPaidForm({
  settlementId,
  version,
  today,
  state,
  isPending,
  dispatch,
}: {
  readonly settlementId: string;
  readonly version: number;
  readonly today: string;
  readonly state: SettlementActionState;
  readonly isPending: boolean;
  readonly dispatch: (formData: FormData) => void;
}) {
  const titleId = useId();
  const ids = { paidOn: useId(), payoutReference: useId() };
  const [values, setValues] = useState<PaidValues>({ paidOn: today, payoutReference: "" });
  const [local, setLocal] = useState<Problems | undefined>(undefined);
  const shown = answered(state);
  const problems: Problems = local ?? (shown.status === "failed" ? shown.fieldErrors : {});

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isPending) {
      return;
    }
    const found = paidProblems(values, today);
    const first = (["paidOn", "payoutReference"] as const).find((field) => found[field] !== undefined);
    if (first !== undefined) {
      setLocal(found);
      document.getElementById(ids[first])?.focus();
      return;
    }
    setLocal(undefined);
    const formData = new FormData();
    formData.set("settlementId", settlementId);
    formData.set("version", String(version));
    formData.set("paidOn", values.paidOn.trim());
    formData.set("payoutReference", values.payoutReference.trim());
    dispatch(formData);
  }

  return (
    <form noValidate onSubmit={submit} aria-labelledby={titleId} className="grid gap-4 rounded-lg border p-4">
      <h3 id={titleId} className="text-base font-semibold">
        {A.markPaidTitle}
      </h3>
      <Field id={ids.paidOn} label={A.paidOnLabel} hint={A.paidOnHint} error={problems.paidOn}>
        {(described) => (
          <Input
            id={ids.paidOn}
            name="paidOn"
            type="date"
            max={today}
            value={values.paidOn}
            className="max-w-xs"
            {...described}
            onChange={(event) => {
              const paidOn = event.currentTarget.value;
              setValues((previous) => ({ ...previous, paidOn }));
            }}
          />
        )}
      </Field>
      <Field
        id={ids.payoutReference}
        label={A.referenceLabel}
        hint={A.referenceHint}
        error={problems.payoutReference}
      >
        {(described) => (
          <Input
            id={ids.payoutReference}
            name="payoutReference"
            maxLength={REFERENCE_MAX}
            autoComplete="off"
            value={values.payoutReference}
            {...described}
            onChange={(event) => {
              const payoutReference = event.currentTarget.value;
              setValues((previous) => ({ ...previous, payoutReference }));
            }}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? A.marking : A.markPaid}
        </Button>
      </div>
    </form>
  );
}

/**
 * The review of one statement (README §2 `/settlements/[settlementId]`, PF-91), offered by the statement's status as
 * the API allows it (`actions.ts` sends what each operation requires):
 *
 * - a **draft**: "Add an adjustment" (amount, description, reason), **Approve** (`ConfirmDialog`, then the step-up the
 *   API asks for; `If-Match`) and **Void draft** (`ReasonDialog`);
 * - an **approved** statement: "Record the bank transfer" (transfer day, bank reference; step-up, `If-Match`), with a
 *   link to the OTA's payout account, whose bank details are revealed there;
 * - a **paid**, **carried-forward** or **void** statement: nothing, as it can no longer change.
 *
 * The outcome of the last action stays below the forms while the revalidated page shows the statement as it is now.
 */
export function SettlementActions({
  settlementId,
  status,
  version,
  currency,
  netAmount,
  payoutAccountStatus,
  tenantId,
  tenantName,
  month,
  today,
}: SettlementActionsProps) {
  const adjust = useStepUpAction(addSettlementAdjustment, IDLE);
  const approve = useStepUpAction(approveSettlement, IDLE);
  const markPaid = useStepUpAction(markSettlementPaid, IDLE);
  const voidDraft = useStepUpAction(voidSettlement, IDLE);
  const actions = { adjust, approve, markPaid, void: voidDraft } as const;
  // The outcome shown is the one of the action that ran last.
  const [latest, setLatest] = useState<SettlementActionKind | undefined>(undefined);
  const pending = Object.values(actions).some((action) => action.isPending);
  const outcome = latest === undefined ? IDLE : actions[latest].state;
  const positive = isPositive(netAmount.amount);
  const net = formatMoney(netAmount) ?? `${netAmount.amount} ${netAmount.currency}`;

  function run(action: SettlementActionKind, formData: FormData): void {
    setLatest(action);
    actions[action].dispatch(formData);
  }

  const payoutLink = (
    <Link href={payoutHref(tenantId)} className="font-medium underline underline-offset-4">
      {SETTLEMENT_DETAIL_STRINGS.openPayout(tenantName)}
    </Link>
  );

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{A.intro[status]}</p>
      {status === "draft" ? (
        <>
          <AdjustmentForm
            settlementId={settlementId}
            currency={currency}
            state={adjust.state}
            current={latest === "adjust"}
            isPending={adjust.isPending}
            dispatch={(formData) => run("adjust", formData)}
          />
          {positive && payoutAccountStatus !== "verified" ? (
            <p className="text-sm" data-note="payout">
              {A.payoutWarning} {payoutLink}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <ConfirmDialog
              trigger={<Button disabled={pending}>{A.approve}</Button>}
              title={A.approveTitle(tenantName, month)}
              description={positive ? A.approvePositive(net) : A.approveNotPositive}
              confirmLabel={A.approveConfirm}
              destructive={false}
              onConfirm={() => {
                const formData = new FormData();
                formData.set("settlementId", settlementId);
                formData.set("version", String(version));
                run("approve", formData);
              }}
            />
            <ReasonDialog
              trigger={
                <Button variant="destructive" disabled={pending}>
                  {A.void}
                </Button>
              }
              title={A.voidTitle(tenantName, month)}
              description={A.voidDescription}
              confirmLabel={A.voidConfirm}
              onConfirm={(formData) => run("void", formData)}
            >
              <input type="hidden" name="settlementId" value={settlementId} />
            </ReasonDialog>
            {pending ? <span className="text-sm text-muted-foreground">{A.working}</span> : null}
          </div>
        </>
      ) : null}
      {status === "approved" ? (
        <>
          <p className="text-sm">
            {A.revealToPay} {payoutLink}
          </p>
          <MarkPaidForm
            settlementId={settlementId}
            version={version}
            today={today}
            state={latest === "markPaid" ? markPaid.state : IDLE}
            isPending={markPaid.isPending}
            dispatch={(formData) => run("markPaid", formData)}
          />
        </>
      ) : null}
      <Outcome state={outcome} settlementId={settlementId} />
      {adjust.stepUpDialog}
      {approve.stepUpDialog}
      {markPaid.stepUpDialog}
      {voidDraft.stepUpDialog}
    </div>
  );
}
