// @velexis/testing/stripe (X-028; ADR-0015 "Stripe", ADR-0011, ADR-0013): signed Stripe webhook events for tests.
// Tests never call Stripe and never need the Stripe CLI: they take a synthetic event fixture of
// packages/testing/fixtures/stripe/, change what the test is about, and sign it with the endpoint's test secret
// exactly as Stripe signs a delivery (`Stripe-Signature: t=<unix seconds>,v1=<HMAC-SHA256>`).
//
//   const whsec = `whsec_${randomBytes(24).toString("base64url")}`;     // the endpoint's secret in this test only
//   const { payload, header, event } = signedStripeEvent(
//     "payment_intent.succeeded",
//     { data: { object: { amount_received: 1000 } } },                  // deep-merged into the fixture
//     whsec,
//   );
//   await request(app.server).post("/webhooks/stripe/velexis/test")
//     .set("Stripe-Signature", header).set("Content-Type", "application/json").send(payload);
//
// `payload` is the exact body that was signed: send it as it is. Parsing and re-serialising it, or changing one byte,
// makes `stripe.webhooks.constructEvent` reject it, as it must. `stripe` is a devDependency of this package
// (ADR-0022 item 2), like the Amadeus stub: the apps list their own runtime `stripe`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";

/** The event types with a fixture: every event type of the webhook table in `docs/mvp/architecture.md` §5 (d). */
export const STRIPE_FIXTURE_EVENT_TYPES = [
  // OTA payments, /webhooks/stripe/velexis/{test,live} (and the M5 connect/ and c/ endpoints with `account` set).
  "payment_intent.amount_capturable_updated",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  // Platform billing, /webhooks/stripe/billing.
  "checkout.session.completed",
  "customer.subscription.updated",
  "invoice.paid",
  // Platform Connect account events, /webhooks/stripe/connect-accounts (M5).
  "account.updated",
  "account.application.deauthorized",
] as const;

/** An event type that has a fixture. */
export type StripeFixtureEventType = (typeof STRIPE_FIXTURE_EVENT_TYPES)[number];

/** The `stripe` type of an event of type `T` (for example `Stripe.PaymentIntentSucceededEvent`). */
export type StripeFixtureEvent<T extends StripeFixtureEventType = StripeFixtureEventType> = Extract<
  Stripe.Event,
  { type: T }
>;

/**
 * Overrides deep-merged into a fixture: any part of the event, at any depth. A plain object is merged key by key; any
 * other value (a string, a number, `null`, an array) replaces the fixture's value; `undefined` removes the key.
 */
export type StripeEventOverrides<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: StripeEventOverrides<T[K]> | undefined }
    : T;

/** Where the fixtures are: `packages/testing/fixtures/stripe/<type>.json` (also next to `dist/`, one level up). */
export const STRIPE_FIXTURES_DIR = join(__dirname, "..", "fixtures", "stripe");

/** The tenant the fixtures belong to (`metadata.velexis_tenant_id`, `client_reference_id`). */
export const STRIPE_TEST_TENANT_ID = "ten_test_alpha";

/** The connected account of the Connect fixtures (`event.account`). */
export const STRIPE_TEST_ACCOUNT_ID = "acct_test_alpha";

/** The header Stripe sends the signature in. */
export const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";

/** Options of `signedStripeEvent`. */
export interface SignedStripeEventOptions {
  /**
   * The signature's timestamp (`t=`): Unix seconds or a `Date`; default now (`Date.now()`, so Vitest's fake timers
   * move it). `constructEvent` rejects a timestamp more than 300 s from its own clock by default, so an old one
   * tests the replay window.
   */
  readonly timestamp?: number | Date | undefined;
}

/** A signed event, ready to post to a webhook endpoint. */
export interface SignedStripeEvent<T extends StripeFixtureEventType = StripeFixtureEventType> {
  /** The request body: the event serialised once, as Stripe sends it (JSON, two-space indentation). */
  readonly payload: string;
  /** The `Stripe-Signature` header for `payload`, from `stripe.webhooks.generateTestHeaderString`. */
  readonly header: string;
  /** The signed event, parsed from `payload` (a copy: changing it changes neither `payload` nor the fixture). */
  readonly event: StripeFixtureEvent<T>;
}

const fixtureCache = new Map<StripeFixtureEventType, unknown>();

function isFixtureType(type: unknown): type is StripeFixtureEventType {
  return typeof type === "string" && (STRIPE_FIXTURE_EVENT_TYPES as readonly string[]).includes(type);
}

/** The file of the fixture of `type`. */
export function stripeFixturePath(type: StripeFixtureEventType): string {
  if (!isFixtureType(type)) {
    throw new TypeError(
      `There is no Stripe fixture for the event type ${JSON.stringify(type)}; ` +
        `known types: ${STRIPE_FIXTURE_EVENT_TYPES.join(", ")}.`,
    );
  }
  return join(STRIPE_FIXTURES_DIR, `${type}.json`);
}

/**
 * The unsigned fixture of `type`, as a fresh copy on every call (read from disk once per process), for tests that
 * need the event object itself, for example the re-fetched object a mocked Stripe API returns.
 */
export function stripeFixture<T extends StripeFixtureEventType>(type: T): StripeFixtureEvent<T> {
  const file = stripeFixturePath(type);
  let fixture = fixtureCache.get(type);
  if (fixture === undefined) {
    fixture = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isPlainObject(fixture) || fixture["object"] !== "event" || fixture["type"] !== type) {
      throw new Error(`${file} is not a Stripe event of type ${type}.`);
    }
    fixtureCache.set(type, fixture);
  }
  return structuredClone(fixture) as StripeFixtureEvent<T>;
}

/**
 * Signs the fixture of `type` with `secret` after deep-merging `overrides` into it (see `StripeEventOverrides`), and
 * returns the body and the `Stripe-Signature` header. The merged event is serialised once; the header signs exactly
 * that string. The fixture itself never changes.
 */
export function signedStripeEvent<T extends StripeFixtureEventType>(
  type: T,
  overrides: StripeEventOverrides<StripeFixtureEvent<NoInfer<T>>> | undefined,
  secret: string,
  options: SignedStripeEventOptions = {},
): SignedStripeEvent<T> {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError(
      "signedStripeEvent needs the endpoint's signing secret (a non-empty string, whsec_…).",
    );
  }
  if (overrides !== undefined && !isPlainObject(overrides)) {
    throw new TypeError("signedStripeEvent: overrides must be a plain object (or undefined).");
  }
  const event = deepMerge(stripeFixture(type), overrides ?? {});
  const payload = JSON.stringify(event, null, 2);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: signatureTimestamp(options.timestamp),
  });
  return { payload, header, event: JSON.parse(payload) as StripeFixtureEvent<T> };
}

function signatureTimestamp(timestamp: number | Date | undefined): number {
  const seconds =
    timestamp === undefined
      ? Date.now() / 1000
      : timestamp instanceof Date
        ? timestamp.getTime() / 1000
        : timestamp;
  if (!Number.isFinite(seconds) || seconds < 1) {
    throw new RangeError("signedStripeEvent: timestamp must be a Date or a positive number of Unix seconds.");
  }
  return Math.floor(seconds);
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Sets an own, enumerable property, so a key named `__proto__` is data and never changes a prototype. */
function setOwn(target: PlainObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** `base` with `overrides` merged in (see `StripeEventOverrides`); `base` is a fresh copy and is changed in place. */
function deepMerge(base: unknown, overrides: unknown): unknown {
  if (!isPlainObject(overrides)) {
    return structuredClone(overrides);
  }
  const target: PlainObject = isPlainObject(base) ? base : {};
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value === undefined) {
      Reflect.deleteProperty(target, key);
    } else {
      setOwn(target, key, deepMerge(Object.hasOwn(target, key) ? target[key] : undefined, value));
    }
  }
  return target;
}

/** What `scanStripeFixture` found: the kind, where (1-based line and column), never the value itself. */
export interface StripeFixtureFinding {
  readonly kind: "api-key" | "webhook-secret" | "email" | "digit-run" | "live-mode";
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const SCAN_RULES: ReadonlyArray<{
  readonly kind: StripeFixtureFinding["kind"];
  readonly pattern: RegExp;
  readonly message: string;
}> = [
  {
    kind: "api-key",
    pattern: /(?<![A-Za-z0-9])(?:(?:sk|rk)_(?:live|test)|pk_live)_/g,
    message: "a Stripe API key (sk_/rk_ live or test, pk_live): fixtures hold no keys",
  },
  {
    kind: "webhook-secret",
    pattern: /(?<![A-Za-z0-9])whsec_/g,
    message: "a webhook signing secret (whsec_): tests generate their own",
  },
  {
    kind: "email",
    pattern: /@(?!example\.com(?![A-Za-z0-9.-]))/gi,
    message: "an @ outside example.com: e-mail addresses must be ...@example.com",
  },
  {
    kind: "digit-run",
    pattern: /(?<!\d)\d(?:[ -]?\d){12,}(?!\d)/g,
    message:
      "a run of 13 or more digits (a card number has 13 to 19), also when grouped with spaces or dashes",
  },
  {
    kind: "live-mode",
    pattern: /"livemode"\s*:\s*true/g,
    message: "a live-mode object: fixtures come from test mode only",
  },
];

/**
 * Scans the text of a fixture for data that must never be committed: Stripe API keys and webhook secrets, an `@`
 * outside `example.com`, runs of 13 or more digits (card numbers), and live-mode objects. Returns every finding, or
 * an empty list. The findings name the kind and the position, not the value.
 */
export function scanStripeFixture(text: string): StripeFixtureFinding[] {
  const lineStarts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  const position = (offset: number): { line: number; column: number } => {
    let line = lineStarts.length;
    while (line > 1 && (lineStarts[line - 1] ?? 0) > offset) {
      line -= 1;
    }
    return { line, column: offset - (lineStarts[line - 1] ?? 0) + 1 };
  };
  const findings: StripeFixtureFinding[] = [];
  for (const rule of SCAN_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const at = position(match.index);
      findings.push({
        kind: rule.kind,
        ...at,
        message: `line ${at.line}, column ${at.column}: ${rule.message}`,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}
