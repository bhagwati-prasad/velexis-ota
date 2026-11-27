// The engine's actions and the fixed outcome set of each (multi-supplier plan §4.1, its action table; OADR-0019 item
// 8, proposed; OBE-110). Business code calls an action and reacts to one of its outcomes only: it never sees a
// supplier's name, payload or error code. Each adapter classifies its own answers into these outcomes.
//
//   Action                                   Outcomes
//   search                                   per source: ok, empty, failed, timed_out, skipped
//   price          (price, extras)           priced, sold_out, refused, unavailable
//   createOrder                              created, rejected, not_sent, unknown
//   findOrder      (after a lost answer)     found, absent, incomplete
//   checkPayable   (new)                     payable, refused, higher_amount, balance_short, unknown
//   requestTicketing                         issued, accepted, rejected, balance_refused, unknown
//   readOrder      (sync, polling)           order, not_found, unavailable
//   cancelOrRelease                          cancelled, order_not_found, refused, version_conflict, not_sent, unknown
//   serviceRequest (void, refund, change)    quoted, submitted, completed, refused
//
// `not_sent` needs proof that the request never left the process; without it an adapter answers `unknown`, and the
// booking stays pending (plan §4.1). The hooks of each action are the engine's (OBE-114), not part of this table.
// Types and constants only: outcomes.test.ts pins every name against the plan's table.

/** The search outcomes, one per called or skipped source. */
export const SEARCH_OUTCOMES = Object.freeze(["ok", "empty", "failed", "timed_out", "skipped"] as const);
export type SearchOutcome = (typeof SEARCH_OUTCOMES)[number];

/** The outcomes of Price, which pricing the extras of an offer answers too (the plan's row "Price, extras"). */
export const PRICE_OUTCOMES = Object.freeze(["priced", "sold_out", "refused", "unavailable"] as const);
export type PriceOutcome = (typeof PRICE_OUTCOMES)[number];

export const CREATE_ORDER_OUTCOMES = Object.freeze(["created", "rejected", "not_sent", "unknown"] as const);
export type CreateOrderOutcome = (typeof CREATE_ORDER_OUTCOMES)[number];

/** The outcomes of Find order, asked after a lost answer to Create order. */
export const FIND_ORDER_OUTCOMES = Object.freeze(["found", "absent", "incomplete"] as const);
export type FindOrderOutcome = (typeof FIND_ORDER_OUTCOMES)[number];

/** The outcomes of Check payable, the new action before ticketing. */
export const CHECK_PAYABLE_OUTCOMES = Object.freeze([
  "payable",
  "refused",
  "higher_amount",
  "balance_short",
  "unknown",
] as const);
export type CheckPayableOutcome = (typeof CHECK_PAYABLE_OUTCOMES)[number];

export const REQUEST_TICKETING_OUTCOMES = Object.freeze([
  "issued",
  "accepted",
  "rejected",
  "balance_refused",
  "unknown",
] as const);
export type RequestTicketingOutcome = (typeof REQUEST_TICKETING_OUTCOMES)[number];

/** The outcomes of Read order, for the booking sync and polling. */
export const READ_ORDER_OUTCOMES = Object.freeze(["order", "not_found", "unavailable"] as const);
export type ReadOrderOutcome = (typeof READ_ORDER_OUTCOMES)[number];

export const CANCEL_OR_RELEASE_OUTCOMES = Object.freeze([
  "cancelled",
  "order_not_found",
  "refused",
  "version_conflict",
  "not_sent",
  "unknown",
] as const);
export type CancelOrReleaseOutcome = (typeof CANCEL_OR_RELEASE_OUTCOMES)[number];

/** The outcomes of a service request: a void, a refund or a change. */
export const SERVICE_REQUEST_OUTCOMES = Object.freeze([
  "quoted",
  "submitted",
  "completed",
  "refused",
] as const);
export type ServiceRequestOutcome = (typeof SERVICE_REQUEST_OUTCOMES)[number];

/** The engine's actions, in the order of the plan's table. */
export const SUPPLY_ACTIONS = Object.freeze([
  "search",
  "price",
  "createOrder",
  "findOrder",
  "checkPayable",
  "requestTicketing",
  "readOrder",
  "cancelOrRelease",
  "serviceRequest",
] as const);
export type SupplyAction = (typeof SUPPLY_ACTIONS)[number];

/** The outcome set of every action. */
export const ACTION_OUTCOMES = Object.freeze({
  search: SEARCH_OUTCOMES,
  price: PRICE_OUTCOMES,
  createOrder: CREATE_ORDER_OUTCOMES,
  findOrder: FIND_ORDER_OUTCOMES,
  checkPayable: CHECK_PAYABLE_OUTCOMES,
  requestTicketing: REQUEST_TICKETING_OUTCOMES,
  readOrder: READ_ORDER_OUTCOMES,
  cancelOrRelease: CANCEL_OR_RELEASE_OUTCOMES,
  serviceRequest: SERVICE_REQUEST_OUTCOMES,
} as const satisfies Readonly<Record<SupplyAction, readonly string[]>>);

/** The outcomes of action `A`. */
export type OutcomeOf<A extends SupplyAction> = (typeof ACTION_OUTCOMES)[A][number];
