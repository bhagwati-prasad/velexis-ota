"use client";

// The interactive part of shopping on behalf `/shopping` (OAD-010; routes.md §6, OADR-0018 point 7): the two searches
// of the page's tabs, "Flight offers" (Flight Offers Search) and "Seat availability" (Flight Availabilities Search),
// and, for one offer of a search, its branded fares (Branded Fares Upsell) and a read-only confirmation of its price
// (Flight Offers Price), each through the page's server actions (actions.ts), which call the raw console operations of
// OBE-067 and nothing else: no customer-scope `flights.*` operation, no booking (`console.bookings.create` is
// deferred, the page says so). This module never imports the SDK's runtime or a server-only module.
//
// Every price here is an Amadeus **net** price, before the OTA's markup and fees: each column, heading and amount says
// so, and the page explains it above the tabs. The answers are shown as Amadeus gave them: a summary per offer (its
// flights in the airports' local times, fare, seats, last ticketing day and net total), the facts of the call (API,
// status, duration, office, Amadeus's request id and the call log entry) and the verbatim answer in a collapsed JSON
// view. An offer of a search or of an upsell answer goes back to the server action as Amadeus gave it, which is what
// Branded Fares Upsell and Flight Offers Price take.
//
// The forms keep their values as typed and send them as text; the action checks them as the API would and answers
// field errors by the forms' own names, shown on their inputs (`aria-describedby`), and Amadeus's own issues of a
// refusal. Only the searches carry an optional reason (kept in the audit trail with each raw read); an offer's branded
// fares and price confirmation reuse the reason of the search they came from. No input asks for a card, and every input
// has `autoComplete="off"`.
import type {
  ConsoleAmadeusAvailabilitiesResult,
  ConsoleAmadeusCall,
  ConsoleAmadeusFlightOffersResult,
  ConsoleAmadeusPricingResult,
  Schemas,
} from "@velexis/ota-sdk";
import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";

import { formatLocalTime } from "@/app/(console)/bookings/views";
import { JsonView } from "@/components/json-view";
import { Money } from "@/components/money";
import { toneClasses } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { INITIAL_ACTION_STATE, fieldError, type ActionState } from "@/lib/action-state";
import type { StaffEnvironment } from "@/lib/permissions";
import { cn } from "@/lib/utils";

import {
  quoteOffer,
  searchAvailability,
  searchOffers,
  upsellOffer,
  type AvailabilitySearchForm,
  type AvailabilityState,
  type OfferSearchForm,
  type OffersState,
  type QuoteState,
  type ShoppingState,
  type SupplierIssue,
  type UpsellState,
} from "./actions";

type FlightOffer = Schemas["AmadeusFlightOffer"];
type Segment = Schemas["AmadeusSegment"];
type Availability = Schemas["AmadeusFlightAvailability"];
type AvailabilitySegment = Schemas["AmadeusExtendedSegment"];
type AmadeusIssue = Schemas["AmadeusIssue"];
type Cabin = Schemas["AmadeusTravelClass"];

export const SHOPPING_STRINGS = Object.freeze({
  tabs: "Shopping",
  offersTab: "Flight offers",
  availabilityTab: "Seat availability",
  // The offer search
  offersForm: "Search flight offers",
  origin: "From",
  destination: "To",
  locationHint: "Airport or city code, like CDG or PAR.",
  departureDate: "Departure",
  returnDate: "Return",
  returnHint: "Empty for a one-way trip.",
  adults: "Adults",
  children: "Children (2 to 11)",
  infants: "Infants on a lap",
  cabin: "Cabin",
  anyCabin: "Any cabin",
  nonStop: "Non-stop flights only",
  carriers: "Airlines",
  carriersHint: "Two-character codes, like AF KL. Empty for every airline.",
  currency: "Currency",
  currencyHint: "Empty for the office's currency.",
  reason: "Reason (optional)",
  reasonHint: "Kept in the audit trail with each Amadeus read of this search.",
  searchOffers: "Search offers",
  asking: "Asking Amadeus…",
  // The availability search
  availabilityForm: "Search seat availability",
  date: "Day",
  time: "From time",
  timeHint: "Local time, like 09:30. Empty for the whole day.",
  seats: "Seats",
  bookingClass: "Booking class",
  bookingClassHint: "One letter, like Y. Empty for every class.",
  includeClosed: "Include closed classes, departed and cancelled flights",
  searchAvailability: "Search availability",
  // Answers
  requestId: "Request id",
  amadeusIssues: "What Amadeus said",
  warnings: "Amadeus warnings",
  offersFound: (count: number) => `${count} offer${count === 1 ? "" : "s"} (net prices)`,
  noOffers: "Amadeus found no offer for this search.",
  offersCaption: "Flight offers with their Amadeus net totals",
  flightsFound: (count: number) => `${count} flight option${count === 1 ? "" : "s"}`,
  noFlights: "Amadeus found no flight for this search.",
  availabilityCaption: "Flights with their seats per booking class",
  classesLegend:
    "Seats per booking class: a digit is the seats Amadeus sells in one booking (9 means 9 or more); L is a waitlist that is open, C a waitlist that is closed, R a class on request.",
  verbatimOffers: "Amadeus answer (verbatim, net prices)",
  verbatimAvailability: "Amadeus answer (verbatim)",
  call: (call: ConsoleAmadeusCall) =>
    [
      `Amadeus ${call.amadeusApi}`,
      `HTTP ${call.httpStatus}`,
      `${call.durationMs} ms`,
      `office ${call.officeId ?? "none"}`,
      `Amadeus request id ${call.correlationId ?? "none"}`,
      `call log ${call.supplierRequestId}`,
    ].join(" · "),
  columns: {
    offer: "Offer",
    flights: "Flights",
    fare: "Fare",
    seats: "Seats",
    lastTicketing: "Last ticketing day",
    net: "Net total",
    actions: "Actions",
  },
  availabilityColumns: {
    option: "Option",
    flight: "Flight",
    from: "From",
    to: "To",
    aircraft: "Aircraft",
    classes: "Seats per class",
  },
  option: (index: number) => `Option ${index + 1}`,
  operatedBy: (carrier: string) => `operated by ${carrier}`,
  nonStopFlight: "Non-stop",
  connections: (count: number) => `${count} connection${count === 1 ? "" : "s"}`,
  unknown: "Unknown",
  noCheckedBag: "No checked bag",
  checkedBags: (count: number) => `${count} checked bag${count === 1 ? "" : "s"}`,
  checkedWeight: (weight: number, unit: string) => `Checked bags up to ${weight} ${unit}`,
  classOf: (code: string) => `class ${code}`,
  // An offer's branded fares and price
  fareRules: "Confirm prices with the detailed fare rules (a slower answer)",
  brandedFares: "Branded fares",
  confirmPrice: "Confirm price",
  workingOn: (id: string, route: string) => `Offer ${id}: ${route}`,
  workingHint:
    "Branded fares and the confirmed price come from Amadeus as net prices, before the markup and fees. Nothing is booked or held.",
  upsellHeading: "Branded fares (net prices)",
  noUpsell: "Amadeus has no other branded fare for this offer.",
  upsellCaption: "Branded fares of the offer with their Amadeus net totals",
  upsellColumns: { brand: "Branded fare", cabin: "Cabin and class", bags: "Bags", net: "Net total" },
  quoteHeading: (id: string) => `Confirmed price of offer ${id} (net)`,
  priceConfirmed: "Amadeus confirms the net price:",
  priceChanged: "The net price changed:",
  priceWas: "was",
  priceNow: "now",
  requirements: "What a booking of it needs",
  noRequirements: "Amadeus names no particular booking data.",
  traveler: (id: string) => `Traveller ${id}`,
  bagOptions: "Bag options (net prices)",
  bag: "Bag",
  fareRulesView: "Detailed fare rules (verbatim)",
  verbatimUpsell: "Amadeus branded fares answer (verbatim, net prices)",
  verbatimQuote: "Amadeus price answer (verbatim, net prices)",
});

const CABIN_LABELS: Readonly<Record<Cabin, string>> = Object.freeze({
  ECONOMY: "Economy",
  PREMIUM_ECONOMY: "Premium economy",
  BUSINESS: "Business",
  FIRST: "First",
});

const CLOSED_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  WAITLIST_OPEN: "L",
  WAITLIST_CLOSED: "C",
  ON_REQUEST: "R",
});

const SEGMENT_CLOSED: Readonly<Record<string, string>> = Object.freeze({
  CANCELLED: "Cancelled",
  DEPARTED: "Departed",
  NOT_AVAILABLE: "Not available",
});

/** The booking data an order of the offer needs (`bookingRequirements`), in words. */
const REQUIREMENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  emailAddressRequired: "An e-mail address",
  mobilePhoneNumberRequired: "A mobile phone number",
  phoneNumberRequired: "A phone number",
  phoneCountryCodeRequired: "The phone's country code",
  postalCodeRequired: "A postal code",
  invoiceAddressRequired: "An invoice address",
  mailingAddressRequired: "A mailing address",
});

/** What each traveller needs (`bookingRequirements.travelerRequirements`), in words. */
const TRAVELER_REQUIREMENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  genderRequired: "gender",
  dateOfBirthRequired: "date of birth",
  documentRequired: "identity document",
  documentIssuanceCityRequired: "the document's city of issue",
  residenceRequired: "residence",
  redressRequiredIfAny: "redress number, if any",
  airFranceDiscountRequired: "Air France discount",
  spanishResidentDiscountRequired: "Spanish resident discount",
});

const MUTED = "text-sm text-muted-foreground";

// ---- Small pieces ---------------------------------------------------------------------------------------------------

/** A text field of a submitted form, or empty. */
function valueOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The state whose field errors a form shows: a failure's, else none. */
function errorsOf(state: ShoppingState<unknown> | undefined): ActionState {
  return state === undefined || state.ok ? INITIAL_ACTION_STATE : state;
}

/** `aria-describedby` and `aria-invalid` of an input with an optional hint and an optional error. */
function describedBy(hintId: string | undefined, errorId: string, error: string | undefined) {
  const ids = [hintId, error === undefined ? undefined : errorId].filter(
    (id): id is string => id !== undefined,
  );
  return {
    ...(ids.length === 0 ? {} : { "aria-describedby": ids.join(" ") }),
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };
}

interface FieldProps {
  /** The form field's name: a key of the action's form type. */
  readonly name: string;
  readonly label: string;
  /** The form's last state: the field shows its error. */
  readonly state: ActionState;
  readonly hint?: string;
  readonly className?: string;
}

/** A text, date, time or number input with its label, hint and error. */
function InputField({
  name,
  label,
  state,
  hint,
  className,
  type = "text",
  defaultValue,
  required = false,
  maxLength,
  min,
  max,
  placeholder,
  codes = false,
}: FieldProps & {
  readonly type?: "text" | "date" | "time" | "number";
  readonly defaultValue?: string;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly placeholder?: string;
  /** Codes in capitals (airports, airlines, currencies, classes). */
  readonly codes?: boolean;
}) {
  const id = useId();
  const error = fieldError(state, name);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete="off"
        spellCheck={false}
        required={required}
        {...(defaultValue === undefined ? {} : { defaultValue })}
        {...(maxLength === undefined ? {} : { maxLength })}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(codes ? { autoCapitalize: "characters", className: "font-mono uppercase" } : {})}
        {...describedBy(hintId, `${id}-error`, error)}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A native select with its label and error. */
function SelectField({
  name,
  label,
  state,
  hint,
  className,
  choices,
}: FieldProps & { readonly choices: readonly { readonly value: string; readonly label: string }[] }) {
  const id = useId();
  const error = fieldError(state, name);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        name={name}
        defaultValue={choices[0]?.value ?? ""}
        autoComplete="off"
        className="flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
        {...describedBy(hintId, `${id}-error`, error)}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A checkbox that posts `true` when ticked. */
function CheckField({
  name,
  label,
  className,
}: {
  readonly name: string;
  readonly label: string;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <input
        id={id}
        type="checkbox"
        name={name}
        value="true"
        autoComplete="off"
        className="size-4 accent-primary"
      />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

/** A refused or failed call: the message, Amadeus's issues and the request id. */
function Failure({ state }: { readonly state: ShoppingState<unknown> | undefined }) {
  if (state === undefined || state.ok) {
    return null;
  }
  const issues = state.supplierIssues ?? [];
  return (
    <div role="alert" className="grid gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm">
      <p className="font-medium">{state.message}</p>
      {issues.length === 0 ? null : (
        <div className="grid gap-0.5">
          <p>{SHOPPING_STRINGS.amadeusIssues}:</p>
          <ul className="list-disc pl-5">
            {/* By position: two issues of one answer may read the same. */}
            {issues.map((issue, index) => (
              <li key={index}>{issueText(issue)}</li>
            ))}
          </ul>
        </div>
      )}
      {state.requestId === undefined ? null : (
        <p className="text-muted-foreground">
          {SHOPPING_STRINGS.requestId}: <code>{state.requestId}</code>
        </p>
      )}
    </div>
  );
}

/** One Amadeus issue as a line: its code, title and detail, and where in the request it was. */
function issueText(issue: SupplierIssue | AmadeusIssue): string {
  const code = typeof issue.code === "number" ? String(issue.code) : undefined;
  const words = [issue.title, issue.detail].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  const source =
    "source" in issue && typeof issue.source === "string"
      ? issue.source
      : typeof issue.source === "object"
        ? (issue.source.pointer ?? issue.source.parameter)
        : undefined;
  const text = [code, words.join(": ")].filter((part) => part !== undefined && part !== "").join(" ");
  return source === undefined || source === "" ? text : `${text} (${source})`;
}

/** Amadeus's warnings of an answer. */
function Warnings({ warnings }: { readonly warnings: readonly AmadeusIssue[] | undefined }) {
  const lines = (warnings ?? []).map(issueText).filter((line) => line !== "");
  if (lines.length === 0) {
    return null;
  }
  return (
    <div role="note" className={cn("grid gap-1 rounded-md px-3 py-2 text-sm", toneClasses("warning"))}>
      <p className="font-medium">{SHOPPING_STRINGS.warnings}</p>
      <ul className="list-disc pl-5">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** The facts of the Amadeus call behind an answer. */
function CallFacts({ call }: { readonly call: ConsoleAmadeusCall }) {
  return (
    <p className="text-xs text-muted-foreground" data-call={call.supplierRequestId}>
      {SHOPPING_STRINGS.call(call)}
    </p>
  );
}

/** A net amount of Amadeus (`grandTotal` or `total` with its currency), or "Unknown". */
function NetAmount({
  amount,
  currency,
}: {
  readonly amount: string | undefined;
  readonly currency: string | undefined;
}) {
  if (amount === undefined || currency === undefined) {
    return <span className="text-muted-foreground">{SHOPPING_STRINGS.unknown}</span>;
  }
  return <Money value={{ amount, currency }} className="font-medium" />;
}

/** The net total of an offer: its `grandTotal` (else `total`) and currency. */
function netOf(offer: FlightOffer): {
  readonly amount: string | undefined;
  readonly currency: string | undefined;
} {
  return { amount: offer.price?.grandTotal ?? offer.price?.total, currency: offer.price?.currency };
}

/** A decimal string without the zeros that change nothing (`98.470` → `98.47`, `98.00` → `98`). */
function canonicalAmount(amount: string): string {
  const [whole = "", fraction = ""] = amount.split(".");
  const kept = fraction.replace(/0+$/, "");
  return kept === "" ? whole : `${whole}.${kept}`;
}

/** An ISO 8601 duration of Amadeus (`PT2H5M`, `P1DT2H`) in words (`2 h 5 min`); the value itself when unreadable. */
function formatDuration(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value);
  if (match === null) {
    return value;
  }
  const hours = Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const parts = [hours > 0 ? `${hours} h` : "", minutes > 0 ? `${minutes} min` : ""].filter(
    (part) => part !== "",
  );
  return parts.length === 0 ? "0 min" : parts.join(" ");
}

/** A segment's flight: `IB 3436`, with the operating airline when it is another. */
function flightOf(segment: Segment): string {
  const flight = `${segment.carrierCode ?? ""} ${segment.number ?? ""}`.trim();
  const operating = segment.operating?.carrierCode;
  return operating !== undefined && operating !== segment.carrierCode
    ? `${flight} (${SHOPPING_STRINGS.operatedBy(operating)})`
    : flight;
}

/** A local time of an airport, or "Unknown". */
function localTime(at: string | undefined): string {
  return at === undefined ? SHOPPING_STRINGS.unknown : formatLocalTime(at);
}

/** The route of an offer: its airports in order, each itinerary on its own (`MAD → ORY · ORY → MAD`). */
function routeOf(offer: FlightOffer): string {
  return (offer.itineraries ?? [])
    .map((itinerary) => {
      const airports = itinerary.segments.map((segment) => segment.departure?.iataCode ?? "?");
      const last = itinerary.segments.at(-1)?.arrival?.iataCode;
      return [...airports, ...(last === undefined ? [] : [last])].join(" → ");
    })
    .join(" · ");
}

/** The flights of an offer, an itinerary per line group. */
function Itineraries({ offer }: { readonly offer: FlightOffer }) {
  return (
    <div className="grid gap-2">
      {(offer.itineraries ?? []).map((itinerary, index) => {
        const connections = itinerary.segments.length - 1;
        return (
          // By position: an itinerary has no id of its own.
          <div key={index} className="grid gap-0.5">
            {itinerary.segments.map((segment, at) => (
              <p key={segment.id ?? at} className="whitespace-nowrap">
                <span className="font-mono">{flightOf(segment)}</span> {segment.departure?.iataCode}{" "}
                <time dateTime={segment.departure?.at}>{localTime(segment.departure?.at)}</time> →{" "}
                {segment.arrival?.iataCode}{" "}
                <time dateTime={segment.arrival?.at}>{localTime(segment.arrival?.at)}</time>
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              {[
                formatDuration(itinerary.duration),
                connections <= 0 ? SHOPPING_STRINGS.nonStopFlight : SHOPPING_STRINGS.connections(connections),
              ]
                .filter((part): part is string => part !== undefined)
                .join(" · ")}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** The checked bags of an offer's first traveller on its first segment, in words, or `undefined`. */
function bagsOf(offer: FlightOffer): string | undefined {
  const bags = offer.travelerPricings?.[0]?.fareDetailsBySegment[0]?.includedCheckedBags;
  if (bags === undefined) {
    return undefined;
  }
  if (typeof bags.weight === "number" && bags.weight > 0) {
    return SHOPPING_STRINGS.checkedWeight(bags.weight, bags.weightUnit ?? "KG");
  }
  return typeof bags.quantity === "number" && bags.quantity > 0
    ? SHOPPING_STRINGS.checkedBags(bags.quantity)
    : SHOPPING_STRINGS.noCheckedBag;
}

/** The fare of an offer's first traveller: cabin, branded fare, booking classes and checked bags. */
function fareOf(offer: FlightOffer): string {
  const details = offer.travelerPricings?.[0]?.fareDetailsBySegment ?? [];
  const unique = (values: (string | undefined)[]) => [
    ...new Set(values.filter((value): value is string => value !== undefined && value !== "")),
  ];
  const cabins = unique(
    details.map((detail) => (detail.cabin === undefined ? undefined : CABIN_LABELS[detail.cabin])),
  );
  const brands = unique(details.map((detail) => detail.brandedFareLabel ?? detail.brandedFare));
  const classes = unique(details.map((detail) => detail.class));
  const parts = [
    cabins.join(", "),
    brands.join(", "),
    classes.length === 0 ? "" : SHOPPING_STRINGS.classOf(classes.join(", ")),
    bagsOf(offer) ?? "",
  ].filter((part) => part !== "");
  return parts.length === 0 ? SHOPPING_STRINGS.unknown : parts.join(" · ");
}

// ---- Flight offers ------------------------------------------------------------------------------------------------------

/** The search form of the offers tab. */
function OfferSearchFields({
  state,
  defaultCurrency,
}: {
  readonly state: ActionState;
  readonly defaultCurrency: string;
}) {
  const cabins = [
    { value: "", label: SHOPPING_STRINGS.anyCabin },
    ...(Object.entries(CABIN_LABELS) as [Cabin, string][]).map(([value, label]) => ({ value, label })),
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <InputField
        name="origin"
        label={SHOPPING_STRINGS.origin}
        hint={SHOPPING_STRINGS.locationHint}
        state={state}
        required
        maxLength={3}
        codes
      />
      <InputField
        name="destination"
        label={SHOPPING_STRINGS.destination}
        hint={SHOPPING_STRINGS.locationHint}
        state={state}
        required
        maxLength={3}
        codes
      />
      <InputField
        name="departureDate"
        label={SHOPPING_STRINGS.departureDate}
        type="date"
        state={state}
        required
      />
      <InputField
        name="returnDate"
        label={SHOPPING_STRINGS.returnDate}
        hint={SHOPPING_STRINGS.returnHint}
        type="date"
        state={state}
      />
      <InputField
        name="adults"
        label={SHOPPING_STRINGS.adults}
        type="number"
        state={state}
        defaultValue="1"
        min={1}
        max={9}
        required
      />
      <InputField
        name="children"
        label={SHOPPING_STRINGS.children}
        type="number"
        state={state}
        defaultValue="0"
        min={0}
        max={8}
      />
      <InputField
        name="infants"
        label={SHOPPING_STRINGS.infants}
        type="number"
        state={state}
        defaultValue="0"
        min={0}
        max={9}
      />
      <SelectField name="cabin" label={SHOPPING_STRINGS.cabin} state={state} choices={cabins} />
      <InputField
        name="carriers"
        label={SHOPPING_STRINGS.carriers}
        hint={SHOPPING_STRINGS.carriersHint}
        state={state}
        maxLength={40}
        codes
      />
      <InputField
        name="currency"
        label={SHOPPING_STRINGS.currency}
        hint={SHOPPING_STRINGS.currencyHint}
        state={state}
        defaultValue={defaultCurrency}
        maxLength={3}
        codes
      />
      <InputField
        name="reason"
        label={SHOPPING_STRINGS.reason}
        hint={SHOPPING_STRINGS.reasonHint}
        state={state}
        maxLength={500}
        className="sm:col-span-2"
      />
      <CheckField name="nonStop" label={SHOPPING_STRINGS.nonStop} className="self-center sm:col-span-2" />
    </div>
  );
}

/** The offer staff work on: the search's offer, its branded fares and the last price confirmation. */
interface WorkingOffer {
  readonly offer: FlightOffer;
  readonly upsell?: UpsellState;
  /** The offer that was priced (the search's or one of its branded fares) and the answer. */
  readonly quote?: { readonly offer: FlightOffer; readonly state: QuoteState };
}

/** What runs for the offer staff work on. */
type Running = "upsell" | "quote" | undefined;

/** The offers tab: the form, the offers of the last search and the offer staff work on. */
function OffersPanel({ defaultCurrency }: { readonly defaultCurrency: string }) {
  const [state, setState] = useState<OffersState | undefined>(undefined);
  // The reason of the search the shown offers came from: their branded fares and prices carry it too.
  const [reason, setReason] = useState("");
  const [searching, startSearch] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input: OfferSearchForm = {
      origin: valueOf(form, "origin"),
      destination: valueOf(form, "destination"),
      departureDate: valueOf(form, "departureDate"),
      returnDate: valueOf(form, "returnDate"),
      adults: valueOf(form, "adults"),
      children: valueOf(form, "children"),
      infants: valueOf(form, "infants"),
      cabin: valueOf(form, "cabin"),
      nonStop: valueOf(form, "nonStop") === "true",
      carriers: valueOf(form, "carriers"),
      currency: valueOf(form, "currency"),
      reason: valueOf(form, "reason"),
    };
    startSearch(async () => {
      const next = await searchOffers(input);
      setState(next);
      if (next.ok) {
        setReason(input.reason.trim());
      }
    });
  }

  return (
    <div className="grid gap-6">
      <form onSubmit={onSubmit} aria-label={SHOPPING_STRINGS.offersForm} className="grid gap-4">
        <OfferSearchFields state={errorsOf(state)} defaultCurrency={defaultCurrency} />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={searching} aria-busy={searching}>
            {searching ? SHOPPING_STRINGS.asking : SHOPPING_STRINGS.searchOffers}
          </Button>
        </div>
      </form>
      <Failure state={state} />
      {state?.ok === true ? (
        // A new search starts afresh: no offer of the last one stays the one staff work on.
        <OffersResult key={state.result.call.supplierRequestId} result={state.result} reason={reason} />
      ) : null}
    </div>
  );
}

/** The offers of a search, the offer staff work on, and the verbatim answer. */
function OffersResult({
  result,
  reason,
}: {
  readonly result: ConsoleAmadeusFlightOffersResult;
  readonly reason: string;
}) {
  const id = useId();
  const [working, setWorking] = useState<WorkingOffer | undefined>(undefined);
  const [running, setRunning] = useState<Running>(undefined);
  const [fareRules, setFareRules] = useState(false);
  const [pending, startCall] = useTransition();
  const offers = result.amadeus.data;

  function showFares(offer: FlightOffer): void {
    setWorking({ offer });
    setRunning("upsell");
    startCall(async () => {
      const upsell = await upsellOffer({ offer, reason });
      setWorking((current) => (current?.offer === offer ? { ...current, upsell } : current));
      setRunning(undefined);
    });
  }

  function confirmPrice(offer: FlightOffer, base: FlightOffer): void {
    setWorking((current) =>
      current?.offer === base
        ? { offer: base, ...(current.upsell === undefined ? {} : { upsell: current.upsell }) }
        : { offer: base },
    );
    setRunning("quote");
    startCall(async () => {
      const state = await quoteOffer({ offer, reason, fareRules });
      setWorking((current) => (current?.offer === base ? { ...current, quote: { offer, state } } : current));
      setRunning(undefined);
    });
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-4">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="text-xl font-semibold">
          {SHOPPING_STRINGS.offersFound(offers.length)}
        </h2>
        <CallFacts call={result.call} />
      </div>
      <Warnings warnings={result.amadeus.warnings} />
      {offers.length === 0 ? (
        <p role="status">{SHOPPING_STRINGS.noOffers}</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              id={`${id}-fare-rules`}
              type="checkbox"
              autoComplete="off"
              checked={fareRules}
              onChange={(event) => setFareRules(event.currentTarget.checked)}
              className="size-4 accent-primary"
            />
            <Label htmlFor={`${id}-fare-rules`}>{SHOPPING_STRINGS.fareRules}</Label>
          </div>
          <Table>
            <TableCaption className="sr-only">{SHOPPING_STRINGS.offersCaption}</TableCaption>
            <TableHeader>
              <TableRow>
                {Object.values(SHOPPING_STRINGS.columns).map((column) => (
                  <TableHead key={column} scope="col">
                    {column}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {offers.map((offer) => (
                <TableRow
                  key={offer.id}
                  data-offer={offer.id}
                  className={working?.offer === offer ? "ring-2 ring-primary ring-inset" : undefined}
                >
                  <TableCell className="font-mono">{offer.id}</TableCell>
                  <TableCell>
                    <Itineraries offer={offer} />
                  </TableCell>
                  <TableCell className="min-w-48 whitespace-normal">
                    {fareOf(offer)}
                    {offer.validatingAirlineCodes === undefined ? null : (
                      <span className="block text-xs text-muted-foreground">
                        {offer.validatingAirlineCodes.join(", ")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{offer.numberOfBookableSeats ?? SHOPPING_STRINGS.unknown}</TableCell>
                  <TableCell>{offer.lastTicketingDate ?? SHOPPING_STRINGS.unknown}</TableCell>
                  <TableCell>
                    <NetAmount {...netOf(offer)} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => showFares(offer)}
                      >
                        {SHOPPING_STRINGS.brandedFares}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={pending}
                        onClick={() => confirmPrice(offer, offer)}
                      >
                        {SHOPPING_STRINGS.confirmPrice}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      {working === undefined ? null : (
        <WorkingPanel
          working={working}
          running={pending ? running : undefined}
          onConfirm={(offer) => confirmPrice(offer, working.offer)}
          disabled={pending}
        />
      )}
      <JsonView value={result.amadeus} label={SHOPPING_STRINGS.verbatimOffers} />
    </section>
  );
}

/** The offer staff work on: its branded fares and its confirmed price, as each answer arrives. */
function WorkingPanel({
  working,
  running,
  onConfirm,
  disabled,
}: {
  readonly working: WorkingOffer;
  readonly running: Running;
  readonly onConfirm: (offer: FlightOffer) => void;
  readonly disabled: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-4 rounded-xl border p-4 shadow-sm">
      <div className="grid gap-1">
        <h3 id={`${id}-heading`} className="text-lg font-semibold">
          {SHOPPING_STRINGS.workingOn(working.offer.id, routeOf(working.offer))}
        </h3>
        <p className={MUTED}>{SHOPPING_STRINGS.workingHint}</p>
      </div>
      <p aria-live="polite" className={MUTED}>
        {running === undefined ? "" : SHOPPING_STRINGS.asking}
      </p>
      {working.upsell === undefined ? null : (
        <UpsellResult state={working.upsell} onConfirm={onConfirm} disabled={disabled} />
      )}
      {working.quote === undefined ? null : (
        <QuoteResult offer={working.quote.offer} state={working.quote.state} />
      )}
    </section>
  );
}

/** The branded fares of an offer, each with "Confirm price". */
function UpsellResult({
  state,
  onConfirm,
  disabled,
}: {
  readonly state: UpsellState;
  readonly onConfirm: (offer: FlightOffer) => void;
  readonly disabled: boolean;
}) {
  const id = useId();
  if (!state.ok) {
    return <Failure state={state} />;
  }
  const { result } = state;
  const fares = result.amadeus.data;
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-3">
      <div className="grid gap-1">
        <h4 id={`${id}-heading`} className="text-base font-semibold">
          {SHOPPING_STRINGS.upsellHeading}
        </h4>
        <CallFacts call={result.call} />
      </div>
      <Warnings warnings={result.amadeus.warnings} />
      {fares.length === 0 ? (
        <p role="status">{SHOPPING_STRINGS.noUpsell}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{SHOPPING_STRINGS.upsellCaption}</TableCaption>
          <TableHeader>
            <TableRow>
              {[...Object.values(SHOPPING_STRINGS.upsellColumns), SHOPPING_STRINGS.columns.actions].map(
                (column) => (
                  <TableHead key={column} scope="col">
                    {column}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {fares.map((fare) => {
              const detail = fare.travelerPricings?.[0]?.fareDetailsBySegment[0];
              return (
                <TableRow key={fare.id} data-fare={fare.id}>
                  <TableCell className="font-medium">
                    {detail?.brandedFareLabel ?? detail?.brandedFare ?? SHOPPING_STRINGS.unknown}
                  </TableCell>
                  <TableCell>
                    {[
                      detail?.cabin === undefined ? undefined : CABIN_LABELS[detail.cabin],
                      detail?.class === undefined ? undefined : SHOPPING_STRINGS.classOf(detail.class),
                    ]
                      .filter((part): part is string => part !== undefined)
                      .join(" · ") || SHOPPING_STRINGS.unknown}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {bagsOf(fare) ?? SHOPPING_STRINGS.unknown}
                  </TableCell>
                  <TableCell>
                    <NetAmount {...netOf(fare)} />
                  </TableCell>
                  <TableCell>
                    <Button type="button" size="sm" disabled={disabled} onClick={() => onConfirm(fare)}>
                      {SHOPPING_STRINGS.confirmPrice}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <JsonView value={result.amadeus} label={SHOPPING_STRINGS.verbatimUpsell} />
    </section>
  );
}

/** The booking data a priced offer needs, in words. */
function requirementsOf(result: ConsoleAmadeusPricingResult): string[] {
  const requirements = result.amadeus.data.bookingRequirements;
  if (requirements === undefined) {
    return [];
  }
  const lines = Object.entries(REQUIREMENT_LABELS)
    .filter(([key]) => (requirements as Record<string, unknown>)[key] === true)
    .map(([, label]) => label);
  for (const traveler of requirements.travelerRequirements ?? []) {
    const needs = Object.entries(TRAVELER_REQUIREMENT_LABELS)
      .filter(([key]) => (traveler as Record<string, unknown>)[key] === true)
      .map(([, label]) => label);
    if (needs.length > 0) {
      lines.push(`${SHOPPING_STRINGS.traveler(traveler.travelerId ?? "?")}: ${needs.join(", ")}`);
    }
  }
  return lines;
}

/** The bag options of a price answer (`included.bags`), each with its net price. */
function BagOptions({ result }: { readonly result: ConsoleAmadeusPricingResult }) {
  const bags = Object.entries(result.amadeus.included?.bags ?? {});
  if (bags.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-1">
      <h5 className="text-sm font-medium">{SHOPPING_STRINGS.bagOptions}</h5>
      <ul className="grid gap-0.5 text-sm">
        {bags.map(([key, bag]) => {
          const size = [
            typeof bag.quantity === "number" ? `${bag.quantity} ×` : undefined,
            typeof bag.weight === "number" ? `${bag.weight} ${bag.weightUnit ?? "KG"}` : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(" ");
          return (
            <li key={key}>
              {[bag.name ?? SHOPPING_STRINGS.bag, size].filter((part) => part !== "").join(", ")}:{" "}
              <NetAmount amount={bag.price?.amount} currency={bag.price?.currencyCode} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The confirmed price of an offer: the net total (and how it changed), what a booking needs, bags and fare rules. */
function QuoteResult({ offer, state }: { readonly offer: FlightOffer; readonly state: QuoteState }) {
  const id = useId();
  if (!state.ok) {
    return <Failure state={state} />;
  }
  const { result } = state;
  const confirmed =
    result.amadeus.data.flightOffers.find((priced) => priced.id === offer.id) ??
    result.amadeus.data.flightOffers[0];
  const before = netOf(offer);
  const after = confirmed === undefined ? { amount: undefined, currency: undefined } : netOf(confirmed);
  const changed =
    before.amount !== undefined &&
    after.amount !== undefined &&
    (canonicalAmount(before.amount) !== canonicalAmount(after.amount) || before.currency !== after.currency);
  const requirements = requirementsOf(result);
  const fareRules = result.amadeus.included?.["detailed-fare-rules"];
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-3">
      <div className="grid gap-1">
        <h4 id={`${id}-heading`} className="text-base font-semibold">
          {SHOPPING_STRINGS.quoteHeading(offer.id)}
        </h4>
        <CallFacts call={result.call} />
      </div>
      <Warnings warnings={result.amadeus.warnings} />
      {changed ? (
        <p
          role="note"
          className={cn("rounded-md px-3 py-2 text-sm", toneClasses("warning"))}
          data-price="changed"
        >
          {SHOPPING_STRINGS.priceChanged} {SHOPPING_STRINGS.priceWas} <NetAmount {...before} />,{" "}
          {SHOPPING_STRINGS.priceNow} <NetAmount {...after} />.
        </p>
      ) : (
        <p className="text-sm" data-price="confirmed">
          {SHOPPING_STRINGS.priceConfirmed} <NetAmount {...after} />.
        </p>
      )}
      {confirmed?.lastTicketingDate === undefined ? null : (
        <p className="text-sm">
          {SHOPPING_STRINGS.columns.lastTicketing}: {confirmed.lastTicketingDate}
        </p>
      )}
      <div className="grid gap-1">
        <h5 className="text-sm font-medium">{SHOPPING_STRINGS.requirements}</h5>
        {requirements.length === 0 ? (
          <p className={MUTED}>{SHOPPING_STRINGS.noRequirements}</p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {requirements.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>
      <BagOptions result={result} />
      {fareRules === undefined ? null : <JsonView value={fareRules} label={SHOPPING_STRINGS.fareRulesView} />}
      <JsonView value={result.amadeus} label={SHOPPING_STRINGS.verbatimQuote} />
    </section>
  );
}

// ---- Seat availability --------------------------------------------------------------------------------------------------

/** The search form of the availability tab. */
function AvailabilitySearchFields({ state }: { readonly state: ActionState }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <InputField
        name="origin"
        label={SHOPPING_STRINGS.origin}
        hint={SHOPPING_STRINGS.locationHint}
        state={state}
        required
        maxLength={3}
        codes
      />
      <InputField
        name="destination"
        label={SHOPPING_STRINGS.destination}
        hint={SHOPPING_STRINGS.locationHint}
        state={state}
        required
        maxLength={3}
        codes
      />
      <InputField name="date" label={SHOPPING_STRINGS.date} type="date" state={state} required />
      <InputField
        name="time"
        label={SHOPPING_STRINGS.time}
        hint={SHOPPING_STRINGS.timeHint}
        type="time"
        state={state}
      />
      <InputField
        name="seats"
        label={SHOPPING_STRINGS.seats}
        type="number"
        state={state}
        defaultValue="1"
        min={1}
        max={9}
        required
      />
      <InputField
        name="carriers"
        label={SHOPPING_STRINGS.carriers}
        hint={SHOPPING_STRINGS.carriersHint}
        state={state}
        maxLength={40}
        codes
      />
      <InputField
        name="bookingClass"
        label={SHOPPING_STRINGS.bookingClass}
        hint={SHOPPING_STRINGS.bookingClassHint}
        state={state}
        maxLength={1}
        codes
      />
      <InputField
        name="reason"
        label={SHOPPING_STRINGS.reason}
        hint={SHOPPING_STRINGS.reasonHint}
        state={state}
        maxLength={500}
      />
      <CheckField
        name="includeClosed"
        label={SHOPPING_STRINGS.includeClosed}
        className="sm:col-span-2 lg:col-span-4"
      />
    </div>
  );
}

/** The seats of a segment per booking class (`J2 Y9 L`), or the segment's closed status. */
function classesOf(segment: AvailabilitySegment): string {
  if (segment.closedStatus !== undefined) {
    return SEGMENT_CLOSED[segment.closedStatus] ?? segment.closedStatus;
  }
  const classes = (segment.availabilityClasses ?? []).map((entry) => {
    const code = entry.class ?? "?";
    const closed = entry.closedStatus === undefined ? undefined : CLOSED_LETTERS[entry.closedStatus];
    return `${code}${closed ?? String(entry.numberOfBookableSeats ?? 0)}`;
  });
  return classes.length === 0 ? SHOPPING_STRINGS.unknown : classes.join(" ");
}

/** The availability tab: the form and the flights of the last search. */
function AvailabilityPanel() {
  const [state, setState] = useState<AvailabilityState | undefined>(undefined);
  const [searching, startSearch] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input: AvailabilitySearchForm = {
      origin: valueOf(form, "origin"),
      destination: valueOf(form, "destination"),
      date: valueOf(form, "date"),
      time: valueOf(form, "time"),
      seats: valueOf(form, "seats"),
      carriers: valueOf(form, "carriers"),
      bookingClass: valueOf(form, "bookingClass"),
      includeClosed: valueOf(form, "includeClosed") === "true",
      reason: valueOf(form, "reason"),
    };
    startSearch(async () => {
      setState(await searchAvailability(input));
    });
  }

  return (
    <div className="grid gap-6">
      <form onSubmit={onSubmit} aria-label={SHOPPING_STRINGS.availabilityForm} className="grid gap-4">
        <AvailabilitySearchFields state={errorsOf(state)} />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={searching} aria-busy={searching}>
            {searching ? SHOPPING_STRINGS.asking : SHOPPING_STRINGS.searchAvailability}
          </Button>
        </div>
      </form>
      <Failure state={state} />
      {state?.ok === true ? <AvailabilityResult result={state.result} /> : null}
    </div>
  );
}

/** The flights of an availability search, a row per segment. */
function AvailabilityResult({ result }: { readonly result: ConsoleAmadeusAvailabilitiesResult }) {
  const id = useId();
  const options: readonly Availability[] = result.amadeus.data;
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-4">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="text-xl font-semibold">
          {SHOPPING_STRINGS.flightsFound(options.length)}
        </h2>
        <CallFacts call={result.call} />
      </div>
      <Warnings warnings={result.amadeus.warnings} />
      {options.length === 0 ? (
        <p role="status">{SHOPPING_STRINGS.noFlights}</p>
      ) : (
        <>
          <p className={MUTED}>{SHOPPING_STRINGS.classesLegend}</p>
          <Table>
            <TableCaption className="sr-only">{SHOPPING_STRINGS.availabilityCaption}</TableCaption>
            <TableHeader>
              <TableRow>
                {Object.values(SHOPPING_STRINGS.availabilityColumns).map((column) => (
                  <TableHead key={column} scope="col">
                    {column}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {options.flatMap((option, index) =>
                option.segments.map((segment, at) => (
                  <TableRow key={`${option.id}-${segment.id ?? at}`} data-option={option.id}>
                    <TableCell className={at === 0 ? "font-medium" : "text-muted-foreground"}>
                      {at === 0 ? SHOPPING_STRINGS.option(index) : ""}
                    </TableCell>
                    <TableCell className="font-mono">{flightOf(segment)}</TableCell>
                    <TableCell>
                      {segment.departure?.iataCode}{" "}
                      <time dateTime={segment.departure?.at}>{localTime(segment.departure?.at)}</time>
                    </TableCell>
                    <TableCell>
                      {segment.arrival?.iataCode}{" "}
                      <time dateTime={segment.arrival?.at}>{localTime(segment.arrival?.at)}</time>
                    </TableCell>
                    <TableCell>{segment.aircraft?.code ?? SHOPPING_STRINGS.unknown}</TableCell>
                    <TableCell className="font-mono">{classesOf(segment)}</TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </>
      )}
      <JsonView value={result.amadeus} label={SHOPPING_STRINGS.verbatimAvailability} />
    </section>
  );
}

// ---- The console ----------------------------------------------------------------------------------------------------------

export interface ShoppingConsoleProps {
  /** The environment the calls run in (the shell's switch); the page names it above the tabs. */
  readonly environment: StaffEnvironment;
  /** The OTA's default currency, which the offer search asks Amadeus for unless staff change it. */
  readonly defaultCurrency: string;
}

/**
 * The two searches as tabs. Both stay mounted while the other is shown (`forceMount`), so switching tabs keeps what was
 * typed and found.
 */
export function ShoppingConsole({ environment, defaultCurrency }: ShoppingConsoleProps): ReactNode {
  return (
    <Tabs defaultValue="offers" className="gap-4" data-environment={environment}>
      <TabsList aria-label={SHOPPING_STRINGS.tabs}>
        <TabsTrigger value="offers">{SHOPPING_STRINGS.offersTab}</TabsTrigger>
        <TabsTrigger value="availability">{SHOPPING_STRINGS.availabilityTab}</TabsTrigger>
      </TabsList>
      <TabsContent value="offers" forceMount className="data-[state=inactive]:hidden">
        <OffersPanel defaultCurrency={defaultCurrency} />
      </TabsContent>
      <TabsContent value="availability" forceMount className="data-[state=inactive]:hidden">
        <AvailabilityPanel />
      </TabsContent>
    </Tabs>
  );
}
