// Guest booking tokens and bookings.lookup (OBE-047, OF-07; ota/docs/flows/my-bookings-and-guest-lookup.md §2, §3 step
// 8 and §4, OADR-0006 points 1, 4 and 6) against PostgreSQL 16, Redis 7, the Amadeus stub and the fake Stripe API of
// test/helpers/fake-stripe.ts.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha on the Velexis test Amadeus account with the `velexis` test payment connection, a test
// storefront and a test and a live secret key; beta live (its storefront serves the live environment). The lookups
// read bookings inserted the way the record step writes them (flights moved relative to now, so no calendar date is
// fixed); the completions run the whole checkout of the stub's Madrid–Paris Orly offer 2 with a PaymentIntent
// confirmed on the fake as Stripe.js would. Redis is flushed before every test, so the failure counters of one test
// never reach the next. Every answer is checked against the OTA document.
import { randomBytes } from "node:crypto";
import { encryptValue, hashApiKey, sha256Hex, type KeyProvider } from "@velexis/crypto";
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
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { BOOKING_TOKEN_PATTERN } from "../../../src/common/auth/booking-access.guard";
import { parseBookingTokens, type BookingTokenEntry } from "../../../src/common/http/cookie-writer";
import { newId } from "../../../src/common/ids";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildStripeConfirmation } from "../../builders/bookings";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import {
  edgeHeaders,
  newApiKey,
  newCsrfToken,
  testApiCredentials,
  testKeyProvider,
} from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Schema = "tenant_alpha" | "tenant_beta";

const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);

/** The Velexis account's test keys of this run: Stripe's shapes, random, never a real key. */
const STRIPE_SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const STRIPE_PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;

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
let accountId: string;
let alphaId: string;
let alphaSk: string;
let alphaLiveSk: string;
let office: string;

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

async function insertTenant(key: "alpha" | "beta", live: boolean): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id,
      key,
      name: `${key} Travel`,
      status: "active",
      plan_code: "early_access",
      ...(live ? { storefront_environment: "live", live_enabled_at: new Date() } : {}),
    })
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
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id: newId("ppc"),
      tenant_id: id,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
      statement_descriptor_suffix: `${key.toUpperCase()} TRAVEL`,
    })
    .execute();
  return id;
}

async function issueKey(tenantId: string, environment: "test" | "live"): Promise<string> {
  const key = newApiKey("sk", environment);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: `Server (${environment})`,
      kind: "secret",
      environment,
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return key;
}

const inTenant = <T>(schema: Schema, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema, run);

const local = (date: Date): string => date.toISOString().slice(0, 19);

/** What a seeded booking looks like. */
interface BookingSeed {
  readonly schema?: Schema;
  readonly environment?: "test" | "live";
  readonly status?: string;
  /** The travellers' last names, as the record step stores them (upper case, as Amadeus writes them). */
  readonly lastNames?: readonly string[];
  /** An airline's own record locator of the booking (`booking_associated_records`). */
  readonly airlineLocator?: string;
}

/** A seeded booking: its id, reference and record locator. */
interface SeededBooking {
  readonly id: string;
  readonly reference: string;
  readonly recordLocator: string;
}

/** A six-character locator of capital letters and digits. */
const newLocator = (): string => randomBytes(3).toString("hex").toUpperCase();

/** A guest booking as the record step writes it: the bookings row, its MAD–ORY flight 10 days ahead, its travellers. */
async function seedBooking(seed: BookingSeed = {}): Promise<SeededBooking> {
  const id = newId("bkg");
  const reference = newBookingReference();
  const recordLocator = newLocator();
  const departure = new Date(Date.now() + 10 * DAY);
  const arrival = new Date(departure.getTime() + 2 * HOUR);
  const lastNames = seed.lastNames ?? ["SAMPLE"];
  const status = seed.status ?? "confirmed";
  // A failed booking has no order and nothing to ticket (the CHECKs of `bookings`).
  const failed = status === "failed";
  await inTenant(seed.schema ?? "tenant_alpha", async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: seed.environment ?? "test",
        reference,
        customer_id: null,
        status,
        ticketing_status: failed ? "not_applicable" : "pending",
        amadeus_order_id: failed ? null : `ORDER-${id.slice(-10)}`,
        record_locator: failed ? null : recordLocator,
        origin_system_code: "GDS",
        owner_office_id: office,
        queuing_office_id: office,
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: departure,
        last_arrival_at: arrival,
        travelers_count: lastNames.length,
        currency: "EUR",
        net_amount: "98.47",
        net_base_amount: "56.00",
        net_fees_amount: "0.00",
        markup_amount: "12.00",
        taxes_amount: "42.47",
        total_amount: "110.47",
        contact_email: "contact-1@example.com",
        lead_last_name: lastNames[0] ?? "SAMPLE",
        order_snapshot: JSON.stringify({}),
      })
      .execute();
    await trx
      .insertInto("booking_segments")
      .values({
        id: newId("seg"),
        booking_id: id,
        amadeus_flight_offer_id: "2",
        amadeus_segment_id: "3",
        itinerary_index: 0,
        segment_index: 0,
        carrier_code: "IB",
        flight_number: "3436",
        departure_iata: "MAD",
        departure_local: local(departure),
        departure_at: departure,
        arrival_iata: "ORY",
        arrival_local: local(arrival),
        arrival_at: arrival,
        duration_minutes: 120,
        cabin: "ECONOMY",
        booking_class: "Q",
      })
      .execute();
    await trx
      .insertInto("booking_travelers")
      .values(
        lastNames.map((lastName, index) => ({
          id: newId("btr"),
          booking_id: id,
          amadeus_traveler_id: String(index + 1),
          traveler_type: "ADULT",
          first_name: "TESTA",
          last_name: lastName,
          date_of_birth: "1988-04-12",
          gender: "FEMALE",
        })),
      )
      .execute();
    if (seed.airlineLocator !== undefined) {
      await trx
        .insertInto("booking_associated_records")
        .values({
          id: newId("bar"),
          booking_id: id,
          reference: seed.airlineLocator,
          origin_system_code: "IB",
        })
        .execute();
    }
  });
  return { id, reference, recordLocator };
}

// ---- Requests ------------------------------------------------------------------------------------------------------

const idempotencyKey = (): string => randomBytes(16).toString("hex");
/** A secret key's headers, with the visitor's IP its server forwards (the lookup counts failures per visitor). */
const keyHeaders = (ip = "198.51.100.10", key = alphaSk): Record<string, string> => ({
  "X-Api-Key": key,
  "X-Velexis-End-User-IP": ip,
});

/** The cookies a browser sends with an edge request: the CSRF value and, when given, the guest cookie. */
function edgeCookies(csrf: string, bookingTokens?: string): string {
  return [
    `__Host-vx_csrf=${csrf}`,
    ...(bookingTokens === undefined ? [] : [`__Host-vx_bt=${bookingTokens}`]),
  ].join("; ");
}

/** The headers of a state-changing edge request for `host` (CSRF cookie, header and `Origin`), with the guest cookie. */
function edgeWrite(host: string, bookingTokens?: string): Record<string, string> {
  const csrf = newCsrfToken();
  return {
    ...edgeHeaders(host),
    Origin: `https://${host}`,
    "X-CSRF-Token": csrf,
    Cookie: edgeCookies(csrf, bookingTokens),
  };
}

/** The headers of an edge read for `host`, with the guest cookie. */
const edgeRead = (host: string, bookingTokens?: string): Record<string, string> => ({
  ...edgeHeaders(host),
  ...(bookingTokens === undefined ? {} : { Cookie: `__Host-vx_bt=${bookingTokens}` }),
});

const lookup = (headers: Record<string, string>, body: JsonObject, key = idempotencyKey()) =>
  request(api.server)
    .post("/v1/bookings/lookup")
    .set({ ...headers, "Idempotency-Key": key })
    .send(body);

const get = (path: string, headers: Record<string, string>) => request(api.server).get(path).set(headers);

interface LookupBody {
  readonly bookingId: string;
  readonly bookingToken: string | null;
  readonly expiresAt: string;
  readonly booking: { readonly id: string; readonly reference: string; readonly status: string };
}
interface ErrorBody {
  readonly error: { readonly code: string; readonly requestId: string; readonly details?: JsonObject };
}
interface CompletionBody {
  readonly booking: { readonly id: string; readonly isGuest: boolean };
  readonly bookingToken: string | null;
  readonly bookingTokenExpiresAt: string | null;
}

/** The `__Host-vx_bt` value of an answer's `Set-Cookie`, with the whole header; `undefined` without one. */
function guestCookieOf(res: {
  headers: JsonObject;
}): { readonly value: string; readonly header: string } | undefined {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? (raw as string[]) : typeof raw === "string" ? [raw] : [];
  const header = headers.find((value) => value.startsWith("__Host-vx_bt="));
  if (header === undefined) {
    return undefined;
  }
  return { value: header.slice("__Host-vx_bt=".length).split(";", 1)[0] ?? "", header };
}

/** The body of an error answer without its `requestId`, as text: what two mismatches must share. */
const withoutRequestId = (body: unknown): string =>
  JSON.stringify(body).replace(/"requestId":"[^"]*"/, '"requestId":""');

/** The bytes of an answer as they were sent, with its `requestId` blanked (the flow's "byte-identical" 404s). */
const rawWithoutRequestId = (res: { readonly text: string }): string =>
  res.text.replace(/"requestId":"[^"]*"/, '"requestId":""');

async function tokenRows(bookingId: string) {
  return await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("booking_access_tokens")
      .selectAll()
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .execute(),
  );
}

async function lookupEvents(bookingId: string) {
  return await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("booking_events")
      .select(["type", "actor_type", "visible_to_customer", "data"])
      .where("booking_id", "=", bookingId)
      .where("type", "=", "booking.lookup")
      .execute(),
  );
}

// ---- Checkouts (the completions) -----------------------------------------------------------------------------------

let searchCount = 0;

/** A priced offer of alpha for the stub's offer 2 of a new search, its flight moved 60 days ahead. */
async function newPricedOffer(): Promise<string> {
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
  const offerId = await inTenant("tenant_alpha", async (trx) => {
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
  return (priced.body as { id: string }).id;
}

/** A guest checkout of alpha with its traveller and contact, and a card payment confirmed on the fake for the total. */
async function paidGuestCheckout(): Promise<string> {
  const pricedOfferId = await newPricedOffer();
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId });
  expect(created.status).toBe(201);
  const checkoutId = (created.body as { id: string }).id;
  const travelers = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/travelers`)
    .set(keyHeaders())
    .send({ travelers: [buildTravelerInput()] });
  expect(travelers.status).toBe(200);
  const contacts = await request(api.server)
    .put(`/v1/checkouts/${checkoutId}/contacts`)
    .set(keyHeaders())
    .send({ contacts: [buildContactInput()] });
  expect(contacts.status).toBe(200);
  const total = (contacts.body as { totals: { total: { amount: string } } }).totals.total.amount;
  const payment = await request(api.server)
    .post(`/v1/checkouts/${checkoutId}/payments`)
    .set({ ...keyHeaders(), "Idempotency-Key": idempotencyKey() })
    .send({ method: "card", termsAccepted: true });
  expect(payment.status).toBe(201);
  const providerPaymentId = (payment.body as { providerPaymentId: string | null }).providerPaymentId ?? "";
  stripe.update(providerPaymentId, buildStripeConfirmation(Math.round(Number(total) * 100)));
  return checkoutId;
}

const complete = (checkoutId: string, headers: Record<string, string>, key = idempotencyKey()) =>
  request(api.server)
    .post(`/v1/checkouts/${checkoutId}/complete`)
    .set({ ...headers, "Idempotency-Key": key })
    .send({});

// Cloning the template, starting the stub and the fake Stripe API and building the API's module graph take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own budget.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["lookupBooking", [200, 404, 429]],
    ["getBooking", [200, 401, 404]],
    ["completeCheckout", [201, 504]],
    ["getBookingTicketingStatus", [200]],
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
  const clientSecret = randomBytes(24).toString("base64url");
  office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  accountId = await insertAccount(clientId, clientSecret);
  alphaId = await insertTenant("alpha", false);
  await insertTenant("beta", true);
  alphaSk = await issueKey(alphaId, "test");
  alphaLiveSk = await issueKey(alphaId, "live");
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Trips"],
  ] as const) {
    await inTenant(schema, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await seedDefaultMarkupRule(trx);
    });
  }
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret } });
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint)],
    env: {
      AMADEUS_BASE_URL_TEST: stub.url,
      STRIPE_SECRET_KEY_TEST: STRIPE_SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY_TEST: STRIPE_PUBLISHABLE_KEY,
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
  // No failure counters, rate limits or cached platform rows from the previous test.
  await redis.client.flushdb();
});

describe("bookings.lookup", () => {
  /** The bookings of this block. */
  let found: SeededBooking;
  let failed: SeededBooking;
  let live: SeededBooking;
  let betaTest: SeededBooking;
  let other: SeededBooking;

  // Five bookings of two tenants: the setup of this block, under its own budget.
  beforeAll(async () => {
    found = await seedBooking({ lastNames: ["MULLER", "ROSSI"], airlineLocator: "IBX9K2" });
    failed = await seedBooking({ status: "failed" });
    live = await seedBooking({ environment: "live" });
    betaTest = await seedBooking({ schema: "tenant_beta", environment: "test" });
    other = await seedBooking({ lastNames: ["BIANCHI"] });
  }, 30_000);

  it("finds a booking by reference, record locator or airline locator and any traveller's name, case- and accent-insensitively, with a 24-hour token", async () => {
    const attempts = [
      { bookingReference: found.reference.toLowerCase(), lastName: "Müller" },
      { bookingReference: found.recordLocator, lastName: "rossi" },
      { bookingReference: "ibx9k2", lastName: " MULLER " },
    ];
    const tokens: string[] = [];
    for (const body of attempts) {
      const before = Date.now();
      const res = await lookup(keyHeaders(), body);

      expect(res.status).toBe(200);
      expectResponseToMatch("lookupBooking", res);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["set-cookie"]).toBeUndefined();
      const answer = res.body as LookupBody;
      expect(answer.bookingId).toBe(found.id);
      expect(answer.booking).toMatchObject({ id: found.id, reference: found.reference, status: "confirmed" });
      expect(answer.bookingToken).toMatch(BOOKING_TOKEN_PATTERN);
      const expiresAt = new Date(answer.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + DAY - MINUTE);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + DAY + MINUTE);
      tokens.push(answer.bookingToken ?? "");
    }

    // Only the SHA-256 of each token is stored; every lookup is a staff-only `booking.lookup` event.
    const rows = await tokenRows(found.id);
    expect(rows.map((row) => row.token_hash).sort()).toEqual(tokens.map((token) => sha256Hex(token)).sort());
    expect(rows.every((row) => row.issued_via === "lookup" && row.created_ip === "198.51.100.10")).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/vxbt_/);
    const events = await lookupEvents(found.id);
    expect(events).toHaveLength(3);
    expect(events.every((event) => !event.visible_to_customer && event.actor_type === "api_key")).toBe(true);
    // The token opens the booking with the key, as X-Booking-Token.
    const opened = await get(`/v1/bookings/${found.id}`, {
      ...keyHeaders(),
      "X-Booking-Token": tokens[0] ?? "",
    });
    expect(opened.status).toBe(200);
    // No token, name or reference reaches a log line.
    for (const secret of [...tokens, "Müller", found.reference]) {
      expect(api.sink.text()).not.toContain(secret);
    }
  });

  it("answers a retry with the same Idempotency-Key with the same token, without a second token", async () => {
    const key = idempotencyKey();
    const body = { bookingReference: other.reference, lastName: "Bianchi" };

    const first = await lookup(keyHeaders(), body, key);
    const retry = await lookup(keyHeaders(), body, key);

    expect([first.status, retry.status]).toEqual([200, 200]);
    expect((retry.body as LookupBody).bookingToken).toBe((first.body as LookupBody).bookingToken);
    expect(await tokenRows(other.id)).toHaveLength(1);
  });

  it("[OBE-047 AC1] answers a wrong reference and a wrong name with identical 404 bodies apart from requestId; the sixth failure answers 429 [OF-07 AC2]", async () => {
    const visitor = keyHeaders("198.51.100.66");
    const wrongReference = await lookup(visitor, { bookingReference: "VXZZZZZZ", lastName: "Muller" });
    const wrongName = await lookup(visitor, { bookingReference: found.reference, lastName: "Bianchi" });

    for (const res of [wrongReference, wrongName]) {
      expect(res.status).toBe(404);
      expectResponseToMatch("lookupBooking", res);
      expect((res.body as ErrorBody).error.code).toBe("NOT_FOUND");
    }
    expect((wrongReference.body as ErrorBody).error.requestId).not.toBe(
      (wrongName.body as ErrorBody).error.requestId,
    );
    expect(withoutRequestId(wrongReference.body)).toBe(withoutRequestId(wrongName.body));
    // Byte for byte as sent, not only once parsed.
    expect(rawWithoutRequestId(wrongReference)).toBe(rawWithoutRequestId(wrongName));
    expect(wrongReference.headers["content-type"]).toBe(wrongName.headers["content-type"]);
    expect(wrongReference.headers["cache-control"]).toBe(wrongName.headers["cache-control"]);

    // Three more failures: five in the window. The sixth attempt answers 429, even with the right name.
    for (const reference of ["VXYYYYYY", "VXXXXXXX", "VXWWWWWW"]) {
      expect((await lookup(visitor, { bookingReference: reference, lastName: "Muller" })).status).toBe(404);
    }
    const sixth = await lookup(visitor, { bookingReference: found.reference, lastName: "Muller" });
    expect(sixth.status).toBe(429);
    expectResponseToMatch("lookupBooking", sixth);
    expect((sixth.body as ErrorBody).error.code).toBe("RATE_LIMITED");
    const retryAfter = Number(sixth.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    // Another visitor is not blocked (one failure counted for this reference so far).
    const elsewhere = await lookup(keyHeaders("198.51.100.67"), {
      bookingReference: found.reference,
      lastName: "Muller",
    });
    expect(elsewhere.status).toBe(200);
    // The counters hold digests, never the IP or the reference.
    const counters = await redis.client.keys("rl:ota_lookup_*");
    expect(counters.length).toBeGreaterThanOrEqual(2);
    expect(counters.join(" ")).not.toMatch(/198\.51\.100|VX/);
  });

  it("[OBE-047 AC1] refuses a reference after five failures on it from any visitors [OF-07 AC2]", async () => {
    for (let visitor = 1; visitor <= 5; visitor += 1) {
      const res = await lookup(keyHeaders(`203.0.113.${visitor}`), {
        bookingReference: other.reference,
        lastName: "Wrong",
      });
      expect(res.status).toBe(404);
    }

    const sixth = await lookup(keyHeaders("203.0.113.6"), {
      bookingReference: other.reference,
      lastName: "Bianchi",
    });

    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("never finds a failed booking, a booking of the other environment, or a test booking from a live storefront", async () => {
    const answers = [
      await lookup(keyHeaders(), { bookingReference: failed.reference, lastName: "Sample" }),
      await lookup(keyHeaders(), { bookingReference: live.reference, lastName: "Sample" }),
      await lookup(edgeWrite(BETA_HOST), { bookingReference: betaTest.reference, lastName: "Sample" }),
    ];

    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(withoutRequestId(res.body)).toBe(withoutRequestId(answers[0]?.body));
    }
    // The live booking is found with a live key.
    const liveKey = await lookup(keyHeaders("198.51.100.10", alphaLiveSk), {
      bookingReference: live.reference,
      lastName: "Sample",
    });
    expect(liveKey.status).toBe(200);
    expect((liveKey.body as LookupBody).bookingToken).toMatch(/^vxbt_live_/);
  });
});

describe("the guest cookie of the storefront edge", () => {
  let bookings: SeededBooking[];

  // Six bookings, oldest first: the setup of this block, under its own budget.
  beforeAll(async () => {
    bookings = [];
    for (let index = 0; index < 6; index += 1) {
      bookings.push(await seedBooking());
    }
  }, 30_000);

  it("[OBE-047 AC2] keeps the newest five guest bookings in one HttpOnly cookie: a sixth drops the oldest entry", async () => {
    let cookie: string | undefined;
    for (const booking of bookings) {
      const res = await lookup(edgeWrite(ALPHA_HOST, cookie), {
        bookingReference: booking.reference,
        lastName: "Sample",
      });

      expect(res.status).toBe(200);
      expectResponseToMatch("lookupBooking", res);
      // No token in the body: it is in the cookie.
      expect((res.body as LookupBody).bookingToken).toBeNull();
      expect(JSON.stringify(res.body)).not.toMatch(/vxbt_/);
      const written = guestCookieOf(res);
      expect(written?.header).toMatch(/; Max-Age=2592000; Path=\/; Secure; SameSite=Lax; HttpOnly$/);
      expect(written?.header).not.toMatch(/Domain=/i);
      cookie = written?.value;
    }

    const entries = parseBookingTokens(cookie);
    expect(entries.map((entry) => entry.bookingId)).toEqual(
      bookings
        .slice(1)
        .map((booking) => booking.id)
        .reverse(),
    );
    // The five open their bookings through the edge; the dropped one has no token any more (the page offers the
    // lookup again).
    for (const entry of entries) {
      expect((await get(`/v1/bookings/${entry.bookingId}`, edgeRead(ALPHA_HOST, cookie))).status).toBe(200);
    }
    const dropped = await get(`/v1/bookings/${bookings[0]?.id}`, edgeRead(ALPHA_HOST, cookie));
    expect(dropped.status).toBe(401);
  });
});

describe("guest tokens at checkout.complete", () => {
  type Answer = { readonly status: number; readonly body: unknown; readonly headers: JsonObject };
  let keyCompletion: { readonly status: number; readonly body: CompletionBody; readonly headers: JsonObject };
  let edgeCompletion: {
    readonly status: number;
    readonly body: CompletionBody;
    readonly headers: JsonObject;
  };
  let edgeTimeout: Answer;
  /** What the timed-out edge completion was sent with, for its same-key replays (the CSRF cookie is its scope). */
  let timeoutRequest: {
    readonly checkoutId: string;
    readonly headers: Record<string, string>;
    readonly key: string;
  };
  let earlier: BookingTokenEntry;

  // Three whole checkouts (search, price, checkout, travellers, contacts, payment) and their completions: one with the
  // secret key, one through the edge with a guest cookie of an earlier booking, and one through the edge that Amadeus
  // answers with a 500 (an unknown outcome): slow on a busy 4-CPU runner, so here under their own budget; the tests only
  // assert on the answers.
  beforeAll(async () => {
    const [keyCheckout, edgeCheckout, timeoutCheckout] = [
      await paidGuestCheckout(),
      await paidGuestCheckout(),
      await paidGuestCheckout(),
    ];
    const seeded = await seedBooking();
    const looked = await lookup(edgeWrite(ALPHA_HOST), {
      bookingReference: seeded.reference,
      lastName: "Sample",
    });
    const [entry] = parseBookingTokens(guestCookieOf(looked)?.value);
    if (entry === undefined) {
      throw new Error("the edge lookup wrote no guest cookie");
    }
    earlier = entry;
    const viaKey = await complete(keyCheckout, keyHeaders());
    const viaEdge = await complete(
      edgeCheckout,
      edgeWrite(ALPHA_HOST, `${earlier.bookingId}.${earlier.token}`),
    );
    timeoutRequest = {
      checkoutId: timeoutCheckout,
      headers: { ...edgeWrite(ALPHA_HOST), ...stubScenario("server-error") },
      key: idempotencyKey(),
    };
    const timedOut = await complete(timeoutCheckout, timeoutRequest.headers, timeoutRequest.key);
    expectResponseToMatch("completeCheckout", viaKey);
    expectResponseToMatch("completeCheckout", viaEdge);
    expectResponseToMatch("completeCheckout", timedOut);
    edgeTimeout = { status: timedOut.status, body: timedOut.body, headers: timedOut.headers };
    keyCompletion = { status: viaKey.status, body: viaKey.body as CompletionBody, headers: viaKey.headers };
    edgeCompletion = {
      status: viaEdge.status,
      body: viaEdge.body as CompletionBody,
      headers: viaEdge.headers,
    };
  }, 60_000);

  it("gives a key caller the guest token in the body, valid 30 days or until 7 days after the trip, stored hashed", async () => {
    expect(keyCompletion.status).toBe(201);
    const { booking, bookingToken, bookingTokenExpiresAt } = keyCompletion.body;
    expect(booking.isGuest).toBe(true);
    expect(bookingToken).toMatch(BOOKING_TOKEN_PATTERN);
    expect(keyCompletion.headers["set-cookie"]).toBeUndefined();
    const [row] = await tokenRows(booking.id);
    expect(row).toMatchObject({ issued_via: "booking_created", token_hash: sha256Hex(bookingToken ?? "") });
    expect(row?.expires_at.toISOString()).toBe(bookingTokenExpiresAt);
    const { last_arrival_at: lastArrival } = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("bookings")
        .select("last_arrival_at")
        .where("id", "=", booking.id)
        .executeTakeFirstOrThrow(),
    );
    // The flight is 60 days ahead: the token lives until 7 days after it lands.
    expect(row?.expires_at.getTime()).toBe(lastArrival.getTime() + 7 * DAY);

    const opened = await get(`/v1/bookings/${booking.id}`, {
      ...keyHeaders(),
      "X-Booking-Token": bookingToken ?? "",
    });
    expect(opened.status).toBe(200);
    // The token never reaches a log line.
    expect(api.sink.text()).not.toContain(bookingToken ?? "vxbt_");
  });

  it("[OBE-047 AC2] adds the edge guest's token to the front of the HttpOnly cookie and puts none in the body", async () => {
    expect(edgeCompletion.status).toBe(201);
    const { booking } = edgeCompletion.body;
    expect(edgeCompletion.body).toMatchObject({ bookingToken: null, bookingTokenExpiresAt: null });
    const written = guestCookieOf(edgeCompletion);
    expect(written?.header).toMatch(/; Path=\/; Secure; SameSite=Lax; HttpOnly$/);
    const entries = parseBookingTokens(written?.value);
    expect(entries.map((entry) => entry.bookingId)).toEqual([booking.id, earlier.bookingId]);
    expect(entries[1]).toEqual(earlier);
    const [row] = await tokenRows(booking.id);
    expect(row).toMatchObject({
      issued_via: "booking_created",
      token_hash: sha256Hex(entries[0]?.token ?? ""),
    });

    const opened = await get(`/v1/bookings/${booking.id}`, edgeRead(ALPHA_HOST, written?.value));
    expect(opened.status).toBe(200);
    // Neither the new token nor the cookie it came in reaches a log line.
    for (const entry of entries) {
      expect(api.sink.text()).not.toContain(entry.token);
    }
  });

  it("gives the edge guest of a 504 the pending booking's token in the cookie, to follow the booking", async () => {
    expect(edgeTimeout.status).toBe(504);
    const error = (edgeTimeout.body as ErrorBody).error;
    expect(error).toMatchObject({
      code: "SUPPLIER_TIMEOUT",
      details: { bookingToken: null, bookingTokenExpiresAt: null, replayed: false },
    });
    const bookingId = String(error.details?.["bookingId"]);
    const written = guestCookieOf(edgeTimeout);
    expect(written?.header).toMatch(/; HttpOnly$/);
    expect(parseBookingTokens(written?.value).map((entry) => entry.bookingId)).toEqual([bookingId]);

    const status = await get(`/v1/bookings/${bookingId}/ticketing`, edgeRead(ALPHA_HOST, written?.value));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ bookingStatus: "pending" });
    // The 504's token never reaches a log line, not even the error's.
    for (const entry of parseBookingTokens(written?.value)) {
      expect(api.sink.text()).not.toContain(entry.token);
    }
  });

  it("hands the 504's guest cookie on to its same-key replays, the pending 504 and the 201 once the booking is decided", async () => {
    const first = guestCookieOf(edgeTimeout);
    expect(first?.header).toMatch(/^__Host-vx_bt=bkg_/);
    const bookingId = String((edgeTimeout.body as ErrorBody).error.details?.["bookingId"]);
    const replay = () => complete(timeoutRequest.checkoutId, timeoutRequest.headers, timeoutRequest.key);

    const pending = await replay();
    expect(pending.status).toBe(504);
    expect((pending.body as ErrorBody).error.details).toMatchObject({ bookingId, replayed: true });
    expect(guestCookieOf(pending)?.header).toBe(first?.header);

    // The booking decided as the reconciliation leaves it once it found the order (written here directly; the
    // reconciliation itself is reconcile.int.test.ts): the replay is the final 201, with the first answer's cookie and
    // no second token.
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("bookings")
        .set({
          status: "confirmed",
          amadeus_order_id: `ORDER-${bookingId.slice(-10)}`,
          record_locator: newLocator(),
        })
        .where("id", "=", bookingId)
        .execute(),
    );
    const decided = await replay();
    expect(decided.status).toBe(201);
    expect(decided.body).toMatchObject({ bookingToken: null, bookingTokenExpiresAt: null });
    expect(guestCookieOf(decided)?.header).toBe(first?.header);
    expect(await tokenRows(bookingId)).toHaveLength(1);
  });
});

describe("booking access with guest tokens", () => {
  let bookingA: SeededBooking;
  let bookingB: SeededBooking;
  let tokenA: string;
  let edgeTokenA: string;

  // Two bookings and a token of A for each kind of caller: the setup of this block, under its own budget.
  beforeAll(async () => {
    bookingA = await seedBooking();
    bookingB = await seedBooking();
    const byKey = await lookup(keyHeaders(), { bookingReference: bookingA.reference, lastName: "Sample" });
    tokenA = (byKey.body as LookupBody).bookingToken ?? "";
    const byEdge = await lookup(edgeWrite(ALPHA_HOST), {
      bookingReference: bookingA.reference,
      lastName: "Sample",
    });
    edgeTokenA = parseBookingTokens(guestCookieOf(byEdge)?.value)[0]?.token ?? "";
  }, 30_000);

  it("[OBE-047 AC3] never opens booking B with a guest token of booking A", async () => {
    // A key caller: A's token on B is the 404 of an unknown booking; on A it opens A.
    const keyOnB = await get(`/v1/bookings/${bookingB.id}`, { ...keyHeaders(), "X-Booking-Token": tokenA });
    expect(keyOnB.status).toBe(404);
    expectResponseToMatch("getBooking", keyOnB);
    expect(
      (await get(`/v1/bookings/${bookingA.id}`, { ...keyHeaders(), "X-Booking-Token": tokenA })).status,
    ).toBe(200);
    // The edge: A's token moved to B's entry is 404 too; the cookie of A opens A only.
    const moved = await get(
      `/v1/bookings/${bookingB.id}`,
      edgeRead(ALPHA_HOST, `${bookingB.id}.${edgeTokenA}`),
    );
    expect(moved.status).toBe(404);
    const cookieA = `${bookingA.id}.${edgeTokenA}`;
    expect((await get(`/v1/bookings/${bookingB.id}`, edgeRead(ALPHA_HOST, cookieA))).status).toBe(401);
    expect((await get(`/v1/bookings/${bookingA.id}`, edgeRead(ALPHA_HOST, cookieA))).status).toBe(200);
  });

  it("reads the cookie for the edge only and X-Booking-Token for keys only, and records each use", async () => {
    const cookieA = `${bookingA.id}.${edgeTokenA}`;
    // A key caller's cookies are ignored, and so is the edge's X-Booking-Token.
    const keyWithCookie = await get(`/v1/bookings/${bookingA.id}`, {
      ...keyHeaders(),
      Cookie: `__Host-vx_bt=${cookieA}`,
    });
    expect(keyWithCookie.status).toBe(401);
    const edgeWithHeader = await get(`/v1/bookings/${bookingA.id}`, {
      ...edgeRead(ALPHA_HOST),
      "X-Booking-Token": tokenA,
    });
    expect(edgeWithHeader.status).toBe(401);
    const before = await tokenRows(bookingA.id);

    expect((await get(`/v1/bookings/${bookingA.id}`, edgeRead(ALPHA_HOST, cookieA))).status).toBe(200);

    const after = await tokenRows(bookingA.id);
    const used = after.find((row) => row.token_hash === sha256Hex(edgeTokenA));
    const unused = after.find((row) => row.token_hash === sha256Hex(tokenA));
    expect(used?.use_count).toBe((before.find((row) => row.id === used?.id)?.use_count ?? 0) + 1);
    expect(used?.last_used_at).not.toBeNull();
    expect(unused?.use_count).toBe(before.find((row) => row.id === unused?.id)?.use_count);
  });

  it("refuses a revoked or expired token like an unknown booking", async () => {
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("booking_access_tokens")
        .set({ revoked_at: new Date() })
        .where("token_hash", "=", sha256Hex(tokenA))
        .execute(),
    );
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("booking_access_tokens")
        .set({ expires_at: new Date(Date.now() - MINUTE) })
        .where("token_hash", "=", sha256Hex(edgeTokenA))
        .execute(),
    );

    const revoked = await get(`/v1/bookings/${bookingA.id}`, { ...keyHeaders(), "X-Booking-Token": tokenA });
    const expired = await get(
      `/v1/bookings/${bookingA.id}`,
      edgeRead(ALPHA_HOST, `${bookingA.id}.${edgeTokenA}`),
    );

    expect(revoked.status).toBe(404);
    expect(expired.status).toBe(404);
  });
});
