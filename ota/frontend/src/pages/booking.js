// Entry module of the booking page (booking.html, ota/frontend/docs/pages-account.md §1 and §3, flows
// ota/docs/flows/my-bookings-and-guest-lookup.md §3 steps 5 and 8 and ota/docs/flows/change-and-cancel.md, SDK guide
// B3 §4). `/booking.html?id=bkg_…` shows one booking to its customer (session cookies) or to the guest whose
// `__Host-vx_bt` cookie holds its token (cookie mode: the page never sees a token).
//
// 1. `bookings.get({ bookingId })`: status, references, trip with each flight's status, travellers and their tickets,
//    contact, payment, the cancellation block (`booking.cancellation`: a cancelled booking, or a cancellation that
//    waits for the staff or the airline) and `allowedActions`. "Refresh from airline" (`canRefresh`) asks again with
//    `refresh: true` (the API throttles it to once a minute; an airline that does not answer keeps the saved booking).
// 2. While the booking or its tickets are pending, `bookings.getTicketingStatus({ bookingId })` after each answer's
//    `pollAfterSeconds` (10 s for a pending booking without one; at most 30 minutes for a pending booking, 10 for
//    tickets), and the booking again once decided, as on the confirmation page.
// 3. Documents (`canDownloadDocuments`): `bookings.listDocuments`; "Download" asks
//    `bookings.getDocumentDownloadUrl` on each click and navigates to the returned same-origin URL. The URL is signed
//    for 5 minutes, so it is never put in the page or kept.
// 4. Change contact details (`canModifyContacts`): a dialog with the primary contact, `bookings.update({ bookingId,
//    ifMatch: version, contacts })` with the whole contacts list (Amadeus replaces it); `409 VERSION_CONFLICT` reloads
//    the booking with `refresh: true` and `412` without, keeping what was typed; `422 CONTACT_DATA_INVALID` marks the
//    fields.
// 5. Cancel (`canCancel`, which the API already denies when the OTA turned self-service cancellation off):
//    components/cancel-dialog.js. When it is not allowed for a reason the traveller cannot change (flown, too close to
//    departure, turned off), the page says "This booking can no longer be cancelled online" with the support contact.
// 6. Fare rules: `bookings.getFareRules` when the "Changes and refunds" disclosure is first opened. Timeline:
//    `bookings.listEvents` (components/booking-timeline.js).
//
// Every control follows `allowedActions` exactly (`ACTION_CONTROLS`); the actions the MVP does not offer
// (`canModifyTravelerDocuments`, `canModifyLoyaltyPrograms`, `canAddRemarks`, `canAddAncillaries`) have none.
// States (pages-account.md §3): `401` without a session or guest token → "Find your booking" with the lookup link;
// `404` → "Booking not found"; the shared states with Retry.

import { boot, renderState } from "../boot.js";
import { mount as mountTimeline } from "../components/booking-timeline.js";
import { mount as mountCancelDialog, isZeroMoney, refundText } from "../components/cancel-dialog.js";
import { airlineLabel, itineraryTitle, renderItinerary } from "../components/itinerary.js";
import { mount as mountLiveRegion } from "../components/live-region.js";
import { clone, fill, on } from "../lib/dom.js";
import { isAborted, pageStateFor } from "../lib/errors.js";
import {
  formatLocalDate,
  formatLocalDateTime,
  formatMinutes,
  formatMoney,
  formatTimestamp,
} from "../lib/format.js";
import { clearFieldErrors, showFieldErrors, withSubmitState } from "../lib/forms.js";
import { hasString, t } from "../lib/i18n.js";
import { signInHref } from "../lib/session.js";
import { safeUrl } from "../lib/url.js";

/** @typedef {import("@velexis/ota-sdk").VelexisClient} VelexisClient */
/** @typedef {import("@velexis/ota-sdk").Schemas["Booking"]} Booking */
/** @typedef {import("@velexis/ota-sdk").Schemas["BookingItinerary"]} BookingItinerary */
/** @typedef {import("@velexis/ota-sdk").Schemas["BookingSegment"]} BookingSegment */
/** @typedef {import("@velexis/ota-sdk").Schemas["BookingTicketingStatus"]} TicketingStatus */
/** @typedef {import("@velexis/ota-sdk").Schemas["BookingFareRules"]} BookingFareRules */
/** @typedef {import("@velexis/ota-sdk").Schemas["Document"]} BookingDocument */
/** @typedef {import("@velexis/ota-sdk").Schemas["Contact"]} Contact */
/** @typedef {import("@velexis/ota-sdk").Schemas["ContactInput"]} ContactInput */
/** @typedef {import("@velexis/ota-sdk").Schemas["Itinerary"]} Itinerary */
/** @typedef {import("@velexis/ota-sdk").Schemas["Money"]} Money */
/** @typedef {import("../lib/errors.js").PageState} PageState */
/** @typedef {import("../lib/config.js").StorefrontConfig} StorefrontConfig */
/** @typedef {import("../lib/session.js").SessionInfo} SessionInfo */
/** @typedef {Pick<VelexisClient, "bookings">} PageClient */

/** A booking id as the API writes it. */
export const BOOKING_ID = /^bkg_[0-9A-Za-z]{16,40}$/;
/** The page's control of each action of `allowedActions` (the `data-action` of its button). */
export const ACTION_CONTROLS = Object.freeze({
  canModifyContacts: "change-contacts",
  canCancel: "cancel",
  canRefresh: "refresh",
  canDownloadDocuments: "download",
});
/** Documents per page of `bookings.listDocuments`. */
export const DOCUMENTS_LIMIT = 20;
/** Events per page of `bookings.listEvents`. */
export const EVENTS_LIMIT = 20;
/** The polling interval while a booking is pending, when an answer gives none. */
export const PENDING_POLL_SECONDS = 10;
/** The wait before trying again after a poll that failed. */
export const RETRY_POLL_SECONDS = 10;
/** How long a pending booking is polled. */
export const PENDING_POLL_LIMIT_MS = 30 * 60_000;
/** How long the issue of tickets is polled; the banner already says that the tickets follow by e-mail. */
export const TICKETING_POLL_LIMIT_MS = 10 * 60_000;
/** Booking states in which the traveller can act. */
const LIVE = new Set(["confirmed", "ticketed", "partially_ticketed"]);
/** Ticketing states that are still moving (polled). */
const TICKETING_OPEN = new Set(["pending", "in_progress"]);
/** Ticketing states that are not final for the traveller (the banner). */
const TICKETING_DONE = new Set(["issued", "not_applicable"]);
/** Reasons of `allowedActions.reasons.canCancel` the page explains with the support contact. */
const CANCEL_CLOSED = new Set([
  "flown",
  "too_close_to_departure",
  "disabled_by_ota",
  "ticketed_non_refundable",
  "not_offered_by_airline",
]);
/** Ticket types of the flights themselves (EMDs are extras). */
const FLIGHT_TICKETS = new Set(["ETICKET", "PTICKET"]);
/** Failures of a poll after which polling cannot do better. */
const FINAL_POLL_STATES = new Set([
  "suspended",
  "unknown-host",
  "signed-out",
  "not-found",
  "forbidden",
  "validation",
  "feature-disabled",
]);
/** Failures of a load without Retry. */
const FINAL_STATES = new Set(["suspended", "unknown-host", "forbidden", "validation", "feature-disabled"]);
/** The date of a bound's title: "Tue 1 Dec 2026". */
const BOUND_DATE = /** @type {const} */ ({
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Reports an error of the page (the browser's console and `error` event) without breaking it.
 * @param {unknown} error
 */
function report(error) {
  try {
    globalThis.reportError?.(error);
  } catch {
    // Nothing else to do.
  }
}

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Whether a value is a plain object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A copy of an API value without its `null` and `undefined` fields (deep), for a request whose schema refuses them.
 * @param {unknown} value
 * @returns {unknown}
 */
function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .map(([key, entry]) => [key, compact(entry)]),
  );
}

/**
 * The status the page shows: the booking's own, or `cancellation_requested` for a live booking whose cancellation
 * waits for the staff or the airline.
 * @param {Booking} booking
 */
export function statusCodeOf(booking) {
  return booking.status !== "cancelled" && booking.cancellation?.status === "pending"
    ? "cancellation_requested"
    : booking.status;
}

/**
 * The primary contact of a booking: the primary one that is not an invoice contact, else the first such contact.
 * @param {ReadonlyArray<Contact>} contacts
 * @returns {Contact | null}
 */
export function primaryContactOf(contacts) {
  return (
    contacts.find((contact) => contact.isPrimary && contact.purpose !== "INVOICE") ??
    contacts.find((contact) => contact.purpose !== "INVOICE") ??
    null
  );
}

/**
 * A copy of a record without some of its fields.
 * @param {object} record
 * @param {ReadonlyArray<string>} keys
 * @returns {Record<string, unknown>}
 */
const without = (record, keys) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/**
 * A booking contact as `ContactInput` (its `id` and empty fields left out).
 * @param {Contact} contact
 * @returns {ContactInput}
 */
function contactInputOf(contact) {
  return /** @type {ContactInput} */ (compact(without(contact, ["id"])));
}

/**
 * The `contacts` of `bookings.update`: the primary contact with the values of the form first (its other fields kept),
 * then the booking's other contacts as they are, because Amadeus replaces the whole list.
 * @param {ReadonlyArray<Contact>} contacts the booking's contacts
 * @param {{ firstName: string, lastName: string, email: string, callingCode: string, number: string }} values
 * @returns {ContactInput[]}
 */
export function contactsUpdate(contacts, values) {
  const primary = primaryContactOf(contacts);
  const base = primary ? contactInputOf(primary) : /** @type {ContactInput} */ ({});
  const phones = list(base.phones);
  const number = values.number.replace(/\D/g, "");
  const callingCode = values.callingCode.replace(/\D/g, "");
  const firstPhone = phones[0];
  /** @type {ContactInput["phones"]} */
  const nextPhones =
    number === ""
      ? phones.slice(1)
      : [
          {
            deviceType: firstPhone?.deviceType ?? "MOBILE",
            ...(callingCode !== "" ? { countryCallingCode: callingCode } : {}),
            number,
          },
          ...phones.slice(1),
        ];
  const firstName = values.firstName.trim();
  const lastName = values.lastName.trim();
  // The addressee keeps its other parts (a middle name, a title); first and last name are the form's.
  const addressee = {
    ...without(isRecord(base.addresseeName) ? base.addresseeName : {}, ["firstName", "lastName"]),
    ...(firstName !== "" ? { firstName } : {}),
    ...(lastName !== "" ? { lastName } : {}),
  };
  /** @type {ContactInput} */
  const next = {
    ...without(base, ["addresseeName", "phones", "emailAddress"]),
    purpose: base.purpose ?? "STANDARD",
    isPrimary: true,
    ...(Object.keys(addressee).length > 0 ? { addresseeName: addressee } : {}),
    emailAddress: values.email.trim(),
    ...(nextPhones && nextPhones.length > 0 ? { phones: nextPhones } : {}),
  };
  return [
    next,
    ...contacts
      .filter((contact) => contact !== primary)
      .map((contact) => ({ ...contactInputOf(contact), isPrimary: false })),
  ];
}

/**
 * Where a document download goes: the signed same-origin path of `bookings.getDocumentDownloadUrl` (cookie mode), or
 * an absolute URL of this very origin; `null` for anything else (the page never sends the traveller elsewhere).
 * @param {unknown} url
 * @param {Location} location
 * @returns {string | null}
 */
export function downloadTarget(url, location) {
  if (typeof url !== "string") {
    return null;
  }
  const path = safeUrl(url, []);
  if (path !== null && path.startsWith("/")) {
    return path;
  }
  try {
    const absolute = new URL(url);
    return absolute.origin === location.origin && safeUrl(absolute.href, ["https:", "http:"]) !== null
      ? `${absolute.pathname}${absolute.search}`
      : null;
  } catch {
    return null;
  }
}

/**
 * A bound of a booking in the shape of the result card's row (components/itinerary.js).
 * @param {BookingItinerary} itinerary
 * @returns {Itinerary}
 */
function itineraryRow(itinerary) {
  const segments = list(itinerary.segments);
  return /** @type {Itinerary} */ (
    /** @type {unknown} */ ({
      ...itinerary,
      marketingCarriers: [...new Set(segments.map((segment) => segment?.carrierCode).filter(Boolean))],
      stopAirports: segments.slice(0, -1).map((segment) => segment?.arrival?.iataCode ?? ""),
    })
  );
}

/**
 * A condition at a glance (the price page's wording): allowed, free, with its maximum fee, not allowed or not known.
 * @param {boolean | null | undefined} allowed
 * @param {Money | null | undefined} penalty
 * @param {string | undefined} locale
 */
function conditionText(allowed, penalty, locale) {
  if (allowed === false) {
    return t("rules.notAllowed");
  }
  if (allowed !== true) {
    return t("rules.unknown");
  }
  if (!penalty) {
    return t("rules.allowed");
  }
  return isZeroMoney(penalty) ? t("rules.free") : t("rules.feeUpTo", { price: formatMoney(penalty, locale) });
}

/**
 * The lines of the fare rules: the refund and change summary, then one line per rule of the airline.
 * @param {BookingFareRules} rules
 * @param {string | undefined} locale
 */
export function fareRuleLines(rules, locale) {
  const summary = rules.summary
    ? [
        {
          category: "REFUND",
          label: t("rules.label", { label: t("rules.refund") }),
          status: conditionText(rules.summary.refundable, rules.summary.refundPenalty, locale),
          detail: null,
        },
        {
          category: "EXCHANGE",
          label: t("rules.label", { label: t("rules.change") }),
          status: conditionText(rules.summary.changeable, rules.summary.changePenalty, locale),
          detail: null,
        },
      ]
    : [];
  const categories = list(rules.rules).map((rule) => {
    const name = hasString(`rules.category.${rule.category}`)
      ? t(`rules.category.${rule.category}`)
      : String(rule.category);
    let status = t("rules.allowed");
    if (rule.applicable === false) {
      status = t("rules.notAllowed");
    } else if (rule.chargeable === true) {
      status =
        rule.maxPenalty && !isZeroMoney(rule.maxPenalty)
          ? t("rules.categoryFeeUpTo", { price: formatMoney(rule.maxPenalty, locale) })
          : t("rules.forFee");
    } else if (rule.chargeable === false) {
      status = t("rules.free");
    }
    const texts = [
      rule.circumstances,
      ...list(rule.texts).map((/** @type {{ text?: unknown }} */ entry) => entry?.text),
    ].filter((entry) => typeof entry === "string" && entry.trim() !== "");
    return {
      category: String(rule.category),
      label: t("rules.label", { label: name }),
      status,
      detail: texts.length > 0 ? texts.join("\n") : null,
    };
  });
  return { summary, categories };
}

/**
 * Runs the booking page (see the top of this file) in `doc`, with what boot() returned. Returns `null` when the page
 * has no booking area, else `{ done, destroy }`: `done` settles once the booking (or a state), its documents and its
 * timeline are shown.
 * @param {{ config: StorefrontConfig, client: PageClient, session?: SessionInfo | null }} context
 * @param {{ doc?: Document, location?: Location, navigate?: (url: string) => void, now?: () => number }} [env] for tests
 */
export function start(context, env = {}) {
  const doc = env.doc ?? document;
  const main = /** @type {HTMLElement | null} */ (doc.querySelector("[data-booking-page]"));
  if (!main) {
    return null;
  }
  const view = doc.defaultView ?? globalThis;
  const location = env.location ?? view.location;
  const navigate = env.navigate ?? ((/** @type {string} */ url) => location.assign(url));
  const now = env.now ?? (() => Date.now());
  const { config, client, session = null } = context;
  const locale = config?.defaultLocale;
  const timeZone = config?.timeZone;
  const support = config?.support ?? null;
  const live = mountLiveRegion(doc.body);

  const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (main.querySelector(selector));
  const button = (/** @type {string} */ action) =>
    /** @type {HTMLButtonElement} */ (main.querySelector(`button[data-action="${action}"]`));
  const el = {
    back: find("[data-back-link]"),
    title: find("[data-booking-title]"),
    state: find("[data-booking-state]"),
    loading: find("[data-booking-loading]"),
    content: find("[data-booking-content]"),
    status: find("[data-booking-status]"),
    reference: find("[data-booking-reference]"),
    airlineReferences: find("[data-airline-references]"),
    bookedAt: find("[data-booked-at]"),
    syncedAt: find("[data-synced-at]"),
    refresh: button("refresh"),
    notice: find("[data-booking-notice]"),
    banner: find("[data-booking-banner]"),
    cancellation: find("[data-cancellation-block]"),
    cancellationTitle: find("[data-cancellation-title]"),
    cancellationText: find("[data-cancellation-text]"),
    cancellationRefund: find("[data-cancellation-refund]"),
    actions: find("[data-actions]"),
    changeContacts: button("change-contacts"),
    cancel: button("cancel"),
    cancelUnavailable: find("[data-cancel-unavailable]"),
    supportContact: find("[data-support-contact]"),
    supportLink: /** @type {HTMLAnchorElement} */ (main.querySelector("a[data-support-link]")),
    itineraries: find("[data-itineraries]"),
    travellers: find("[data-travellers]"),
    contact: find("[data-contact]"),
    cardFeeLine: find("[data-card-fee-line]"),
    cardFee: find("[data-card-fee]"),
    total: find("[data-total]"),
    paid: find("[data-paid]"),
    refundedLine: find("[data-refunded-line]"),
    refunded: find("[data-refunded]"),
    documentsNote: find("[data-documents-note]"),
    documents: find("[data-documents]"),
    documentsState: find("[data-documents-state]"),
    rules: /** @type {HTMLDetailsElement} */ (main.querySelector("details[data-fare-rules]")),
    rulesLoading: find("[data-rules-loading]"),
    rulesSummary: find("[data-rules-summary]"),
    rulesCategories: find("[data-rules-categories]"),
    rulesUnavailable: find("[data-rules-unavailable]"),
    rulesState: find("[data-rules-state]"),
    timeline: find("[data-timeline]"),
    contactsDialog: /** @type {HTMLDialogElement} */ (main.querySelector("dialog[data-contacts-dialog]")),
    contactsForm: /** @type {HTMLFormElement} */ (main.querySelector("form[data-contacts-form]")),
    contactsState: find("[data-contacts-state]"),
    cancelDialog: /** @type {HTMLDialogElement} */ (main.querySelector("dialog[data-cancel-dialog]")),
  };

  const idParam = new URLSearchParams(location.search).get("id");
  const bookingId = idParam !== null && BOOKING_ID.test(idParam) ? idParam : null;
  /** @type {Booking | null} */
  let booking = null;
  /** The last ticketing status of a poll. @type {TicketingStatus | null} */
  let status = null;
  let destroyed = false;
  /** Whether the fare rules were loaded (they load once, when the disclosure is first opened). */
  let rulesLoaded = false;
  let refreshing = false;
  /** The end of polling for the current phase (`pending` or `ticketing`). */
  let deadline = { phase: "", at: 0 };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** Running calls, aborted by destroy. @type {Set<AbortController>} */
  const controllers = new Set();

  const track = () => {
    const controller = new AbortController();
    controllers.add(controller);
    return { signal: controller.signal, done: () => controllers.delete(controller) };
  };

  /** @param {unknown} error */
  const requestIdOf = (error) =>
    error instanceof Error && "requestId" in error
      ? String(/** @type {{ requestId: unknown }} */ (error).requestId ?? "") || null
      : null;

  const timeline = mountTimeline(el.timeline, { locale, timeZone, support, announce: live.announce });

  // ---- Page states ------------------------------------------------------------------------------------------------

  /** Sets the page's heading and title. */
  const setTitle = (/** @type {string} */ title) => {
    el.title.textContent = title;
    doc.title = title;
  };

  /**
   * Replaces the booking with a state (it could not be read).
   * @param {Pick<PageState, "name" | "message"> & Partial<PageState>} state
   * @param {{ links?: Array<{ label: string, href: string }>, onRetry?: () => void, requestId?: string | null, focus?: boolean }} [options]
   */
  const showPageState = (state, { links = [], onRetry, requestId = null, focus = false } = {}) => {
    stopPolling();
    el.loading.hidden = true;
    el.content.hidden = true;
    setTitle(t("booking.titleNone"));
    doc.title = state.message;
    const element = renderState(
      el.state,
      { ...state, scope: "inline" },
      { support, requestId, focus, ...(onRetry ? { onRetry } : {}) },
    );
    const retry = element.querySelector('[data-action="retry"]')?.closest("p") ?? null;
    for (const link of links) {
      const item = fill(clone("tpl-state-link", doc), link);
      if (retry) {
        retry.before(item);
      } else {
        element.append(item);
      }
    }
    live.announce(state.message);
  };

  const lookupLink = () => ({ label: t("booking.findBooking"), href: "/lookup.html" });

  /** "Booking not found" (`404`, or an address without a valid id). */
  const showMissing = (focus = false) => {
    showPageState(
      { name: "not-found", message: t("booking.missing") },
      {
        links: session ? [{ label: t("booking.myBookings"), href: "/bookings.html" }] : [lookupLink()],
        focus,
      },
    );
  };

  /** Without access to the booking (`401`): the lookup link, and sign-in for a customer's booking. */
  const showLookup = (focus = false) => {
    const links = [lookupLink()];
    if (!session && config?.features?.customerAccounts !== false) {
      links.push({ label: t("account.signIn"), href: signInHref(location) });
    }
    showPageState(
      {
        // Not an API state: its name gives it its hint (`stateHint.booking-lookup`) and its `data-state`.
        name: /** @type {PageState["name"]} */ (/** @type {unknown} */ ("booking-lookup")),
        message: t("booking.lookup"),
      },
      { links, focus },
    );
  };

  /**
   * A message above the booking: a success line, or a state of a failed action.
   * @param {string} message
   */
  const showSuccess = (message) => {
    const line = doc.createElement("p");
    line.className = "rounded-ui border-2 border-success bg-panel p-4";
    line.dataset.notice = "success";
    line.textContent = message;
    el.notice.replaceChildren(line);
    live.announce(message);
  };

  /**
   * A failed action of the page, above the booking: its state (with the request id for "Something went wrong").
   * @param {unknown} error
   * @param {{ message?: string, onRetry?: () => void }} [options]
   */
  const showFailure = (error, { message, onRetry } = {}) => {
    const state = pageStateFor(error);
    const unexpected = state.name === "unexpected" || state.name === "validation";
    const shown = message ?? (unexpected ? t("state.unexpected") : state.message);
    renderState(
      el.notice,
      { ...state, scope: "inline", message: shown },
      {
        support,
        focus: true,
        requestId: unexpected ? requestIdOf(error) : null,
        ...(onRetry && !FINAL_STATES.has(state.name) ? { onRetry } : {}),
      },
    );
    live.announce(shown);
  };

  // ---- Rendering ------------------------------------------------------------------------------------------------

  /** One line of a list (`tpl-booking-item`). */
  const item = (/** @type {string} */ value) => fill(clone("tpl-booking-item", doc), { text: value });

  /** The trip: each bound's row (times, airports, duration, stops, airlines) and its flights with their status. */
  const renderTrip = () => {
    if (!booking) {
      return;
    }
    const tripType = booking.tripType ?? "one_way";
    /** @type {Map<string, string>} */
    const airlines = new Map();
    const segments = list(booking.itineraries).flatMap((itinerary) => list(itinerary?.segments));
    for (const segment of segments) {
      if (typeof segment?.carrierName === "string" && segment.carrierName !== "") {
        airlines.set(segment.carrierCode, segment.carrierName);
      }
    }
    const airline = (/** @type {string} */ code) => airlineLabel(code, airlines.get(code));
    el.itineraries.replaceChildren(
      ...list(booking.itineraries).map((/** @type {BookingItinerary} */ itinerary) => {
        const bound = clone("tpl-booking-bound", doc);
        const row = renderItinerary(itineraryRow(itinerary), {
          doc,
          locale,
          tripType,
          airline,
          place: (code) => code,
        });
        const title = row.querySelector('[data-field="title"]');
        if (title) {
          title.textContent = t("offerPage.boundDate", {
            title: itineraryTitle(itinerary.index, tripType),
            date: formatLocalDate(itinerary.departureAt, locale, BOUND_DATE),
          });
        }
        bound.querySelector("[data-bound-row]")?.append(row);
        bound.querySelector("[data-bound-segments]")?.append(
          ...list(itinerary.segments).map((/** @type {BookingSegment} */ segment) => {
            const details = [
              typeof segment.durationMinutes === "number" ? formatMinutes(segment.durationMinutes) : null,
              typeof segment.cabin === "string" ? t(`cabin.${segment.cabin}`) : null,
              text(segment.brandedFareLabel) || null,
            ].filter((part) => part !== null && part !== "");
            const statusText =
              segment.status !== "CONFIRMED" && hasString(`booking.segmentStatus.${segment.status}`)
                ? t(`booking.segmentStatus.${segment.status}`)
                : segment.isFlown
                  ? t("booking.segmentStatus.flown")
                  : segment.scheduleChanged
                    ? t("booking.segmentChanged")
                    : null;
            return fill(clone("tpl-booking-segment", doc), {
              status: segment.status,
              flight: t("segment.flight", {
                airline: airline(segment.carrierCode),
                flightNumber: segment.flightNumber,
              }),
              route: t("bookings.route", {
                from: t("segment.endpoint", {
                  time: formatLocalDateTime(segment.departure?.at, locale),
                  place: segment.departure?.iataCode ?? "",
                }),
                to: t("segment.endpoint", {
                  time: formatLocalDateTime(segment.arrival?.at, locale),
                  place: segment.arrival?.iataCode ?? "",
                }),
              }),
              details: details.length > 0 ? details.join(t("results.separator")) : null,
              noDetails: details.length === 0,
              statusText,
              noStatusText: statusText === null,
            });
          }),
        );
        return bound;
      }),
    );
  };

  /** The travellers with their flight tickets. */
  const renderTravellers = () => {
    if (!booking) {
      return;
    }
    const tickets = list(booking.tickets).filter(
      (ticket) => FLIGHT_TICKETS.has(ticket?.documentType) && ticket.status === "ISSUED",
    );
    el.travellers.replaceChildren(
      ...list(booking.travelers).map((traveller) => {
        const name = [text(traveller?.name?.firstName), text(traveller?.name?.lastName)]
          .filter((part) => part !== "")
          .join(" ");
        const type = hasString(`traveller.${traveller?.travelerType}`)
          ? t(`traveller.${traveller.travelerType}`)
          : String(traveller?.travelerType ?? "");
        const numbers = tickets
          .filter((ticket) => ticket.travelerId === traveller?.travelerId)
          .map((ticket) => ticket.documentNumber);
        return fill(clone("tpl-traveller", doc), {
          name: type !== "" ? t("booking.traveller", { name, type }) : name,
          tickets:
            numbers.length > 0
              ? t("booking.tickets", { count: numbers.length, numbers: numbers.join(", ") })
              : null,
          noTickets: numbers.length === 0,
        });
      }),
    );
  };

  /** The primary contact: name, e-mail, phone. */
  const renderContact = () => {
    const primary = primaryContactOf(list(booking?.contacts));
    const name = [text(primary?.addresseeName?.firstName), text(primary?.addresseeName?.lastName)]
      .filter((part) => part !== "")
      .join(" ");
    const phone = list(primary?.phones)[0];
    const lines = [
      name,
      text(primary?.emailAddress),
      phone && text(phone.number) !== ""
        ? text(phone.countryCallingCode) !== ""
          ? t("booking.phone", { code: text(phone.countryCallingCode), number: text(phone.number) })
          : text(phone.number)
        : "",
    ].filter((line) => line !== "");
    el.contact.replaceChildren(...(lines.length > 0 ? lines : [t("booking.contactNone")]).map(item));
  };

  /** Total, paid, card fee and refunded. */
  const renderPayment = () => {
    const totals = booking?.totals;
    el.total.textContent = formatMoney(totals?.total, locale);
    el.paid.textContent = formatMoney(totals?.paid, locale);
    el.cardFeeLine.hidden = !totals?.cardFee || isZeroMoney(totals.cardFee);
    el.cardFee.textContent = totals?.cardFee ? formatMoney(totals.cardFee, locale) : "";
    el.refundedLine.hidden = !totals?.refunded || isZeroMoney(totals.refunded);
    el.refunded.textContent = formatMoney(totals?.refunded, locale);
  };

  /** The cancellation block: a cancelled booking, or a cancellation that waits for the staff or the airline. */
  const renderCancellation = () => {
    const cancellation = booking?.cancellation ?? null;
    el.cancellation.hidden = cancellation === null;
    if (!booking || cancellation === null) {
      return;
    }
    const cancelled = cancellation.status === "cancelled" || booking.status === "cancelled";
    el.cancellation.dataset.status = cancelled ? "cancelled" : "pending";
    el.cancellationTitle.textContent = cancelled
      ? t("booking.cancelledTitle")
      : t("booking.cancellationRequestedTitle");
    const at = cancellation.cancelledAt ?? booking.cancelledAt ?? cancellation.requestedAt;
    el.cancellationText.textContent = cancelled
      ? t("booking.cancelledOn", { time: formatTimestamp(String(at), locale, timeZone) })
      : t("booking.cancellationRequested", {
          time: formatTimestamp(cancellation.requestedAt, locale, timeZone),
        });
    const money = cancelled
      ? refundText(cancellation, locale)
      : cancellation.estimatedRefund && !isZeroMoney(cancellation.estimatedRefund)
        ? t("booking.estimatedRefund", { amount: formatMoney(cancellation.estimatedRefund, locale) })
        : null;
    el.cancellationRefund.textContent = money ?? "";
    el.cancellationRefund.hidden = money === null;
  };

  /** The controls of `allowedActions` (ACTION_CONTROLS), exactly. */
  const renderActions = () => {
    const actions = booking?.allowedActions;
    const active = booking !== null && LIVE.has(booking.status);
    el.changeContacts.hidden = actions?.canModifyContacts !== true;
    el.cancel.hidden = actions?.canCancel !== true;
    el.refresh.hidden = actions?.canRefresh !== true;
    const reason = actions?.reasons?.["canCancel"];
    el.cancelUnavailable.hidden = !(
      actions?.canCancel !== true &&
      active &&
      booking?.cancellation === null &&
      typeof reason === "string" &&
      CANCEL_CLOSED.has(reason)
    );
    const email =
      typeof support?.email === "string" && !support.email.endsWith(".invalid") ? support.email : null;
    el.supportContact.hidden = email === null;
    el.supportLink.textContent = email ?? "";
    if (email !== null) {
      el.supportLink.href = `mailto:${email}`;
    } else {
      el.supportLink.removeAttribute("href");
    }
    el.actions.hidden = el.changeContacts.hidden && el.cancel.hidden && el.cancelUnavailable.hidden;
  };

  /** The banner of a booking that is being confirmed, has failed, or waits for its tickets. */
  const renderBanner = () => {
    if (!booking) {
      return;
    }
    const bookingStatus = status?.bookingStatus ?? booking.status;
    const ticketing = status?.status ?? booking.ticketing?.status;
    const message =
      bookingStatus === "pending"
        ? t("booking.pendingBooking")
        : bookingStatus === "failed"
          ? t("booking.failedBooking")
          : LIVE.has(bookingStatus) && !TICKETING_DONE.has(String(ticketing))
            ? t("booking.ticketing")
            : null;
    el.banner.textContent = message ?? "";
    el.banner.hidden = message === null;
  };

  /** Shows the whole booking. */
  const render = () => {
    if (!booking) {
      return;
    }
    el.state.replaceChildren();
    el.loading.hidden = true;
    el.content.hidden = false;
    el.back.hidden = session === null;
    setTitle(t("booking.title", { reference: booking.reference }));
    const code = statusCodeOf(booking);
    el.status.dataset.status = code;
    el.status.textContent = hasString(`bookingStatus.${code}`) ? t(`bookingStatus.${code}`) : code;
    el.reference.textContent = booking.reference;
    const references = list(booking.recordLocators)
      .filter((locator) => typeof locator?.reference === "string" && locator.originSystemCode !== "1A")
      .map((locator) => t("confirmation.airlineReference", locator));
    el.airlineReferences.textContent =
      references.length > 0 ? t("confirmation.airlineReferences", { references: references.join(", ") }) : "";
    el.airlineReferences.hidden = references.length === 0;
    el.bookedAt.textContent = t("booking.bookedAt", {
      time: formatTimestamp(booking.createdAt, locale, timeZone),
    });
    el.syncedAt.textContent =
      typeof booking.lastSyncedAt === "string"
        ? t("booking.syncedAt", { time: formatTimestamp(booking.lastSyncedAt, locale, timeZone) })
        : t("booking.notSynced");
    renderBanner();
    renderCancellation();
    renderActions();
    renderTrip();
    renderTravellers();
    renderContact();
    renderPayment();
  };

  // ---- Documents, events, fare rules --------------------------------------------------------------------------

  /** The documents of the booking, or why there are none yet. */
  const loadDocuments = async () => {
    if (!booking || bookingId === null) {
      return;
    }
    el.documentsState.replaceChildren();
    const actions = booking.allowedActions;
    if (actions?.canDownloadDocuments !== true) {
      el.documents.replaceChildren();
      const reason = actions?.reasons?.["canDownloadDocuments"];
      el.documentsNote.textContent =
        reason === "not_ticketed"
          ? t("booking.documentsNotTicketed")
          : reason === "pending"
            ? t("booking.documentsPending")
            : t("booking.documentsNone");
      el.documentsNote.hidden = false;
      return;
    }
    const call = track();
    try {
      const page = await client.bookings.listDocuments(
        { bookingId, limit: DOCUMENTS_LIMIT },
        { signal: call.signal },
      );
      if (destroyed) {
        return;
      }
      const shown = list(page.data).filter(
        (/** @type {BookingDocument} */ entry) => entry?.status === "ready" || entry?.status === "pending",
      );
      el.documents.replaceChildren(
        ...shown.map((/** @type {BookingDocument} */ entry) => {
          const kind = hasString(`document.kind.${entry.kind}`)
            ? t(`document.kind.${entry.kind}`)
            : entry.kind;
          const ready = entry.status === "ready";
          return fill(clone("tpl-document-row", doc), {
            id: entry.id,
            kind,
            detail: t("booking.documentDetail", {
              fileName: entry.fileName,
              time: formatTimestamp(entry.createdAt, locale, timeZone),
            }),
            downloadLabel: t("booking.documentDownload", { name: `${kind}, ${entry.fileName}` }),
            ready,
            notReady: !ready,
            status: ready ? null : t("booking.documentPreparing"),
          });
        }),
      );
      el.documentsNote.textContent = shown.length === 0 ? t("booking.documentsNone") : "";
      el.documentsNote.hidden = shown.length > 0;
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      el.documents.replaceChildren();
      el.documentsNote.hidden = true;
      const state = pageStateFor(error);
      renderState(
        el.documentsState,
        { ...state, scope: "inline", message: t("booking.documentsFailed") },
        { support, onRetry: () => loadDocuments().catch(report) },
      );
    } finally {
      call.done();
    }
  };

  /** The timeline of the booking. */
  const loadEvents = async () => {
    if (bookingId === null) {
      return;
    }
    const call = track();
    try {
      const page = await client.bookings.listEvents(
        { bookingId, limit: EVENTS_LIMIT },
        { signal: call.signal },
      );
      if (!destroyed) {
        timeline.show(page);
      }
    } catch (error) {
      if (!destroyed && !isAborted(error)) {
        timeline.fail(error, () => loadEvents().catch(report));
      }
    } finally {
      call.done();
    }
  };

  /** The fare rules, once, when the disclosure is first opened. */
  const loadRules = async () => {
    if (bookingId === null || rulesLoaded) {
      return;
    }
    rulesLoaded = true;
    el.rulesState.replaceChildren();
    el.rulesLoading.hidden = false;
    const call = track();
    try {
      const rules = await client.bookings.getFareRules({ bookingId }, { signal: call.signal });
      if (destroyed) {
        return;
      }
      const lines = fareRuleLines(rules, locale);
      const rule = (
        /** @type {{ category: string, label: string, status: string, detail: string | null }} */ line,
      ) => fill(clone("tpl-rule", doc), { ...line, noDetail: line.detail === null });
      el.rulesSummary.replaceChildren(...lines.summary.map(rule));
      el.rulesCategories.replaceChildren(...lines.categories.map(rule));
      el.rulesUnavailable.hidden = rules.available !== false && lines.categories.length > 0;
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      rulesLoaded = false;
      const state = pageStateFor(error);
      renderState(
        el.rulesState,
        { ...state, scope: "inline", message: t("rules.failed") },
        { support, onRetry: () => loadRules().catch(report) },
      );
    } finally {
      el.rulesLoading.hidden = true;
      call.done();
    }
  };
  const onRulesToggle = () => {
    if (el.rules.open) {
      loadRules().catch(report);
    }
  };
  el.rules.addEventListener("toggle", onRulesToggle);

  /**
   * A click on "Download": a new signed URL for this document, then the browser goes there. Nothing is pre-generated
   * or kept: the URL expires after 5 minutes.
   * @param {Event} _event
   * @param {Element} matched
   */
  const onDownload = async (_event, matched) => {
    const control = /** @type {HTMLButtonElement} */ (matched);
    const documentId = control.dataset.documentId;
    const row = control.closest("[data-document-row]");
    const message = /** @type {HTMLElement | null} */ (row?.querySelector("[data-document-message]") ?? null);
    if (!documentId || bookingId === null || control.getAttribute("aria-disabled") === "true") {
      return;
    }
    if (message) {
      message.hidden = true;
      message.textContent = "";
    }
    control.setAttribute("aria-disabled", "true");
    live.announce(t("booking.downloading"));
    const call = track();
    try {
      const link = await client.bookings.getDocumentDownloadUrl(
        { bookingId, documentId },
        { signal: call.signal },
      );
      const target = downloadTarget(link?.url, location);
      if (target === null) {
        throw new Error("the download URL is not on this storefront");
      }
      if (!destroyed) {
        navigate(target);
      }
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      const shown =
        state.code === "DOCUMENT_NOT_READY"
          ? t("booking.documentNotReady")
          : state.name === "not-found"
            ? t("booking.documentGone")
            : state.name === "unexpected"
              ? t("state.unexpected")
              : state.message;
      if (message) {
        message.textContent = shown;
        message.hidden = false;
      }
      live.announce(shown);
      if (state.name === "unexpected") {
        // Not an answer of the API (a download URL off this storefront, say): reported, as a bug of the page.
        report(error);
      }
    } finally {
      call.done();
      control.removeAttribute("aria-disabled");
    }
  };
  const offDownload = on(el.documents, "click", '[data-action="download"]', (event, matched) => {
    onDownload(event, matched).catch(report);
  });

  // ---- Ticketing polling --------------------------------------------------------------------------------------

  /** Stops polling. */
  function stopPolling() {
    clearTimeout(timer);
    timer = undefined;
  }

  /** Whether the booking or its tickets are still moving (and worth polling). */
  const moving = () => {
    if (!booking) {
      return false;
    }
    const bookingStatus = status?.bookingStatus ?? booking.status;
    const ticketing = status?.status ?? booking.ticketing?.status;
    return bookingStatus === "pending" || (LIVE.has(bookingStatus) && TICKETING_OPEN.has(String(ticketing)));
  };

  /**
   * Plans the next poll in `seconds`, unless the current phase reached its limit.
   * @param {number} seconds
   */
  const schedule = (seconds) => {
    stopPolling();
    const phase = (status?.bookingStatus ?? booking?.status) === "pending" ? "pending" : "ticketing";
    if (deadline.phase !== phase) {
      deadline = {
        phase,
        at: now() + (phase === "pending" ? PENDING_POLL_LIMIT_MS : TICKETING_POLL_LIMIT_MS),
      };
    }
    if (now() + seconds * 1000 > deadline.at) {
      return;
    }
    timer = setTimeout(() => {
      poll().catch(report);
    }, seconds * 1000);
  };

  /** One poll of the ticketing status; once the booking or its tickets are decided, the booking again. */
  const poll = async () => {
    if (destroyed || bookingId === null || !booking) {
      return;
    }
    const call = track();
    /** @type {TicketingStatus} */
    let next;
    try {
      next = await client.bookings.getTicketingStatus({ bookingId }, { signal: call.signal });
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (!FINAL_POLL_STATES.has(state.name)) {
        schedule(
          state.name === "rate-limited" && state.retryAfterSeconds
            ? state.retryAfterSeconds
            : RETRY_POLL_SECONDS,
        );
      }
      return;
    } finally {
      call.done();
    }
    if (destroyed) {
      return;
    }
    status = next;
    renderBanner();
    if (moving()) {
      const after = next.pollAfterSeconds;
      if (typeof after === "number" && after > 0) {
        schedule(after);
      } else if (next.bookingStatus === "pending") {
        schedule(PENDING_POLL_SECONDS);
      }
      return;
    }
    // Decided: the booking with its record locator, tickets, documents and history, once. Polling does not start
    // again from that booking, which may still lag behind the ticketing answer for a moment; the answer says how it
    // ended.
    const reloaded = await reloadAll({ poll: false });
    if (reloaded && !destroyed) {
      status = next;
      renderBanner();
    }
  };

  /** Starts polling when the booking or its tickets are still moving. */
  const startPolling = () => {
    stopPolling();
    status = null;
    deadline = { phase: "", at: 0 };
    if (moving()) {
      poll().catch(report);
    }
  };

  // ---- Loading ------------------------------------------------------------------------------------------------

  /**
   * Reads the booking again (after a change, a conflict or a decided ticketing) and shows it, with its documents and
   * history. With `refresh`, the airline is asked first (an airline that does not answer gives the saved booking).
   * Resolves with the booking, or `null` when it could not be read (the page then shows why).
   * @param {{ refresh?: boolean }} [options]
   * @returns {Promise<Booking | null>}
   */
  const reloadBooking = async ({ refresh = false } = {}) => {
    if (bookingId === null) {
      return null;
    }
    const call = track();
    try {
      /** @type {Booking} */
      let next;
      try {
        next = await client.bookings.get(
          { bookingId, ...(refresh ? { refresh: true } : {}) },
          { signal: call.signal },
        );
      } catch (error) {
        if (!refresh || !pageStateFor(error).name.startsWith("supplier-")) {
          throw error;
        }
        next = await client.bookings.get({ bookingId }, { signal: call.signal });
      }
      if (destroyed) {
        return null;
      }
      booking = next;
      status = null;
      render();
      return next;
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return null;
      }
      const state = pageStateFor(error);
      if (state.name === "signed-out") {
        showLookup(true);
      } else if (state.name === "not-found") {
        showMissing(true);
      } else {
        showFailure(error, { onRetry: () => reloadAll().catch(report) });
      }
      return null;
    } finally {
      call.done();
    }
  };

  /**
   * The booking, its documents and its history again, and polling when it is still moving (unless `poll` is false).
   * @param {{ refresh?: boolean, poll?: boolean }} [options]
   */
  async function reloadAll({ refresh = false, poll: restart = true } = {}) {
    const next = await reloadBooking({ refresh });
    if (next && !destroyed) {
      if (restart) {
        startPolling();
      }
      await Promise.all([loadDocuments(), loadEvents()]);
    }
    return next;
  }

  /**
   * The first load: the booking, then its documents and history; polling when it is still moving.
   * @param {{ focus?: boolean }} [options]
   */
  const load = async ({ focus = false } = {}) => {
    if (bookingId === null) {
      return;
    }
    el.state.replaceChildren();
    el.content.hidden = true;
    el.loading.hidden = false;
    live.announce(t("booking.loading"));
    const call = track();
    try {
      booking = await client.bookings.get({ bookingId }, { signal: call.signal });
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (state.name === "signed-out") {
        showLookup(focus);
        return;
      }
      if (state.name === "not-found") {
        showMissing(focus);
        return;
      }
      const unexpected = state.name === "unexpected" || state.name === "validation";
      showPageState(unexpected ? { ...state, message: t("state.unexpected") } : state, {
        focus,
        requestId: unexpected ? requestIdOf(error) : null,
        ...(FINAL_STATES.has(state.name) ? {} : { onRetry: () => load({ focus: true }).catch(report) }),
      });
      return;
    } finally {
      call.done();
    }
    if (destroyed) {
      return;
    }
    render();
    live.announce(el.title.textContent ?? "");
    startPolling();
    await Promise.all([loadDocuments(), loadEvents()]);
    if (location.hash === "#documents") {
      /** @type {HTMLElement | null} */ (main.querySelector("#documents"))?.focus();
    }
  };

  // ---- Refresh from airline -----------------------------------------------------------------------------------

  const onRefresh = async () => {
    if (refreshing || bookingId === null || el.refresh.getAttribute("aria-disabled") === "true") {
      return;
    }
    refreshing = true;
    el.refresh.setAttribute("aria-disabled", "true");
    el.notice.replaceChildren();
    live.announce(t("booking.refreshing"));
    const call = track();
    try {
      booking = await client.bookings.get({ bookingId, refresh: true }, { signal: call.signal });
      if (destroyed) {
        return;
      }
      status = null;
      render();
      showSuccess(t("booking.refreshed"));
      startPolling();
      await Promise.all([loadDocuments(), loadEvents()]);
    } catch (error) {
      if (destroyed || isAborted(error)) {
        return;
      }
      const state = pageStateFor(error);
      if (state.name === "signed-out") {
        showLookup(true);
      } else if (state.name === "not-found") {
        showMissing(true);
      } else if (state.name.startsWith("supplier-")) {
        // The airline did not answer: the booking on the screen is the one saved last.
        showFailure(error, { message: t("booking.refreshFailed") });
      } else {
        showFailure(error);
      }
    } finally {
      call.done();
      refreshing = false;
      el.refresh.removeAttribute("aria-disabled");
    }
  };
  const onRefreshClick = () => {
    onRefresh().catch(report);
  };
  el.refresh.addEventListener("click", onRefreshClick);

  // ---- Change contact details ---------------------------------------------------------------------------------

  /** @param {string} name */
  const contactControl = (name) =>
    /** @type {HTMLInputElement} */ (el.contactsForm.querySelector(`[name="${name}"]`));
  const contactFields = {
    firstName: contactControl("contacts.0.addresseeName.firstName"),
    lastName: contactControl("contacts.0.addresseeName.lastName"),
    email: contactControl("contacts.0.emailAddress"),
    callingCode: contactControl("contacts.0.phones.0.countryCallingCode"),
    number: contactControl("contacts.0.phones.0.number"),
  };

  /** Opens the contacts dialog with the booking's primary contact. */
  const openContacts = () => {
    if (!booking || booking.allowedActions?.canModifyContacts !== true) {
      return;
    }
    const primary = primaryContactOf(list(booking.contacts));
    const phone = list(primary?.phones)[0];
    clearFieldErrors(el.contactsForm);
    el.contactsState.replaceChildren();
    contactFields.firstName.value = text(primary?.addresseeName?.firstName);
    contactFields.lastName.value = text(primary?.addresseeName?.lastName);
    contactFields.email.value = text(primary?.emailAddress);
    contactFields.callingCode.value = text(phone?.countryCallingCode);
    contactFields.number.value = text(phone?.number);
    if (!el.contactsDialog.open) {
      el.contactsDialog.showModal();
    }
    contactFields.firstName.focus();
  };
  const onOpenContacts = () => openContacts();
  el.changeContacts.addEventListener("click", onOpenContacts);

  /**
   * A message in the contacts dialog (a page state of src/boot.js), focused.
   * @param {Parameters<typeof renderState>[1]} state
   * @param {{ requestId?: string | null }} [options]
   */
  const contactsMessage = (state, { requestId = null } = {}) => {
    renderState(el.contactsState, state, { support, requestId, focus: true });
    live.announce(state.message);
  };

  /** Save: `bookings.update` with the whole contacts list and the version on the screen. */
  const saveContacts = () =>
    withSubmitState(el.contactsForm, async () => {
      if (!booking || bookingId === null) {
        return;
      }
      clearFieldErrors(el.contactsForm);
      el.contactsState.replaceChildren();
      const contacts = contactsUpdate(list(booking.contacts), {
        firstName: contactFields.firstName.value,
        lastName: contactFields.lastName.value,
        email: contactFields.email.value,
        callingCode: contactFields.callingCode.value,
        number: contactFields.number.value,
      });
      const call = track();
      try {
        const next = await client.bookings.update(
          { bookingId, ifMatch: booking.version, contacts },
          { signal: call.signal },
        );
        if (destroyed) {
          return;
        }
        booking = next;
        el.contactsDialog.close();
        render();
        const email = text(primaryContactOf(list(next.contacts))?.emailAddress);
        showSuccess(email !== "" ? t("booking.contactsSavedEmail", { email }) : t("booking.contactsSaved"));
        await loadEvents();
      } catch (error) {
        if (destroyed || isAborted(error)) {
          return;
        }
        const state = pageStateFor(error);
        if (state.name === "validation" && state.fieldErrors.length > 0) {
          showFieldErrors(el.contactsForm, state.fieldErrors);
          live.announce(t("state.validation"));
          return;
        }
        if (state.name === "stale") {
          // 409 VERSION_CONFLICT: the airline's order changed (reloaded from the airline); 412: the booking changed
          // here. What was typed stays; the next save uses the new version.
          const next = await reloadBooking({ refresh: state.code === "VERSION_CONFLICT" });
          if (next && next.allowedActions?.canModifyContacts === true) {
            contactsMessage({ name: "stale", scope: "inline", message: t("booking.contactsStale") });
            return;
          }
          el.contactsDialog.close();
          if (next) {
            showFailure(error, { message: t("booking.notModifiable") });
          }
          return;
        }
        if (
          state.code === "BOOKING_NOT_MODIFIABLE" ||
          state.code === "BOOKING_ALREADY_CANCELLED" ||
          state.name === "feature-disabled"
        ) {
          el.contactsDialog.close();
          const next = await reloadBooking();
          if (next) {
            showFailure(error, { message: t("booking.notModifiable") });
          }
          return;
        }
        if (state.name === "supplier-timeout") {
          // The airline may have applied it: the booking as it is recorded now.
          el.contactsDialog.close();
          const next = await reloadBooking();
          if (next) {
            showFailure(error, { message: t("booking.contactsTimeout") });
          }
          return;
        }
        if (state.name === "signed-out") {
          el.contactsDialog.close();
          showLookup(true);
          return;
        }
        const unexpected = state.name === "unexpected" || state.name === "validation";
        contactsMessage(unexpected ? { ...state, message: t("state.unexpected") } : state, {
          requestId: unexpected ? requestIdOf(error) : null,
        });
      } finally {
        call.done();
      }
    });
  /** @param {SubmitEvent} event */
  const onContactsSubmit = (event) => {
    event.preventDefault();
    saveContacts().catch(report);
  };
  /** @param {Event} event */
  const onContactsClick = (event) => {
    const target = /** @type {Element | null} */ (event.target);
    if (
      target?.closest?.('[data-action="close-dialog"]') &&
      !el.contactsForm.hasAttribute("data-submitting")
    ) {
      el.contactsDialog.close();
    }
  };
  /** Escape does not close the dialog while the change is on its way to the airline. */
  const onContactsCancel = (/** @type {Event} */ event) => {
    if (el.contactsForm.hasAttribute("data-submitting")) {
      event.preventDefault();
    }
  };
  el.contactsForm.addEventListener("submit", onContactsSubmit);
  el.contactsDialog.addEventListener("click", onContactsClick);
  el.contactsDialog.addEventListener("cancel", onContactsCancel);

  // ---- Cancel -------------------------------------------------------------------------------------------------

  const cancelDialog = mountCancelDialog(el.cancelDialog, {
    client,
    locale,
    timeZone,
    support,
    announce: live.announce,
    booking: () => booking,
    onResult(result) {
      if (destroyed) {
        return;
      }
      if (result?.booking) {
        booking = result.booking;
        status = null;
        render();
      }
      startPolling();
      Promise.all([loadDocuments(), loadEvents()]).catch(report);
    },
    reload: ({ refresh }) => reloadAll({ refresh }),
  });
  const onOpenCancel = () => {
    if (booking?.allowedActions?.canCancel === true) {
      cancelDialog.open();
    }
  };
  el.cancel.addEventListener("click", onOpenCancel);

  const done = (async () => {
    if (bookingId === null) {
      showMissing();
      return;
    }
    await load();
  })().catch(report);

  return {
    done,
    destroy() {
      destroyed = true;
      stopPolling();
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
      timeline.destroy();
      cancelDialog.destroy();
      offDownload();
      el.rules.removeEventListener("toggle", onRulesToggle);
      el.refresh.removeEventListener("click", onRefreshClick);
      el.changeContacts.removeEventListener("click", onOpenContacts);
      el.contactsForm.removeEventListener("submit", onContactsSubmit);
      el.contactsDialog.removeEventListener("click", onContactsClick);
      el.contactsDialog.removeEventListener("cancel", onContactsCancel);
      el.cancel.removeEventListener("click", onOpenCancel);
      if (el.contactsDialog.open) {
        el.contactsDialog.close();
      }
      if (el.cancelDialog.open) {
        el.cancelDialog.close();
      }
      live.clear();
    },
  };
}

document.documentElement.dataset.js = "on";

boot().then((context) => {
  try {
    start(
      /** @type {{ config: StorefrontConfig, client: PageClient, session: SessionInfo | null }} */ (
        /** @type {unknown} */ (context)
      ),
    );
  } catch (error) {
    report(error);
  }
});
