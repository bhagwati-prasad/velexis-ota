"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { Checkout, ContactInput } from "@velexis/ota-sdk";
import type { VelexisErrorData } from "@velexis/ota-sdk/react";
import { saveContactsAction } from "./actions";
import { fieldError } from "@/lib/action-state";
import { ErrorMessage } from "@/components/error-message";

/** Contact step: primary contact (+ invoice contact when the airline requires an invoice address). */
export function ContactsForm({ checkout, onSaved }: { checkout: Checkout; onSaved: () => Promise<void> }) {
  const [error, setError] = useState<VelexisErrorData>();
  const [pending, start] = useTransition();
  const req = checkout.requirements.contact;
  const primary = checkout.contacts.find((c) => c.isPrimary);
  const invoice = checkout.contacts.find((c) => c.purpose === "INVOICE");
  const [withInvoice, setWithInvoice] = useState(req.invoiceAddressRequired || !!invoice);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    const contacts: ContactInput[] = [
      {
        purpose: "STANDARD",
        isPrimary: true,
        addresseeName: { firstName: s("firstName").toUpperCase(), lastName: s("lastName").toUpperCase() },
        emailAddress: s("email"),
        phones: s("phone") ? [{ deviceType: "MOBILE", countryCallingCode: s("callingCode").replace(/^\+/, ""), number: s("phone").replace(/\D/g, "") }] : [],
        language: document.documentElement.lang || undefined,
      },
    ];
    if (withInvoice) {
      contacts.push({
        purpose: "INVOICE",
        companyName: s("company") || undefined,
        emailAddress: s("invoiceEmail") || s("email"),
        address: { lines: [s("street")], postalCode: s("postalCode"), cityName: s("city"), countryCode: s("country").toUpperCase() },
      });
    }
    start(async () => {
      const r = await saveContactsAction(checkout.id, checkout.version, contacts);
      if (r.ok) {
        setError(undefined);
        await onSaved();
      } else setError(r.error);
    });
  }

  const err = (p: string) => fieldError(error, p);
  const phone = primary?.phones?.[0];
  return (
    <form onSubmit={onSubmit} className="step">
      <h2>Contact details</h2>
      <label>
        First name
        <input name="firstName" defaultValue={primary?.addresseeName?.firstName ?? ""} required />
      </label>
      <label>
        Last name
        <input name="lastName" defaultValue={primary?.addresseeName?.lastName ?? ""} required />
      </label>
      <label>
        E-mail
        <input type="email" name="email" defaultValue={primary?.emailAddress ?? ""} required={req.emailRequired} />
        {err("/contacts/0/emailAddress") && <span className="error">{err("/contacts/0/emailAddress")}</span>}
      </label>
      <label>
        Mobile phone
        <input name="callingCode" defaultValue={phone?.countryCallingCode ?? ""} placeholder="+44" size={5} required={req.phoneCountryCodeRequired} />
        <input type="tel" name="phone" defaultValue={phone?.number ?? ""} required={req.mobilePhoneRequired || req.phoneRequired} />
        {err("/contacts/0/phones") && <span className="error">{err("/contacts/0/phones")}</span>}
      </label>
      <label>
        <input type="checkbox" checked={withInvoice} disabled={req.invoiceAddressRequired} onChange={(e) => setWithInvoice(e.target.checked)} /> I need an invoice
        {req.invoiceAddressRequired && " (required by the airline)"}
      </label>
      {withInvoice && (
        <fieldset>
          <legend>Invoice</legend>
          <input name="company" placeholder="Company (optional)" defaultValue={invoice?.companyName ?? ""} />
          <input name="invoiceEmail" type="email" placeholder="Invoice e-mail" defaultValue={invoice?.emailAddress ?? ""} />
          <input name="street" placeholder="Street" defaultValue={invoice?.address?.lines?.[0] ?? ""} required />
          <input name="postalCode" placeholder="Postal code" defaultValue={invoice?.address?.postalCode ?? ""} required={req.postalCodeRequired} />
          <input name="city" placeholder="City" defaultValue={invoice?.address?.cityName ?? ""} required />
          <input name="country" placeholder="Country (GB)" maxLength={2} defaultValue={invoice?.address?.countryCode ?? ""} required />
        </fieldset>
      )}
      <ErrorMessage error={error} showFields />
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save contact"}</button>
      {checkout.progress.contactsComplete && !error && <span className="ok">✓</span>}
    </form>
  );
}
