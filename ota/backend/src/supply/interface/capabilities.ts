// What an adapter can do, declared in code (multi-supplier plan §4.2, its capability table; OADR-0019 item 9,
// proposed; OBE-110). The flow skips a step whose capability is missing and never tests a supplier's name.
//
//   Row            Values                                                    When missing
//   searchLimits   journeys, travellers, currencies                          the source is skipped for that query
//   extras         bags, seats, after booking                                the step is skipped for that booking
//   findOrder      by queue and remark, by our reference, none               a lost answer goes to staff
//   ticketing      now or later; paid by the agency or from a supplier       required
//                  balance; ticket numbers may be absent
//   servicing      cancel, void, refund, change: by API, by request, none    today's "request only" path
//
// Every row is required, so a declaration states each one: a missing capability is a value (`false`, `none`, or a
// limit the query exceeds), never an absent member. Types and constants only: capabilities.test.ts pins the rows and
// values against the plan's table.

/** The rows of the declaration, in the order of the plan's table. */
export const CAPABILITY_ROWS = Object.freeze([
  "searchLimits",
  "extras",
  "findOrder",
  "ticketing",
  "servicing",
] as const);
export type CapabilityRow = (typeof CAPABILITY_ROWS)[number];

/** What the flow does when a row's capability is missing (the plan's column "When missing"). */
export const WHEN_CAPABILITY_MISSING = Object.freeze({
  /** The source is skipped for that query (Search answers `skipped`). */
  searchLimits: "skip_source",
  /** The step is skipped for that booking. */
  extras: "skip_step",
  /** A lost answer to Create order goes to staff. */
  findOrder: "to_staff",
  /** Never missing: every adapter declares how it tickets. */
  ticketing: "required",
  /** The operation takes today's "request only" path. */
  servicing: "request_only",
} as const satisfies Readonly<Record<CapabilityRow, string>>);

/** The queries a source can serve; a query beyond one of them skips the source. */
export interface SearchLimits {
  /** The most journeys (origin-destination pairs) of one search. */
  readonly maxJourneys: number;
  /** The most travellers who take a seat in one search (held infants are not counted). */
  readonly maxTravellers: number;
  /** The currencies the source quotes (ISO 4217 codes), or `any`. */
  readonly currencies: "any" | readonly string[];
}

/** The extras a source sells: bags, seats, and extras added after booking. */
export const EXTRAS = Object.freeze(["bags", "seats", "afterBooking"] as const);
export type Extra = (typeof EXTRAS)[number];
export type ExtrasCapability = { readonly [E in Extra]: boolean };

/** How a source finds an order after a lost answer: by queue and remark, by our reference, or not at all. */
export const FIND_ORDER_MODES = Object.freeze(["queue_and_remark", "our_reference", "none"] as const);
export type FindOrderMode = (typeof FIND_ORDER_MODES)[number];

/** When the ticket is issued: in the answer to the ticketing request, or later. */
export const TICKET_ISSUANCE = Object.freeze(["now", "later"] as const);
export type TicketIssuance = (typeof TICKET_ISSUANCE)[number];

/** Who pays the ticket: the agency, or the source from its supplier balance. */
export const TICKET_PAYMENT = Object.freeze(["agency", "supplier_balance"] as const);
export type TicketPayment = (typeof TICKET_PAYMENT)[number];

export interface TicketingCapability {
  readonly issuance: TicketIssuance;
  readonly payment: TicketPayment;
  /** True when an issued booking may come without ticket numbers. */
  readonly ticketNumbersMayBeAbsent: boolean;
}

/** The after-sales operations of the row "Cancel, void, refund, change". */
export const SERVICE_OPERATIONS = Object.freeze(["cancel", "void", "refund", "change"] as const);
export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];

/** How a source serves an after-sales operation: by API, by request, or not at all. */
export const SERVICE_MODES = Object.freeze(["api", "request", "none"] as const);
export type ServiceMode = (typeof SERVICE_MODES)[number];
export type ServicingCapability = { readonly [O in ServiceOperation]: ServiceMode };

/** An adapter's capability declaration: one value per row of the plan's table. */
export interface SupplierCapabilities {
  readonly searchLimits: SearchLimits;
  readonly extras: ExtrasCapability;
  readonly findOrder: FindOrderMode;
  readonly ticketing: TicketingCapability;
  readonly servicing: ServicingCapability;
}
