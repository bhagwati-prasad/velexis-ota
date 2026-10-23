// The forms of identification of an Amadeus order (passport, identity card or driving licence numbers that name a
// traveller to the airline) as Velexis keeps and shows them: through the shared redactor, then each `number` cut to its
// last 4 characters, as FIX-W26-SECURITY's redactor cuts them (cutting a cut number again keeps the same 4). OBE-062
// wrote this projection for the console (console/console-bookings.mapper.ts re-exports it); FIX-W27-SYNC moved it here
// so the record step (order-recorder.ts) and every synchronisation (booking-sync.service.ts) write
// `bookings.form_of_identifications` with the same one (lead decision (3) of 2026-10-23).
import { redactPayload } from "@velexis/logger";

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** Forms of identification with their numbers cut to the last 4 characters (customer scope does the same). */
export function maskedIdentifications(value: unknown): JsonObject[] {
  return records(redactPayload(value)).map((entry) => {
    const number = entry["number"];
    return typeof number === "string" ? { ...entry, number: number.slice(-4) } : entry;
  });
}
