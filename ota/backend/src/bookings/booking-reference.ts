// Booking references (OBE-042; OADR-0003 point 3, tenant.sql `bookings.reference` with CHECK `^[A-Z0-9]{6,10}$`): the
// Velexis reference a traveller reads in e-mails and types with their last name in bookings.lookup, and the key of the
// general remark `VELEXIS <reference>` that every Flight Create Orders carries, so the reconciliation of a timed-out
// order (OBE-043) accepts only the PNR with that remark.
//
// A reference is `VX` and 6 characters of a 32-character alphabet without the look-alikes I, O, 0 and 1 (about 10⁹
// values), drawn from the CSPRNG at the claim. `bookings.reference` is UNIQUE: the claim draws again on the rare
// collision. The reference is not a secret (bookings.lookup also asks for the last name and is rate-limited).
import { randomInt } from "node:crypto";

/** The characters of the random part: A–Z without I and O, 2–9. */
export const BOOKING_REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The fixed start of every reference. */
export const BOOKING_REFERENCE_PREFIX = "VX";

/** Characters after the prefix. */
export const BOOKING_REFERENCE_RANDOM_LENGTH = 6;

/** A reference this module makes. */
export const BOOKING_REFERENCE_PATTERN = /^VX[A-HJ-NP-Z2-9]{6}$/;

/** The text of the general remark that makes an order findable (OADR-0003 point 3). */
export const VELEXIS_REMARK_PREFIX = "VELEXIS";

/** A new booking reference (`VX7K2M9Q`); `random(n)` is a uniform integer in `[0, n)`, the CSPRNG by default. */
export function newBookingReference(random: (max: number) => number = randomInt): string {
  let reference = BOOKING_REFERENCE_PREFIX;
  for (let index = 0; index < BOOKING_REFERENCE_RANDOM_LENGTH; index += 1) {
    reference += BOOKING_REFERENCE_ALPHABET[random(BOOKING_REFERENCE_ALPHABET.length)] ?? "";
  }
  return reference;
}

/** Whether `value` is a reference of this module's form. */
export function isBookingReference(value: unknown): value is string {
  return typeof value === "string" && BOOKING_REFERENCE_PATTERN.test(value);
}

/** The general remark of an order: `VELEXIS <reference>`. */
export function velexisRemarkText(reference: string): string {
  if (!isBookingReference(reference)) {
    throw new TypeError("velexisRemarkText: not a booking reference");
  }
  return `${VELEXIS_REMARK_PREFIX} ${reference}`;
}
