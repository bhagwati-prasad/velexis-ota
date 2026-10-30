// Office isolation across the console (OBE-075 step 3; ota/docs/scope.md OF-09 AC3, ADR-0012 office isolation, OADR-0011
// point 7, flows/console-operations.md §3 step 4 and §6): two OTAs on the shared Velexis test Amadeus account, each with
// an office of its own. A stub serves one set of credentials, so either OTA's calls could read every order of the
// account: only the OTA backend's office rule keeps them apart. For each OTA, the PNR import and lookup, the queue reads
// (console.queues.list and the raw console.amadeus.getQueue) and the raw order reads (by id and by record locator) of
// the other OTA's office are refused `403 OFFICE_NOT_ALLOWED`, audited as denied in the caller's own `staff_actions`,
// with nothing of the other OTA's order in the answer, the caller's supplier log or its bookings; the same calls for
// its own office are served. The raw shopping reads take no office: they always go out with the caller's.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does (both tenants in test on the one Velexis account, the stub; accounts and memberships). Staff sign
// in through the OTA admin's service key with portal tokens. The orders are created in the stub through its own HTTP
// API, as a GDS terminal would create them, with synthetic travellers and flights relative to now, each placed on a
// queue of its queuing office. The calls run in a `beforeAll` hook with a budget of its own; the tests read what they
// answered. Names and documents are made up per run.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import {
  buildOrderContact,
  buildOrderRequestInput,
  buildOrderTraveler,
  pricedFlightOffer,
} from "../../builders/bookings";
import { journeyAmadeusLimitsModule } from "../../helpers/amadeus-limits";
import { testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type TenantKey = "alpha" | "beta";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BOOKINGS = "/v1/console/bookings";
const RAW = "/v1/console/amadeus";
/** The queue the tenants' own orders are placed on, in their queuing office. */
const QUEUE = 63;
/**
 * The queue of the orders queued in one tenant's office but owned by the other's. Queue List entries name no office,
 * so an entry is the queue office's (raw-amadeus.service.ts, "Office isolation"): such an order, which Velexis never
 * makes (its client fills both offices from the creator's connection), would show on the queue it was put on. It is
 * kept off QUEUE, whose reads this file checks for the other tenant's orders.
 */
const OTHER_QUEUE = 64;

const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/** About forty calls, most of them to the stub; the bound only stops a run that hangs. */
const CALLS_TIMEOUT_MS = 90_000;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };

/** One OTA of the file: its platform id, schema, office and signed-in agent. */
interface Tenant {
  readonly key: TenantKey;
  readonly id: string;
  readonly schema: TenantSchema;
  readonly office: string;
  agent: AdminSession;
}

const tenants = {} as Record<TenantKey, Tenant>;

// ---- Platform rows -------------------------------------------------------------------------------------------------

async function insertAmadeusAccount(): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(stubCredentials.clientSecret, {
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
      client_id: stubCredentials.clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** An active test tenant on the shared Velexis test account (the stub) with an office of its own. */
async function insertTenant(key: TenantKey, office: string, amadeusAccountId: string): Promise<string> {
  const id = newId("ten");
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
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: "active",
    })
    .execute();
  return id;
}

interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
}

async function insertAgent(tenantId: string): Promise<Member> {
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
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role: "agent", status: "active" })
    .execute();
  return { accountId, staffId, tenantId };
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
    role: "agent",
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

/** An agent signed in through the OTA admin (its service key, the staff member's IP, the test environment). */
class AdminSession {
  readonly ip: string;
  readonly userAgent = `Mozilla/5.0 (OTA admin isolation ${randomBytes(3).toString("hex")})`;
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

  async open(): Promise<this> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
    this.accessToken = (res.body.session as { accessToken: string }).accessToken;
    return this;
  }

  get(path: string): Promise<Response> {
    return request(api.server).get(path).set(this.headers()).then();
  }

  post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return request(api.server)
      .post(path)
      .set({ ...this.headers(), ...headers })
      .send(body as object)
      .then();
  }
}

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

/** An order made outside Velexis: its id, record locator, and the traveller's last name and passport. */
interface StubOrder {
  readonly id: string;
  readonly recordLocator: string;
  readonly lastName: string;
  readonly passportNumber: string;
}

/**
 * An order of the stub of one adult with a last name and a passport of its own, its flight 10 days after now, held by
 * the offices given and placed on queue `queue` (QUEUE by default) of its queuing office.
 */
async function stubOrder(
  offices: { readonly queuing: string; readonly owner: string },
  queue = QUEUE,
): Promise<StubOrder> {
  const departure = new Date(Math.floor((Date.now() + 10 * DAY) / MINUTE) * MINUTE);
  const offer = pricedFlightOffer();
  for (const itinerary of offer["itineraries"] as JsonObject[]) {
    for (const segment of itinerary["segments"] as JsonObject[]) {
      (segment["departure"] as JsonObject)["at"] = local(departure);
      (segment["arrival"] as JsonObject)["at"] = local(new Date(departure.getTime() + 125 * MINUTE));
    }
  }
  const lastName = `ISO${randomBytes(4)
    .toString("hex")
    .toUpperCase()
    .replace(/[^A-Z]/g, "Q")}`;
  const traveler = buildOrderTraveler({ travelerId: "1", lastName });
  const built = buildCreateOrderRequest({
    ...buildOrderRequestInput({ flightOffers: [offer] }),
    travelers: [traveler],
    contacts: [buildOrderContact()],
    queue: { number: queue, category: 0 },
    offices,
  });
  const res = await fetch(`${stub.url}/v1/booking/flight-orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await stubToken()}`, "Content-Type": "application/vnd.amadeus+json" },
    body: JSON.stringify(built.body),
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

/** A Flight Offers Search POST body (getFlightOffersQuery), Madrid to Paris a month from now. */
const searchQuery = (): JsonObject => ({
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
});

// ---- What the calls answered ---------------------------------------------------------------------------------------

/** One call of the table: a tenant's agent asking for its own office's data or the other tenant's. */
interface Call {
  readonly operationId: OtaOperationId;
  readonly caller: TenantKey;
  readonly target: "own" | "other";
  readonly res: Response;
  /** The Amadeus operations the stub was asked for during the call (the token requests left out). */
  readonly amadeus: readonly string[];
  /** The other tenant's order or office the call named, for the checks that nothing of it was kept. */
  readonly order?: StubOrder;
}

const calls: Call[] = [];
/** The orders of each tenant's office, and one queued in the caller's office but owned by the other's. */
const orders = {} as Record<TenantKey, { readonly own: StubOrder; readonly ownedByOther: StubOrder }>;
/** Every row of each schema after the calls. */
const rowsOf = {} as Record<
  TenantKey,
  {
    readonly staffActions: Array<Record<string, unknown>>;
    readonly supplierRequests: Array<Record<string, unknown>>;
    readonly bookings: Array<Record<string, unknown>>;
  }
>;

const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];
const operationById = new Map(otaOperations.map((operation) => [operation.operationId, operation]));
const otherOf = (key: TenantKey): TenantKey => (key === "alpha" ? "beta" : "alpha");

/** Runs `send` with the stub's request log cleared first and keeps the call with the Amadeus operations it caused. */
async function record(
  operationId: OtaOperationId,
  caller: TenantKey,
  target: Call["target"],
  send: () => Promise<Response>,
  order?: StubOrder,
): Promise<Response> {
  stub.clearRequests();
  const res = await send();
  const amadeus = stub
    .requests()
    .map((entry) => String(entry.operation))
    .filter((operation) => operation !== "oauth2Token");
  calls.push({ operationId, caller, target, res, amadeus, ...(order === undefined ? {} : { order }) });
  return res;
}

const callsOf = (operationId: OtaOperationId, target: Call["target"]): Call[] =>
  calls.filter((entry) => entry.operationId === operationId && entry.target === target);

// Cloning the template, starting the stub and the API's graph, the sign-ins and compiling the response validators.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const operationId of [
    "consoleImportBooking",
    "consoleFindBookingByRecordLocator",
    "consoleListQueue",
    "consoleListQueueSnapshots",
    "consoleAmadeusGetQueue",
    "consoleAmadeusGetFlightOrder",
    "consoleAmadeusGetFlightOrderByReference",
    "consoleAmadeusSearchFlightOffers",
  ] as const) {
    for (const status of [200, 201, 403]) {
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
    applicationName: "ota-test-reader",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  stubCredentials = {
    clientId: `velexis-test-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  };
  stub = await startAmadeusStub({ credentials: stubCredentials });
  const amadeusAccountId = await insertAmadeusAccount();
  for (const key of ["alpha", "beta"] as const) {
    const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
    const id = await insertTenant(key, office, amadeusAccountId);
    const schema = `tenant_${key}` as TenantSchema;
    await tenantTx(tenantDb, schema, async (trx) => {
      await seedStorefrontSettings(trx, {
        name: `${key} Travel`,
        defaultCurrency: "EUR",
        defaultLocale: "en",
      });
      await seedDefaultMarkupRule(trx);
    });
    tenants[key] = { key, id, schema, office, agent: undefined as unknown as AdminSession };
  }
  // Both processes of a deployment share the account's and each tenant's Amadeus buckets: the file's calls must never
  // empty one (test/helpers/amadeus-limits.ts).
  api = await createTestApp({
    database: db,
    redis,
    imports: [journeyAmadeusLimitsModule()],
    env: { AMADEUS_BASE_URL_TEST: stub.url },
  });
  for (const tenant of Object.values(tenants)) {
    tenant.agent = await new AdminSession(await insertAgent(tenant.id)).open();
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

// Each tenant's agent asks for its own office's data and for the other tenant's, and the rows they left are read.
beforeAll(async () => {
  for (const key of ["alpha", "beta"] as const) {
    const own = tenants[key];
    const other = tenants[otherOf(key)];
    orders[key] = {
      own: await stubOrder({ queuing: own.office, owner: own.office }),
      // Queued in this tenant's office, owned by the other's: the owner office decides.
      ownedByOther: await stubOrder({ queuing: own.office, owner: other.office }, OTHER_QUEUE),
    };
  }
  for (const key of ["alpha", "beta"] as const) {
    const { agent, office } = tenants[key];
    const otherOffice = tenants[otherOf(key)].office;
    const mine = orders[key].own;
    const theirs = orders[otherOf(key)].own;
    const lookup = (order: StubOrder) =>
      agent.get(`${BOOKINGS}/by-record-locator?reference=${order.recordLocator}&originSystemCode=GDS`);
    const byReference = (order: StubOrder) =>
      agent.get(
        `${RAW}/v1/booking/flight-orders/by-reference?reference=${order.recordLocator}&originSystemCode=GDS`,
      );
    const importOf = (order: StubOrder) =>
      agent.post(
        `${BOOKINGS}/imports`,
        { reference: order.recordLocator, pricing: { mode: "net" } },
        { "Idempotency-Key": randomUUID() },
      );

    // The other tenant's office and orders: refused.
    await record("consoleFindBookingByRecordLocator", key, "other", () => lookup(theirs), theirs);
    await record("consoleImportBooking", key, "other", () => importOf(theirs), theirs);
    await record("consoleListQueue", key, "other", () =>
      agent.get(`/v1/console/queues/${QUEUE}?officeId=${otherOffice}`),
    );
    await record("consoleAmadeusGetQueue", key, "other", () =>
      agent.get(`${RAW}/office/queues/${QUEUE}?officeId=${otherOffice}`),
    );
    await record(
      "consoleAmadeusGetFlightOrder",
      key,
      "other",
      () => agent.get(`${RAW}/v1/booking/flight-orders/${theirs.id}`),
      theirs,
    );
    await record("consoleAmadeusGetFlightOrderByReference", key, "other", () => byReference(theirs), theirs);
    // An order on this tenant's queue that the other tenant's office owns: refused all the same.
    const owned = orders[key].ownedByOther;
    await record("consoleFindBookingByRecordLocator", key, "other", () => lookup(owned), owned);
    await record("consoleImportBooking", key, "other", () => importOf(owned), owned);
    await record(
      "consoleAmadeusGetFlightOrder",
      key,
      "other",
      () => agent.get(`${RAW}/v1/booking/flight-orders/${owned.id}`),
      owned,
    );
    await record("consoleAmadeusGetFlightOrderByReference", key, "other", () => byReference(owned), owned);

    // Its own office and orders: served.
    await record("consoleFindBookingByRecordLocator", key, "own", () => lookup(mine));
    await record("consoleAmadeusGetFlightOrder", key, "own", () =>
      agent.get(`${RAW}/v1/booking/flight-orders/${mine.id}`),
    );
    await record("consoleAmadeusGetFlightOrderByReference", key, "own", () => byReference(mine));
    await record("consoleListQueue", key, "own", () =>
      agent.get(`/v1/console/queues/${QUEUE}?officeId=${office}`),
    );
    await record("consoleAmadeusGetQueue", key, "own", () =>
      agent.get(`${RAW}/office/queues/${QUEUE}?officeId=${office}`),
    );
    await record("consoleListQueueSnapshots", key, "own", () =>
      agent.get(`/v1/console/queue-snapshots?queueId=${QUEUE}&include=items`),
    );
    await record("consoleListQueueSnapshots", key, "other", () =>
      agent.get(`/v1/console/queue-snapshots?officeId=${otherOffice}`),
    );
    await record("consoleAmadeusSearchFlightOffers", key, "own", () =>
      agent.post(`${RAW}/v2/shopping/flight-offers`, { amadeus: searchQuery() }),
    );
    await record("consoleImportBooking", key, "own", () => importOf(mine));
  }
  for (const key of ["alpha", "beta"] as const) {
    rowsOf[key] = await tenantTx(tenantDb, tenants[key].schema, async (trx) => ({
      staffActions: (await trx
        .selectFrom("staff_actions")
        .selectAll()
        .where("action", "!=", "staff.sign_in")
        .orderBy("created_at")
        .orderBy("id")
        .execute()) as Array<Record<string, unknown>>,
      supplierRequests: (await trx
        .selectFrom("supplier_requests")
        .select(["id", "operation", "office_id", "request_id", "response_body"])
        .execute()) as Array<Record<string, unknown>>,
      bookings: (await trx
        .selectFrom("bookings")
        .select(["id", "record_locator", "amadeus_order_id", "owner_office_id"])
        .execute()) as Array<Record<string, unknown>>,
    }));
  }
}, CALLS_TIMEOUT_MS);

/** The operations that name an office or an order of the account, which another tenant's must never reach. */
const OFFICE_BOUND: readonly OtaOperationId[] = [
  "consoleFindBookingByRecordLocator",
  "consoleImportBooking",
  "consoleListQueue",
  "consoleAmadeusGetQueue",
  "consoleAmadeusGetFlightOrder",
  "consoleAmadeusGetFlightOrderByReference",
];

describe("two OTAs on the shared Amadeus account", () => {
  it("[OBE-075 AC1] [OF-09 AC3] refuses each tenant the other's office: imports, PNR lookups, queue reads and raw order reads answer 403 OFFICE_NOT_ALLOWED", () => {
    for (const operationId of OFFICE_BOUND) {
      const refused = callsOf(operationId, "other");
      // Both tenants, each with the other's own order or office (and, for the order reads, an order on its own queue
      // that the other's office owns).
      expect([operationId, new Set(refused.map((entry) => entry.caller)).size]).toEqual([operationId, 2]);
      for (const entry of refused) {
        expect([operationId, entry.caller, ...answer(entry.res)]).toEqual([
          operationId,
          entry.caller,
          403,
          "OFFICE_NOT_ALLOWED",
        ]);
        expectResponseToMatch(operationId, entry.res);
        // Nothing of the order in the answer: not its traveller, not its passport.
        if (entry.order !== undefined) {
          const body = JSON.stringify(entry.res.body);
          expect(body).not.toContain(entry.order.lastName);
          expect(body).not.toContain(entry.order.passportNumber);
        }
      }
    }
  });

  it("[OBE-075 AC1] [OF-09 AC3] refuses another office's queue before any Amadeus call, and reads an order only to find its office", () => {
    for (const operationId of ["consoleListQueue", "consoleAmadeusGetQueue"] as const) {
      for (const entry of callsOf(operationId, "other")) {
        expect([operationId, entry.caller, entry.amadeus]).toEqual([operationId, entry.caller, []]);
      }
    }
    // A PNR import is refused on the by-reference answer: the complete order is never read for the caller.
    for (const entry of callsOf("consoleImportBooking", "other")) {
      expect([entry.caller, entry.amadeus]).toEqual([entry.caller, ["getFlightOrderByReference"]]);
    }
  });

  it("[OBE-075 AC1] [OF-09 AC3] serves each tenant its own office: the same calls for its own orders and queue succeed", () => {
    const served: ReadonlyArray<readonly [OtaOperationId, number]> = [
      ["consoleFindBookingByRecordLocator", 200],
      ["consoleImportBooking", 201],
      ["consoleListQueue", 200],
      ["consoleAmadeusGetQueue", 200],
      ["consoleAmadeusGetFlightOrder", 200],
      ["consoleAmadeusGetFlightOrderByReference", 200],
    ];
    for (const [operationId, status] of served) {
      const own = callsOf(operationId, "own");
      expect(own).toHaveLength(2);
      for (const entry of own) {
        expect([operationId, entry.caller, ...answer(entry.res)]).toEqual([
          operationId,
          entry.caller,
          status,
          undefined,
        ]);
        expectResponseToMatch(operationId, entry.res);
      }
    }
    // Each queue read shows the tenant's own order and never the other's, which sits on the same queue number of the
    // other office.
    for (const entry of callsOf("consoleAmadeusGetQueue", "own")) {
      const ids = (entry.res.body.amadeus.data as JsonObject[]).map((item) => String(item["id"]));
      const mine = orders[entry.caller].own.recordLocator;
      const theirs = orders[otherOf(entry.caller)].own.recordLocator;
      expect([entry.caller, ids.some((id) => id.startsWith(mine))]).toEqual([entry.caller, true]);
      expect([entry.caller, ids.some((id) => id.startsWith(theirs))]).toEqual([entry.caller, false]);
      expect(entry.res.body.call.officeId).toBe(tenants[entry.caller].office);
    }
  });

  it("[OBE-075 AC1] [OF-09 AC3] sends the raw shopping reads with the caller's own office, which no request can change", () => {
    for (const entry of callsOf("consoleAmadeusSearchFlightOffers", "own")) {
      expect([entry.caller, ...answer(entry.res)]).toEqual([entry.caller, 200, undefined]);
      expect([entry.caller, entry.res.body.call.officeId]).toEqual([
        entry.caller,
        tenants[entry.caller].office,
      ]);
      const row = rowsOf[entry.caller].supplierRequests.find(
        (candidate) => candidate["id"] === entry.res.body.call.supplierRequestId,
      );
      expect(row).toMatchObject({ office_id: tenants[entry.caller].office });
    }
  });

  it("[OBE-075 AC1] [OF-09 AC3] never lists the other tenant's queue snapshots", () => {
    for (const entry of callsOf("consoleListQueueSnapshots", "other")) {
      expect([entry.caller, ...answer(entry.res), entry.res.body.data]).toEqual([
        entry.caller,
        200,
        undefined,
        [],
      ]);
      expectResponseToMatch("consoleListQueueSnapshots", entry.res);
    }
    for (const entry of callsOf("consoleListQueueSnapshots", "own")) {
      const snapshots = entry.res.body.data as JsonObject[];
      expect(snapshots.length).toBeGreaterThan(0);
      expect([entry.caller, [...new Set(snapshots.map((snapshot) => snapshot["officeId"]))]]).toEqual([
        entry.caller,
        [tenants[entry.caller].office],
      ]);
      expect(JSON.stringify(snapshots)).not.toContain(orders[otherOf(entry.caller)].own.recordLocator);
    }
  });
});

describe("what the refused calls left", () => {
  it("[OBE-075 AC1] [OF-09 AC1] audits each refusal as denied in the caller's own staff_actions, and nothing in the other tenant's", () => {
    for (const key of ["alpha", "beta"] as const) {
      const refused = calls.filter(
        (entry) => entry.caller === key && entry.target === "other" && entry.res.status === 403,
      );
      const requestIds = new Set(refused.map((entry) => String(entry.res.headers["x-request-id"])));
      const denied = rowsOf[key].staffActions.filter((row) => requestIds.has(String(row["request_id"])));
      expect(refused).toHaveLength(10);
      expect(denied).toHaveLength(refused.length);
      // One row per refused call, under that call's request id, with the operation's SDK method as the action.
      for (const entry of refused) {
        const rows = denied.filter((row) => row["request_id"] === String(entry.res.headers["x-request-id"]));
        expect([entry.operationId, rows.map((row) => row["action"])]).toEqual([
          entry.operationId,
          [String(operationById.get(entry.operationId)?.sdkMethod).replace(/^console\./, "")],
        ]);
      }
      for (const row of denied) {
        expect(row).toMatchObject({
          outcome: "denied",
          actor_type: "staff",
          staff_id: tenants[key].agent.member.staffId,
          staff_role: "agent",
          ip_address: tenants[key].agent.ip,
          user_agent: tenants[key].agent.userAgent,
          before: null,
        });
      }
      // The other tenant's audit holds none of this tenant's calls.
      const elsewhere = rowsOf[otherOf(key)].staffActions.filter((row) =>
        requestIds.has(String(row["request_id"])),
      );
      expect(elsewhere).toEqual([]);
    }
  });

  it("[OBE-075 AC1] [OF-09 AC3] keeps nothing of the other tenant's orders: no booking, and a withheld body in the supplier log", () => {
    for (const key of ["alpha", "beta"] as const) {
      const foreign = [orders[otherOf(key)].own, orders[key].ownedByOther];
      const { bookings, supplierRequests, staffActions } = rowsOf[key];
      // The import of its own order made the tenant's one booking; the refused imports made none.
      expect(bookings.map((row) => row["record_locator"])).toEqual([orders[key].own.recordLocator]);
      expect(bookings[0]).toMatchObject({ owner_office_id: tenants[key].office });
      const stored = JSON.stringify([supplierRequests, staffActions]);
      for (const order of foreign) {
        expect([key, order.recordLocator, stored.includes(order.lastName)]).toEqual([
          key,
          order.recordLocator,
          false,
        ]);
        expect([key, order.recordLocator, stored.includes(order.passportNumber)]).toEqual([
          key,
          order.recordLocator,
          false,
        ]);
      }
      // Every supplier request of the tenant went out with its own office.
      expect([key, [...new Set(supplierRequests.map((row) => row["office_id"]))]]).toEqual([
        key,
        [tenants[key].office],
      ]);
    }
  });
});
