// The notification templates the code knows (OADR-0013 items 3 and 4): the MVP keys, the variables each key may use
// (its allow-list) with sample data for the console preview, and the loader of the English code defaults
// `<key>.{subject,html,txt}.hbs` in this folder. OBE-030 and OBE-055 add the default files and refine the allow-lists
// of the keys they write; the provisioning seed (provisioning/seeds/templates.seed.ts) copies the defaults that exist
// into a new tenant's `notification_templates`, and every key without a row uses the code default at send time.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The MVP template keys of OADR-0013 item 4, in the order of the decision. E-mail only. */
export const TEMPLATE_KEYS = Object.freeze([
  "auth.verify_email",
  "auth.password_reset",
  "booking.confirmed",
  "booking.ticketed",
  "booking.ticketing_delayed",
  "booking.cancelled",
  "booking.cancellation_requested",
  "booking.not_confirmed",
  "staff.ticketing_failed",
  "staff.manual_review",
  "staff.airline_card_alert",
] as const);

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** True when `value` is one of the MVP template keys. */
export function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === "string" && (TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** The only channel of the MVP (`notification_templates.channel`). */
export const TEMPLATE_CHANNEL = "email";

/** The locale of the code defaults: English, the last fallback of every template (OADR-0013 item 3). */
export const DEFAULT_TEMPLATE_LOCALE = "en";

/** Who receives a template: customers (account e-mails), travellers (booking e-mails) or the OTA's staff. */
export type TemplateAudience = "customer" | "traveller" | "staff";

/**
 * One variable a template may use: a Handlebars path relative to the render data (`booking.reference`). `[]` marks
 * the items of a list, which templates reach with `{{#each}}` (`booking.segments[].origin`).
 */
export interface TemplateVariable {
  readonly name: string;
  readonly description: string;
}

/** Sample render data: JSON values only, so it can be stored in `notification_templates.sample_data`. */
export type SampleValue = string | number | boolean | null | readonly SampleValue[] | SampleData;
export interface SampleData {
  readonly [name: string]: SampleValue;
}

/** What the code knows about one key. */
export interface TemplateDefinition {
  readonly key: TemplateKey;
  readonly audience: TemplateAudience;
  /** The allow-list: a strict-mode template of this key may use these variables and no other. */
  readonly variables: readonly TemplateVariable[];
  /** Render data for the console preview and the default-template tests. Example values only, never real data. */
  readonly sampleData: SampleData;
}

const variable = (name: string, description: string): TemplateVariable =>
  Object.freeze({ name, description });

const BRAND_VARIABLES = [
  variable("brand.name", "Brand name of the OTA (storefront settings)."),
  variable("brand.supportEmail", "Customer support e-mail of the OTA; empty when not set."),
  variable("brand.supportPhone", "Customer support phone of the OTA; empty when not set."),
  variable("brand.storefrontUrl", "Base URL of the OTA's storefront, such as https://demo.ota.example.com."),
];

const SAMPLE_BRAND: SampleData = {
  name: "Demo Travel",
  supportEmail: "support@demo.example.com",
  supportPhone: "+33 1 23 45 67 89",
  storefrontUrl: "https://demo.ota.example.com",
};

const CUSTOMER_VARIABLES = [variable("customer.firstName", "First name of the customer account.")];

const SAMPLE_CUSTOMER: SampleData = { firstName: "Alex" };

const BOOKING_VARIABLES = [
  variable("booking.reference", "Booking reference shown to the traveller."),
  variable("booking.recordLocator", "Airline record locator (PNR); empty before the order is confirmed."),
  variable("booking.url", "Link to the booking page (/booking.html?id=bkg_…) on the OTA's storefront host."),
  variable("booking.total.amount", "Total price as a decimal string, such as 412.30."),
  variable("booking.total.currency", "ISO 4217 currency of the total, such as EUR."),
  variable("booking.contact.firstName", "First name of the booking contact."),
  variable("booking.contact.lastName", "Last name of the booking contact."),
  variable("booking.travellers[].firstName", "First name of each traveller."),
  variable("booking.travellers[].lastName", "Last name of each traveller."),
  variable("booking.segments[].origin", "IATA code of each flight's departure airport."),
  variable("booking.segments[].destination", "IATA code of each flight's arrival airport."),
  variable(
    "booking.segments[].departureAt",
    "Local departure date and time at the origin (ISO 8601, no offset).",
  ),
  variable(
    "booking.segments[].arrivalAt",
    "Local arrival date and time at the destination (ISO 8601, no offset).",
  ),
  variable("booking.segments[].carrierCode", "IATA code of each flight's marketing airline."),
  variable("booking.segments[].flightNumber", "Flight number of each flight, without the airline code."),
];

const SAMPLE_BOOKING: SampleData = {
  reference: "VX7K2M9Q",
  recordLocator: "ABC123",
  url: "https://demo.ota.example.com/booking.html?id=bkg_01J9ZA2B4C6D8E0F2G4H6J8K0M",
  total: { amount: "412.30", currency: "EUR" },
  contact: { firstName: "Alex", lastName: "Martin" },
  travellers: [{ firstName: "Alex", lastName: "Martin" }],
  segments: [
    {
      origin: "CDG",
      destination: "JFK",
      departureAt: "2026-11-01T10:00:00",
      arrivalAt: "2026-11-01T12:35:00",
      carrierCode: "AF",
      flightNumber: "6",
    },
  ],
};

const STAFF_BOOKING_VARIABLES = [
  variable("booking.reference", "Booking reference."),
  variable("booking.recordLocator", "Airline record locator (PNR); empty when there is none."),
  variable("booking.consoleUrl", "Link to the booking in the OTA admin."),
];

const SAMPLE_STAFF_BOOKING: SampleData = {
  reference: "VX7K2M9Q",
  recordLocator: "ABC123",
  consoleUrl: "https://admin.ota.example.com/bookings/bkg_01J9ZA2B4C6D8E0F2G4H6J8K0M",
};

function define(
  key: TemplateKey,
  audience: TemplateAudience,
  variables: readonly TemplateVariable[],
  sampleData: SampleData,
): TemplateDefinition {
  return Object.freeze({
    key,
    audience,
    variables: Object.freeze([...BRAND_VARIABLES, ...variables]),
    sampleData: Object.freeze({ brand: SAMPLE_BRAND, ...sampleData }),
  });
}

/** Every MVP key with its audience, allow-list and sample data. */
export const TEMPLATE_REGISTRY: Readonly<Record<TemplateKey, TemplateDefinition>> = Object.freeze({
  "auth.verify_email": define(
    "auth.verify_email",
    "customer",
    [
      ...CUSTOMER_VARIABLES,
      variable(
        "verifyUrl",
        "Link to /account/verify.html with the verification token, on the storefront host.",
      ),
      variable("expiresAt", "When the link expires (ISO 8601 UTC)."),
    ],
    {
      customer: SAMPLE_CUSTOMER,
      verifyUrl: "https://demo.ota.example.com/account/verify.html?token=sample",
      expiresAt: "2026-11-02T10:00:00Z",
    },
  ),
  "auth.password_reset": define(
    "auth.password_reset",
    "customer",
    [
      ...CUSTOMER_VARIABLES,
      variable(
        "resetUrl",
        "Link to /account/reset-password.html with the reset token, on the storefront host.",
      ),
      variable("expiresAt", "When the link expires (ISO 8601 UTC)."),
    ],
    {
      customer: SAMPLE_CUSTOMER,
      resetUrl: "https://demo.ota.example.com/account/reset-password.html?token=sample",
      expiresAt: "2026-11-01T11:00:00Z",
    },
  ),
  "booking.confirmed": define("booking.confirmed", "traveller", BOOKING_VARIABLES, {
    booking: SAMPLE_BOOKING,
  }),
  "booking.ticketed": define(
    "booking.ticketed",
    "traveller",
    [
      ...BOOKING_VARIABLES,
      variable("tickets[].number", "Number of each e-ticket (13 digits)."),
      variable("tickets[].travellerName", "Name of the traveller of each e-ticket."),
    ],
    {
      booking: SAMPLE_BOOKING,
      tickets: [{ number: "0571234567890", travellerName: "Alex Martin" }],
    },
  ),
  "booking.ticketing_delayed": define("booking.ticketing_delayed", "traveller", BOOKING_VARIABLES, {
    booking: SAMPLE_BOOKING,
  }),
  "booking.cancelled": define(
    "booking.cancelled",
    "traveller",
    [
      ...BOOKING_VARIABLES,
      variable("refund.amount", "Refunded amount as a decimal string; empty when nothing is refunded."),
      variable("refund.currency", "ISO 4217 currency of the refund; empty when nothing is refunded."),
    ],
    {
      booking: SAMPLE_BOOKING,
      refund: { amount: "412.30", currency: "EUR" },
    },
  ),
  "booking.cancellation_requested": define("booking.cancellation_requested", "traveller", BOOKING_VARIABLES, {
    booking: SAMPLE_BOOKING,
  }),
  "booking.not_confirmed": define("booking.not_confirmed", "traveller", BOOKING_VARIABLES, {
    booking: SAMPLE_BOOKING,
  }),
  "staff.ticketing_failed": define(
    "staff.ticketing_failed",
    "staff",
    [
      ...STAFF_BOOKING_VARIABLES,
      variable("failure.code", "Error code of the last ticketing attempt."),
      variable("failure.message", "Error message of the last ticketing attempt, without request data."),
      variable("failure.attempts", "Number of ticketing attempts made."),
    ],
    {
      booking: SAMPLE_STAFF_BOOKING,
      failure: { code: "AMADEUS_ERROR", message: "The airline refused the ticketing request.", attempts: 3 },
    },
  ),
  "staff.manual_review": define(
    "staff.manual_review",
    "staff",
    [...STAFF_BOOKING_VARIABLES, variable("review.reason", "Why the booking needs a member of staff.")],
    {
      booking: SAMPLE_STAFF_BOOKING,
      review: { reason: "The ticketing policy of the OTA is manual review." },
    },
  ),
  "staff.airline_card_alert": define(
    "staff.airline_card_alert",
    "staff",
    [
      ...STAFF_BOOKING_VARIABLES,
      variable("alert.kind", "What was detected, such as repeated_declines."),
      variable("alert.message", "Description of the alert, never card data."),
      variable("alert.occurredAt", "When it was detected (ISO 8601 UTC)."),
    ],
    {
      booking: SAMPLE_STAFF_BOOKING,
      alert: {
        kind: "repeated_declines",
        message: "Several airline-card payments were declined for the same checkout.",
        occurredAt: "2026-11-01T10:05:00Z",
      },
    },
  ),
});

/**
 * The folder of the code defaults: this one. The build must copy the `.hbs` files next to `registry.js` when the
 * first defaults are added (OBE-030); a folder without them simply has no defaults.
 */
export const DEFAULT_TEMPLATES_DIR = __dirname;

/** The three files of a default, by part: subject line, HTML body and plain-text body. */
export const TEMPLATE_PARTS = Object.freeze(["subject", "html", "txt"] as const);
export type TemplatePart = (typeof TEMPLATE_PARTS)[number];

/** The file name of one part of a default: `<key>.<part>.hbs`, such as `booking.confirmed.subject.hbs`. */
export function templateFileName(key: TemplateKey, part: TemplatePart): string {
  return `${key}.${part}.hbs`;
}

/** The sources of one code default, as stored in `notification_templates`. */
export interface TemplateSource {
  readonly key: TemplateKey;
  /** The subject template, trimmed: one line. */
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** A default has some of its three files but not all: the defaults in `dir` are incomplete. */
export class TemplateFilesError extends Error {
  override readonly name = "TemplateFilesError";
  readonly key: TemplateKey;
  readonly missing: readonly string[];

  constructor(key: TemplateKey, missing: readonly string[]) {
    super(
      `The default template ${key} is incomplete: ${missing.join(", ")} missing. A default has the three files ` +
        `${TEMPLATE_PARTS.map((part) => templateFileName(key, part)).join(", ")}, or none.`,
    );
    this.key = key;
    this.missing = Object.freeze([...missing]);
  }
}

/** The file's content, or `undefined` when it does not exist. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * The code default of `key` in `dir`, or `undefined` when it has none of its files. Throws `TemplateFilesError`
 * when only some of the three exist.
 */
export async function loadTemplateDefault(
  key: TemplateKey,
  dir: string = DEFAULT_TEMPLATES_DIR,
): Promise<TemplateSource | undefined> {
  const [subject, html, text] = await Promise.all(
    TEMPLATE_PARTS.map((part) => readOptional(join(dir, templateFileName(key, part)))),
  );
  if (subject === undefined && html === undefined && text === undefined) {
    return undefined;
  }
  if (subject === undefined || html === undefined || text === undefined) {
    const missing = TEMPLATE_PARTS.filter((_, index) => [subject, html, text][index] === undefined);
    throw new TemplateFilesError(
      key,
      missing.map((part) => templateFileName(key, part)),
    );
  }
  return Object.freeze({ key, subject: subject.trim(), html, text });
}

/** The code defaults in `dir`, in the order of `TEMPLATE_KEYS`: only the keys whose files exist. */
export async function loadTemplateDefaults(
  dir: string = DEFAULT_TEMPLATES_DIR,
): Promise<readonly TemplateSource[]> {
  const defaults = await Promise.all(TEMPLATE_KEYS.map((key) => loadTemplateDefault(key, dir)));
  return Object.freeze(defaults.filter((source) => source !== undefined));
}
