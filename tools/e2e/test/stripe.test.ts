// support/stripe.ts (OFE-017): the Stripe CLI forwarders against a stand-in `stripe` (no network, no key), the
// redaction of their output, the PaymentIntent read against a fake fetch, and the test-card guards; since FIX-W43-SHARED
// (lead decision 5(l) of 2026-11-05) the billing forwarder's events and the Stripe test objects of PFE-027's Checkout
// journey, against a fake fetch, and since FIX-W44-PLATFORM (lead decision 7(c) of 2026-11-05) the subscription and
// Customer that journey's Checkout made, found and removed against a fake fetch.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/stack";
import {
  archiveStripeTestObjects,
  BILLING_STRIPE_EVENTS,
  BILLING_WEBHOOK_PATH,
  createMonthlyTestPrice,
  createTestProduct,
  fillCardForm,
  findCheckoutTestObjects,
  isReadyLine,
  OTA_STRIPE_EVENTS,
  OTA_WEBHOOK_PATH,
  redactStripeOutput,
  removeCheckoutTestObjects,
  retrievePaymentIntent,
  startStripeForwarder,
  STRIPE_TEST_CARDS,
  stripeCliEnv,
  stripeListenArgs,
  testCardExpiry,
  webhookSecretIn,
  type StripeFetch,
  type StripeForwarder,
} from "../support/stripe";

// Built at run time, so that no secret scanner takes these test values for leaked keys.
const TEST_KEY = ["sk", "test", "ofe017unit"].join("_");
const LIVE_KEY = ["sk", "live", "ofe017unit"].join("_");
const SECRET = ["whsec", "ofe017forwarder0secret"].join("_");
const FORWARD_TO = `http://127.0.0.1:4000${OTA_WEBHOOK_PATH}`;
const BILLING_FORWARD_TO = `http://127.0.0.1:3100${BILLING_WEBHOOK_PATH}`;

describe("stripeListenArgs and stripeCliEnv", () => {
  it("forwards the OTA's events of the account itself to the OTA API, the key never on the command line [OFE-017 AC1]", () => {
    const args = stripeListenArgs(FORWARD_TO);
    expect(args.slice(0, 3)).toEqual(["listen", "--forward-to", FORWARD_TO]);
    expect(args[args.indexOf("--events") + 1]?.split(",")).toEqual([...OTA_STRIPE_EVENTS]);
    expect(args[args.indexOf("--events-from") + 1]).toBe("@self");
    expect(args).toEqual(expect.arrayContaining(["--skip-update", "--color", "off"]));
    expect(args).not.toContain("--live");
    expect(args).not.toContain("--api-key");
    expect(args.join(" ")).not.toMatch(/sk_|rk_|whsec_/);
    expect(OTA_WEBHOOK_PATH).toBe("/webhooks/stripe/velexis/test");
    expect(stripeCliEnv(TEST_KEY)).toEqual({ STRIPE_API_KEY: TEST_KEY, STRIPE_CLI_TELEMETRY_OPTOUT: "1" });
  });

  it("subscribes to the events of the OTA listener of tools/dev/stripe-listen.sh", () => {
    const script = readFileSync(join(REPO_ROOT, "tools/dev/stripe-listen.sh"), "utf8");
    const events = /^readonly OTA_EVENTS=(.+)$/m.exec(script)?.[1]?.split(",");
    expect(events).toEqual([...OTA_STRIPE_EVENTS]);
  });

  it("[PFE-027 AC1] forwards Stripe Billing's events of the account itself to the platform API, as stripe-listen.sh's billing listener", () => {
    const forwardTo = `http://127.0.0.1:3100${BILLING_WEBHOOK_PATH}`;
    const args = stripeListenArgs(forwardTo, BILLING_STRIPE_EVENTS);
    expect(args.slice(0, 3)).toEqual(["listen", "--forward-to", forwardTo]);
    expect(args[args.indexOf("--events") + 1]?.split(",")).toEqual([...BILLING_STRIPE_EVENTS]);
    expect(args[args.indexOf("--events-from") + 1]).toBe("@self");
    expect(args.join(" ")).not.toMatch(/sk_|rk_|whsec_|--api-key|--live/);
    // The billing listener of the development script: the same events, the same route of the platform API.
    const script = readFileSync(join(REPO_ROOT, "tools/dev/stripe-listen.sh"), "utf8");
    expect(/^readonly BILLING_EVENTS=(.+)$/m.exec(script)?.[1]?.split(",")).toEqual([
      ...BILLING_STRIPE_EVENTS,
    ]);
    expect(/^readonly BILLING_URL=(.+)$/m.exec(script)?.[1]).toBe(`localhost:3100${BILLING_WEBHOOK_PATH}`);
    // The platform API's route, which verifies them with STRIPE_BILLING_WEBHOOK_SECRET.
    expect(BILLING_WEBHOOK_PATH).toBe("/webhooks/stripe/billing");
    const controller = readFileSync(
      join(REPO_ROOT, "platform/backend/src/billing/sync/billing-webhook.controller.ts"),
      "utf8",
    );
    expect(controller).toContain('@Controller("webhooks/stripe")');
    expect(controller).toContain('@Post("billing")');
  });
});

describe("the forwarder's output", () => {
  const ready =
    "> Ready! You are using Stripe API Version [2025-09-30]. Your webhook signing secret is " +
    `${SECRET} (^C to quit)`;

  it("reads the signing secret and the Ready line of stripe listen", () => {
    expect(webhookSecretIn(ready)).toBe(SECRET);
    expect(isReadyLine(ready)).toBe(true);
    expect(webhookSecretIn("> Getting ready...")).toBeUndefined();
    expect(isReadyLine("> Getting ready...")).toBe(false);
  });

  it("redacts every signing secret, secret key and restricted key, and keeps the rest", () => {
    const restricted = ["rk", "live", "abc123"].join("_");
    expect(redactStripeOutput(ready)).toBe(
      "> Ready! You are using Stripe API Version [2025-09-30]. Your webhook signing secret is whsec_[REDACTED] " +
        "(^C to quit)",
    );
    expect(redactStripeOutput(`key ${TEST_KEY}, ${LIVE_KEY} and ${restricted}`)).toBe(
      "key sk_test_[REDACTED], sk_live_[REDACTED] and rk_live_[REDACTED]",
    );
    const event = "2026-10-28 06:40:01   --> payment_intent.succeeded [evt_3Qabc]";
    expect(redactStripeOutput(event)).toBe(event);
  });
});

describe("startStripeForwarder", () => {
  const dir = mkdtempSync(join(tmpdir(), "ofe-017-stripe-"));

  /**
   * A stand-in `stripe`: prints its arguments and whether it got a key (never the key), then `ready` (or not), stays
   * up until SIGTERM unless `exitCode` is given, in which case it exits with it.
   */
  const fakeCli = (
    name: string,
    behaviour: { ready?: string; extra?: string; exitCode?: number },
  ): string => {
    const script = join(dir, name);
    writeFileSync(
      script,
      "#!/usr/bin/env node\n" +
        // The SIGTERM handler before any output, so a stop right after "Ready!" finds it; the exit waits for the
        // write (a pipe is written asynchronously).
        (behaviour.exitCode === undefined
          ? 'process.on("SIGTERM", () => process.stdout.write("stopped\\n", () => process.exit(0)));\n' +
            "setInterval(() => undefined, 1000);\n"
          : `process.exitCode = ${behaviour.exitCode};\n`) +
        'process.stdout.write("args: " + process.argv.slice(2).join(" ") + "\\n");\n' +
        'process.stdout.write("key: " + (process.env.STRIPE_API_KEY ? "set" : "missing") + "\\n");\n' +
        (behaviour.extra === undefined
          ? ""
          : `process.stderr.write(${JSON.stringify(behaviour.extra)} + "\\n");\n`) +
        (behaviour.ready === undefined
          ? ""
          : `process.stderr.write(${JSON.stringify(behaviour.ready)} + "\\r\\n");\n`),
    );
    chmodSync(script, 0o755);
    return script;
  };

  const env = { ...process.env, ...stripeCliEnv(TEST_KEY) };
  const start = (cli: string, log: string, readyTimeoutMs?: number): Promise<StripeForwarder> =>
    startStripeForwarder({
      cli,
      env,
      forwardTo: FORWARD_TO,
      logFile: join(dir, log),
      ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
    });
  const failureOf = async (promise: Promise<StripeForwarder>): Promise<string> => {
    try {
      const forwarder = await promise;
      await forwarder.stop();
      return "(it started)";
    } catch (error) {
      return String(error);
    }
  };

  let readySecret = "";
  let readyLog = "";
  let billingLog = "";
  let exitedEarly = "";
  let withoutSecret = "";
  let tooSlow = "";
  let missing = "";

  // Each case spawns a stand-in CLI (a node process, about 50 ms idle; the slow one waits 1 s for its timeout): they
  // run here, once, with this budget, and the tests assert on what they left.
  beforeAll(async () => {
    const forwarder = await start(
      fakeCli("ready.js", {
        ready: `> Ready! You are using Stripe API Version [2025-09-30]. Your webhook signing secret is ${SECRET} (^C to quit)`,
      }),
      "ready.log",
    );
    readySecret = forwarder.webhookSecret;
    await forwarder.stop();
    await forwarder.stop();
    readyLog = readFileSync(join(dir, "ready.log"), "utf8");
    // The billing forwarder of E2E_STRIPE_BILLING=1: the same CLI with the billing events.
    const billing = await startStripeForwarder({
      cli: fakeCli("billing.js", {
        ready: `> Ready! You are using Stripe API Version [2025-09-30]. Your webhook signing secret is ${SECRET} (^C to quit)`,
      }),
      env,
      forwardTo: BILLING_FORWARD_TO,
      events: BILLING_STRIPE_EVENTS,
      logFile: join(dir, "billing.log"),
    });
    await billing.stop();
    billingLog = readFileSync(join(dir, "billing.log"), "utf8");
    exitedEarly = await failureOf(
      start(
        fakeCli("refused.js", { extra: `Authorization failed for ${TEST_KEY}, status=401`, exitCode: 1 }),
        "refused.log",
      ),
    );
    withoutSecret = await failureOf(start(fakeCli("no-secret.js", { ready: "> Ready!" }), "no-secret.log"));
    tooSlow = await failureOf(start(fakeCli("silent.js", {}), "silent.log", 1_000));
    missing = await failureOf(start(join(dir, "no-such-stripe"), "missing.log"));
  }, 30_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves with the signing secret once the CLI is ready, and logs its output redacted [OFE-017 AC1]", () => {
    expect(readySecret).toBe(SECRET);
    expect(readyLog).toContain(`args: ${stripeListenArgs(FORWARD_TO).join(" ")}`);
    expect(readyLog).toContain("key: set");
    expect(readyLog).toContain("Your webhook signing secret is whsec_[REDACTED] (^C to quit)");
    expect(readyLog).not.toContain(SECRET);
    expect(readyLog).not.toContain(TEST_KEY);
    // stop() sent SIGTERM and waited for the exit; a second stop() changes nothing.
    expect(readyLog).toContain("stopped");
  });

  it("[PFE-027 AC1] runs the billing forwarder with the billing events, its log redacted", () => {
    expect(billingLog).toContain(
      `args: ${stripeListenArgs(BILLING_FORWARD_TO, BILLING_STRIPE_EVENTS).join(" ")}`,
    );
    expect(billingLog).toContain(`--events ${BILLING_STRIPE_EVENTS.join(",")}`);
    expect(billingLog).toContain("key: set");
    expect(billingLog).not.toContain(SECRET);
    expect(billingLog).not.toContain(TEST_KEY);
  });

  it("fails with the CLI's redacted output when it exits before it is ready, never with the key", () => {
    expect(exitedEarly).toMatch(/stripe listen exited with code 1 before it was ready/);
    expect(exitedEarly).toContain("Authorization failed for sk_test_[REDACTED], status=401");
    expect(exitedEarly).not.toContain(TEST_KEY);
  });

  it("fails when the CLI says Ready! without a signing secret", () => {
    expect(withoutSecret).toMatch(/printed no webhook signing secret before "Ready!"/);
  });

  it("fails, and stops the CLI, when it is not ready in time", () => {
    expect(tooSlow).toMatch(/stripe listen was not ready within 1 s/);
    expect(readFileSync(join(dir, "silent.log"), "utf8")).toContain("stopped");
  });

  it("says how to install the CLI when it is not there", () => {
    expect(missing).toMatch(/the Stripe CLI was not found as ".*no-such-stripe"/);
    expect(missing).toMatch(/E2E_STRIPE_CLI/);
  });
});

describe("retrievePaymentIntent", () => {
  /** A fake fetch that records its calls and answers `status` with `body`. */
  const fakeFetch = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: StripeFetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
    return { calls, fetchImpl };
  };

  it("reads the PaymentIntent from Stripe's API with the test key as a bearer token [OFE-017 AC2]", async () => {
    const { calls, fetchImpl } = fakeFetch(200, {
      id: "pi_3QofeTest",
      status: "canceled",
      capture_method: "manual",
    });
    await expect(retrievePaymentIntent(TEST_KEY, "pi_3QofeTest", fetchImpl)).resolves.toEqual({
      id: "pi_3QofeTest",
      status: "canceled",
      captureMethod: "manual",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/payment_intents/pi_3QofeTest");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).toEqual({ Authorization: `Bearer ${TEST_KEY}` });
  });

  it("refuses a live key and anything but a PaymentIntent id before any request", async () => {
    const { calls, fetchImpl } = fakeFetch(200, {});
    await expect(retrievePaymentIntent(LIVE_KEY, "pi_3QofeTest", fetchImpl)).rejects.toThrow(/test-mode key/);
    await expect(retrievePaymentIntent(TEST_KEY, "pi_1/../../charges", fetchImpl)).rejects.toThrow(
      /not a PaymentIntent id/,
    );
    expect(calls).toEqual([]);
  });

  it("names the status of a refusal, never the key or the body", async () => {
    const { fetchImpl } = fakeFetch(401, { error: { message: `Invalid API Key provided: ${TEST_KEY}` } });
    const failure = await retrievePaymentIntent(TEST_KEY, "pi_3QofeTest", fetchImpl).catch(String);
    expect(failure).toBe("Error: Stripe answered 401 to GET /v1/payment_intents/pi_3QofeTest");
    const other = fakeFetch(200, { id: "pi_other", status: "succeeded" });
    await expect(retrievePaymentIntent(TEST_KEY, "pi_3QofeTest", other.fetchImpl)).rejects.toThrow(
      /is not that PaymentIntent/,
    );
  });
});

describe("the Stripe test objects of a journey (FIX-W43-SHARED)", () => {
  /** A fake fetch that records each call and answers with `answer(url, call number)`. */
  const fakeStripe = (answer: (url: string, n: number) => { status: number; body: unknown }) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: StripeFetch = (url, init) => {
      calls.push({ url, init });
      const { status, body } = answer(url, calls.length);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
    const forms = (): Record<string, string>[] =>
      calls.map((call) => Object.fromEntries(new URLSearchParams(String(call.init.body))));
    return { calls, fetchImpl, forms };
  };

  it("[PFE-027 AC1] creates a labelled product and its monthly price with the test key, as Stripe's API takes them", async () => {
    const stripe = fakeStripe((url) => ({
      status: 200,
      body: { id: url.endsWith("/v1/products") ? "prod_Fix43" : "price_1Fix43" },
    }));
    await expect(
      createTestProduct(TEST_KEY, "E2E Paid 1a2b", "portal-checkout", stripe.fetchImpl),
    ).resolves.toBe("prod_Fix43");
    await expect(
      createMonthlyTestPrice(
        TEST_KEY,
        { productId: "prod_Fix43", currency: "EUR", unitAmount: 1900, label: "portal-checkout" },
        stripe.fetchImpl,
      ),
    ).resolves.toBe("price_1Fix43");
    expect(stripe.calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", "https://api.stripe.com/v1/products"],
      ["POST", "https://api.stripe.com/v1/prices"],
    ]);
    for (const call of stripe.calls) {
      expect(call.init.headers).toEqual({
        Authorization: `Bearer ${TEST_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      });
    }
    expect(stripe.forms()).toEqual([
      { name: "E2E Paid 1a2b", "metadata[velexis_e2e]": "portal-checkout" },
      {
        product: "prod_Fix43",
        currency: "eur",
        unit_amount: "1900",
        "recurring[interval]": "month",
        "metadata[velexis_e2e]": "portal-checkout",
      },
    ]);
  });

  it("refuses a live key, a bad product id or amount before any request, and names only the status of a refusal", async () => {
    const stripe = fakeStripe(() => ({ status: 200, body: { id: "prod_Fix43" } }));
    await expect(createTestProduct(LIVE_KEY, "x", "y", stripe.fetchImpl)).rejects.toThrow(/test-mode key/);
    const price = { productId: "prod_Fix43", currency: "EUR", unitAmount: 1900, label: "y" };
    await expect(
      createMonthlyTestPrice(TEST_KEY, { ...price, productId: "prod_1/../x" }, stripe.fetchImpl),
    ).rejects.toThrow(/not a Stripe product id/);
    await expect(
      createMonthlyTestPrice(TEST_KEY, { ...price, unitAmount: 19.5 }, stripe.fetchImpl),
    ).rejects.toThrow(/positive amount in minor units/);
    expect(stripe.calls).toEqual([]);
    const refused = fakeStripe(() => ({
      status: 401,
      body: { error: { message: `Invalid API Key provided: ${TEST_KEY}` } },
    }));
    const failure = await createTestProduct(TEST_KEY, "x", "y", refused.fetchImpl).catch(String);
    expect(failure).toBe("Error: Stripe answered 401 to POST /v1/products");
    // An answer that names another kind of object is no product.
    const other = fakeStripe(() => ({ status: 200, body: { id: "price_1Fix43" } }));
    await expect(createTestProduct(TEST_KEY, "x", "y", other.fetchImpl)).rejects.toThrow(/names no product/);
  });

  it("[PFE-027 AC1] archives the prices, then the products, with active=false", async () => {
    const stripe = fakeStripe((url) => ({ status: 200, body: { id: url.split("/").at(-1), active: false } }));
    await archiveStripeTestObjects(
      TEST_KEY,
      { prices: ["price_1Fix43"], products: ["prod_Fix43"] },
      stripe.fetchImpl,
    );
    expect(stripe.calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", "https://api.stripe.com/v1/prices/price_1Fix43"],
      ["POST", "https://api.stripe.com/v1/products/prod_Fix43"],
    ]);
    expect(stripe.forms()).toEqual([{ active: "false" }, { active: "false" }]);
  });

  it("tries every object when one is refused, then names each refusal, never the key or the body", async () => {
    const stripe = fakeStripe((url, n) =>
      n === 1
        ? { status: 404, body: { error: { message: `No such price; key ${TEST_KEY}` } } }
        : { status: 200, body: { id: url.split("/").at(-1) } },
    );
    const failure = await archiveStripeTestObjects(
      TEST_KEY,
      { prices: ["price_1Gone"], products: ["prod_Fix43"] },
      stripe.fetchImpl,
    ).catch(String);
    expect(stripe.calls).toHaveLength(2);
    expect(failure).toBe(
      "Error: Stripe test objects left active:\n  - Stripe answered 404 to POST /v1/prices/price_1Gone",
    );
    expect(failure).not.toContain(TEST_KEY);
    // Every id is checked before the first request, and a live key is refused.
    const untouched = fakeStripe(() => ({ status: 200, body: {} }));
    await expect(
      archiveStripeTestObjects(
        TEST_KEY,
        { prices: ["price_1Ok"], products: ["prod_1?x=1"] },
        untouched.fetchImpl,
      ),
    ).rejects.toThrow(/not a Stripe product id/);
    await expect(
      archiveStripeTestObjects(LIVE_KEY, { prices: ["price_1Ok"], products: [] }, untouched.fetchImpl),
    ).rejects.toThrow(/Stripe test objects left active:[\s\S]*test-mode key/);
    expect(untouched.calls).toEqual([]);
  });

  // What the journey's Checkout made (lead decision 7(c) of 2026-11-05).
  const OTA = "ten_01JF44PXATF0RMCHECK00T0001";
  const OTHER_OTA = "ten_01JF44PXATF0RMS0ME0NE00002";
  const OWNER = "account+4f0c2b1e-7d3a-4e5f-9a1b-2c3d4e5f6a7b@example.com";
  const scope = { priceId: "price_1Fix44", email: OWNER, tenantIds: [OTA] } as const;
  /** A list answer of Stripe's, `{object: "list", data, has_more}`. */
  const list = (data: unknown[]) => ({ status: 200, body: { object: "list", data, has_more: false } });

  it("[FIX-W44-PLATFORM AC1] finds only the subscription to the journey's price and the Customer of its owner's OTA", async () => {
    const stripe = fakeStripe((url) =>
      new URL(url).pathname === "/v1/subscriptions"
        ? list([
            { id: "sub_1Own", status: "active", metadata: { velexis_tenant_id: OTA } },
            { id: "sub_1Pending", status: "incomplete", metadata: { velexis_tenant_id: OTA } },
            { id: "sub_1Ended", status: "canceled", metadata: { velexis_tenant_id: OTA } },
            { id: "sub_1Expired", status: "incomplete_expired", metadata: { velexis_tenant_id: OTA } },
            { id: "sub_1Foreign", status: "active", metadata: { velexis_tenant_id: OTHER_OTA } },
            { id: "sub_1NoMetadata", status: "active", metadata: {} },
            { id: "cus_NotASubscription", status: "active", metadata: { velexis_tenant_id: OTA } },
          ])
        : list([
            { id: "cus_Own", email: OWNER, metadata: { velexis_tenant_id: OTA } },
            { id: "cus_ForeignOta", email: OWNER, metadata: { velexis_tenant_id: OTHER_OTA } },
            { id: "cus_OtherEmail", email: OWNER.toUpperCase(), metadata: { velexis_tenant_id: OTA } },
            { id: "cus_NoMetadata", email: OWNER },
          ]),
    );
    await expect(findCheckoutTestObjects(TEST_KEY, scope, stripe.fetchImpl)).resolves.toEqual({
      subscriptions: ["sub_1Own", "sub_1Pending"],
      customers: ["cus_Own"],
    });
    // Two reads with the test key alone: the subscriptions of the journey's price in every status, and the Customers
    // with the owner's address.
    const requests = stripe.calls.map((call) => {
      const url = new URL(call.url);
      return [call.init.method, url.origin + url.pathname, Object.fromEntries(url.searchParams)];
    });
    expect(requests).toEqual([
      [
        "GET",
        "https://api.stripe.com/v1/subscriptions",
        { price: "price_1Fix44", status: "all", limit: "100" },
      ],
      ["GET", "https://api.stripe.com/v1/customers", { email: OWNER, limit: "100" }],
    ]);
    for (const call of stripe.calls) {
      expect(call.init.headers).toEqual({ Authorization: `Bearer ${TEST_KEY}` });
      expect(call.init.body).toBeUndefined();
    }
  });

  it("[FIX-W44-PLATFORM AC1] refuses a live key, a foreign id or address before any request, and looks up nothing without an OTA", async () => {
    const untouched = fakeStripe(() => list([]));
    await expect(findCheckoutTestObjects(LIVE_KEY, scope, untouched.fetchImpl)).rejects.toThrow(
      /test-mode key/,
    );
    await expect(
      findCheckoutTestObjects(TEST_KEY, { ...scope, priceId: "price_1&status=active" }, untouched.fetchImpl),
    ).rejects.toThrow(/not a Stripe price id/);
    await expect(
      findCheckoutTestObjects(TEST_KEY, { ...scope, email: "owner" }, untouched.fetchImpl),
    ).rejects.toThrow(/e-mail address/);
    await expect(
      findCheckoutTestObjects(TEST_KEY, { ...scope, tenantIds: [OTA, "ten_x' OR '1"] }, untouched.fetchImpl),
    ).rejects.toThrow(/not an OTA id/);
    await expect(
      findCheckoutTestObjects(TEST_KEY, { ...scope, tenantIds: [] }, untouched.fetchImpl),
    ).resolves.toEqual({ subscriptions: [], customers: [] });
    expect(untouched.calls).toEqual([]);
  });

  it("[FIX-W44-PLATFORM AC1] names the read Stripe refused by its path and status, never the key, the address or the body", async () => {
    const refused = fakeStripe((url) =>
      new URL(url).pathname === "/v1/customers"
        ? { status: 401, body: { error: { message: `Invalid API Key provided: ${TEST_KEY} for ${OWNER}` } } }
        : list([]),
    );
    const failure = await findCheckoutTestObjects(TEST_KEY, scope, refused.fetchImpl).catch(String);
    expect(failure).toBe("Error: Stripe answered 401 to GET /v1/customers");
    // An answer without a list finds nothing to remove: it fails instead.
    const notAList = fakeStripe(() => ({ status: 200, body: { object: "subscription", id: "sub_1Own" } }));
    await expect(findCheckoutTestObjects(TEST_KEY, scope, notAList.fetchImpl)).rejects.toThrow(
      "Stripe's answer to GET /v1/subscriptions is not a list",
    );
    // An answer that is not JSON fails without the parser's quote of the body.
    const notJson: StripeFetch = () =>
      Promise.resolve(new Response(`<html>${TEST_KEY} ${OWNER}</html>`, { status: 200 }));
    const unparsed = await findCheckoutTestObjects(TEST_KEY, scope, notJson).catch(String);
    expect(unparsed).toBe("Error: Stripe's answer to GET /v1/subscriptions is not JSON");
  });

  it("[FIX-W44-PLATFORM AC1] cancels the subscriptions, then deletes the Customers", async () => {
    const stripe = fakeStripe((url) => {
      const id = url.split("/").at(-1);
      return {
        status: 200,
        body: url.includes("/v1/subscriptions/")
          ? // An `incomplete` subscription (its first payment never went through) can end as `incomplete_expired`.
            { id, object: "subscription", status: id === "sub_1Pending" ? "incomplete_expired" : "canceled" }
          : { id, object: "customer", deleted: true },
      };
    });
    await removeCheckoutTestObjects(
      TEST_KEY,
      { subscriptions: ["sub_1Own", "sub_1Pending"], customers: ["cus_Own"] },
      stripe.fetchImpl,
    );
    expect(stripe.calls.map((call) => [call.init.method, call.url])).toEqual([
      ["DELETE", "https://api.stripe.com/v1/subscriptions/sub_1Own"],
      ["DELETE", "https://api.stripe.com/v1/subscriptions/sub_1Pending"],
      ["DELETE", "https://api.stripe.com/v1/customers/cus_Own"],
    ]);
    for (const call of stripe.calls) {
      expect(call.init.headers).toEqual({ Authorization: `Bearer ${TEST_KEY}` });
      expect(call.init.body).toBeUndefined();
    }
  });

  it("[FIX-W44-PLATFORM AC1] tries every object when one is refused or not removed, then names each, never the key or the body", async () => {
    const stripe = fakeStripe((url, n) => {
      const id = url.split("/").at(-1);
      if (n === 1) {
        return { status: 404, body: { error: { message: `No such subscription; key ${TEST_KEY}` } } };
      }
      return n === 2
        ? { status: 200, body: { id, object: "subscription", status: "active" } }
        : { status: 200, body: { id, object: "customer", deleted: true } };
    });
    const failure = await removeCheckoutTestObjects(
      TEST_KEY,
      { subscriptions: ["sub_1Gone", "sub_1Stays"], customers: ["cus_Own"] },
      stripe.fetchImpl,
    ).catch(String);
    expect(stripe.calls).toHaveLength(3);
    expect(failure).toBe(
      "Error: Stripe test objects left behind:\n" +
        "  - Stripe answered 404 to DELETE /v1/subscriptions/sub_1Gone\n" +
        "  - Stripe's answer to DELETE /v1/subscriptions/sub_1Stays is not that subscription removed",
    );
    expect(failure).not.toContain(TEST_KEY);
    // Every id is checked before the first request, and a live key is refused.
    const untouched = fakeStripe(() => ({ status: 200, body: {} }));
    await expect(
      removeCheckoutTestObjects(
        TEST_KEY,
        { subscriptions: ["sub_1Ok"], customers: ["cus_1/../../products"] },
        untouched.fetchImpl,
      ),
    ).rejects.toThrow(/not a Stripe customer id/);
    await expect(
      removeCheckoutTestObjects(
        TEST_KEY,
        { subscriptions: ["price_1Fix44"], customers: [] },
        untouched.fetchImpl,
      ),
    ).rejects.toThrow(/not a Stripe subscription id/);
    await expect(
      removeCheckoutTestObjects(LIVE_KEY, { subscriptions: [], customers: ["cus_Own"] }, untouched.fetchImpl),
    ).rejects.toThrow(/Stripe test objects left behind:[\s\S]*test-mode key/);
    expect(untouched.calls).toEqual([]);
  });
});

describe("the card page helpers", () => {
  /** The Luhn check of a card number. */
  const luhn = (digits: string): boolean =>
    [...digits]
      .reverse()
      .map(Number)
      .reduce(
        (sum, digit, index) => sum + (index % 2 === 1 ? (digit * 2 > 9 ? digit * 2 - 9 : digit * 2) : digit),
        0,
      ) %
      10 ===
    0;

  it("uses Stripe's documented test cards only: 3-D Secure 4000 0027 6000 3184 and 4242 4242 4242 4242", async () => {
    expect(STRIPE_TEST_CARDS).toEqual({ threeDSecure: "4000002760003184", visa: "4242424242424242" });
    for (const number of Object.values(STRIPE_TEST_CARDS)) {
      expect(luhn(number)).toBe(true);
    }
    // Refused before the page is touched.
    await expect(fillCardForm({} as Page, "4111111111111111")).rejects.toThrow(/documented test cards only/);
  });

  it("types an expiry three years ahead, as month and two-digit year", () => {
    expect(testCardExpiry(new Date(Date.UTC(2026, 9, 28)))).toBe("1229");
    expect(testCardExpiry(new Date(Date.UTC(2097, 0, 1)))).toBe("1200");
    expect(testCardExpiry()).toMatch(/^12\d{2}$/);
  });
});
