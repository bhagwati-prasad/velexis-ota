// The server actions of shopping on behalf `/shopping` (OAD-010; routes.md §6, OADR-0018 point 7, README §7): staff
// answering a caller search, compare and quote with the raw, read-only console operations of OBE-067, each through the
// SDK's console namespace with the client `requireStaff` hands back (the staff token of the request, the service key,
// the environment of the switch, the end-user headers).
//
// Every shopping call sends its request once: the four actions' client has `maxRetries: 0` (`SHOPPING_RETRIES`, a
// client-level SDK option), so a call that timed out at Amadeus (`504 SUPPLIER_TIMEOUT` after the API's 30 s) or met a
// `503` or `429` is not sent to Amadeus again behind the staff member's back: they read "Search again" (or "Try again")
// and decide. The SDK would otherwise retry these POSTs (`x-idempotent-by-design`) twice, up to three Amadeus calls and
// minutes of waiting for one click. The searches since lead decision (2d) of 2026-10-30 (FIX-W34-OTA), the Branded Fares
// upsell and the price confirmation of one offer since lead decision (2b) of 2026-10-30, second batch (FIX-W35-OTA).
// Every other action of the admin keeps the SDK's default retries.
//
//   searchOffers         console.amadeus.searchFlightOffers          Flight Offers Search POST
//   searchAvailability   console.amadeus.searchFlightAvailabilities  Flight Availabilities Search (seats per class)
//   upsellOffer          console.amadeus.upsellAirOffers             Branded Fares Upsell of one offer
//   quoteOffer           console.amadeus.quoteAirOffers              Flight Offers Price of one offer (a read-only quote)
//
// Every one needs `amadeus:read` (owner, admin, agent) and starts with `requireStaff("amadeus:read")`, so a forged POST
// from another role is refused before any call; the API decides and audits all the same (each raw read is an audited
// read, `amadeus.<operationId>` in staff_actions with the request's optional `reason`). The prices they answer are
// Amadeus **net** prices, before the OTA's markup and fees: the page labels them so, and nothing here passes them to a
// customer. Nothing is booked: booking on behalf waits for `console.bookings.create` (deferred, scope §3.4), so no action
// here writes anything or carries an idempotency key (the four reads are idempotent by design).
//
// The admin never calls a customer-scope operation (`flights.*`, `/v1/flight-searches`, …): the service key is
// console-only (OADR-0011), and a second key with customer scope would widen what a leaked admin credential can do
// (OADR-0018 point 7, "Alternatives considered").
//
// A server action is a public endpoint, so each one checks what it gets as the API would before any call: the search
// forms' values (airports and cities as IATA codes, real days, travellers, carriers, a booking class, the reason) with
// Zod, the field errors keyed by the form's own names; an offer for the upsell or the quote must be an Amadeus flight
// offer (`type`, `id`) of a sane size, which the client got from a search or an upsell answer of this page and posts
// back as Amadeus gave it. The API's answers become the action's state, never `error.tsx` (README §7, routes.md §1): the
// message of lib/errors.ts or this page's words, the request id, the API's field errors on the form's fields, and
// Amadeus's own issues of a `422 SUPPLIER_REJECTED` (`details.errors`, console scope, already redacted by the API),
// which tell staff what Amadeus did not accept. Only redirects (an ended session) and bugs are thrown. No action
// revalidates a path: nothing changed, and a re-render of the page would only read the markup rules again.
"use server";

import type {
  ConsoleAmadeusAvailabilitiesResult,
  ConsoleAmadeusFlightOffer,
  ConsoleAmadeusFlightOffersResult,
  ConsoleAmadeusPricingInclude,
  ConsoleAmadeusPricingResult,
  ConsoleAmadeusSearchFlightAvailabilitiesParams,
  ConsoleAmadeusSearchFlightOffersParams,
  ConsoleAmadeusUpsellResult,
  Schemas,
} from "@velexis/ota-sdk";
import { z } from "zod";

import { isCalendarDay } from "@/app/(console)/bookings/views";
import { fromZod, type ActionState, type FieldErrors } from "@/lib/action-state";
import {
  GENERIC_ERROR_MESSAGE,
  fromVelexisError,
  isVelexisErrorLike,
  type VelexisErrorLike,
} from "@/lib/errors";
import { requireStaff, type StaffClientOptions, type StaffContext } from "@/lib/session";

// ---- What the page sends and gets ------------------------------------------------------------------------------------

/** The offer search form's values as typed (results.tsx); the action parses them. */
export interface OfferSearchForm {
  /** Airport or city of departure (IATA, `PAR` or `CDG`). */
  readonly origin: string;
  /** Airport or city of arrival. */
  readonly destination: string;
  /** Day of departure, `YYYY-MM-DD` (local to the airport). */
  readonly departureDate: string;
  /** Day of the return flight, or empty for a one-way trip. */
  readonly returnDate: string;
  /** Adults (12 and over), 1 to 9. */
  readonly adults: string;
  /** Children (2 to 11), 0 to 8. */
  readonly children: string;
  /** Infants on a lap, at most one per adult. */
  readonly infants: string;
  /** A cabin (`ECONOMY`, `PREMIUM_ECONOMY`, `BUSINESS`, `FIRST`), or empty for any. */
  readonly cabin: string;
  /** Non-stop flights only. */
  readonly nonStop: boolean;
  /** Airlines to keep, two-character codes separated by spaces or commas; empty for every airline. */
  readonly carriers: string;
  /** The currency of the prices (ISO 4217), or empty for the office's. */
  readonly currency: string;
  /** Why staff search (kept in the audit trail), or empty. */
  readonly reason: string;
}

/** The seat availability form's values as typed (results.tsx); the action parses them. */
export interface AvailabilitySearchForm {
  readonly origin: string;
  readonly destination: string;
  /** Day of departure, `YYYY-MM-DD`. */
  readonly date: string;
  /** Departure from this local time (`HH:MM`), or empty for the whole day. */
  readonly time: string;
  /** Seats wanted, 1 to 9. */
  readonly seats: string;
  /** Airlines to keep, as in the offer search; empty for every airline. */
  readonly carriers: string;
  /** One booking class (`Y`), or empty for every class. */
  readonly bookingClass: string;
  /** Show closed classes, departed and cancelled flights too. */
  readonly includeClosed: boolean;
  readonly reason: string;
}

/** An offer of this page's answers (a search or an upsell), posted back as Amadeus gave it. */
export interface OfferRequest {
  readonly offer: unknown;
  /** The reason of the search the offer came from, or empty. */
  readonly reason: string;
}

/** The read-only quote of an offer. */
export interface QuoteRequest extends OfferRequest {
  /** Ask Amadeus for the detailed fare rules too (`include=detailed-fare-rules`). */
  readonly fareRules: boolean;
}

/** One issue of Amadeus's answer (`AmadeusIssue`), as the API passes it to the console. */
export interface SupplierIssue {
  readonly code?: number;
  readonly title?: string;
  readonly detail?: string;
  /** Where in the request Amadeus found it (`source.pointer` or `source.parameter`). */
  readonly source?: string;
}

/** A refused or failed call (or form): `ActionState`, and Amadeus's own issues when it refused. */
export interface ShoppingFailure extends ActionState {
  readonly ok: false;
  readonly supplierIssues?: readonly SupplierIssue[];
}

/** A call that answered: the verbatim Amadeus answer with the call's facts, as the SDK resolved it. */
export interface ShoppingSuccess<Result> {
  readonly ok: true;
  readonly result: Result;
}

/** What an action answers. */
export type ShoppingState<Result> = ShoppingSuccess<Result> | ShoppingFailure;

export type OffersState = ShoppingState<ConsoleAmadeusFlightOffersResult>;
export type AvailabilityState = ShoppingState<ConsoleAmadeusAvailabilitiesResult>;
export type UpsellState = ShoppingState<ConsoleAmadeusUpsellResult>;
export type QuoteState = ShoppingState<ConsoleAmadeusPricingResult>;

// ---- Limits and messages ---------------------------------------------------------------------------------------------

/** The most offers a search asks Amadeus for (`searchCriteria.maxFlightOffers`). */
const MAX_OFFERS = 50;
/** Travellers who take a seat (Amadeus: at most 9 older than two). */
const MAX_SEATED = 9;
/** The most airlines a filter keeps. */
const MAX_CARRIERS = 10;
/** The longest reason the console operations take (`maxLength: 500`). */
const REASON_MAX = 500;
/** The largest offer an upsell or a quote posts back, as JSON characters (an offer is a few kilobytes). */
const OFFER_MAX_CHARACTERS = 200_000;
/** The SDK timeout of these calls: the API gives Amadeus 30 s for a shopping call (OBE-067) and needs a moment more. */
const SHOPPING_TIMEOUT_MS = 60_000;
/** The most Amadeus issues a failure lists. */
const MAX_ISSUES = 10;
/**
 * The automatic retries of every shopping call's client: none, so a timed-out search, upsell or price confirmation
 * reaches Amadeus once (FIX-W34-OTA for the searches, FIX-W35-OTA for the upsell and the price confirmation).
 */
const SHOPPING_RETRIES = 0;

const CABINS = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] as const;

const STRINGS = Object.freeze({
  location: "Enter a three-letter airport or city code, like CDG or PAR.",
  sameLocation: "Enter a destination other than the origin.",
  day: "Enter a day as YYYY-MM-DD.",
  returnBefore: "The return cannot be before the departure.",
  adults: `Enter 1 to ${MAX_SEATED} adults.`,
  children: `Enter 0 to ${MAX_SEATED - 1} children.`,
  infants: "Enter at most one infant per adult.",
  seated: `At most ${MAX_SEATED} travellers can take a seat (adults and children).`,
  seats: `Enter 1 to ${MAX_SEATED} seats.`,
  cabin: "Choose a cabin, or any.",
  carriers: `Enter up to ${MAX_CARRIERS} two-character airline codes, like AF KL.`,
  currency: "Enter a three-letter currency code, like EUR, or leave it empty.",
  time: "Enter a time as HH:MM, or leave it empty.",
  bookingClass: "Enter one letter, like Y, or leave it empty.",
  reason: `Use at most ${REASON_MAX} characters.`,
  staleOffer: "This offer cannot be sent to Amadeus as it is. Search again.",
  // The API's answers, in the words of this page.
  rejectedSearch: "Amadeus refused the search.",
  rejectedOffer: "Amadeus refused this offer. It may have sold out or changed: search again.",
  searchTimeout: "Amadeus did not answer in time. Search again.",
  offerTimeout: "Amadeus did not answer in time. Try again.",
});

// ---- Form values -------------------------------------------------------------------------------------------------------

/** A trimmed text, in capitals. */
const upper = (value: unknown): unknown => (typeof value === "string" ? value.trim().toUpperCase() : value);
/** A trimmed text. */
const trimmed = (value: unknown): unknown => (typeof value === "string" ? value.trim() : value);
/** An empty or blank text is no value. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** A text of the form, with `message` when it is missing or not a text. */
const text = (message: string) => z.string({ required_error: message, invalid_type_error: message });

/** A three-letter IATA airport or city code. */
const Location = z.preprocess(upper, text(STRINGS.location).regex(/^[A-Z]{3}$/, STRINGS.location));
/** A real calendar day, `YYYY-MM-DD`. */
const Day = z.preprocess(
  trimmed,
  text(STRINGS.day).refine((value) => isCalendarDay(value), STRINGS.day),
);
/** A whole number from `min` to `max`, typed as digits; an empty field is `empty` when given. */
const count = (min: number, max: number, message: string, empty?: number) =>
  z.preprocess(
    (value) => {
      const typed = trimmed(value);
      return typed === "" && empty !== undefined ? String(empty) : typed;
    },
    text(message)
      .regex(/^[0-9]{1,2}$/, message)
      .transform(Number)
      .refine((value) => value >= min && value <= max, message),
  );
/** Airline codes separated by spaces or commas, in capitals, at most 10 and each once. */
const Carriers = z.preprocess(
  (value) => (value === undefined ? "" : upper(value)),
  text(STRINGS.carriers)
    .max(MAX_CARRIERS * 4, STRINGS.carriers)
    .transform((value) => [...new Set(value.split(/[\s,]+/).filter((code) => code !== ""))])
    .refine(
      (codes) => codes.length <= MAX_CARRIERS && codes.every((code) => /^[A-Z0-9]{2}$/.test(code)),
      STRINGS.carriers,
    ),
);
/** The staff action's reason: at most 500 characters after trimming, counted as the API counts (code points). */
const Reason = z.preprocess(
  (value) => (value === undefined ? "" : trimmed(value)),
  text(STRINGS.reason).refine((value) => [...value].length <= REASON_MAX, STRINGS.reason),
);

const OfferSearchSchema = z
  .object({
    origin: Location,
    destination: Location,
    departureDate: Day,
    returnDate: z.preprocess(blankToUndefined, Day.optional()),
    adults: count(1, MAX_SEATED, STRINGS.adults),
    children: count(0, MAX_SEATED - 1, STRINGS.children, 0),
    infants: count(0, MAX_SEATED, STRINGS.infants, 0),
    cabin: z.preprocess(
      (value) => blankToUndefined(upper(value)),
      z.enum(CABINS, { errorMap: () => ({ message: STRINGS.cabin }) }).optional(),
    ),
    nonStop: z.boolean(),
    carriers: Carriers,
    currency: z.preprocess(
      (value) => blankToUndefined(upper(value)),
      z
        .string()
        .regex(/^[A-Z]{3}$/, STRINGS.currency)
        .optional(),
    ),
    reason: Reason,
  })
  .superRefine((form, context) => {
    if (form.destination === form.origin) {
      context.addIssue({ code: "custom", path: ["destination"], message: STRINGS.sameLocation });
    }
    // Days as `YYYY-MM-DD` compare as text.
    if (form.returnDate !== undefined && form.returnDate < form.departureDate) {
      context.addIssue({ code: "custom", path: ["returnDate"], message: STRINGS.returnBefore });
    }
    if (form.infants > form.adults) {
      context.addIssue({ code: "custom", path: ["infants"], message: STRINGS.infants });
    }
    if (form.adults + form.children > MAX_SEATED) {
      context.addIssue({ code: "custom", path: ["children"], message: STRINGS.seated });
    }
  });

type OfferSearchValues = z.infer<typeof OfferSearchSchema>;

const AvailabilitySearchSchema = z
  .object({
    origin: Location,
    destination: Location,
    date: Day,
    time: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/, STRINGS.time)
        .optional(),
    ),
    seats: count(1, MAX_SEATED, STRINGS.seats),
    carriers: Carriers,
    bookingClass: z.preprocess(
      (value) => blankToUndefined(upper(value)),
      z
        .string()
        .regex(/^[A-Z]$/, STRINGS.bookingClass)
        .optional(),
    ),
    includeClosed: z.boolean(),
    reason: Reason,
  })
  .superRefine((form, context) => {
    if (form.destination === form.origin) {
      context.addIssue({ code: "custom", path: ["destination"], message: STRINGS.sameLocation });
    }
  });

type AvailabilitySearchValues = z.infer<typeof AvailabilitySearchSchema>;

/**
 * An Amadeus flight offer as a search or an upsell answered it: an object with `type` `flight-offer` and an `id`; the
 * API checks the rest against the Amadeus schema.
 */
const OfferSchema = z
  .object({ type: z.literal("flight-offer"), id: z.string().min(1).max(64) })
  .passthrough()
  .refine((offer) => {
    try {
      return JSON.stringify(offer).length <= OFFER_MAX_CHARACTERS;
    } catch {
      return false;
    }
  });

const OfferRequestSchema = z.object({ offer: OfferSchema, reason: Reason });
const QuoteRequestSchema = OfferRequestSchema.extend({ fareRules: z.boolean() });

// ---- Bodies --------------------------------------------------------------------------------------------------------------

/** The optional `reason` of a body: absent when blank. */
function reasonOf(reason: string): { readonly reason?: string } {
  return reason === "" ? {} : { reason };
}

/** The search's travellers: the adults, the children, then each infant on the lap of an adult (by position). */
function travelersOf(values: OfferSearchValues): Schemas["AmadeusExtendedTravelerInfo"][] {
  const travelers: Schemas["AmadeusExtendedTravelerInfo"][] = [];
  const add = (travelerType: Schemas["AmadeusTravelerType"], associatedAdultId?: string) => {
    travelers.push({
      id: String(travelers.length + 1),
      travelerType,
      ...(associatedAdultId === undefined ? {} : { associatedAdultId }),
    });
  };
  for (let index = 0; index < values.adults; index += 1) {
    add("ADULT");
  }
  for (let index = 0; index < values.children; index += 1) {
    add("CHILD");
  }
  for (let index = 0; index < values.infants; index += 1) {
    // The adults are the first travellers, so adult `index + 1` holds infant `index`.
    add("HELD_INFANT", String(index + 1));
  }
  return travelers;
}

/** The Flight Offers Search POST body of the offer search form (the getFlightOffersQuery, sent verbatim). */
function offersParams(values: OfferSearchValues): ConsoleAmadeusSearchFlightOffersParams {
  const legs: Schemas["AmadeusOriginDestination"][] = [
    {
      id: "1",
      originLocationCode: values.origin,
      destinationLocationCode: values.destination,
      departureDateTimeRange: { date: values.departureDate },
    },
  ];
  if (values.returnDate !== undefined) {
    legs.push({
      id: "2",
      originLocationCode: values.destination,
      destinationLocationCode: values.origin,
      departureDateTimeRange: { date: values.returnDate },
    });
  }
  const legIds = legs.map((_, index) => String(index + 1));
  const filters: NonNullable<Schemas["AmadeusSearchCriteria"]["flightFilters"]> = {
    ...(values.cabin === undefined
      ? {}
      : {
          cabinRestrictions: [
            { cabin: values.cabin, coverage: "MOST_SEGMENTS", originDestinationIds: legIds },
          ],
        }),
    ...(values.carriers.length === 0
      ? {}
      : { carrierRestrictions: { includedCarrierCodes: values.carriers } }),
    ...(values.nonStop ? { connectionRestriction: { maxNumberOfConnections: 0 } } : {}),
  };
  return {
    amadeus: {
      ...(values.currency === undefined ? {} : { currencyCode: values.currency }),
      originDestinations: legs,
      travelers: travelersOf(values),
      sources: ["GDS"],
      searchCriteria: {
        maxFlightOffers: MAX_OFFERS,
        // Amadeus's default, written out (the document's type requires it): no upsell offers in the search's answer;
        // an offer's branded fares come from "Branded fares" (Branded Fares Upsell).
        maxUpsellOffers: 0,
        ...(Object.keys(filters).length === 0 ? {} : { flightFilters: filters }),
      },
    },
    ...reasonOf(values.reason),
  };
}

/** The Flight Availabilities Search body of the seat availability form. */
function availabilityParams(
  values: AvailabilitySearchValues,
): ConsoleAmadeusSearchFlightAvailabilitiesParams {
  const criteria: Schemas["AmadeusExtendedSearchCriteria"] = {
    ...(values.includeClosed ? { includeClosedContent: true } : {}),
    ...(values.bookingClass === undefined ? {} : { class: values.bookingClass }),
    ...(values.carriers.length === 0
      ? {}
      : { flightFilters: { carrierRestrictions: { includedCarrierCodes: values.carriers } } }),
  };
  return {
    amadeus: {
      originDestinations: [
        {
          id: "1",
          originLocationCode: values.origin,
          destinationLocationCode: values.destination,
          departureDateTime: {
            date: values.date,
            ...(values.time === undefined ? {} : { time: `${values.time}:00` }),
          },
        },
      ],
      travelers: Array.from({ length: values.seats }, (_, index) => ({
        id: String(index + 1),
        travelerType: "ADULT" as const,
      })),
      sources: ["GDS"],
      ...(Object.keys(criteria).length === 0 ? {} : { searchCriteria: criteria }),
    },
    ...reasonOf(values.reason),
  };
}

/** What Amadeus's include of the quote asks for: bag options always, the detailed fare rules when asked. */
function quoteIncludeOf(fareRules: boolean): ConsoleAmadeusPricingInclude {
  return fareRules ? ["bags", "detailed-fare-rules"] : ["bags"];
}

// ---- Failures --------------------------------------------------------------------------------------------------------

/** The API's pointers (as lib/errors.ts derives field names from them) → the offer search form's fields. */
const OFFER_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  "amadeus.originDestinations.0.originLocationCode": "origin",
  "amadeus.originDestinations.0.destinationLocationCode": "destination",
  "amadeus.originDestinations.0.departureDateTimeRange.date": "departureDate",
  "amadeus.originDestinations.1.departureDateTimeRange.date": "returnDate",
  "amadeus.currencyCode": "currency",
  "amadeus.searchCriteria.flightFilters.carrierRestrictions.includedCarrierCodes": "carriers",
  "amadeus.searchCriteria.flightFilters.cabinRestrictions": "cabin",
  "amadeus.travelers": "adults",
  reason: "reason",
});

/** The API's pointers → the seat availability form's fields. */
const AVAILABILITY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  "amadeus.originDestinations.0.originLocationCode": "origin",
  "amadeus.originDestinations.0.destinationLocationCode": "destination",
  "amadeus.originDestinations.0.departureDateTime.date": "date",
  "amadeus.originDestinations.0.departureDateTime.time": "time",
  "amadeus.searchCriteria.flightFilters.carrierRestrictions.includedCarrierCodes": "carriers",
  "amadeus.searchCriteria.class": "bookingClass",
  "amadeus.travelers": "seats",
  reason: "reason",
});

/**
 * `fieldErrors` with the names of `fields`: a name that is a key or starts with a key and a dot (a list's item,
 * `…includedCarrierCodes.1`, `amadeus.travelers.0.id`) becomes the form's field; the first message of a field wins.
 */
function onFormFields(
  fieldErrors: FieldErrors | undefined,
  fields: Readonly<Record<string, string>>,
): FieldErrors {
  const result: Record<string, string> = {};
  for (const [name, message] of Object.entries(fieldErrors ?? {})) {
    const key = Object.keys(fields).find(
      (candidate) => name === candidate || name.startsWith(`${candidate}.`),
    );
    const field = key === undefined ? name : (fields[key] ?? name);
    if (!Object.hasOwn(result, field)) {
      result[field] = message;
    }
  }
  return Object.freeze(result);
}

/** A string of an object, if it has one. */
function textOf(value: unknown, name: string): string | undefined {
  const field =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

/** Amadeus's issues of a supplier error: `details.errors` (console scope), else the first one in `error.supplier`. */
function supplierIssuesOf(error: VelexisErrorLike): SupplierIssue[] {
  const listed = error.details?.["errors"];
  const { supplier } = error as { readonly supplier?: unknown };
  const issues: unknown[] = Array.isArray(listed) ? listed : supplier === undefined ? [] : [supplier];
  return issues
    .filter((issue): issue is Record<string, unknown> => typeof issue === "object" && issue !== null)
    .slice(0, MAX_ISSUES)
    .map((issue) => {
      const code = issue["code"];
      const source = issue["source"];
      const where = textOf(source, "pointer") ?? textOf(source, "parameter");
      const title = textOf(issue, "title");
      const detail = textOf(issue, "detail");
      return {
        ...(typeof code === "number" && Number.isInteger(code) ? { code } : {}),
        ...(title === undefined ? {} : { title }),
        ...(detail === undefined ? {} : { detail }),
        ...(where === undefined ? {} : { source: where }),
      };
    })
    .filter((issue) => Object.keys(issue).length > 0);
}

/** How a failure reads on this page: the search form's or an offer's. */
interface FailureWords {
  readonly rejected: string;
  readonly timeout: string;
  readonly fields: Readonly<Record<string, string>>;
}

const SEARCH_WORDS: FailureWords = {
  rejected: STRINGS.rejectedSearch,
  timeout: STRINGS.searchTimeout,
  fields: {},
};
const OFFER_WORDS: FailureWords = {
  rejected: STRINGS.rejectedOffer,
  timeout: STRINGS.offerTimeout,
  fields: {},
};

/**
 * The state of a failed call: lib/errors.ts's message, request id and field errors (on the form's fields), this page's
 * words for Amadeus's refusal and timeout, and Amadeus's own issues. Redirects and bugs are thrown again.
 */
function failure(error: unknown, words: FailureWords): ShoppingFailure {
  const base = fromVelexisError(error);
  if (!isVelexisErrorLike(error)) {
    return { ...base, ok: false };
  }
  const fieldErrors = onFormFields(base.fieldErrors, words.fields);
  const message =
    error.code === "SUPPLIER_REJECTED"
      ? words.rejected
      : error.code === "SUPPLIER_TIMEOUT"
        ? words.timeout
        : (base.message ?? GENERIC_ERROR_MESSAGE);
  const issues = error.code.startsWith("SUPPLIER_") ? supplierIssuesOf(error) : [];
  return {
    ...base,
    ok: false,
    message,
    ...(Object.keys(fieldErrors).length === 0 ? {} : { fieldErrors }),
    ...(issues.length === 0 ? {} : { supplierIssues: Object.freeze(issues) }),
  };
}

/** The state of a form that failed its schema. */
function invalid(error: z.ZodError): ShoppingFailure {
  return { ...fromZod(error), ok: false };
}

/** The state of an offer that is not one of this page's (a stale page, or a forged POST). */
function staleOffer(): ShoppingFailure {
  return { ok: false, code: "VALIDATION_FAILED", message: STRINGS.staleOffer };
}

/**
 * The staff context of an action, or the state of its refusal (a missing permission, a refused session); `options`
 * builds its console client (every shopping call: `maxRetries: 0`).
 */
async function shopper(
  options: StaffClientOptions = {},
): Promise<{ readonly context: StaffContext } | { readonly state: ShoppingFailure }> {
  try {
    return { context: await requireStaff("amadeus:read", options) };
  } catch (error) {
    return { state: { ...fromVelexisError(error), ok: false } };
  }
}

// ---- The actions -------------------------------------------------------------------------------------------------------

/**
 * "Search" of the offers tab: Flight Offers Search POST (`console.amadeus.searchFlightOffers`) for the form's trip,
 * travellers, cabin, non-stop, airlines and currency, from the GDS, at most 50 offers. Net prices. Sent once (no
 * automatic retry).
 */
export async function searchOffers(form: OfferSearchForm): Promise<OffersState> {
  const staff = await shopper({ maxRetries: SHOPPING_RETRIES });
  if ("state" in staff) {
    return staff.state;
  }
  const parsed = OfferSearchSchema.safeParse(form);
  if (!parsed.success) {
    return invalid(parsed.error);
  }
  try {
    const result = await staff.context.console.amadeus.searchFlightOffers(offersParams(parsed.data), {
      timeoutMs: SHOPPING_TIMEOUT_MS,
    });
    return { ok: true, result };
  } catch (error) {
    return failure(error, { ...SEARCH_WORDS, fields: OFFER_FIELDS });
  }
}

/**
 * "Search" of the seat availability tab: Flight Availabilities Search (`console.amadeus.searchFlightAvailabilities`),
 * the open booking classes and their seats on the flights of one day, from the GDS. Sent once (no automatic retry).
 */
export async function searchAvailability(form: AvailabilitySearchForm): Promise<AvailabilityState> {
  const staff = await shopper({ maxRetries: SHOPPING_RETRIES });
  if ("state" in staff) {
    return staff.state;
  }
  const parsed = AvailabilitySearchSchema.safeParse(form);
  if (!parsed.success) {
    return invalid(parsed.error);
  }
  try {
    const result = await staff.context.console.amadeus.searchFlightAvailabilities(
      availabilityParams(parsed.data),
      { timeoutMs: SHOPPING_TIMEOUT_MS },
    );
    return { ok: true, result };
  } catch (error) {
    return failure(error, { ...SEARCH_WORDS, fields: AVAILABILITY_FIELDS });
  }
}

/**
 * "Branded fares" of an offer: Branded Fares Upsell (`console.amadeus.upsellAirOffers`) of the one offer, as the search
 * answered it. Net prices. Sent once (no automatic retry).
 */
export async function upsellOffer(request: OfferRequest): Promise<UpsellState> {
  const staff = await shopper({ maxRetries: SHOPPING_RETRIES });
  if ("state" in staff) {
    return staff.state;
  }
  const parsed = OfferRequestSchema.safeParse(request);
  if (!parsed.success) {
    return staleOffer();
  }
  // The schema checked the offer's `type` and `id`; the API checks the rest against the Amadeus schema.
  const offer = parsed.data.offer as unknown as Schemas["AmadeusFlightOffer"];
  try {
    const result = await staff.context.console.amadeus.upsellAirOffers(
      {
        amadeus: { data: { type: "flight-offer-upsell", flightOffers: [offer] } },
        ...reasonOf(parsed.data.reason),
      },
      { timeoutMs: SHOPPING_TIMEOUT_MS },
    );
    return { ok: true, result };
  } catch (error) {
    return failure(error, OFFER_WORDS);
  }
}

/**
 * "Confirm price" of an offer: Flight Offers Price (`console.amadeus.quoteAirOffers`) of the one offer, with its bag
 * options and, when asked, the detailed fare rules. A read-only quote: nothing is stored or booked. Net prices. Sent
 * once (no automatic retry).
 */
export async function quoteOffer(request: QuoteRequest): Promise<QuoteState> {
  const staff = await shopper({ maxRetries: SHOPPING_RETRIES });
  if ("state" in staff) {
    return staff.state;
  }
  const parsed = QuoteRequestSchema.safeParse(request);
  if (!parsed.success) {
    return staleOffer();
  }
  // As for the upsell: the API checks the offer against the Amadeus schema.
  const offer = parsed.data.offer as unknown as ConsoleAmadeusFlightOffer;
  try {
    const result = await staff.context.console.amadeus.quoteAirOffers(
      {
        include: quoteIncludeOf(parsed.data.fareRules),
        amadeus: { data: { type: "flight-offer-pricing", flightOffers: [offer] } },
        ...reasonOf(parsed.data.reason),
      },
      { timeoutMs: SHOPPING_TIMEOUT_MS },
    );
    return { ok: true, result };
  } catch (error) {
    return failure(error, OFFER_WORDS);
  }
}
