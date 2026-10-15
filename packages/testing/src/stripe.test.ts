import { createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stripeModule from "./stripe.js";
import {
  scanStripeFixture,
  signedStripeEvent,
  STRIPE_FIXTURE_EVENT_TYPES,
  STRIPE_FIXTURES_DIR,
  STRIPE_TEST_ACCOUNT_ID,
  STRIPE_TEST_TENANT_ID,
  stripeFixture,
  stripeFixturePath,
  type StripeEventOverrides,
  type StripeFixtureEvent,
  type StripeFixtureEventType,
} from "./stripe.js";

// Tests of task X-028: the signed Stripe webhook fixtures of @velexis/testing/stripe.

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const PACKAGE_DIR = resolve(__dirname, "..");

/** A fresh signing secret per test, as `stripe listen` or the dashboard would print one; never a committed value. */
function newSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

function fixtureText(type: StripeFixtureEventType): string {
  return readFileSync(stripeFixturePath(type), "utf8");
}

/** The error `fn` throws (fails the test when it does not throw). */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected a throw");
}

/** Every way of changing a signed body that a webhook receiver must refuse. */
const TAMPERINGS: ReadonlyArray<{ readonly name: string; readonly change: (payload: string) => string }> = [
  {
    name: "one value changed",
    change: (payload) => payload.replace('"livemode": false', '"livemode": true'),
  },
  {
    name: "the event id changed",
    change: (payload) => payload.replace(/"id": "evt_test_/, '"id": "evt_tesT_'),
  },
  { name: "whitespace appended", change: (payload) => `${payload}\n` },
  { name: "re-serialised without indentation", change: (payload) => JSON.stringify(JSON.parse(payload)) },
  { name: "one byte removed", change: (payload) => payload.slice(0, -2) + payload.slice(-1) },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("signed fixtures and stripe.webhooks.constructEvent", () => {
  it.each(STRIPE_FIXTURE_EVENT_TYPES)("constructEvent accepts the signed %s fixture [X-028 AC1]", (type) => {
    const secret = newSecret();
    const { payload, header, event } = signedStripeEvent(type, {}, secret);

    const verified = Stripe.webhooks.constructEvent(payload, header, secret);
    expect(verified.type).toBe(type);
    expect(verified).toEqual(JSON.parse(payload));
    expect(verified).toEqual(event);
    expect(verified).toEqual(stripeFixture(type));
    // The raw body as a Buffer, as a receiver with a raw-body parser gets it.
    expect(Stripe.webhooks.constructEvent(Buffer.from(payload, "utf8"), header, secret).id).toBe(event.id);
  });

  it.each(STRIPE_FIXTURE_EVENT_TYPES)(
    "constructEvent rejects the %s fixture when the payload is changed after signing [X-028 AC1]",
    (type) => {
      const secret = newSecret();
      const { payload, header } = signedStripeEvent(type, {}, secret);
      for (const { name, change } of TAMPERINGS) {
        const tampered = change(payload);
        expect(tampered, name).not.toBe(payload);
        const error = thrown(() => Stripe.webhooks.constructEvent(tampered, header, secret));
        expect(error, name).toBeInstanceOf(Stripe.errors.StripeSignatureVerificationError);
      }
    },
  );

  it("constructEvent rejects another secret, a changed timestamp and a timestamp outside the tolerance [X-028 AC1]", () => {
    const secret = newSecret();
    const { payload, header } = signedStripeEvent("payment_intent.succeeded", {}, secret);
    expect(() => Stripe.webhooks.constructEvent(payload, header, newSecret())).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );

    const t = Number(/^t=(\d+),/.exec(header)?.[1]);
    const shifted = header.replace(`t=${t},`, `t=${t - 1},`);
    expect(() => Stripe.webhooks.constructEvent(payload, shifted, secret)).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );

    // Signed 301 s before the receiver's clock: outside Stripe's default tolerance of 300 s (replay protection).
    const old = signedStripeEvent("payment_intent.succeeded", {}, secret, { timestamp: 1_791_799_200 });
    expect(() =>
      Stripe.webhooks.constructEvent(
        old.payload,
        old.header,
        secret,
        undefined,
        undefined,
        1_791_799_501_000,
      ),
    ).toThrow(/tolerance/);
    expect(
      Stripe.webhooks.constructEvent(old.payload, old.header, secret, undefined, undefined, 1_791_799_500_000)
        .id,
    ).toBe("evt_test_pi_succeeded");
  });

  it("signs with Stripe's documented scheme: t=<unix seconds>,v1=hex(HMAC-SHA256(secret, `${t}.${payload}`))", () => {
    const secret = newSecret();
    const { payload, header } = signedStripeEvent("charge.refunded", {}, secret, {
      timestamp: 1_791_972_000,
    });
    const expected = createHmac("sha256", secret).update(`1791972000.${payload}`, "utf8").digest("hex");
    expect(header).toBe(`t=1791972000,v1=${expected}`);
  });
});

describe("signedStripeEvent", () => {
  it("deep-merges the overrides into the fixture: siblings kept, arrays and scalars replaced, undefined removes", () => {
    const secret = newSecret();
    const { payload, header, event } = signedStripeEvent(
      "payment_intent.succeeded",
      {
        id: "evt_test_pi_succeeded_2",
        livemode: true,
        data: {
          object: {
            amount_received: 1000,
            customer: null,
            latest_charge: "ch_test_alpha_2",
            metadata: { velexis_tenant_id: "ten_test_beta", payment_id: undefined, extra: "1" },
            payment_method_types: ["link"],
          },
        },
      },
      secret,
    );
    expect(event.id).toBe("evt_test_pi_succeeded_2");
    expect(event.livemode).toBe(true);
    expect(event.type).toBe("payment_intent.succeeded");
    const intent = event.data.object;
    expect(intent.amount_received).toBe(1000);
    expect(intent.amount).toBe(45210); // a sibling of a changed field
    expect(intent.latest_charge).toBe("ch_test_alpha_2");
    expect(intent.payment_method_types).toEqual(["link"]);
    expect(intent.metadata).toEqual({
      checkout_id: "chk_test_alpha_1",
      velexis_environment: "test",
      velexis_tenant_id: "ten_test_beta",
      extra: "1",
    });
    expect(intent.payment_method_options).toEqual(
      stripeFixture("payment_intent.succeeded").data.object.payment_method_options,
    );
    expect(Stripe.webhooks.constructEvent(payload, header, secret)).toEqual(event);
  });

  it("serialises once, as Stripe does (two-space JSON), and never changes the fixture", () => {
    const before = fixtureText("invoice.paid");
    const first = signedStripeEvent("invoice.paid", { data: { object: { amount_paid: 1 } } }, newSecret());
    expect(first.payload).toBe(JSON.stringify(first.event, null, 2));
    expect(first.payload).toContain("1 × Growth (at €49.00 / month)"); // UTF-8 kept as is, signed as is

    first.event.data.object.status = "void";
    const again = signedStripeEvent("invoice.paid", undefined, newSecret());
    expect(again.event.data.object.amount_paid).toBe(4900);
    expect(again.event.data.object.status).toBe("paid");
    expect(again.event).toEqual(stripeFixture("invoice.paid"));
    expect(fixtureText("invoice.paid")).toBe(before);

    const copy = stripeFixture("invoice.paid");
    copy.data.object.status = "void";
    expect(stripeFixture("invoice.paid").data.object.status).toBe("paid");
  });

  it("an object override replaces null, an object over a scalar becomes the object, and null replaces an object", () => {
    const { event } = signedStripeEvent(
      "payment_intent.payment_failed",
      { data: { object: { shipping: { name: "Test Traveller", phone: null } } } },
      newSecret(),
    );
    expect(event.data.object.shipping).toEqual({ name: "Test Traveller", phone: null });

    // An expanded object over an id string, and null over an object (null is a value, not "keep the fixture's").
    const secret = newSecret();
    const fixture = stripeFixture("checkout.session.completed").data.object;
    expect(fixture.customer).toBe("cus_test_alpha");
    expect(fixture.customer_details).not.toBeNull();
    const changed = signedStripeEvent(
      "checkout.session.completed",
      {
        data: {
          object: {
            customer: { id: "cus_test_alpha", object: "customer", email: "owner+alpha@example.com" },
            customer_details: null,
          },
        },
      },
      secret,
    );
    expect(changed.event.data.object.customer).toEqual({
      id: "cus_test_alpha",
      object: "customer",
      email: "owner+alpha@example.com",
    });
    expect(changed.event.data.object.customer_details).toBeNull();
    expect(changed.event.data.object.client_reference_id).toBe(STRIPE_TEST_TENANT_ID);
    expect(Stripe.webhooks.constructEvent(changed.payload, changed.header, secret)).toEqual(changed.event);
  });

  it("treats a __proto__ key in the overrides as data, never as a prototype", () => {
    const overrides = JSON.parse(
      '{"data":{"object":{"metadata":{"__proto__":{"polluted":"yes"}}}}}',
    ) as StripeEventOverrides<StripeFixtureEvent<"charge.refunded">>;
    const { payload, event } = signedStripeEvent("charge.refunded", overrides, newSecret());
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(event.data.object.metadata)).toBe(Object.prototype);
    expect(payload).toContain('"__proto__": {');
  });

  it("signs with the given timestamp (Unix seconds or a Date), or now by default (fake timers move it)", () => {
    const secret = newSecret();
    expect(signedStripeEvent("invoice.paid", {}, secret, { timestamp: 1_791_795_899 }).header).toMatch(
      /^t=1791795899,v1=[0-9a-f]{64}$/,
    );
    expect(
      signedStripeEvent("invoice.paid", {}, secret, { timestamp: new Date("2026-10-12T09:04:59.900Z") })
        .header,
    ).toMatch(/^t=1791795899,v1=/);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
    const now = signedStripeEvent("payment_intent.amount_capturable_updated", {}, secret);
    expect(now.header).toMatch(/^t=1791799200,v1=/);
    expect(Stripe.webhooks.constructEvent(now.payload, now.header, secret).type).toBe(
      "payment_intent.amount_capturable_updated",
    );
  });

  it("refuses a missing secret, an unknown type, overrides that are not an object and a bad timestamp", () => {
    const secret = newSecret();
    expect(() => signedStripeEvent("invoice.paid", {}, "")).toThrow(TypeError);
    expect(() => signedStripeEvent("invoice.paid", {}, undefined as unknown as string)).toThrow(TypeError);
    const unknown = thrown(() =>
      signedStripeEvent("payment_intent.created" as StripeFixtureEventType, {}, secret),
    );
    expect(unknown).toBeInstanceOf(TypeError);
    expect(unknown.message).toContain('"payment_intent.created"');
    expect(unknown.message).toContain("charge.dispute.created");
    expect(() => signedStripeEvent("invoice.paid", [] as never, secret)).toThrow(TypeError);
    for (const timestamp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, new Date(Number.NaN)]) {
      expect(() => signedStripeEvent("invoice.paid", {}, secret, { timestamp })).toThrow(RangeError);
    }
    // No error message ever repeats the secret.
    const errors = [
      thrown(() => signedStripeEvent("invoice.paid", [] as never, secret)),
      thrown(() => signedStripeEvent("invoice.paid", {}, secret, { timestamp: -1 })),
    ];
    for (const error of errors) {
      expect(error.message).not.toContain(secret);
    }
  });

  it("types the overrides by the event type", () => {
    // Compile-time checks only (pnpm typecheck); the function is never called.
    const typed = (secret: string): void => {
      signedStripeEvent(
        "payment_intent.succeeded",
        { data: { object: { status: "requires_capture" } } },
        secret,
      );
      signedStripeEvent(
        "charge.dispute.created",
        { data: { object: { status: "won", metadata: {} } } },
        secret,
      );
      // @ts-expect-error amounts are numbers of minor units
      signedStripeEvent("payment_intent.succeeded", { data: { object: { amount: "45210" } } }, secret);
      // @ts-expect-error "paid" is not a status of a PaymentIntent
      signedStripeEvent("payment_intent.succeeded", { data: { object: { status: "paid" } } }, secret);
      // @ts-expect-error there is no fixture for payment_intent.created
      signedStripeEvent("payment_intent.created", {}, secret);
    };
    expect(typeof typed).toBe("function");
  });
});

/** The event types of the webhook table of architecture.md §5 (d): exact types and `prefix.*` patterns. */
function webhookTableEventPatterns(): { endpoint: string; patterns: string[] }[] {
  const architecture = readFileSync(join(REPO_ROOT, "docs/mvp/architecture.md"), "utf8");
  const section = architecture.split(/^### /m).find((part) => part.startsWith("(d) Stripe webhooks"));
  expect(section, "architecture.md §5 (d)").toBeDefined();
  const rows = (section ?? "")
    .split("\n")
    .filter((line) => line.startsWith("| `/webhooks/stripe/"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  expect(rows.length).toBeGreaterThanOrEqual(5);
  return rows.map((cells) => {
    const endpoint = cells[1] ?? "";
    const events = cells[3] ?? "";
    const patterns = [...events.matchAll(/`([a-z_]+(?:\.[a-z_*]+)+)`/g)].map((match) => match[1] ?? "");
    if (patterns.length === 0) {
      // The M5 connect/ and c/ endpoints receive the same payment events as velexis/ (covered there).
      expect(events, endpoint).toMatch(/^Same payment events/);
    }
    return { endpoint, patterns };
  });
}

/** The keys whose string values are ids of Stripe or Velexis objects. */
const ID_KEYS = new Set([
  "id",
  "account",
  "balance_transaction",
  "charge",
  "checkout_id",
  "client_reference_id",
  "customer",
  "default_payment_method",
  "invoice",
  "latest_charge",
  "latest_invoice",
  "payment_id",
  "payment_intent",
  "payment_method",
  "price",
  "product",
  "source",
  "subscription",
  "subscription_item",
  "velexis_subscription_id",
  "velexis_tenant_id",
]);

/** Every string value under an id key, at any depth, with its JSON path. */
function collectIds(value: unknown, path = "$"): { path: string; value: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectIds(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === "string" && ID_KEYS.has(key)
      ? [{ path: `${path}.${key}`, value: child }]
      : collectIds(child, `${path}.${key}`),
  );
}

function matchesPattern(type: string, pattern: string): boolean {
  return pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : type === pattern;
}

describe("the fixtures", () => {
  it("cover every event type of the webhook table in architecture.md §5 (d), one file per type [X-028 AC2]", () => {
    const table = webhookTableEventPatterns();
    const patterns = table.flatMap((row) => row.patterns);
    expect(patterns).toEqual(
      expect.arrayContaining([
        "payment_intent.*",
        "charge.refunded",
        "charge.dispute.*",
        "checkout.session.completed",
        "customer.subscription.*",
        "invoice.*",
        "account.updated",
        "account.application.deauthorized",
      ]),
    );
    for (const pattern of patterns) {
      expect(
        STRIPE_FIXTURE_EVENT_TYPES.filter((type) => matchesPattern(type, pattern)),
        `a fixture for ${pattern}`,
      ).not.toEqual([]);
    }
    for (const type of STRIPE_FIXTURE_EVENT_TYPES) {
      expect(
        patterns.some((pattern) => matchesPattern(type, pattern)),
        `${type} is in the webhook table`,
      ).toBe(true);
    }
    // The files of the folder are exactly the fixtures of STRIPE_FIXTURE_EVENT_TYPES.
    const files = readdirSync(STRIPE_FIXTURES_DIR).filter((file) => file.endsWith(".json"));
    expect(files.sort()).toEqual(STRIPE_FIXTURE_EVENT_TYPES.map((type) => `${type}.json`).sort());
    // And the folder is the package's fixtures/stripe, next to src/ and dist/.
    expect(STRIPE_FIXTURES_DIR).toBe(join(PACKAGE_DIR, "fixtures", "stripe"));
  });

  it.each(STRIPE_FIXTURE_EVENT_TYPES)(
    "%s contains no real key, e-mail address or card number [X-028 AC2]",
    (type) => {
      const text = fixtureText(type);
      expect(text).not.toMatch(/sk_live|rk_live|sk_test_|rk_test_|whsec_/);
      for (const match of text.matchAll(/@/g)) {
        expect(text.slice(match.index + 1, match.index + 13), `the @ at offset ${match.index}`).toMatch(
          /^example\.com[^A-Za-z0-9.-]/,
        );
      }
      expect(text).not.toMatch(/(?<!\d)\d{13,19}(?!\d)/);
      expect(scanStripeFixture(text)).toEqual([]);
    },
  );

  it("the scan fails on a fixture copy with a live key, a real-looking e-mail address and a card number [X-028 AC2]", () => {
    const original = fixtureText("payment_intent.succeeded");
    expect(scanStripeFixture(original)).toEqual([]);
    // The bad values are built here, so this file holds no key-shaped or card-shaped literal itself.
    const liveKey = ["sk", "live", "x".repeat(24)].join("_");
    const cases: ReadonlyArray<{ readonly kind: string; readonly find: string; readonly replace: string }> = [
      { kind: "api-key", find: "pi_test_alpha_1_secret_synthetic", replace: liveKey },
      { kind: "api-key", find: '"review": null', replace: `"review": "${["rk", "test", "abc"].join("_")}"` },
      { kind: "webhook-secret", find: "ALPHA TRAVEL", replace: ["whsec", "abc"].join("_") },
      { kind: "email", find: '"receipt_email": null', replace: '"receipt_email": "traveller@gmail.com"' },
      {
        kind: "email",
        find: '"receipt_email": null',
        replace: '"receipt_email": "a@example.com.attacker.test"',
      },
      { kind: "digit-run", find: '"review": null', replace: `"review": "${"4242".repeat(4)}"` },
      { kind: "digit-run", find: '"review": null', replace: '"review": "4000 0027 6000 3184"' },
      { kind: "digit-run", find: '"review": null', replace: '"review": "4000-0027-6000-3184"' },
      { kind: "digit-run", find: '"created": 1791799200', replace: `"created": ${"1".repeat(13)}` },
      { kind: "live-mode", find: '"livemode": false', replace: '"livemode": true' },
    ];
    const bads: string[] = [];
    for (const { kind, find, replace } of cases) {
      expect(original, kind).toContain(find);
      const bad = original.replace(find, replace);
      bads.push(bad);
      const findings = scanStripeFixture(bad);
      expect(
        findings.map((finding) => finding.kind),
        kind,
      ).toEqual([kind]);
      const [finding] = findings;
      expect(finding?.line, kind).toBe(original.slice(0, original.indexOf(find)).split("\n").length);
      // The message says what and where, never the value.
      expect(finding?.message).toMatch(/^line \d+, column \d+: /);
      expect(finding?.message).not.toContain("x".repeat(24));
      expect(finding?.message).not.toContain("gmail");
    }
    // All of them in one text: every finding, in the order of the text.
    const all = scanStripeFixture(bads.join(""));
    expect(all.length).toBe(cases.length);
    expect(all.map((finding) => finding.line)).toEqual(
      [...all.map((finding) => finding.line)].sort((a, b) => a - b),
    );
    // 12 digits, a phone-like group and dates are not card numbers.
    expect(scanStripeFixture('"a": "424242424242", "b": "+33 1 23 45 67 89", "c": "2026-10-12"')).toEqual([]);
  });

  it.each(STRIPE_FIXTURE_EVENT_TYPES)(
    "%s is a test-mode event of the SDK's API version with synthetic ids",
    (type) => {
      const text = fixtureText(type);
      const event = JSON.parse(text) as Record<string, unknown> & {
        data: { object: Record<string, unknown> };
      };
      expect(event).toMatchObject({
        object: "event",
        type,
        livemode: false,
        api_version: Stripe.API_VERSION,
      });
      expect(event["id"]).toMatch(/^evt_test_[a-z_]+$/);
      expect(Number.isInteger(event["created"])).toBe(true);
      expect(event.data.object["id"]).toMatch(/^[a-z]+_test_[a-z_0-9]+$/);
      if ("livemode" in event.data.object) {
        expect(event.data.object["livemode"]).toBe(false);
      }
      // Every id and every reference to an object is synthetic: <prefix>_test_… (sub_velexis_test_… for ours).
      const ids = collectIds(event);
      expect(ids.length).toBeGreaterThan(1);
      for (const { path, value } of ids) {
        expect(value, `${path} in ${type}`).toMatch(/^[a-z]+_(?:velexis_)?test_[a-z0-9_]+$/);
      }
      // Prettier keeps the files as written (pnpm format:check) and they end with one newline.
      expect(text.endsWith("}\n")).toBe(true);
    },
  );

  it("carry the tenant where the webhook table says it comes from", () => {
    const paymentTypes = [
      "payment_intent.amount_capturable_updated",
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "charge.refunded",
    ] as const;
    for (const type of paymentTypes) {
      // velexis/{test,live}: metadata.velexis_tenant_id (ADR-0011: tenant, environment, checkout and payment).
      expect(stripeFixture(type).data.object.metadata, type).toEqual({
        velexis_tenant_id: STRIPE_TEST_TENANT_ID,
        velexis_environment: "test",
        checkout_id: "chk_test_alpha_1",
        payment_id: "pay_test_alpha_1",
      });
    }
    // A dispute has its own metadata, which Stripe does not fill from the charge: the tenant is on the disputed charge.
    const dispute = stripeFixture("charge.dispute.created").data.object;
    expect(dispute.metadata).toEqual({});
    const charge = stripeFixture("charge.refunded").data.object;
    expect(dispute.charge).toBe(charge.id);
    expect(dispute.payment_intent).toBe(charge.payment_intent);
    expect(charge.metadata["velexis_tenant_id"]).toBe(STRIPE_TEST_TENANT_ID);

    // billing: client_reference_id, or the subscription metadata (ADR-0013, platform flow subscription-billing §B).
    const tenantMetadata = {
      velexis_tenant_id: STRIPE_TEST_TENANT_ID,
      velexis_subscription_id: "sub_velexis_test_alpha",
      velexis_plan_code: "growth",
    };
    const session = stripeFixture("checkout.session.completed").data.object;
    expect(session.client_reference_id).toBe(STRIPE_TEST_TENANT_ID);
    expect(session.mode).toBe("subscription");
    expect(session.metadata).toEqual(tenantMetadata);
    const subscription = stripeFixture("customer.subscription.updated").data.object;
    expect(subscription.metadata).toEqual(tenantMetadata);
    expect(session.subscription).toBe(subscription.id);
    const invoice = stripeFixture("invoice.paid").data.object;
    expect(invoice.parent?.subscription_details?.metadata).toEqual(tenantMetadata);
    expect(invoice.parent?.subscription_details?.subscription).toBe(subscription.id);
    expect(session.invoice).toBe(invoice.id);

    // connect-accounts (M5): event.account.
    expect(stripeFixture("account.updated").account).toBe(STRIPE_TEST_ACCOUNT_ID);
    expect(stripeFixture("account.updated").data.object.id).toBe(STRIPE_TEST_ACCOUNT_ID);
    expect(stripeFixture("account.application.deauthorized").account).toBe(STRIPE_TEST_ACCOUNT_ID);
  });
});

describe("the @velexis/testing/stripe subpath", () => {
  it("is exported from dist/stripe.js, which tsc builds from src/stripe.ts, and ships the fixtures", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
      files: string[];
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(manifest.exports["./stripe"]).toEqual({
      types: "./dist/stripe.d.ts",
      default: "./dist/stripe.js",
    });
    expect(manifest.files).toContain("fixtures");
    // stripe 18.x, exact, a devDependency only (ADR-0022 item 2; tech-stack.md).
    expect(manifest.devDependencies["stripe"]).toMatch(/^18\.\d+\.\d+$/);
    expect(manifest.dependencies["stripe"]).toBeUndefined();
    expect(Object.keys(stripeModule)).toEqual(
      expect.arrayContaining([
        "signedStripeEvent",
        "stripeFixture",
        "stripeFixturePath",
        "scanStripeFixture",
        "STRIPE_FIXTURE_EVENT_TYPES",
        "STRIPE_FIXTURES_DIR",
        "STRIPE_TEST_TENANT_ID",
        "STRIPE_TEST_ACCOUNT_ID",
        "STRIPE_SIGNATURE_HEADER",
      ]),
    );
  });
});
