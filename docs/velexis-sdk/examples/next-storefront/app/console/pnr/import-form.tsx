"use client";

import { useActionState, useState } from "react";
import { importPnrAction } from "./actions";
import { initialFormState } from "@/lib/action-state";
import { ErrorMessage } from "@/components/error-message";

export function ImportForm({ reference, flightOrderId }: { reference: string; flightOrderId: string }) {
  const [state, action, pending] = useActionState(importPnrAction.bind(null, reference, flightOrderId), initialFormState);
  const [pricing, setPricing] = useState<"markup_rules" | "net" | "override">("markup_rules");
  return (
    <form action={action} className="console-form">
      <h3>Import as booking</h3>
      <input name="customerId" placeholder="Customer id (cus_…, optional)" pattern="cus_[A-Za-z0-9]+" />
      <input name="contactEmail" type="email" placeholder="Contact e-mail (if the PNR has none)" />
      <label>
        Selling price
        <select name="pricing" value={pricing} onChange={(e) => setPricing(e.target.value as typeof pricing)}>
          <option value="markup_rules">Markup rules</option>
          <option value="net">Net</option>
          <option value="override">Override</option>
        </select>
      </label>
      {pricing === "override" && (
        <>
          <input name="sellingAmount" inputMode="decimal" placeholder="Selling total" required />
          <input name="currency" placeholder="EUR" maxLength={3} required />
        </>
      )}
      <input name="tags" placeholder="Tags (comma-separated)" />
      <input name="note" placeholder="Internal note" />
      <input name="reason" placeholder="Reason (audit)" />
      <label>
        <input type="checkbox" name="sendConfirmation" /> Send confirmation to the customer
      </label>
      <button type="submit" disabled={pending}>{pending ? "Importing…" : "Import"}</button>
      <ErrorMessage error={state.error} showFields />
    </form>
  );
}
