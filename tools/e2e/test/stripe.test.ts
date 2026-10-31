// support/stripe.ts (OFE-017): the Stripe CLI forwarder against a stand-in `stripe` (no network, no key), the
// redaction of its output, the PaymentIntent read against a fake fetch, and the test-card guards.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../support/stack";
import {
  fillCardForm,
  isReadyLine,
  OTA_STRIPE_EVENTS,
  OTA_WEBHOOK_PATH,
  redactStripeOutput,
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
