// The markup and fee rules of the OTA admin's settings (OAD-013; routes.md §9, api-changes part 2 §2.1 and §2.2,
// OADR-0005 points 3–7): what the six pages, the shared form (pricing-rule-form.tsx) and the server actions
// (pricing-actions.ts) share. A `"use server"` module may export only async functions, and server code cannot read
// the constants of a `"use client"` module (they reach it as client references), so the field names, the choices
// and their labels, the Zod mirrors of `MarkupRuleInput` / `FeeRuleInput`, the request bodies and the texts of a rule
// live here, in a module without a directive that imports no server-only module and of the SDK only types (OADR-0018
// point 1), as `bookings/[bookingId]/action-rules.ts` and `pnr/import-rules.ts` do for their pages.
//
// The form posts flat fields named after the request body's JSON pointers (`fixed.amount`, `scope.origins`), so the
// API's field errors land on the field that caused them (lib/errors.ts turns `/scope/origins/3` into `scope.origins.3`,
// which `ruleFieldOf` folds into `scope.origins`). One `currency` field holds the currency of the fixed amount and of
// both caps, which the API requires to be one. The validity window is typed in the OTA's time zone
// (`datetime-local`), and the server action turns it into instants with the time zone of `console.auth.me`.
//
// An update sends only what changed (`updateBodyOf`): the form posts the rule as the page rendered it (`original`, the
// body of `ruleBodyOfRule`), and every field whose value the form changed goes into the `PATCH` (`scope` as a whole),
// so a rule edited in one field is written in that field only, and a form sent unchanged makes no call.
//
// The default markup rule always matches (OADR-0005 point 3, revised 2026-10-30; lead decision (2e), FIX-W34-OTA): its
// scope stays `{}`, it stays active with no validity window and keeps priority 1000, and the API answers `409 CONFLICT`
// `default_rule` to a change of any of them. Its form has no inputs for them (it shows them read-only) and posts the
// marker `defaultRule`; the action reads them from `original` (`withDefaultRuleValues`) and never sends them
// (`withoutDefaultRuleFields`), whatever a forged POST carries.
import type {
  FeeRule,
  FeeRuleInput,
  FeeRuleUpdate,
  MarkupRule,
  MarkupRuleInput,
  MarkupRuleUpdate,
} from "@velexis/ota-sdk";
import { z } from "zod";

import { formatInstant } from "@/app/(console)/bookings/views";
import { formatMoney, type MoneyValue } from "@/components/money";
import { ACTION_KEY_FIELD, type ActionState } from "@/lib/action-state";

// ---- Kinds, routes and ids --------------------------------------------------------------------------------------

/** The two kinds of pricing rules: markup rules (`mkr_…`) and fee rules (`fee_…`). */
export type RuleKind = "markup" | "fee";
/** A rule as the API answers it. */
export type PricingRule = MarkupRule | FeeRule;
/** A warning of a saved rule (`SettingsWarning`: `fixed_currency_not_default`, `sells_below_net`, …). */
export type SettingsWarning = NonNullable<MarkupRule["warnings"]>[number];
export type Calculation = MarkupRule["calculation"];
export type AppliesPer = MarkupRule["appliesPer"];
export type FeeType = FeeRule["feeType"];
/** The scope of a fee rule: the markup rule's fields and `cardBrands`. */
export type RuleScope = FeeRule["scope"];

/** The list of each kind. */
export const RULE_PATHS: Readonly<Record<RuleKind, string>> = Object.freeze({
  markup: "/settings/markups",
  fee: "/settings/fees",
});

/** The page of one rule. */
export function rulePath(kind: RuleKind, id: string): string {
  return `${RULE_PATHS[kind]}/${encodeURIComponent(id)}`;
}

/** The page that creates a rule. */
export function newRulePath(kind: RuleKind): string {
  return `${RULE_PATHS[kind]}/new`;
}

/** A rule id as the API writes it; nothing else is ever sent as one. */
export const RULE_ID_PATTERN: Readonly<Record<RuleKind, RegExp>> = Object.freeze({
  markup: /^mkr_[0-9A-Za-z]{16,40}$/,
  fee: /^fee_[0-9A-Za-z]{16,40}$/,
});

/** The list filter of the URL (`?active=true|false`, the API's `active`). */
export const ACTIVE_PARAM = "active";
/** The cursor of the URL (`page.nextCursor` of the previous page). */
export const CURSOR_PARAM = "cursor";
/** The page size of the lists: every rule of most OTAs on one page, in the engine's order. */
export const RULES_PAGE_SIZE = 50;
/** The longest cursor a list passes on; the API's cursors are far shorter. */
const MAX_CURSOR_LENGTH = 2048;

/** What a list's URL asks for: the `active` filter and the cursor, and the parameters the API would refuse. */
export interface RuleListQuery {
  readonly active: boolean | undefined;
  readonly cursor: string | undefined;
  /** The URL's parameters the API would refuse (`active`, `cursor`); the page then sends nothing. */
  readonly invalid: readonly string[];
}

/** The list query of a URL: `active` is `true`, `false` or absent; one cursor of a sane length. */
export function ruleListQueryOf(query: URLSearchParams): RuleListQuery {
  const invalid: string[] = [];
  const actives = query.getAll(ACTIVE_PARAM).filter((value) => value !== "");
  const [activeText] = actives;
  let active: boolean | undefined;
  if (actives.length > 1 || (activeText !== undefined && activeText !== "true" && activeText !== "false")) {
    invalid.push(ACTIVE_PARAM);
  } else if (activeText !== undefined) {
    active = activeText === "true";
  }
  const cursors = query.getAll(CURSOR_PARAM).filter((value) => value !== "");
  const [cursor] = cursors;
  if (cursors.length > 1 || (cursor !== undefined && cursor.length > MAX_CURSOR_LENGTH)) {
    invalid.push(CURSOR_PARAM);
  }
  return { active, cursor: invalid.includes(CURSOR_PARAM) ? undefined : cursor, invalid };
}

/** The URL of a list with the `active` filter and, on a later page, the cursor. */
export function ruleListHref(kind: RuleKind, active: boolean | undefined, cursor?: string): string {
  const query = new URLSearchParams();
  if (active !== undefined) {
    query.set(ACTIVE_PARAM, String(active));
  }
  if (cursor !== undefined) {
    query.set(CURSOR_PARAM, cursor);
  }
  const text = query.toString();
  return text === "" ? RULE_PATHS[kind] : `${RULE_PATHS[kind]}?${text}`;
}

// ---- Field names ------------------------------------------------------------------------------------------------

/** The form's fields; the body's are named after the API's JSON pointers. */
export const RULE_FIELDS = Object.freeze({
  /** Hidden: the rule of an update or delete. */
  ruleId: "ruleId",
  /** Hidden: the rule's `version`, sent as `If-Match`. */
  version: "version",
  /** Hidden: the rule as the page rendered it (JSON of `ruleBodyOfRule`), what an update compares the form with. */
  original: "original",
  /** Hidden: the idempotency key of a create (lib/action-state.ts). */
  actionKey: ACTION_KEY_FIELD,
  /** Hidden: `true` on the default markup rule's form, which has no scope, priority, active or window inputs. */
  defaultRule: "defaultRule",
  name: "name",
  description: "description",
  label: "label",
  feeType: "feeType",
  calculation: "calculation",
  percentage: "percentage",
  fixedAmount: "fixed.amount",
  minAmount: "min.amount",
  maxAmount: "max.amount",
  currency: "currency",
  appliesPer: "appliesPer",
  priority: "priority",
  stackable: "stackable",
  refundable: "refundable",
  isActive: "isActive",
  activeFrom: "activeFrom",
  activeUntil: "activeUntil",
  minNet: "scope.minNet",
  maxNet: "scope.maxNet",
});

// ---- Choices ----------------------------------------------------------------------------------------------------

/** One choice of a select, a radio group or a checkbox group. */
export interface Choice<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
  /** What the choice means, under its label. */
  readonly detail?: string;
}

type ItemOf<List> = NonNullable<List> extends readonly (infer Item)[] ? Item : never;

type Cabin = ItemOf<RuleScope["cabins"]>;
type TravelerType = ItemOf<RuleScope["travelerTypes"]>;
type TripType = ItemOf<RuleScope["tripTypes"]>;
type Source = ItemOf<RuleScope["sources"]>;
type Channel = ItemOf<RuleScope["channels"]>;
type CardBrand = ItemOf<RuleScope["cardBrands"]>;

/**
 * The choices of a label table, in its order. The tables are `Record`s of the document's enums, so a value the
 * document adds and a table misses fails the type check.
 */
function choicesOf<Value extends string>(
  labels: Readonly<Record<Value, string | { readonly label: string; readonly detail: string }>>,
): readonly Choice<Value>[] {
  return Object.freeze(
    (Object.entries(labels) as [Value, string | { label: string; detail: string }][]).map(([value, label]) =>
      typeof label === "string" ? { value, label } : { value, label: label.label, detail: label.detail },
    ),
  );
}

export const CALCULATIONS: Readonly<Record<RuleKind, readonly Choice<Calculation>[]>> = Object.freeze({
  markup: choicesOf<Calculation>({
    percentage: "Percentage of the net price",
    fixed: "Fixed amount",
    percentage_plus_fixed: "Percentage of the net price plus a fixed amount",
  }),
  fee: choicesOf<Calculation>({
    percentage: "Percentage of the base amount",
    fixed: "Fixed amount",
    percentage_plus_fixed: "Percentage of the base amount plus a fixed amount",
  }),
});

export const APPLIES_PER = choicesOf<AppliesPer>({
  booking: "Per booking",
  traveler: "Per traveller",
  segment: "Per segment",
});

/** The fee types with the pricing step that charges them (OADR-0005 point 7). */
export const FEE_TYPES = choicesOf<FeeType>({
  booking_service: {
    label: "Booking service fee",
    detail: "Charged when the offer is priced, on the price after markup.",
  },
  ticketing: {
    label: "Ticketing fee",
    detail: "Charged when the offer is priced, on the price after markup.",
  },
  payment_card: {
    label: "Card fee",
    detail:
      "Charged when the card brand is known at checkout, on top of the Amadeus card fee; limit it to card brands below.",
  },
  ancillary_service: {
    label: "Extras fee",
    detail: "Charged per extra (bags, seats) chosen at checkout, on the extra's amount.",
  },
  cancellation: {
    label: "Cancellation fee",
    detail: "Charged by the cancellation quote and kept from the refund.",
  },
  change: {
    label: "Change fee",
    detail: "Stored but never charged in the MVP: there are no exchanges yet.",
  },
});

const CABINS = choicesOf<Cabin>({
  ECONOMY: "Economy",
  PREMIUM_ECONOMY: "Premium economy",
  BUSINESS: "Business",
  FIRST: "First",
});
const TRAVELER_TYPES = choicesOf<TravelerType>({
  ADULT: "Adult",
  CHILD: "Child",
  SENIOR: "Senior",
  YOUNG: "Young adult",
  HELD_INFANT: "Infant on a lap",
  SEATED_INFANT: "Infant in a seat",
  STUDENT: "Student",
});
const TRIP_TYPES = choicesOf<TripType>({
  one_way: "One way",
  round_trip: "Round trip",
  multi_city: "Multi-city",
});
const SOURCES = choicesOf<Source>({ GDS: "GDS", LTC: "LTC", PYTON: "PYTON", EAC: "EAC", NDC: "NDC" });
const CHANNELS = choicesOf<Channel>({
  storefront: "Storefront and API keys",
  console: "Console (staff)",
});
const CARD_BRANDS = choicesOf<CardBrand>({
  VISA: "Visa",
  MASTERCARD: "Mastercard",
  AMERICAN_EXPRESS: "American Express",
  DINERS: "Diners Club",
  MAESTRO: "Maestro",
  VISA_ELECTRON: "Visa Electron",
  VISA_DEBIT: "Visa Debit",
  MASTERCARD_DEBIT: "Mastercard Debit",
  VISA_IXARIS: "Visa (IXARIS)",
  MASTERCARD_IXARIS: "Mastercard (IXARIS)",
  MASTERCARD_AIRPLUS: "Mastercard (AirPlus)",
  UATP_AIRPLUS: "UATP (AirPlus)",
  PYTON: "PYTON",
});

/** The label of `value` among `choices`, or the value itself. */
export function labelOf(choices: readonly Choice[], value: string): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

// ---- Scope fields -----------------------------------------------------------------------------------------------

/** The list fields of a scope, in the document's order. */
export type ScopeListKey =
  | "origins"
  | "destinations"
  | "originCountries"
  | "destinationCountries"
  | "carriers"
  | "cabins"
  | "travelerTypes"
  | "tripTypes"
  | "sources"
  | "channels"
  | "cardBrands";

/** A scope list typed as codes (`PAR, NYC`). */
export interface ScopeCodeField {
  readonly type: "codes";
  readonly key: ScopeListKey;
  readonly name: string;
  readonly label: string;
  readonly hint: string;
  readonly pattern: RegExp;
  readonly max: number;
  /** Codes as the hint and the error show them. */
  readonly example: string;
}

/** A scope list chosen with checkboxes. */
export interface ScopeChoiceField {
  readonly type: "choices";
  readonly key: ScopeListKey;
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly choices: readonly Choice[];
}

export type ScopeField = ScopeCodeField | ScopeChoiceField;

/** Every scope list of the form, in the document's order; `cardBrands` is a fee rule's only. */
const SCOPE_FIELDS: readonly ScopeField[] = [
  {
    type: "codes",
    key: "origins",
    name: "scope.origins",
    label: "Origins",
    hint: "IATA codes of the first departure airport or city.",
    pattern: /^[A-Z]{3}$/,
    max: 200,
    example: "PAR, NYC",
  },
  {
    type: "codes",
    key: "destinations",
    name: "scope.destinations",
    label: "Destinations",
    hint: "IATA codes of the destination airport or city (the turnaround point of a round trip).",
    pattern: /^[A-Z]{3}$/,
    max: 200,
    example: "LON, BKK",
  },
  {
    type: "codes",
    key: "originCountries",
    name: "scope.originCountries",
    label: "Origin countries",
    hint: "ISO country codes of the origin.",
    pattern: /^[A-Z]{2}$/,
    max: 250,
    example: "FR, DE",
  },
  {
    type: "codes",
    key: "destinationCountries",
    name: "scope.destinationCountries",
    label: "Destination countries",
    hint: "ISO country codes of the destination.",
    pattern: /^[A-Z]{2}$/,
    max: 250,
    example: "US, TH",
  },
  {
    type: "codes",
    key: "carriers",
    name: "scope.carriers",
    label: "Airlines",
    hint: "IATA codes of the validating or marketing airlines.",
    pattern: /^[A-Z0-9]{2}$/,
    max: 200,
    example: "AF, LH",
  },
  { type: "choices", key: "cabins", name: "scope.cabins", label: "Cabins", choices: CABINS },
  {
    type: "choices",
    key: "travelerTypes",
    name: "scope.travelerTypes",
    label: "Traveller types",
    hint: "A rule per traveller counts only the travellers of these types.",
    choices: TRAVELER_TYPES,
  },
  { type: "choices", key: "tripTypes", name: "scope.tripTypes", label: "Trip types", choices: TRIP_TYPES },
  {
    type: "choices",
    key: "sources",
    name: "scope.sources",
    label: "Sources",
    hint: "Amadeus content sources of the offer.",
    choices: SOURCES,
  },
  {
    type: "choices",
    key: "channels",
    name: "scope.channels",
    label: "Channels",
    hint: "Who prices the offer: the storefront and API keys, or staff in the console.",
    choices: CHANNELS,
  },
  {
    type: "choices",
    key: "cardBrands",
    name: "scope.cardBrands",
    label: "Card brands",
    hint: "Only a card fee knows the card brand: a fee of another type with card brands never applies.",
    choices: CARD_BRANDS,
  },
];

/** The scope lists of a kind's form. */
export function scopeFieldsOf(kind: RuleKind): readonly ScopeField[] {
  return kind === "fee" ? SCOPE_FIELDS : SCOPE_FIELDS.filter((field) => field.key !== "cardBrands");
}

// ---- Messages ---------------------------------------------------------------------------------------------------

export const RULE_MESSAGES = Object.freeze({
  staleForm: "This form is out of date. Reload the page and try again.",
  nameRequired: "Enter a name.",
  nameTooLong: "Use at most 120 characters.",
  descriptionTooLong: "Use at most 1,000 characters.",
  labelRequired: "Enter the label travellers see.",
  labelTooLong: "Use at most 80 characters.",
  feeType: "Choose what the fee is charged for.",
  calculation: "Choose how the amount is computed.",
  appliesPer: "Choose what the amount is computed for.",
  percentageRequired: "Enter the percentage.",
  markupPercentage: "Enter a percentage from -100 to 999.9999, like 4 or 4.5; a negative one is a discount.",
  feePercentage: "Enter a percentage from 0 to 100, like 1.5.",
  fixedRequired: "Enter the fixed amount.",
  markupAmount: "Enter an amount with at most two decimals, like 15.00; a negative one is a discount.",
  feeAmount: "Enter an amount of zero or more with at most two decimals, like 15.00.",
  currencyRequired: "Enter the currency of the amounts, like EUR.",
  currency: "Enter a three-letter currency code, like EUR.",
  net: "Enter an amount with at most two decimals, like 400.00.",
  priority: "Enter a whole number from 0 to 100,000.",
  dateTime: "Enter a date and a time.",
  window: "The end of the window is after its start.",
  codes: (example: string) => `Enter codes like ${example}, separated by commas.`,
  tooManyCodes: (max: number) => `Enter at most ${max} codes.`,
  choice: "Choose from the list.",
});

// ---- Decimals ---------------------------------------------------------------------------------------------------

/** Patterns of the document and of `numeric(12,2)`: amounts below 10 000 000 000 with at most two decimals. */
const MARKUP_PERCENTAGE = /^-?[0-9]{1,3}(\.[0-9]{1,4})?$/;
const FEE_PERCENTAGE = /^[0-9]{1,3}(\.[0-9]{1,4})?$/;
const MARKUP_AMOUNT = /^-?[0-9]{1,10}(\.[0-9]{1,2})?$/;
const FEE_AMOUNT = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const NET_BOUND = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const PRIORITY = /^[0-9]{1,6}$/;
const PRIORITY_MAX = 100_000;

/** A percentage's value in ten-thousandths, exactly (a percentage is never a JS float here). */
function tenThousandths(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const scaled = BigInt(`${whole}${fraction.padEnd(4, "0").slice(0, 4)}`);
  return negative ? -scaled : scaled;
}

/** A decimal string without trailing zeros (`4.5000` → `4.5`, `-0` → `0`), to compare and to show. */
export function trimDecimal(value: string): string {
  const trimmed = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
  const unsigned = trimmed.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return trimmed.startsWith("-") && /[1-9]/.test(unsigned) ? `-${unsigned}` : unsigned;
}

/** Two decimal strings of the same value (`15` and `15.00`). */
function sameDecimal(left: string | null, right: string | null): boolean {
  return left === null || right === null ? left === right : trimDecimal(left) === trimDecimal(right);
}

// ---- Times in the OTA's time zone -------------------------------------------------------------------------------

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The offset of `timeZone` from UTC at `instant`, in ms (`Intl`'s view of the zone's rules). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return local - (instant - (((instant % 1000) + 1000) % 1000));
}

/** The offset of `timeZone` at `instant`; 0 (UTC) for a zone the runtime does not know. */
function safeOffsetMs(instant: number, timeZone: string): number {
  try {
    return zoneOffsetMs(instant, timeZone);
  } catch {
    return 0;
  }
}

/** A `datetime-local` value (`YYYY-MM-DDTHH:mm[:ss]`) that names a real day and time of a year after 0000. */
export function isLocalDateTime(value: string): boolean {
  const match = LOCAL_DATE_TIME.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map((part) => Number(part ?? 0));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year > 0 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

/** `datetime-local` with seconds, so two values compare as text. */
function withSeconds(value: string): string {
  return value.length === 16 ? `${value}:00` : value;
}

/**
 * The instant (ISO, UTC) of a wall-clock time in `timeZone`; a zone the runtime does not know counts as UTC. A time
 * a change to daylight saving time skips is read with the offset before the change; a time the change back repeats
 * is read as its second occurrence.
 */
export function instantOfLocal(local: string, timeZone: string): string {
  const match = LOCAL_DATE_TIME.exec(local);
  if (match === null) {
    throw new TypeError("not a local date and time");
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((part) => Number(part ?? 0)) as number[];
  const wall = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0);
  // Twice: the offset at the guess may differ from the one at the result across a change of daylight saving time.
  let offset = safeOffsetMs(wall, timeZone);
  offset = safeOffsetMs(wall - offset, timeZone);
  return new Date(wall - offset).toISOString().replace(".000Z", "Z");
}

/** The wall-clock time of an instant in `timeZone`, as a `datetime-local` value (seconds only when not 0). */
export function localOfInstant(instant: string, timeZone: string): string {
  const time = Date.parse(instant);
  if (!Number.isFinite(time)) {
    return "";
  }
  const local = new Date(time + safeOffsetMs(time, timeZone)).toISOString();
  const seconds = local.slice(17, 19);
  return seconds === "00" ? local.slice(0, 16) : local.slice(0, 19);
}

/**
 * Two instants that the form shows as the same wall-clock time in `timeZone` (what its `datetime-local` field holds,
 * to the second when it has seconds), or both none. Compared as shown, not as instants: a time of the hour the clocks
 * go back stands for two instants and is read back as the second (`instantOfLocal`), so a stored first one sent back
 * unchanged is still unchanged.
 */
function sameWallClock(left: string | null, right: string | null, timeZone: string): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return localOfInstant(left, timeZone) === localOfInstant(right, timeZone);
}

// ---- The form's values: the Zod mirrors of MarkupRuleInput and FeeRuleInput ---------------------------------------

/** What the form posts, before its schema: text fields, the checkbox groups as lists, the checkboxes as booleans. */
export type RuleFormInput = Readonly<Record<string, string | readonly string[] | boolean | undefined>>;

/** The form's fields as `ruleFormSchema` reads them (`FormData` of the form). */
export function ruleFormInput(kind: RuleKind, form: FormData): RuleFormInput {
  const text = (name: string): string | undefined => {
    const value = form.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const checked = (name: string): boolean => {
    const value = form.get(name);
    return value === "true" || value === "on";
  };
  const input: Record<string, string | readonly string[] | boolean | undefined> = {};
  for (const name of [
    RULE_FIELDS.name,
    RULE_FIELDS.calculation,
    RULE_FIELDS.percentage,
    RULE_FIELDS.fixedAmount,
    RULE_FIELDS.minAmount,
    RULE_FIELDS.maxAmount,
    RULE_FIELDS.currency,
    RULE_FIELDS.appliesPer,
    RULE_FIELDS.priority,
    RULE_FIELDS.activeFrom,
    RULE_FIELDS.activeUntil,
    RULE_FIELDS.minNet,
    RULE_FIELDS.maxNet,
    ...(kind === "markup" ? [RULE_FIELDS.description] : [RULE_FIELDS.label, RULE_FIELDS.feeType]),
  ]) {
    input[name] = text(name);
  }
  for (const field of scopeFieldsOf(kind)) {
    input[field.name] =
      field.type === "codes"
        ? text(field.name)
        : form.getAll(field.name).filter((value): value is string => typeof value === "string");
  }
  input[RULE_FIELDS.isActive] = checked(RULE_FIELDS.isActive);
  input[kind === "markup" ? RULE_FIELDS.stackable : RULE_FIELDS.refundable] = checked(
    kind === "markup" ? RULE_FIELDS.stackable : RULE_FIELDS.refundable,
  );
  return input;
}

/** An empty or blank text is no value. */
const blank = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalText = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());

/** A name-like text: trimmed, 1 to `max` code points (JSON Schema counts code points). */
const sizedText = (max: number, required: string, tooLong: string) =>
  z
    .string({ required_error: required, invalid_type_error: required })
    .trim()
    .refine((value) => value !== "", required)
    .refine((value) => [...value].length <= max, tooLong);

/** Codes typed as text (`par, NYC; lon`): upper-cased, separated by commas, semicolons or spaces, each once. */
function codesOf(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((code) => code.trim().toUpperCase())
        .filter((code) => code !== ""),
    ),
  ];
}

const codeList = (field: ScopeCodeField) =>
  z.preprocess(
    (value) => (typeof value === "string" ? codesOf(value) : []),
    z
      .array(z.string().regex(field.pattern, RULE_MESSAGES.codes(field.example)), {
        invalid_type_error: RULE_MESSAGES.codes(field.example),
      })
      .max(field.max, RULE_MESSAGES.tooManyCodes(field.max)),
  );

const choiceList = (field: ScopeChoiceField) =>
  z
    .array(z.string(), { invalid_type_error: RULE_MESSAGES.choice })
    .default([])
    .refine(
      (values) => values.every((value) => field.choices.some((choice) => choice.value === value)),
      RULE_MESSAGES.choice,
    )
    // In the form's order, each once.
    .transform((values) =>
      field.choices.map((choice) => choice.value).filter((value) => values.includes(value)),
    );

const choice = <Value extends string>(choices: readonly Choice<Value>[], message: string) =>
  z.enum(choices.map((entry) => entry.value) as [Value, ...Value[]], { errorMap: () => ({ message }) });

/** The form's values once its schema passed. */
export interface RuleFormValues {
  readonly name: string;
  readonly description: string | null;
  readonly label: string | null;
  readonly feeType: FeeType | null;
  /** The scope as the API takes it: only the lists with an item and the net bounds that are set. */
  readonly scope: RuleScope;
  readonly calculation: Calculation;
  readonly percentage: string | null;
  readonly fixedAmount: string | null;
  readonly minAmount: string | null;
  readonly maxAmount: string | null;
  readonly currency: string | null;
  readonly appliesPer: AppliesPer;
  readonly priority: number;
  readonly stackable: boolean;
  readonly refundable: boolean;
  readonly isActive: boolean;
  /** `datetime-local` values in the OTA's time zone. */
  readonly activeFrom: string | null;
  readonly activeUntil: string | null;
}

/** The calculation uses the percentage, and the fixed amount (as the engine reads it). */
export const usesPercentage = (calculation: string): boolean =>
  calculation === "percentage" || calculation === "percentage_plus_fixed";
export const usesFixed = (calculation: string): boolean =>
  calculation === "fixed" || calculation === "percentage_plus_fixed";

/**
 * The schema of the form of `kind`: the patterns, bounds and enums of `MarkupRuleInput` or `FeeRuleInput`, and the
 * rules the API adds (api-changes part 2 §2.1 and §2.2, the backend's `pricing-rules.mapper.ts`): the percentage of a
 * percentage calculation and the fixed amount of a fixed one are required, a markup percentage is at least -100 and
 * a fee's at most 100, a fee's amounts are not negative, the amounts share the one currency, the window ends after it
 * starts. Values the calculation does not use are not checked and not sent. Every field is checked, and the rules
 * between fields run on the fields that passed, so one submission names every problem; each issue is on its field
 * (an item of a code list on the list).
 */
export function ruleFormSchema(kind: RuleKind) {
  const amount = kind === "markup" ? MARKUP_AMOUNT : FEE_AMOUNT;
  const amountMessage = kind === "markup" ? RULE_MESSAGES.markupAmount : RULE_MESSAGES.feeAmount;
  const money = optionalText(z.string().trim());
  const fields: Record<string, z.ZodTypeAny> = {
    [RULE_FIELDS.name]: sizedText(120, RULE_MESSAGES.nameRequired, RULE_MESSAGES.nameTooLong),
    ...(kind === "markup"
      ? {
          [RULE_FIELDS.description]: optionalText(
            z
              .string()
              .trim()
              .refine((value) => [...value].length <= 1000, RULE_MESSAGES.descriptionTooLong),
          ),
        }
      : {
          [RULE_FIELDS.label]: sizedText(80, RULE_MESSAGES.labelRequired, RULE_MESSAGES.labelTooLong),
          [RULE_FIELDS.feeType]: choice(FEE_TYPES, RULE_MESSAGES.feeType),
        }),
    ...Object.fromEntries(
      scopeFieldsOf(kind).map((field) => [
        field.name,
        field.type === "codes" ? codeList(field) : choiceList(field),
      ]),
    ),
    [RULE_FIELDS.minNet]: optionalText(z.string().trim().regex(NET_BOUND, RULE_MESSAGES.net)),
    [RULE_FIELDS.maxNet]: optionalText(z.string().trim().regex(NET_BOUND, RULE_MESSAGES.net)),
    [RULE_FIELDS.calculation]: choice(CALCULATIONS[kind], RULE_MESSAGES.calculation),
    [RULE_FIELDS.percentage]: money,
    [RULE_FIELDS.fixedAmount]: money,
    [RULE_FIELDS.minAmount]: money,
    [RULE_FIELDS.maxAmount]: money,
    [RULE_FIELDS.currency]: optionalText(
      z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .refine((value) => CURRENCY.test(value), RULE_MESSAGES.currency),
    ),
    [RULE_FIELDS.appliesPer]: choice(APPLIES_PER, RULE_MESSAGES.appliesPer),
    [RULE_FIELDS.priority]: z
      .string({ required_error: RULE_MESSAGES.priority, invalid_type_error: RULE_MESSAGES.priority })
      .trim()
      .refine((value) => PRIORITY.test(value) && Number(value) <= PRIORITY_MAX, RULE_MESSAGES.priority)
      .transform(Number),
    [kind === "markup" ? RULE_FIELDS.stackable : RULE_FIELDS.refundable]: z.boolean().default(false),
    [RULE_FIELDS.isActive]: z.boolean().default(false),
    [RULE_FIELDS.activeFrom]: optionalText(z.string().trim().refine(isLocalDateTime, RULE_MESSAGES.dateTime)),
    [RULE_FIELDS.activeUntil]: optionalText(
      z.string().trim().refine(isLocalDateTime, RULE_MESSAGES.dateTime),
    ),
  };

  return z.record(z.unknown()).transform((input, context): RuleFormValues => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    const values: Record<string, unknown> = {};
    const failed = new Set<string>();
    for (const [name, schema] of Object.entries(fields)) {
      const result = schema.safeParse(input[name]);
      if (result.success) {
        values[name] = result.data;
      } else {
        failed.add(name);
        issue(name, result.error.issues[0]?.message ?? RULE_MESSAGES.staleForm);
      }
    }
    const text = (name: string): string | null => (values[name] as string | undefined) ?? null;

    // The rules between fields, on the fields that passed.
    const calculation = values[RULE_FIELDS.calculation] as Calculation | undefined;
    const percentage = text(RULE_FIELDS.percentage);
    const fixed = text(RULE_FIELDS.fixedAmount);
    const usedPercentage = calculation !== undefined && usesPercentage(calculation);
    const usedFixed = calculation === undefined || usesFixed(calculation);
    if (usedPercentage) {
      if (percentage === null) {
        issue(RULE_FIELDS.percentage, RULE_MESSAGES.percentageRequired);
      } else if (kind === "markup") {
        if (!MARKUP_PERCENTAGE.test(percentage) || tenThousandths(percentage) < -1_000_000n) {
          issue(RULE_FIELDS.percentage, RULE_MESSAGES.markupPercentage);
        }
      } else if (!FEE_PERCENTAGE.test(percentage) || tenThousandths(percentage) > 1_000_000n) {
        issue(RULE_FIELDS.percentage, RULE_MESSAGES.feePercentage);
      }
    }
    if (calculation !== undefined && usesFixed(calculation) && fixed === null) {
      issue(RULE_FIELDS.fixedAmount, RULE_MESSAGES.fixedRequired);
    }
    const amounts: (readonly [string, string | null])[] = [
      [RULE_FIELDS.fixedAmount, usedFixed ? fixed : null],
      [RULE_FIELDS.minAmount, text(RULE_FIELDS.minAmount)],
      [RULE_FIELDS.maxAmount, text(RULE_FIELDS.maxAmount)],
    ];
    for (const [name, value] of amounts) {
      if (value !== null && !amount.test(value)) {
        issue(name, amountMessage);
      }
    }
    if (
      amounts.some(([, value]) => value !== null) &&
      text(RULE_FIELDS.currency) === null &&
      !failed.has(RULE_FIELDS.currency)
    ) {
      issue(RULE_FIELDS.currency, RULE_MESSAGES.currencyRequired);
    }
    const from = text(RULE_FIELDS.activeFrom);
    const until = text(RULE_FIELDS.activeUntil);
    if (from !== null && until !== null && withSeconds(until) <= withSeconds(from)) {
      issue(RULE_FIELDS.activeUntil, RULE_MESSAGES.window);
    }
    if (failed.size > 0 || calculation === undefined) {
      return z.NEVER;
    }

    const scope: Record<string, unknown> = {};
    for (const field of scopeFieldsOf(kind)) {
      const list = values[field.name] as string[];
      if (list.length > 0) {
        scope[field.key] = list;
      }
    }
    const minNet = text(RULE_FIELDS.minNet);
    const maxNet = text(RULE_FIELDS.maxNet);
    if (minNet !== null) {
      scope["minNet"] = minNet;
    }
    if (maxNet !== null) {
      scope["maxNet"] = maxNet;
    }
    return {
      name: values[RULE_FIELDS.name] as string,
      description: kind === "markup" ? text(RULE_FIELDS.description) : null,
      label: kind === "fee" ? text(RULE_FIELDS.label) : null,
      feeType: kind === "fee" ? (values[RULE_FIELDS.feeType] as FeeType) : null,
      scope: scope as RuleScope,
      calculation,
      percentage: usedPercentage ? percentage : null,
      fixedAmount: usesFixed(calculation) ? fixed : null,
      minAmount: text(RULE_FIELDS.minAmount),
      maxAmount: text(RULE_FIELDS.maxAmount),
      currency: text(RULE_FIELDS.currency),
      appliesPer: values[RULE_FIELDS.appliesPer] as AppliesPer,
      priority: values[RULE_FIELDS.priority] as number,
      stackable: kind === "markup" && values[RULE_FIELDS.stackable] === true,
      refundable: kind === "fee" && values[RULE_FIELDS.refundable] === true,
      isActive: values[RULE_FIELDS.isActive] === true,
      activeFrom: from,
      activeUntil: until,
    };
  });
}

// ---- Request bodies ---------------------------------------------------------------------------------------------

/**
 * Every writable field of a rule of either kind, `null` where it has no value: what a create sends (without the
 * nulls) and what an update compares (`updateBodyOf`). The kind's own fields only: `description` and `stackable` of a
 * markup rule, `label`, `feeType` and `refundable` of a fee rule.
 */
export interface RuleBody {
  readonly name: string;
  readonly description?: string | null;
  readonly label?: string;
  readonly feeType?: FeeType;
  readonly scope: RuleScope;
  readonly calculation: Calculation;
  readonly percentage: string | null;
  readonly fixed: MoneyValue | null;
  readonly appliesPer: AppliesPer;
  readonly min: MoneyValue | null;
  readonly max: MoneyValue | null;
  readonly priority: number;
  readonly stackable?: boolean;
  readonly refundable?: boolean;
  readonly isActive: boolean;
  readonly activeFrom: string | null;
  readonly activeUntil: string | null;
}

/**
 * The scope fields in the document's order, without empty lists and unset bounds (`{}` matches every offer); the
 * checkbox lists in the order of their choices, as the form posts them, so an untouched list compares equal.
 */
export function normalizedScope(kind: RuleKind, scope: RuleScope | undefined): RuleScope {
  const normalized: Record<string, unknown> = {};
  const given = (scope ?? {}) as Readonly<Record<string, unknown>>;
  for (const field of scopeFieldsOf(kind)) {
    const values = given[field.key];
    if (!Array.isArray(values) || values.length === 0) {
      continue;
    }
    if (field.type === "choices") {
      const order = field.choices.map((entry) => entry.value);
      const rank = (value: unknown) => {
        const index = order.indexOf(String(value));
        return index === -1 ? order.length : index;
      };
      normalized[field.key] = [...values].sort((left, right) => rank(left) - rank(right));
    } else {
      normalized[field.key] = [...values];
    }
  }
  for (const bound of ["minNet", "maxNet"] as const) {
    const value = given[bound];
    if (typeof value === "string" && value !== "") {
      normalized[bound] = value;
    }
  }
  return normalized as RuleScope;
}

/** An amount in the form's one currency, or `null`. */
const moneyOf = (amount: string | null, currency: string | null): MoneyValue | null =>
  amount === null || currency === null ? null : { amount, currency };

/** The body of the form's values; the window in the OTA's `timeZone`. */
export function ruleBodyOfForm(kind: RuleKind, values: RuleFormValues, timeZone: string): RuleBody {
  const common = {
    name: values.name,
    scope: normalizedScope(kind, values.scope),
    calculation: values.calculation,
    percentage: values.percentage,
    fixed: moneyOf(values.fixedAmount, values.currency),
    appliesPer: values.appliesPer,
    min: moneyOf(values.minAmount, values.currency),
    max: moneyOf(values.maxAmount, values.currency),
    priority: values.priority,
    isActive: values.isActive,
    activeFrom: values.activeFrom === null ? null : instantOfLocal(values.activeFrom, timeZone),
    activeUntil: values.activeUntil === null ? null : instantOfLocal(values.activeUntil, timeZone),
  };
  return kind === "markup"
    ? { ...common, description: values.description, stackable: values.stackable }
    : {
        ...common,
        label: values.label ?? "",
        feeType: values.feeType ?? "booking_service",
        refundable: values.refundable,
      };
}

/**
 * The body of a rule as the API answered it (the page's `original`), as its form posts it unchanged: the texts trimmed
 * (a blank description is none) and only the amounts its calculation uses (`ruleFormSchema` drops the others), so a
 * rule the API stored with a value its calculation ignores is not changed by a form sent as shown.
 */
export function ruleBodyOfRule(kind: RuleKind, rule: PricingRule): RuleBody {
  const common = {
    name: rule.name.trim(),
    scope: normalizedScope(kind, rule.scope),
    calculation: rule.calculation,
    percentage: usesPercentage(rule.calculation) ? (rule.percentage ?? null) : null,
    fixed: usesFixed(rule.calculation) ? (rule.fixed ?? null) : null,
    appliesPer: rule.appliesPer,
    min: rule.min ?? null,
    max: rule.max ?? null,
    priority: rule.priority,
    isActive: rule.isActive,
    activeFrom: rule.activeFrom ?? null,
    activeUntil: rule.activeUntil ?? null,
  };
  if (kind === "markup") {
    const markup = rule as MarkupRule;
    const description = markup.description?.trim() ?? "";
    return { ...common, description: description === "" ? null : description, stackable: markup.stackable };
  }
  const fee = rule as FeeRule;
  return { ...common, label: fee.label.trim(), feeType: fee.feeType, refundable: fee.refundable };
}

// ---- The default markup rule ------------------------------------------------------------------------------------

/**
 * The fields of the default markup rule that stay as seeded besides its scope (see the file header): its form shows
 * them read-only and never sends them.
 */
export const DEFAULT_RULE_FIXED_FIELDS = Object.freeze([
  RULE_FIELDS.priority,
  RULE_FIELDS.isActive,
  RULE_FIELDS.activeFrom,
  RULE_FIELDS.activeUntil,
] as const);

/** The priority the default markup rule keeps (OADR-0005 point 3). */
export const DEFAULT_RULE_PRIORITY = 1000;

/** Whether `form` is the default markup rule's form (its hidden marker). */
export function isDefaultRuleForm(kind: RuleKind, form: FormData): boolean {
  return kind === "markup" && form.get(RULE_FIELDS.defaultRule) === "true";
}

/**
 * The input of the default markup rule's form, which has no inputs for its fixed fields: those fields as the page
 * rendered the rule (`original`, the window in the OTA's `timeZone` as the form would show it), in place of anything
 * the POST carries, so the form's schema reads them and `updateBodyOf` finds them unchanged.
 */
export function withDefaultRuleValues(
  input: RuleFormInput,
  original: RuleBody,
  timeZone: string,
): RuleFormInput {
  const local = (instant: string | null): string | undefined =>
    instant === null ? undefined : localOfInstant(instant, timeZone);
  return {
    ...input,
    [RULE_FIELDS.priority]: String(original.priority),
    [RULE_FIELDS.isActive]: original.isActive,
    [RULE_FIELDS.activeFrom]: local(original.activeFrom),
    [RULE_FIELDS.activeUntil]: local(original.activeUntil),
  };
}

/** The `PATCH` body of the default markup rule: `changes` without its scope and its fixed fields, never sent. */
export function withoutDefaultRuleFields(
  changes: MarkupRuleUpdate & FeeRuleUpdate,
): MarkupRuleUpdate & FeeRuleUpdate {
  const fixed: ReadonlySet<string> = new Set(["scope", ...DEFAULT_RULE_FIXED_FIELDS]);
  return Object.fromEntries(
    Object.entries(changes).filter(([name]) => !fixed.has(name)),
  ) as MarkupRuleUpdate & FeeRuleUpdate;
}

/** A body without its `null` fields: what a create sends. */
function withoutNulls(body: RuleBody): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== null && value !== undefined),
  );
}

/** The body of console.settings.markupRules.create. */
export function markupInputOf(body: RuleBody): MarkupRuleInput {
  return withoutNulls(body) as unknown as MarkupRuleInput;
}

/** The body of console.settings.feeRules.create. */
export function feeInputOf(body: RuleBody): FeeRuleInput {
  return withoutNulls(body) as unknown as FeeRuleInput;
}

/** Two amounts of the same value and currency, or both none. */
function sameMoney(left: MoneyValue | null, right: MoneyValue | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.currency === right.currency && sameDecimal(left.amount, right.amount);
}

/** Whether the field `name` of two bodies holds the same value; the window as the form shows it in `timeZone`. */
function sameField(name: keyof RuleBody, form: RuleBody, original: RuleBody, timeZone: string): boolean {
  if (name === "scope") {
    return JSON.stringify(form.scope) === JSON.stringify(original.scope);
  }
  if (name === "percentage") {
    return sameDecimal(form.percentage, original.percentage);
  }
  if (name === "fixed" || name === "min" || name === "max") {
    return sameMoney(form[name], original[name]);
  }
  if (name === "activeFrom" || name === "activeUntil") {
    return sameWallClock(form[name], original[name], timeZone);
  }
  return (form[name] ?? null) === (original[name] ?? null);
}

/**
 * The `PATCH` body of an update: the fields of the form's body that differ from the rule the page rendered
 * (`original`), `null` for a value the form cleared, `scope` as a whole, the window compared as the form shows it in
 * the OTA's `timeZone`. Empty when nothing changed.
 */
export function updateBodyOf(
  form: RuleBody,
  original: RuleBody,
  timeZone: string,
): MarkupRuleUpdate & FeeRuleUpdate {
  const changes: Record<string, unknown> = {};
  for (const name of Object.keys(form) as (keyof RuleBody)[]) {
    if (!sameField(name, form, original, timeZone)) {
      changes[name] = form[name] ?? null;
    }
  }
  return changes as MarkupRuleUpdate & FeeRuleUpdate;
}

const MoneySchema = z.object({ amount: z.string(), currency: z.string() }).nullable();

/**
 * The page's `original` (JSON of `ruleBodyOfRule`), or `undefined` when it is not one: a form whose hidden field
 * does not parse is out of date.
 */
export function parseOriginal(kind: RuleKind, json: unknown): RuleBody | undefined {
  if (typeof json !== "string" || json.length > 100_000) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const schema = z.object({
    name: z.string(),
    description: kind === "markup" ? z.string().nullable() : z.undefined(),
    label: kind === "fee" ? z.string() : z.undefined(),
    feeType: kind === "fee" ? choice(FEE_TYPES, RULE_MESSAGES.feeType) : z.undefined(),
    scope: z.record(z.unknown()),
    calculation: choice(CALCULATIONS[kind], RULE_MESSAGES.calculation),
    percentage: z.string().nullable(),
    fixed: MoneySchema,
    appliesPer: choice(APPLIES_PER, RULE_MESSAGES.appliesPer),
    min: MoneySchema,
    max: MoneySchema,
    priority: z.number().int(),
    stackable: kind === "markup" ? z.boolean() : z.undefined(),
    refundable: kind === "fee" ? z.boolean() : z.undefined(),
    isActive: z.boolean(),
    activeFrom: z.string().nullable(),
    activeUntil: z.string().nullable(),
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const body = Object.fromEntries(
    Object.entries(parsed.data).filter(([, field]) => field !== undefined),
  ) as unknown as RuleBody;
  return { ...body, scope: normalizedScope(kind, body.scope) };
}

// ---- API field errors on the form's fields ----------------------------------------------------------------------

/** The scope lists' names: an error of one item (`scope.origins.3`) belongs to its list's field. */
const LIST_NAMES: readonly string[] = SCOPE_FIELDS.map((field) => field.name);

/**
 * The form's field of a name lib/errors.ts derived from an API pointer: an item of a scope list → the list, a money
 * object → its amount (`/fixed` → `fixed.amount`), a money currency → the one `currency` field, `If-Match` and the
 * path's rule id → the hidden fields (the form is out of date).
 */
export function ruleFieldOf(name: string): string {
  const list = LIST_NAMES.find((candidate) => name.startsWith(`${candidate}.`));
  if (list !== undefined) {
    return list;
  }
  switch (name) {
    case "fixed":
      return RULE_FIELDS.fixedAmount;
    case "min":
      return RULE_FIELDS.minAmount;
    case "max":
      return RULE_FIELDS.maxAmount;
    case "fixed.currency":
    case "min.currency":
    case "max.currency":
      return RULE_FIELDS.currency;
    case "ifMatch":
      return RULE_FIELDS.version;
    case "markupRuleId":
    case "feeRuleId":
      return RULE_FIELDS.ruleId;
    default:
      return name;
  }
}

/** The hidden fields: a problem with one means the page is out of date. */
export const HIDDEN_RULE_FIELDS: ReadonlySet<string> = new Set([
  RULE_FIELDS.ruleId,
  RULE_FIELDS.version,
  RULE_FIELDS.original,
  RULE_FIELDS.actionKey,
]);

// ---- Action states ----------------------------------------------------------------------------------------------

/** What a save answers besides the shared state: the rule and the API's warnings (`warnings[]`). */
export interface RuleActionState extends ActionState {
  /** The saved rule (a create's new one: the form opens it). */
  readonly rule?: { readonly id: string; readonly name: string };
  /** The API's warnings of the saved rule, as it sent them. */
  readonly warnings?: readonly SettingsWarning[];
}

/** The warnings of a state, or none. */
export function warningsOf(state: ActionState): readonly SettingsWarning[] {
  const { warnings } = state as RuleActionState;
  return Array.isArray(warnings) ? warnings : [];
}

/** The saved rule of a state, or `undefined`. */
export function savedRuleOf(state: ActionState): { readonly id: string; readonly name: string } | undefined {
  return (state as RuleActionState).rule;
}

// ---- What a rule says, in words ---------------------------------------------------------------------------------

/** A percentage as a sentence shows it: `4.5000` → `4.5 %`. */
export function percentText(value: string): string {
  return `${trimDecimal(value)} %`;
}

/** An amount, formatted. */
export function moneyText(value: MoneyValue): string {
  return formatMoney(value) ?? `${value.amount} ${value.currency}`;
}

/** The base a percentage takes. */
const PERCENT_BASE: Readonly<Record<RuleKind, string>> = Object.freeze({
  markup: "of the net price",
  fee: "of the base amount",
});

/** How a rule computes its amount: `4.5 % of the net price + €15.00, per traveller`. */
export function calculationText(kind: RuleKind, rule: PricingRule): string {
  const parts: string[] = [];
  if (usesPercentage(rule.calculation) && rule.percentage !== null && rule.percentage !== undefined) {
    parts.push(`${percentText(rule.percentage)} ${PERCENT_BASE[kind]}`);
  }
  if (usesFixed(rule.calculation) && rule.fixed !== null && rule.fixed !== undefined) {
    parts.push(moneyText(rule.fixed));
  }
  const per = labelOf(APPLIES_PER, rule.appliesPer).toLowerCase();
  return parts.length === 0
    ? `${labelOf(CALCULATIONS[kind], rule.calculation)}, ${per}`
    : `${parts.join(" + ")}, ${per}`;
}

/** The caps of a rule: `at least €15.00 and at most €50.00 per unit`, or `undefined` without caps. */
export function capsText(rule: PricingRule): string | undefined {
  const caps = [
    rule.min === null || rule.min === undefined ? undefined : `at least ${moneyText(rule.min)}`,
    rule.max === null || rule.max === undefined ? undefined : `at most ${moneyText(rule.max)}`,
  ].filter((part): part is string => part !== undefined);
  return caps.length === 0 ? undefined : `${caps.join(" and ")} per unit`;
}

/** One line of a scope as the pages show it. */
export interface ScopeLine {
  readonly label: string;
  readonly value: string;
}

/** The scope of a rule, line by line; none for a scope that matches every offer. */
export function scopeLines(kind: RuleKind, scope: RuleScope): ScopeLine[] {
  const normalized = normalizedScope(kind, scope) as Readonly<Record<string, unknown>>;
  const lines: ScopeLine[] = [];
  for (const field of scopeFieldsOf(kind)) {
    const values = normalized[field.key];
    if (Array.isArray(values)) {
      const shown = (values as string[]).map((value) =>
        field.type === "choices" ? labelOf(field.choices, value) : value,
      );
      lines.push({ label: field.label, value: shown.join(", ") });
    }
  }
  const minNet = normalized["minNet"];
  const maxNet = normalized["maxNet"];
  if (typeof minNet === "string" || typeof maxNet === "string") {
    const range =
      typeof minNet === "string" && typeof maxNet === "string"
        ? `${minNet} to ${maxNet}`
        : typeof minNet === "string"
          ? `${minNet} or more`
          : `up to ${String(maxNet)}`;
    lines.push({ label: "Net total", value: `${range}, in the offer's currency` });
  }
  return lines;
}

/** The scope in one line: `Every offer`, or its lines joined. */
export function scopeText(kind: RuleKind, scope: RuleScope): string {
  const lines = scopeLines(kind, scope);
  return lines.length === 0 ? "Every offer" : lines.map((line) => `${line.label}: ${line.value}`).join(" · ");
}

/** The validity window in the OTA's time zone: `Always`, `From …`, `Until …` or `… to …`. */
export function windowText(rule: PricingRule, timeZone: string): string {
  const from = rule.activeFrom ?? null;
  const until = rule.activeUntil ?? null;
  if (from === null && until === null) {
    return "Always";
  }
  if (from !== null && until !== null) {
    return `${formatInstant(from, timeZone)} to ${formatInstant(until, timeZone)}`;
  }
  return from !== null
    ? `From ${formatInstant(from, timeZone)}`
    : `Until ${formatInstant(until ?? "", timeZone)}`;
}

/** The currency of a rule's amounts: the fixed amount's, else a cap's, else `undefined`. */
export function currencyOfRule(rule: PricingRule): string | undefined {
  return (rule.fixed ?? rule.min ?? rule.max ?? undefined)?.currency;
}
