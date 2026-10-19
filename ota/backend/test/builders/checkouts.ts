// Builders of checkout requests (OBE-036): travellers, identity documents, contacts and special requests as
// checkout.setTravelers, checkout.setContacts and checkout.setRemarks take them, and the dates and numbers tests
// need. The people are synthetic (no real person); document and resident card numbers are random, generated at run
// time, so a test can search the whole database for "its" number. Dates that must lie ahead are computed from today
// (`dateFromToday`), never written as fixed calendar dates that would pass. Builders only build values; sending them
// is the test's job (conventions §10).
//
//   const traveler = buildTravelerInput({ documents: [buildPassport({ expiryDate: dateFromToday(400) })] });
//   await request(api.server).put(`/v1/checkouts/${id}/travelers`).set(headers).send({ travelers: [traveler] });
import { randomInt } from "node:crypto";
import type { components } from "@velexis/api-types";
import { defineBuilder, type Builder } from "@velexis/testing";

type Schemas = components["schemas"];
export type TravelerInput = Schemas["TravelerInput"];
export type TravelerDocumentInput = Schemas["TravelerDocumentInput"];
export type ContactInput = Schemas["ContactInput"];
export type RemarkInput = Schemas["RemarkInput"];

const DAY_MS = 86_400_000;

/** The UTC date `days` days from now (`YYYY-MM-DD`). */
export function dateFromToday(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** A fresh passport number of the document's number pattern: `X` and 8 random digits. */
export function newDocumentNumber(): string {
  return `X${String(randomInt(10_000_000, 100_000_000))}`;
}

/** A fresh Spanish resident card number of Amadeus's pattern: 8 random digits and a letter. */
export function newResidentCardNumber(): string {
  return `${String(randomInt(10_000_000, 100_000_000))}Z`;
}

/** Latin letters for a sequence number (1 → A, 26 → Z, 27 → AA): names may hold no digits. */
export function lettersOf(sequence: number): string {
  let rest = sequence;
  let letters = "";
  while (rest > 0) {
    const index = (rest - 1) % 26;
    letters = String.fromCharCode(65 + index) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

/** A passport valid for five more years. */
export const buildPassport: Builder<TravelerDocumentInput> = defineBuilder<TravelerDocumentInput>(() => ({
  documentType: "PASSPORT",
  number: newDocumentNumber(),
  issuanceDate: dateFromToday(-365),
  expiryDate: dateFromToday(5 * 365),
  issuanceCountry: "SE",
  issuanceLocation: "STOCKHOLM",
  nationality: "SE",
  birthPlace: "UPPSALA",
  holder: true,
}));

/** An adult with a name, a date of birth, a gender and a passport: everything the stub's requirements ask for. */
export const buildTravelerInput: Builder<TravelerInput> = defineBuilder<TravelerInput>((n) => ({
  travelerId: "1",
  name: { firstName: `TESTA${lettersOf(n)}`, lastName: "SAMPLE" },
  dateOfBirth: "1988-04-12",
  gender: "FEMALE",
  contact: {
    emailAddress: `traveller-${n}@example.com`,
    phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
  },
  documents: [buildPassport()],
  loyaltyPrograms: [{ programOwner: "IB", id: "2084471234" }],
}));

/** The primary contact, with the e-mail and the mobile phone the stub's requirements ask for. */
export const buildContactInput: Builder<ContactInput> = defineBuilder<ContactInput>((n) => ({
  purpose: "STANDARD",
  isPrimary: true,
  addresseeName: { firstName: `TESTA${lettersOf(n)}`, lastName: "SAMPLE" },
  emailAddress: `contact-${n}@example.com`,
  phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
  language: "en",
}));

/** A special request for traveller 1. */
export const buildRemarkInput: Builder<RemarkInput> = defineBuilder<RemarkInput>((n) => ({
  text: `Window seat if possible ${lettersOf(n)}`,
  travelerIds: ["1"],
}));
