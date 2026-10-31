// console.settings.markupRules.* and console.settings.feeRules.* through the API's whole pipeline (OBE-069; api-changes
// part 2 §2.1 and §2.2, OADR-0005 points 3, 6 and 8, OF-10 AC1), against PostgreSQL 16, Redis 7 and the Amadeus stub:
// the rows with If-Match and ETag, the list's order, filter and cursor, the default rule, the history a delete keeps,
// the warnings, the permissions, the staff_actions rows, the tenant isolation, and the next search and the next pricing
// after a change, while the offers and priced offers stored before keep their prices.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha and beta in test on the Velexis test Amadeus account (a connection with an office each),
// accounts and memberships of the roles used, a secret test key of alpha for the searches. Staff sign in through the OTA
// admin's service key with portal tokens, as console-access.int.test.ts does, each admin client with an end-user IP
// address of its own. The settings rows and the default markup rule (0 %) are seeded as provisioning seeds them. The
// stub answers its five-offer Madrid–Paris fixture (net 92.15, 98.47, 109.32, 131.86 and 558.94 EUR) for every search
// and echoes the posted offers when pricing. Each search asks for another day, so that no search joins an earlier
// identical one (the 30-second single flight of OADR-0002 point 2). Every answer is checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { Money } from "../../../src/pricing/pricing.types";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { journeyAmadeusLimitsModule } from "../../helpers/amadeus-limits";
import { newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "finance" | "viewer";
type Schema = "tenant_alpha" | "tenant_beta";
type Json = Record<string, unknown>;

const MARKUP = "/v1/console/settings/markup-rules";
const FEES = "/v1/console/settings/fee-rules";

/** The net grand totals of the stub's search fixture, cheapest first. */
const NETS = Object.freeze(["92.15", "98.47", "109.32", "131.86", "558.94"]);
/** The totals of the fixture with a markup of `percent` % of the net, rounded half-up to cents. */
const withMarkup = (percent: string): string[] =>
  NETS.map((net) => new Money(net).times(new Money(percent).div(100).plus(1)).toFixed(2));

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
let alphaSk: string;
/** The seeded default markup rule of alpha. */
let alphaDefault: string;

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one end user. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
};

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A portal token in the platform's format (PADR-0007 item 1): `ptk_` and 43 random base62 characters. */
function newPortalToken(): string {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  return token;
}

/** Inserts the Velexis test Amadeus account with `secret` encrypted as the platform encrypts it. */
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

/** Inserts an active test tenant of a provisioned test schema and its connection on the shared account. */
async function insertTenant(key: "alpha" | "beta"): Promise<string> {
  const tenantId = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenantId,
      key,
      name: `${key} Travel`,
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/London",
      storefront_environment: "test",
    })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: tenantId,
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
  return tenantId;
}

/** Issues a secret test key of a tenant as the platform does. */
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

/** A portal account and its membership in one tenant. */
interface Member {
  readonly accountId: string;
  readonly staffId: string;
}

/** Inserts an active account with MFA and its membership with `role` in `tenantId`. */
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
      time_zone: "Europe/London",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId };
}

/** A staff member signed in through the OTA admin: their calls with its admin client's headers. */
interface Staff {
  readonly member: Member;
  readonly get: (path: string) => request.Test;
  readonly post: (path: string, body: unknown, idempotencyKey?: string) => request.Test;
  readonly patch: (path: string, body: unknown, ifMatch?: string) => request.Test;
  readonly delete: (path: string, ifMatch?: string) => request.Test;
}

/** Signs a new member with `role` in through a new admin client (its own end-user IP); fails unless it answers 200. */
async function signIn(tenantId: string, role: Role): Promise<Staff> {
  const member = await insertMember(tenantId, role);
  const portalToken = newPortalToken();
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId,
    membershipId: member.staffId,
    role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(
    await redis.client.set(redisKeys.portalToken(sha256Hex(portalToken)).key, value, "EX", 60, "NX"),
  ).toBe("OK");
  const headers = {
    "X-Api-Key": testApiCredentials().serviceKey,
    "X-Velexis-End-User-IP": newIp(),
    "X-Velexis-End-User-Agent": `Mozilla/5.0 (OTA admin pricing rules test ${randomBytes(3).toString("hex")})`,
    "X-Velexis-Environment": "test",
  };
  const res = await request(api.server)
    .post("/v1/console/auth/sign-in")
    .set({ ...headers, "Idempotency-Key": randomUUID() })
    .send({ grantType: "portal_token", portalToken });
  expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
  const authorization = `Bearer ${(res.body.session as { accessToken: string }).accessToken}`;
  const withMatch = (req: request.Test, ifMatch: string | undefined) =>
    ifMatch === undefined ? req : req.set("If-Match", ifMatch);
  return {
    member,
    get: (path) => request(api.server).get(path).set(headers).set("Authorization", authorization),
    post: (path, body, idempotencyKey = randomUUID()) =>
      request(api.server)
        .post(path)
        .set(headers)
        .set({ Authorization: authorization, "Idempotency-Key": idempotencyKey })
        .send(body as object),
    patch: (path, body, ifMatch) =>
      withMatch(
        request(api.server)
          .patch(path)
          .set(headers)
          .set("Authorization", authorization)
          .send(body as object),
        ifMatch,
      ),
    delete: (path, ifMatch) =>
      withMatch(request(api.server).delete(path).set(headers).set("Authorization", authorization), ifMatch),
  };
}

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The staff_actions rows of `staffId` in `schema`, oldest first. */
async function staffActions(schema: Schema, staffId: string): Promise<Json[]> {
  return tenantTx(tenantDb, schema as TenantSchema, (trx) =>
    trx
      .selectFrom("staff_actions")
      .selectAll()
      .where("staff_id", "=", staffId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  ) as Promise<Json[]>;
}

/* ------------------------------------------------------------------------------------------------
 * Searches and pricing with alpha's secret key
 * ---------------------------------------------------------------------------------------------- */

let searchDay = 0;
/** A departure day of its own for every search, weeks ahead of today. */
function nextDepartureDate(): string {
  searchDay += 1;
  return new Date(Date.now() + (30 + searchDay) * 86_400_000).toISOString().slice(0, 10);
}

/** A completed one-way Madrid → Paris Orly search of alpha for one adult; its id. */
async function search(): Promise<string> {
  const res = await request(api.server)
    .post("/v1/flight-searches")
    .set({ "X-Api-Key": alphaSk, "Idempotency-Key": randomUUID() })
    .send({
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "ORY",
      departureDate: nextDepartureDate(),
      adults: 1,
    });
  expect([res.status, res.body.status]).toEqual([201, "completed"]);
  expectResponseToMatch("createFlightSearch", res);
  return (res.body as { id: string }).id;
}

/** The totals of a search's offers, cheapest first, as flights.listResults answers them now. */
async function totalsOf(searchId: string): Promise<string[]> {
  const res = await request(api.server)
    .get(`/v1/flight-searches/${searchId}/offers?limit=5&sort=price`)
    .set("X-Api-Key", alphaSk);
  expect(res.status).toBe(200);
  expectResponseToMatch("listFlightSearchResults", res);
  return (res.body as { data: Array<{ price: { total: { amount: string } } }> }).data.map(
    (offer) => offer.price.total.amount,
  );
}

/**
 * The last ticketing day of the offers priced here, 60 days ahead: the stub echoes the posted offers, whose fixture
 * date would bound a priced offer's expiry (OADR-0002 point 3), so the stored offers get this date instead and the
 * tests never depend on today.
 */
const LAST_TICKETING_DATE = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);

/** Prices the cheapest offer of a new search of alpha; the priced offer's id and fee total. */
async function priceCheapest(): Promise<{ id: string; fees: string }> {
  const searchId = await search();
  const offer = await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
    await trx
      .updateTable("flight_offers")
      .set({
        payload: sql`jsonb_set(payload, '{lastTicketingDate}', to_jsonb(${LAST_TICKETING_DATE}::text))`,
        last_ticketing_date: LAST_TICKETING_DATE,
      })
      .where("search_id", "=", searchId)
      .execute();
    return await trx
      .selectFrom("flight_offers")
      .select("id")
      .where("search_id", "=", searchId)
      .orderBy("selling_total")
      .executeTakeFirstOrThrow();
  });
  const res = await request(api.server)
    .post("/v1/priced-offers")
    .set({ "X-Api-Key": alphaSk, "Idempotency-Key": randomUUID() })
    .send({ offerIds: [offer.id] });
  expect(res.status).toBe(201);
  expectResponseToMatch("priceFlightOffers", res);
  const body = res.body as { id: string; price: { fees: { amount: string } } };
  return { id: body.id, fees: body.price.fees.amount };
}

/** The fee total of a stored priced offer, as flights.getPricedOffer answers it now. */
async function pricedFees(id: string): Promise<string> {
  const res = await request(api.server).get(`/v1/priced-offers/${id}`).set("X-Api-Key", alphaSk);
  expect(res.status).toBe(200);
  expectResponseToMatch("getPricedOffer", res);
  return (res.body as { price: { fees: { amount: string } } }).price.fees.amount;
}

/* ------------------------------------------------------------------------------------------------
 * Setup
 * ---------------------------------------------------------------------------------------------- */

/** A markup rule's body for console.settings.markupRules.create. */
const markupBody = (overrides: Json = {}): Json => ({
  name: "Ten percent",
  scope: {},
  calculation: "percentage",
  percentage: "10.0000",
  priority: 10,
  ...overrides,
});

/** A fee rule's body for console.settings.feeRules.create. */
const feeBody = (overrides: Json = {}): Json => ({
  name: "Service fee",
  label: "Service fee",
  feeType: "booking_service",
  scope: {},
  calculation: "fixed",
  fixed: { amount: "10.00", currency: "EUR" },
  ...overrides,
});

// Cloning the template, starting the stub and building the API's module graph (Nest, pools, Redis, the OTA document's
// validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its
// own budget, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations (the FlightSearch, FlightOffer and PricedOffer schemas are large)
  // compile on their first check: here, with every status the tests below check, instead of inside a test's budget.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["createFlightSearch", [201]],
    ["listFlightSearchResults", [200]],
    ["priceFlightOffers", [201]],
    ["getPricedOffer", [200]],
    ["consoleListMarkupRules", [200, 400, 403]],
    ["consoleCreateMarkupRule", [201, 400, 403, 409]],
    ["consoleGetMarkupRule", [200, 404]],
    ["consoleUpdateMarkupRule", [200, 400, 409, 412]],
    ["consoleDeleteMarkupRule", [204, 409, 412]],
    ["consoleListFeeRules", [200]],
    ["consoleCreateFeeRule", [201, 400, 403]],
    ["consoleGetFeeRule", [200, 404]],
    ["consoleUpdateFeeRule", [200, 412]],
    ["consoleDeleteFeeRule", [204]],
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
  amadeusAccountId = await insertAmadeusAccount(clientId, secret);
  alphaId = await insertTenant("alpha");
  betaId = await insertTenant("beta");
  alphaSk = await issueKey(alphaId);
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Trips"],
  ] as const) {
    await tenantTx(tenantDb, schema, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await seedDefaultMarkupRule(trx);
    });
  }
  alphaDefault = (
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("markup_rules").select("id").where("is_default", "=", true).executeTakeFirstOrThrow(),
    )
  ).id;
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  api = await createTestApp({
    database: db,
    redis,
    env: { AMADEUS_BASE_URL_TEST: stub.url },
    // Its journeys search and price for one tenant one after the other (helpers/amadeus-limits.ts).
    imports: [journeyAmadeusLimitsModule()],
  });
  // The first sign-in, read, write, search and pricing of a process open the pools' connections and warm the token,
  // validation and pricing code; done once here, so that no test pays for it.
  const warmUp = await signIn(alphaId, "owner");
  expect((await warmUp.get(MARKUP)).status).toBe(200);
  const created = await warmUp.post(FEES, feeBody({ isActive: false }));
  expect(created.status).toBe(201);
  expect((await warmUp.delete(`${FEES}/${String(created.body.id)}`, '"1"')).status).toBe(204);
  await priceCheapest();
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

// Every test starts from the seeded rules: only the default markup rule of each tenant at 0 %.
afterEach(async () => {
  for (const schema of ["tenant_alpha", "tenant_beta"] as const) {
    await tenantTx(tenantDb, schema, async (trx) => {
      await trx.deleteFrom("markup_rules").where("is_default", "=", false).execute();
      await trx.deleteFrom("fee_rules").execute();
      await trx
        .updateTable("markup_rules")
        .set({ percentage: "0", priority: 1000, scope: JSON.stringify({}), is_active: true, version: 1 })
        .where("is_default", "=", true)
        .execute();
    });
  }
});

/* ------------------------------------------------------------------------------------------------
 * The tests
 * ---------------------------------------------------------------------------------------------- */

describe("a markup or fee change and the prices", () => {
  it("applies a markup change to the next search, never to an existing search's offers [OBE-069 AC1] [OF-10 AC1]", async () => {
    const owner = await signIn(alphaId, "owner");
    const before = await search();
    expect(await totalsOf(before)).toEqual([...NETS]);

    const created = await owner.post(MARKUP, markupBody());
    expect(answer(created)).toEqual([201, undefined]);
    const afterCreate = await search();
    const changed = await owner.patch(
      `${MARKUP}/${String(created.body.id)}`,
      { percentage: "20.0000" },
      created.headers["etag"] as string,
    );
    expect(answer(changed)).toEqual([200, undefined]);
    const afterUpdate = await search();

    expect(await totalsOf(afterCreate)).toEqual(withMarkup("10"));
    expect(await totalsOf(afterUpdate)).toEqual(withMarkup("20"));
    // The searches stored before each change keep their prices.
    expect(await totalsOf(before)).toEqual([...NETS]);
  });

  it("deletes a rule keeping the history: the offers keep their amounts and lose the reference [OF-10 AC1]", async () => {
    const owner = await signIn(alphaId, "owner");
    const created = await owner.post(MARKUP, markupBody());
    const id = String(created.body.id);
    const priced = await search();
    const pricedOffer = await priceCheapest();
    const pricedRow = () =>
      tenantTx(tenantDb, "tenant_alpha", (trx) =>
        trx
          .selectFrom("priced_offers")
          .select(["markup_rule_id", "markup_amount", "selling_total"])
          .where("id", "=", pricedOffer.id)
          .executeTakeFirstOrThrow(),
      );
    const pricedBefore = await pricedRow();

    const deleted = await owner.delete(`${MARKUP}/${id}`, created.headers["etag"] as string);
    const after = await search();

    expect([deleted.status, deleted.body]).toEqual([204, {}]);
    expect(deleted.headers["cache-control"]).toBe("private, no-store");
    expect(await totalsOf(priced)).toEqual(withMarkup("10"));
    expect(await totalsOf(after)).toEqual([...NETS]);
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("flight_offers")
        .select(["markup_rule_id", "markup_amount", "net_total", "selling_total"])
        .where("search_id", "=", priced)
        .orderBy("selling_total")
        .execute(),
    );
    expect(rows.map((row) => [row.markup_rule_id, row.net_total, row.selling_total])).toEqual(
      NETS.map((net, index) => [null, net, withMarkup("10")[index]]),
    );
    expect(pricedBefore).toEqual({
      markup_rule_id: id,
      markup_amount: new Money(NETS[0] ?? "").times("0.1").toFixed(2),
      selling_total: withMarkup("10")[0],
    });
    expect(await pricedRow()).toEqual({ ...pricedBefore, markup_rule_id: null });
    expect((await owner.get(`${MARKUP}/${id}`)).status).toBe(404);
  });

  it("applies a fee change to the next pricing; a priced offer keeps its fee lines [OF-10 AC1]", async () => {
    const owner = await signIn(alphaId, "owner");
    const before = await priceCheapest();

    const created = await owner.post(FEES, feeBody());
    expect(answer(created)).toEqual([201, undefined]);
    const after = await priceCheapest();

    expect([before.fees, after.fees]).toEqual(["0.00", "10.00"]);
    expect(await pricedFees(before.id)).toBe("0.00");
  });
});

describe("console.settings.markupRules", () => {
  it("lets a viewer list and read the rules but not create one; deleting the default rule answers 409 [OBE-069 AC2]", async () => {
    const viewer = await signIn(alphaId, "viewer");
    const owner = await signIn(alphaId, "owner");

    const list = await viewer.get(MARKUP);
    const read = await viewer.get(`${MARKUP}/${alphaDefault}`);
    const create = await viewer.post(MARKUP, markupBody());
    const removeDefault = await owner.delete(`${MARKUP}/${alphaDefault}`, read.headers["etag"] as string);

    expect(answer(list)).toEqual([200, undefined]);
    expectResponseToMatch("consoleListMarkupRules", list);
    expect(list.headers["cache-control"]).toBe("private, no-store");
    expect(list.body).toEqual({
      data: [
        expect.objectContaining({
          id: alphaDefault,
          isDefault: true,
          scope: {},
          percentage: "0.0000",
          priority: 1000,
        }),
      ],
      page: { nextCursor: null, limit: 20 },
    });
    expect(answer(read)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetMarkupRule", read);
    expect(read.headers["etag"]).toBe(`"${String(read.body.version)}"`);
    expect(answer(create)).toEqual([403, "FORBIDDEN"]);
    expect(create.body.error.details).toEqual({ requiredPermission: "settings:write" });
    expectResponseToMatch("consoleCreateMarkupRule", create);
    expect(answer(removeDefault)).toEqual([409, "CONFLICT"]);
    expect(removeDefault.body.error.details).toEqual({ reason: "default_rule" });
    expectResponseToMatch("consoleDeleteMarkupRule", removeDefault);
    expect((await owner.get(`${MARKUP}/${alphaDefault}`)).status).toBe(200);
  });

  it("keeps the default rule's catch-all scope: narrowing it answers 409, its other fields change", async () => {
    const admin = await signIn(alphaId, "admin");
    const etag = (await admin.get(`${MARKUP}/${alphaDefault}`)).headers["etag"] as string;

    const narrowed = await admin.patch(`${MARKUP}/${alphaDefault}`, { scope: { carriers: ["AF"] } }, etag);
    const raised = await admin.patch(
      `${MARKUP}/${alphaDefault}`,
      { percentage: "3.0000", scope: { carriers: [] } },
      etag,
    );

    expect(answer(narrowed)).toEqual([409, "CONFLICT"]);
    expect(narrowed.body.error.details).toEqual({ reason: "default_rule" });
    expectResponseToMatch("consoleUpdateMarkupRule", narrowed);
    expect(answer(raised)).toEqual([200, undefined]);
    expectResponseToMatch("consoleUpdateMarkupRule", raised);
    expect(raised.body).toMatchObject({ isDefault: true, scope: {}, percentage: "3.0000", warnings: [] });
  });

  it("[FIX-W34-OTA AC3] keeps the default rule active, undated and at priority 1000: each change answers 409 default_rule, its percentage changes", async () => {
    const admin = await signIn(alphaId, "admin");
    const before = await admin.get(`${MARKUP}/${alphaDefault}`);
    const etag = before.headers["etag"] as string;

    for (const update of [
      { isActive: false },
      { activeFrom: "2027-01-01T00:00:00.000Z" },
      { activeUntil: "2027-01-01T00:00:00.000Z" },
      { priority: 2000 },
      { priority: 1, percentage: "2.0000" },
    ]) {
      const refused = await admin.patch(`${MARKUP}/${alphaDefault}`, update, etag);
      expect([update, ...answer(refused)]).toEqual([update, 409, "CONFLICT"]);
      expect([update, refused.body.error.details]).toEqual([update, { reason: "default_rule" }]);
      expect(refused.body.error.message).toBe(
        "The default markup rule always matches: it cannot be deleted, its scope stays empty, it stays active with " +
          "no validity window, and its priority stays 1000.",
      );
      expectResponseToMatch("consoleUpdateMarkupRule", refused);
    }
    // Nothing changed: the same version, still active, undated, at 1000 and 0 %.
    const unchanged = await admin.get(`${MARKUP}/${alphaDefault}`);
    expect(unchanged.body).toEqual(before.body);

    const allowed = await admin.patch(
      `${MARKUP}/${alphaDefault}`,
      { percentage: "1.5000", isActive: true, activeFrom: null, activeUntil: null, priority: 1000 },
      etag,
    );
    expect(answer(allowed)).toEqual([200, undefined]);
    expectResponseToMatch("consoleUpdateMarkupRule", allowed);
    expect(allowed.body).toMatchObject({
      isDefault: true,
      percentage: "1.5000",
      isActive: true,
      activeFrom: null,
      activeUntil: null,
      priority: 1000,
      scope: {},
      version: Number(before.body.version) + 1,
    });
  });

  it("creates a rule with Location and ETag, replays a retry and refuses the key with another body", async () => {
    const owner = await signIn(alphaId, "owner");
    const key = randomUUID();
    const body = markupBody({
      name: "Long-haul economy",
      description: "4 % on economy from France above 400 EUR net, at least 15 EUR per traveller.",
      scope: { originCountries: ["FR"], cabins: ["ECONOMY"], minNet: "400.00" },
      percentage: "4",
      min: { amount: "15", currency: "EUR" },
      priority: 100,
    });

    const created = await owner.post(MARKUP, body, key);
    const replay = await owner.post(MARKUP, body, key);
    const reused = await owner.post(MARKUP, { ...body, name: "Another" }, key);

    expect(answer(created)).toEqual([201, undefined]);
    expectResponseToMatch("consoleCreateMarkupRule", created);
    const id = String(created.body.id);
    expect(created.headers["location"]).toBe(`${MARKUP}/${id}`);
    expect(created.headers["etag"]).toBe('"1"');
    expect(created.body).toMatchObject({
      id: expect.stringMatching(/^mkr_/),
      percentage: "4.0000",
      fixed: null,
      min: { amount: "15.00", currency: "EUR" },
      appliesPer: "traveler",
      stackable: false,
      isDefault: false,
      isActive: true,
      version: 1,
      warnings: [],
    });
    expect([replay.status, replay.body.id, replay.headers["location"]]).toEqual([201, id, `${MARKUP}/${id}`]);
    expect(answer(reused)).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    const stored = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("markup_rules").selectAll().where("is_default", "=", false).execute(),
    );
    expect(stored).toEqual([
      expect.objectContaining({
        id,
        fixed_currency: "EUR",
        min_amount: "15.00",
        scope: { originCountries: ["FR"], cabins: ["ECONOMY"], minNet: "400.00" },
        created_by_staff_id: owner.member.staffId,
      }),
    ]);
  });

  it("refuses rules the schema allows but OADR-0005 does not with 400 VALIDATION_FAILED", async () => {
    const owner = await signIn(alphaId, "owner");

    const missing = await owner.post(MARKUP, markupBody({ calculation: "percentage_plus_fixed" }));
    const mixed = await owner.post(
      MARKUP,
      markupBody({ min: { amount: "1.00", currency: "EUR" }, max: { amount: "9.999", currency: "USD" } }),
    );
    const window = await owner.post(
      MARKUP,
      markupBody({ activeFrom: "2026-12-01T00:00:00Z", activeUntil: "2026-11-01T00:00:00Z" }),
    );
    // The date-time format admits the year 0000, which timestamptz refuses.
    const yearZero = await owner.post(MARKUP, markupBody({ activeFrom: "0000-01-01T00:00:00Z" }));
    const defaultFlag = await owner.post(MARKUP, markupBody({ isDefault: true }));

    expect(missing.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/fixed", code: "required" }),
    ]);
    expect(mixed.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/max/amount", code: "decimals" }),
      expect.objectContaining({ path: "/max/currency", code: "currency" }),
    ]);
    expect(window.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/activeUntil", code: "window" }),
    ]);
    expect(yearZero.body.error?.fieldErrors).toEqual([
      expect.objectContaining({ path: "/activeFrom", code: "format" }),
    ]);
    for (const res of [missing, mixed, window, yearZero, defaultFlag]) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expectResponseToMatch("consoleCreateMarkupRule", res);
    }
    const count = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("markup_rules").select("id").execute(),
    );
    expect(count).toHaveLength(1);
  });

  it("warns about amounts in another currency than the default and about rules that sell below net", async () => {
    const owner = await signIn(alphaId, "owner");

    const res = await owner.post(
      MARKUP,
      markupBody({
        name: "AF October promotion",
        scope: { carriers: ["AF"] },
        calculation: "fixed",
        percentage: null,
        fixed: { amount: "-10.00", currency: "USD" },
        appliesPer: "booking",
        stackable: true,
      }),
    );

    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleCreateMarkupRule", res);
    expect(res.body.warnings).toEqual([
      { code: "fixed_currency_not_default", message: expect.any(String), path: "/fixed/currency" },
      { code: "sells_below_net", message: expect.any(String), path: "/fixed/amount" },
    ]);
    // A get answers the rule without warnings.
    expect((await owner.get(`${MARKUP}/${String(res.body.id)}`)).body).not.toHaveProperty("warnings");
  });

  it("needs If-Match on update and delete, answers a stale one 412 and takes it quoted, weak or bare", async () => {
    const owner = await signIn(alphaId, "owner");
    const created = await owner.post(MARKUP, markupBody());
    const path = `${MARKUP}/${String(created.body.id)}`;

    const missing = await owner.patch(path, { name: "No precondition" });
    const missingDelete = await owner.delete(path);
    const quoted = await owner.patch(path, { name: "Quoted" }, '"1"');
    const stale = await owner.patch(path, { name: "Stale" }, '"1"');
    const weak = await owner.patch(path, { name: "Weak" }, 'W/"2"');
    const bare = await owner.patch(path, { isActive: false }, "3");
    const staleDelete = await owner.delete(path, '"3"');

    for (const res of [missing, missingDelete]) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expect(res.body.error.fieldErrors).toEqual([
        expect.objectContaining({ path: "/header/If-Match", code: "required" }),
      ]);
    }
    expect(answer(stale)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("consoleUpdateMarkupRule", stale);
    expect(answer(staleDelete)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("consoleDeleteMarkupRule", staleDelete);
    expect([quoted, weak, bare].map((res) => [res.status, res.body.version, res.headers["etag"]])).toEqual([
      [200, 2, '"2"'],
      [200, 3, '"3"'],
      [200, 4, '"4"'],
    ]);
    expectResponseToMatch("consoleUpdateMarkupRule", bare);
    expect(bare.body).toMatchObject({ name: "Weak", isActive: false });
  });

  it("lists in evaluation order with the active filter, page after page", async () => {
    const owner = await signIn(alphaId, "owner");
    for (const [priority, isActive] of [
      [50, true],
      [10, false],
      [50, true],
      [20, true],
    ] as const) {
      expect((await owner.post(MARKUP, markupBody({ priority, isActive }))).status).toBe(201);
    }

    const first = await owner.get(`${MARKUP}?limit=2`);
    const second = await owner.get(`${MARKUP}?limit=2&cursor=${String(first.body.page.nextCursor)}`);
    const third = await owner.get(`${MARKUP}?limit=2&cursor=${String(second.body.page.nextCursor)}`);
    const active = await owner.get(`${MARKUP}?active=true`);
    const inactive = await owner.get(`${MARKUP}?active=false`);
    const otherFilter = await owner.get(`${MARKUP}?active=true&cursor=${String(first.body.page.nextCursor)}`);
    // A cursor is base64url JSON anyone can write: a position no integer column holds is refused like any other.
    const forged = Buffer.from(JSON.stringify({ p: "9999999999", i: alphaDefault, f: "all" })).toString(
      "base64url",
    );
    const outOfRange = await owner.get(`${MARKUP}?cursor=${forged}`);

    const priorities = (res: Response) => (res.body.data as Json[]).map((rule) => rule["priority"]);
    for (const res of [first, second, third, active, inactive]) {
      expect(res.status).toBe(200);
      expectResponseToMatch("consoleListMarkupRules", res);
    }
    expect([priorities(first), priorities(second), priorities(third)]).toEqual([[10, 20], [50, 50], [1000]]);
    const tied = [...(second.body.data as Json[])].map((rule) => String(rule["id"]));
    expect(tied).toEqual([...tied].sort());
    expect(third.body.page.nextCursor).toBeNull();
    expect(priorities(active)).toEqual([20, 50, 50, 1000]);
    expect(priorities(inactive)).toEqual([10]);
    for (const res of [otherFilter, outOfRange]) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expectResponseToMatch("consoleListMarkupRules", res);
      expect(res.body.error.fieldErrors).toEqual([
        expect.objectContaining({ path: "/query/cursor", code: "cursor" }),
      ]);
    }
  });

  it("keeps the stored scope when an update does not send one, so the rule the engine applies never widens", async () => {
    const owner = await signIn(alphaId, "owner");
    // A scope written outside the console: the engine reads it (codes trimmed and upper-cased: Air France only), the
    // answer cannot show the lower-case code and leaves it out.
    const id = newId("mkr");
    const stored = { carriers: ["af"], minNet: "100.00" };
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .insertInto("markup_rules")
        .values({
          id,
          name: "Written outside the console",
          scope: JSON.stringify(stored),
          calculation: "percentage",
          percentage: "5",
          priority: 10,
        })
        .execute(),
    );
    const storedRow = () =>
      tenantTx(tenantDb, "tenant_alpha", (trx) =>
        trx
          .selectFrom("markup_rules")
          .select(["scope", "percentage", "version"])
          .where("id", "=", id)
          .executeTakeFirstOrThrow(),
      );

    const changed = await owner.patch(`${MARKUP}/${id}`, { percentage: "6.0000" }, '"1"');
    const afterChange = await storedRow();
    const replaced = await owner.patch(`${MARKUP}/${id}`, { scope: { carriers: ["AF", "IB"] } }, '"2"');

    expect(answer(changed)).toEqual([200, undefined]);
    expectResponseToMatch("consoleUpdateMarkupRule", changed);
    expect(afterChange).toEqual({ scope: stored, percentage: "6.0000", version: 2 });
    // A scope sent replaces the stored one whole.
    expect(answer(replaced)).toEqual([200, undefined]);
    expect(replaced.body.scope).toEqual({ carriers: ["AF", "IB"] });
    expect(await storedRow()).toEqual({
      scope: { carriers: ["AF", "IB"] },
      percentage: "6.0000",
      version: 3,
    });
  });

  it("writes a staff_actions row with the rule before and after for each change, and a failed one for a refusal", async () => {
    const owner = await signIn(alphaId, "owner");
    const created = await owner.post(MARKUP, markupBody());
    const id = String(created.body.id);
    const updated = await owner.patch(`${MARKUP}/${id}`, { percentage: "12.5000" }, '"1"');
    const refused = await owner.delete(`${MARKUP}/${alphaDefault}`, '"1"');
    await owner.get(`${MARKUP}/${id}`);
    await owner.get(MARKUP);
    expect((await owner.delete(`${MARKUP}/${id}`, '"2"')).status).toBe(204);

    expect([created.status, updated.status, refused.status]).toEqual([201, 200, 409]);
    const { warnings: _created, ...rule } = created.body as Json;
    const { warnings: _updated, ...changed } = updated.body as Json;
    const rows = (await staffActions("tenant_alpha", owner.member.staffId)).filter(
      (row) => row["action"] !== "staff.sign_in",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        action: "settings.markupRules.create",
        outcome: "succeeded",
        staff_role: "owner",
        target_type: "markup_rule",
        target_id: id,
        before: null,
        after: rule,
      }),
      expect.objectContaining({
        action: "settings.markupRules.update",
        outcome: "succeeded",
        target_id: id,
        before: rule,
        after: changed,
      }),
      expect.objectContaining({
        action: "settings.markupRules.delete",
        outcome: "failed",
        target_type: "markup_rule",
        target_id: alphaDefault,
        before: null,
        after: null,
      }),
      // The reads are not audited.
      expect.objectContaining({
        action: "settings.markupRules.delete",
        outcome: "succeeded",
        target_id: id,
        before: changed,
        after: null,
      }),
    ]);
  });

  it("never shows or changes another tenant's rules", async () => {
    const alphaOwner = await signIn(alphaId, "owner");
    const betaOwner = await signIn(betaId, "owner");
    const created = await alphaOwner.post(MARKUP, markupBody());
    const path = `${MARKUP}/${String(created.body.id)}`;

    const list = await betaOwner.get(MARKUP);
    const read = await betaOwner.get(path);
    const change = await betaOwner.patch(path, { percentage: "50.0000" }, '"1"');
    const removal = await betaOwner.delete(path, '"1"');

    expect((list.body.data as Json[]).map((rule) => rule["isDefault"])).toEqual([true]);
    for (const res of [read, change, removal]) {
      expect(answer(res)).toEqual([404, "NOT_FOUND"]);
    }
    expect((await alphaOwner.get(path)).body).toMatchObject({ percentage: "10.0000", version: 1 });
  });
});

describe("console.settings.feeRules", () => {
  it("creates, reads, lists, updates and deletes fee rules, a change fee stored though unused", async () => {
    const admin = await signIn(alphaId, "admin");

    const created = await admin.post(
      FEES,
      feeBody({
        name: "Change fee",
        label: "Change fee",
        feeType: "change",
        fixed: { amount: "35", currency: "EUR" },
      }),
    );
    const id = String(created.body.id);
    const read = await admin.get(`${FEES}/${id}`);
    const list = await admin.get(`${FEES}?active=true`);
    const updated = await admin.patch(
      `${FEES}/${id}`,
      { refundable: true, fixed: { amount: "40.00", currency: "USD" } },
      read.headers["etag"] as string,
    );
    const stale = await admin.patch(`${FEES}/${id}`, { refundable: false }, '"1"');
    const deleted = await admin.delete(`${FEES}/${id}`, updated.headers["etag"] as string);

    expect(answer(created)).toEqual([201, undefined]);
    expectResponseToMatch("consoleCreateFeeRule", created);
    expect(created.headers["location"]).toBe(`${FEES}/${id}`);
    expect(created.body).toMatchObject({
      id: expect.stringMatching(/^fee_/),
      feeType: "change",
      fixed: { amount: "35.00", currency: "EUR" },
      appliesPer: "booking",
      refundable: false,
      priority: 100,
      isActive: true,
      warnings: [],
    });
    expect(answer(read)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetFeeRule", read);
    expectResponseToMatch("consoleListFeeRules", list);
    expect((list.body.data as Json[]).map((rule) => rule["id"])).toEqual([id]);
    expect(answer(updated)).toEqual([200, undefined]);
    expectResponseToMatch("consoleUpdateFeeRule", updated);
    expect(updated.body).toMatchObject({
      refundable: true,
      fixed: { amount: "40.00", currency: "USD" },
      version: 2,
      warnings: [expect.objectContaining({ code: "fixed_currency_not_default", path: "/fixed/currency" })],
    });
    expect(answer(stale)).toEqual([412, "PRECONDITION_FAILED"]);
    expect(deleted.status).toBe(204);
    expectResponseToMatch("consoleDeleteFeeRule", deleted);
    expect((await admin.get(`${FEES}/${id}`)).status).toBe(404);
  });

  it("refuses negative fees and percentages above 100, and lets only owners and admins write", async () => {
    const owner = await signIn(alphaId, "owner");
    const agent = await signIn(alphaId, "agent");
    const finance = await signIn(alphaId, "finance");

    const negative = await owner.post(FEES, feeBody({ fixed: { amount: "-1.00", currency: "EUR" } }));
    const percent = await owner.post(
      FEES,
      feeBody({ calculation: "percentage", fixed: null, percentage: "100.5000" }),
    );
    const byAgent = await agent.post(FEES, feeBody());
    const byFinance = await finance.post(FEES, feeBody());
    const readByAgent = await agent.get(FEES);

    expect(negative.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/fixed/amount", code: "minimum" }),
    ]);
    expect(percent.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/percentage", code: "maximum" }),
    ]);
    for (const res of [negative, percent]) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expectResponseToMatch("consoleCreateFeeRule", res);
    }
    for (const res of [byAgent, byFinance]) {
      expect(answer(res)).toEqual([403, "FORBIDDEN"]);
      expect(res.body.error.details).toEqual({ requiredPermission: "settings:write" });
    }
    expect(answer(readByAgent)).toEqual([200, undefined]);
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("fee_rules").select("id").execute(),
    );
    expect(rows).toEqual([]);
  });
});
