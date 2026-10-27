// checkout.create, checkout.get, checkout.setTravelers, checkout.setContacts and checkout.setRemarks against PostgreSQL
// 16, Redis 7 and the Amadeus stub (OBE-036; ota/docs/flows/checkout-stripe.md §1 and §2 steps 1–2,
// ota/docs/data-model.md §4). The file clones the @velexis/testing template (tenant_alpha and tenant_beta
// provisioned), writes the platform rows of two tenants on the Velexis test Amadeus account as the platform does,
// seeds their storefront settings and default markup rule as provisioning does, and calls the API in-process with
// secret keys, a console:automation key, customer tokens (bearer and cookie) and the hosted storefront's edge headers.
//
// Every checkout opens from a priced offer made by the API itself: a search (the stub's Madrid–Paris Orly fixture,
// whose offer 2 is IB3436 for one adult; Spain and France, so passports and identity cards are accepted) and
// flights.price of offer 2. Before pricing, the stored offer's flight is moved to a day 60 days from today and its last
// ticketing day to 30 days from today: the fixture's own dates would pass, and with them every date check. Every
// answer is checked against the OTA document (`expectResponseToMatch`).
import { randomBytes } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import {
  aadFor,
  decryptValue,
  DecryptionError,
  encryptValue,
  hashApiKey,
  type KeyProvider,
} from "@velexis/crypto";
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
import { CheckoutRepository } from "../../../src/checkout/checkout.repository";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import type { ApiConfig } from "../../../src/config";
import { TokenService } from "../../../src/identity/token.service";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import {
  buildContactInput,
  buildPassport,
  buildRemarkInput,
  buildTravelerInput,
  dateFromToday,
  newDocumentNumber,
  newResidentCardNumber,
} from "../../builders/checkouts";
import {
  edgeHeaders,
  edgeWriteHeaders,
  newApiKey,
  testApiCredentials,
  testKeyProvider,
} from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const ALPHA_HOST = "alpha.ota.example.com";
/** The origin alpha's publishable key allows (a browser client of the OTA's own site). */
const ALPHA_ORIGIN = "https://shop.alpha-travel.example";
/** The day of the priced flight (the stored offer is moved there) and its last ticketing day. */
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const CONSOLE = Object.freeze({ "X-Velexis-Scope": "console" });

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let accountId: string;
let alphaId: string;
let alphaSk: string;
let alphaPk: string;
let alphaConsole: string;
let betaSk: string;
let tokens: TokenService;

/** Inserts the Velexis test Amadeus account with `secret` encrypted as the platform encrypts it. */
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

/** Inserts a tenant of a provisioned test schema and its connection on the shared account. */
async function insertTenant(key: "alpha" | "beta"): Promise<string> {
  const id = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
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

/** Issues a test key of a tenant as the platform does: secret (with `scopes`), or publishable for ALPHA_ORIGIN. */
async function issueKey(
  tenantId: string,
  scopes: readonly string[] = [],
  kind: "sk" | "pk" = "sk",
): Promise<string> {
  const key = newApiKey(kind);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: kind === "pk" ? "Storefront (test)" : "Server (test)",
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      ...(scopes.length === 0 ? {} : { scopes: [...scopes] }),
      ...(kind === "pk" ? { allowed_origins: [ALPHA_ORIGIN] } : {}),
    })
    .execute();
  return key;
}

async function seedTenant(schema: "tenant_alpha" | "tenant_beta", name: string): Promise<void> {
  await tenantTx(tenantDb, schema, async (trx) => {
    await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
  });
}

/** Changes alpha's storefront settings for the length of `run`, then restores them. */
async function withAlphaSettings(
  settings: { guest_checkout_enabled?: boolean; require_email_verification?: boolean },
  run: () => Promise<void>,
): Promise<void> {
  const change = (values: typeof settings) =>
    tenantTx(tenantDb, "tenant_alpha", (trx) => trx.updateTable("storefront_settings").set(values).execute());
  await change(settings);
  try {
    await run();
  } finally {
    await change({ guest_checkout_enabled: true, require_email_verification: false });
  }
}

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const keyHeaders = (key: string, extra: Readonly<Record<string, string>> = {}) => ({
  "X-Api-Key": key,
  ...extra,
});

/** A signed-in customer of alpha: the row and a valid access token (bearer for keys, cookie for the edge). */
async function newCustomer(options: { verified?: boolean } = {}): Promise<{
  id: string;
  email: string;
  token: string;
}> {
  const id = newId("cus");
  const email = `${id.toLowerCase()}@example.com`;
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx
      .insertInto("customers")
      .values({
        id,
        email,
        email_verified_at: options.verified === false ? null : new Date(),
        first_name: "TESTA",
        last_name: "CUSTOMER",
        phone_country_code: "46",
        phone_number: "701234567",
      })
      .execute(),
  );
  const token = await tokens.signCustomerToken({ sub: id, tid: alphaId, sid: newId("ses") });
  return { id, email, token: token.token };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The edge headers of a state-changing request, with the customer's access cookie when given. */
function edgeWrite(accessToken?: string): Record<string, string> {
  const headers = { ...edgeWriteHeaders(ALPHA_HOST) };
  if (accessToken !== undefined) {
    headers.Cookie = `${headers.Cookie}; __Host-vx_at=${accessToken}`;
  }
  return headers;
}

function edgeRead(accessToken?: string): Record<string, string> {
  return {
    ...edgeHeaders(ALPHA_HOST),
    ...(accessToken === undefined ? {} : { Cookie: `__Host-vx_at=${accessToken}` }),
  };
}

let searchCount = 0;

/**
 * A new priced offer of alpha for offer 2 of a new search, made with `headers` (a key's, a customer's, the edge's):
 * the stored offer's flight is moved to FLIGHT_DATE before pricing. Answers the priced offer's id and total.
 */
async function newPricedOffer(
  headers: () => Record<string, string>,
): Promise<{ id: string; total: { amount: string; currency: string } }> {
  searchCount += 1;
  const searched = await request(api.server)
    .post("/v1/flight-searches")
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "ORY",
      departureDate: dateFromToday(60 + searchCount),
      adults: 1,
    });
  expect(searched.status).toBe(201);
  const searchId = (searched.body as { id: string }).id;
  const offerId = await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
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
    .set({ ...headers(), "Idempotency-Key": idempotencyKey() })
    .send({ offerIds: [offerId] });
  expect(priced.status).toBe(201);
  const body = priced.body as { id: string; price: { total: { amount: string; currency: string } } };
  return { id: body.id, total: body.price.total };
}

interface CheckoutBody {
  readonly id: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly isGuest: boolean;
  readonly channel: string;
  readonly pricedOfferId: string;
  readonly basePricedOfferId: string;
  readonly currency: string;
  readonly totals: {
    readonly offer: { amount: string; currency: string };
    readonly ancillaries: { amount: string; currency: string };
    readonly cardFee: { amount: string; currency: string } | null;
    readonly total: { amount: string; currency: string };
  };
  readonly requirements: {
    readonly contact: Record<string, unknown>;
    readonly travelers: Array<{
      travelerId: string;
      travelerType: string;
      requiredFields: string[];
      documentTypes: string[];
      dateOfBirthMax: string | null;
    }>;
  };
  readonly progress: {
    travelersComplete: boolean;
    contactsComplete: boolean;
    paymentReady: boolean;
    readyToComplete: boolean;
    missing: Array<{ path: string; code: string }>;
  };
  readonly travelers: Array<{
    id: string;
    travelerId: string;
    complete: boolean;
    missingFields: string[];
    name: Record<string, string> | null;
    documents: Array<Record<string, unknown>>;
    discountEligibility: Array<Record<string, unknown>>;
    saveToAccount?: boolean;
  }>;
  readonly contacts: Array<{
    id: string;
    isPrimary: boolean;
    emailAddress: string | null;
    phones: unknown[];
  }>;
  readonly remarks: Array<{
    text: string;
    travelerIds: string[];
    kind: string;
    subType: string;
    source: string;
  }>;
  readonly itineraries: Array<{ departureAt: string }>;
  readonly ticketing: Record<string, unknown>;
  readonly locale: string | null;
  readonly metadata: Record<string, string>;
  readonly version: number;
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly fieldErrors?: Array<{ path: string; code: string; message?: string }>;
  };
}

const create = (headers: Record<string, string>, body: object, key: string = idempotencyKey()) =>
  request(api.server)
    .post("/v1/checkouts")
    .set({ ...headers, "Idempotency-Key": key })
    .send(body);

const get = (headers: Record<string, string>, id: string) =>
  request(api.server).get(`/v1/checkouts/${id}`).set(headers);

const put = (headers: Record<string, string>, id: string, part: string, body: object) =>
  request(api.server).put(`/v1/checkouts/${id}/${part}`).set(headers).send(body);

/** A checkout of alpha opened with a secret key (a guest checkout), and the priced offer it was opened from. */
async function keyCheckout(): Promise<{ body: CheckoutBody; pricedOffer: { id: string } }> {
  const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk));
  const res = await create(keyHeaders(alphaSk), { pricedOfferId: pricedOffer.id });
  expect(res.status).toBe(201);
  return { body: res.body as CheckoutBody, pricedOffer };
}

/** The checkout's rows of `table` in alpha. */
async function travelerRows(checkoutId: string) {
  return await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx.selectFrom("checkout_travelers").selectAll().where("checkout_id", "=", checkoutId).execute(),
  );
}

// Cloning the template, starting the stub and building the API's module graph (Nest, pools, Redis, the OTA document's
// validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its
// own timeout, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations (the Checkout schema is large) compile on their first check: here,
  // with every status the tests below check, instead of inside a test's time bound.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createFlightSearch", [201]],
    ["priceFlightOffers", [201]],
    ["createCheckout", [201, 401, 403, 404, 409, 410]],
    ["getCheckout", [200, 404]],
    ["setCheckoutTravelers", [200, 400, 404, 409, 410, 412, 422]],
    ["setCheckoutContacts", [200, 404, 410, 412, 422]],
    ["setCheckoutRemarks", [200, 400, 404, 410]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  accountId = await insertAccount(clientId, secret);
  alphaId = await insertTenant("alpha");
  const betaId = await insertTenant("beta");
  alphaSk = await issueKey(alphaId);
  alphaPk = await issueKey(alphaId, [], "pk");
  alphaConsole = await issueKey(alphaId, ["console:automation", "queues:read"]);
  betaSk = await issueKey(betaId);
  await seedTenant("tenant_alpha", "Alpha Travel");
  await seedTenant("tenant_beta", "Beta Trips");
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
  );
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(async () => {
  // Full Amadeus buckets, rate limits and no single-flight keys from the previous test.
  await redis.client.flushdb();
});

describe("a checkout filled step by step", () => {
  it("opens a guest checkout on the hosted storefront and fills travellers, contacts and requests [OBE-036 AC1]", async () => {
    const pricedOffer = await newPricedOffer(() => edgeWrite());

    const created = await create(edgeWrite(), {
      pricedOfferId: pricedOffer.id,
      metadata: { campaign: "autumn" },
    });

    expect(created.status).toBe(201);
    expectResponseToMatch("createCheckout", created);
    const opened = created.body as CheckoutBody;
    expect(opened.id).toMatch(/^chk_/);
    expect(created.headers["location"]).toBe(`/v1/checkouts/${opened.id}`);
    expect(created.headers["etag"]).toBe('"1"');
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(opened).toMatchObject({
      status: "open",
      customerId: null,
      isGuest: true,
      channel: "storefront",
      pricedOfferId: pricedOffer.id,
      basePricedOfferId: pricedOffer.id,
      currency: "EUR",
      totals: {
        offer: pricedOffer.total,
        ancillaries: { amount: "0.00", currency: "EUR" },
        cardFee: null,
        total: pricedOffer.total,
      },
      locale: "en",
      metadata: { campaign: "autumn" },
      version: 1,
      contacts: [],
      remarks: [],
      payment: null,
      bookingId: null,
      ticketing: { policy: "issue_after_payment", paymentTiming: "authorize_before_booking" },
    });
    expect(new Date(opened.expiresAt).getTime() - new Date(opened.createdAt).getTime()).toBe(30 * 60_000);
    expect(opened.itineraries.map((itinerary) => itinerary.departureAt)).toEqual([`${FLIGHT_DATE}T07:15:00`]);
    // The stub's booking requirements: e-mail and mobile phone, the adult's gender and date of birth.
    expect(opened.requirements.contact).toMatchObject({ emailRequired: true, mobilePhoneRequired: true });
    expect(opened.requirements.travelers).toEqual([
      expect.objectContaining({
        travelerId: "1",
        travelerType: "ADULT",
        requiredFields: ["name", "dateOfBirth", "gender"],
        documentTypes: ["PASSPORT", "IDENTITY_CARD"],
      }),
    ]);
    expect(opened.travelers).toEqual([
      expect.objectContaining({
        travelerId: "1",
        complete: false,
        missingFields: ["name", "dateOfBirth", "gender"],
      }),
    ]);
    expect(opened.progress).toMatchObject({
      travelersComplete: false,
      contactsComplete: false,
      readyToComplete: false,
    });
    expect(opened.progress.missing.map((entry) => [entry.path, entry.code])).toEqual([
      ["/travelers/0/name", "REQUIRED"],
      ["/travelers/0/dateOfBirth", "REQUIRED"],
      ["/travelers/0/gender", "REQUIRED"],
      ["/contacts", "PRIMARY_CONTACT_REQUIRED"],
    ]);

    const read = await get(edgeRead(), opened.id);
    expect(read.status).toBe(200);
    expectResponseToMatch("getCheckout", read);
    expect(read.headers["etag"]).toBe('"1"');
    expect(read.body).toEqual(opened);

    const passport = buildPassport();
    const travelers = await put({ ...edgeWrite(), "If-Match": '"1"' }, opened.id, "travelers", {
      travelers: [buildTravelerInput({ documents: [passport] })],
    });
    expect(travelers.status).toBe(200);
    expectResponseToMatch("setCheckoutTravelers", travelers);
    expect(travelers.headers["etag"]).toBe('"2"');
    const withTravelers = travelers.body as CheckoutBody;
    expect(withTravelers.version).toBe(2);
    expect(withTravelers.progress.travelersComplete).toBe(true);
    expect(withTravelers.travelers[0]).toMatchObject({ complete: true, missingFields: [] });
    expect(withTravelers.travelers[0]?.documents).toEqual([
      {
        documentType: "PASSPORT",
        numberMasked: `•••••${(passport.number ?? "").slice(-4)}`,
        expiryDate: passport.expiryDate,
        issuanceCountry: "SE",
        nationality: "SE",
        holder: true,
      },
    ]);

    const contacts = await put({ ...edgeWrite(), "If-Match": '"2"' }, opened.id, "contacts", {
      contacts: [buildContactInput()],
    });
    expect(contacts.status).toBe(200);
    expectResponseToMatch("setCheckoutContacts", contacts);
    const withContacts = contacts.body as CheckoutBody;
    expect(withContacts.version).toBe(3);
    expect(withContacts.contacts).toEqual([expect.objectContaining({ isPrimary: true })]);
    expect(withContacts.progress).toMatchObject({
      travelersComplete: true,
      contactsComplete: true,
      missing: [],
    });

    const remarks = await put(edgeWrite(), opened.id, "remarks", { remarks: [buildRemarkInput()] });
    expect(remarks.status).toBe(200);
    expectResponseToMatch("setCheckoutRemarks", remarks);
    const withRemarks = remarks.body as CheckoutBody;
    expect(withRemarks.version).toBe(4);
    expect(withRemarks.remarks).toEqual([
      expect.objectContaining({
        kind: "general",
        subType: "GENERAL_MISCELLANEOUS",
        travelerIds: ["1"],
        source: "customer",
      }),
    ]);

    const final = await get(edgeRead(), opened.id);
    expect(final.status).toBe(200);
    expectResponseToMatch("getCheckout", final);
    expect(final.body).toMatchObject({
      version: 4,
      progress: {
        travelersComplete: true,
        contactsComplete: true,
        paymentReady: false,
        readyToComplete: false,
      },
    });
    // No payment yet (OBE-038): the checkout is still open.
    expect((final.body as CheckoutBody).status).toBe("open");
  });

  it("fills a signed-in customer's checkout with a secret key and the customer's token [OBE-036 AC1]", async () => {
    const customer = await newCustomer();
    const headers = keyHeaders(alphaSk, bearer(customer.token));
    const pricedOffer = await newPricedOffer(() => headers);

    const created = await create(headers, { pricedOfferId: pricedOffer.id, locale: "sv-SE" });

    expect(created.status).toBe(201);
    expectResponseToMatch("createCheckout", created);
    const opened = created.body as CheckoutBody;
    expect(opened).toMatchObject({ customerId: customer.id, isGuest: false, locale: "sv-SE" });
    // The primary contact from the profile; its phone has no device type, so the mobile phone is still missing.
    expect(opened.contacts).toEqual([
      expect.objectContaining({
        isPrimary: true,
        emailAddress: customer.email,
        phones: [{ countryCallingCode: "46", number: "701234567" }],
      }),
    ]);
    expect(opened.progress.missing).toContainEqual(
      expect.objectContaining({ path: "/contacts/0/phones", code: "MOBILE_PHONE_REQUIRED" }),
    );

    const travelers = await put(headers, opened.id, "travelers", {
      travelers: [buildTravelerInput({ saveToAccount: true })],
    });
    expect(travelers.status).toBe(200);
    expectResponseToMatch("setCheckoutTravelers", travelers);
    expect((travelers.body as CheckoutBody).travelers[0]).toMatchObject({
      complete: true,
      saveToAccount: true,
    });
    const contacts = await put(headers, opened.id, "contacts", {
      contacts: [
        buildContactInput({ emailAddress: customer.email }),
        {
          purpose: "INVOICE",
          companyName: "TEST AB",
          address: { lines: ["Main street 1"], countryCode: "SE" },
        },
      ],
    });
    expect(contacts.status).toBe(200);
    expectResponseToMatch("setCheckoutContacts", contacts);
    expect((contacts.body as CheckoutBody).contacts.map((contact) => contact.isPrimary)).toEqual([
      true,
      false,
    ]);
    const remarks = await put(headers, opened.id, "remarks", { remarks: [] });
    expect(remarks.status).toBe(200);
    expectResponseToMatch("setCheckoutRemarks", remarks);
    expect(remarks.body).toMatchObject({
      version: 4,
      remarks: [],
      progress: { travelersComplete: true, contactsComplete: true },
    });

    // The OTA's server (a secret key without a customer token) reads it; another customer does not.
    const server = await get(keyHeaders(alphaSk), opened.id);
    expect(server.status).toBe(200);
    expectResponseToMatch("getCheckout", server);
    const other = await newCustomer();
    const foreign = await get(keyHeaders(alphaSk, bearer(other.token)), opened.id);
    expect(foreign.status).toBe(404);
    expectResponseToMatch("getCheckout", foreign);
    // Nor can another customer, or a guest, open a checkout from this customer's priced offer.
    const otherOpens = await create(keyHeaders(alphaSk, bearer(other.token)), {
      pricedOfferId: pricedOffer.id,
    });
    expect(otherOpens.status).toBe(404);
    expectResponseToMatch("createCheckout", otherOpens);
    const guestOpens = await create(keyHeaders(alphaSk), { pricedOfferId: pricedOffer.id });
    expect(guestOpens.status).toBe(404);
  });

  it("serves a customer on the storefront with the session cookie, and abandons the customer's older checkout", async () => {
    const customer = await newCustomer();
    const pricedOffer = await newPricedOffer(() => edgeWrite(customer.token));
    const first = await create(edgeWrite(customer.token), { pricedOfferId: pricedOffer.id });
    expect(first.status).toBe(201);
    const firstId = (first.body as CheckoutBody).id;
    expect(first.body).toMatchObject({ customerId: customer.id, isGuest: false });

    const second = await create(edgeWrite(customer.token), {
      pricedOfferId: pricedOffer.id,
      prefillContactFromAccount: false,
    });
    expect(second.status).toBe(201);
    expectResponseToMatch("createCheckout", second);
    expect(second.body).toMatchObject({ customerId: customer.id, contacts: [] });

    const abandoned = await get(edgeRead(customer.token), firstId);
    expect(abandoned.status).toBe(200);
    expect(abandoned.body).toMatchObject({ status: "abandoned", version: 2 });
    const change = await put(edgeWrite(customer.token), firstId, "remarks", { remarks: [] });
    expect(change.status).toBe(410);
    expectResponseToMatch("setCheckoutRemarks", change);
    expect((change.body as ErrorBody).error.code).toBe("CHECKOUT_EXPIRED");
    // A guest on the storefront cannot read the customer's checkout.
    const guest = await get(edgeRead(), (second.body as CheckoutBody).id);
    expect(guest.status).toBe(404);
  });

  it("replays checkout.create for the same Idempotency-Key", async () => {
    const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk));
    const key = idempotencyKey();

    const first = await create(keyHeaders(alphaSk), { pricedOfferId: pricedOffer.id }, key);
    const again = await create(keyHeaders(alphaSk), { pricedOfferId: pricedOffer.id }, key);

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers["location"]).toBe(first.headers["location"]);
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("checkouts").select("id").where("base_priced_offer_id", "=", pricedOffer.id).execute(),
    );
    expect(rows).toHaveLength(1);
  });

  it("opens a console checkout in console scope", async () => {
    const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk));

    const res = await create(keyHeaders(alphaConsole, CONSOLE), { pricedOfferId: pricedOffer.id });

    expect(res.status).toBe(201);
    expectResponseToMatch("createCheckout", res);
    expect(res.body).toMatchObject({ channel: "console", isGuest: true, customerId: null });
    const remarks = await put(keyHeaders(alphaConsole, CONSOLE), (res.body as CheckoutBody).id, "remarks", {
      remarks: [buildRemarkInput()],
    });
    expect(remarks.status).toBe(200);
    expect((remarks.body as CheckoutBody).remarks[0]?.source).toBe("staff");
  });
});

describe("travellers' documents at rest", () => {
  it("stores document and resident card numbers only in their ciphertext columns [OBE-036 AC2]", async () => {
    const { body: checkout } = await keyCheckout();
    const number = newDocumentNumber();
    const cardNumber = newResidentCardNumber();

    const res = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
      travelers: [
        buildTravelerInput({
          documents: [buildPassport({ number })],
          discountEligibility: [{ subType: "SPANISH_RESIDENT", cityName: "MADRID", cardNumber }],
        }),
      ],
    });

    expect(res.status).toBe(200);
    expectResponseToMatch("setCheckoutTravelers", res);
    const traveler = (res.body as CheckoutBody).travelers[0];
    expect(traveler?.documents[0]).toMatchObject({ numberMasked: `•••••${number.slice(-4)}` });
    expect(traveler?.documents[0]).not.toHaveProperty("number");
    // Issue date, place of issue and birth place stay inside the ciphertext.
    expect(Object.keys(traveler?.documents[0] ?? {}).sort()).toEqual(
      ["documentType", "expiryDate", "holder", "issuanceCountry", "nationality", "numberMasked"].sort(),
    );
    expect(traveler?.discountEligibility).toEqual([
      { subType: "SPANISH_RESIDENT", cityName: "MADRID", cardNumber: `•••••${cardNumber.slice(-4)}` },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(number);
    expect(JSON.stringify(res.body)).not.toContain(cardNumber);

    // The ciphertext columns hold the numbers, sealed for their own place only.
    const [row] = await travelerRows(checkout.id);
    if (row === undefined) {
      throw new Error("the checkout has a traveller");
    }
    expect(row.documents_ciphertext).toBeInstanceOf(Buffer);
    expect(row.discount_eligibility_ciphertext).toBeInstanceOf(Buffer);
    expect(row.encryption_key_id).toBe("local:v1");
    const documents = await decryptValue(row.documents_ciphertext as Buffer, {
      aad: aadFor("tenant_alpha", "checkout_travelers", "documents_ciphertext", row.id),
      keys,
    });
    expect(JSON.parse(documents.toString("utf8"))).toEqual([
      expect.objectContaining({ number, birthPlace: "UPPSALA" }),
    ]);
    const discounts = await decryptValue(row.discount_eligibility_ciphertext as Buffer, {
      aad: aadFor("tenant_alpha", "checkout_travelers", "discount_eligibility_ciphertext", row.id),
      keys,
    });
    expect(JSON.parse(discounts.toString("utf8"))).toEqual([expect.objectContaining({ cardNumber })]);
    await expect(
      decryptValue(row.documents_ciphertext as Buffer, {
        aad: aadFor("tenant_beta", "checkout_travelers", "documents_ciphertext", row.id),
        keys,
      }),
    ).rejects.toBeInstanceOf(DecryptionError);

    // No other column of the tenant's schema holds either number: every text, character, json and array column
    // (and, as bytes, every bytea column but the two sealed ones, which only hold ciphertext).
    const columns = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      sql<{ table_name: string; column_name: string; data_type: string }>`
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'tenant_alpha'
          AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY', 'bytea')
        ORDER BY table_name, column_name`.execute(trx),
    );
    expect(columns.rows.length).toBeGreaterThan(50);
    // One statement probes every column for all the values (one query per column and value would be hundreds of round
    // trips inside this test's time bound on a busy runner); a row that holds any of them names its column.
    const columnsHolding = async (values: readonly string[]): Promise<string[]> => {
      const probes = columns.rows.map(({ table_name: table, column_name: column, data_type: type }) => {
        const matches = values.map((value) =>
          type === "bytea"
            ? sql`position(convert_to(${value}, 'UTF8') IN ${sql.ref(column)}) > 0`
            : sql`${sql.ref(column)}::text LIKE ${`%${value}%`}`,
        );
        return sql`SELECT ${`${table}.${column}`}::text AS place FROM ${sql.table(table)}
          WHERE ${sql.join(matches, sql` OR `)}`;
      });
      const found = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
        sql<{ place: string }>`${sql.join(probes, sql` UNION ALL `)}`.execute(trx),
      );
      return [...new Set(found.rows.map((row) => row.place))].sort();
    };
    // The probe finds a value that is stored in plain text (the checkout's id)...
    expect(await columnsHolding([checkout.id])).toEqual(
      expect.arrayContaining(["checkout_travelers.checkout_id", "checkouts.id"]),
    );
    // ...and neither number anywhere.
    expect(await columnsHolding([number, cardNumber])).toEqual([]);
    // Nor did the API log either of them.
    expect(api.sink.text()).not.toContain(number);
    expect(api.sink.text()).not.toContain(cardNumber);
  });

  it("keeps the stored number of a document sent back without one, and refuses a masked number", async () => {
    const { body: checkout } = await keyCheckout();
    const passport = buildPassport();
    const first = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
      travelers: [buildTravelerInput({ documents: [passport] })],
    });
    expect(first.status).toBe(200);
    const shown = (first.body as CheckoutBody).travelers[0]?.documents[0] ?? {};
    const later = dateFromToday(6 * 365);

    // The answer's document sent back unchanged but for the expiry date.
    const again = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
      travelers: [buildTravelerInput({ documents: [{ ...shown, expiryDate: later } as never] })],
    });
    expect(again.status).toBe(200);
    expectResponseToMatch("setCheckoutTravelers", again);
    const [row] = await travelerRows(checkout.id);
    const sealed = await decryptValue(row?.documents_ciphertext as Buffer, {
      aad: aadFor("tenant_alpha", "checkout_travelers", "documents_ciphertext", row?.id ?? ""),
      keys,
    });
    expect(JSON.parse(sealed.toString("utf8"))).toEqual([
      expect.objectContaining({
        number: passport.number,
        expiryDate: later,
        issuanceLocation: "STOCKHOLM",
        birthPlace: "UPPSALA",
      }),
    ]);

    const masked = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
      travelers: [
        buildTravelerInput({
          documents: [{ ...passport, number: `•••••${(passport.number ?? "").slice(-4)}` }],
        }),
      ],
    });
    expect(masked.status).toBe(400);
    expectResponseToMatch("setCheckoutTravelers", masked);
    expect((masked.body as ErrorBody).error.code).toBe("VALIDATION_FAILED");

    // A document of another country without a number has no stored number to keep.
    const unknown = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
      travelers: [
        buildTravelerInput({
          documents: [{ documentType: "PASSPORT", issuanceCountry: "NO", expiryDate: later }],
        }),
      ],
    });
    expect(unknown.status).toBe(422);
    expectResponseToMatch("setCheckoutTravelers", unknown);
    expect((unknown.body as ErrorBody).error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/travelers/0/documents/0/number", code: "REQUIRED" }),
    ]);
  });
});

describe("checks of the steps", () => {
  it("answers 422 TRAVELER_DATA_INVALID with field errors that never echo a value, and stores nothing", async () => {
    const { body: checkout } = await keyCheckout();
    const number = newDocumentNumber();

    const res = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
      travelers: [
        buildTravelerInput({
          name: { firstName: "ZOË", lastName: "QUIXOTE" },
          documents: [buildPassport({ number, expiryDate: dateFromToday(59) })],
        }),
        buildTravelerInput({ travelerId: "2" }),
      ],
    });

    expect(res.status).toBe(422);
    expectResponseToMatch("setCheckoutTravelers", res);
    const error = (res.body as ErrorBody).error;
    expect(error.code).toBe("TRAVELER_DATA_INVALID");
    expect(error.fieldErrors?.map((entry) => [entry.path, entry.code])).toEqual([
      ["/travelers/0/name/firstName", "INVALID_CHARACTERS"],
      ["/travelers/0/documents/0/expiryDate", "DOCUMENT_EXPIRES_BEFORE_RETURN"],
      ["/travelers/1/travelerId", "UNKNOWN_TRAVELER_ID"],
    ]);
    for (const value of ["ZOË", "QUIXOTE", number, dateFromToday(59)]) {
      expect(JSON.stringify(res.body)).not.toContain(value);
    }
    // All or nothing: the valid parts were not stored, and the version did not move.
    const [row] = await travelerRows(checkout.id);
    expect(row).toMatchObject({ first_name: null, documents_ciphertext: null });
    const after = await get(keyHeaders(alphaSk), checkout.id);
    expect(after.body).toMatchObject({ version: 1 });
  });

  it("answers 422 CONTACT_DATA_INVALID for contacts that miss what the airline requires", async () => {
    const { body: checkout } = await keyCheckout();

    const res = await put(keyHeaders(alphaSk), checkout.id, "contacts", {
      contacts: [
        buildContactInput({
          phones: [{ deviceType: "LANDLINE", countryCallingCode: "46", number: "81234567" }],
        }),
      ],
    });

    expect(res.status).toBe(422);
    expectResponseToMatch("setCheckoutContacts", res);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: "CONTACT_DATA_INVALID",
      fieldErrors: [expect.objectContaining({ path: "/contacts/0/phones", code: "MOBILE_PHONE_REQUIRED" })],
    });
    const two = await put(keyHeaders(alphaSk), checkout.id, "contacts", {
      contacts: [buildContactInput(), buildContactInput()],
    });
    expect(two.status).toBe(422);
    expect((two.body as ErrorBody).error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/contacts", code: "PRIMARY_CONTACT_REQUIRED" }),
    ]);
  });

  it("[FIX-W30-OTA AC1] takes a US phone (calling code 1) in contacts and travellers, and still refuses letters or four digits on the field", async () => {
    const { body: checkout } = await keyCheckout();
    const usPhones = (countryCallingCode: string) => [
      { deviceType: "MOBILE" as const, countryCallingCode, number: "2025550143" },
    ];
    const traveler = (countryCallingCode: string) => {
      const input = buildTravelerInput();
      return { ...input, contact: { ...input.contact, phones: usPhones(countryCallingCode) } };
    };

    const travelers = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
      travelers: [traveler("1")],
    });
    expect(travelers.status).toBe(200);
    expectResponseToMatch("setCheckoutTravelers", travelers);
    expect((travelers.body as CheckoutBody).travelers[0]).toMatchObject({
      complete: true,
      contact: { phones: usPhones("1") },
    });
    const contacts = await put(keyHeaders(alphaSk), checkout.id, "contacts", {
      contacts: [buildContactInput({ phones: usPhones("+1") })],
    });
    expect(contacts.status).toBe(200);
    expectResponseToMatch("setCheckoutContacts", contacts);
    // Kept as the traveller gave it: Flight Create Orders sends it to Amadeus unchanged.
    expect((contacts.body as CheckoutBody).contacts[0]?.phones).toEqual(usPhones("+1"));
    expect(contacts.body).toMatchObject({ version: 3, progress: { contactsComplete: true } });

    for (const code of ["1a", "1234"]) {
      const badTraveler = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
        travelers: [traveler(code)],
      });
      expect([code, badTraveler.status]).toEqual([code, 400]);
      expectResponseToMatch("setCheckoutTravelers", badTraveler);
      expect((badTraveler.body as ErrorBody).error).toMatchObject({
        code: "VALIDATION_FAILED",
        fieldErrors: [{ path: "/travelers/0/contact/phones/0/countryCallingCode", code: "pattern" }],
      });
      const badContact = await put(keyHeaders(alphaSk), checkout.id, "contacts", {
        contacts: [buildContactInput({ phones: usPhones(code) })],
      });
      expect([code, badContact.status]).toEqual([code, 400]);
      expect((badContact.body as ErrorBody).error).toMatchObject({
        code: "VALIDATION_FAILED",
        fieldErrors: [{ path: "/contacts/0/phones/0/countryCallingCode", code: "pattern" }],
      });
      expect(JSON.stringify([badTraveler.body, badContact.body])).not.toContain("2025550143");
    }
    // Nothing of the refused requests was stored.
    const after = await get(keyHeaders(alphaSk), checkout.id);
    expect(after.body).toMatchObject({ version: 3 });
  });

  it("answers 400 for requests of unknown travellers, and replaces the requests as a whole", async () => {
    const { body: checkout } = await keyCheckout();

    const unknown = await put(keyHeaders(alphaSk), checkout.id, "remarks", {
      remarks: [buildRemarkInput({ travelerIds: ["1", "4"] })],
    });
    expect(unknown.status).toBe(400);
    expectResponseToMatch("setCheckoutRemarks", unknown);
    expect((unknown.body as ErrorBody).error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/remarks/0/travelerIds/1" }),
    ]);

    const two = await put(keyHeaders(alphaSk), checkout.id, "remarks", {
      remarks: [buildRemarkInput(), buildRemarkInput({ travelerIds: [] })],
    });
    expect(two.status).toBe(200);
    expect((two.body as CheckoutBody).remarks.map((remark) => remark.travelerIds)).toEqual([["1"], []]);
    const one = await put(keyHeaders(alphaSk), checkout.id, "remarks", { remarks: [buildRemarkInput()] });
    expect((one.body as CheckoutBody).remarks).toHaveLength(1);
  });

  it("answers 412 to a stale If-Match and takes a quoted, weak or bare current one", async () => {
    const { body: checkout } = await keyCheckout();

    const stale = await put({ ...keyHeaders(alphaSk), "If-Match": '"7"' }, checkout.id, "remarks", {
      remarks: [],
    });
    expect(stale.status).toBe(412);
    expectResponseToMatch("setCheckoutRemarks", stale);
    expect((stale.body as ErrorBody).error.code).toBe("PRECONDITION_FAILED");

    for (const [index, tag] of ['"1"', 'W/"2"', "3", "*"].entries()) {
      const res = await put({ ...keyHeaders(alphaSk), "If-Match": tag }, checkout.id, "remarks", {
        remarks: [],
      });
      expect([tag, res.status]).toEqual([tag, 200]);
      expect(res.body).toMatchObject({ version: index + 2 });
    }
  });

  it("answers 409 CHECKOUT_ALREADY_COMPLETED to changes of a completed checkout", async () => {
    const { body: checkout } = await keyCheckout();
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("checkouts")
        .set({ status: "completed", completed_at: new Date() })
        .where("id", "=", checkout.id)
        .execute(),
    );

    const res = await put(keyHeaders(alphaSk), checkout.id, "travelers", {
      travelers: [buildTravelerInput()],
    });

    expect(res.status).toBe(409);
    expectResponseToMatch("setCheckoutTravelers", res);
    expect((res.body as ErrorBody).error.code).toBe("CHECKOUT_ALREADY_COMPLETED");
    const read = await get(keyHeaders(alphaSk), checkout.id);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "completed" });
  });
});

describe("who may open and read a checkout", () => {
  it("answers 404 to tenant B for tenant A's checkout, and for an unknown id [OBE-036 AC3]", async () => {
    const { body: checkout } = await keyCheckout();

    const read = await get(keyHeaders(betaSk), checkout.id);
    expect(read.status).toBe(404);
    expectResponseToMatch("getCheckout", read);
    for (const [operationId, part, body] of [
      ["setCheckoutTravelers", "travelers", { travelers: [buildTravelerInput()] }],
      ["setCheckoutContacts", "contacts", { contacts: [buildContactInput()] }],
      ["setCheckoutRemarks", "remarks", { remarks: [] }],
    ] as const) {
      const res = await put(keyHeaders(betaSk), checkout.id, part, body);
      expect([operationId, res.status]).toEqual([operationId, 404]);
      expectResponseToMatch(operationId, res);
    }
    const unknown = await get(keyHeaders(alphaSk), newId("chk"));
    expect(unknown.status).toBe(404);
    // Tenant B cannot open a checkout from tenant A's priced offer either.
    const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk));
    const foreign = await create(keyHeaders(betaSk), { pricedOfferId: pricedOffer.id });
    expect(foreign.status).toBe(404);
    expectResponseToMatch("createCheckout", foreign);
    // Alpha's checkout is unchanged.
    const own = await get(keyHeaders(alphaSk), checkout.id);
    expect(own.body).toMatchObject({ version: 1 });
  });

  it("answers 404 for a checkout or a priced offer of the other environment", async () => {
    const { body: checkout } = await keyCheckout();
    const other = await newPricedOffer(() => keyHeaders(alphaSk));
    await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
      await trx.updateTable("checkouts").set({ environment: "live" }).where("id", "=", checkout.id).execute();
      await trx
        .updateTable("priced_offers")
        .set({ environment: "live" })
        .where("id", "=", other.id)
        .execute();
    });

    const read = await get(keyHeaders(alphaSk), checkout.id);
    expect(read.status).toBe(404);
    expectResponseToMatch("getCheckout", read);
    const change = await put(keyHeaders(alphaSk), checkout.id, "remarks", { remarks: [] });
    expect(change.status).toBe(404);
    expectResponseToMatch("setCheckoutRemarks", change);
    const opened = await create(keyHeaders(alphaSk), { pricedOfferId: other.id });
    expect(opened.status).toBe(404);
    expectResponseToMatch("createCheckout", opened);
  });

  it("lets only its customer, console scope and a secret key read a customer's checkout, and anyone with the key a guest's", async () => {
    const customer = await newCustomer();
    const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk, bearer(customer.token)));
    const created = await create(keyHeaders(alphaSk, bearer(customer.token)), {
      pricedOfferId: pricedOffer.id,
    });
    expect(created.status).toBe(201);
    const id = (created.body as CheckoutBody).id;
    const browser = keyHeaders(alphaPk, { Origin: ALPHA_ORIGIN });

    // The OTA's browser client without the customer's token neither reads nor changes it...
    const anonymous = await get(browser, id);
    expect(anonymous.status).toBe(404);
    expectResponseToMatch("getCheckout", anonymous);
    const change = await put(browser, id, "remarks", { remarks: [] });
    expect(change.status).toBe(404);
    expectResponseToMatch("setCheckoutRemarks", change);
    // ...with the token it does, and so do the OTA's server (secret key) and console scope.
    const owner = await get({ ...browser, ...bearer(customer.token) }, id);
    expect(owner.status).toBe(200);
    expectResponseToMatch("getCheckout", owner);
    const server = await get(keyHeaders(alphaSk), id);
    expect(server.status).toBe(200);
    const staff = await get(keyHeaders(alphaConsole, CONSOLE), id);
    expect(staff.status).toBe(200);
    expect(staff.body).toMatchObject({ id, customerId: customer.id, version: 1 });
    // A guest checkout is a capability URL: the browser client reads it with its id alone.
    const { body: guest } = await keyCheckout();
    const capability = await get(browser, guest.id);
    expect(capability.status).toBe(200);
    expect(capability.body).toMatchObject({ id: guest.id, isGuest: true });
  });

  it("answers 410 CHECKOUT_EXPIRED to every change of an expired checkout, which stays readable [OBE-036 AC3]", async () => {
    const { body: checkout } = await keyCheckout();
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("checkouts")
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where("id", "=", checkout.id)
        .execute(),
    );

    const read = await get(keyHeaders(alphaSk), checkout.id);
    expect(read.status).toBe(200);
    expectResponseToMatch("getCheckout", read);
    expect(read.body).toMatchObject({ status: "expired" });
    for (const [operationId, part, body] of [
      ["setCheckoutTravelers", "travelers", { travelers: [buildTravelerInput()] }],
      ["setCheckoutContacts", "contacts", { contacts: [buildContactInput()] }],
      ["setCheckoutRemarks", "remarks", { remarks: [] }],
    ] as const) {
      const res = await put(keyHeaders(alphaSk), checkout.id, part, body);
      expect([operationId, res.status]).toEqual([operationId, 410]);
      expectResponseToMatch(operationId, res);
      expect((res.body as ErrorBody).error.code).toBe("CHECKOUT_EXPIRED");
    }
  });

  it("answers 410 OFFER_EXPIRED for an expired priced offer and 404 for an unknown one", async () => {
    const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk));
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("priced_offers")
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where("id", "=", pricedOffer.id)
        .execute(),
    );

    const expired = await create(keyHeaders(alphaSk), { pricedOfferId: pricedOffer.id });
    expect(expired.status).toBe(410);
    expectResponseToMatch("createCheckout", expired);
    expect((expired.body as ErrorBody).error.code).toBe("OFFER_EXPIRED");
    const unknown = await create(keyHeaders(alphaSk), { pricedOfferId: newId("prc") });
    expect(unknown.status).toBe(404);
    expectResponseToMatch("createCheckout", unknown);
  });

  it("answers 401 to a guest without guest checkout and 403 EMAIL_NOT_VERIFIED to an unverified customer", async () => {
    const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk));
    await withAlphaSettings({ guest_checkout_enabled: false }, async () => {
      const guest = await create(edgeWrite(), { pricedOfferId: pricedOffer.id });
      expect(guest.status).toBe(401);
      expectResponseToMatch("createCheckout", guest);
      expect((guest.body as ErrorBody).error.code).toBe("UNAUTHENTICATED");
      // A signed-in customer still may.
      const customer = await newCustomer();
      const signedIn = await create(keyHeaders(alphaSk, bearer(customer.token)), {
        pricedOfferId: pricedOffer.id,
      });
      expect(signedIn.status).toBe(201);
    });
    await withAlphaSettings({ require_email_verification: true }, async () => {
      const unverified = await newCustomer({ verified: false });
      const res = await create(keyHeaders(alphaSk, bearer(unverified.token)), {
        pricedOfferId: pricedOffer.id,
      });
      expect(res.status).toBe(403);
      expectResponseToMatch("createCheckout", res);
      expect((res.body as ErrorBody).error.code).toBe("EMAIL_NOT_VERIFIED");
    });
  });
});

describe("a console checkout of a customer's priced offer (FIX-W30-OTA)", () => {
  /** Marks `customerId` deleted (as account.delete leaves it) or disabled, in its own committed transaction. */
  const markCustomer = (customerId: string, status: "deleted" | "disabled") =>
    tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .updateTable("customers")
        .set(
          status === "deleted"
            ? {
                status,
                deleted_at: new Date(),
                email: `${randomBytes(16).toString("hex")}@deleted.invalid`,
                pending_email: null,
              }
            : { status },
        )
        .where("id", "=", customerId)
        .execute(),
    );

  /** The checkouts opened from `pricedOfferId`. */
  const checkoutsOf = (pricedOfferId: string) =>
    tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("checkouts")
        .select(["id", "customer_id", "channel"])
        .where("base_priced_offer_id", "=", pricedOfferId)
        .execute(),
    );

  it("[FIX-W30-OTA AC6] opens it for the customer while the account stands", async () => {
    const customer = await newCustomer();
    const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk, bearer(customer.token)));

    const res = await create(keyHeaders(alphaConsole, CONSOLE), { pricedOfferId: pricedOffer.id });

    expect(res.status).toBe(201);
    expectResponseToMatch("createCheckout", res);
    expect(res.body).toMatchObject({ channel: "console", customerId: customer.id, isGuest: false });
  });

  it("[FIX-W30-OTA AC6] refuses a deleted or a disabled customer's priced offer with 409 CONFLICT, writing nothing", async () => {
    for (const status of ["deleted", "disabled"] as const) {
      const customer = await newCustomer();
      const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk, bearer(customer.token)));
      await markCustomer(customer.id, status);

      const res = await create(keyHeaders(alphaConsole, CONSOLE), { pricedOfferId: pricedOffer.id });

      expect([status, res.status]).toEqual([status, 409]);
      expectResponseToMatch("createCheckout", res);
      expect((res.body as ErrorBody).error).toMatchObject({
        code: "CONFLICT",
        details: { reason: `customer_${status}` },
      });
      expect(await checkoutsOf(pricedOffer.id)).toEqual([]);
      // As customer scope refuses the customer's own token (FIX-W29-SECURITY).
      const own = await create(keyHeaders(alphaSk, bearer(customer.token)), {
        pricedOfferId: pricedOffer.id,
      });
      expect([status, own.status, (own.body as ErrorBody).error.code]).toEqual([
        status,
        401,
        "UNAUTHENTICATED",
      ]);
    }
  });

  it("[FIX-W30-OTA AC6] refuses it too when the deletion commits after the console read the customer, leaving no checkout", async () => {
    const customer = await newCustomer();
    const pricedOffer = await newPricedOffer(() => keyHeaders(alphaSk, bearer(customer.token)));
    // CheckoutRepository is provided by more than one module: the spy sits on the class. The first read of the
    // customer (before the insert) sees it active; the deletion commits right after it, before the insert.
    const readCustomer = CheckoutRepository.prototype.customer;
    let reads = 0;
    const spy = vi.spyOn(CheckoutRepository.prototype, "customer").mockImplementation(async function (
      this: CheckoutRepository,
      trx,
      id,
    ) {
      const row = await readCustomer.call(this, trx, id);
      reads += 1;
      if (reads === 1 && id === customer.id) {
        await markCustomer(customer.id, "deleted");
      }
      return row;
    });
    let res;
    try {
      res = await create(keyHeaders(alphaConsole, CONSOLE), { pricedOfferId: pricedOffer.id });
    } finally {
      spy.mockRestore();
    }

    expect(reads).toBe(2);
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "customer_deleted" },
    });
    expect(await checkoutsOf(pricedOffer.id)).toEqual([]);
  });
});
