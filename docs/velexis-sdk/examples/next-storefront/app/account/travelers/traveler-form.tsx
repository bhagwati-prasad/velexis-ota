"use client";

import { useActionState } from "react";
import { createSavedTravelerAction } from "../actions";
import { fieldError, initialFormState } from "@/lib/action-state";
import { ErrorMessage } from "@/components/error-message";

export function TravelerForm() {
  const [state, action, pending] = useActionState(createSavedTravelerAction, initialFormState);
  const fe = (p: string) => fieldError(state.error, p);
  return (
    <form action={action} className="traveler-form">
      <input name="label" placeholder="Label (e.g. Leo)" />
      <input name="firstName" placeholder="First name(s) as in passport" required />
      <input name="lastName" placeholder="Last name" required />
      <label>
        Date of birth <input type="date" name="dateOfBirth" required />
      </label>
      {fe("/dateOfBirth") && <span className="error">{fe("/dateOfBirth")}</span>}
      <select name="gender" defaultValue="">
        <option value="">Gender</option>
        <option value="FEMALE">Female</option>
        <option value="MALE">Male</option>
        <option value="UNSPECIFIED">Unspecified</option>
      </select>
      <label>
        <input type="checkbox" name="isAccountHolder" /> This is me
      </label>
      <fieldset>
        <legend>Passport (optional)</legend>
        <input name="documentNumber" placeholder="Number" />
        <input type="date" name="expiryDate" aria-label="Expiry date" />
        <input name="issuanceCountry" placeholder="Issuing country (GB)" maxLength={2} />
        <input name="nationality" placeholder="Nationality (GB)" maxLength={2} />
        {fe("/documents") && <span className="error">{fe("/documents")}</span>}
      </fieldset>
      <fieldset>
        <legend>Frequent flyer (optional)</legend>
        <input name="loyaltyAirline" placeholder="Airline (BA)" maxLength={2} />
        <input name="loyaltyNumber" placeholder="Number" />
      </fieldset>
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save traveller"}</button>
      {state.message && <p className={state.ok ? "ok" : "error"}>{state.message}</p>}
      <ErrorMessage error={state.error} />
    </form>
  );
}
