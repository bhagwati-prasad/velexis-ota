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
//    environment, never on its command line; its output goes to stripe-cli.log in the stack's log folder (test-results/stack/, or
//    test-results/<E2E_RESULTS_SUBDIR>/stack/; the billing one's to stripe-cli-billing.log) with every `whsec_`, `sk_` and `rk_` value redacted, and an error shows only that
//    redacted output.
// 2. The card page. `fillCardForm` types a Stripe test card into the Payment Element's iframe, `completeThreeDSecure`
//    presses "Complete" in Stripe's 3-D Secure test challenge. Only Stripe's documented test cards are used.
// 3. Stripe's own record. `retrievePaymentIntent` reads a PaymentIntent with the test key: after a void its status is
//    `canceled` (OF-04 AC2). It never puts the key or a response body into an error.
// 4. Stripe test objects of a journey (FIX-W43-SHARED). `createTestProduct` and `createMonthlyTestPrice` make the
//    product and monthly price that the portal's Checkout journey links to its plan through the admin API (prices are
//    made in Stripe first, platform/docs/flows/subscription-billing.md §A), and `archiveStripeTestObjects` archives them
//    again in its `afterAll` (Stripe deletes no product that has a price: `active=false`). What the journey's Checkout
//    made (lead decision 7(c) of 2026-11-05, FIX-W44-PLATFORM) goes too: `findCheckoutTestObjects` finds the
//    subscriptions to the journey's own price and the Customer of its owner's OTA, each also by its Velexis metadata,
//    and `removeCheckoutTestObjects` cancels those subscriptions and deletes those Customers; nothing else in the
//    account is touched. Test keys only; an error names the request and Stripe's status, never the key, a query or a
//    response body.
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

/**
 * The ids of the kinds of object a journey makes: the product and the price itself, the subscription and the Customer
 * through its Checkout.
 */
const STRIPE_IDS = Object.freeze({
  product: /^prod_[A-Za-z0-9]+$/,
  price: /^price_[A-Za-z0-9]+$/,
  subscription: /^sub_[A-Za-z0-9]+$/,
  customer: /^cus_[A-Za-z0-9]+$/,
} as const);

type StripeObjectKind = keyof typeof STRIPE_IDS;

/** How long one request to Stripe's API may take. */
const STRIPE_REQUEST_TIMEOUT_MS = 15_000;

/** A request of the test-object helpers to Stripe's API. */
interface StripeRequest {
  readonly method: "GET" | "POST" | "DELETE";
  /** The path, without a query: the only part of the request an error names. */
  readonly path: string;
  /** The query of a GET. */
  readonly query?: Readonly<Record<string, string>>;
  /** The form fields of a POST (form-encoded, as Stripe's API takes them). */
  readonly form?: Readonly<Record<string, string>>;
}

/**
 * Sends `request` to Stripe's API with the test-mode `secretKey` and answers Stripe's JSON object. A refusal throws with
 * the method, the path and Stripe's status alone, never the key, the query (an e-mail address) or the body.
 */
async function requestStripe(
  secretKey: string,
  request: StripeRequest,
  fetchImpl: StripeFetch,
): Promise<Record<string, unknown>> {
  if (!STRIPE_TEST_KEY.test(secretKey)) {
    throw new TypeError(
      "Stripe test objects are made and removed with a test-mode key (sk_test_…, rk_test_…) only",
    );
  }
  const query = request.query === undefined ? "" : `?${new URLSearchParams(request.query).toString()}`;
  const response = await fetchImpl(`${STRIPE_API_URL}${request.path}${query}`, {
    method: request.method,
    headers:
      request.form === undefined
        ? { Authorization: `Bearer ${secretKey}` }
        : { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    ...(request.form === undefined ? {} : { body: new URLSearchParams(request.form).toString() }),
    signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Stripe answered ${response.status} to ${request.method} ${request.path}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // The parser's message quotes the start of the body: never in an error.
    throw new Error(`Stripe's answer to ${request.method} ${request.path} is not JSON`);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`Stripe's answer to ${request.method} ${request.path} is not an object`);
  }
  return body as Record<string, unknown>;
}

/**
 * POSTs `fields` to `path` of Stripe's API with the test-mode `secretKey` and answers the id of the `kind` of object
 * Stripe answered with. A refusal throws with the request and Stripe's status alone, never the key or the body.
 */
async function postToStripe(
  secretKey: string,
  path: string,
  fields: Readonly<Record<string, string>>,
  kind: StripeObjectKind,
  fetchImpl: StripeFetch,
): Promise<string> {
  const { id } = await requestStripe(secretKey, { method: "POST", path, form: fields }, fetchImpl);
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

/**
 * Whose Checkout `findCheckoutTestObjects` looks for: the journey's own price, and its owner, an account new in the
 * run, with that owner's OTAs. The platform makes one Stripe Customer per OTA with the owner's e-mail address and
 * `metadata.velexis_tenant_id`, and the subscription of a Checkout with the same metadata (checkout.service.ts,
 * `checkoutSessionParams` of stripe-billing.gateway.ts).
 */
export interface CheckoutTestScope {
  /** `price_…` the journey made (`createMonthlyTestPrice`): only subscriptions to it are looked at. */
  readonly priceId: string;
  /** The owner's e-mail address (`uniqueEmail`, new in the run): only Customers with exactly it are looked at. */
  readonly email: string;
  /** `ten_…` of the owner's OTAs: the `metadata.velexis_tenant_id` of a Customer or subscription must be one of them. */
  readonly tenantIds: readonly string[];
}

/** What a journey's Checkout made in Stripe's test account: `removeCheckoutTestObjects` removes it. */
export interface CheckoutTestObjects {
  /** `sub_…` not yet ended (`canceled`, `incomplete_expired`), which Stripe can still cancel. */
  readonly subscriptions: readonly string[];
  /** `cus_…`. */
  readonly customers: readonly string[];
}

/** The id of an OTA, the value of `metadata.velexis_tenant_id`. */
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The statuses of a subscription that has ended: Stripe cancels it no more. A cancelled subscription answers one of them
 * (`canceled`; an `incomplete` one, whose first payment never went through, can end as `incomplete_expired`).
 */
const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

/**
 * How many objects one list request answers at most (Stripe's maximum): a run makes one subscription and one Customer,
 * so one page is all there is.
 */
const STRIPE_LIST_LIMIT = "100";

/** One object of a list Stripe answered, as far as these helpers read it. */
interface ListedStripeObject {
  readonly id: string;
  readonly status?: unknown;
  readonly email?: unknown;
  readonly tenantId?: unknown;
}

/** GETs the list at `path` with `query` and answers its objects whose id is of `kind`. */
async function listFromStripe(
  secretKey: string,
  path: string,
  query: Readonly<Record<string, string>>,
  kind: StripeObjectKind,
  fetchImpl: StripeFetch,
): Promise<ListedStripeObject[]> {
  const { data } = await requestStripe(
    secretKey,
    { method: "GET", path, query: { ...query, limit: STRIPE_LIST_LIMIT } },
    fetchImpl,
  );
  if (!Array.isArray(data)) {
    throw new Error(`Stripe's answer to GET ${path} is not a list`);
  }
  const listed: ListedStripeObject[] = [];
  for (const item of data as unknown[]) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const { id, status, email, metadata } = item as Record<string, unknown>;
    if (typeof id !== "string" || !STRIPE_IDS[kind].test(id)) {
      continue;
    }
    const tenantId =
      typeof metadata === "object" && metadata !== null
        ? (metadata as Record<string, unknown>)["velexis_tenant_id"]
        : undefined;
    listed.push({ id, status, email, tenantId });
  }
  return listed;
}

/**
 * The subscriptions and Customers the Checkout of `scope` made in Stripe's test account, and nothing else: the
 * subscriptions to `scope.priceId` (a price of the journey's own) whose `metadata.velexis_tenant_id` is one of
 * `scope.tenantIds` and that have not ended, and the Customers with exactly `scope.email` whose
 * `metadata.velexis_tenant_id` is one of `scope.tenantIds`. Every input is checked before the first request; with no
 * OTA nothing is looked up (no OTA, no Checkout).
 */
export async function findCheckoutTestObjects(
  secretKey: string,
  scope: CheckoutTestScope,
  fetchImpl: StripeFetch = fetch,
): Promise<CheckoutTestObjects> {
  if (!STRIPE_TEST_KEY.test(secretKey)) {
    throw new TypeError(
      "Stripe test objects are made and removed with a test-mode key (sk_test_…, rk_test_…) only",
    );
  }
  if (!STRIPE_IDS.price.test(scope.priceId)) {
    throw new TypeError(`not a Stripe price id: ${scope.priceId}`);
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(scope.email)) {
    throw new TypeError("a Checkout's owner is looked up by an e-mail address");
  }
  for (const tenantId of scope.tenantIds) {
    if (!TENANT_ID.test(tenantId)) {
      throw new TypeError(`not an OTA id: ${tenantId}`);
    }
  }
  if (scope.tenantIds.length === 0) {
    return { subscriptions: [], customers: [] };
  }
  const ofTheOtas = (object: ListedStripeObject): boolean =>
    typeof object.tenantId === "string" && scope.tenantIds.includes(object.tenantId);
  // `status=all`: every status (Stripe leaves the canceled ones out otherwise); the ended ones are dropped below.
  const subscriptions = await listFromStripe(
    secretKey,
    "/v1/subscriptions",
    { price: scope.priceId, status: "all" },
    "subscription",
    fetchImpl,
  );
  // Stripe's e-mail filter is case-sensitive; the answer is compared again all the same.
  const customers = await listFromStripe(
    secretKey,
    "/v1/customers",
    { email: scope.email },
    "customer",
    fetchImpl,
  );
  return {
    subscriptions: subscriptions
      .filter(
        (subscription) =>
          ofTheOtas(subscription) &&
          !(typeof subscription.status === "string" && ENDED_SUBSCRIPTION_STATUSES.has(subscription.status)),
      )
      .map(({ id }) => id),
    customers: customers
      .filter((customer) => customer.email === scope.email && ofTheOtas(customer))
      .map(({ id }) => id),
  };
}

/**
 * Cancels the subscriptions of `objects` at once (`DELETE /v1/subscriptions/<id>`: no proration, no final invoice), then
 * deletes the Customers (`DELETE /v1/customers/<id>`, which also cancels any subscription a Checkout still finished in
 * between). A subscription counts as removed once Stripe answers it ended (ENDED_SUBSCRIPTION_STATUSES), a Customer once
 * Stripe answers it deleted. Every id is checked before the first request; every object is tried even when one fails,
 * then one error names each refusal by its request and Stripe's status.
 */
export async function removeCheckoutTestObjects(
  secretKey: string,
  objects: CheckoutTestObjects,
  fetchImpl: StripeFetch = fetch,
): Promise<void> {
  const requests = [
    ...objects.subscriptions.map((id) => ({
      id,
      kind: "subscription" as const,
      path: `/v1/subscriptions/${id}`,
    })),
    ...objects.customers.map((id) => ({ id, kind: "customer" as const, path: `/v1/customers/${id}` })),
  ];
  for (const request of requests) {
    if (!STRIPE_IDS[request.kind].test(request.id)) {
      throw new TypeError(`not a Stripe ${request.kind} id: ${request.id}`);
    }
  }
  const failures: string[] = [];
  for (const request of requests) {
    try {
      const answer = await requestStripe(secretKey, { method: "DELETE", path: request.path }, fetchImpl);
      const removed =
        request.kind === "subscription"
          ? answer["id"] === request.id &&
            typeof answer["status"] === "string" &&
            ENDED_SUBSCRIPTION_STATUSES.has(answer["status"])
          : answer["id"] === request.id && answer["deleted"] === true;
      if (!removed) {
        throw new Error(`Stripe's answer to DELETE ${request.path} is not that ${request.kind} removed`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Stripe test objects left behind:\n  - ${failures.join("\n  - ")}`);
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
