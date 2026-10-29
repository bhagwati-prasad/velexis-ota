// The server actions of a booking's page (OAD-008; routes.md §3.2 "Actions", README §7, OADR-0018 points 4, 5 and 8):
// everything staff change on one booking, each through the SDK's console namespace with the client `requireStaff`
// hands back (the staff token of the request, the service key, the environment of the switch, the end-user headers).
//
//   patchBooking     console.bookings.patch     bookings:write     one traveller, one contact, a new remark, or the
//                                                                    ticketing agreement; `ifMatch`; a contact goes
//                                                                    whole, the dialog's values over the stored one
//   issueTickets     console.bookings.issue     bookings:issue     `ifMatch`, idempotency key; `allowUnpaid` for owner
//                                                                    and admin only; an airline-card booking only with an
//                                                                    `other` form of payment `CASH` or `ACCOUNT`
//   cancelBooking    console.bookings.cancel    bookings:cancel    `ifMatch`, idempotency key; refund `none`, `full`,
//                                                                    `amount`
//   resyncBooking    console.bookings.resync    bookings:write     answers the `changes`
//   addNote          console.bookings.addNote   bookings:write     idempotency key; internal unless asked
//   capturePayment   console.payments.capture   payments:capture   `ifMatch` = the payment's version, idempotency key
//   refundPayment    console.payments.refund    payments:refund    idempotency key; never an airline card
//
// Every action starts with `requireStaff(permission)` (a forged POST fails before any call; the API decides and audits
// all the same), then validates the form with Zod, then makes one call. The idempotency key is the dialog's hidden
// `actionKey`, rendered once with the page, so a double submit or a retry replays the same action instead of issuing,
// cancelling, capturing or refunding twice; a patch has no key in the contract (`If-Match` makes its replay a `412`).
// When the call of a keyed action (issue, cancel, note, capture, refund) ends in a final refusal that the API stores
// under the key (a stored `4xx` but `412`; `429` and a request still running under the key are not stored), its state
// brings a new key (`keyedFailure`: lib/action-state.ts `withNextActionKey`, `crypto.randomUUID()` here on the server),
// which the dialog or form sends next, so a corrected resubmission is a new request; after `412`, `429`, `5xx`, a
// timeout or a network error the key stays, so a retry replays or waits for the first request (OADR-0018 point 5,
// revision of 2026-10-27, FIX-W31-OTA). After `409 IDEMPOTENCY_KEY_REUSED` the key stays too and the message asks for a
// reload (revision of 2026-10-28, FIX-W32-OTA): an earlier request under the key may still be running, and a new key
// could refund or capture twice. A refusal before the call (the form's schema, a permission) used no key and keeps it.
// A refund above what can still be refunded says the API's `details.refundable` (FIX-W32-OTA), and so does the cancel
// dialog's refund amount (FIX-W33-OTA).
// Known API codes are answered here as the action's state (README §7, routes.md §1: messages of lib/errors.ts, some in
// this action's own words, `fieldErrors` mapped to the dialog's fields, the request id), never thrown to `error.tsx`;
// only Next.js's redirects (an ended session) and bugs are thrown. A success revalidates the booking's page, whose new
// render brings new idempotency keys.
//
// No card data: no action reads a card field, and the only form of payment an action builds is an `other` one of the
// OTA's settlement with the airline (OADR-0018 point 8). Nothing here logs.
"use server";

import type {
  ConsoleBooking,
  ConsoleBookingResyncResult,
  ConsolePatchBookingParams,
  StaffPermission,
} from "@velexis/ota-sdk";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  AGREEMENT_DELAY_PATTERN,
  AGREEMENT_OPTIONS,
  ALLOW_UNPAID_FIELD,
  AMOUNT_FIELD,
  BOOKING_ID_FIELD,
  CANCEL_REASON_CODES,
  CONTACT_PURPOSES,
  CURRENCY_FIELD,
  FLIGHT_OFFER_ID_PATTERN,
  FLIGHT_OFFERS_FIELD,
  GENDERS,
  KEPT_FIELD,
  KEPT_MAX_LENGTH,
  NOTE_TEXT_FIELD,
  NOTE_VISIBLE_FIELD,
  NOTIFY_FIELD,
  PATCH_ELEMENT_FIELD,
  PATCH_ELEMENTS,
  PATCH_FIELDS,
  PAYMENT_ID_FIELD,
  PHONE_DEVICE_TYPES,
  REASON_CODE_FIELD,
  REFUND_MODE_FIELD,
  REFUND_REASON_FIELD,
  REFUND_REASONS,
  REMARK_TYPES,
  SETTLEMENT_FIELD,
  SETTLEMENT_METHODS,
  TYPED_AMOUNT_PATTERN,
  VERSION_FIELD,
  canAllowUnpaid,
  isPositiveAmount,
  valuesOf,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { formatMoney, type MoneyValue } from "@/components/money";
import {
  ACTION_KEY_FIELD,
  REASON_FIELD,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  actionFailure,
  actionSuccess,
  fromZod,
  withNextActionKey,
  type ActionState,
} from "@/lib/action-state";
import { fromVelexisError, isVelexisErrorLike } from "@/lib/errors";
import { requireStaff, type StaffContext } from "@/lib/session";

// ---- States ---------------------------------------------------------------------------------------------------------

/** One difference a resync applied, as the page shows it (`ConsoleSyncChange` with its values as short text). */
export interface SyncChangeView {
  readonly path: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

/** The state of `resyncBooking`: the action's state and, after a success, the differences it applied. */
export interface ResyncState extends ActionState {
  readonly changes?: readonly SyncChangeView[];
}

// ---- Messages -------------------------------------------------------------------------------------------------------

/** Words of this page for codes (or `CODE:details.reason`) whose catalogue message says too little here. */
const STRINGS = Object.freeze({
  staleForm: "This form is out of date. Reload the page and try again.",
  alreadyIssued: "The tickets of this booking are already issued. Reload the page to see them.",
  alreadyCancelled: "This booking is already cancelled. Reload the page to see its current state.",
  ticketingInProgress: "Tickets are being issued for this booking right now. Reload the page in a moment.",
  cancellationPending: "A cancellation of this booking is still being decided. Reload the page in a moment.",
  flown: "A flight of this booking has departed: it cannot be cancelled from the console.",
  busy: "Another change of this booking is running. Send the same form again in a moment.",
  paymentRequired:
    "The payment is not captured. Capture it first, or ask an owner or an admin to issue the booking unpaid.",
  authorisationExpired: "The authorisation has expired; contact the traveller.",
  providerError: "Stripe did not answer. Send the same form again: the payment is captured once.",
  allowUnpaidRole: "Only an owner or an admin may issue a booking that is not paid.",
  refundViaAirline:
    "The airline charged this card: it is refunded by the airline, not from the console. Refund nothing here.",
  amountExceedsCaptured: "The amount is above what can still be refunded. Reload the page to see it.",
  /** A refund above what can still be refunded, with the API's figure (`details.refundable`, FIX-W32-OTA). */
  amountExceedsRefundable: (refundable: string) =>
    `The amount is above what can still be refunded: at most ${refundable}.`,
  amountExceedsAuthorized: "The amount is above the authorised amount.",
  currencyMismatch: "The amount must be in the payment's currency.",
  notRefundable: "This payment cannot be refunded in its current state. Reload the page.",
  notCapturable: "This payment can no longer be captured in its current state. Reload the page.",
  cancelRejected:
    "Amadeus refused the cancellation: the tickets can no longer be voided. Cancel and refund with the airline.",
  // Successes
  patched: "Saved to the Amadeus order.",
  issued: "Tickets issued.",
  issueRecorded: (status: string) =>
    `The issuance was recorded: ticketing is now ${status.replaceAll("_", " ")}.`,
  cancelled: "Booking cancelled.",
  cancelPending: "Cancellation sent: Amadeus's answer is not known yet. Reload the page in a moment.",
  resynced: (count: number) =>
    count === 0
      ? "Synchronised with Amadeus: nothing changed."
      : `Synchronised with Amadeus: ${count} change${count === 1 ? "" : "s"}.`,
  noteAdded: "Note added.",
  captured: (amount: string) => `Captured ${amount}.`,
  refundRequested: (amount: string) => `Refund of ${amount} requested: Stripe completes it.`,
});

/** A message of an override: fixed, or built from the error's `details` (an amount the API answered, say). */
type OverrideMessage = string | ((details: Readonly<Record<string, unknown>>) => string);

/** Overrides of the message (and the field it belongs to) by `CODE` or `CODE:details.reason`. */
type Overrides = Readonly<
  Record<string, OverrideMessage | { readonly message: OverrideMessage; readonly field: string }>
>;

/** The text of an override's message for an error with `details`. */
function overrideText(message: OverrideMessage, details: Readonly<Record<string, unknown>>): string {
  return typeof message === "string" ? message : message(details);
}

/** The overrides every booking action shares. */
const BOOKING_OVERRIDES: Overrides = Object.freeze({
  ALREADY_ISSUED: STRINGS.alreadyIssued,
  BOOKING_ALREADY_CANCELLED: STRINGS.alreadyCancelled,
  "BOOKING_NOT_MODIFIABLE:ticketing_in_progress": STRINGS.ticketingInProgress,
  "BOOKING_NOT_MODIFIABLE:cancellation_pending": STRINGS.cancellationPending,
  "BOOKING_NOT_MODIFIABLE:pending": STRINGS.cancellationPending,
  "BOOKING_NOT_MODIFIABLE:flown": STRINGS.flown,
  SERVICE_UNAVAILABLE: STRINGS.busy,
});

/** The fields that are hidden in the dialogs: a problem with them means the page is out of date. */
const HIDDEN_FIELDS: ReadonlySet<string> = new Set([
  BOOKING_ID_FIELD,
  VERSION_FIELD,
  PAYMENT_ID_FIELD,
  ACTION_KEY_FIELD,
  FLIGHT_OFFERS_FIELD,
  CURRENCY_FIELD,
  PATCH_ELEMENT_FIELD,
  PATCH_FIELDS.travelerId,
  PATCH_FIELDS.purpose,
  PATCH_FIELDS.language,
  KEPT_FIELD,
]);

/** The state of a form that failed its schema; a hidden field's problem (`kept.phones.0` too) asks for a reload. */
function invalid(error: z.ZodError): ActionState {
  const state = fromZod(error);
  const hidden = Object.keys(state.fieldErrors ?? {}).some((name) =>
    HIDDEN_FIELDS.has(name.split(".")[0] ?? name),
  );
  return hidden ? { ...state, message: STRINGS.staleForm } : state;
}

/**
 * The state of a failed SDK call: lib/errors.ts's message and field errors (`fields`: the API's pointers to the
 * dialog's field names), the request id, and this action's own words for the codes of `overrides`. Redirects and bugs
 * are thrown again (`fromVelexisError`).
 */
function failure(
  error: unknown,
  fields: Readonly<Record<string, string>>,
  overrides: Overrides,
): ActionState {
  const state = fromVelexisError(error, { fields });
  if (!isVelexisErrorLike(error)) {
    return state;
  }
  const reason = error.details?.["reason"];
  const override =
    (typeof reason === "string" ? overrides[`${error.code}:${reason}`] : undefined) ?? overrides[error.code];
  if (override === undefined) {
    return state;
  }
  const details = error.details ?? {};
  if (typeof override === "string" || typeof override === "function") {
    return { ...state, message: overrideText(override, details) };
  }
  const message = overrideText(override.message, details);
  return {
    ...state,
    message,
    fieldErrors: { ...state.fieldErrors, [override.field]: message },
  };
}

/**
 * `failure` of a call that carried the form's idempotency key: with a new key for the next submission when the API
 * stored its answer under the key or refused the key (`withNextActionKey`, see the file header).
 */
function keyedFailure(
  error: unknown,
  fields: Readonly<Record<string, string>>,
  overrides: Overrides,
): ActionState {
  const state = failure(error, fields, overrides);
  return isVelexisErrorLike(error) ? withNextActionKey(state, error) : state;
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

/** The API's warnings of an answer (`warnings[]`: notifications not sent, an order Amadeus no longer had), as text. */
function withWarnings(message: string, booking: Pick<ConsoleBooking, "warnings">): string {
  const notes = (booking.warnings ?? [])
    .map((warning) => warning.detail ?? warning.title)
    .filter((note): note is string => typeof note === "string" && note !== "");
  return notes.length === 0 ? message : `${message} ${notes.join(" ")}`;
}

/** An amount as a sentence shows it. */
function moneyText(value: MoneyValue): string {
  return formatMoney(value) ?? `${value.amount} ${value.currency}`;
}

/** Revalidates the booking's page, every tab of it (the next render brings new idempotency keys). */
function revalidateBooking(bookingId: string): void {
  revalidatePath(`/bookings/${bookingId}`);
}

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

const BookingId = z
  .string({ required_error: STRINGS.staleForm })
  .regex(/^bkg_[0-9A-Za-z]{16,40}$/, STRINGS.staleForm);
const PaymentId = z
  .string({ required_error: STRINGS.staleForm })
  .regex(/^pay_[0-9A-Za-z]{16,40}$/, STRINGS.staleForm);
/** The version the page displayed: a whole number (`ifMatch`, sent as its ETag `"<n>"`). */
const Version = z
  .string({ required_error: STRINGS.staleForm })
  .regex(/^(?:0|[1-9][0-9]{0,14})$/, STRINGS.staleForm)
  .transform(Number);
/** The dialog's idempotency key (`crypto.randomUUID()` of the page). */
const ActionKey = z.string({ required_error: STRINGS.staleForm }).uuid(STRINGS.staleForm);
/** The staff action's reason: 3 to 500 characters after trimming, counted as the API counts (code points). */
const Reason = z
  .string({ required_error: "Enter a reason." })
  .trim()
  .refine((value) => [...value].length > 0, "Enter a reason.")
  .refine(
    (value) => [...value].length >= REASON_MIN_LENGTH,
    `Enter at least ${REASON_MIN_LENGTH} characters.`,
  )
  .refine((value) => [...value].length <= REASON_MAX_LENGTH, `Use at most ${REASON_MAX_LENGTH} characters.`);
/** An amount staff typed: digits with at most two decimals, above zero. */
const TypedAmount = z
  .string({ required_error: "Enter an amount." })
  .trim()
  .refine((value) => value !== "", "Enter an amount.")
  .refine((value) => TYPED_AMOUNT_PATTERN.test(value), "Enter an amount like 120.50.")
  .refine(isPositiveAmount, "Enter an amount above zero.");
const Currency = z.string({ required_error: STRINGS.staleForm }).regex(/^[A-Z]{3}$/, STRINGS.staleForm);
/** An optional text: blank is absent. */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

// ---- patchBooking ---------------------------------------------------------------------------------------------------

const NAME = z.string().trim().min(1, "Required.").max(60, "Use at most 60 characters.");
const PHONE_COUNTRY = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{1,3}$/, "Enter the country calling code, like 47 or +1.");
const PHONE_NUMBER = z
  .string()
  .trim()
  .regex(/^[0-9]{1,15}$/, "Enter digits only, at most 15.");
const EMAIL = z.string().trim().email("Enter an e-mail address.").max(120, "Use at most 120 characters.");

/** A text of the stored contact (`kept`): what the order holds, bounded; the API checks it again. */
const KEPT_TEXT = z.string().max(500);
/** The stored contact the traveller and contact dialogs post (action-rules.ts `KeptContact`, `keptContactOf`). */
const KeptContactSchema = z
  .object({
    addresseeName: z
      .object({
        firstName: KEPT_TEXT.optional(),
        middleName: KEPT_TEXT.optional(),
        lastName: KEPT_TEXT.optional(),
        secondLastName: KEPT_TEXT.optional(),
      })
      .strict()
      .optional(),
    companyName: KEPT_TEXT.optional(),
    emailAddress: KEPT_TEXT.optional(),
    phones: z
      .array(
        z
          .object({
            deviceType: z.enum(PHONE_DEVICE_TYPES).optional(),
            countryCallingCode: KEPT_TEXT.optional(),
            number: KEPT_TEXT.optional(),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    address: z
      .object({
        lines: z.array(KEPT_TEXT).max(10).optional(),
        postalCode: KEPT_TEXT.optional(),
        countryCode: KEPT_TEXT.optional(),
        cityName: KEPT_TEXT.optional(),
        stateName: KEPT_TEXT.optional(),
        postalBox: KEPT_TEXT.optional(),
      })
      .strict()
      .optional(),
    language: KEPT_TEXT.optional(),
    purpose: z.enum(valuesOf(CONTACT_PURPOSES)).optional(),
  })
  .strict();
type KeptValue = z.infer<typeof KeptContactSchema>;

/** The hidden `kept` (JSON of the stored contact); anything else means the form is out of date. */
const Kept = z
  .string()
  .max(KEPT_MAX_LENGTH, STRINGS.staleForm)
  .transform((text, context): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: STRINGS.staleForm });
      return z.NEVER;
    }
  })
  .pipe(KeptContactSchema);

const PatchBase = {
  bookingId: BookingId,
  version: Version,
  reason: Reason,
  notifyCustomer: z.boolean(),
};

/** A phone of a traveller or a contact: both parts or neither. */
const phoneParts = {
  phoneCountryCode: optional(PHONE_COUNTRY),
  phoneNumber: optional(PHONE_NUMBER),
};

const PatchForm = z.discriminatedUnion("element", [
  z
    .object({
      ...PatchBase,
      element: z.literal("traveler"),
      travelerId: z
        .string({ required_error: STRINGS.staleForm })
        .regex(/^[0-9A-Za-z-]{1,20}$/, STRINGS.staleForm),
      firstName: NAME,
      lastName: NAME,
      dateOfBirth: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.")),
      gender: optional(z.enum(valuesOf(GENDERS), { message: "Choose a gender." })),
      email: optional(EMAIL),
      ...phoneParts,
      kept: optional(Kept),
    })
    .strict(),
  z
    .object({
      ...PatchBase,
      element: z.literal("contact"),
      purpose: z.enum(valuesOf(CONTACT_PURPOSES), { message: STRINGS.staleForm }),
      firstName: optional(NAME),
      lastName: optional(NAME),
      companyName: optional(z.string().trim().max(60, "Use at most 60 characters.")),
      email: optional(EMAIL),
      ...phoneParts,
      addressLine1: optional(z.string().trim().max(70, "Use at most 70 characters.")),
      addressLine2: optional(z.string().trim().max(70, "Use at most 70 characters.")),
      postalCode: optional(z.string().trim().max(17, "Use at most 17 characters.")),
      cityName: optional(
        z
          .string()
          .trim()
          .regex(/^[a-zA-Z -]{1,35}$/, "Letters, spaces and hyphens, at most 35."),
      ),
      countryCode: optional(
        z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/, "Enter a two-letter country code."),
      ),
      language: optional(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/, STRINGS.staleForm)),
      kept: optional(Kept),
    })
    .strict(),
  z
    .object({
      ...PatchBase,
      element: z.literal("remark"),
      remarkType: z.enum(valuesOf(REMARK_TYPES), { message: "Choose a remark type." }),
      remarkText: z.string().trim().min(1, "Enter the remark.").max(200, "Use at most 200 characters."),
    })
    .strict(),
  z
    .object({
      ...PatchBase,
      element: z.literal("ticketingAgreement"),
      agreementOption: z.enum(valuesOf(AGREEMENT_OPTIONS), { message: "Choose an option." }),
      agreementDelay: optional(
        z.string().trim().toUpperCase().regex(AGREEMENT_DELAY_PATTERN, "Enter whole days, like 2D."),
      ),
    })
    .strict(),
]);

type PatchInput = z.infer<typeof PatchForm>;

/** The form fields of each patch element. */
const PATCH_ELEMENT_FIELDS: Readonly<Record<PatchInput["element"], readonly string[]>> = {
  traveler: [
    PATCH_FIELDS.travelerId,
    PATCH_FIELDS.firstName,
    PATCH_FIELDS.lastName,
    PATCH_FIELDS.dateOfBirth,
    PATCH_FIELDS.gender,
    PATCH_FIELDS.email,
    PATCH_FIELDS.phoneCountryCode,
    PATCH_FIELDS.phoneNumber,
    KEPT_FIELD,
  ],
  contact: [
    PATCH_FIELDS.purpose,
    PATCH_FIELDS.firstName,
    PATCH_FIELDS.lastName,
    PATCH_FIELDS.companyName,
    PATCH_FIELDS.email,
    PATCH_FIELDS.phoneCountryCode,
    PATCH_FIELDS.phoneNumber,
    PATCH_FIELDS.addressLine1,
    PATCH_FIELDS.addressLine2,
    PATCH_FIELDS.postalCode,
    PATCH_FIELDS.cityName,
    PATCH_FIELDS.countryCode,
    PATCH_FIELDS.language,
    KEPT_FIELD,
  ],
  remark: [PATCH_FIELDS.remarkType, PATCH_FIELDS.remarkText],
  ticketingAgreement: [PATCH_FIELDS.agreementOption, PATCH_FIELDS.agreementDelay],
};

/** The patch form's values: the element's own fields only, so a field of another element is never read. */
function patchValues(form: FormData): Record<string, unknown> {
  const element = textOf(form, PATCH_ELEMENT_FIELD);
  const fields = PATCH_ELEMENTS.find((candidate) => candidate === element);
  const values: Record<string, unknown> = {
    element,
    bookingId: textOf(form, BOOKING_ID_FIELD),
    version: textOf(form, VERSION_FIELD),
    reason: textOf(form, REASON_FIELD),
    notifyCustomer: checked(form, NOTIFY_FIELD),
  };
  for (const name of fields === undefined ? [] : PATCH_ELEMENT_FIELDS[fields]) {
    values[name] = textOf(form, name);
  }
  return values;
}

/** The properties of `value` that are set (Zod types an absent optional property as `undefined`, the API's types do not). */
function present<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, part]) => part !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * The phones of a contact: the dialog's phone in place of the stored first phone, with that phone's device type (`MOBILE`
 * when it had none), then the stored contact's other phones as they were; the dialog's phone left empty removes the
 * first. One part alone is refused before the call. The country calling code goes as staff typed it, with or without its
 * `+` (lead decision (1) of 2026-10-26: one to three digits, sent to Amadeus as given, so the `1` of North America is a
 * code too).
 */
function phonesOf(
  input: { phoneCountryCode?: string | undefined; phoneNumber?: string | undefined },
  stored: KeptValue["phones"],
) {
  const typed =
    input.phoneCountryCode === undefined || input.phoneNumber === undefined
      ? []
      : [
          {
            deviceType: stored?.[0]?.deviceType ?? ("MOBILE" as const),
            countryCallingCode: input.phoneCountryCode,
            number: input.phoneNumber,
          },
        ];
  const phones = [...typed, ...(stored ?? []).slice(1).map((phone) => present(phone))];
  return phones.length === 0 ? undefined : phones;
}

/** The parts of a stored contact the traveller dialog does not show, as the API takes them. */
function keptTravelerContactOf(kept: KeptValue) {
  const { addresseeName, address } = kept;
  return present({
    addresseeName: addresseeName === undefined ? undefined : present(addresseeName),
    companyName: kept.companyName,
    address: address === undefined ? undefined : present(address),
    language: kept.language,
    purpose: kept.purpose,
  });
}

/**
 * The PATCH body of one element (see the file header); the merge options keep their defaults (merge, add). A traveller's
 * `contact` and an order contact go whole, the dialog's values over the stored contact (`kept`): the API replaces them.
 */
function patchBodyOf(input: PatchInput): Omit<ConsolePatchBookingParams, "bookingId" | "ifMatch"> {
  const common = { reason: input.reason, notifyCustomer: input.notifyCustomer };
  switch (input.element) {
    case "traveler": {
      const kept = input.kept ?? {};
      const phones = phonesOf(input, kept.phones);
      const contact = {
        ...keptTravelerContactOf(kept),
        ...(input.email === undefined ? {} : { emailAddress: input.email }),
        ...(phones === undefined ? {} : { phones }),
      };
      return {
        ...common,
        travelers: [
          {
            id: input.travelerId,
            name: { firstName: input.firstName, lastName: input.lastName },
            ...(input.dateOfBirth === undefined ? {} : { dateOfBirth: input.dateOfBirth }),
            ...(input.gender === undefined ? {} : { gender: input.gender }),
            ...(Object.keys(contact).length === 0 ? {} : { contact }),
          },
        ],
      };
    }
    case "contact": {
      const kept = input.kept ?? {};
      const phones = phonesOf(input, kept.phones);
      const storedAddress = kept.address ?? {};
      const lines = [
        ...[input.addressLine1, input.addressLine2].filter((line): line is string => line !== undefined),
        // The dialog shows the first two lines; the others stay.
        ...(storedAddress.lines ?? []).slice(2),
      ];
      const address = {
        ...(lines.length === 0 ? {} : { lines }),
        ...present({
          postalCode: input.postalCode,
          cityName: input.cityName,
          countryCode: input.countryCode?.toUpperCase(),
          stateName: storedAddress.stateName,
          postalBox: storedAddress.postalBox,
        }),
      };
      // The dialog shows the first and last name; a middle or second last name stays.
      const name = present({
        firstName: input.firstName,
        middleName: kept.addresseeName?.middleName,
        lastName: input.lastName,
        secondLastName: kept.addresseeName?.secondLastName,
      });
      const language = input.language ?? kept.language;
      return {
        ...common,
        contacts: [
          {
            purpose: input.purpose,
            ...(Object.keys(name).length === 0 ? {} : { addresseeName: name }),
            ...(input.companyName === undefined ? {} : { companyName: input.companyName }),
            ...(input.email === undefined ? {} : { emailAddress: input.email }),
            ...(phones === undefined ? {} : { phones }),
            ...(Object.keys(address).length === 0 ? {} : { address }),
            ...(language === undefined ? {} : { language }),
          },
        ],
      };
    }
    case "remark":
      return { ...common, remarks: { general: [{ subType: input.remarkType, text: input.remarkText }] } };
    case "ticketingAgreement":
      return {
        ...common,
        ticketingAgreement: {
          option: input.agreementOption,
          ...(input.agreementOption === "CONFIRM" || input.agreementDelay === undefined
            ? {}
            : { delay: input.agreementDelay }),
        },
      };
  }
}

/** The API's pointers of a patch, to the dialog's fields. */
const PATCH_POINTERS: Readonly<Record<string, string>> = Object.freeze({
  "/travelers/0/id": PATCH_FIELDS.travelerId,
  "/travelers/0/name/firstName": PATCH_FIELDS.firstName,
  "/travelers/0/name/lastName": PATCH_FIELDS.lastName,
  "/travelers/0/dateOfBirth": PATCH_FIELDS.dateOfBirth,
  "/travelers/0/gender": PATCH_FIELDS.gender,
  "/travelers/0/contact/emailAddress": PATCH_FIELDS.email,
  "/travelers/0/contact/phones/0/countryCallingCode": PATCH_FIELDS.phoneCountryCode,
  "/travelers/0/contact/phones/0/number": PATCH_FIELDS.phoneNumber,
  "/contacts/0/addresseeName/firstName": PATCH_FIELDS.firstName,
  "/contacts/0/addresseeName/lastName": PATCH_FIELDS.lastName,
  "/contacts/0/companyName": PATCH_FIELDS.companyName,
  "/contacts/0/emailAddress": PATCH_FIELDS.email,
  "/contacts/0/phones/0/countryCallingCode": PATCH_FIELDS.phoneCountryCode,
  "/contacts/0/phones/0/number": PATCH_FIELDS.phoneNumber,
  "/contacts/0/address/lines/0": PATCH_FIELDS.addressLine1,
  "/contacts/0/address/lines/1": PATCH_FIELDS.addressLine2,
  "/contacts/0/address/postalCode": PATCH_FIELDS.postalCode,
  "/contacts/0/address/cityName": PATCH_FIELDS.cityName,
  "/contacts/0/address/countryCode": PATCH_FIELDS.countryCode,
  "/remarks/general/0/subType": PATCH_FIELDS.remarkType,
  "/remarks/general/0/text": PATCH_FIELDS.remarkText,
  "/ticketingAgreement/option": PATCH_FIELDS.agreementOption,
  "/ticketingAgreement/delay": PATCH_FIELDS.agreementDelay,
  "/reason": REASON_FIELD,
});

/**
 * Edit travellers, contacts, remarks and the ticketing agreement (`bookings:write`): one element per dialog, with
 * `ifMatch` = the version the page displayed (`412` asks for a reload). No idempotency key: the contract has none for
 * PATCH, and its `If-Match` makes a replay after a success a `412`.
 */
export async function patchBooking(_previous: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor("bookings:write");
  if ("state" in staff) {
    return staff.state;
  }
  const input = PatchForm.safeParse(patchValues(form));
  if (!input.success) {
    return invalid(input.error);
  }
  const { bookingId, version } = input.data;
  if (
    (input.data.element === "traveler" || input.data.element === "contact") &&
    phoneMissingPart(input.data)
  ) {
    return actionFailure("Enter both parts of the phone number, or neither.", {
      code: "VALIDATION_FAILED",
      fieldErrors: {
        [input.data.phoneCountryCode === undefined
          ? PATCH_FIELDS.phoneCountryCode
          : PATCH_FIELDS.phoneNumber]: "Required with the other part of the phone number.",
      },
    });
  }
  if (
    input.data.element === "ticketingAgreement" &&
    input.data.agreementOption !== "CONFIRM" &&
    input.data.agreementDelay === undefined
  ) {
    return actionFailure("Enter the delay in days.", {
      code: "VALIDATION_FAILED",
      fieldErrors: { [PATCH_FIELDS.agreementDelay]: "Required for this option." },
    });
  }
  let booking: ConsoleBooking;
  try {
    booking = await staff.context.console.bookings.patch({
      bookingId,
      ifMatch: version,
      ...patchBodyOf(input.data),
    });
  } catch (error) {
    return failure(error, PATCH_POINTERS, BOOKING_OVERRIDES);
  }
  revalidateBooking(bookingId);
  return actionSuccess(withWarnings(STRINGS.patched, booking));
}

/** One part of a phone without the other. */
function phoneMissingPart(input: {
  phoneCountryCode?: string | undefined;
  phoneNumber?: string | undefined;
}): boolean {
  return (input.phoneCountryCode === undefined) !== (input.phoneNumber === undefined);
}

// ---- issueTickets ---------------------------------------------------------------------------------------------------

const IssueForm = z
  .object({
    bookingId: BookingId,
    version: Version,
    actionKey: ActionKey,
    reason: Reason,
    notifyCustomer: z.boolean(),
    allowUnpaid: z.boolean(),
    settlement: optional(z.enum(valuesOf(SETTLEMENT_METHODS), { message: "Choose CASH or ACCOUNT." })),
    flightOfferIds: optional(
      z
        .string()
        .transform((value) => value.split(",").map((id) => id.trim()))
        .refine(
          (ids) => ids.length >= 1 && ids.length <= 6 && ids.every((id) => FLIGHT_OFFER_ID_PATTERN.test(id)),
          STRINGS.staleForm,
        ),
    ),
  })
  .superRefine((value, context) => {
    // The airline-card dialog sends the booking's flight offers: its issuance needs the OTA's settlement.
    if (value.flightOfferIds !== undefined && value.settlement === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [SETTLEMENT_FIELD],
        message: "Choose CASH or ACCOUNT.",
      });
    }
  });

const ISSUE_POINTERS: Readonly<Record<string, string>> = Object.freeze({
  "/formOfPayments": SETTLEMENT_FIELD,
  "/formOfPayments/0": SETTLEMENT_FIELD,
  "/formOfPayments/0/other/method": SETTLEMENT_FIELD,
  "/allowUnpaid": ALLOW_UNPAID_FIELD,
  "/reason": REASON_FIELD,
});

const ISSUE_OVERRIDES: Overrides = Object.freeze({
  ...BOOKING_OVERRIDES,
  PAYMENT_REQUIRED: STRINGS.paymentRequired,
  PAYMENT_DECLINED: STRINGS.authorisationExpired,
  PAYMENT_PROVIDER_ERROR: STRINGS.providerError,
});

/**
 * Issue tickets (`bookings:issue`): `ifMatch`, the dialog's idempotency key, `capturePayment: true` (an authorised
 * Stripe payment is captured first), `notifyCustomer`, and `allowUnpaid` only from an owner or an admin (refused here
 * before any call for another role; the API refuses it too). An airline-card booking's dialog sends the OTA's
 * settlement (`CASH` or `ACCOUNT`), which becomes the issuance's only form of payment: `other` for the booking's flight
 * offers. No other form of payment can be sent from here.
 */
export async function issueTickets(_previous: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor("bookings:issue");
  if ("state" in staff) {
    return staff.state;
  }
  const input = IssueForm.safeParse({
    bookingId: textOf(form, BOOKING_ID_FIELD),
    version: textOf(form, VERSION_FIELD),
    actionKey: textOf(form, ACTION_KEY_FIELD),
    reason: textOf(form, REASON_FIELD),
    notifyCustomer: checked(form, NOTIFY_FIELD),
    allowUnpaid: checked(form, ALLOW_UNPAID_FIELD),
    settlement: textOf(form, SETTLEMENT_FIELD),
    flightOfferIds: textOf(form, FLIGHT_OFFERS_FIELD),
  });
  if (!input.success) {
    return invalid(input.error);
  }
  const { bookingId, version, actionKey, reason, notifyCustomer, allowUnpaid, settlement, flightOfferIds } =
    input.data;
  if (allowUnpaid && !canAllowUnpaid(staff.context.staff.staff.role)) {
    return actionFailure(STRINGS.allowUnpaidRole, {
      code: "FORBIDDEN",
      fieldErrors: { [ALLOW_UNPAID_FIELD]: STRINGS.allowUnpaidRole },
    });
  }
  let booking: ConsoleBooking;
  try {
    booking = await staff.context.console.bookings.issue(
      {
        bookingId,
        ifMatch: version,
        reason,
        capturePayment: true,
        notifyCustomer,
        ...(allowUnpaid ? { allowUnpaid: true } : {}),
        ...(settlement === undefined
          ? {}
          : {
              formOfPayments: [{ other: { method: settlement, flightOfferIds: flightOfferIds ?? ["1"] } }],
            }),
      },
      { idempotencyKey: actionKey },
    );
  } catch (error) {
    return keyedFailure(error, ISSUE_POINTERS, ISSUE_OVERRIDES);
  }
  revalidateBooking(bookingId);
  const status = booking.ticketing.status;
  return actionSuccess(
    withWarnings(status === "issued" ? STRINGS.issued : STRINGS.issueRecorded(status), booking),
  );
}

// ---- cancelBooking --------------------------------------------------------------------------------------------------

const CancelForm = z
  .object({
    bookingId: BookingId,
    version: Version,
    actionKey: ActionKey,
    reason: Reason,
    reasonCode: z.enum(valuesOf(CANCEL_REASON_CODES), { message: "Choose a reason." }),
    refundMode: z.enum(["none", "full", "amount"], { message: "Choose what happens to the money." }),
    amount: optional(TypedAmount),
    currency: Currency,
    notifyCustomer: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.refundMode === "amount" && value.amount === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [AMOUNT_FIELD], message: "Enter an amount." });
    }
  });

const CANCEL_POINTERS: Readonly<Record<string, string>> = Object.freeze({
  "/reasonCode": REASON_CODE_FIELD,
  "/reason": REASON_FIELD,
  "/refund": REFUND_MODE_FIELD,
  "/refund/mode": REFUND_MODE_FIELD,
  "/refund/amount": AMOUNT_FIELD,
  "/refund/amount/amount": AMOUNT_FIELD,
  "/refund/amount/currency": AMOUNT_FIELD,
});

/** A `Money` of an error's `details` as the API answers it, or `undefined` when it is not one. */
function moneyOfDetail(value: unknown): MoneyValue | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { amount, currency } = value as Record<string, unknown>;
  return typeof amount === "string" &&
    /^[0-9]{1,12}(?:\.[0-9]{1,4})?$/.test(amount) &&
    typeof currency === "string" &&
    /^[A-Z]{3}$/.test(currency)
    ? { amount, currency }
    : undefined;
}

/**
 * A refund above what can still be refunded (`422 UNPROCESSABLE`, `amount_exceeds_captured`) says how much can (the
 * API's `details.refundable`: captured less refunded less the refunds still on their way to Stripe), so staff correct
 * the amount without a reload (FIX-W32-OTA, lead decision (1h) of 2026-10-28); without the figure, the reload message.
 * The cancel dialog's refund amount says it the same way since FIX-W33-OTA (lead decision (1f) of 2026-10-29):
 * console.bookings.cancel answers the same refusal with the same `details.refundable`.
 */
function refundableRefusal(details: Readonly<Record<string, unknown>>): string {
  const refundable = moneyOfDetail(details["refundable"]);
  return refundable === undefined
    ? STRINGS.amountExceedsCaptured
    : STRINGS.amountExceedsRefundable(moneyText(refundable));
}

const CANCEL_OVERRIDES: Overrides = Object.freeze({
  ...BOOKING_OVERRIDES,
  SUPPLIER_REJECTED: STRINGS.cancelRejected,
  "UNPROCESSABLE:refund_via_airline": { message: STRINGS.refundViaAirline, field: REFUND_MODE_FIELD },
  // The API's `details.refundable`, as the refund dialog says it (FIX-W33-OTA).
  "UNPROCESSABLE:amount_exceeds_captured": { message: refundableRefusal, field: AMOUNT_FIELD },
  "UNPROCESSABLE:amount_exceeds_authorized": {
    message: STRINGS.amountExceedsAuthorized,
    field: AMOUNT_FIELD,
  },
  "UNPROCESSABLE:currency_mismatch": { message: STRINGS.currencyMismatch, field: AMOUNT_FIELD },
});

/**
 * Cancel a booking (`bookings:cancel`): `ifMatch`, the dialog's idempotency key, the reason code and text, the refund
 * (`none`, `full`, or `amount` with an amount in the booking's currency) and `notifyCustomer`. What the refund modes
 * mean for an authorisation, a capture or an airline card is in action-rules.ts.
 */
export async function cancelBooking(_previous: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor("bookings:cancel");
  if ("state" in staff) {
    return staff.state;
  }
  const input = CancelForm.safeParse({
    bookingId: textOf(form, BOOKING_ID_FIELD),
    version: textOf(form, VERSION_FIELD),
    actionKey: textOf(form, ACTION_KEY_FIELD),
    reason: textOf(form, REASON_FIELD),
    reasonCode: textOf(form, REASON_CODE_FIELD),
    refundMode: textOf(form, REFUND_MODE_FIELD),
    // An amount belongs to mode `amount` only; any other mode leaves it out.
    amount: textOf(form, REFUND_MODE_FIELD) === "amount" ? (textOf(form, AMOUNT_FIELD) ?? "") : undefined,
    currency: textOf(form, CURRENCY_FIELD),
    notifyCustomer: checked(form, NOTIFY_FIELD),
  });
  if (!input.success) {
    return invalid(input.error);
  }
  const { bookingId, version, actionKey, reason, reasonCode, refundMode, amount, currency, notifyCustomer } =
    input.data;
  let booking: ConsoleBooking;
  try {
    booking = await staff.context.console.bookings.cancel(
      {
        bookingId,
        ifMatch: version,
        reasonCode,
        reason,
        refund:
          refundMode === "amount" && amount !== undefined
            ? { mode: "amount", amount: { amount, currency } }
            : { mode: refundMode },
        notifyCustomer,
      },
      { idempotencyKey: actionKey },
    );
  } catch (error) {
    return keyedFailure(error, CANCEL_POINTERS, CANCEL_OVERRIDES);
  }
  revalidateBooking(bookingId);
  return actionSuccess(
    withWarnings(booking.status === "cancelled" ? STRINGS.cancelled : STRINGS.cancelPending, booking),
  );
}

// ---- resyncBooking --------------------------------------------------------------------------------------------------

const ResyncForm = z.object({ bookingId: BookingId });

/** The longest value of a change the page shows. */
const CHANGE_VALUE_MAX_LENGTH = 200;

/** A value of a change as short text. */
function changeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "none";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > CHANGE_VALUE_MAX_LENGTH ? `${text.slice(0, CHANGE_VALUE_MAX_LENGTH - 1)}…` : text;
}

/**
 * Resync from Amadeus (`bookings:write`): one Flight Order Management GET through the API (safe to repeat, throttled by
 * the API to one per 10 s), answered with the differences it applied (`changes`), shown under the button.
 */
export async function resyncBooking(_previous: ResyncState, form: FormData): Promise<ResyncState> {
  const staff = await staffFor("bookings:write");
  if ("state" in staff) {
    return staff.state;
  }
  const input = ResyncForm.safeParse({ bookingId: textOf(form, BOOKING_ID_FIELD) });
  if (!input.success) {
    return invalid(input.error);
  }
  const { bookingId } = input.data;
  let result: ConsoleBookingResyncResult;
  try {
    result = await staff.context.console.bookings.resync({ bookingId });
  } catch (error) {
    return failure(error, {}, BOOKING_OVERRIDES);
  }
  revalidateBooking(bookingId);
  const changes = result.changes.map((change): SyncChangeView => ({
    path: change.path,
    label: change.label,
    before: changeValue(change.before),
    after: changeValue(change.after),
  }));
  return { ...actionSuccess(STRINGS.resynced(changes.length)), changes };
}

// ---- addNote --------------------------------------------------------------------------------------------------------

const NoteForm = z.object({
  bookingId: BookingId,
  actionKey: ActionKey,
  text: z
    .string({ required_error: "Enter the note." })
    .trim()
    .min(1, "Enter the note.")
    .refine((value) => [...value].length <= 2000, "Use at most 2,000 characters."),
  visibleToCustomer: z.boolean(),
});

/**
 * Add a note to the booking's timeline (`bookings:write`): internal unless the staff member ticks "Visible to the
 * customer"; the form's idempotency key makes a double submit add one note.
 */
export async function addNote(_previous: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor("bookings:write");
  if ("state" in staff) {
    return staff.state;
  }
  const input = NoteForm.safeParse({
    bookingId: textOf(form, BOOKING_ID_FIELD),
    actionKey: textOf(form, ACTION_KEY_FIELD),
    text: textOf(form, NOTE_TEXT_FIELD),
    visibleToCustomer: checked(form, NOTE_VISIBLE_FIELD),
  });
  if (!input.success) {
    return invalid(input.error);
  }
  const { bookingId, actionKey, text, visibleToCustomer } = input.data;
  try {
    await staff.context.console.bookings.addNote(
      { bookingId, text, visibleToCustomer },
      { idempotencyKey: actionKey },
    );
  } catch (error) {
    return keyedFailure(error, { "/text": NOTE_TEXT_FIELD }, BOOKING_OVERRIDES);
  }
  revalidateBooking(bookingId);
  return actionSuccess(STRINGS.noteAdded);
}

// ---- capturePayment and refundPayment -------------------------------------------------------------------------------

const PAYMENT_POINTERS: Readonly<Record<string, string>> = Object.freeze({
  "/amount": AMOUNT_FIELD,
  "/amount/amount": AMOUNT_FIELD,
  "/amount/currency": AMOUNT_FIELD,
});

const PAYMENT_OVERRIDES: Overrides = Object.freeze({
  PAYMENT_DECLINED: STRINGS.authorisationExpired,
  PAYMENT_PROVIDER_ERROR: STRINGS.providerError,
  "UNPROCESSABLE:refund_via_airline": STRINGS.refundViaAirline,
  "UNPROCESSABLE:amount_exceeds_captured": { message: STRINGS.amountExceedsCaptured, field: AMOUNT_FIELD },
  "UNPROCESSABLE:amount_exceeds_authorized": {
    message: STRINGS.amountExceedsAuthorized,
    field: AMOUNT_FIELD,
  },
  "UNPROCESSABLE:currency_mismatch": { message: STRINGS.currencyMismatch, field: AMOUNT_FIELD },
  "CONFLICT:payment_not_refundable": STRINGS.notRefundable,
  "CONFLICT:payment_not_capturable": STRINGS.notCapturable,
});

/** The overrides of a refund: a payment's, with the refundable amount in the refusal of a too large one. */
const REFUND_OVERRIDES: Overrides = Object.freeze({
  ...PAYMENT_OVERRIDES,
  "UNPROCESSABLE:amount_exceeds_captured": { message: refundableRefusal, field: AMOUNT_FIELD },
});

const CaptureForm = z.object({
  paymentId: PaymentId,
  bookingId: optional(BookingId),
  version: Version,
  actionKey: ActionKey,
  reason: Reason,
  amount: optional(TypedAmount),
  currency: Currency,
});

/** Revalidates the page of a payment's booking (the payments tab), or the payment's own page. */
function revalidatePayment(paymentId: string, bookingId: string | undefined): void {
  if (bookingId === undefined) {
    revalidatePath(`/payments/${paymentId}`);
  } else {
    revalidateBooking(bookingId);
  }
}

/**
 * Capture an authorised Stripe payment (`payments:capture`): `ifMatch` = the payment's version, the dialog's
 * idempotency key (Stripe captures once per key), the amount (empty: the whole authorisation; less releases the rest)
 * and the reason. An expired authorisation answers "contact the traveller" (`402 PAYMENT_DECLINED`).
 */
export async function capturePayment(_previous: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor("payments:capture");
  if ("state" in staff) {
    return staff.state;
  }
  const input = CaptureForm.safeParse({
    paymentId: textOf(form, PAYMENT_ID_FIELD),
    bookingId: textOf(form, BOOKING_ID_FIELD),
    version: textOf(form, VERSION_FIELD),
    actionKey: textOf(form, ACTION_KEY_FIELD),
    reason: textOf(form, REASON_FIELD),
    amount: textOf(form, AMOUNT_FIELD),
    currency: textOf(form, CURRENCY_FIELD),
  });
  if (!input.success) {
    return invalid(input.error);
  }
  const { paymentId, bookingId, version, actionKey, reason, amount, currency } = input.data;
  let captured: MoneyValue;
  try {
    const payment = await staff.context.console.payments.capture(
      {
        paymentId,
        ifMatch: version,
        reason,
        ...(amount === undefined ? {} : { amount: { amount, currency } }),
      },
      { idempotencyKey: actionKey },
    );
    captured = payment.amountCaptured;
  } catch (error) {
    return keyedFailure(error, { ...PAYMENT_POINTERS, "/reason": REASON_FIELD }, PAYMENT_OVERRIDES);
  }
  revalidatePayment(paymentId, bookingId);
  return actionSuccess(STRINGS.captured(moneyText(captured)));
}

const RefundForm = z.object({
  paymentId: PaymentId,
  bookingId: optional(BookingId),
  actionKey: ActionKey,
  reason: Reason,
  refundReason: z.enum(valuesOf(REFUND_REASONS), { message: "Choose a reason category." }),
  amount: TypedAmount,
  currency: Currency,
});

/**
 * Refund a captured Stripe payment (`payments:refund`): the amount (at most what is still refundable), the reason
 * category, the dialog's reason as the refund's note, and the dialog's idempotency key (one refund per key). The API
 * creates the refund `pending` and the payments queue sends it to Stripe. Airline-card payments are refunded by the
 * airline (`422 refund_via_airline`), never here.
 */
export async function refundPayment(_previous: ActionState, form: FormData): Promise<ActionState> {
  const staff = await staffFor("payments:refund");
  if ("state" in staff) {
    return staff.state;
  }
  const input = RefundForm.safeParse({
    paymentId: textOf(form, PAYMENT_ID_FIELD),
    bookingId: textOf(form, BOOKING_ID_FIELD),
    actionKey: textOf(form, ACTION_KEY_FIELD),
    reason: textOf(form, REASON_FIELD),
    refundReason: textOf(form, REFUND_REASON_FIELD),
    amount: textOf(form, AMOUNT_FIELD),
    currency: textOf(form, CURRENCY_FIELD),
  });
  if (!input.success) {
    return invalid(input.error);
  }
  const { paymentId, bookingId, actionKey, reason, refundReason, amount, currency } = input.data;
  try {
    await staff.context.console.payments.refund(
      { paymentId, amount: { amount, currency }, reason: refundReason, reasonNote: reason },
      { idempotencyKey: actionKey },
    );
  } catch (error) {
    return keyedFailure(
      error,
      { ...PAYMENT_POINTERS, "/reason": REFUND_REASON_FIELD, "/reasonNote": REASON_FIELD },
      REFUND_OVERRIDES,
    );
  }
  revalidatePayment(paymentId, bookingId);
  return actionSuccess(STRINGS.refundRequested(moneyText({ amount, currency })));
}
