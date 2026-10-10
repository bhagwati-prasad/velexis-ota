"use client";

import { useActionState } from "react";
import { lookupBookingAction } from "./actions";
import { initialFormState } from "@/lib/action-state";
import { ErrorMessage } from "@/components/error-message";

export function LookupForm() {
  const [state, action, pending] = useActionState(lookupBookingAction, initialFormState);
  return (
    <form action={action} className="lookup-form">
      <label>
        Booking reference
        <input name="reference" required autoCapitalize="characters" pattern="[A-Za-z0-9-]{5,20}" />
      </label>
      <label>
        Last name
        <input name="lastName" required autoComplete="family-name" />
      </label>
      <button type="submit" disabled={pending}>{pending ? "Looking up…" : "Find booking"}</button>
      {state.message && <p className="error" role="alert">{state.message}</p>}
      <ErrorMessage error={state.error} />
    </form>
  );
}
