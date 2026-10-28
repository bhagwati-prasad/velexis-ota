// The console PNR lookup and import (OBE-064; ota/docs/flows/console-operations.md §2 "PNR lookup and import", §3
// step 4, ADR-0012 office isolation, scope.md OF-09 AC3, OADR-0005 point 10): console.bookings.findByRecordLocator and
// console.bookings.import against PostgreSQL 16, Redis 7 and the Amadeus stub, through the API's whole pipeline
// (guards, validation, idempotency, the audit interceptor).
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: two tenants on the shared Velexis test Amadeus account (the stub), each with an office of its
// own, accounts and memberships. Staff sign in through the OTA admin's service key with portal tokens. The orders are
// created in the stub through its own HTTP API, as a GDS terminal would create them, with synthetic travellers and
// flights relative to now; a stub serves one set of credentials, so both tenants read every order and only the OTA
// backend's office check keeps them apart. Every answer is checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
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
import type { Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildCreateOrderRequest, buildIssueRequest } from "../../../src/bookings/order-request.builder";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { documentRenderKey } from "../../../src/documents/documents.processor";
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
const LOOKUP = "/v1/console/bookings/by-record-locator";
const IMPORTS = "/v1/console/bookings/imports";

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
let consoleRuleId: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };

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

  lookup(reference: string, query = "") {
    return request(api.server)
      .get(`${LOOKUP}?reference=${reference}&originSystemCode=GDS${query}`)
      .set(this.headers());
  }

  import(body: JsonObject, key: string = randomUUID()) {
    return request(api.server)
      .post(IMPORTS)
      .set({ ...this.headers(), "Idempotency-Key": key })
      .send(body);
  }
}

async function staffSession(tenantId: string, role: Role): Promise<AdminSession> {
  return await new AdminSession(await insertMember(tenantId, role)).signIn();
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

const inTenant = <T>(schema: Schema, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema as TenantSchema, run);

async function newCustomer(schema: Schema, status: "active" | "deleted" = "active"): Promise<string> {
  const id = newId("cus");
  await inTenant(schema, (trx) =>
    trx
      .insertInto("customers")
      .values({
        id,
        email:
          status === "deleted"
            ? `${randomBytes(8).toString("hex")}@deleted.invalid`
            : `${id.toLowerCase()}@example.com`,
        email_verified_at: new Date(),
        first_name: status === "deleted" ? null : "Testa",
        last_name: status === "deleted" ? null : "Customer",
        status,
        deleted_at: status === "deleted" ? new Date() : null,
      })
      .execute(),
  );
  return id;
}

const bookingsOf = (schema: Schema, recordLocator: string) =>
  inTenant(schema, (trx) =>
    trx.selectFrom("bookings").selectAll().where("record_locator", "=", recordLocator).execute(),
  );

const staffActionsOf = (schema: Schema, targetId: string) =>
  inTenant(schema, (trx) =>
    trx
      .selectFrom("staff_actions")
      .select(["action", "outcome", "target_type", "target_id", "booking_id", "reason", "after", "staff_id"])
      .where((eb) => eb.or([eb("target_id", "=", targetId), eb("booking_id", "=", targetId)]))
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const supplierRequestsOf = (schema: Schema, operation: string) =>
  inTenant(schema, (trx) =>
    trx
      .selectFrom("supplier_requests")
      .select(["id", "amadeus_api", "response_body", "booking_id", "office_id"])
      .where("operation", "=", operation)
      .orderBy("created_at")
      .execute(),
  );

// ---- Amadeus stub orders -------------------------------------------------------------------------------------------

const local = (date: Date): string => date.toISOString().slice(0, 19);

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

/** A call to the stub's own HTTP API (as a GDS terminal or another Amadeus client would make it). */
async function stubFetch(path: string, body: unknown): Promise<JsonObject> {
  const res = await fetch(`${stub.url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await stubToken()}`, "Content-Type": "application/vnd.amadeus+json" },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as JsonObject;
}

/** An order made outside Velexis. */
interface StubOrder {
  readonly id: string;
  readonly recordLocator: string;
  readonly data: JsonObject;
  readonly passportNumber: string;
}

/**
 * An order of the stub (Flight Create Orders) of one adult with a passport, its flight 10 days after now, held by the
 * offices given (`owner: null` leaves the owner office out, as Amadeus's by-reference answers often do).
 */
async function stubOrder(offices: {
  readonly queuing: string;
  readonly owner: string | null;
}): Promise<StubOrder> {
  const departure = new Date(Math.floor((Date.now() + 10 * DAY) / MINUTE) * MINUTE);
  const offer = pricedFlightOffer();
  for (const itinerary of offer["itineraries"] as JsonObject[]) {
    for (const segment of itinerary["segments"] as JsonObject[]) {
      (segment["departure"] as JsonObject)["at"] = local(departure);
      (segment["arrival"] as JsonObject)["at"] = local(new Date(departure.getTime() + 125 * MINUTE));
    }
  }
  const traveler = buildOrderTraveler({ travelerId: "1" });
  const built = buildCreateOrderRequest({
    ...buildOrderRequestInput({ flightOffers: [offer] }),
    travelers: [traveler],
    contacts: [buildOrderContact()],
    offices: { queuing: offices.queuing, owner: offices.owner ?? offices.queuing },
  });
  const body = built.body as { data: JsonObject };
  if (offices.owner === null) {
    delete body.data["ownerOfficeId"];
  }
  const data = (await stubFetch("/v1/booking/flight-orders", body))["data"] as JsonObject;
  const recordLocator = ((data["associatedRecords"] as JsonObject[])[0]?.["reference"] as string) ?? "";
  return {
    id: data["id"] as string,
    recordLocator,
    data,
    passportNumber: traveler.documents[0]?.number ?? "",
  };
}

const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

// Cloning the template, starting the stub, building the API's module graph and compiling the response validators of
// the operations take several seconds alone and much longer on a busy runner: all of it happens once here, with its
// own budget, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["consoleFindBookingByRecordLocator", [200, 403, 404]],
    ["consoleImportBooking", [201, 400, 403, 404, 409, 422]],
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
  // Alpha's markup for console sales: 10 %, before the seeded default rule (0 %, priority 1000).
  consoleRuleId = newId("mkr");
  await inTenant("tenant_alpha", (trx) =>
    trx
      .insertInto("markup_rules")
      .values({
        id: consoleRuleId,
        name: "Console sales",
        scope: JSON.stringify({ channels: ["console"] }),
        calculation: "percentage",
        percentage: "10.0000",
        applies_per: "booking",
        priority: 50,
      })
      .execute(),
  );
  stub = await startAmadeusStub({ credentials: stubCredentials });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
  // The first sign-in and console calls of a process open the pools' connections and warm the token, validation and
  // Amadeus code; done once here, so that no test pays for it.
  const warmUp = await staffSession(alphaId, "owner");
  const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
  expect((await warmUp.lookup(order.recordLocator)).status).toBe(200);
  expect((await warmUp.import({ reference: order.recordLocator, pricing: { mode: "net" } })).status).toBe(
    201,
  );
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

describe("console.bookings.findByRecordLocator", () => {
  it("answers the tenant's order verbatim with its summary, importable, and audits the lookup", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });

    const res = await agent.lookup(order.recordLocator, "&include=bags");

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleFindBookingByRecordLocator", res);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toMatchObject({
      reference: order.recordLocator,
      originSystemCode: "GDS",
      call: {
        environment: "test",
        amadeusApi: "GetFlightOrderByRecordLocator",
        amadeusOperationId: "getFlightOrder",
        httpMethod: "GET",
        path: `/v1/booking/flight-orders/by-reference?reference=${order.recordLocator}&originSystemCode=GDS&include=bags`,
        httpStatus: 200,
      },
    });
    const [match, ...others] = res.body.matches as JsonObject[];
    expect(others).toEqual([]);
    expect(match).toMatchObject({
      flightOrderId: order.id,
      bookingId: null,
      bookingReference: null,
      bookingStatus: null,
      importable: true,
      summary: {
        recordLocators: [{ reference: order.recordLocator, originSystemCode: "GDS", primary: true }],
        travelers: [{ travelerId: "1", lastName: "SAMPLE" }],
        queuingOfficeId: alphaOffice,
        ticketNumbers: [],
      },
    });
    // Verbatim: the full passport number, which only the console's audited reads show.
    expect(JSON.stringify(match?.["amadeus"])).toContain(order.passportNumber);
    expect(amadeusCalls("getFlightOrderByReference")).toHaveLength(1);
    expect(await staffActionsOf("tenant_alpha", order.recordLocator)).toEqual([
      expect.objectContaining({
        action: "pnr.lookup",
        outcome: "succeeded",
        target_type: "record_locator",
        target_id: order.recordLocator,
        staff_id: agent.member.staffId,
        after: expect.objectContaining({ flightOrderIds: [order.id], withheldOrders: 0 }),
      }),
    ]);
  });

  it("[OBE-064 AC1] [OF-09 AC3] tenant B on the shared account cannot find tenant A's PNR", async () => {
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    const betaAgent = await staffSession(betaId, "agent");

    const res = await betaAgent.lookup(order.recordLocator);

    expect(answer(res)).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    expectResponseToMatch("consoleFindBookingByRecordLocator", res);
    expect(JSON.stringify(res.body)).not.toContain(order.passportNumber);
    // The refusal is a denied staff action naming the record locator, written once.
    expect(await staffActionsOf("tenant_beta", order.recordLocator)).toEqual([
      expect.objectContaining({
        action: "bookings.findByRecordLocator",
        outcome: "denied",
        target_type: "record_locator",
        staff_id: betaAgent.member.staffId,
      }),
    ]);
    // Beta's supplier log keeps the call, not alpha's order: its id and a marker only, without the answer's
    // dictionaries (alpha's airports, with their cities and countries).
    const rows = (await supplierRequestsOf("tenant_beta", "console.bookings.findByRecordLocator")).filter(
      (row) => JSON.stringify(row.response_body).includes(order.id),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.response_body).toStrictEqual({
      data: [{ type: "flight-order", id: order.id, withheld: "office_not_allowed" }],
    });
    for (const secret of [order.passportNumber.slice(-4), "SAMPLE", "TESTA", "contact-"]) {
      expect(JSON.stringify(rows[0]?.response_body)).not.toContain(secret);
    }
  });

  it("[OBE-064 AC1] takes the owner office before the queuing office, and the queuing office of an order without owner", async () => {
    const agent = await staffSession(alphaId, "agent");
    const ownedByBeta = await stubOrder({ queuing: alphaOffice, owner: betaOffice });
    const queuedOnly = await stubOrder({ queuing: alphaSecondOffice, owner: null });

    expect(answer(await agent.lookup(ownedByBeta.recordLocator))).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    // The owner office decides: beta, which owns the order, finds it although it is queued at alpha's office.
    const betaAgent = await staffSession(betaId, "agent");
    const owned = await betaAgent.lookup(ownedByBeta.recordLocator);
    expect(answer(owned)).toEqual([200, undefined]);
    expect((owned.body.matches as JsonObject[]).map((match) => match["flightOrderId"])).toEqual([
      ownedByBeta.id,
    ]);
    const res = await agent.lookup(queuedOnly.recordLocator);
    expect(answer(res)).toEqual([200, undefined]);
    expect((res.body.matches as JsonObject[])[0]).toMatchObject({
      flightOrderId: queuedOnly.id,
      importable: true,
    });
  });

  it("answers 404 for a record locator Amadeus does not know, with the supplier's error", async () => {
    const agent = await staffSession(alphaId, "agent");

    const res = await agent.lookup("ZZZZ99");

    expect(answer(res)).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("consoleFindBookingByRecordLocator", res);
    expect(res.body.error.supplier).toBeTruthy();
  });

  it("shows an imported order as attached to its booking", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    const imported = await agent.import({ reference: order.recordLocator, pricing: { mode: "net" } });
    expect(answer(imported)).toEqual([201, undefined]);

    const res = await agent.lookup(order.recordLocator);

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleFindBookingByRecordLocator", res);
    expect((res.body.matches as JsonObject[])[0]).toMatchObject({
      flightOrderId: order.id,
      bookingId: imported.body.id,
      bookingReference: imported.body.reference,
      bookingStatus: "confirmed",
      importable: false,
    });
  });
});

describe("console.bookings.import", () => {
  it("imports the tenant's order as a booking with its children, at net, without payment, for the staff to issue", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    stub.clearRequests();

    const res = await agent.import({
      reference: order.recordLocator,
      pricing: { mode: "net" },
      tags: ["terminal"],
    });

    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleImportBooking", res);
    expect(res.headers["location"]).toBe(`/v1/console/bookings/${res.body.id}`);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.body).toMatchObject({
      status: "confirmed",
      channel: "import",
      recordLocator: order.recordLocator,
      amadeusOrderId: order.id,
      queuingOfficeId: alphaOffice,
      ownerOfficeId: alphaOffice,
      createdByStaffId: agent.member.staffId,
      paymentStatus: "not_applicable",
      payments: [],
      contactEmail: (order.data["contacts"] as JsonObject[])[0]?.["emailAddress"],
      ticketing: { status: "manual_review" },
      pricing: {
        pricingMode: "net",
        net: { amount: "98.47", currency: "EUR" },
        markup: { amount: "0.00", currency: "EUR" },
        selling: { amount: "98.47", currency: "EUR" },
        markupRuleId: null,
      },
      totals: { total: { amount: "98.47", currency: "EUR" } },
      tags: ["terminal"],
      travelers: [{ travelerId: "1", name: { lastName: "SAMPLE" } }],
      itineraries: [{ originCode: "MAD", destinationCode: "ORY" }],
    });
    // No Flight Create Orders, no issuance: the by-reference read and the complete order only.
    expect(
      stub
        .requests()
        .map((entry) => entry.operation)
        .filter((name) => name !== "oauth2Token"),
    ).toEqual(["getFlightOrderByReference", "getFlightOrder"]);
    const bookingId = res.body.id as string;
    const [row] = await bookingsOf("tenant_alpha", order.recordLocator);
    expect(row).toMatchObject({
      id: bookingId,
      channel: "import",
      pricing_mode: "net",
      ticketing_status: "manual_review",
    });
    // The passport is sealed: no plain column holds its number, only its last 4.
    const travelers = await inTenant("tenant_alpha", (trx) =>
      trx.selectFrom("booking_travelers").selectAll().where("booking_id", "=", bookingId).execute(),
    );
    expect(travelers).toHaveLength(1);
    expect(travelers[0]?.document_last4).toBe(order.passportNumber.slice(-4));
    expect(travelers[0]?.documents_ciphertext).not.toBeNull();
    expect(
      JSON.stringify({ ...row, travelers: travelers.map(({ documents_ciphertext: _c, ...rest }) => rest) }),
    ).not.toContain(order.passportNumber);
    // The import's two Amadeus calls are linked to the booking; the events and the staff action are written.
    expect(
      (await supplierRequestsOf("tenant_alpha", "console.bookings.import"))
        .filter((entry) => entry.booking_id === bookingId)
        .map((entry) => entry.amadeus_api),
    ).toEqual(["GetFlightOrderByRecordLocator", "FlightOrderManagement"]);
    const events = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("booking_events")
        .select(["type", "visible_to_customer"])
        .where("booking_id", "=", bookingId)
        .execute(),
    );
    expect(events).toEqual([{ type: "booking.imported", visible_to_customer: false }]);
    expect(await staffActionsOf("tenant_alpha", bookingId)).toEqual([
      expect.objectContaining({
        action: "booking.import",
        outcome: "succeeded",
        target_type: "booking",
        booking_id: bookingId,
        after: expect.objectContaining({ recordLocator: order.recordLocator, pricingMode: "net" }),
      }),
    ]);
  });

  it("[OBE-064 AC2] answers 409 ORDER_ALREADY_IMPORTED when the same order is imported again", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    const key = randomUUID();
    const first = await agent.import({ reference: order.recordLocator, pricing: { mode: "net" } }, key);
    expect(answer(first)).toEqual([201, undefined]);
    stub.clearRequests();

    // The same key replays the stored answer; another key is a second import of a known order.
    const replay = await agent.import({ reference: order.recordLocator, pricing: { mode: "net" } }, key);
    const second = await agent.import({ reference: order.recordLocator, pricing: { mode: "net" } });

    expect([replay.status, replay.body.id]).toEqual([201, first.body.id]);
    expect(answer(second)).toEqual([409, "ORDER_ALREADY_IMPORTED"]);
    expectResponseToMatch("consoleImportBooking", second);
    expect(second.body.error.details).toEqual({ bookingId: first.body.id, reference: first.body.reference });
    // The local index answers before Amadeus is asked.
    expect(amadeusCalls("getFlightOrderByReference")).toEqual([]);
    expect(await bookingsOf("tenant_alpha", order.recordLocator)).toHaveLength(1);
  });

  it("[OBE-064 AC2] answers 409 to one of two concurrent imports of the same order, which stays one booking", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });

    // Two keys at once: both may pass the local index before either commits, and whichever way they interleave, the
    // check in the recording transaction or the unique indexes keep one booking and refuse the other.
    const results = await Promise.all([
      agent.import({ reference: order.recordLocator, pricing: { mode: "net" } }),
      agent.import({ reference: order.recordLocator, pricing: { mode: "net" } }),
    ]);

    const [created, refused] = [...results].sort((a, b) => a.status - b.status);
    if (created === undefined || refused === undefined) {
      throw new Error("expected two answers");
    }
    expect([answer(created), answer(refused)]).toEqual([
      [201, undefined],
      [409, "ORDER_ALREADY_IMPORTED"],
    ]);
    for (const res of results) {
      expectResponseToMatch("consoleImportBooking", res);
    }
    expect(refused.body.error.details).toEqual({
      bookingId: created.body.id,
      reference: created.body.reference,
    });
    expect(await bookingsOf("tenant_alpha", order.recordLocator)).toHaveLength(1);
  });

  it("[OBE-064 AC1] [OF-09 AC3] tenant B on the shared account cannot import tenant A's PNR", async () => {
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    const betaOwner = await staffSession(betaId, "owner");

    const res = await betaOwner.import({
      reference: order.recordLocator,
      flightOrderId: order.id,
      pricing: { mode: "net" },
    });

    expect(answer(res)).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    expectResponseToMatch("consoleImportBooking", res);
    expect(await bookingsOf("tenant_beta", order.recordLocator)).toEqual([]);
    // Refused on the by-reference answer: the order itself is never read for beta.
    expect(amadeusCalls("getFlightOrder")).toEqual([]);
    expect(await staffActionsOf("tenant_beta", order.recordLocator)).toEqual([
      expect.objectContaining({
        action: "bookings.import",
        outcome: "denied",
        target_type: "record_locator",
      }),
    ]);
    // Alpha can still import it.
    const alphaAgent = await staffSession(alphaId, "agent");
    expect(
      answer(await alphaAgent.import({ reference: order.recordLocator, pricing: { mode: "net" } })),
    ).toEqual([201, undefined]);
  });

  it("prices with the tenant's markup rules by default, channel console", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });

    const res = await agent.import({ reference: order.recordLocator });

    expect(answer(res)).toEqual([201, undefined]);
    expect(res.body.pricing).toMatchObject({
      pricingMode: "markup_rules",
      net: { amount: "98.47" },
      markup: { amount: "9.85" },
      selling: { amount: "108.32" },
      markupRuleId: consoleRuleId,
      markupRuleName: "Console sales",
    });
  });

  it("sells at an override, attaches a customer, keeps a staff note and queues the confirmation", async () => {
    const admin = await staffSession(alphaId, "admin");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    const customerId = await newCustomer("tenant_alpha");

    const res = await admin.import({
      reference: order.recordLocator,
      customerId,
      contactEmail: "desk@example.com",
      pricing: { mode: "override", sellingTotal: { amount: "120.00", currency: "EUR" } },
      sendConfirmation: true,
      note: "Created in the GDS terminal by the night desk.",
      reason: "Attach terminal booking",
    });

    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleImportBooking", res);
    expect(res.body).toMatchObject({
      customerId,
      isGuest: false,
      contactEmail: "desk@example.com",
      pricing: { pricingMode: "override", markup: { amount: "21.53" }, selling: { amount: "120.00" } },
      notes: [{ text: "Created in the GDS terminal by the night desk.", visibleToCustomer: false }],
    });
    const bookingId = res.body.id as string;
    const notifications = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("notifications")
        .select(["template_key", "recipient", "dedupe_key"])
        .where("booking_id", "=", bookingId)
        .execute(),
    );
    expect(notifications).toEqual([
      {
        template_key: "booking.confirmed",
        recipient: "desk@example.com",
        dedupe_key: `booking.confirmed:${bookingId}`,
      },
    ]);
    expect(await staffActionsOf("tenant_alpha", bookingId)).toEqual([
      expect.objectContaining({ action: "booking.import", reason: "Attach terminal booking" }),
    ]);
  });

  it("imports an issued order as ticketed with its e-tickets", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    await stubFetch(
      `/v1/booking/flight-orders/${encodeURIComponent(order.id)}/issuance`,
      buildIssueRequest(["2"]),
    );

    const res = await agent.import({ reference: order.recordLocator, pricing: { mode: "net" } });

    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleImportBooking", res);
    expect(res.body).toMatchObject({ status: "ticketed", ticketing: { status: "issued" } });
    expect(res.body.tickets).toHaveLength(1);
    const [ticket] = res.body.tickets as JsonObject[];
    expect(ticket).toMatchObject({ documentType: "ETICKET", status: "ISSUED" });
    // booking.imported asks for the itinerary and the e-ticket receipt of the imported version (DOCUMENT_TRIGGERS).
    const documents = api.app.get<Queue>(getQueueToken(OTA_QUEUE.documents), { strict: false });
    const bookingId = res.body.id as string;
    for (const job of [
      { bookingId, kind: "itinerary", bookingVersion: 1 },
      { bookingId, kind: "e_ticket_receipt", bookingVersion: 1, ticketId: ticket?.["id"] as string },
    ] as const) {
      expect(await documents.getDeduplicationJobId(documentRenderKey(job))).not.toBe(null);
    }
  });

  it("imports an order whose every flight the airline cancelled as cancelled by the airline", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });
    stub.orders.cancelByAirline(order.id);

    const res = await agent.import({ reference: order.recordLocator, pricing: { mode: "net" } });

    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleImportBooking", res);
    expect(res.body).toMatchObject({ status: "cancelled", ticketing: { status: "not_applicable" } });
    expect(res.body.cancelledAt).not.toBeNull();
    const [row] = await bookingsOf("tenant_alpha", order.recordLocator);
    expect(row).toMatchObject({ status: "cancelled", cancelled_by: "airline" });
  });

  it("refuses an unknown or deleted customer, and an override without its selling total, before anything is written", async () => {
    const agent = await staffSession(alphaId, "agent");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });

    const unknown = await agent.import({ reference: order.recordLocator, customerId: newId("cus") });
    const deleted = await agent.import({
      reference: order.recordLocator,
      customerId: await newCustomer("tenant_alpha", "deleted"),
    });
    const override = await agent.import({ reference: order.recordLocator, pricing: { mode: "override" } });

    expect(answer(unknown)).toEqual([404, "NOT_FOUND"]);
    expect(answer(deleted)).toEqual([409, "CONFLICT"]);
    expect(deleted.body.error.details).toEqual({ reason: "customer_deleted" });
    expect(answer(override)).toEqual([400, "VALIDATION_FAILED"]);
    for (const res of [unknown, deleted, override]) {
      expectResponseToMatch("consoleImportBooking", res);
    }
    expect(amadeusCalls("getFlightOrderByReference")).toEqual([]);
    expect(await bookingsOf("tenant_alpha", order.recordLocator)).toEqual([]);
  });

  it("refuses the import to a viewer, whose role lacks bookings:write", async () => {
    const viewer = await staffSession(alphaId, "viewer");
    const order = await stubOrder({ queuing: alphaOffice, owner: alphaOffice });

    const res = await viewer.import({ reference: order.recordLocator, pricing: { mode: "net" } });

    expect(answer(res)).toEqual([403, "FORBIDDEN"]);
    expect(res.body.error.details).toMatchObject({ requiredPermission: "bookings:write" });
    expect(amadeusCalls("getFlightOrderByReference")).toEqual([]);
  });
});
