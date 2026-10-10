"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useStorefront, type VelexisErrorData } from "@velexis/ota-sdk/react";
import type { CancellationQuote, CancellationReason, Money } from "@velexis/ota-sdk";
import { cancelBookingAction, quoteCancellationAction } from "./actions";
import { ErrorMessage } from "@/components/error-message";

const REASONS: { value: CancellationReason; label: string }[] = [
  { value: "change_of_plans", label: "Change of plans" },
  { value: "illness", label: "Illness" },
  { value: "schedule_change", label: "Schedule change" },
  { value: "duplicate_booking", label: "Duplicate booking" },
  { value: "found_cheaper", label: "Found a cheaper fare" },
  { value: "other", label: "Other" },
];

/** Cancel with refund preview: quote (mode, refund, penalty, OTA fee, per traveller) → confirm with expectedRefund. */
export function CancelPanel({ bookingId, version }: { bookingId: string; version: number }) {
  const router = useRouter();
  const { formatMoney } = useStorefront();
  const [quote, setQuote] = useState<CancellationQuote>();
  const [reason, setReason] = useState<CancellationReason>("change_of_plans");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<VelexisErrorData>();
  const [done, setDone] = useState<string>();
  const [pending, start] = useTransition();

  const loadQuote = () =>
    start(async () => {
      const r = await quoteCancellationAction(bookingId);
      if (r.ok) {
        setQuote(r.data);
        setError(undefined);
      } else setError(r.error);
    });

  const confirm = (expectedRefund: Money) =>
    start(async () => {
      const r = await cancelBookingAction(bookingId, version, reason, expectedRefund, comment || undefined);
      if (r.ok) {
        setDone(r.data.status === "pending" ? "Your cancellation request was received; our team completes it shortly." : "Your booking is cancelled.");
        router.refresh();
        return;
      }
      if (r.error.code === "REFUND_AMOUNT_CHANGED") {
        // The refund moved since the preview: refresh the quote and ask again.
        const q = await quoteCancellationAction(bookingId);
        if (q.ok) setQuote(q.data);
      }
      setError(r.error);
    });

  if (done) return <div className="notice">{done}</div>;

  return (
    <section className="step">
      <h2>Cancel booking</h2>
      {!quote && (
        <button type="button" onClick={loadQuote} disabled={pending}>
          {pending ? "Checking refund…" : "See refund and cancel"}
        </button>
      )}
      {quote && !quote.cancellable && <p>This booking cannot be cancelled online{quote.notAllowedReason ? ` (${quote.notAllowedReason.replace(/_/g, " ")})` : ""}.</p>}
      {quote && quote.cancellable && (
        <div>
          <p>
            {quote.mode === "void" && "Your tickets can still be voided today — "}
            {quote.mode === "release" && "Not ticketed yet — "}
            {quote.mode === "request_only" && "Our team will process this cancellation — "}
            estimated refund <strong>{formatMoney(quote.estimatedRefund)}</strong> of {formatMoney(quote.amountPaid)} (airline penalty {formatMoney(quote.penalty)}, service fee{" "}
            {formatMoney(quote.otaFee)}).
          </p>
          {quote.lines.length > 1 && (
            <ul>
              {quote.lines.map((l) => (
                <li key={l.travelerId}>
                  {l.travelerName ?? l.travelerId}: refund {formatMoney(l.refund)} (penalty {formatMoney(l.penalty)})
                </li>
              ))}
            </ul>
          )}
          <p className="muted">Quote valid until {new Date(quote.expiresAt).toLocaleTimeString()}.</p>
          <label>
            Reason
            <select value={reason} onChange={(e) => setReason(e.target.value as CancellationReason)}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>
          <label>
            Comment (optional)
            <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
          </label>
          <button type="button" className="danger" disabled={pending} onClick={() => confirm(quote.estimatedRefund)}>
            {pending ? "Cancelling…" : `Cancel and refund ${formatMoney(quote.estimatedRefund)}`}
          </button>
        </div>
      )}
      {error?.code === "REFUND_AMOUNT_CHANGED" ? <p className="error">The refund amount changed — please review the new amount.</p> : <ErrorMessage error={error} />}
    </section>
  );
}
