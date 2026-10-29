// The raw Amadeus reads of the console (OBE-067; OADR-0011 point 7, ota/docs/flows/console-operations.md §2 "Raw
// Amadeus (read)", ADR-0012 office isolation, scope.md OF-09 AC3): the eight `console.amadeus.*` reads against
// PostgreSQL 16, Redis 7 and the Amadeus stub, through the API's whole pipeline (guards, validation, the audit
// interceptor), and the four raw writes, which stay deferred.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: two tenants on the shared Velexis test Amadeus account (the stub), each with an office of its
// own (alpha a second one), accounts and memberships. Staff sign in through the OTA admin's service key with portal
// tokens. The orders are created in the stub through its own HTTP API, as a GDS terminal would create them, with
// synthetic travellers and flights relative to now; a stub serves one set of credentials, so both tenants read every
// order and only the OTA backend's office rule keeps them apart. Every documented answer is checked against the OTA
// document. The `isolation` describe is the isolation test of the new tenant repository (RawAmadeusRepository,
// conventions §12): a booking of another tenant or of the other environment is never the request's.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encryptValue, sha256Hex, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
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
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SupplierRequestsRepository,
  type SupplierRequestRecord,
} from "../../../src/amadeus/supplier-requests.repository";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { APP_DIR } from "../../../src/config";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import {
  buildOrderContact,
  buildOrderRequestInput,
  buildOrderTraveler,
  pricedFlightOffer,
} from "../../builders/bookings";
import { testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Schema = "tenant_alpha" | "tenant_beta";
type Role = "owner" | "admin" | "agent" | "finance" | "viewer";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RAW = "/v1/console/amadeus";
const SEARCH = `${RAW}/v2/shopping/flight-offers`;
const AVAILABILITY = `${RAW}/v1/shopping/availability/flight-availabilities`;
const UPSELL = `${RAW}/v1/shopping/flight-offers/upselling`;
const PRICING = `${RAW}/v1/shopping/flight-offers/pricing`;
const ORDERS = `${RAW}/v1/booking/flight-orders`;
const BY_REFERENCE = `${ORDERS}/by-reference`;
const QUEUES = `${RAW}/office/queues`;
/** The queue the queue tests place their orders on (the other tests use the builders' 50). */
const RAW_QUEUE = 61;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let amadeusAccountId: string;
let alphaId: string;
let betaId: string;
/** The office of each tenant on the shared account (and a second one of alpha's). */
let alphaOffice: string;
let alphaSecondOffice: string;
let betaOffice: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };
/** The Flight Offers Search fixture's answer, as the stub sends it for every search. */
let searchFixture: JsonObject;

// ---- Platform rows -------------------------------------------------------------------------------------------------

async function insertAmadeusAccount(clientId: string, secret: string): Promise<string> {
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

/** An active test tenant on the shared Velexis test account (the stub) with its own offices. */
async function insertTenant(key: "alpha" | "beta", offices: readonly string[]): Promise<string> {
  const id = newId("ten");
  const [main] = offices;
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
      amadeus_account_id: amadeusAccountId,
      office_ids: [...offices],
      default_office_id: main,
      queuing_office_id: main,
      owner_office_id: main,
      status: "active",
    })
    .execute();
  return id;
}

interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly role: Role;
}

async function insertMember(tenantId: string, role: Role): Promise<Member> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `staff.${randomBytes(4).toString("hex")}@example.com`,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/Paris",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, tenantId, role };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's API does (PADR-0007 item 1). */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: member.tenantId,
    membershipId: member.staffId,
    role: member.role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

let ipCounter = 0;

/** A staff member signed in through the OTA admin (its service key, the staff member's IP, the test environment). */
class AdminSession {
  readonly ip: string;
  readonly userAgent = `Mozilla/5.0 (OTA admin test ${randomBytes(3).toString("hex")})`;
  accessToken = "";

  constructor(readonly member: Member) {
    ipCounter += 1;
    this.ip = `198.51.100.${ipCounter}`;
  }

  headers(): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      "X-Velexis-Environment": "test",
      ...(this.accessToken === "" ? {} : { Authorization: `Bearer ${this.accessToken}` }),
    };
  }

  async signIn(): Promise<this> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
    this.accessToken = (res.body.session as { accessToken: string }).accessToken;
    return this;
  }

  get(path: string, headers: Record<string, string> = {}) {
    return request(api.server)
      .get(path)
      .set({ ...this.headers(), ...headers });
  }

  post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return request(api.server)
      .post(path)
      .set({ ...this.headers(), ...headers })
      .send(body as object);
  }
}

async function staffSession(tenantId: string, role: Role): Promise<AdminSession> {
  return await new AdminSession(await insertMember(tenantId, role)).signIn();
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

const inTenant = <T>(schema: Schema, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema as TenantSchema, run);

/**
 * A booking (its main columns) of alpha's test environment unless `tenant` or `environment` say otherwise, held by the
 * tenant's office and attached to `flightOrderId` when one is given.
 */
async function seedBooking(
  options: {
    readonly flightOrderId?: string;
    readonly recordLocator?: string;
    readonly tenant?: Schema;
    readonly environment?: "test" | "live";
  } = {},
) {
  const id = newId("bkg");
  const departure = new Date(Date.now() + 10 * DAY);
  const tenant = options.tenant ?? "tenant_alpha";
  const office = tenant === "tenant_beta" ? betaOffice : alphaOffice;
  await inTenant(tenant, (trx) =>
    trx
      .insertInto("bookings")
      .values({
        id,
        environment: options.environment ?? "test",
        reference: newBookingReference(),
        status: "confirmed",
        record_locator: options.recordLocator ?? null,
        origin_system_code: options.recordLocator === undefined ? null : "GDS",
        amadeus_order_id: options.flightOrderId ?? null,
        queuing_office_id: office,
        owner_office_id: office,
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 2 * 60 * MINUTE),
        currency: "EUR",
        net_amount: "98.47",
        total_amount: "110.47",
        contact_email: `${id.toLowerCase()}@example.com`,
        lead_last_name: "SAMPLE",
      })
      .execute(),
  );
  return id;
}

interface StaffActionRow {
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly booking_id: string | null;
  readonly reason: string | null;
  readonly after: unknown;
  readonly staff_id: string | null;
}

/** The staff actions of `schema` the staff member `staffId` caused after signing in, oldest first. */
const staffActionsOf = (schema: Schema, staffId: string): Promise<StaffActionRow[]> =>
  inTenant(schema, (trx) =>
    trx
      .selectFrom("staff_actions")
      .select([
        "id",
        "action",
        "outcome",
        "target_type",
        "target_id",
        "booking_id",
        "reason",
        "after",
        "staff_id",
      ])
      .where("staff_id", "=", staffId)
      .where("action", "!=", "staff.sign_in")
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

interface SupplierRow {
  readonly id: string;
  readonly operation: string;
  readonly amadeus_api: string;
  readonly office_id: string | null;
  readonly staff_id: string | null;
  readonly booking_id: string | null;
  readonly response_body: unknown;
}

/** The `supplier_requests` rows of `schema` of the staff member `staffId`, oldest first. */
const supplierRequestsOf = (schema: Schema, staffId: string): Promise<SupplierRow[]> =>
  inTenant(schema, (trx) =>
    trx
      .selectFrom("supplier_requests")
      .select(["id", "operation", "amadeus_api", "office_id", "staff_id", "booking_id", "response_body"])
      .where("staff_id", "=", staffId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

// ---- Amadeus stub orders -------------------------------------------------------------------------------------------

const local = (date: Date): string => date.toISOString().slice(0, 19);
const dayFromNow = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

async function stubToken(): Promise<string> {
  const res = await fetch(`${stub.url}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: stubCredentials.clientId,
      client_secret: stubCredentials.clientSecret,
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/** An order made outside Velexis. */
interface StubOrder {
  readonly id: string;
  readonly recordLocator: string;
  readonly lastName: string;
  readonly passportNumber: string;
}

/**
 * An order of the stub (Flight Create Orders) of one adult with a passport and a last name of its own, its flight 10
 * days after now, held by the offices given (`owner: null` leaves the owner office out, as Amadeus's by-reference
 * answers often do), placed on queue `queue` of its queuing office.
 */
async function stubOrder(offices: {
  readonly queuing: string;
  readonly owner: string | null;
  readonly queue?: number;
}): Promise<StubOrder> {
  const departure = new Date(Math.floor((Date.now() + 10 * DAY) / MINUTE) * MINUTE);
  const offer = pricedFlightOffer();
  for (const itinerary of offer["itineraries"] as JsonObject[]) {
    for (const segment of itinerary["segments"] as JsonObject[]) {
      (segment["departure"] as JsonObject)["at"] = local(departure);
      (segment["arrival"] as JsonObject)["at"] = local(new Date(departure.getTime() + 125 * MINUTE));
    }
  }
  const lastName = `RAW${randomBytes(4)
    .toString("hex")
    .toUpperCase()
    .replace(/[^A-Z]/g, "Q")}`;
  const traveler = buildOrderTraveler({ travelerId: "1", lastName });
  const built = buildCreateOrderRequest({
    ...buildOrderRequestInput({ flightOffers: [offer] }),
    travelers: [traveler],
    contacts: [buildOrderContact()],
    queue: { number: offices.queue ?? 50, category: 0 },
    offices: { queuing: offices.queuing, owner: offices.owner ?? offices.queuing },
  });
  const body = built.body as { data: JsonObject };
  if (offices.owner === null) {
    delete body.data["ownerOfficeId"];
  }
  const res = await fetch(`${stub.url}/v1/booking/flight-orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await stubToken()}`, "Content-Type": "application/vnd.amadeus+json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const data = ((await res.json()) as { data: JsonObject }).data;
  return {
    id: data["id"] as string,
    recordLocator: ((data["associatedRecords"] as JsonObject[])[0]?.["reference"] as string) ?? "",
    lastName,
    passportNumber: traveler.documents[0]?.number ?? "",
  };
}

const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** A Flight Offers Search POST body (getFlightOffersQuery), Madrid to Paris a month from now. */
function searchQuery(): JsonObject {
  return {
    currencyCode: "EUR",
    originDestinations: [
      {
        id: "1",
        originLocationCode: "MAD",
        destinationLocationCode: "PAR",
        departureDateTimeRange: { date: dayFromNow(30) },
      },
    ],
    travelers: [{ id: "1", travelerType: "ADULT" }],
    sources: ["GDS"],
  };
}

/** Offer `id` of the Flight Offers Search fixture, as a client got it and posts it back. */
function searchOffer(id: string): JsonObject {
  const offer = (searchFixture["data"] as JsonObject[]).find((candidate) => candidate["id"] === id);
  if (offer === undefined) {
    throw new Error(`the Flight Offers Search fixture has no offer ${id}`);
  }
  return structuredClone(offer);
}

// Cloning the template, starting the stub, building the API's module graph and compiling the response validators of
// the operations take several seconds alone and much longer on a busy runner: all of it happens once here, with its
// own budget, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["consoleAmadeusSearchFlightOffers", [200, 400, 403]],
    ["consoleAmadeusGetFlightOffers", [200]],
    ["consoleAmadeusSearchFlightAvailabilities", [200]],
    ["consoleAmadeusUpsellAirOffers", [200, 422]],
    ["consoleAmadeusQuoteAirOffers", [200]],
    ["consoleAmadeusGetFlightOrder", [200, 403, 404]],
    ["consoleAmadeusGetFlightOrderByReference", [200, 403]],
    ["consoleAmadeusGetQueue", [200, 403]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  searchFixture = (
    JSON.parse(
      readFileSync(
        join(APP_DIR, "../../tools/amadeus-stub/fixtures/flight-offers-search/success.json"),
        "utf8",
      ),
    ) as { body: JsonObject }
  ).body;
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
  stubCredentials = {
    clientId: `velexis-test-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  };
  const office = (): string => `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  [alphaOffice, alphaSecondOffice, betaOffice] = [office(), office(), office()];
  amadeusAccountId = await insertAmadeusAccount(stubCredentials.clientId, stubCredentials.clientSecret);
  alphaId = await insertTenant("alpha", [alphaOffice, alphaSecondOffice]);
  betaId = await insertTenant("beta", [betaOffice]);
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Trips"],
  ] as const) {
    await inTenant(schema, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await seedDefaultMarkupRule(trx);
    });
  }
  // Alpha sells with a 10 % markup on every channel: the raw reads still answer Amadeus's net prices.
  await inTenant("tenant_alpha", (trx) =>
    trx
      .insertInto("markup_rules")
      .values({
        id: newId("mkr"),
        name: "Everything",
        scope: JSON.stringify({}),
        calculation: "percentage",
        percentage: "10.0000",
        applies_per: "booking",
        priority: 10,
      })
      .execute(),
  );
  stub = await startAmadeusStub({ credentials: stubCredentials });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
  // The first sign-in and console calls of a process open the pools' connections and warm the token, validation and
  // Amadeus code; done once here, so that no test pays for it.
  const warmUp = await staffSession(alphaId, "owner");
  expect((await warmUp.get(`${SEARCH}?${new URLSearchParams(simpleQuery()).toString()}`)).status).toBe(200);
  expect((await warmUp.get(`${QUEUES}/${RAW_QUEUE}`)).status).toBe(200);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

// Each test starts with full Amadeus buckets (the shared account's and each tenant's, 5 calls per second): the tests
// make their calls back to back, faster than a staff member would, and a test never waits for a bucket to refill.
beforeEach(async () => {
  stub.clearRequests();
  await redis.client.del(
    redisKeys.amadeusCredentialBucket(amadeusAccountId, "test").key,
    redisKeys.amadeusTenantBucket(alphaId, "test").key,
    redisKeys.amadeusTenantBucket(betaId, "test").key,
  );
});

/** The query of a Flight Offers Search GET, Madrid to Paris a month from now. */
function simpleQuery(): Record<string, string> {
  return {
    originLocationCode: "MAD",
    destinationLocationCode: "PAR",
    departureDate: dayFromNow(30),
    adults: "1",
    max: "5",
  };
}

/** The audit row of a successful raw read, checked against its answer's `call`. */
async function expectAudited(
  session: AdminSession,
  res: Response,
  action: string,
  expected: Partial<StaffActionRow> = {},
): Promise<StaffActionRow> {
  const rows = (await staffActionsOf("tenant_alpha", session.member.staffId)).filter(
    (row) => row.action === action,
  );
  expect(rows).toEqual([
    expect.objectContaining({ id: res.body.call.staffActionId, outcome: "succeeded", ...expected }),
  ]);
  return rows[0] as StaffActionRow;
}

describe("console.amadeus shopping reads", () => {
  it("[OBE-067 AC1] searchFlightOffers sends the body as given for the tenant's office, answers net prices and audits the reason", async () => {
    const agent = await staffSession(alphaId, "agent");
    const bookingId = await seedBooking();

    const res = await agent.post(SEARCH, {
      amadeus: searchQuery(),
      bookingId,
      reason: "Check AF availability for a corporate request",
    });

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleAmadeusSearchFlightOffers", res);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.call).toMatchObject({
      environment: "test",
      officeId: alphaOffice,
      amadeusApi: "FlightOffersSearch",
      amadeusOperationId: "searchFlightOffers",
      httpMethod: "POST",
      path: "/v2/shopping/flight-offers",
      httpStatus: 200,
    });
    // Net prices: Amadeus's offers as they are, although alpha sells with a 10 % markup.
    expect(res.body.amadeus.data).toEqual(searchFixture["data"]);
    // Every dictionary, `locations` and `currencies` with the `key` the document's entries require: their first code
    // (FIX-W33-OTA), so the answer conforms (expectResponseToMatch above).
    const fixtureDictionaries = searchFixture["dictionaries"] as JsonObject;
    expect(res.body.amadeus.dictionaries).toEqual({
      carriers: fixtureDictionaries["carriers"],
      aircraft: fixtureDictionaries["aircraft"],
      locations: { key: "MAD", ...(fixtureDictionaries["locations"] as JsonObject) },
      currencies: { key: "EUR", ...(fixtureDictionaries["currencies"] as JsonObject) },
    });
    expect(amadeusCalls("searchFlightOffers")).toHaveLength(1);
    expect(await supplierRequestsOf("tenant_alpha", agent.member.staffId)).toEqual([
      expect.objectContaining({
        id: res.body.call.supplierRequestId,
        operation: "console.amadeus.searchFlightOffers",
        amadeus_api: "FlightOffersSearch",
        office_id: alphaOffice,
        booking_id: bookingId,
      }),
    ]);
    await expectAudited(agent, res, "amadeus.searchFlightOffers", {
      reason: "Check AF availability for a corporate request",
      target_type: "booking",
      target_id: bookingId,
      booking_id: bookingId,
      after: expect.objectContaining({ supplierRequestId: res.body.call.supplierRequestId, results: 5 }),
    });
  });

  it("[OBE-067 AC1] getFlightOffers forwards the query verbatim and answers the stub's offers", async () => {
    const agent = await staffSession(alphaId, "agent");
    const query = new URLSearchParams({ ...simpleQuery(), nonStop: "true", currencyCode: "EUR" }).toString();

    const res = await agent.get(`${SEARCH}?${query}`);

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleAmadeusGetFlightOffers", res);
    const [call] = amadeusCalls("getFlightOffers");
    expect(call?.query).toEqual({ ...simpleQuery(), nonStop: "true", currencyCode: "EUR" });
    expect(res.body.call).toMatchObject({ officeId: alphaOffice, httpMethod: "GET" });
    // `path` is what was sent: the same parameters, in the document's order.
    const sent = new URL(res.body.call.path as string, "https://amadeus.invalid");
    expect([sent.pathname, Object.fromEntries(sent.searchParams)]).toEqual([
      "/v2/shopping/flight-offers",
      { ...simpleQuery(), nonStop: "true", currencyCode: "EUR" },
    ]);
    expect(res.body.amadeus.data).toEqual(searchFixture["data"]);
    await expectAudited(agent, res, "amadeus.getFlightOffers", { reason: null, target_type: null });
  });

  it("[OBE-067 AC1] searchFlightAvailabilities, upsellAirOffers and quoteAirOffers reach the stub for the tenant's office", async () => {
    const admin = await staffSession(alphaId, "admin");
    const availability = await admin.post(AVAILABILITY, {
      amadeus: {
        originDestinations: [
          {
            id: "1",
            originLocationCode: "MAD",
            destinationLocationCode: "PAR",
            departureDateTime: { date: dayFromNow(30), time: "06:00:00" },
          },
        ],
        travelers: [{ id: "1", travelerType: "ADULT" }],
        sources: ["GDS"],
      },
      reason: "Seats in M class",
    });
    const upsell = await admin.post(UPSELL, {
      amadeus: { data: { type: "flight-offers-upselling", flightOffers: [searchOffer("2")] } },
    });
    const pricing = await admin.post(`${PRICING}?include=bags&forceClass=true`, {
      amadeus: { data: { type: "flight-offers-pricing", flightOffers: [searchOffer("2")] } },
    });

    expect([answer(availability), answer(upsell), answer(pricing)]).toEqual([
      [200, undefined],
      [200, undefined],
      [200, undefined],
    ]);
    expectResponseToMatch("consoleAmadeusSearchFlightAvailabilities", availability);
    expectResponseToMatch("consoleAmadeusUpsellAirOffers", upsell);
    expectResponseToMatch("consoleAmadeusQuoteAirOffers", pricing);
    expect(
      ["searchFlightAvailabilities", "upsellAirOffers", "quoteAirOffers"].map(
        (operation) => amadeusCalls(operation).length,
      ),
    ).toEqual([1, 1, 1]);
    expect(amadeusCalls("quoteAirOffers")[0]?.query).toEqual({ include: "bags", forceClass: "true" });
    expect(pricing.body.call).toMatchObject({
      amadeusApi: "FlightOffersPrice",
      path: "/v1/shopping/flight-offers/pricing?include=bags&forceClass=true",
      officeId: alphaOffice,
    });
    // The priced offer at Amadeus's (net) price, its bag options included.
    const priced = (pricing.body.amadeus.data.flightOffers as JsonObject[])[0];
    expect(priced?.["price"]).toEqual(searchOffer("2")["price"]);
    expect(pricing.body.amadeus.included).toHaveProperty("bags");
    expect(
      (await supplierRequestsOf("tenant_alpha", admin.member.staffId)).map((row) => [
        row.operation,
        row.office_id,
      ]),
    ).toEqual([
      ["console.amadeus.searchFlightAvailabilities", alphaOffice],
      ["console.amadeus.upsellAirOffers", alphaOffice],
      ["console.amadeus.quoteAirOffers", alphaOffice],
    ]);
    expect(
      (await staffActionsOf("tenant_alpha", admin.member.staffId)).map((row) => [
        row.action,
        row.outcome,
        row.reason,
      ]),
    ).toEqual([
      ["amadeus.searchFlightAvailabilities", "succeeded", "Seats in M class"],
      ["amadeus.upsellAirOffers", "succeeded", null],
      ["amadeus.quoteAirOffers", "succeeded", null],
    ]);
  });

  it("answers Amadeus's refusal as 422 SUPPLIER_REJECTED with its verbatim errors and the call's log row", async () => {
    const agent = await staffSession(alphaId, "agent");

    const res = await agent.post(
      UPSELL,
      { amadeus: { data: { type: "flight-offers-upselling", flightOffers: [searchOffer("2")] } } },
      { "X-Stub-Scenario": "sold-out" },
    );

    expect(answer(res)).toEqual([422, "SUPPLIER_REJECTED"]);
    expectResponseToMatch("consoleAmadeusUpsellAirOffers", res);
    const [row] = await supplierRequestsOf("tenant_alpha", agent.member.staffId);
    expect(res.body.error).toMatchObject({
      supplier: { provider: "amadeus", code: 34651 },
      details: {
        supplierRequestId: row?.id,
        errors: [expect.objectContaining({ status: 400, code: 34651 })],
      },
    });
    // A failed read has the audit interceptor's row, without a reason or a body.
    expect(await staffActionsOf("tenant_alpha", agent.member.staffId)).toEqual([
      expect.objectContaining({ action: "amadeus.upsellAirOffers", outcome: "failed", after: null }),
    ]);
  });

  it("refuses a bookingId that is no booking of the environment before any call", async () => {
    const agent = await staffSession(alphaId, "agent");

    const res = await agent.post(SEARCH, { amadeus: searchQuery(), bookingId: newId("bkg") });

    expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch("consoleAmadeusSearchFlightOffers", res);
    expect(res.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/bookingId", code: "not_found" }),
    ]);
    expect(amadeusCalls("searchFlightOffers")).toEqual([]);
  });

  it("refuses a role without amadeus:read before any call, with a denied row", async () => {
    const finance = await staffSession(alphaId, "finance");

    const res = await finance.post(SEARCH, { amadeus: searchQuery() });

    expect(answer(res)).toEqual([403, "FORBIDDEN"]);
    expectResponseToMatch("consoleAmadeusSearchFlightOffers", res);
    expect(res.body.error.details).toMatchObject({ requiredPermission: "amadeus:read" });
    expect(amadeusCalls("searchFlightOffers")).toEqual([]);
    expect(await staffActionsOf("tenant_alpha", finance.member.staffId)).toEqual([
      expect.objectContaining({ action: "amadeus.searchFlightOffers", outcome: "denied" }),
    ]);
  });
});

describe("console.amadeus order reads", () => {
  it("[OBE-067 AC1] getFlightOrder reads the tenant's order for its office, verbatim, linked to its booking", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    const bookingId = await seedBooking({ flightOrderId: order.id, recordLocator: order.recordLocator });

    const res = await agent.get(`${ORDERS}/${order.id}?include=bags&fareRules=refunds`);

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleAmadeusGetFlightOrder", res);
    expect(res.body).toMatchObject({
      flightOrderId: order.id,
      bookingId,
      bookingSynced: false,
      call: {
        officeId: alphaOffice,
        amadeusApi: "FlightOrderManagement",
        amadeusOperationId: "getFlightOrder",
        path: `/v1/booking/flight-orders/${order.id}?include=bags&fareRules=refunds`,
      },
      amadeus: { data: { id: order.id, ownerOfficeId: alphaOffice } },
    });
    // Verbatim: the full passport number, which only the console's audited reads show.
    expect(JSON.stringify(res.body.amadeus)).toContain(order.passportNumber);
    expect(amadeusCalls("getFlightOrder")[0]?.query).toEqual({ include: "bags", fareRules: "refunds" });
    expect(await supplierRequestsOf("tenant_alpha", agent.member.staffId)).toEqual([
      expect.objectContaining({
        operation: "console.amadeus.getFlightOrder",
        office_id: alphaOffice,
        booking_id: bookingId,
      }),
    ]);
    await expectAudited(agent, res, "amadeus.getFlightOrder", {
      target_type: "flight_order",
      target_id: order.id,
      booking_id: bookingId,
    });
  });

  it("[OBE-067 AC1] getFlightOrderByReference answers the tenant's orders with their bookings", async () => {
    const agent = await staffSession(alphaId, "agent");
    // The queuing office decides only for an order without an owner office (OBE-064's rule).
    const order = await stubOrder({ queuing: alphaSecondOffice, owner: null });

    const res = await agent.get(
      `${BY_REFERENCE}?reference=${order.recordLocator}&originSystemCode=GDS&include=bags`,
    );

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleAmadeusGetFlightOrderByReference", res);
    expect(amadeusCalls("getFlightOrderByReference").map((call) => call.query)).toEqual([
      { reference: order.recordLocator, originSystemCode: "GDS", include: "bags" },
    ]);
    expect(res.body.matches).toEqual([{ flightOrderId: order.id, bookingId: null }]);
    expect((res.body.amadeus.data as JsonObject[]).map((entry) => entry["id"])).toEqual([order.id]);
    expect(res.body.call).toMatchObject({
      officeId: alphaOffice,
      amadeusApi: "GetFlightOrderByRecordLocator",
      path: `/v1/booking/flight-orders/by-reference?reference=${order.recordLocator}&originSystemCode=GDS&include=bags`,
    });
    await expectAudited(agent, res, "amadeus.getFlightOrderByReference", {
      target_type: "record_locator",
      target_id: order.recordLocator,
      after: expect.objectContaining({ flightOrderIds: [order.id], withheldOrders: 0 }),
    });
  });

  it("[OBE-067 AC1] [OF-09 AC3] tenant A cannot read tenant B's order by id: refused, and A's supplier log keeps its id only", async () => {
    const betaOrder = await stubOrder({ queuing: betaOffice, owner: betaOffice });
    const agent = await staffSession(alphaId, "agent");

    const res = await agent.get(`${ORDERS}/${betaOrder.id}`);

    expect(answer(res)).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    expectResponseToMatch("consoleAmadeusGetFlightOrder", res);
    expect(JSON.stringify(res.body)).not.toContain(betaOrder.lastName);
    const [row, ...others] = await supplierRequestsOf("tenant_alpha", agent.member.staffId);
    expect(others).toEqual([]);
    expect(row?.response_body).toEqual({
      data: { type: "flight-order", id: betaOrder.id, withheld: "office_not_allowed" },
    });
    expect(await staffActionsOf("tenant_alpha", agent.member.staffId)).toEqual([
      expect.objectContaining({
        action: "amadeus.getFlightOrder",
        outcome: "denied",
        target_type: "flight_order",
        target_id: betaOrder.id,
        after: expect.objectContaining({ code: "OFFICE_NOT_ALLOWED", supplierRequestId: row?.id }),
      }),
    ]);
  });

  it("[OBE-067 AC1] [OF-09 AC3] tenant A cannot read tenant B's PNR by record locator, even one queued in A's office", async () => {
    const agent = await staffSession(alphaId, "agent");
    const betaOrder = await stubOrder({ queuing: betaOffice, owner: betaOffice });
    // Queued in alpha's office but owned by beta's: the owner office decides.
    const ownedByBeta = await stubOrder({ queuing: alphaOffice, owner: betaOffice });

    const refused = await agent.get(
      `${BY_REFERENCE}?reference=${betaOrder.recordLocator}&originSystemCode=GDS`,
    );
    const owned = await agent.get(
      `${BY_REFERENCE}?reference=${ownedByBeta.recordLocator}&originSystemCode=GDS`,
    );

    expect([answer(refused), answer(owned)]).toEqual([
      [403, "OFFICE_NOT_ALLOWED"],
      [403, "OFFICE_NOT_ALLOWED"],
    ]);
    expectResponseToMatch("consoleAmadeusGetFlightOrderByReference", refused);
    const rows = await supplierRequestsOf("tenant_alpha", agent.member.staffId);
    expect(rows.map((row) => row.response_body)).toEqual([
      { data: [{ type: "flight-order", id: betaOrder.id, withheld: "office_not_allowed" }] },
      { data: [{ type: "flight-order", id: ownedByBeta.id, withheld: "office_not_allowed" }] },
    ]);
    const stored = JSON.stringify(rows.map((row) => row.response_body));
    for (const order of [betaOrder, ownedByBeta]) {
      expect(stored).not.toContain(order.lastName);
      expect(stored).not.toContain(order.passportNumber.slice(-4));
    }
    expect(
      (await staffActionsOf("tenant_alpha", agent.member.staffId)).map((row) => [
        row.action,
        row.outcome,
        row.target_id,
      ]),
    ).toEqual([
      ["amadeus.getFlightOrderByReference", "denied", betaOrder.recordLocator],
      ["amadeus.getFlightOrderByReference", "denied", ownedByBeta.recordLocator],
    ]);
    // Beta reads its own order, and its own supplier log keeps it (only another office's orders are withheld).
    const betaAgent = await staffSession(betaId, "agent");
    const own = await betaAgent.get(
      `${BY_REFERENCE}?reference=${betaOrder.recordLocator}&originSystemCode=GDS`,
    );
    expect(answer(own)).toEqual([200, undefined]);
    expect((own.body.amadeus.data as JsonObject[]).map((entry) => entry["id"])).toEqual([betaOrder.id]);
    const [betaRow, ...betaOthers] = await supplierRequestsOf("tenant_beta", betaAgent.member.staffId);
    expect(betaOthers).toEqual([]);
    const [kept] = (betaRow?.response_body as { data: JsonObject[] }).data;
    expect(kept).toMatchObject({ id: betaOrder.id, ownerOfficeId: betaOffice });
    expect(kept).not.toHaveProperty("withheld");
  });

  it("[OBE-067 AC1] [OF-09 AC3] writes the rows of another office's order reads with the withheld body from their first write", async () => {
    const betaOrder = await stubOrder({ queuing: betaOffice, owner: betaOffice });
    const agent = await staffSession(alphaId, "agent");
    // Every row the API's client writes, as it writes it: the client applies the read's `recordedResponse` hook
    // (rawRecordedResponseOf) before the insert, the row's first and only write.
    const repository = api.app.get(SupplierRequestsRepository, { strict: false });
    const insert = repository.insert.bind(repository);
    const written: SupplierRequestRecord[] = [];
    const spy = vi.spyOn(repository, "insert").mockImplementation(async (trx, record) => {
      written.push(record);
      await insert(trx, record);
    });
    let byId: Response;
    let byReference: Response;
    try {
      byId = await agent.get(`${ORDERS}/${betaOrder.id}`);
      byReference = await agent.get(
        `${BY_REFERENCE}?reference=${betaOrder.recordLocator}&originSystemCode=GDS`,
      );
    } finally {
      spy.mockRestore();
    }

    expect([answer(byId), answer(byReference)]).toEqual([
      [403, "OFFICE_NOT_ALLOWED"],
      [403, "OFFICE_NOT_ALLOWED"],
    ]);
    const withheld = { type: "flight-order", id: betaOrder.id, withheld: "office_not_allowed" };
    expect(written.map((record) => [record.operation, record.responseBody])).toStrictEqual([
      ["console.amadeus.getFlightOrder", { data: withheld }],
      ["console.amadeus.getFlightOrderByReference", { data: [withheld] }],
    ]);
    for (const record of written) {
      for (const secret of [betaOrder.lastName, betaOrder.passportNumber.slice(-4), "dictionaries"]) {
        expect(JSON.stringify(record.responseBody)).not.toContain(secret);
      }
    }
    // And the rows as stored are the rows as written: nothing replaced them afterwards.
    expect(
      (await supplierRequestsOf("tenant_alpha", agent.member.staffId)).map((row) => row.response_body),
    ).toStrictEqual([{ data: withheld }, { data: [withheld] }]);
  });

  it("answers an order Amadeus does not have with 404 NOT_FOUND", async () => {
    const agent = await staffSession(alphaId, "agent");

    const res = await agent.get(`${ORDERS}/eJzTd9cPNfX09DUFAAsGAkQ`);

    expect(answer(res)).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("consoleAmadeusGetFlightOrder", res);
    expect(res.body.error).toMatchObject({ supplier: { provider: "amadeus", status: 404 } });
  });
});

describe("console.amadeus.getQueue", () => {
  it("[OBE-067 AC1] reads the queue of the tenant's office and keeps it as a snapshot", async () => {
    const agent = await staffSession(alphaId, "agent");
    const alphaOrder = await stubOrder({ queuing: alphaOffice, owner: alphaOffice, queue: RAW_QUEUE });
    const betaOrder = await stubOrder({ queuing: betaOffice, owner: betaOffice, queue: RAW_QUEUE });

    const res = await agent.get(`${QUEUES}/${RAW_QUEUE}?max=100&category=0`);

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleAmadeusGetQueue", res);
    const [read] = amadeusCalls("listQueue");
    expect(read?.query).toEqual({ max: "100", category: "0", officeId: alphaOffice });
    expect(res.body.call).toMatchObject({
      officeId: alphaOffice,
      amadeusApi: "QueueList",
      path: `/v1/office/queues/${RAW_QUEUE}?max=100&category=0&officeId=${alphaOffice}`,
    });
    const ids = (res.body.amadeus.data as JsonObject[]).map((entry) => entry["id"] as string);
    expect(ids.some((id) => id.startsWith(alphaOrder.recordLocator))).toBe(true);
    expect(ids.some((id) => id.startsWith(betaOrder.recordLocator))).toBe(false);
    const snapshot = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("queue_snapshots")
        .select([
          "office_id",
          "queue_id",
          "category",
          "max_requested",
          "item_count",
          "fetched_by_staff_id",
          "supplier_request_id",
        ])
        .where("id", "=", res.body.queueSnapshotId as string)
        .executeTakeFirstOrThrow(),
    );
    expect(snapshot).toEqual({
      office_id: alphaOffice,
      queue_id: RAW_QUEUE,
      category: 0,
      max_requested: 100,
      item_count: ids.length,
      fetched_by_staff_id: agent.member.staffId,
      supplier_request_id: res.body.call.supplierRequestId,
    });
    await expectAudited(agent, res, "amadeus.getQueue", {
      target_type: "queue",
      target_id: String(RAW_QUEUE),
      after: expect.objectContaining({ queueSnapshotId: res.body.queueSnapshotId, withheldItems: 0 }),
    });
  });

  it("[OBE-067 AC1] [OF-09 AC3] refuses another tenant's office before any call", async () => {
    const agent = await staffSession(alphaId, "agent");

    const res = await agent.get(`${QUEUES}/${RAW_QUEUE}?officeId=${betaOffice}`);

    expect(answer(res)).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    expectResponseToMatch("consoleAmadeusGetQueue", res);
    expect(amadeusCalls("listQueue")).toEqual([]);
    expect(await supplierRequestsOf("tenant_alpha", agent.member.staffId)).toEqual([]);
    expect(await staffActionsOf("tenant_alpha", agent.member.staffId)).toEqual([
      expect.objectContaining({ action: "amadeus.getQueue", outcome: "denied" }),
    ]);
  });
});

// ---- Tenant and environment isolation (conventions §12: every new tenant repository) --------------------------

describe("isolation", () => {
  it("never takes another tenant's or the other environment's booking for one of the request's", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    // The order has a booking in beta and one in alpha's live mode, but none in alpha's test mode.
    const attached = { flightOrderId: order.id, recordLocator: order.recordLocator };
    const foreign = [
      await seedBooking({ ...attached, tenant: "tenant_beta" }),
      await seedBooking({ ...attached, environment: "live" }),
    ];

    // One after the other, so that the audit rows come in this order.
    const searches: Response[] = [];
    for (const bookingId of foreign) {
      searches.push(await agent.post(SEARCH, { amadeus: searchQuery(), bookingId }));
    }
    const byId = await agent.get(`${ORDERS}/${order.id}`);
    const byReference = await agent.get(
      `${BY_REFERENCE}?reference=${order.recordLocator}&originSystemCode=GDS`,
    );

    for (const res of searches) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expect(res.body.error.fieldErrors).toEqual([
        expect.objectContaining({ path: "/bookingId", code: "not_found" }),
      ]);
    }
    expect(amadeusCalls("searchFlightOffers")).toEqual([]);
    expect([answer(byId), answer(byReference)]).toEqual([
      [200, undefined],
      [200, undefined],
    ]);
    expect(byId.body).toMatchObject({ flightOrderId: order.id, bookingId: null });
    expect(byReference.body.matches).toEqual([{ flightOrderId: order.id, bookingId: null }]);
    expect(
      (await supplierRequestsOf("tenant_alpha", agent.member.staffId)).map((row) => [
        row.operation,
        row.booking_id,
      ]),
    ).toEqual([
      ["console.amadeus.getFlightOrder", null],
      ["console.amadeus.getFlightOrderByReference", null],
    ]);
    expect(
      (await staffActionsOf("tenant_alpha", agent.member.staffId)).map((row) => [
        row.action,
        row.outcome,
        row.booking_id,
      ]),
    ).toEqual([
      ["amadeus.searchFlightOffers", "failed", null],
      ["amadeus.searchFlightOffers", "failed", null],
      ["amadeus.getFlightOrder", "succeeded", null],
      ["amadeus.getFlightOrderByReference", "succeeded", null],
    ]);
  });
});

describe("console.amadeus raw writes", () => {
  it("[OBE-067 AC2] createFlightOrders answers 501 NOT_IMPLEMENTED, as the three other raw writes", async () => {
    const owner = await staffSession(alphaId, "owner");
    const orderId = "eJzTd9cPNfX09DUFAAsGAkQ";

    const responses = await Promise.all([
      owner.post(ORDERS, { amadeus: { data: { type: "flight-order" } } }),
      owner.post(`${ORDERS}/${orderId}/issuance`, {}),
      request(api.server).patch(`${ORDERS}/${orderId}`).set(owner.headers()).send({}),
      request(api.server).delete(`${ORDERS}/${orderId}`).set(owner.headers()),
    ]);

    expect(responses.map(answer)).toEqual([
      [501, "NOT_IMPLEMENTED"],
      [501, "NOT_IMPLEMENTED"],
      [501, "NOT_IMPLEMENTED"],
      [501, "NOT_IMPLEMENTED"],
    ]);
    expect(responses[0]?.body.error.details).toEqual({
      milestone: "deferred",
      operationId: "consoleAmadeusCreateFlightOrders",
    });
    expect(stub.requests().filter((entry) => entry.operation !== "oauth2Token")).toEqual([]);
  });
});
