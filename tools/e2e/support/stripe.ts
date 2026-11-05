// Stripe in the end-to-end journeys (OFE-017; ota/frontend/README.md §13 journey 2, ota/docs/flows/checkout-stripe.md
// §6, docs/mvp/local-development.md §6, PADR-0017 item 4): the Stripe CLI forwarders of the stack, and the browser and
// API helpers of the nightly `storefront-stripe` and `portal-stripe` journeys. Test mode only; nothing here runs without
// E2E_STRIPE=1.
//
// 1. The forwarders. With E2E_STRIPE=1, E2E_WITH_OTA=1 and the OTA's test keys (STRIPE_SECRET_KEY_TEST,
//    STRIPE_PUBLISHABLE_KEY_TEST), support/stack.ts starts `stripe listen` before the apps: the events the OTA's
//    production endpoint receives (the list of tools/dev/stripe-listen.sh), of the Velexis account only, forwarded to
//    the OTA API's `/webhooks/stripe/velexis/test`. The signing secret the CLI prints with its "Ready!" line becomes the
//    OTA API's STRIPE_WEBHOOK_SECRET_VELEXIS_TEST, so the API verifies what the CLI signs. With E2E_STRIPE_BILLING=1
//    (the nightly `portal-stripe` step; lead decision 5(l) of 2026-11-05, FIX-W43-SHARED) the stack starts a second one
//    the same way with the platform's test key (STRIPE_SECRET_KEY): the events of Stripe Billing's endpoint (the
//    `billing` list of stripe-listen.sh) forwarded to the platform API's `/webhooks/stripe/billing`, whose signing
//    secret becomes the platform API's STRIPE_BILLING_WEBHOOK_SECRET. The key reaches each CLI as STRIPE_API_KEY in its
//    environment, never on its command line; its output goes to test-results/stack/stripe-cli.log (the billing one's
//    to stripe-cli-billing.log) with every `whsec_`, `sk_` and `rk_` value redacted, and an error shows only that
//    redacted output.
// 2. The card page. `fillCardForm` types a Stripe test card into the Payment Element's iframe, `completeThreeDSecure`
//    presses "Complete" in Stripe's 3-D Secure test challenge. Only Stripe's documented test cards are used.
// 3. Stripe's own record. `retrievePaymentIntent` reads a PaymentIntent with the test key: after a void its status is
//    `canceled` (OF-04 AC2). It never puts the key or a response body into an error.
// 4. Stripe test objects of a journey (FIX-W43-SHARED). `createTestProduct` and `createMonthlyTestPrice` make the
//    product and monthly price that the portal's Checkout journey links to its plan through the admin API (prices are
//    made in Stripe first, platform/docs/flows/subscription-billing.md §A), and `archiveStripeTestObjects` archives them
//    again in its `afterAll` (Stripe deletes no product that has a price: `active=false`). Test keys only; an error
//    names the request and Stripe's status, never the key or a response body.
//
// This file never imports support/stack.ts (which imports it): the stack passes in what the forwarders need.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { expect, type Locator, type Page } from "@playwright/test";

/** The OTA API's webhook route of the Velexis Stripe account in test mode (OADR-0010 point 4). */
export const OTA_WEBHOOK_PATH = "/webhooks/stripe/velexis/test";

/** The platform API's webhook route of Stripe Billing (platform/docs/flows/subscription-billing.md §C). */
export const BILLING_WEBHOOK_PATH = "/webhooks/stripe/billing";

/**
 * The events the OTA's production endpoint receives (ADR-0011, OADR-0010; the `ota` listener of
 * tools/dev/stripe-listen.sh): the forwarder subscribes to these only.
 */
export const OTA_STRIPE_EVENTS = Object.freeze([
  "payment_intent.amount_capturable_updated",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const);

/**
 * The events the platform's billing endpoint receives (ADR-0013, platform/docs/flows/subscription-billing.md §D; the
 * `billing` listener of tools/dev/stripe-listen.sh): the billing forwarder (E2E_STRIPE_BILLING=1) subscribes to these
 * only.
 */
export const BILLING_STRIPE_EVENTS = Object.freeze([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
] as const);

/** How long `stripe listen` may take to connect to Stripe and print "Ready!". */
export const STRIPE_READY_TIMEOUT_MS = 60_000;
/** How long the forwarder may take to exit after SIGTERM before it gets SIGKILL. */
const STRIPE_STOP_TIMEOUT_MS = 10_000;
/** How many lines of the forwarder's (redacted) output an error shows. */
const OUTPUT_TAIL_LINES = 40;

/** Stripe's API, which `retrievePaymentIntent` reads and the test-object helpers write (test mode only). */
export const STRIPE_API_URL = "https://api.stripe.com";

/**
 * The arguments of `stripe listen` for a forwarder of `events` (the OTA's by default) to `forwardTo`: the events of the
 * account itself (`@self`: no connected account's events, which reach another endpoint), no update check, no colours in
 * the log.
 */
export function stripeListenArgs(forwardTo: string, events: readonly string[] = OTA_STRIPE_EVENTS): string[] {
  return [
    "listen",
    "--forward-to",
    forwardTo,
    "--events",
    events.join(","),
    "--events-from",
    "@self",
    "--skip-update",
    "--color",
    "off",
  ];
}

/** What the Stripe CLI gets on top of the harness's environment: the key (never on its command line), no telemetry. */
export function stripeCliEnv(secretKey: string): Record<string, string> {
  return { STRIPE_API_KEY: secretKey, STRIPE_CLI_TELEMETRY_OPTOUT: "1" };
}

/** A webhook signing secret, a secret key or a restricted key, in any text. */
const STRIPE_SECRET_VALUE = /\b(whsec_|(?:sk|rk)_(?:test|live)_)[A-Za-z0-9_]+/g;

/** `text` with every Stripe secret replaced by its prefix and `[REDACTED]` (`whsec_[REDACTED]`). */
export function redactStripeOutput(text: string): string {
  return text.replace(STRIPE_SECRET_VALUE, "$1[REDACTED]");
}

/** The signing secret in a line of `stripe listen` ("Your webhook signing secret is whsec_…"), if there is one. */
export function webhookSecretIn(line: string): string | undefined {
  return /\b(whsec_[A-Za-z0-9]+)/.exec(line)?.[1];
}

/** The line with which `stripe listen` says it is connected and forwarding. */
export function isReadyLine(line: string): boolean {
  return /\bReady!/.test(line);
}

/** How the stack starts the forwarder. */
export interface StripeForwarderOptions {
  /** The Stripe CLI binary (E2E_STRIPE_CLI): a name on PATH or a path. */
  readonly cli: string;
  /** The CLI's whole environment, STRIPE_API_KEY included (`childEnv(stripeCliEnv(key))` of support/stack.ts). */
  readonly env: NodeJS.ProcessEnv;
  /** Where the events go: the OTA API's OTA_WEBHOOK_PATH, or the platform API's BILLING_WEBHOOK_PATH. */
  readonly forwardTo: string;
  /** The events it subscribes to: OTA_STRIPE_EVENTS (the default) or BILLING_STRIPE_EVENTS. */
  readonly events?: readonly string[];
  /** The log file of its redacted output. */
  readonly logFile: string;
  /** Default STRIPE_READY_TIMEOUT_MS. */
  readonly readyTimeoutMs?: number;
}

/** A running `stripe listen`. */
export interface StripeForwarder {
  /** The signing secret of its deliveries (`whsec_…`): for the receiving API's environment only, never printed. */
  readonly webhookSecret: string;
  /** SIGTERM, then SIGKILL after 10 s. Idempotent. */
  stop(): Promise<void>;
  /** SIGKILL at once, for a harness that dies without its teardown (support/stack.ts `killAll`). */
  kill(): void;
}

/** Splits a stream's chunks into lines (`\n`, `\r\n`, and the `\r` of a spinner) and hands each to `onLine`. */
function lineReader(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  let rest = "";
  return {
    push(chunk) {
      const lines = (rest + chunk.toString("utf8")).split(/\r\n|\n|\r/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
      }
    },
    end() {
      if (rest !== "") {
        onLine(rest);
        rest = "";
      }
    },
  };
}

/**
 * Starts `stripe listen` to `options.forwardTo` and resolves once it printed "Ready!" and its signing secret. Rejects
 * when the CLI is missing, exits first or is not ready in time (it is stopped then), with its redacted output; the
 * secret and the key are never part of an error or the log.
 */
export async function startStripeForwarder(options: StripeForwarderOptions): Promise<StripeForwarder> {
  const fd = openSync(options.logFile, "w");
  let logOpen = true;
  const tail: string[] = [];
  let secret: string | undefined;
  let exitDescription: string | undefined;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolveReady) => {
    markReady = resolveReady;
  });

  const onLine = (line: string): void => {
    const found = webhookSecretIn(line);
    if (found !== undefined) {
      secret = found;
    }
    const redacted = redactStripeOutput(line);
    tail.push(redacted);
    if (tail.length > OUTPUT_TAIL_LINES) {
      tail.shift();
    }
    if (logOpen) {
      writeSync(fd, `${redacted}\n`);
    }
    if (isReadyLine(line)) {
      markReady();
    }
  };
  const closeLog = (): void => {
    if (logOpen) {
      logOpen = false;
      closeSync(fd);
    }
  };

  let child: ChildProcess;
  try {
    child = spawn(options.cli, stripeListenArgs(options.forwardTo, options.events), {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    closeLog();
    throw error;
  }
  const stdout = lineReader(onLine);
  const stderr = lineReader(onLine);
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<void>((resolveExit) => {
    // `close` comes after the output streams have ended, so no line of the end is lost; a start that failed may
    // give only `error`.
    const finish = (description: string): void => {
      exitDescription ??= description;
      stdout.end();
      stderr.end();
      closeLog();
      resolveExit();
    };
    child.once("close", (code, signal) => {
      finish(signal === null ? `exited with code ${code}` : `was stopped by ${signal}`);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ENOENT"
          ? `could not start: the Stripe CLI was not found as "${options.cli}". Install the Stripe CLI 1.x ` +
              "(docs/mvp/local-development.md §1) or point E2E_STRIPE_CLI at it"
          : `could not start: ${error.message}`,
      );
    });
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (exitDescription === undefined) {
      child.kill("SIGTERM");
      const done = await Promise.race([
        exited.then(() => true),
        delay(STRIPE_STOP_TIMEOUT_MS, false, { ref: false }),
      ]);
      if (!done) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    closeLog();
  };

  const timeoutMs = options.readyTimeoutMs ?? STRIPE_READY_TIMEOUT_MS;
  const outcome = await Promise.race([
    ready.then(() => "ready" as const),
    exited.then(() => "exited" as const),
    delay(timeoutMs, "timeout" as const, { ref: false }),
  ]);
  const output = (): string => (tail.length === 0 ? "(no output)" : tail.join("\n"));
  if (outcome !== "ready") {
    const reason =
      outcome === "exited"
        ? `${exitDescription ?? "exited"} before it was ready`
        : `was not ready within ${timeoutMs / 1000} s`;
    await stop();
    throw new Error(`stripe listen ${reason}. Its output (${options.logFile}, redacted):\n${output()}`);
  }
  if (secret === undefined) {
    await stop();
    throw new Error(
      `stripe listen printed no webhook signing secret before "Ready!". Its output (${options.logFile}, ` +
        `redacted):\n${output()}`,
    );
  }
  const kill = (): void => {
    if (exitDescription === undefined) {
      child.kill("SIGKILL");
    }
  };
  return { webhookSecret: secret, stop, kill };
}

// ---- Stripe's record of a payment -------------------------------------------------------------------------------

/** What the journeys read of a PaymentIntent. */
export interface PaymentIntentState {
  readonly id: string;
  /** `requires_payment_method`, `requires_action`, `requires_capture`, `succeeded`, `canceled`, … */
  readonly status: string;
  readonly captureMethod: string;
}

/** The `fetch` that `retrievePaymentIntent` uses: the global one, a fake in the unit tests. */
export type StripeFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The PaymentIntent `id` as Stripe has it, read with the test-mode `secretKey`. Throws with the status alone (never the
 * key or the body) when Stripe refuses, and refuses anything but a test key or a PaymentIntent id before any request.
 */
export async function retrievePaymentIntent(
  secretKey: string,
  id: string,
  fetchImpl: StripeFetch = fetch,
): Promise<PaymentIntentState> {
  if (!/^(?:sk|rk)_test_[A-Za-z0-9_]+$/.test(secretKey)) {
    throw new TypeError("retrievePaymentIntent takes a test-mode key (sk_test_…, rk_test_…) only");
  }
  if (!/^pi_[A-Za-z0-9]+$/.test(id)) {
    throw new TypeError(`not a PaymentIntent id: ${id}`);
  }
  const response = await fetchImpl(`${STRIPE_API_URL}/v1/payment_intents/${id}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Stripe answered ${response.status} to GET /v1/payment_intents/${id}`);
  }
  const body = (await response.json()) as { id?: unknown; status?: unknown; capture_method?: unknown };
  if (body.id !== id || typeof body.status !== "string") {
    throw new Error(`Stripe's answer to GET /v1/payment_intents/${id} is not that PaymentIntent`);
  }
  return {
    id,
    status: body.status,
    captureMethod: typeof body.capture_method === "string" ? body.capture_method : "",
  };
}

// ---- Stripe test objects of a journey ---------------------------------------------------------------------------

/** A Stripe test-mode secret or restricted key; any other key is refused before a request. */
const STRIPE_TEST_KEY = /^(?:sk|rk)_test_[A-Za-z0-9_]+$/;

/** The ids of the two kinds of object a journey makes. */
const STRIPE_IDS = Object.freeze({
  product: /^prod_[A-Za-z0-9]+$/,
  price: /^price_[A-Za-z0-9]+$/,
} as const);

type StripeObjectKind = keyof typeof STRIPE_IDS;

/**
 * POSTs `fields` (form-encoded, as Stripe's API takes them) to `path` of Stripe's API with the test-mode `secretKey` and
 * answers the id of the `kind` of object Stripe answered with. A refusal throws with the request and Stripe's status
 * alone, never the key or the body.
 */
async function postToStripe(
  secretKey: string,
  path: string,
  fields: Readonly<Record<string, string>>,
  kind: StripeObjectKind,
  fetchImpl: StripeFetch,
): Promise<string> {
  if (!STRIPE_TEST_KEY.test(secretKey)) {
    throw new TypeError("Stripe test objects are made with a test-mode key (sk_test_…, rk_test_…) only");
  }
  const response = await fetchImpl(`${STRIPE_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Stripe answered ${response.status} to POST ${path}`);
  }
  const { id } = (await response.json()) as { id?: unknown };
  if (typeof id !== "string" || !STRIPE_IDS[kind].test(id)) {
    throw new Error(`Stripe's answer to POST ${path} names no ${kind}`);
  }
  return id;
}

/**
 * Creates a product named `name` in Stripe's test account, labelled `metadata[velexis_e2e] = label` so that a person
 * finds what a run left behind, and answers its id (`prod_…`).
 */
export function createTestProduct(
  secretKey: string,
  name: string,
  label: string,
  fetchImpl: StripeFetch = fetch,
): Promise<string> {
  return postToStripe(
    secretKey,
    "/v1/products",
    { name, "metadata[velexis_e2e]": label },
    "product",
    fetchImpl,
  );
}

/** The monthly price `createMonthlyTestPrice` makes. */
export interface MonthlyTestPrice {
  /** The product it belongs to (`createTestProduct`). */
  readonly productId: string;
  /** ISO 4217, in either case: Stripe takes it in lower case. */
  readonly currency: string;
  /** The monthly amount in the currency's minor unit (1900 for 19.00 EUR). */
  readonly unitAmount: number;
  /** Its `metadata[velexis_e2e]`. */
  readonly label: string;
}

/** Creates a recurring monthly price of `price.productId` in Stripe's test account and answers its id (`price_…`). */
export async function createMonthlyTestPrice(
  secretKey: string,
  price: MonthlyTestPrice,
  fetchImpl: StripeFetch = fetch,
): Promise<string> {
  if (!STRIPE_IDS.product.test(price.productId)) {
    throw new TypeError(`not a Stripe product id: ${price.productId}`);
  }
  if (!Number.isSafeInteger(price.unitAmount) || price.unitAmount <= 0) {
    throw new TypeError("a monthly test price needs a positive amount in minor units");
  }
  return postToStripe(
    secretKey,
    "/v1/prices",
    {
      product: price.productId,
      currency: price.currency.toLowerCase(),
      unit_amount: String(price.unitAmount),
      "recurring[interval]": "month",
      "metadata[velexis_e2e]": price.label,
    },
    "price",
    fetchImpl,
  );
}

/** What a journey made in Stripe's test account and archives again. */
export interface StripeTestObjects {
  readonly prices: readonly string[];
  readonly products: readonly string[];
}

/**
 * Archives the prices and then the products of `objects` in Stripe's test account (`active=false`: Stripe deletes no
 * product that has a price). Every id is checked before the first request; every object is tried even when one fails,
 * then one error names each refusal by its request and Stripe's status.
 */
export async function archiveStripeTestObjects(
  secretKey: string,
  objects: StripeTestObjects,
  fetchImpl: StripeFetch = fetch,
): Promise<void> {
  const requests = [
    ...objects.prices.map((id) => ({ id, kind: "price" as const, path: `/v1/prices/${id}` })),
    ...objects.products.map((id) => ({ id, kind: "product" as const, path: `/v1/products/${id}` })),
  ];
  for (const request of requests) {
    if (!STRIPE_IDS[request.kind].test(request.id)) {
      throw new TypeError(`not a Stripe ${request.kind} id: ${request.id}`);
    }
  }
  const failures: string[] = [];
  for (const request of requests) {
    try {
      await postToStripe(secretKey, request.path, { active: "false" }, request.kind, fetchImpl);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Stripe test objects left active:\n  - ${failures.join("\n  - ")}`);
  }
}

// ---- The card page ----------------------------------------------------------------------------------------------

/** Stripe's documented test cards (https://docs.stripe.com/testing); never any other number. */
export const STRIPE_TEST_CARDS = Object.freeze({
  /** `4000 0027 6000 3184`: 3-D Secure 2 is required for every payment, with Stripe's test challenge. */
  threeDSecure: "4000002760003184",
  /** `4242 4242 4242 4242`: succeeds without authentication. */
  visa: "4242424242424242",
} as const);

/** The Payment Element's iframe on the card page (`checkout/pay-card.html`, `[data-payment-element]`). */
export const PAYMENT_ELEMENT_FRAME = "[data-payment-element] iframe";

/** The billing country typed with a test card: Spain, whose cards the Payment Element takes without a postal code. */
const CARD_COUNTRY = "ES";
/** A postal code, should the Payment Element ask for one all the same. */
const CARD_POSTAL_CODE = "28001";

/** An expiry three years ahead as the Payment Element takes it typed: month and two-digit year (`1229`). */
export function testCardExpiry(now = new Date()): string {
  return `12${String((now.getUTCFullYear() + 3) % 100).padStart(2, "0")}`;
}

/**
 * Types the test card `number` (STRIPE_TEST_CARDS), an expiry three years ahead and the security code `123` into the
 * Payment Element of the card page `page`, and the billing country when it asks for one. The values are Stripe's
 * public test values; they go to Stripe's iframe only, as a traveller's would.
 */
export async function fillCardForm(page: Page, number: string): Promise<void> {
  if (!(Object.values(STRIPE_TEST_CARDS) as string[]).includes(number)) {
    throw new TypeError("fillCardForm types Stripe's documented test cards only (STRIPE_TEST_CARDS)");
  }
  const element = page.locator(PAYMENT_ELEMENT_FRAME).first().contentFrame();
  await element.locator('input[name="number"]').pressSequentially(number);
  await element.locator('input[name="expiry"]').pressSequentially(testCardExpiry());
  await element.locator('input[name="cvc"]').pressSequentially("123");
  const country = element.locator('select[name="country"]');
  if ((await country.count()) > 0) {
    await country.selectOption(CARD_COUNTRY);
  }
  const postalCode = element.locator('input[name="postalCode"]');
  if (await postalCode.isVisible()) {
    await postalCode.fill(CARD_POSTAL_CODE);
  }
}

/** The "Complete" button of Stripe's 3-D Secure test challenge (its id, and its name in newer versions). */
const AUTHORIZE_3DS_BUTTON = "#test-source-authorize-3ds";
const COMPLETE_3DS_NAME = /^complete( authentication)?$/i;

/** How long Stripe's challenge may take to appear after Pay. */
export const THREE_DS_TIMEOUT_MS = 20_000;

/**
 * Waits for Stripe's 3-D Secure test challenge (a modal of nested Stripe iframes on the card page, whose nesting has
 * changed over Stripe's versions: every frame of the page is searched) and presses "Complete".
 */
export async function completeThreeDSecure(page: Page, timeoutMs = THREE_DS_TIMEOUT_MS): Promise<void> {
  let complete: Locator | undefined;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          const button = frame
            .locator(AUTHORIZE_3DS_BUTTON)
            .or(frame.getByRole("button", { name: COMPLETE_3DS_NAME }))
            .first();
          if (await button.isVisible().catch(() => false)) {
            complete = button;
            return true;
          }
        }
        return false;
      },
      { message: "Stripe's 3-D Secure test challenge shows its Complete button", timeout: timeoutMs },
    )
    .toBe(true);
  await complete?.click();
}
