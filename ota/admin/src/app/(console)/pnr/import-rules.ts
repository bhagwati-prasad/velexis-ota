// The shared vocabulary of the PNR lookup and import `/pnr` (OAD-009, routes.md §4, console-operations flow §3 step 4):
// the URL of a lookup, the record locator's rule, the import dialog's field names and choices, and the state the
// import's server action answers. The page (page.tsx), the dialog (import-dialog.tsx), the server actions (actions.ts)
// and the queue pages (`/queues`, whose orphan PNRs link here) import it. A module without a directive, as the booking
// page's action-rules.ts: a `"use server"` module may export async functions only, and a `"use client"` module would
// reach the server only as client references. No SDK runtime import (types only), nothing secret.
import type { Choice } from "@/app/(console)/bookings/[bookingId]/action-rules";
import type { ActionState } from "@/lib/action-state";

// ---- The lookup's URL -----------------------------------------------------------------------------------------------

/** The route of the lookup. */
export const PNR_PATH = "/pnr";
/** The search parameter of the record locator (`/pnr?recordLocator=L2P9XC`): the queue pages' links and the form. */
export const RECORD_LOCATOR_PARAM = "recordLocator";
/** The other spelling a link may use (`/pnr?reference=…`, the API's own name of the parameter); read, never written. */
export const REFERENCE_PARAM = "reference";

/** A record locator as Get Flight Order By Record Locator takes it (`ConsoleRecordLocator`: `^[A-Z0-9]{5,8}$`). */
export const RECORD_LOCATOR_PATTERN = /^[A-Z0-9]{5,8}$/;

/** A record locator as staff typed it, in the API's spelling: without spaces, in capitals (`l2p 9xc` → `L2P9XC`). */
export function normalizeRecordLocator(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** The lookup of `recordLocator` (`/pnr?recordLocator=…`): what an orphan queue item's "Import" link opens. */
export function pnrHref(recordLocator: string): string {
  return `${PNR_PATH}?${new URLSearchParams({ [RECORD_LOCATOR_PARAM]: recordLocator }).toString()}`;
}

/** The page of a booking (`/bookings/<id>`, the overview). */
export function bookingPath(bookingId: string): string {
  return `/bookings/${encodeURIComponent(bookingId)}`;
}

// ---- The import dialog's fields -------------------------------------------------------------------------------------

/** Hidden: the record locator that was looked up (`reference` of the import). */
export const REFERENCE_FIELD = "reference";
/** Hidden: the Amadeus order of the match (`flightOrderId`), so the import never picks another order of the locator. */
export const FLIGHT_ORDER_FIELD = "flightOrderId";
/** Hidden: the order's currency, the currency of an override's selling total. */
export const CURRENCY_FIELD = "currency";
/** The pricing mode (`pricing.mode`). */
export const PRICING_MODE_FIELD = "pricingMode";
/** The selling total of an override (`pricing.sellingTotal.amount`). */
export const SELLING_TOTAL_FIELD = "sellingTotal";
/** The customer the booking is attached to (`customerId`); empty: a guest booking. */
export const CUSTOMER_FIELD = "customerId";
/** The booking's contact e-mail when the order has none (`contactEmail`). */
export const CONTACT_EMAIL_FIELD = "contactEmail";
/** Send the booking confirmation to the contact (`sendConfirmation`). */
export const SEND_CONFIRMATION_FIELD = "sendConfirmation";
/** Staff tags, separated by commas (`tags`). */
export const TAGS_FIELD = "tags";
/** The internal note (`note`). */
export const NOTE_FIELD = "note";

/** `ConsolePricingInput.mode`. */
export type PricingMode = "markup_rules" | "net" | "override";

/** The pricing modes of an import (`ConsolePricingInput.mode`), the API's default first. */
export const PRICING_MODES: readonly Choice<PricingMode>[] = [
  { value: "markup_rules", label: "The OTA's markup and fee rules" },
  { value: "net", label: "The net price" },
  { value: "override", label: "A selling total of my own" },
];

/** The pricing mode the dialog starts with and the API applies without one. */
export const DEFAULT_PRICING_MODE: PricingMode = "markup_rules";

/** The most tags a booking takes (`ConsoleBookingImportRequest.tags.maxItems`). */
export const TAGS_MAX = 10;
/** The longest tag (`tags.items.maxLength`). */
export const TAG_MAX_LENGTH = 40;
/** The longest internal note (`note.maxLength`). */
export const NOTE_MAX_LENGTH = 2000;

/** The tags of the tags field: separated by commas, trimmed, without empty or repeated ones, in their order. */
export function tagsOf(text: string): string[] {
  const tags: string[] = [];
  for (const part of text.split(",")) {
    const tag = part.trim();
    if (tag !== "" && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}

// ---- The import's answer --------------------------------------------------------------------------------------------

/** A booking of this OTA as the import's answer names it: its id and its reference (`VX…`). */
export interface ImportedBooking {
  readonly id: string;
  readonly reference: string;
}

/**
 * The state of `importBooking`: the action's state and, with it, the booking the order is attached to: the new one
 * after a success, or the existing one after `409 ORDER_ALREADY_IMPORTED` (the order was imported before, by this
 * form or by someone else), which the dialog links. `warnings` are the API's warnings of a success (a confirmation
 * that could not be queued): the dialog then stays on the lookup to show them instead of opening the booking.
 */
export interface ImportState extends ActionState {
  readonly booking?: ImportedBooking;
  readonly warnings?: readonly string[];
}

/** The booking an import's state names, if any (a state from `ConfirmDialog` is typed as a plain `ActionState`). */
export function importedBookingOf(state: ActionState): ImportedBooking | undefined {
  const { booking } = state as ImportState;
  return booking !== undefined && typeof booking.id === "string" && typeof booking.reference === "string"
    ? booking
    : undefined;
}

/** The warnings of an import's state; none for any other state. */
export function importWarningsOf(state: ActionState): readonly string[] {
  const { warnings } = state as ImportState;
  return Array.isArray(warnings) ? warnings.filter((warning) => typeof warning === "string") : [];
}

// ---- The customer search --------------------------------------------------------------------------------------------

/** The shortest search (`q.minLength` of console.customers.list). */
export const CUSTOMER_QUERY_MIN_LENGTH = 2;
/** The longest search (`q.maxLength`). */
export const CUSTOMER_QUERY_MAX_LENGTH = 100;

/** A customer the import may be attached to, as the dialog lists it. */
export interface CustomerChoice {
  readonly id: string;
  readonly email: string;
  /** First and last name, or `null` when the account has none. */
  readonly name: string | null;
}

/** What `searchCustomers` answers: the active customers found, or why there are none. */
export interface CustomerSearchState {
  readonly ok: boolean;
  readonly customers?: readonly CustomerChoice[];
  readonly message?: string;
  readonly requestId?: string;
}
