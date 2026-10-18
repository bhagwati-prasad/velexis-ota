// AmadeusClient against PostgreSQL 16, Redis 7 and the Amadeus stub (OBE-018; OADR-0001 points 6–11, flows/amadeus-
// connection-and-tokens.md §4–§6). The file clones the @velexis/testing template (tenant_alpha and tenant_beta
// provisioned), writes the platform rows of two tenants on the Velexis test account as the platform does (their
// `supplier_connections` with an office each, the account's client secret encrypted with the test KEK), and runs
// AmadeusModule inside the API's module graph against an in-process stub that accepts only that account's credentials.
//
// The module's client runs with the limits of limits.ts. Tests that need shorter timeouts (the stub's `timeout`
// scenario holds an answer for 30 s), roomier buckets (twelve calls in a row) or a clock that stands still (so a bucket
// does not refill between two calls) build a client of their own from the same graph's services, with other
// `AmadeusLimits` or a `FakeClock` for its buckets.
import { randomBytes } from "node:crypto";
import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { encryptValue, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  type Kysely,
  type PlatformDatabase,
  type Selectable,
  type TenantDatabase,
} from "@velexis/db";
import { AppError } from "@velexis/errors";
import { createTestDatabase, FakeClock, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import type { Redis } from "ioredis";
import { ClsService } from "nestjs-cls";
import { PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AmadeusClient,
  type QuoteAirOffersReply,
  type UpsellAirOffersRequest,
} from "../../../src/amadeus/amadeus.client";
import { AmadeusModule } from "../../../src/amadeus/amadeus.module";
import type { AmadeusCallContext } from "../../../src/amadeus/call-context";
import { ConnectionResolver } from "../../../src/amadeus/connection-resolver";
import { DEFAULT_AMADEUS_LIMITS, type AmadeusLimits } from "../../../src/amadeus/limits";
import { AmadeusRateLimitedError, AmadeusRateLimiter } from "../../../src/amadeus/rate-limiter";
import { SupplierRequestsRepository } from "../../../src/amadeus/supplier-requests.repository";
import { AMADEUS_FETCH, TokenProvider } from "../../../src/amadeus/token-provider";
import { PublicRoute } from "../../../src/common/auth/caller.guard";
import { Clock } from "../../../src/common/clock";
import { IdGenerator, newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { REDIS_CLIENT } from "../../../src/common/redis/redis.module";
import { TenantContext, type RequestTenant } from "../../../src/tenancy/tenant-context";
import { TenantTx } from "../../../src/tenancy/tenant-tx";
import { TenancyModule, type OtaPool } from "../../../src/tenancy/tenancy.module";
import { testKeyProvider } from "../../helpers/api-env";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type SupplierRequestRow = Selectable<TenantDatabase["supplier_requests"]>;

/** A passport number of the synthetic traveller: it must never be stored or logged in clear. */
const PASSPORT = "X93051746";
const EMAIL = "alex.tester@example.com";

/** One tenant of the file: its platform id, its office and its request context (tenant_alpha or tenant_beta). */
interface FileTenant {
  readonly id: string;
  readonly office: string;
  readonly context: RequestTenant;
}

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let accountId: string;
let alpha: FileTenant;
let beta: FileTenant;
let tenants: TenantContext;
let tx: TenantTx;
/** The module's client: the limits of limits.ts, the process clock. */
let client: AmadeusClient;

/** A random Amadeus office id (`^[A-Z0-9]{9}$`). */
const newOffice = (): string => `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;

/** Inserts the Velexis test account with `secret` encrypted as the platform encrypts it. */
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

/** Inserts the platform tenant of a provisioned test schema and its connection on the shared account. */
async function insertTenant(key: "alpha" | "beta"): Promise<FileTenant> {
  const id = newId("ten");
  const office = newOffice();
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
  return {
    id,
    office,
    context: {
      tenantId: id,
      key,
      schemaName: `tenant_${key}` as RequestTenant["schemaName"],
      environment: "test",
      caller: { type: "key", id: newId("key") },
      actor: { type: "system", id: null },
      requestId: `req-${key}-0001`,
    },
  };
}

/** The call context of `tenant` for `operation`. */
function callContext(tenant: FileTenant, extra: Partial<AmadeusCallContext> = {}): AmadeusCallContext {
  return {
    tenantId: tenant.id,
    environment: "test",
    operation: "flights.search",
    requestId: `req-${randomBytes(6).toString("hex")}`,
    ...extra,
  };
}

/** Runs `fn` as the tenant's request or job does. */
const as = <T>(tenant: FileTenant, fn: () => Promise<T>): Promise<T> => tenants.run(tenant.context, fn);

/** The tenant's `supplier_requests` rows of one request id, oldest first. */
function rowsOf(tenant: FileTenant, requestId: string): Promise<SupplierRequestRow[]> {
  return as(tenant, () =>
    tx.run((trx) =>
      trx
        .selectFrom("supplier_requests")
        .selectAll()
        .where("request_id", "=", requestId)
        .orderBy("id")
        .execute(),
    ),
  );
}

/**
 * A route that calls Amadeus for tenant alpha inside an HTTP request, as a use case will: the client takes
 * `X-Stub-Scenario` from the request itself. Public and bound to no operation, so it records the tenant itself.
 */
@Controller("__amadeus-probe")
@PublicRoute()
class AmadeusProbeController {
  constructor(
    private readonly amadeus: AmadeusClient,
    private readonly tenantContext: TenantContext,
  ) {}

  @Get("search")
  async search(): Promise<{ status: number; supplierRequestId: string | null }> {
    this.tenantContext.set(alpha.context);
    const { call } = await this.amadeus.getFlightOffers(callContext(alpha), { query: SEARCH });
    return { status: call.status, supplierRequestId: call.supplierRequestId };
  }
}

/** The AppError a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/** The stub's requests of one operation since the last `clearRequests()`. */
const requestsOf = (operation: string) =>
  stub.requests().filter((request) => request.operation === operation);

/** A client of the same graph with other limits, and buckets on `clock`. */
async function clientWith(
  limits: AmadeusLimits,
  clock: Clock | FakeClock = api.app.get(Clock),
): Promise<AmadeusClient> {
  const { app } = api;
  return new AmadeusClient(
    app.get(ConnectionResolver),
    app.get(TokenProvider),
    new AmadeusRateLimiter(app.get<Redis>(REDIS_CLIENT), clock, limits),
    app.get(SupplierRequestsRepository),
    app.get(TenantTx),
    app.get(TenantContext),
    app.get(IdGenerator),
    app.get(ClsService),
    await app.resolve(PinoLogger),
    app.get(AMADEUS_FETCH),
    app.get(ConfigService),
    limits,
  );
}

/** Every operation times out after 400 ms instead of 15 to 60 s; the retry still waits 300–800 ms. */
const FAST_TIMEOUTS: AmadeusLimits = {
  ...DEFAULT_AMADEUS_LIMITS,
  timeoutMs: Object.fromEntries(
    Object.keys(DEFAULT_AMADEUS_LIMITS.timeoutMs).map((name) => [name, 400]),
  ) as AmadeusLimits["timeoutMs"],
};

const SEARCH = {
  originLocationCode: "MAD",
  destinationLocationCode: "ORY",
  departureDate: "2027-01-15",
  adults: 1,
  max: 5,
};

/** Search, then price offer 2 as the booking flow does; the priced offer to book. */
async function pricedOffer(
  tenant: FileTenant,
): Promise<NonNullable<QuoteAirOffersReply["data"]["flightOffers"]>[number]> {
  return as(tenant, async () => {
    const search = await client.getFlightOffers(callContext(tenant), { query: SEARCH });
    const offer = search.body.data?.find((candidate) => candidate.id === "2") ?? search.body.data?.[0];
    if (offer === undefined) {
      throw new Error("the stub found no offer");
    }
    const priced = await client.quoteAirOffers(callContext(tenant, { operation: "flights.price" }), {
      body: { data: { type: "flight-offers-pricing", flightOffers: [offer] } },
    });
    const [first] = priced.body.data.flightOffers;
    if (first === undefined) {
      throw new Error("the stub priced no offer");
    }
    return first;
  });
}

// Cloning the template, starting the stub and building the API's module graph (Nest, pools, Redis, the vx:invalidate
// subscriber) take a few seconds alone and much longer on a busy 4-CPU CI runner: all of it happens once here, with its
// own timeout, and the tests only make calls.
beforeAll(async () => {
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  accountId = await insertAccount(clientId, secret);
  alpha = await insertTenant("alpha");
  beta = await insertTenant("beta");
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  api = await createTestApp({
    database: db,
    redis,
    imports: [AmadeusModule, TenancyModule.forApi()],
    controllers: [AmadeusProbeController],
    env: { AMADEUS_BASE_URL_TEST: stub.url },
  });
  tenants = api.app.get(TenantContext);
  tx = api.app.get(TenantTx);
  client = api.app.get(AmadeusClient);
}, 120_000);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

describe("a call", () => {
  it("reaches the stub with the tenant's credentials and writes one row in the tenant's schema only", async () => {
    const context = callContext(alpha);

    const result = await as(alpha, () => client.getFlightOffers(context, { query: SEARCH }));

    expect(result.body.data?.length).toBeGreaterThan(0);
    expect(result.call).toMatchObject({ status: 200, officeId: alpha.office, attempts: 1 });
    expect(await rowsOf(alpha, context.requestId)).toEqual([
      expect.objectContaining({
        id: result.call.supplierRequestId,
        environment: "test",
        provider: "amadeus",
        operation: "flights.search",
        amadeus_api: "FlightOffersSearch",
        amadeus_operation_id: "getFlightOffers",
        http_method: "GET",
        path: "/v2/shopping/flight-offers?originLocationCode=MAD&destinationLocationCode=ORY&departureDate=2027-01-15&adults=1&max=5",
        office_id: alpha.office,
        http_status: 200,
        outcome: "success",
        error_codes: [],
        redacted: true,
        truncated: false,
        request_body: SEARCH,
        response_body: expect.objectContaining({ data: expect.any(Array) }),
      }),
    ]);
    // Tenant isolation: the other tenant's schema has no row of the call.
    expect(await rowsOf(beta, context.requestId)).toEqual([]);
  });

  it("reaches the stub through each of the 12 operations, with one row per call", async () => {
    // The stub validates every request against its specification, so this proves the methods, paths, query
    // encodings, `X-HTTP-Method-Override` and bodies of the client, not only its fake `fetch` (amadeus.client.test.ts).
    const offer = await pricedOffer(alpha);
    const requestIds: string[] = [];
    const ctx = (operation: string): AmadeusCallContext => {
      const context = callContext(alpha, { operation });
      requestIds.push(context.requestId);
      return context;
    };
    // Twelve calls in a row are more than the tenant's burst of 10: this client gets roomy buckets of its own (on the
    // same keys, emptied before and after, so the tests after it start with full buckets).
    const roomy = await clientWith({
      ...DEFAULT_AMADEUS_LIMITS,
      credentialBucket: { ratePerSecond: 100, burst: 100 },
      tenantBucket: { ratePerSecond: 100, burst: 100 },
    });
    const bucketKeys = [
      redisKeys.amadeusCredentialBucket(accountId, "test").key,
      redisKeys.amadeusTenantBucket(alpha.id, "test").key,
    ];
    await redis.client.del(...bucketKeys);
    stub.clearRequests();

    const answers = await as(alpha, async () => {
      const searched = await roomy.searchFlightOffers(ctx("flights.search"), {
        body: {
          originDestinations: [
            {
              id: "1",
              originLocationCode: "MAD",
              destinationLocationCode: "ORY",
              departureDateTimeRange: { date: "2027-01-15" },
            },
          ],
          travelers: [{ id: "1", travelerType: "ADULT" }],
          sources: ["GDS"],
        },
      });
      const listed = await roomy.getFlightOffers(ctx("flights.search"), { query: SEARCH });
      const availability = await roomy.searchFlightAvailabilities(ctx("flights.availability"), {
        body: {
          originDestinations: [
            {
              id: "1",
              originLocationCode: "MAD",
              destinationLocationCode: "PAR",
              departureDateTime: { date: "2027-01-15", time: "06:00:00" },
            },
          ],
          travelers: [{ id: "1", travelerType: "ADULT" }],
          sources: ["GDS"],
        },
      });
      const searchOffer = listed.body.data?.find((candidate) => candidate.id === "2");
      if (searchOffer === undefined) {
        throw new Error("the stub found no offer 2");
      }
      // The specifications type a flight offer each their own way (Flight Offers Search knows more amenity types than
      // Branded Fares Upsell): the shopping module converts, this test hands the stub's offer back as it came.
      const upsellOffer =
        searchOffer as unknown as UpsellAirOffersRequest["body"]["data"]["flightOffers"][number];
      const upsold = await roomy.upsellAirOffers(ctx("flights.upsell"), {
        body: { data: { type: "flight-offers-upselling", flightOffers: [upsellOffer] } },
      });
      const priced = await roomy.quoteAirOffers(ctx("flights.price"), {
        body: { data: { type: "flight-offers-pricing", flightOffers: [offer] } },
        query: { include: ["bags"] },
      });
      const created = await roomy.createFlightOrders(ctx("bookings.create"), {
        body: {
          data: {
            type: "flight-order",
            flightOffers: [offer],
            travelers: [
              {
                id: "1",
                dateOfBirth: "1990-01-01",
                name: { firstName: "ALEX", lastName: "TESTER" },
                gender: "MALE",
              },
            ],
            automatedProcess: [{ code: "IMMEDIATE", queue: { number: "50", category: "0" } }],
          },
        },
      });
      const order = created.body.data;
      const flightOrderId = order.id ?? "";
      const reference = order.associatedRecords?.[0]?.reference ?? "";
      const got = await roomy.getFlightOrder(ctx("bookings.sync"), { flightOrderId });
      const byReference = await roomy.getFlightOrderByReference(ctx("console.bookings.import"), {
        query: { reference, originSystemCode: "GDS" },
      });
      const patched = await roomy.patchFlightOrder(ctx("console.bookings.patch"), {
        flightOrderId,
        body: {
          data: {
            type: "flight-order",
            flightOffers: order.flightOffers,
            remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: "VELEXIS CHANGED" }] },
          },
        },
      });
      const issued = await roomy.issueFlightOrder(ctx("bookings.issue"), {
        flightOrderId,
        body: {
          data: {
            formOfPayments: [
              { other: { method: "CASH", flightOfferIds: [order.flightOffers[0]?.id ?? ""] } },
            ],
          },
        },
      });
      const queue = await roomy.listQueue(ctx("console.queues.list"), { queueId: 50 });
      const cancelled = await roomy.cancelFlightOrder(ctx("bookings.cancel"), { flightOrderId });
      return [
        searched,
        listed,
        availability,
        upsold,
        priced,
        created,
        got,
        byReference,
        patched,
        issued,
        queue,
        cancelled,
      ];
    }).finally(() => redis.client.del(...bucketKeys));

    expect(answers.map((answer) => answer.call.status)).toEqual([
      200, 200, 200, 200, 200, 201, 200, 200, 200, 200, 200, 204,
    ]);
    expect(stub.requests().map((sent) => [sent.operation, sent.status])).toEqual([
      ["searchFlightOffers", 200],
      ["getFlightOffers", 200],
      ["searchFlightAvailabilities", 200],
      ["upsellAirOffers", 200],
      ["quoteAirOffers", 200],
      ["createFlightOrders", 201],
      ["getFlightOrder", 200],
      ["getFlightOrderByReference", 200],
      ["patchFlightOrder", 200],
      ["issueFlightOrder", 200],
      ["listQueue", 200],
      ["cancelFlightOrder", 204],
    ]);
    const rows = await Promise.all(requestIds.map((requestId) => rowsOf(alpha, requestId)));
    expect(
      rows.map((own) => own.map((row) => [row.amadeus_operation_id, row.outcome, row.office_id])),
    ).toEqual(
      [
        "searchFlightOffers",
        "getFlightOffers",
        "searchFlightAvailabilities",
        "upsellAirOffers",
        "quoteAirOffers",
        "createFligtOrders",
        "getFlightOrder",
        "getFlightOrder",
        "patchFlightOrder",
        "issueFlightOrder",
        "GET/office/queues/{queue-id}",
        "cancelFlightOrder",
      ].map((operationId) => [[operationId, "success", alpha.office]]),
    );
  });

  it("writes its row in a transaction of its own, which the caller's rollback does not undo", async () => {
    const context = callContext(alpha);

    await expect(
      as(alpha, () =>
        tx.run(async () => {
          await client.getFlightOffers(context, { query: SEARCH });
          throw new Error("the use case fails after the call");
        }),
      ),
    ).rejects.toThrow("the use case fails after the call");

    expect(await rowsOf(alpha, context.requestId)).toHaveLength(1);
  });

  it("refuses another tenant's office with 403 before any call", async () => {
    stub.clearRequests();
    const context = callContext(alpha, { operation: "console.amadeus.listQueue" });

    const error = await rejection(
      as(alpha, () => client.listQueue(context, { queueId: 50, query: { officeId: beta.office } })),
    );
    const own = await as(alpha, () => client.listQueue(callContext(alpha), { queueId: 50 }));

    expect([error.status, error.code]).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    expect(await rowsOf(alpha, context.requestId)).toEqual([]);
    expect(requestsOf("listQueue")).toEqual([
      expect.objectContaining({ query: { officeId: alpha.office }, status: 200 }),
    ]);
    expect(own.call.officeId).toBe(alpha.office);
  });
});

describe("X-Stub-Scenario", () => {
  it("is forwarded from the API request to the stub outside production", async () => {
    stub.clearRequests();

    const failing = await request(api.server)
      .get("/__amadeus-probe/search")
      .set("X-Stub-Scenario", "server-error");
    const passing = await request(api.server).get("/__amadeus-probe/search");

    expect([failing.status, failing.body.error?.code]).toEqual([502, "SUPPLIER_ERROR"]);
    expect(failing.body.error).not.toHaveProperty("supplier");
    expect([passing.status, passing.body.status]).toEqual([200, 200]);
    expect(requestsOf("getFlightOffers").map((sent) => [sent.scenario, sent.status])).toEqual([
      ["server-error", 500],
      ["server-error", 500],
      ["success", 200],
    ]);
  });
});

describe("timeouts and retries", () => {
  it("retries a read once after the stub's `timeout`, then answers 504 SUPPLIER_TIMEOUT [OBE-018 AC1]", async () => {
    const fast = await clientWith(FAST_TIMEOUTS);
    const context = callContext(alpha, { stubScenario: "timeout" });
    stub.clearRequests();

    const error = await rejection(as(alpha, () => fast.getFlightOffers(context, { query: SEARCH })));

    expect([error.status, error.code]).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(requestsOf("getFlightOffers")).toEqual([
      expect.objectContaining({ scenario: "timeout" }),
      expect.objectContaining({ scenario: "timeout" }),
    ]);
    expect((await rowsOf(alpha, context.requestId)).map((row) => [row.http_status, row.outcome])).toEqual([
      [null, "timeout"],
      [null, "timeout"],
    ]);
  });

  it("never retries createFlightOrders after the stub's `timeout` [OBE-018 AC1]", async () => {
    const offer = await pricedOffer(alpha);
    const fast = await clientWith(FAST_TIMEOUTS);
    const context = callContext(alpha, { operation: "bookings.create", stubScenario: "timeout" });
    stub.clearRequests();

    const error = await rejection(
      as(alpha, () =>
        fast.createFlightOrders(context, {
          body: {
            data: {
              type: "flight-order",
              flightOffers: [offer],
              travelers: [
                {
                  id: "1",
                  dateOfBirth: "1990-01-01",
                  name: { firstName: "ALEX", lastName: "TESTER" },
                  gender: "MALE",
                },
              ],
            },
          },
        }),
      ),
    );

    expect([error.status, error.code]).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(requestsOf("createFlightOrders")).toHaveLength(1);
    expect(await rowsOf(alpha, context.requestId)).toEqual([
      expect.objectContaining({
        amadeus_operation_id: "createFligtOrders",
        outcome: "timeout",
        http_status: null,
      }),
    ]);
  });

  it("retries a read once after a server error and maps the second one", async () => {
    const context = callContext(beta, { stubScenario: "server-error" });
    stub.clearRequests();

    const error = await rejection(
      as(beta, () => client.getFlightOrder(context, { flightOrderId: "eJzTd9f3NjIJdgMADeQCtg" })),
    );

    expect([error.status, error.code, error.supplier]).toEqual([
      502,
      "SUPPLIER_ERROR",
      expect.objectContaining({ provider: "amadeus", status: 500, code: 141 }),
    ]);
    expect(requestsOf("getFlightOrder")).toHaveLength(2);
    expect((await rowsOf(beta, context.requestId)).map((row) => [row.http_status, row.error_codes])).toEqual([
      [500, [141]],
      [500, [141]],
    ]);
  });
});

describe("redaction", () => {
  it("stores a request with a passport number masked, and logs the call without a body [OBE-018 AC2]", async () => {
    const offer = await pricedOffer(beta);
    const context = callContext(beta, { operation: "bookings.create" });

    const created = await as(beta, () =>
      client.createFlightOrders(context, {
        body: {
          data: {
            type: "flight-order",
            flightOffers: [offer],
            travelers: [
              {
                id: "1",
                dateOfBirth: "1990-01-01",
                name: { firstName: "ALEX", lastName: "TESTER" },
                gender: "MALE",
                contact: {
                  emailAddress: EMAIL,
                  phones: [{ deviceType: "MOBILE", countryCallingCode: "44", number: "7700900123" }],
                },
                documents: [
                  {
                    documentType: "PASSPORT",
                    number: PASSPORT,
                    expiryDate: "2030-04-14",
                    issuanceCountry: "GB",
                    nationality: "GB",
                    holder: true,
                    birthPlace: "EXAMPLE CITY",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(created.call).toMatchObject({ status: 201, officeId: beta.office });
    const [row] = await rowsOf(beta, context.requestId);
    const stored = JSON.stringify([row?.request_body, row?.response_body]);
    expect(row).toMatchObject({
      amadeus_api: "FlightCreateOrders",
      http_status: 201,
      outcome: "success",
      office_id: beta.office,
      request_body: {
        data: {
          queuingOfficeId: beta.office,
          ownerOfficeId: beta.office,
          travelers: [
            {
              documents: [{ documentType: "PASSPORT", number: PASSPORT.slice(-4), expiryDate: "2030-04-14" }],
              contact: { emailAddress: "a***@example.com", phones: [{ number: "******0123" }] },
            },
          ],
        },
      },
    });
    expect(stored).not.toContain(PASSPORT);
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain("EXAMPLE CITY");

    const lines = api.sink.records().filter((line) => line["msg"] === "amadeus.call");
    const line = lines.find((candidate) => candidate["requestId"] === context.requestId);
    expect(line).toMatchObject({
      tenantId: beta.id,
      amadeusOperation: "createFlightOrders",
      status: 201,
      outcome: "success",
      supplierRequestId: row?.id,
    });
    for (const field of ["body", "requestBody", "responseBody", "req", "res"]) {
      expect(line).not.toHaveProperty(field);
    }
    expect(JSON.stringify(line)).not.toContain("ALEX");
    expect(api.sink.text()).not.toContain(PASSPORT);
    expect(api.sink.text()).not.toContain(EMAIL);
  });
});

describe("the buckets", () => {
  it("answer 429 for an empty tenant bucket without calling the stub [OBE-018 AC3]", async () => {
    const credentialKey = redisKeys.amadeusCredentialBucket(accountId, "test").key;
    const tenantKey = redisKeys.amadeusTenantBucket(beta.id, "test").key;
    await redis.client.del(credentialKey, tenantKey);
    // The buckets' clock stands still: no token comes back between the calls, however long they take.
    const clock = new FakeClock(new Date());
    const pinned = await clientWith(DEFAULT_AMADEUS_LIMITS, clock);
    try {
      for (let call = 0; call < 10; call += 1) {
        await as(beta, () => pinned.getFlightOffers(callContext(beta), { query: SEARCH }));
      }
      const before = stub.requests().length;
      const context = callContext(beta);

      const error = await rejection(as(beta, () => pinned.getFlightOffers(context, { query: SEARCH })));

      expect([error.status, error.code, error.details]).toEqual([
        429,
        "RATE_LIMITED",
        { retryAfterSeconds: 1 },
      ]);
      expect(error.cause).toEqual(new AmadeusRateLimitedError("tenant", 200));
      expect(stub.requests()).toHaveLength(before);
      expect(await rowsOf(beta, context.requestId)).toEqual([]);

      // 200 ms later the tenant has one token again.
      clock.advance(200);
      await as(beta, () => pinned.getFlightOffers(callContext(beta), { query: SEARCH }));
      expect(stub.requests()).toHaveLength(before + 1);
    } finally {
      await redis.client.del(credentialKey, tenantKey);
    }
  });

  it("share the credential set's bucket between tenants, and take nothing from a bucket when the other is empty", async () => {
    const clock = new FakeClock(new Date());
    const limiter = new AmadeusRateLimiter(api.app.get<Redis>(REDIS_CLIENT), clock);
    const credId = newId("ama");
    const [first, second, third] = [newId("ten"), newId("ten"), newId("ten")];

    for (const tenantId of [first, second]) {
      for (let take = 0; take < 10; take += 1) {
        await limiter.take({ credId, tenantId, environment: "test" });
      }
    }
    const shared = await rejection(limiter.take({ credId, tenantId: third, environment: "test" }));

    expect([shared.code, (shared.cause as AmadeusRateLimitedError).bucket]).toEqual([
      "RATE_LIMITED",
      "credential",
    ]);
    expect(await redis.client.exists(redisKeys.amadeusTenantBucket(third, "test").key)).toBe(0);
    expect(await redis.client.hget(redisKeys.amadeusCredentialBucket(credId, "test").key, "tokens")).toBe(
      "0",
    );
    expect(await redis.client.pttl(redisKeys.amadeusCredentialBucket(credId, "test").key)).toBeGreaterThan(
      1000,
    );

    // 50 ms refill one credential token (20 per second): the third tenant's first call passes.
    clock.advance(50);
    await limiter.take({ credId, tenantId: third, environment: "test" });
    expect(Number(await redis.client.hget(redisKeys.amadeusTenantBucket(third, "test").key, "tokens"))).toBe(
      9,
    );
  });
});
