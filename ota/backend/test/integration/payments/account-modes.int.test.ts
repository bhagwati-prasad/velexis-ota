// The three Stripe account modes of a tenant's payment connection (OBE-077; OADR-0010 point 1, ADR-0011 (A), PADR-0011
// points 1 and 7, api-changes §4), against PostgreSQL 16, Redis 7, the Amadeus stub and a fake of the Stripe API: the same
// code serves `velexis`, `connect_standard` and `api_keys`, and what differs per mode is only what reaches Stripe (the
// key and the `Stripe-Account` header) and what storefront.get gives the browser (the publishable key, `accountId`, the
// merchant and the statement descriptor) [OF-12 AC1]. Stripe is mocked at the HTTP layer: the API's own `stripe` SDK
// client sends its requests to test/helpers/fake-stripe.ts on the loopback interface.
//
// The file clones the @velexis/testing template (tenant_alpha provisioned), writes the platform rows as the platform
// does (alpha on the Velexis test Amadeus account, with the `velexis` test payment connection of provisioning), and
// switches that one connection row in place between the modes as the platform's payments page does (PADR-0011 point 1:
// the same `ppc_` id, `version + 1`), publishing the `connection` invalidation after each switch. The OTA's own secret
// key and webhook secret are envelope-encrypted with the test KEKs and the connection's associated data, as the platform
// stores them. A payment made before a switch keeps its account through the payment steps and checkout.complete's read
// and capture (PADR-0011 point 7). Every key is built at run time; none is real. Every answer is checked against the
// OTA document.
import { randomBytes } from "node:crypto";
import { INVALIDATION_CHANNEL } from "@velexis/api-types/jobs";
import { encryptValue, hashApiKey, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { connectionSecretAad } from "../../../src/payments/stripe/stripe-client.factory";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildStripeConfirmation } from "../../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import { journeyAmadeusLimitsModule } from "../../helpers/amadeus-limits";
import {
  edgeHeaders,
  edgeWriteHeaders,
  testApiCredentials,
  testKeyProvider,
  newApiKey,
} from "../../helpers/api-env";
import {
  startFakeStripe,
  stripeEndpointModule,
  type FakeStripe,
  type FakeStripeRequest,
} from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALPHA_HOST = "alpha.ota.example.com";
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const DESCRIPTOR = "ALPHA TRAVEL";

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;
/** The OTA's own keys (`api_keys` mode) and its webhook signing secret, as PADR-0011 point 5 has the OTA enter them. */
const OTA_SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const OTA_PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;
const OTA_WEBHOOK_SECRET = `whsec_${randomBytes(20).toString("hex")}`;
/** The OTA's Stripe accounts: the one connected through Connect OAuth, and the one of its own keys. */
const CONNECT_ACCOUNT = `acct_${randomBytes(8).toString("hex")}Connect`;
const OWN_ACCOUNT = `acct_${randomBytes(8).toString("hex")}OwnKeys`;

type Mode = "velexis" | "connect_standard" | "api_keys";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let connectionId: string;
let alphaSk: string;

/** Every response body of the file: the OTA's secret key and the Velexis one are in none of them. */
const everyBody: string[] = [];

async function insertAccount(clientId: string, secret: string): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(secret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys,
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: "Velexis test",
      environment: "test",
      base_url: "https://test.travel.api.amadeus.com",
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

async function insertTenant(accountId: string): Promise<string> {
  const id = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: id,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: accountId,
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: "active",
    })
    .execute();
  return id;
}

/** The `velexis` test connection, as the provisioning post-step `create_payment_connection` writes it (PBE-022). */
async function insertPaymentConnection(tenantId: string): Promise<string> {
  const id = newId("ppc");
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id,
      tenant_id: tenantId,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: DESCRIPTOR,
    })
    .execute();
  return id;
}

async function issueKey(tenantId: string): Promise<string> {
  const key = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return key;
}

/** `value` sealed as the platform seals a column of the connection row (ADR-0010: the row's associated data). */
async function sealedFor(
  column: "secret_ciphertext" | "webhook_secret_ciphertext",
  value: string,
  rowId = connectionId,
): Promise<{ readonly ciphertext: Buffer; readonly kekId: string }> {
  const aad =
    column === "secret_ciphertext"
      ? connectionSecretAad(rowId)
      : `platform.payment_provider_connections.webhook_secret_ciphertext:${rowId}`;
  const { ciphertext, kekId } = await encryptValue(Buffer.from(value, "utf8"), { aad, keys });
  return { ciphertext: Buffer.from(ciphertext), kekId };
}

/**
 * Switches alpha's connection row in place to `mode`, as the platform's payments page does (PADR-0011 point 1; the
 * secrets cleared outside `api_keys`), without publishing anything.
 */
async function writeMode(
  mode: Mode,
  secret = OTA_SECRET_KEY,
  secretRowId = connectionId,
  /** The `acct_…` of a `connect_standard` or `api_keys` row; default: the mode's own account of the file. */
  account?: string,
): Promise<void> {
  const own =
    mode === "api_keys"
      ? {
          secret: await sealedFor("secret_ciphertext", secret, secretRowId),
          webhook: await sealedFor("webhook_secret_ciphertext", OTA_WEBHOOK_SECRET),
        }
      : undefined;
  await migrator
    .updateTable("platform.payment_provider_connections")
    .set({
      account_mode: mode,
      account_reference:
        mode === "velexis"
          ? null
          : (account ?? (mode === "connect_standard" ? CONNECT_ACCOUNT : OWN_ACCOUNT)),
      publishable_key: own === undefined ? null : OTA_PUBLISHABLE_KEY,
      secret_ciphertext: own?.secret.ciphertext ?? null,
      webhook_secret_ciphertext: own?.webhook.ciphertext ?? null,
      encryption_key_id: own?.secret.kekId ?? null,
      // The platform keeps the suffix whatever the mode: only `velexis` payments carry it (ADR-0011 (A)).
      statement_descriptor_suffix: DESCRIPTOR,
      version: sql<number>`version + 1`,
      updated_at: new Date(),
    })
    .where("id", "=", connectionId)
    .execute();
}

/** The cached connection row of alpha's test environment (PlatformCache, 60 s). */
const cachedConnection = (): string => `conn:payment:${alphaId}:test`;

/** The platform's `connection` invalidation of alpha, published after its commit (OADR-0009 point 4). */
async function publishConnectionInvalidation(): Promise<void> {
  await redis.client.publish(
    INVALIDATION_CHANNEL,
    JSON.stringify({ v: 1, type: "connection", tenantId: alphaId }),
  );
}

/**
 * Publishes the invalidation and waits until the API's subscriber has handled it, so the next read is the row as
 * written. A marker in the cached row's key (an entry that does not parse, a miss for any reader) is what the
 * subscriber must delete: its absence proves the message was handled, also when the row was not cached.
 */
async function invalidateConnection(): Promise<void> {
  await redis.client.set(cachedConnection(), "invalidation-pending", "EX", 60);
  await publishConnectionInvalidation();
  // Not a bound of the criterion: generous, well under the 60 s the cached row would otherwise live.
  await vi.waitFor(
    async () => {
      expect(await redis.client.exists(cachedConnection())).toBe(0);
    },
    { timeout: 5000, interval: 20 },
  );
}

/** storefront.get of the hosted storefront (the edge), its answer checked against the document. */
async function storefrontPayment(): Promise<Record<string, unknown>> {
  const res = seen(await request(api.server).get("/v1/storefront").set(edgeHeaders(ALPHA_HOST)));
  expect(res.status).toBe(200);
  expectResponseToMatch("getStorefront", res);
  return (res.body as { payment: Record<string, unknown> }).payment;
}

/** Switches to `mode` (on `account`, when given) and invalidates the cached row: storefront.get shows the mode at once. */
async function switchTo(mode: Mode, account?: string): Promise<void> {
  await writeMode(mode, OTA_SECRET_KEY, connectionId, account);
  await invalidateConnection();
  expect((await storefrontPayment())["accountMode"]).toBe(mode);
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const keyHeaders = (): Record<string, string> => ({ "X-Api-Key": alphaSk });
const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);

/** Records the body of an answer for the secret checks, and hands the answer back. */
function seen<T extends { text: string }>(res: T): T {
  everyBody.push(res.text);
  return res;
}

interface PaymentBody {
  readonly id: string;
  readonly status: string;
  readonly clientSecret: string | null;
  readonly providerPublicKey: string | null;
  readonly providerPaymentId: string | null;
}

interface ErrorBody {
  readonly error: { readonly code: string };
}

let searchCount = 0;

/** A guest checkout of alpha with its traveller and contact, from a priced offer of the stub's offer 2. */
async function newCheckout(): Promise<string> {
  searchCount += 1;
  const searched = await request(api.server)
    .post("/v1/flight-searches")
    .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey() })
    .send({
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "ORY",
      departureDate: dateFromToday(60 + searchCount),
      adults: 1,
    });
  expect(searched.status).toBe(201);
  const searchId = (searched.body as { id: string }).id;
  const offerId = await alphaTx(async (trx) => {
    await trx
      .updateTable("flight_offers")
      .set({
        payload: sql`jsonb_set(jsonb_set(jsonb_set(payload,
          '{itineraries,0,segments,0,departure,at}', to_jsonb(${`${FLIGHT_DATE}T07:15:00`}::text)),
          '{itineraries,0,segments,0,arrival,at}', to_jsonb(${`${FLIGHT_DATE}T09:20:00`}::text)),
          '{lastTicketingDate}', to_jsonb(${LAST_TICKETING_DATE}::text))`,
        last_ticketing_date: LAST_TICKETING_DATE,
      })
      .where("search_id", "=", searchId)
      .execute();
    const row = await trx
      .selectFrom("flight_offers")
      .select("id")
      .where("search_id", "=", searchId)
      .where("amadeus_offer_id", "=", "2")
      .executeTakeFirstOrThrow();
    return row.id;
  });
  const priced = await request(api.server)
    .post("/v1/priced-offers")
    .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey() })
    .send({ offerIds: [offerId] });
  expect(priced.status).toBe(201);
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId: (priced.body as { id: string }).id });
  expect(created.status).toBe(201);
  const checkoutId = (created.body as { id: string }).id;
  expect(
    (
      await request(api.server)
        .put(`/v1/checkouts/${checkoutId}/travelers`)
        .set(keyHeaders())
        .send({ travelers: [buildTravelerInput()] })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(api.server)
        .put(`/v1/checkouts/${checkoutId}/contacts`)
        .set(keyHeaders())
        .send({ contacts: [buildContactInput()] })
    ).status,
  ).toBe(200);
  return checkoutId;
}

/** checkout.createPayment of the hosted storefront (the edge, with its CSRF pair). */
const createPayment = (checkoutId: string) =>
  request(api.server)
    .post(`/v1/checkouts/${checkoutId}/payments`)
    .set({ ...edgeWriteHeaders(ALPHA_HOST), "Idempotency-Key": idempotencyKey() })
    .send({ method: "card", termsAccepted: true })
    .then(seen);

const getPayment = (paymentId: string) =>
  request(api.server).get(`/v1/payments/${paymentId}`).set(edgeHeaders(ALPHA_HOST)).then(seen);

const updatePayment = (paymentId: string, body: object) =>
  request(api.server)
    .patch(`/v1/payments/${paymentId}`)
    .set(edgeWriteHeaders(ALPHA_HOST))
    .send(body)
    .then(seen);

/** A new payment of a new checkout in the current mode: its answer (201) and its row's connection columns. */
async function newPayment(): Promise<PaymentBody> {
  const res = await createPayment(await newCheckout());
  expect(res.status).toBe(201);
  expectResponseToMatch("createCheckoutPayment", res);
  return res.body as PaymentBody;
}

/** The connection columns of a payment row: the connection's id and the account recorded with it. */
async function recorded(paymentId: string): Promise<{ connectionId: string | null; metadata: unknown }> {
  const row = await alphaTx((trx) =>
    trx
      .selectFrom("payments")
      .select(["provider_connection_id as connectionId", "metadata"])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow(),
  );
  return { connectionId: row.connectionId, metadata: row.metadata };
}

/** What a request carried to Stripe: its key and its `Stripe-Account` header. */
const credentialsOf = (req: FakeStripeRequest | undefined): [string | undefined, string | undefined] => [
  req?.headers["authorization"],
  req?.headers["stripe-account"],
];

/** The requests the fake received for one PaymentIntent (its reads, updates, captures, cancels). */
const intentRequests = (intentId: string | null): FakeStripeRequest[] =>
  stripe.requests.filter(
    (req) => intentId !== null && req.path.startsWith(`/v1/payment_intents/${intentId}`),
  );

const creates = (): FakeStripeRequest[] =>
  stripe.requests.filter((req) => req.method === "POST" && req.path === "/v1/payment_intents");

// Cloning the template, starting the stub and the fake Stripe API and building the API's module graph take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createCheckoutPayment", [201, 424, 502]],
    ["getPayment", [200]],
    ["updatePayment", [200]],
    ["getStorefront", [200]],
    ["completeCheckout", [201]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys, stripe] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    testKeyProvider(),
    startFakeStripe(),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  alphaId = await insertTenant(await insertAccount(clientId, secret));
  connectionId = await insertPaymentConnection(alphaId);
  alphaSk = await issueKey(alphaId);
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
  });
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  api = await createTestApp({
    database: db,
    redis,
    // One tenant's searches and prices one after the other: buckets the file cannot empty.
    imports: [stripeEndpointModule(stripe.endpoint), journeyAmadeusLimitsModule()],
    env: {
      AMADEUS_BASE_URL_TEST: stub.url,
      STRIPE_SECRET_KEY_TEST: SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
    },
  });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(async () => {
  // Full rate limits (10 payments per minute per IP) and no cached rows from the previous test.
  await redis.client.flushdb();
  stripe.reset();
});

describe("one code path for the three account modes [OF-12 AC1]", () => {
  // What differs per mode, and nothing else (OADR-0010 point 1, api-changes §4).
  const MODES = [
    {
      mode: "velexis",
      key: () => SECRET_KEY,
      stripeAccount: undefined,
      descriptor: DESCRIPTOR,
      storefront: () => ({
        accountMode: "velexis",
        publishableKey: PUBLISHABLE_KEY,
        accountId: null,
        merchantName: "Velexis on behalf of Alpha Travel",
        statementDescriptor: DESCRIPTOR,
      }),
      account: () => ({ accountMode: "velexis", accountReference: null }),
    },
    {
      mode: "connect_standard",
      key: () => SECRET_KEY,
      stripeAccount: CONNECT_ACCOUNT,
      descriptor: undefined,
      storefront: () => ({
        accountMode: "connect_standard",
        publishableKey: PUBLISHABLE_KEY,
        accountId: CONNECT_ACCOUNT,
        merchantName: "Alpha Travel",
        statementDescriptor: null,
      }),
      account: () => ({ accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT }),
    },
    {
      mode: "api_keys",
      key: () => OTA_SECRET_KEY,
      stripeAccount: undefined,
      descriptor: undefined,
      storefront: () => ({
        accountMode: "api_keys",
        publishableKey: OTA_PUBLISHABLE_KEY,
        accountId: null,
        merchantName: "Alpha Travel",
        statementDescriptor: null,
      }),
      account: () => ({ accountMode: "api_keys", accountReference: OWN_ACCOUNT }),
    },
  ] as const;

  it.each(MODES)(
    "[OBE-077 AC1] $mode: storefront.get, checkout.createPayment, getPayment and updatePayment use the mode's key, Stripe-Account and publishable key",
    async ({ mode, key, stripeAccount, descriptor, storefront, account }) => {
      await switchTo(mode);

      // The storefront initialises Stripe.js with what the mode needs, and names the merchant.
      expect(await storefrontPayment()).toMatchObject({
        provider: "stripe",
        environment: "test",
        supportedMethods: ["card"],
        ...storefront(),
      });

      stripe.reset();
      const payment = await newPayment();
      expect(payment).toMatchObject({
        status: "requires_payment_method",
        providerPublicKey: storefront().publishableKey,
      });
      expect(payment.clientSecret).toMatch(/_secret_/);
      const [created] = creates();
      expect(credentialsOf(created)).toEqual([`Bearer ${key()}`, stripeAccount]);
      expect(created?.form).toMatchObject({
        capture_method: "manual",
        metadata: { velexis_tenant_id: alphaId, velexis_environment: "test", payment_id: payment.id },
      });
      expect(created?.form["statement_descriptor_suffix"]).toBe(descriptor);
      // The row records the connection and the account the payment was created on (PADR-0011 point 7).
      expect(await recorded(payment.id)).toEqual({ connectionId, metadata: { connection: account() } });

      // Every later call for the payment is made on the same account.
      stripe.reset();
      const read = await getPayment(payment.id);
      expect(read.status).toBe(200);
      expectResponseToMatch("getPayment", read);
      expect((read.body as PaymentBody).providerPublicKey).toBe(storefront().publishableKey);
      const updated = await updatePayment(payment.id, { card: { brand: "MASTERCARD", bin: "555555" } });
      expect(updated.status).toBe(200);
      expectResponseToMatch("updatePayment", updated);
      expect(intentRequests(payment.providerPaymentId).map((req) => `${req.method} ${req.path}`)).toEqual([
        `GET /v1/payment_intents/${payment.providerPaymentId}`,
        `POST /v1/payment_intents/${payment.providerPaymentId}`,
      ]);
      for (const req of stripe.requests) {
        expect(credentialsOf(req)).toEqual([`Bearer ${key()}`, stripeAccount]);
      }
    },
  );
});

describe("existing payments keep the account they were created on (OBE-077 step 3, PADR-0011 point 7)", () => {
  it("reads and updates a Connect payment on its connected account after the OTA went back to velexis, and puts new payments on the Velexis account", async () => {
    await switchTo("connect_standard");
    const connected = await newPayment();
    await switchTo("velexis");
    stripe.reset();

    const read = await getPayment(connected.id);
    const updated = await updatePayment(connected.id, { card: { brand: "MASTERCARD" } });
    const fresh = await newPayment();

    expect([read.status, updated.status]).toEqual([200, 200]);
    expect(intentRequests(connected.providerPaymentId).map(credentialsOf)).toEqual([
      [`Bearer ${SECRET_KEY}`, CONNECT_ACCOUNT],
      [`Bearer ${SECRET_KEY}`, CONNECT_ACCOUNT],
    ]);
    // The current account is not the payment's: its publishable key would not confirm this PaymentIntent.
    expect((read.body as PaymentBody).providerPublicKey).toBeNull();
    expect(credentialsOf(creates()[0])).toEqual([`Bearer ${SECRET_KEY}`, undefined]);
    expect([await recorded(connected.id), await recorded(fresh.id)]).toEqual([
      {
        connectionId,
        metadata: { connection: { accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT } },
      },
      { connectionId, metadata: { connection: { accountMode: "velexis", accountReference: null } } },
    ]);
  });

  it("completes a checkout paid on the connected account after the OTA went back to velexis: the read and the capture go to that account", async () => {
    await switchTo("connect_standard");
    const checkoutId = await newCheckout();
    const created = await createPayment(checkoutId);
    expect(created.status).toBe(201);
    const payment = created.body as PaymentBody & { readonly amount: { readonly amount: string } };
    // Stripe.js confirmed it in the browser: the authorisation waits for its capture.
    stripe.update(
      payment.providerPaymentId ?? "",
      buildStripeConfirmation(Math.round(Number(payment.amount.amount) * 100)),
    );
    await switchTo("velexis");
    stripe.reset();

    const completed = seen(
      await request(api.server)
        .post(`/v1/checkouts/${checkoutId}/complete`)
        .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey() })
        .send({}),
    );

    expect(completed.status).toBe(201);
    expectResponseToMatch("completeCheckout", completed);
    // checkout.complete (BookingOrchestrator) reads the PaymentIntent and captures it where it lives, with the Velexis
    // key and the connected account, although the connection names the Velexis account now.
    const calls = intentRequests(payment.providerPaymentId);
    expect(calls.map((req) => `${req.method} ${req.path}`)).toContain(
      `POST /v1/payment_intents/${payment.providerPaymentId}/capture`,
    );
    expect(stripe.requests.map(credentialsOf)).toEqual(
      stripe.requests.map(() => [`Bearer ${SECRET_KEY}`, CONNECT_ACCOUNT]),
    );
    expect(calls).toHaveLength(stripe.requests.length);
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.status).toBe("succeeded");
  });

  it("serves an api_keys payment with its account's key, and never with another account's once the OTA left it", async () => {
    const velexis = await newPayment();
    await switchTo("api_keys");
    const own = await newPayment();
    stripe.reset();

    // A velexis payment stays on the Velexis account; the api_keys one is read with the OTA's key.
    expect((await getPayment(velexis.id)).status).toBe(200);
    expect((await getPayment(own.id)).status).toBe(200);
    expect([
      intentRequests(velexis.providerPaymentId).map(credentialsOf),
      intentRequests(own.providerPaymentId).map(credentialsOf),
    ]).toEqual([[[`Bearer ${SECRET_KEY}`, undefined]], [[`Bearer ${OTA_SECRET_KEY}`, undefined]]]);

    // Back to Velexis: the platform cleared the OTA's key, so its payment is not sent to any other account. The read
    // answers the stored state, as during a Stripe outage.
    await switchTo("velexis");
    stripe.reset();
    const stored = await getPayment(own.id);

    expect(stored.status).toBe(200);
    expectResponseToMatch("getPayment", stored);
    expect(stored.body).toMatchObject({
      id: own.id,
      status: "requires_payment_method",
      providerPublicKey: null,
    });
    expect(stripe.requests).toEqual([]);
  });
});

// Both directions of a switch on one and the same `acct_…` (lead decisions (2i) of 2026-10-30 and (2l) of 2026-10-31):
// the account is what the gateway compares, not the mode (stripe.gateway.ts `paymentTargetOf`).
describe("a payment of an account the OTA moved to the other mode (FIX-W36-OTA, FIX-W37-OTA)", () => {
  /** Completes a checkout whose payment Stripe.js confirmed: checkout.complete reads and captures the payment. */
  async function completeConfirmed(
    checkoutId: string,
    payment: PaymentBody & { amount: { amount: string } },
  ) {
    stripe.update(
      payment.providerPaymentId ?? "",
      buildStripeConfirmation(Math.round(Number(payment.amount.amount) * 100)),
    );
    return seen(
      await request(api.server)
        .post(`/v1/checkouts/${checkoutId}/complete`)
        .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey() })
        .send({}),
    );
  }

  it("[FIX-W37-OTA AC7] reads, updates and captures a Connect payment with the OTA's own key once it moved that account to api_keys", async () => {
    await switchTo("connect_standard");
    const checkoutId = await newCheckout();
    const created = await createPayment(checkoutId);
    expect(created.status).toBe(201);
    const payment = created.body as PaymentBody & { readonly amount: { readonly amount: string } };
    // The OTA now gives Velexis its own keys of that very account (the platform keeps the row's id).
    await switchTo("api_keys", CONNECT_ACCOUNT);
    stripe.reset();

    const read = await getPayment(payment.id);
    const updated = await updatePayment(payment.id, { card: { brand: "MASTERCARD" } });
    // The card's brand may change the amount (a card fee): Stripe.js confirms the updated PaymentIntent.
    const completed = await completeConfirmed(checkoutId, updated.body as typeof payment);

    expect([read.status, updated.status, completed.status]).toEqual([200, 200, 201]);
    expectResponseToMatch("completeCheckout", completed);
    const calls = intentRequests(payment.providerPaymentId);
    expect(calls.map((req) => `${req.method} ${req.path}`)).toContain(
      `POST /v1/payment_intents/${payment.providerPaymentId}/capture`,
    );
    // Every call with the OTA's key, on the account it belongs to (no Stripe-Account header: the key is the account's).
    expect(stripe.requests.map(credentialsOf)).toEqual(
      stripe.requests.map(() => [`Bearer ${OTA_SECRET_KEY}`, undefined]),
    );
    expect(calls).toHaveLength(stripe.requests.length);
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.status).toBe("succeeded");
    expect(await recorded(payment.id)).toEqual({
      connectionId,
      metadata: { connection: { accountMode: "connect_standard", accountReference: CONNECT_ACCOUNT } },
    });
  });

  it("[FIX-W37-OTA AC7] reads and captures an api_keys payment through the Connect path once the OTA connected that account (lead decision (2i))", async () => {
    await switchTo("api_keys", OWN_ACCOUNT);
    const checkoutId = await newCheckout();
    const created = await createPayment(checkoutId);
    expect(created.status).toBe(201);
    const payment = created.body as PaymentBody & { readonly amount: { readonly amount: string } };
    await switchTo("connect_standard", OWN_ACCOUNT);
    stripe.reset();

    const read = await getPayment(payment.id);
    const completed = await completeConfirmed(checkoutId, payment);

    expect([read.status, completed.status]).toEqual([200, 201]);
    expect(intentRequests(payment.providerPaymentId).map((req) => `${req.method} ${req.path}`)).toContain(
      `POST /v1/payment_intents/${payment.providerPaymentId}/capture`,
    );
    expect(stripe.requests.map(credentialsOf)).toEqual(
      stripe.requests.map(() => [`Bearer ${SECRET_KEY}`, OWN_ACCOUNT]),
    );
    expect(stripe.intents.get(payment.providerPaymentId ?? "")?.status).toBe("succeeded");
  });
});

describe("a connection change (OBE-077 step 3)", () => {
  it("reaches new payments at once after the platform's invalidation, and within the cache's 60 s without one", async () => {
    await switchTo("velexis");
    await storefrontPayment();
    // Lost invalidations are covered by the TTL of the cached row (`conn:payment:`, 60 s).
    const ttl = await redis.client.ttl(`conn:payment:${alphaId}:test`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // Written but not published: the cached row still serves for now.
    await writeMode("connect_standard");
    expect((await storefrontPayment())["accountMode"]).toBe("velexis");
    stripe.reset();
    await newPayment();
    expect(credentialsOf(creates()[0])).toEqual([`Bearer ${SECRET_KEY}`, undefined]);

    // Published: the subscriber drops the cached row, and the next read is the connected account.
    await invalidateConnection();
    expect(await storefrontPayment()).toMatchObject({
      accountMode: "connect_standard",
      accountId: CONNECT_ACCOUNT,
    });
    stripe.reset();
    await newPayment();
    expect(credentialsOf(creates()[0])).toEqual([`Bearer ${SECRET_KEY}`, CONNECT_ACCOUNT]);
  });

  it("serves a rolled key of the same account from the invalidation on", async () => {
    await switchTo("api_keys");
    const own = await newPayment();
    const rolled = `sk_test_${randomBytes(20).toString("hex")}`;
    await writeMode("api_keys", rolled);
    await invalidateConnection();
    stripe.reset();

    expect((await getPayment(own.id)).status).toBe(200);
    expect(intentRequests(own.providerPaymentId).map(credentialsOf)).toEqual([
      [`Bearer ${rolled}`, undefined],
    ]);
    expect(api.sink.text()).not.toContain(rolled);
  });
});

describe("the OTA's decrypted key (OBE-077 AC2)", () => {
  it("[OBE-077 AC2] answers 424 for a key that does not decrypt, naming the connection only, and 502 when Stripe fails", async () => {
    // The ciphertext of another row: its associated data does not match this connection.
    await writeMode("api_keys", OTA_SECRET_KEY, "ppc_01JA4CE5H8K1M4P7R0T3V6Y9ZZ");
    await invalidateConnection();
    const checkout = await newCheckout();
    stripe.reset();

    const refused = await createPayment(checkout);

    expect([refused.status, (refused.body as ErrorBody).error.code]).toEqual([
      424,
      "PAYMENT_PROVIDER_NOT_CONFIGURED",
    ]);
    expectResponseToMatch("createCheckoutPayment", refused);
    expect(stripe.requests).toEqual([]);
    const unavailable = api.sink
      .records()
      .filter((line) => line["msg"] === "payments.stripe_account_unavailable");
    expect(unavailable.at(-1)).toMatchObject({
      tenantId: alphaId,
      accountMode: "api_keys",
      connectionId,
      reason: "connection_secret_unreadable",
    });

    // The OTA's key again: a Stripe failure is 502, with Stripe's error type and no key.
    await switchTo("api_keys");
    stripe.reset();
    stripe.fail(2, "server_error");
    const failed = await createPayment(checkout);

    expect([failed.status, (failed.body as ErrorBody).error.code]).toEqual([502, "PAYMENT_PROVIDER_ERROR"]);
    expectResponseToMatch("createCheckoutPayment", failed);
    expect(stripe.requests.map(credentialsOf)).toEqual([
      [`Bearer ${OTA_SECRET_KEY}`, undefined],
      [`Bearer ${OTA_SECRET_KEY}`, undefined],
    ]);
    expect(
      api.sink
        .records()
        .filter((line) => line["msg"] === "payments.stripe_call_failed")
        .at(-1),
    ).toMatchObject({
      accountMode: "api_keys",
      stripeErrorType: "StripeAPIError",
      statusCode: 500,
    });
  });

  it("[OBE-077 AC2] never appears in a log line or an answer of the file; only Stripe received it", async () => {
    // Stripe did get the keys it needed (the positive control of the checks below): storefront.get, a payment, its read
    // and its update in api_keys mode, so the checks hold something also when this test runs alone…
    const before = everyBody.length;
    await switchTo("api_keys");
    stripe.reset();
    const payment = await newPayment();
    expect((await getPayment(payment.id)).status).toBe(200);
    expect((await updatePayment(payment.id, { card: { brand: "MASTERCARD", bin: "555555" } })).status).toBe(
      200,
    );
    expect(stripe.requests.map(credentialsOf)).toEqual(
      stripe.requests.map(() => [`Bearer ${OTA_SECRET_KEY}`, undefined]),
    );
    expect(creates()).toHaveLength(1);
    expect(everyBody.length - before).toBeGreaterThanOrEqual(4);

    // …and no log line and no answer of this file holds a secret key, the OTA's or Velexis's.
    const logs = api.sink.text();
    for (const secret of [OTA_SECRET_KEY, OTA_WEBHOOK_SECRET, SECRET_KEY]) {
      expect(logs).not.toContain(secret);
      expect(everyBody.filter((body) => body.includes(secret))).toEqual([]);
    }
    expect(everyBody.filter((body) => /\b(?:sk|rk)_(?:test|live)_/.test(body))).toEqual([]);
  });
});
