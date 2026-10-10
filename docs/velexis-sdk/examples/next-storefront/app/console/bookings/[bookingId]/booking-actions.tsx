"use client";

import { useActionState, useState } from "react";
import type { Money } from "@velexis/ota-sdk";
import { addNoteAction, cancelAction, issueAction, patchAction, resyncAction } from "./actions";
import { initialFormState, type FormState } from "@/lib/action-state";
import { ErrorMessage } from "@/components/error-message";

/** A fresh idempotency key per rendered form = per click intent (a retry of the same submit reuses it). */
function useClickId() {
  const [id] = useState(() => crypto.randomUUID());
  return id;
}

function Result({ state }: { state: FormState }) {
  return (
    <>
      {state.message && <p className={state.ok ? "ok" : "muted"}>{state.message}</p>}
      <ErrorMessage error={state.error} showFields />
      {state.error?.code === "PRECONDITION_FAILED" || state.error?.code === "VERSION_CONFLICT" ? <p className="muted">Reload the page to get the latest version.</p> : null}
    </>
  );
}

export function IssueForm({ bookingId, version, unpaid, canAllowUnpaid }: { bookingId: string; version: number; unpaid: boolean; canAllowUnpaid: boolean }) {
  const [state, action, pending] = useActionState(issueAction.bind(null, bookingId, version), initialFormState);
  const clickId = useClickId();
  return (
    <form action={action} className="console-form">
      <h3>Issue tickets</h3>
      <input type="hidden" name="clickId" value={clickId} />
      <label>
        Form of payment
        <select name="formOfPayment" defaultValue="">
          <option value="">Order default</option>
          <option value="ACCOUNT">Account</option>
          <option value="CASH">Cash</option>
          <option value="CHECK">Check</option>
        </select>
      </label>
      {unpaid && canAllowUnpaid && (
        <label>
          <input type="checkbox" name="allowUnpaid" /> Issue although unpaid
        </label>
      )}
      <label>
        <input type="checkbox" name="notify" defaultChecked /> E-mail the customer
      </label>
      <input name="reason" placeholder="Reason (audit)" />
      <button type="submit" disabled={pending}>{pending ? "Issuing…" : "Issue"}</button>
      <Result state={state} />
    </form>
  );
}

export function CancelForm({ bookingId, version, paid }: { bookingId: string; version: number; paid: Money }) {
  const [state, action, pending] = useActionState(cancelAction.bind(null, bookingId, version), initialFormState);
  const [mode, setMode] = useState<"none" | "full" | "amount">("none");
  const clickId = useClickId();
  return (
    <form action={action} className="console-form danger" onSubmit={(e) => !confirm("Cancel this order at Amadeus?") && e.preventDefault()}>
      <h3>Cancel order</h3>
      <input type="hidden" name="clickId" value={clickId} />
      <select name="reasonCode" defaultValue="customer_request">
        {["customer_request", "duplicate", "fraud", "schedule_change", "no_payment", "ticketing_deadline", "airline_request", "other"].map((r) => (
          <option key={r} value={r}>{r.replace(/_/g, " ")}</option>
        ))}
      </select>
      <input name="reason" placeholder="Reason (required)" required />
      <fieldset>
        <legend>Refund (paid {paid.amount} {paid.currency})</legend>
        {(["none", "full", "amount"] as const).map((m) => (
          <label key={m}>
            <input type="radio" name="refund" value={m} checked={mode === m} onChange={() => setMode(m)} /> {m}
          </label>
        ))}
        {mode === "amount" && (
          <>
            <input name="amount" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" required />
            <input type="hidden" name="currency" value={paid.currency} />
          </>
        )}
      </fieldset>
      <label>
        <input type="checkbox" name="notify" defaultChecked /> E-mail the customer
      </label>
      <button type="submit" disabled={pending}>{pending ? "Cancelling…" : "Cancel order"}</button>
      <Result state={state} />
    </form>
  );
}

export function PatchForm({ bookingId, version }: { bookingId: string; version: number }) {
  const [state, action, pending] = useActionState(patchAction.bind(null, bookingId, version), initialFormState);
  return (
    <form action={action} className="console-form">
      <h3>Modify order</h3>
      <label>
        Ticketing agreement
        <select name="ticketingOption" defaultValue="">
          <option value="">unchanged</option>
          <option value="CONFIRM">CONFIRM</option>
          <option value="DELAY_TO_QUEUE">DELAY_TO_QUEUE</option>
          <option value="DELAY_TO_CANCEL">DELAY_TO_CANCEL</option>
        </select>
      </label>
      <input name="delay" placeholder="Delay, e.g. 2D or 6H" pattern="[0-9]+[DH]" />
      <label>
        Add remark
        <select name="remarkType" defaultValue="GENERAL_MISCELLANEOUS">
          {["GENERAL_MISCELLANEOUS", "CONFIDENTIAL", "INVOICE", "QUALITY_CONTROL", "BACKOFFICE", "FULFILLMENT", "ITINERARY", "TICKETING_MISCELLANEOUS", "TOUR_CODE"].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input name="remark" maxLength={110} placeholder="Remark text" />
      </label>
      <input name="reason" placeholder="Reason (audit)" />
      <button type="submit" disabled={pending}>{pending ? "Updating at Amadeus…" : "Apply"}</button>
      <Result state={state} />
    </form>
  );
}

export function NoteForm({ bookingId }: { bookingId: string }) {
  const [state, action, pending] = useActionState(addNoteAction.bind(null, bookingId), initialFormState);
  return (
    <form action={action} className="console-form">
      <textarea name="text" required maxLength={2000} placeholder="Internal note" />
      <label>
        <input type="checkbox" name="visible" /> Visible to the customer
      </label>
      <button type="submit" disabled={pending}>Add note</button>
      <Result state={state} />
    </form>
  );
}

export function ResyncButton({ bookingId }: { bookingId: string }) {
  const [state, action, pending] = useActionState(resyncAction.bind(null, bookingId), initialFormState);
  return (
    <form action={action} className="inline">
      <button type="submit" disabled={pending}>{pending ? "Syncing…" : "Sync with Amadeus"}</button>
      <Result state={state} />
    </form>
  );
}
