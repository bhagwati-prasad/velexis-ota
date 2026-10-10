"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Booking } from "@velexis/ota-sdk";
import type { VelexisErrorData } from "@velexis/ota-sdk/react";
import { updateContactsAction } from "./actions";
import { ErrorMessage } from "@/components/error-message";

/** Update the primary contact's e-mail / phone at the airline (bookings.update with ifMatch = booking.version). */
export function BookingContactsForm({ booking }: { booking: Booking }) {
  const router = useRouter();
  const [error, setError] = useState<VelexisErrorData>();
  const [ok, setOk] = useState(false);
  const [pending, start] = useTransition();
  const primary = booking.contacts.find((c) => c.isPrimary) ?? booking.contacts[0];
  const phone = primary?.phones?.[0];

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const others = booking.contacts.filter((c) => c !== primary).map(({ id: _id, ...rest }) => ({ ...rest, addresseeName: rest.addresseeName ?? undefined, companyName: rest.companyName ?? undefined, emailAddress: rest.emailAddress ?? undefined, address: rest.address ?? undefined, language: rest.language ?? undefined }));
    start(async () => {
      const r = await updateContactsAction(booking.id, booking.version, [
        {
          purpose: primary?.purpose ?? "STANDARD",
          isPrimary: true,
          addresseeName: primary?.addresseeName ?? undefined,
          emailAddress: String(f.get("email")),
          phones: [{ deviceType: "MOBILE", countryCallingCode: String(f.get("callingCode")).replace(/^\+/, ""), number: String(f.get("phone")).replace(/\D/g, "") }],
        },
        ...others,
      ]);
      if (r.ok) {
        setError(undefined);
        setOk(true);
        router.refresh();
      } else {
        setOk(false);
        setError(r.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="step">
      <h2>Contact details</h2>
      <label>
        E-mail
        <input type="email" name="email" defaultValue={primary?.emailAddress ?? ""} required />
      </label>
      <label>
        Mobile
        <input name="callingCode" defaultValue={phone?.countryCallingCode ?? ""} size={5} />
        <input type="tel" name="phone" defaultValue={phone?.number ?? ""} required />
      </label>
      <button type="submit" disabled={pending}>{pending ? "Updating with the airline…" : "Update contact"}</button>
      {ok && <span className="ok">Updated ✓</span>}
      {error?.code === "VERSION_CONFLICT" || error?.code === "PRECONDITION_FAILED" ? (
        <p className="error">
          The booking changed meanwhile. <button type="button" onClick={() => router.refresh()}>Reload</button>
        </p>
      ) : (
        <ErrorMessage error={error} showFields />
      )}
    </form>
  );
}
