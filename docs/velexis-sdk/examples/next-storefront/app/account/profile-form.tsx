"use client";

import { useActionState } from "react";
import type { Schemas } from "@velexis/ota-sdk";
import { updateProfileAction } from "./actions";
import { fieldError, initialFormState } from "@/lib/action-state";
import { ErrorMessage } from "@/components/error-message";

export function ProfileForm({ customer }: { customer: Schemas["Customer"] }) {
  // Bind the version the form was rendered with (optimistic concurrency → 412 when stale).
  const [state, action, pending] = useActionState(updateProfileAction.bind(null, customer.version), initialFormState);
  return (
    <form action={action} className="profile-form">
      <p>E-mail: {customer.email}</p>
      <label>
        First name
        <input name="firstName" defaultValue={customer.firstName} required />
        {fieldError(state.error, "/firstName") && <span className="error">{fieldError(state.error, "/firstName")}</span>}
      </label>
      <label>
        Last name
        <input name="lastName" defaultValue={customer.lastName} required />
      </label>
      <label>
        Date of birth
        <input type="date" name="dateOfBirth" defaultValue={customer.dateOfBirth ?? ""} />
      </label>
      <label>
        Mobile
        <input name="callingCode" defaultValue={customer.phone?.countryCallingCode ?? ""} size={5} placeholder="+44" />
        <input type="tel" name="phone" defaultValue={customer.phone?.number ?? ""} />
      </label>
      <label>
        <input type="checkbox" name="marketing" defaultChecked={customer.marketingConsent.granted} /> Send me offers by e-mail
      </label>
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      {state.message && <p className={state.ok ? "ok" : "error"}>{state.message}</p>}
      <ErrorMessage error={state.error} showFields />
    </form>
  );
}
