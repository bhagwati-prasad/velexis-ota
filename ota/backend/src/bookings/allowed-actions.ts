// The self-service actions of a booking for its customer or guest (BookingAllowedActions of the OTA document; OBE-046;
// ota/docs/flows/my-bookings-and-guest-lookup.md §3 step 5, ota/docs/flows/change-and-cancel.md §3). A pure function of
// the booking's state, its segments, its documents, the storefront's switches and the refresh throttle at `now`: the
// storefront shows a button exactly when its action is true, and every false action has its reason.
//
//   Action                       True when (the first failing rule gives the reason)
//   canCancel                    live¹, nothing departed (`flown`), more than 3 h before the first departure
//                                (`too_close_to_departure`), self-service cancellation on (`disabled_by_ota`)
//   canModifyContacts            live¹, the last flight has not landed (`flown`)
//   canAddRemarks                as canModifyContacts
//   canModifyTravelerDocuments   never in the MVP (`disabled_by_ota`: bookings.update answers travellers' changes
//                                with 403 FEATURE_DISABLED, OBE-048); the state reasons come first
//   canModifyLoyaltyPrograms     as canModifyTravelerDocuments
//   canDownloadDocuments         a ready document exists; else `not_ticketed` before any ticket, `pending` after
//   canRefresh                   an Amadeus order, live¹ (or flown), no refresh in the last 60 s (`throttled`)
//   canAddAncillaries            never in the MVP: post-booking sales are deferred (scope.md §3), `disabled_by_ota`
//                                after the state, `flown`, `too_close_to_departure` (24 h) and the `ancillaries`
//                                switch rules
//
//   ¹ live: `confirmed`, `ticketed` or `partially_ticketed`; otherwise every action is false with the state as the reason
//     (`pending`, `failed`, `cancelled`).
//
// "Departed" means a segment is flown (Amadeus `isFlown`) or its departure instant has passed; "landed" means every
// segment is flown or the booking's last arrival has passed. The 3-hour and 24-hour windows count from the first
// segment that has not departed yet.
import type { components } from "@velexis/api-types";

type AllowedActions = components["schemas"]["BookingAllowedActions"];

/** A reason of BookingAllowedActions.reasons. */
export type ActionReason = AllowedActions["reasons"][string];

/** The actions BookingAllowedActions names, in the document's order. */
export const BOOKING_ACTIONS = [
  "canCancel",
  "canModifyContacts",
  "canModifyTravelerDocuments",
  "canModifyLoyaltyPrograms",
  "canAddRemarks",
  "canDownloadDocuments",
  "canRefresh",
  "canAddAncillaries",
] as const;

export type BookingAction = (typeof BOOKING_ACTIONS)[number];

/** Cancellation stops this long before the first remaining departure (change-and-cancel §3 step 3). */
export const CANCEL_CUTOFF_MS = 3 * 60 * 60_000;

/** Extra bags stop this long before the first remaining departure (BookingAllowedActions.canAddAncillaries). */
export const ANCILLARIES_CUTOFF_MS = 24 * 60 * 60_000;

/** How long after a refresh (or a sync) the next one is throttled (bookings.get `refresh=true`). */
export const REFRESH_THROTTLE_MS = 60_000;

/** Post-booking extra bags are deferred in the MVP (getBookingAncillaries and addBookingAncillaries are `deferred`). */
export const POST_BOOKING_ANCILLARIES = false;

/** Traveller changes through bookings.update are not offered in the MVP (OBE-048: `403 FEATURE_DISABLED`). */
export const TRAVELER_CHANGES = false;

/** A segment as the rules read it. */
export interface ActionSegment {
  readonly departureAt: Date;
  readonly arrivalAt: Date;
  readonly isFlown: boolean;
}

/** What the rules read of a booking. */
export interface AllowedActionsInput {
  readonly status: string;
  readonly ticketingStatus: string;
  readonly amadeusOrderId: string | null;
  readonly lastArrivalAt: Date;
  readonly segments: readonly ActionSegment[];
  /** A document of the booking is `ready`. */
  readonly documentsReady: boolean;
  /** The storefront's switches (`storefront_settings.features`). */
  readonly features: { readonly selfServiceCancellation: boolean; readonly ancillaries: boolean };
  /** The last refresh or sync of the booking (claim time), or `null`. */
  readonly lastRefreshAt: Date | null;
  readonly now: Date;
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(["confirmed", "ticketed", "partially_ticketed"]);

/** The reason every action has when the booking is not live, or `undefined` for a live booking. */
function stateReason(status: string): ActionReason | undefined {
  if (LIVE_STATUSES.has(status)) {
    return undefined;
  }
  if (status === "pending" || status === "failed" || status === "cancelled") {
    return status;
  }
  // An unknown state (a status the document does not have) allows nothing either.
  return "pending";
}

/** The first rule that fails, or `undefined` when all pass. */
function firstFailing(rules: ReadonlyArray<readonly [boolean, ActionReason]>): ActionReason | undefined {
  return rules.find(([passes]) => !passes)?.[1];
}

/** The allowed actions of a booking at `input.now` (see the file header). */
export function allowedActionsOf(input: AllowedActionsInput): AllowedActions {
  const now = input.now.getTime();
  const state = stateReason(input.status);
  const departed = input.segments.some((segment) => segment.isFlown || segment.departureAt.getTime() <= now);
  const landed =
    input.lastArrivalAt.getTime() <= now ||
    (input.segments.length > 0 && input.segments.every((segment) => segment.isFlown));
  const next = input.segments
    .filter((segment) => !segment.isFlown && segment.departureAt.getTime() > now)
    .reduce<number | undefined>(
      (earliest, segment) =>
        earliest === undefined || segment.departureAt.getTime() < earliest
          ? segment.departureAt.getTime()
          : earliest,
      undefined,
    );
  const before = (cutoffMs: number): boolean => next !== undefined && next - now > cutoffMs;
  const throttled = input.lastRefreshAt !== null && now - input.lastRefreshAt.getTime() < REFRESH_THROTTLE_MS;
  const ticketed =
    input.ticketingStatus === "issued" ||
    input.ticketingStatus === "partially_issued" ||
    input.status === "ticketed" ||
    input.status === "partially_ticketed";
  const live = (): readonly [boolean, ActionReason] => [state === undefined, state ?? "pending"];

  const failing: Record<BookingAction, ActionReason | undefined> = {
    canCancel: firstFailing([
      live(),
      [!departed, "flown"],
      [before(CANCEL_CUTOFF_MS), "too_close_to_departure"],
      [input.features.selfServiceCancellation, "disabled_by_ota"],
    ]),
    canModifyContacts: firstFailing([live(), [!landed, "flown"]]),
    canModifyTravelerDocuments: firstFailing([
      live(),
      [!landed, "flown"],
      [TRAVELER_CHANGES, "disabled_by_ota"],
    ]),
    canModifyLoyaltyPrograms: firstFailing([
      live(),
      [!landed, "flown"],
      [TRAVELER_CHANGES, "disabled_by_ota"],
    ]),
    canAddRemarks: firstFailing([live(), [!landed, "flown"]]),
    canDownloadDocuments: firstFailing([
      // Documents of a cancelled booking (the cancelled itinerary) stay downloadable once they exist.
      [input.documentsReady || state === undefined, state ?? "pending"],
      [input.documentsReady, ticketed ? "pending" : "not_ticketed"],
    ]),
    canRefresh: firstFailing([
      [state === undefined, state ?? "pending"],
      [input.amadeusOrderId !== null, "pending"],
      [!throttled, "throttled"],
    ]),
    canAddAncillaries: firstFailing([
      live(),
      [!departed, "flown"],
      [before(ANCILLARIES_CUTOFF_MS), "too_close_to_departure"],
      [input.features.ancillaries && POST_BOOKING_ANCILLARIES, "disabled_by_ota"],
    ]),
  };
  const reasons: Record<string, ActionReason> = {};
  for (const action of BOOKING_ACTIONS) {
    const reason = failing[action];
    if (reason !== undefined) {
      reasons[action] = reason;
    }
  }
  return {
    canCancel: failing.canCancel === undefined,
    canModifyContacts: failing.canModifyContacts === undefined,
    canModifyTravelerDocuments: failing.canModifyTravelerDocuments === undefined,
    canModifyLoyaltyPrograms: failing.canModifyLoyaltyPrograms === undefined,
    canAddRemarks: failing.canAddRemarks === undefined,
    canDownloadDocuments: failing.canDownloadDocuments === undefined,
    canRefresh: failing.canRefresh === undefined,
    canAddAncillaries: failing.canAddAncillaries === undefined,
    reasons,
  };
}
