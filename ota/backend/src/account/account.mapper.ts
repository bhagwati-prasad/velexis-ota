// The answers of the customer account operations (OBE-035; the document's `Customer`, `AccountDeletion`): account.get
// and account.update answer the identity module's `Customer` (customers.mapper.ts `toCustomer`: only the contract's
// columns, never a password hash, an identity or a token) with `ETag: "<version>"`; account.delete answers
// `AccountDeletion`. Times are ISO 8601 instants in UTC.
import type { components } from "@velexis/api-types";
import { toCustomer, type Customer } from "../identity/customers.mapper";
import type { CustomerRecord } from "../identity/customers.repository";

type Schemas = components["schemas"];
export type { Customer };
export type AccountDeletion = Schemas["AccountDeletion"];
export type RetainedRecord = AccountDeletion["retainedRecords"][number];

/** `Cache-Control` of account.get and account.update (the document: personal data, never cached). */
export const ACCOUNT_CACHE_CONTROL = "private, no-store";

/** `Cache-Control` of account.delete: it ends every session. */
export const DELETION_CACHE_CONTROL = "no-store";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The latest erasure of a deleted account's personal data (the document: 30 days; the erasure job is OBE-087). */
export const ERASURE_DUE_AFTER_MS = 30 * DAY_MS;

/** The ETag of a customer: its quoted `version` (the `If-Match` of account.update). */
export function accountEtagOf(version: number): string {
  return `"${version}"`;
}

/** The contract's `Customer` of a row. */
export function toAccount(row: CustomerRecord): Customer {
  return toCustomer(row);
}

/**
 * The records a deletion keeps (`retainedRecords`): the bookings and their payments, when the customer has bookings.
 * The legal periods depend on the OTA's jurisdiction, so the reasons name the rules, not a number of years.
 */
export const RETAINED_BOOKING_RECORDS: readonly RetainedRecord[] = Object.freeze([
  Object.freeze({
    category: "bookings",
    reason:
      "Booking, ticket and passenger records are kept for as long as airline settlement and tax law require, " +
      "then deleted.",
  } as const),
  Object.freeze({
    category: "payments",
    reason: "Payment and refund records are kept for as long as accounting obligations require.",
  } as const),
]);

/** A deletion as account.delete reports it. */
export interface AccountDeletionOutcome {
  /** When the deletion was made (the request's time). */
  readonly requestedAt: Date;
  /** Whether the customer had bookings, which are kept (detached and minimised by the erasure job). */
  readonly hasBookings: boolean;
}

/**
 * account.delete's answer: `scheduled` (sign-in is disabled now, the erasure runs within 30 days), no data export
 * (`exportData` is refused while data exports are deferred, account.service.ts), and the records that are kept.
 */
export function toAccountDeletion(outcome: AccountDeletionOutcome): AccountDeletion {
  return {
    status: "scheduled",
    requestedAt: outcome.requestedAt.toISOString(),
    erasureDueBy: new Date(outcome.requestedAt.getTime() + ERASURE_DUE_AFTER_MS).toISOString(),
    dataExport: null,
    retainedRecords: outcome.hasBookings ? RETAINED_BOOKING_RECORDS.map((record) => ({ ...record })) : [],
  };
}
