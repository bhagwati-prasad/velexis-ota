// The server actions of the PNR lookup `/pnr` (OAD-009; routes.md §4, console-operations flow §3 step 4, README §7,
// OADR-0018 points 4 and 5): attaching an Amadeus order that Velexis did not create to the OTA as a booking, the
// customer search of the import dialog, and the raw reads of the Advanced panel (OAD-010), each through the SDK's
// console namespace with the client `requireStaff` hands back (the staff token of the request, the service key, the
// environment of the switch, the end-user headers).
//
//   importBooking     console.bookings.import   bookings:write    idempotency key; the pricing mode (`markup_rules`,
//                                                                   `net`, or `override` with a selling total in the
//                                                                   order's currency); the match's `flightOrderId`
//   searchCustomers   console.customers.list    customers:read    `q`, active accounts only, at most 8
//   readRawOrders     console.amadeus.getFlightOrderByReference   amadeus:read   the record locator (GDS)
//   readRawOrder      console.amadeus.getFlightOrder              amadeus:read   one Amadeus order id
//
// The two raw reads (OBE-067, routes.md §4 "Advanced") answer Amadeus's verbatim orders, already redacted by the API,
// with net prices and the call's facts, for support. Each is an Amadeus call and an audited read (`amadeus.<operationId>`
// in staff_actions), so it runs only when staff press its button, never while the page renders; neither writes anything
// or carries a key. A value the API would refuse (a record locator outside `^[A-Z0-9]{5,8}$`, an order id outside
// `^[A-Za-z0-9=_-]{8,200}$`) is refused before any call.
//
// `importBooking` starts with `requireStaff("bookings:write")` (a forged POST fails before any call; the API decides and
// audits all the same), then validates the dialog's form with Zod, then makes one call with the dialog's hidden
// `actionKey` as the SDK's `idempotencyKey`, rendered once with the page: a double submit or a retry after a timeout
// replays the same import instead of making a second booking. The key handling after a failure is the shared one of
// lib/action-state.ts (`withNextActionKey`, ConfirmDialog's `useActionKey`), never this module's own: a final `4xx`
// the API stored under the key brings a new key, everything else keeps it (OADR-0018 point 5 and its revisions).
//
// The API's answers become the dialog's state, never `error.tsx` (README §7, routes.md §1 and §4): `409
// ORDER_ALREADY_IMPORTED` names the existing booking (`details.bookingId`, `details.reference`), which the dialog links;
// `403 OFFICE_NOT_ALLOWED` says the order belongs to an office outside this OTA (OBE-064: the owner office, or the
// queuing office when the order has none, must be one of the OTA's); `409 CONFLICT` for a deleted or disabled customer
// and `422 UNPROCESSABLE` for a missing contact e-mail, a selling total in another currency or below the net price are
// put on their fields. A success answers the new booking (and the API's warnings, a confirmation that could not be
// queued): the dialog opens its page, or stays to show the warnings. Nothing here logs, and no field asks for a card.
//
// No action here revalidates a path. When a server action revalidates any path, Next.js renders the page it was called
// from again in the same answer (`pathWasRevalidated`, whatever the path): `/pnr?recordLocator=…`, whose render is
// another Get Flight Order By Record Locator call and another audited `pnr.lookup` that no one asked for, and whose new
// tree shows the match as a booking in place of the dialog, so the API's warnings of the import would be lost with it.
// The bookings pages need nothing either: they are dynamic, so every navigation to them reads the API afresh.
"use server";

import type {
  ConsoleAmadeusFlightOrderResult,
  ConsoleAmadeusFlightOrdersByReferenceResult,
  ConsoleBooking,
  ConsoleImportBookingParams,
  StaffPermission,
} from "@velexis/ota-sdk";
import { z } from "zod";

import { TYPED_AMOUNT_PATTERN, isPositiveAmount } from "@/app/(console)/bookings/[bookingId]/action-rules";
import { formatMoney } from "@/components/money";
import {
  ACTION_KEY_FIELD,
  REASON_FIELD,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  fromZod,
  withNextActionKey,
  type ActionState,
} from "@/lib/action-state";
import { GENERIC_ERROR_MESSAGE, fromVelexisError, isVelexisErrorLike } from "@/lib/errors";
import { requireStaff, type StaffContext } from "@/lib/session";

import {
  CONTACT_EMAIL_FIELD,
  CURRENCY_FIELD,
  CUSTOMER_FIELD,
  CUSTOMER_QUERY_MAX_LENGTH,
  CUSTOMER_QUERY_MIN_LENGTH,
  FLIGHT_ORDER_FIELD,
  NOTE_FIELD,
  NOTE_MAX_LENGTH,
  PRICING_MODE_FIELD,
  RECORD_LOCATOR_PATTERN,
  REFERENCE_FIELD,
  SELLING_TOTAL_FIELD,
  SEND_CONFIRMATION_FIELD,
  TAGS_FIELD,
  TAGS_MAX,
  TAG_MAX_LENGTH,
  normalizeRecordLocator,
  tagsOf,
  type CustomerChoice,
  type CustomerSearchState,
  type ImportState,
  type ImportedBooking,
} from "./import-rules";

// ---- Messages -------------------------------------------------------------------------------------------------------

const STRINGS = Object.freeze({
  staleForm: "This form is out of date. Reload the page and look the record locator up again.",
  reasonRequired: "Enter a reason.",
  reasonTooShort: `Enter at least ${REASON_MIN_LENGTH} characters.`,
  reasonTooLong: `Use at most ${REASON_MAX_LENGTH} characters.`,
  pricingMode: "Choose how the booking is priced.",
  sellingTotalRequired: "Enter the selling total.",
  sellingTotalFormat: "Enter an amount like 1450.00.",
  sellingTotalPositive: "Enter an amount above zero.",
  customer: "Choose a customer from the search, or none.",
  contactEmail: "Enter an e-mail address.",
  tooManyTags: `Use at most ${TAGS_MAX} tags.`,
  tagTooLong: `A tag has at most ${TAG_MAX_LENGTH} characters.`,
  noteTooLong: `Use at most ${NOTE_MAX_LENGTH} characters.`,
  // The API's refusals, in the words of this page.
  alreadyImported: (reference: string) => `This order is already booking ${reference}.`,
  alreadyImportedUnnamed:
    "This order is already a booking of this OTA. Look the record locator up again to open it.",
  officeNotAllowed:
    "This order belongs to an Amadeus office outside this OTA: only orders of the OTA's own offices can be imported.",
  customerDeleted:
    "This customer deleted their account: choose another customer, or import the order as a guest booking.",
  customerDisabled:
    "This customer's account is disabled: choose another customer, or import the order as a guest booking.",
  customerNotFound: "This customer was not found. Search again, or import the order as a guest booking.",
  orderNotFound: "Amadeus no longer has an order with this record locator. Look it up again.",
  severalOrders:
    "Several orders have this record locator. Reload the page and import the order from its own line.",
  contactEmailRequired: "The order has no e-mail address: enter the booking's contact e-mail.",
  currencyMismatch: (currency: string | undefined) =>
    currency === undefined
      ? "The selling total must be in the order's currency."
      : `The selling total must be in the order's currency (${currency}).`,
  sellingBelowNet: (net: string | undefined) =>
    net === undefined
      ? "The selling total cannot be below the order's net price."
      : `The selling total cannot be below the order's net price (${net}).`,
  supplierTimeout:
    "Amadeus did not answer in time. Send the same form again: the order is imported once, whatever happened.",
  busy: "This import is still running. Send the same form again in a moment.",
  // Successes
  imported: (reference: string) => `Imported as booking ${reference}.`,
  // The customer search
  queryTooShort: `Enter at least ${CUSTOMER_QUERY_MIN_LENGTH} characters of the e-mail address or the name.`,
  queryTooLong: `Use at most ${CUSTOMER_QUERY_MAX_LENGTH} characters.`,
});

/** The most customers the search lists. */
const CUSTOMER_SEARCH_LIMIT = 8;

/** The API's pointers (as lib/errors.ts derives field names from them) → the dialog's fields. */
const API_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  pricing: PRICING_MODE_FIELD,
  "pricing.mode": PRICING_MODE_FIELD,
  "pricing.sellingTotal": SELLING_TOTAL_FIELD,
  "pricing.sellingTotal.amount": SELLING_TOTAL_FIELD,
  "pricing.sellingTotal.currency": SELLING_TOTAL_FIELD,
  reference: REFERENCE_FIELD,
  flightOrderId: FLIGHT_ORDER_FIELD,
  customerId: CUSTOMER_FIELD,
  contactEmail: CONTACT_EMAIL_FIELD,
  note: NOTE_FIELD,
  reason: REASON_FIELD,
});

/** The dialog's hidden fields: a problem with them means the page is out of date. */
const HIDDEN_FIELDS: ReadonlySet<string> = new Set([
  REFERENCE_FIELD,
  FLIGHT_ORDER_FIELD,
  CURRENCY_FIELD,
  ACTION_KEY_FIELD,
]);

// ---- Form fields ----------------------------------------------------------------------------------------------------

/** A text field of the form, or `undefined` (absent, or a file). */
function textOf(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

/** A checkbox of the form: checked when it posts `true` (or a browser's default `on`). */
function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "true" || value === "on";
}

/** An empty or blank text is no value. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** An optional text: blank is absent. */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

/** A hidden value the page rendered; a problem with it asks for a reload. */
const hiddenText = (pattern: RegExp) =>
  z.string({ required_error: STRINGS.staleForm }).regex(pattern, STRINGS.staleForm);

/** The staff action's reason: 3 to 500 characters after trimming, counted as the API counts (code points). */
const Reason = z
  .string({ required_error: STRINGS.reasonRequired })
  .trim()
  .refine((value) => [...value].length > 0, STRINGS.reasonRequired)
  .refine((value) => [...value].length >= REASON_MIN_LENGTH, STRINGS.reasonTooShort)
  .refine((value) => [...value].length <= REASON_MAX_LENGTH, STRINGS.reasonTooLong);

const ImportForm = z
  .object({
    [REFERENCE_FIELD]: hiddenText(RECORD_LOCATOR_PATTERN),
    // An Amadeus order id: visible ASCII (base64-like ids, sometimes URL-encoded), as the lookup answered it.
    [FLIGHT_ORDER_FIELD]: hiddenText(/^[\x21-\x7e]{1,200}$/),
    [CURRENCY_FIELD]: optional(hiddenText(/^[A-Z]{3}$/)),
    [ACTION_KEY_FIELD]: z.string({ required_error: STRINGS.staleForm }).uuid(STRINGS.staleForm),
    [REASON_FIELD]: Reason,
    [PRICING_MODE_FIELD]: z.preprocess(
      (value) => blankToUndefined(value) ?? "markup_rules",
      z.enum(["markup_rules", "net", "override"], { errorMap: () => ({ message: STRINGS.pricingMode }) }),
    ),
    [SELLING_TOTAL_FIELD]: optional(
      z
        .string()
        .trim()
        .refine((value) => TYPED_AMOUNT_PATTERN.test(value), STRINGS.sellingTotalFormat)
        .refine(isPositiveAmount, STRINGS.sellingTotalPositive),
    ),
    [CUSTOMER_FIELD]: optional(z.string().regex(/^cus_[0-9A-Za-z]{12,40}$/, STRINGS.customer)),
    [CONTACT_EMAIL_FIELD]: optional(
      z.string().trim().email(STRINGS.contactEmail).max(254, STRINGS.contactEmail),
    ),
    [SEND_CONFIRMATION_FIELD]: z.boolean(),
    [TAGS_FIELD]: z
      .string()
      .max(TAGS_MAX * (TAG_MAX_LENGTH + 2), STRINGS.tooManyTags)
      .transform(tagsOf)
      .refine((tags) => tags.length <= TAGS_MAX, STRINGS.tooManyTags)
      .refine((tags) => tags.every((tag) => [...tag].length <= TAG_MAX_LENGTH), STRINGS.tagTooLong),
    [NOTE_FIELD]: optional(
      z
        .string()
        .trim()
        .refine((value) => [...value].length <= NOTE_MAX_LENGTH, STRINGS.noteTooLong),
    ),
  })
  .superRefine((form, context) => {
    if (form[PRICING_MODE_FIELD] !== "override") {
      return;
    }
    if (form[SELLING_TOTAL_FIELD] === undefined) {
      context.addIssue({
        code: "custom",
        path: [SELLING_TOTAL_FIELD],
        message: STRINGS.sellingTotalRequired,
      });
    }
    if (form[CURRENCY_FIELD] === undefined) {
      // The page renders the order's currency with the override; without it the form is not this page's.
      context.addIssue({ code: "custom", path: [CURRENCY_FIELD], message: STRINGS.staleForm });
    }
  });

type ImportFormValues = z.infer<typeof ImportForm>;

/** The dialog's form as the schema reads it: the text fields, the checkbox as a boolean, the tags as text. */
function importFormInput(form: FormData): Record<string, unknown> {
  const input: Record<string, unknown> = {
    [SEND_CONFIRMATION_FIELD]: checked(form, SEND_CONFIRMATION_FIELD),
    [TAGS_FIELD]: textOf(form, TAGS_FIELD) ?? "",
  };
  for (const name of [
    REFERENCE_FIELD,
    FLIGHT_ORDER_FIELD,
    CURRENCY_FIELD,
    ACTION_KEY_FIELD,
    REASON_FIELD,
    PRICING_MODE_FIELD,
    SELLING_TOTAL_FIELD,
    CUSTOMER_FIELD,
    CONTACT_EMAIL_FIELD,
    NOTE_FIELD,
  ]) {
    const value = textOf(form, name);
    if (value !== undefined) {
      input[name] = value;
    }
  }
  return input;
}

/** The state of a form that failed its schema; a hidden field's problem asks for a reload. */
function invalid(error: z.ZodError): ActionState {
  const state = fromZod(error);
  const hidden = Object.keys(state.fieldErrors ?? {}).some((name) => HIDDEN_FIELDS.has(name));
  return hidden ? { ...state, message: STRINGS.staleForm } : state;
}

/** The body of console.bookings.import for the dialog's values (no empty optional field is sent). */
function importParams(values: ImportFormValues): ConsoleImportBookingParams {
  const mode = values[PRICING_MODE_FIELD];
  const sellingTotal = values[SELLING_TOTAL_FIELD];
  const currency = values[CURRENCY_FIELD];
  const customerId = values[CUSTOMER_FIELD];
  const contactEmail = values[CONTACT_EMAIL_FIELD];
  const tags = values[TAGS_FIELD];
  const note = values[NOTE_FIELD];
  return {
    reference: values[REFERENCE_FIELD],
    flightOrderId: values[FLIGHT_ORDER_FIELD],
    pricing:
      mode === "override" && sellingTotal !== undefined && currency !== undefined
        ? { mode, sellingTotal: { amount: sellingTotal, currency } }
        : { mode },
    ...(customerId === undefined ? {} : { customerId }),
    ...(contactEmail === undefined ? {} : { contactEmail }),
    sendConfirmation: values[SEND_CONFIRMATION_FIELD],
    ...(tags.length === 0 ? {} : { tags }),
    ...(note === undefined ? {} : { note }),
    reason: values[REASON_FIELD],
  };
}

// ---- Failures -------------------------------------------------------------------------------------------------------

/** A string detail of an error, if it has one. */
function detailText(details: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = details?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A `Money` detail of an error as a sentence shows it (`details.net` of `selling_below_net`). */
function detailMoney(details: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = details?.[name];
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { amount, currency } = value as { amount?: unknown; currency?: unknown };
  if (typeof amount !== "string" || typeof currency !== "string") {
    return undefined;
  }
  return formatMoney({ amount, currency }) ?? `${amount} ${currency}`;
}

/** The existing booking of a `409 ORDER_ALREADY_IMPORTED` (`details.bookingId`, `details.reference`). */
function existingBookingOf(details: Record<string, unknown> | undefined): ImportedBooking | undefined {
  const id = detailText(details, "bookingId");
  const reference = detailText(details, "reference");
  return id !== undefined && /^bkg_[0-9A-Za-z]{16,40}$/.test(id) && reference !== undefined
    ? { id, reference }
    : undefined;
}

/** `state` with `message` as its message and, when `field` is given, as that field's error too. */
function said(state: ActionState, message: string, field?: string): ActionState {
  return field === undefined
    ? { ...state, message }
    : { ...state, message, fieldErrors: { ...state.fieldErrors, [field]: message } };
}

/**
 * The state of a failed import: lib/errors.ts's message, field errors (`API_FIELDS`; a tag's pointer on the tags
 * field) and request id, this page's words for the codes it knows, the existing booking of `409
 * ORDER_ALREADY_IMPORTED`, and a new key for the next submission when the API stored its answer under the key
 * (`withNextActionKey`). Redirects and bugs are thrown again (`fromVelexisError`).
 */
function importFailure(error: unknown, values: ImportFormValues): ImportState {
  const base = fromVelexisError(error, { fields: API_FIELDS });
  if (!isVelexisErrorLike(error)) {
    return base;
  }
  const fieldErrors = Object.fromEntries(
    Object.entries(base.fieldErrors ?? {}).map(([name, message]) => [
      name.startsWith(`${TAGS_FIELD}.`) ? TAGS_FIELD : name,
      message,
    ]),
  );
  let state: ImportState =
    Object.keys(fieldErrors).length === 0 ? base : { ...base, fieldErrors: Object.freeze(fieldErrors) };
  const reason = detailText(error.details, "reason");
  switch (error.code) {
    case "ORDER_ALREADY_IMPORTED": {
      const booking = existingBookingOf(error.details);
      state =
        booking === undefined
          ? said(state, STRINGS.alreadyImportedUnnamed)
          : { ...said(state, STRINGS.alreadyImported(booking.reference)), booking };
      break;
    }
    case "OFFICE_NOT_ALLOWED":
      state = said(state, STRINGS.officeNotAllowed);
      break;
    case "CONFLICT":
      if (reason === "customer_deleted") {
        state = said(state, STRINGS.customerDeleted, CUSTOMER_FIELD);
      } else if (reason === "customer_disabled") {
        state = said(state, STRINGS.customerDisabled, CUSTOMER_FIELD);
      } else if (reason === "idempotency_key_in_use") {
        state = said(state, STRINGS.busy);
      }
      break;
    case "NOT_FOUND": {
      // Amadeus's 404 carries `error.supplier`; the customer's does not.
      const { supplier } = error as { readonly supplier?: unknown };
      const fromSupplier = typeof supplier === "object" && supplier !== null;
      state =
        !fromSupplier && values[CUSTOMER_FIELD] !== undefined
          ? said(state, STRINGS.customerNotFound, CUSTOMER_FIELD)
          : said(state, STRINGS.orderNotFound);
      break;
    }
    case "UNPROCESSABLE":
      if (reason === "contact_email_required") {
        state = said(state, STRINGS.contactEmailRequired, CONTACT_EMAIL_FIELD);
      } else if (reason === "currency_mismatch") {
        state = said(
          state,
          STRINGS.currencyMismatch(detailText(error.details, "currency")),
          SELLING_TOTAL_FIELD,
        );
      } else if (reason === "selling_below_net") {
        state = said(state, STRINGS.sellingBelowNet(detailMoney(error.details, "net")), SELLING_TOTAL_FIELD);
      } else if (reason === "several_orders") {
        state = said(state, STRINGS.severalOrders);
      }
      break;
    case "SUPPLIER_TIMEOUT":
      state = said(state, STRINGS.supplierTimeout);
      break;
    default:
      break;
  }
  return withNextActionKey(state, error);
}

/** The staff context of an action, or the state of its refusal (a missing permission, an ended or refused session). */
async function staffFor(
  permission: StaffPermission,
): Promise<{ readonly context: StaffContext } | { readonly state: ActionState }> {
  try {
    return { context: await requireStaff(permission) };
  } catch (error) {
    return { state: fromVelexisError(error) };
  }
}

/** The API's warnings of an answer (`warnings[]`: a confirmation that could not be queued), as sentences. */
function warningsOf(booking: Pick<ConsoleBooking, "warnings">): string[] {
  return (booking.warnings ?? [])
    .map((warning) => warning.detail ?? warning.title)
    .filter((note): note is string => typeof note === "string" && note !== "");
}

// ---- importBooking --------------------------------------------------------------------------------------------------

/**
 * "Import" of a match (`console.bookings.import`, `bookings:write`): the order of the match (`flightOrderId`) as a
 * booking of the OTA with the chosen pricing, customer or contact e-mail, confirmation, tags, note and reason, under the
 * dialog's idempotency key. A success answers the new booking (the dialog opens it, or stays with the API's warnings)
 * and revalidates no path; the file header says why, and lists the refusals.
 */
export async function importBooking(_state: ActionState, form: FormData): Promise<ImportState> {
  const staff = await staffFor("bookings:write");
  if ("state" in staff) {
    return staff.state;
  }
  const parsed = ImportForm.safeParse(importFormInput(form));
  if (!parsed.success) {
    return invalid(parsed.error);
  }
  const values = parsed.data;

  let booking: ConsoleBooking;
  try {
    booking = await staff.context.console.bookings.import(importParams(values), {
      idempotencyKey: values[ACTION_KEY_FIELD],
    });
  } catch (error) {
    return importFailure(error, values);
  }
  const warnings = warningsOf(booking);
  const message = [STRINGS.imported(booking.reference), ...warnings].join(" ");
  return {
    ok: true,
    message,
    booking: { id: booking.id, reference: booking.reference },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

// ---- searchCustomers ------------------------------------------------------------------------------------------------

/** The name of a customer as the dialog lists it, or `null` when the account has none. */
function customerName(first: string | null, last: string | null): string | null {
  const name = [first, last]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(" ");
  return name === "" ? null : name;
}

/**
 * The import dialog's customer search (`console.customers.list`, `customers:read`): active accounts whose e-mail, first
 * or last name starts with `query`, at most 8. A server action is a public endpoint, so the query is checked here as
 * the API would (2 to 100 characters) before any call.
 */
export async function searchCustomers(query: unknown): Promise<CustomerSearchState> {
  const q = typeof query === "string" ? query.trim() : "";
  const length = [...q].length;
  if (length < CUSTOMER_QUERY_MIN_LENGTH) {
    return { ok: false, message: STRINGS.queryTooShort };
  }
  if (length > CUSTOMER_QUERY_MAX_LENGTH) {
    return { ok: false, message: STRINGS.queryTooLong };
  }
  const staff = await staffFor("customers:read");
  if ("state" in staff) {
    return { ok: false, message: staff.state.message ?? STRINGS.customer };
  }
  try {
    const page = await staff.context.console.customers.list({
      q,
      status: ["active"],
      limit: CUSTOMER_SEARCH_LIMIT,
    });
    const customers: CustomerChoice[] = page.data.map((customer) => ({
      id: customer.id,
      email: customer.email,
      name: customerName(customer.firstName, customer.lastName),
    }));
    return { ok: true, customers };
  } catch (error) {
    const state = fromVelexisError(error);
    return {
      ok: false,
      message: state.message ?? STRINGS.customer,
      ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
    };
  }
}

// ---- The Advanced panel's raw reads (OAD-010) -----------------------------------------------------------------------

/** What a raw read of the Advanced panel answers: Amadeus's verbatim answer with the call's facts, or the refusal. */
export type RawReadState<Result> =
  | { readonly ok: true; readonly result: Result }
  | (ActionState & { readonly ok: false; readonly message: string });

export type RawOrdersState = RawReadState<ConsoleAmadeusFlightOrdersByReferenceResult>;
export type RawOrderState = RawReadState<ConsoleAmadeusFlightOrderResult>;

/**
 * An Amadeus order id as consoleAmadeusGetFlightOrder takes it in its path (`flightOrderId` of the OTA document: 8 to
 * 200 letters, digits, `=`, `_` or `-`); the API refuses any other value with `400 VALIDATION_FAILED`.
 */
const FLIGHT_ORDER_ID_PATTERN = /^[A-Za-z0-9=_-]{8,200}$/;

const RAW_STRINGS = Object.freeze({
  invalidReference: "Enter 5 to 8 letters and digits, like L2P9XC.",
  invalidOrder:
    "The API cannot read this order id: it takes 8 to 200 letters, digits, equals signs, underscores or hyphens.",
  noOrders: "No order with this record locator in your offices.",
  noOrder: "Amadeus has no order with this id (any more).",
  officeNotAllowed:
    "This order belongs to an Amadeus office outside this OTA: Velexis shows only the orders of its own offices.",
});

/** The state of a failed raw read: lib/errors.ts's message (or this panel's words) and the request id. */
function rawFailure(error: unknown, notFound: string): RawReadState<never> {
  const state = fromVelexisError(error);
  const code = isVelexisErrorLike(error) ? error.code : undefined;
  const message =
    code === "NOT_FOUND"
      ? notFound
      : code === "OFFICE_NOT_ALLOWED"
        ? RAW_STRINGS.officeNotAllowed
        : (state.message ?? GENERIC_ERROR_MESSAGE);
  return { ...state, ok: false, message };
}

/** A refused raw read: no session, no permission, or a value the API would refuse. */
async function rawReader(): Promise<
  { readonly context: StaffContext } | { readonly state: RawReadState<never> }
> {
  const staff = await staffFor("amadeus:read");
  return "state" in staff
    ? { state: { ...staff.state, ok: false, message: staff.state.message ?? GENERIC_ERROR_MESSAGE } }
    : staff;
}

/**
 * "Read the raw orders" of the Advanced panel: Get Flight Order By Record Locator (`console.amadeus.getFlightOrderByReference`,
 * `amadeus:read`, origin system `GDS`): the verbatim orders of the OTA's offices with the record locator, and which of them
 * are bookings of this OTA (`matches`). Net prices.
 */
export async function readRawOrders(reference: unknown): Promise<RawOrdersState> {
  const staff = await rawReader();
  if ("state" in staff) {
    return staff.state;
  }
  const value = typeof reference === "string" ? normalizeRecordLocator(reference) : "";
  if (!RECORD_LOCATOR_PATTERN.test(value)) {
    return { ok: false, code: "VALIDATION_FAILED", message: RAW_STRINGS.invalidReference };
  }
  try {
    return {
      ok: true,
      result: await staff.context.console.amadeus.getFlightOrderByReference({ reference: value }),
    };
  } catch (error) {
    return rawFailure(error, RAW_STRINGS.noOrders);
  }
}

/**
 * "Read this order" of the Advanced panel: Flight Order Management GET (`console.amadeus.getFlightOrder`, `amadeus:read`)
 * of one order of the lookup: the verbatim order, the booking of this OTA attached to it, if any. It changes no booking.
 * Net prices.
 */
export async function readRawOrder(flightOrderId: unknown): Promise<RawOrderState> {
  const staff = await rawReader();
  if ("state" in staff) {
    return staff.state;
  }
  if (typeof flightOrderId !== "string" || !FLIGHT_ORDER_ID_PATTERN.test(flightOrderId)) {
    return { ok: false, code: "VALIDATION_FAILED", message: RAW_STRINGS.invalidOrder };
  }
  try {
    return { ok: true, result: await staff.context.console.amadeus.getFlightOrder({ flightOrderId }) };
  } catch (error) {
    return rawFailure(error, RAW_STRINGS.noOrder);
  }
}
