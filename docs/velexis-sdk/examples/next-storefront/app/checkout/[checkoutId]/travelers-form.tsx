"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { Checkout, CheckoutTravelerRequirement, Schemas, TravelerInput, Traveler } from "@velexis/ota-sdk";
import type { VelexisErrorData } from "@velexis/ota-sdk/react";
import { saveTravelersAction } from "./actions";
import { fieldError } from "@/lib/action-state";
import { ErrorMessage } from "@/components/error-message";

type Gender = NonNullable<TravelerInput["gender"]>;
type DocumentType = NonNullable<NonNullable<TravelerInput["documents"]>[number]["documentType"]>;

const TYPE_LABEL: Record<string, string> = { ADULT: "Adult", CHILD: "Child", HELD_INFANT: "Infant (on lap)", SEATED_INFANT: "Infant (own seat)", SENIOR: "Senior", YOUNG: "Young adult", STUDENT: "Student" };

/** Travellers step: one fieldset per Amadeus traveller, driven by `checkout.requirements.travelers`. */
export function TravelersForm({ checkout, savedTravelers, signedIn, onSaved }: { checkout: Checkout; savedTravelers: Schemas["SavedTraveler"][]; signedIn: boolean; onSaved: () => Promise<void> }) {
  const [error, setError] = useState<VelexisErrorData>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const travelers = checkout.requirements.travelers.map((req) => readTraveler(form, req));
    start(async () => {
      const r = await saveTravelersAction(checkout.id, checkout.version, travelers);
      if (r.ok) {
        setError(undefined);
        setSaved(true);
        await onSaved();
      } else {
        setError(r.error);
        setSaved(false);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="step">
      <h2>Travellers</h2>
      <p className="muted">Enter names exactly as in the passport.</p>
      {checkout.requirements.travelers.map((req, i) => (
        <TravelerFieldset
          key={req.travelerId}
          index={i}
          requirement={req}
          traveler={checkout.travelers.find((t) => t.travelerId === req.travelerId)}
          savedTravelers={savedTravelers}
          signedIn={signedIn}
          error={error}
        />
      ))}
      <ErrorMessage error={error} />
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save travellers"}</button>
      {saved && checkout.progress.travelersComplete && <span className="ok">Saved ✓</span>}
    </form>
  );
}

function TravelerFieldset({ index, requirement: req, traveler: t, savedTravelers, signedIn, error }: {
  index: number;
  requirement: CheckoutTravelerRequirement;
  traveler: Traveler | undefined;
  savedTravelers: Schemas["SavedTraveler"][];
  signedIn: boolean;
  error: VelexisErrorData | undefined;
}) {
  const p = `/travelers/${index}`;
  const needs = (f: CheckoutTravelerRequirement["requiredFields"][number]) => req.requiredFields.includes(f);
  const doc = t?.documents?.[0];
  const prefix = `t${req.travelerId}`;
  const err = (path: string) => fieldError(error, `${p}${path}`);

  return (
    <fieldset>
      <legend>
        Traveller {req.travelerId} · {TYPE_LABEL[req.travelerType] ?? req.travelerType}
      </legend>
      {savedTravelers.length > 0 && (
        <label>
          Use a saved traveller
          <select name={`${prefix}.savedTravelerId`} defaultValue={t?.savedTravelerId ?? ""}>
            <option value="">— enter details —</option>
            {savedTravelers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name.firstName} {s.name.lastName} {s.label ? `(${s.label})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        First name(s)
        <input name={`${prefix}.firstName`} defaultValue={t?.name?.firstName ?? ""} autoComplete="given-name" />
        {err("/name/firstName") && <span className="error">{err("/name/firstName")}</span>}
      </label>
      <label>
        Last name
        <input name={`${prefix}.lastName`} defaultValue={t?.name?.lastName ?? ""} autoComplete="family-name" />
        {err("/name/lastName") && <span className="error">{err("/name/lastName")}</span>}
      </label>
      <label>
        Date of birth
        <input type="date" name={`${prefix}.dateOfBirth`} defaultValue={t?.dateOfBirth ?? ""} min={req.dateOfBirthMin ?? undefined} max={req.dateOfBirthMax ?? undefined} required={needs("dateOfBirth")} />
        {err("/dateOfBirth") && <span className="error">{err("/dateOfBirth")}</span>}
      </label>
      <label>
        Gender
        <select name={`${prefix}.gender`} defaultValue={t?.gender ?? ""} required={needs("gender")}>
          <option value="">—</option>
          <option value="FEMALE">Female</option>
          <option value="MALE">Male</option>
          <option value="UNSPECIFIED">Unspecified</option>
        </select>
      </label>
      {needs("documents") && (
        <div className="document">
          <label>
            Document
            <select name={`${prefix}.documentType`} defaultValue={doc?.documentType ?? req.documentTypes[0] ?? "PASSPORT"}>
              {req.documentTypes.map((d) => (
                <option key={d} value={d}>{d.replace("_", " ").toLowerCase()}</option>
              ))}
            </select>
          </label>
          <label>
            Number
            {/* Stored numbers come back masked; leave blank to keep the stored document. */}
            <input name={`${prefix}.documentNumber`} placeholder={doc?.number ? `${doc.number} (stored)` : ""} />
            {err("/documents/0/number") && <span className="error">{err("/documents/0/number")}</span>}
          </label>
          <label>
            Expiry date
            <input type="date" name={`${prefix}.expiryDate`} defaultValue={doc?.expiryDate ?? ""} />
            {err("/documents/0/expiryDate") && <span className="error">{err("/documents/0/expiryDate")}</span>}
          </label>
          <label>
            Issuing country
            <input name={`${prefix}.issuanceCountry`} defaultValue={doc?.issuanceCountry ?? ""} maxLength={2} placeholder="GB" />
          </label>
          <label>
            Nationality
            <input name={`${prefix}.nationality`} defaultValue={doc?.nationality ?? ""} maxLength={2} placeholder="GB" />
          </label>
          {needs("documentIssuanceCity") && (
            <label>
              Place of issue
              <input name={`${prefix}.issuanceLocation`} defaultValue={doc?.issuanceLocation ?? ""} />
            </label>
          )}
        </div>
      )}
      {signedIn && (
        <label>
          <input type="checkbox" name={`${prefix}.saveToAccount`} defaultChecked={t?.saveToAccount ?? false} /> Save to my account for next time
        </label>
      )}
    </fieldset>
  );
}

/** FormData → Amadeus-shaped TravelerInput. Empty fields are omitted (the API keeps stored values for omitted fields). */
function readTraveler(form: FormData, req: CheckoutTravelerRequirement): TravelerInput {
  const v = (k: string) => {
    const x = form.get(`t${req.travelerId}.${k}`);
    return typeof x === "string" && x.trim() !== "" ? x.trim() : undefined;
  };
  const savedTravelerId = v("savedTravelerId");
  const input: TravelerInput = { travelerId: req.travelerId };
  if (savedTravelerId) input.savedTravelerId = savedTravelerId;
  const firstName = v("firstName")?.toUpperCase();
  const lastName = v("lastName")?.toUpperCase();
  if (firstName || lastName) input.name = { firstName, lastName };
  if (v("dateOfBirth")) input.dateOfBirth = v("dateOfBirth");
  if (v("gender")) input.gender = v("gender") as Gender;
  const number = v("documentNumber");
  if (number) {
    input.documents = [
      {
        documentType: (v("documentType") ?? "PASSPORT") as DocumentType,
        number,
        expiryDate: v("expiryDate"),
        issuanceCountry: v("issuanceCountry")?.toUpperCase(),
        nationality: v("nationality")?.toUpperCase(),
        issuanceLocation: v("issuanceLocation"),
        holder: true,
      },
    ];
  }
  if (form.get(`t${req.travelerId}.saveToAccount`) === "on") input.saveToAccount = true;
  return input;
}
