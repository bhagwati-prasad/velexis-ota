// Deleted and disabled customers on every customer-scope operation, and account.delete beside a checkout.create
// (FIX-W29-SECURITY; lead decision (1) of 2026-10-24, ADR-0008's note of 2026-10-24, identity/customer-access.ts,
// common/auth/customer.guard.ts, account/account.service.ts, checkout/checkout.service.ts), through the API's whole
// pipeline against PostgreSQL 16, Redis 7 and the Amadeus stub, for key callers (bearer tokens) and the hosted
// storefront's edge (the `__Host-vx_at` cookie).
//
// The file clones the @velexis/testing template, writes the platform rows of tenant_alpha (a supplier connection on the
// Velexis test Amadeus account, whose base URL is the stub, and a secret test key), seeds its storefront settings, and
// inserts customers with Argon2id password identities (one made-up password, hashed once). Priced offers come from the
// stub's Madrid–Paris Orly offer through flights.search and flights.price, without a customer token (so any customer of
// alpha may open a checkout from them). The operations swept are every operation of the OTA document whose security
// names the customer's scheme for the caller (`customerRequirements` of the guard), implemented (not in
// pending-operations.ts): the guard runs before request validation, so each request needs only its route.
//
// The race scenarios are deterministic: a spy holds checkout.create after its read of the customer, or holds the
// deletion's transaction with the customer locked, until the other request has done its part. Scenarios run in their
// `beforeAll` hook with a budget of their own; the tests only read what they left. Passwords and keys are made up per
// run; no value is a secret.
import { randomBytes, randomUUID } from "node:crypto";
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
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountRepository } from "../../../src/account/account.repository";
import { CheckoutRepository } from "../../../src/checkout/checkout.repository";
import {
  customerRequirements,
  INACTIVE_CUSTOMER_OPERATIONS,
  type CustomerCaller,
} from "../../../src/common/auth/customer.guard";
import { loadOpenApiDocument } from "../../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS } from "../../../src/common/http/pending-operations";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { CUSTOMER_ACCESS_ALLOWED, CUSTOMER_ACCESS_REVOKED } from "../../../src/identity/customer-access";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { dateFromToday } from "../../builders/checkouts";
import {
  edgeHeaders,
  newApiKey,
  newCsrfToken,
  testApiCredentials,
  testKeyProvider,
} from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * Cloning the template, hashing the test password with Argon2id (19 MiB), starting the stub and the API's graph (it
 * parses the OTA document and compiles its validators): a few seconds alone, more on a busy 4-CPU CI runner. The bound
 * only stops a start-up that hangs.
 */
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/**
 * A scenario signs in, prices an offer through the stub, deletes an account (an Argon2id verification) and sweeps a
 * few dozen requests: about a second locally; the bound allows for CI load and only stops a scenario that hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a race scenario waits at most for the other request to reach its barrier or a lock. */
const BARRIER_WAIT_MS = 15_000;

const ALPHA_HOST = "alpha.ota.example.com";
const TERMS_VERSION = "2026-09-01";
const PRIVACY_VERSION = "2026-08-15";

/** The password of every inserted customer, made up for this run, and its Argon2id hash (made once, below). */
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
let passwordHash = "";

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId = "";
let alphaKey = "";

const alphaTx = <T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", fn);

let ipCounter = 0;
/** A new documentation-range IP address (RFC 5737) for one client, so the per-IP limits never mix scenarios. */
const newIp = (): string => {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
};

let emailCounter = 0;
/** An address of its own for each customer of this run. */
const newEmail = (label: string): string => {
  emailCounter += 1;
  return `${label}-${emailCounter}-${randomBytes(4).toString("hex")}@example.com`;
};

/** Inserts the Velexis test Amadeus account, whose base URL is the stub; its id. */
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
      base_url: stub.url,
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** Inserts tenant alpha (active), its supplier connection and a secret test key, as the platform does. */
async function insertAlpha(accountId: string): Promise<void> {
  alphaId = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id: alphaId, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: alphaId,
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
  alphaKey = newApiKey("sk", "test");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: alphaId,
      name: "Server (test)",
      kind: "secret",
      environment: "test",
      prefix: alphaKey.slice(0, 14),
      key_hash: hashApiKey(alphaKey, testApiCredentials().pepper),
      last4: alphaKey.slice(-4),
    })
    .execute();
}

/** Inserts an active customer of alpha with a password identity (PASSWORD); its id. */
async function insertCustomer(email: string): Promise<string> {
  const id = newId("cus");
  await alphaTx(async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id,
        email,
        status: "active",
        first_name: "Anna",
        last_name: "Berg",
        email_verified_at: new Date(),
        marketing_consent: false,
      })
      .execute();
    await trx
      .insertInto("customer_identities")
      .values({
        id: newId("cid"),
        customer_id: id,
        provider: "password",
        provider_subject: email.toLowerCase(),
        password_hash: passwordHash,
        email,
        email_verified_at: new Date(),
      })
      .execute();
  });
  return id;
}

/** Sets the status of customer `customerId` as a staff member who disables it would. */
async function disableCustomer(customerId: string): Promise<void> {
  await alphaTx((trx) =>
    trx.updateTable("customers").set({ status: "disabled" }).where("id", "=", customerId).execute(),
  );
}

/** The customer's status and its checkouts' statuses. */
async function customerState(customerId: string) {
  return await alphaTx(async (trx) => ({
    status: (
      await trx
        .selectFrom("customers")
        .select("status")
        .where("id", "=", customerId)
        .executeTakeFirstOrThrow()
    ).status,
    checkouts: (
      await trx.selectFrom("checkouts").select("status").where("customer_id", "=", customerId).execute()
    ).map((row) => row.status),
  }));
}

/** A server of a third-party storefront with alpha's secret key, calling for one visitor. */
class KeyClient {
  readonly ip = newIp();

  headers(accessToken?: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      "X-Api-Key": alphaKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": "Mozilla/5.0 (third-party storefront test)",
      ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
      ...extra,
    };
  }

  post(path: string, body: unknown, accessToken?: string): request.Test {
    return request(api.server)
      .post(path)
      .set(this.headers(accessToken, { "Idempotency-Key": randomUUID() }))
      .send(body as object);
  }

  get(path: string, accessToken?: string): request.Test {
    return request(api.server).get(path).set(this.headers(accessToken));
  }
}

/** The browser of a storefront visitor: its cookies, the session's among them. */
class Visitor {
  readonly ip = newIp();
  readonly jar = new Map<string, string>([["__Host-vx_csrf", newCsrfToken()]]);

  headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      ...edgeHeaders(ALPHA_HOST),
      Origin: `https://${ALPHA_HOST}`,
      "X-CSRF-Token": this.jar.get("__Host-vx_csrf") ?? "",
      "X-Forwarded-For": this.ip,
      "User-Agent": "Mozilla/5.0 (storefront test)",
      Cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join("; "),
      ...extra,
    };
  }

  /** Keeps the cookies an answer sets (a `Max-Age=0` one is removed, as a browser does). */
  remember(res: Response): void {
    const header = res.headers["set-cookie"] as unknown;
    for (const line of Array.isArray(header) ? (header as string[]) : []) {
      const [pair = "", ...attributes] = line.split("; ");
      const index = pair.indexOf("=");
      if (attributes.includes("Max-Age=0")) {
        this.jar.delete(pair.slice(0, index));
      } else {
        this.jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
    }
  }
}

/** Signs `email` in as a key caller's customer; the access token. */
async function bearerSignIn(email: string): Promise<string> {
  const res = await new KeyClient().post("/v1/auth/sign-in", { email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`bearerSignIn: sign-in answered ${res.status}`);
  }
  return (res.body as { session: { accessToken: string } }).session.accessToken;
}

/** Signs `email` in on the storefront; the visitor with the session's cookies. */
async function edgeSignIn(email: string): Promise<Visitor> {
  const visitor = new Visitor();
  const res = await request(api.server)
    .post("/v1/auth/sign-in")
    .set(visitor.headers({ "Idempotency-Key": randomUUID() }))
    .send({ email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`edgeSignIn: sign-in answered ${res.status}`);
  }
  visitor.remember(res);
  return visitor;
}

let searchCount = 0;
/** A priced offer of alpha's test environment, priced without a customer: any customer of alpha may open it. */
async function newPricedOffer(): Promise<string> {
  searchCount += 1;
  const client = new KeyClient();
  const searched = await client.post("/v1/flight-searches", {
    mode: "simple",
    originLocationCode: "MAD",
    destinationLocationCode: "ORY",
    departureDate: dateFromToday(60 + searchCount),
    adults: 1,
  });
  expect(searched.status).toBe(201);
  const searchId = (searched.body as { id: string }).id;
  const offerId = await alphaTx(async (trx) => {
    const row = await trx
      .selectFrom("flight_offers")
      .select("id")
      .where("search_id", "=", searchId)
      .where("amadeus_offer_id", "=", "2")
      .executeTakeFirstOrThrow();
    return row.id;
  });
  const priced = await client.post("/v1/priced-offers", { offerIds: [offerId] });
  expect(priced.status).toBe(201);
  return (priced.body as { id: string }).id;
}

/** One operation of the document: its id, method and path template. */
interface Operation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
}

/**
 * The implemented operations of the OTA document on which `caller` may present a customer's token (its security names
 * the customer's scheme for the caller: required or optional), except account.delete, whose replay the guard lets
 * through (`INACTIVE_CUSTOMER_OPERATIONS`; its own scenario below).
 */
function customerOperations(caller: CustomerCaller): Operation[] {
  const document = loadOpenApiDocument().document as { paths: Record<string, Record<string, unknown>> };
  const requirements = customerRequirements(document);
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const operationId = (operation as { operationId?: unknown } | null)?.operationId;
      if (
        typeof operationId !== "string" ||
        Object.hasOwn(PENDING_OPERATIONS, operationId) ||
        INACTIVE_CUSTOMER_OPERATIONS.has(operationId)
      ) {
        continue;
      }
      if ((requirements.get(operationId)?.[caller] ?? "none") !== "none") {
        operations.push({ operationId, method, path });
      }
    }
  }
  return operations;
}

/** `[status, error code]` of an answer. */
const outcome = (res: Response): [number, unknown] => [
  res.status,
  (res.body as { error?: { code?: unknown } }).error?.code,
];

/**
 * Sends `operation` with the customer's credential (`headers`) and an empty body; the route's path parameters are a
 * placeholder, since the guard answers before the request is validated. `[operationId, status, code]` of an answer that
 * is not `401 UNAUTHENTICATED`.
 */
async function sweep(
  operations: readonly Operation[],
  headers: () => Record<string, string>,
): Promise<Array<[string, number, unknown]>> {
  const unexpected: Array<[string, number, unknown]> = [];
  for (const operation of operations) {
    const path = operation.path.replace(/\{[^}]+\}/g, "x0");
    const sent = request(api.server)
      [operation.method as "get" | "post" | "put" | "patch" | "delete"](path)
      .set({ ...headers(), "Idempotency-Key": randomUUID(), "If-Match": '"1"' });
    const res =
      operation.method === "get" || operation.method === "delete" ? await sent : await sent.send({});
    const [status, code] = outcome(res);
    if (status !== 401 || code !== "UNAUTHENTICATED") {
      unexpected.push([operation.operationId, status, code]);
    }
  }
  return unexpected;
}

/**
 * Resolves once a backend of the test database waits for a lock another one holds (`pg_blocking_pids`, which needs no
 * privilege on the other roles' sessions, unlike their `wait_event` columns).
 */
async function untilWaitingForLock(): Promise<void> {
  const deadline = Date.now() + BARRIER_WAIT_MS;
  for (;;) {
    const { rows } = await sql<{ waiting: number }>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `.execute(migrator);
    if ((rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`untilWaitingForLock: no backend waited for a lock within ${BARRIER_WAIT_MS} ms`);
    }
    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
  }
}

/** A promise and the function that resolves it: one barrier of a race scenario. */
function barrier(): { readonly reached: Promise<void>; readonly pass: () => void } {
  let pass = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    pass = resolve;
  });
  return { reached, pass };
}

/** Waits for `reached`, failing at once when `pending` answers first (it never got to its barrier). */
async function untilReached(reached: Promise<void>, pending: Promise<Response>, what: string): Promise<void> {
  const answeredFirst = pending.then((res) => {
    throw new Error(
      `${what} answered ${res.status} ${JSON.stringify(outcome(res))} before it reached its barrier`,
    );
  });
  answeredFirst.catch(() => undefined);
  await Promise.race([reached, answeredFirst]);
}

beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of the operations checked below compile on their first check: here, not in a test.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["deleteAccount", [202]],
    ["createCheckout", [201, 401]],
    ["listBookings", [200, 401]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys, passwordHash] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    testKeyProvider(),
    hashCustomerPassword(PASSWORD),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  await insertAlpha(await insertAmadeusAccount(clientId, secret));
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await trx
      .updateTable("storefront_settings")
      .set({ terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION })
      .execute();
  });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

describe("a deleted customer's access token, still valid for minutes", () => {
  let customerId = "";
  let before: { list: Response; account: Response; cached: string | null };
  let deletion: Response;
  let deletedAgain: { byKey: Response; replay: Response };
  let revoked: Array<{ value: string | null; ttl: number }>;
  let byKey: Array<[string, number, unknown]>;
  let byEdge: Array<[string, number, unknown]>;
  let keyOperations: Operation[];
  let edgeOperations: Operation[];
  let other: { list: Response; created: Response };

  beforeAll(async () => {
    const email = newEmail("deleted");
    customerId = await insertCustomer(email);
    const token = await bearerSignIn(email);
    const visitor = await edgeSignIn(email);
    // The edge's cookies as they were before the deletion cleared them in the browser: someone who kept a copy.
    const kept = new Map(visitor.jar);
    const client = new KeyClient();
    // Used once before the deletion: the guard caches that the customer may act.
    before = {
      list: await client.get("/v1/bookings", token),
      account: await client.get("/v1/account", token),
      cached: await redis.client.get(redisKeys.customerAccess(alphaId, "test", customerId).key),
    };
    const deletionKey = randomUUID();
    deletion = await request(api.server)
      .post("/v1/account/deletion")
      .set(client.headers(token, { "Idempotency-Key": deletionKey }))
      .send({ currentPassword: PASSWORD });
    deletedAgain = {
      // A new deletion with the token is refused like every other operation; the same key replays the stored answer.
      byKey: await client.post("/v1/account/deletion", { currentPassword: PASSWORD }, token),
      replay: await request(api.server)
        .post("/v1/account/deletion")
        .set(client.headers(token, { "Idempotency-Key": deletionKey }))
        .send({ currentPassword: PASSWORD }),
    };
    revoked = await Promise.all(
      (["test", "live"] as const).map(async (environment) => {
        const key = redisKeys.customerAccess(alphaId, environment, customerId).key;
        return { value: await redis.client.get(key), ttl: await redis.client.ttl(key) };
      }),
    );
    keyOperations = customerOperations("key");
    edgeOperations = customerOperations("edge");
    byKey = await sweep(keyOperations, () => client.headers(token));
    const replayed = new Visitor();
    replayed.jar.clear();
    for (const [name, value] of kept) {
      replayed.jar.set(name, value);
    }
    byEdge = await sweep(edgeOperations, () => replayed.headers());
    // Another customer of alpha is not touched by the revocation.
    const otherEmail = newEmail("active");
    await insertCustomer(otherEmail);
    const otherToken = await bearerSignIn(otherEmail);
    const pricedOfferId = await newPricedOffer();
    other = {
      list: await client.get("/v1/bookings", otherToken),
      created: await client.post("/v1/checkouts", { pricedOfferId }, otherToken),
    };
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W29-SECURITY AC3] works before the deletion, and the deletion revokes it in both environments for a minute", () => {
    expect(outcome(before.list)[0]).toBe(200);
    expectResponseToMatch("listBookings", before.list);
    expect(before.account.status).toBe(200);
    expect(before.cached).toBe(CUSTOMER_ACCESS_ALLOWED);
    expect(deletion.status).toBe(202);
    expectResponseToMatch("deleteAccount", deletion);
    for (const key of revoked) {
      expect(key.value).toBe(CUSTOMER_ACCESS_REVOKED);
      expect(key.ttl).toBeGreaterThan(0);
      expect(key.ttl).toBeLessThanOrEqual(60);
    }
  });

  it("[FIX-W29-SECURITY AC3] is refused with 401 UNAUTHENTICATED by bookings.list, checkout.create and every other customer-scope operation", () => {
    const swept = keyOperations.map((operation) => operation.operationId);
    expect(swept).toEqual(
      expect.arrayContaining(["listBookings", "getBooking", "createCheckout", "getAccount"]),
    );
    expect(swept.length).toBeGreaterThan(20);
    expect(byKey).toEqual([]);
  });

  it("[FIX-W29-SECURITY AC3] is refused by a new account.delete, whose replay of the same key still answers the deletion", () => {
    expect(outcome(deletedAgain.byKey)).toEqual([401, "UNAUTHENTICATED"]);
    expect(deletedAgain.replay.status).toBe(202);
    expect(deletedAgain.replay.body).toEqual(deletion.body);
  });

  it("[FIX-W29-SECURITY AC3] is refused the same as the storefront's cookie, on every operation the edge may call with it", () => {
    const swept = edgeOperations.map((operation) => operation.operationId);
    expect(swept).toEqual(
      expect.arrayContaining([
        "listBookings",
        "createCheckout",
        "completeCheckoutWithAirlineCard",
        "getSession",
      ]),
    );
    expect(byEdge).toEqual([]);
  });

  it("[FIX-W29-SECURITY AC3] leaves the other customers of the OTA alone, and logs each refusal without the token", () => {
    expect(other.list.status).toBe(200);
    expect(other.created.status).toBe(201);
    expectResponseToMatch("createCheckout", other.created);
    const refusals = api.sink
      .records()
      .filter((line) => line["msg"] === "customer.token_refused" && line["reason"] === "customer_inactive");
    expect(refusals.length).toBeGreaterThanOrEqual(keyOperations.length + edgeOperations.length);
  });
});

describe("a disabled customer's access token", () => {
  let fresh: { byKey: Array<[string, number, unknown]>; byEdge: Array<[string, number, unknown]> };
  let cached: { before: Response; ttl: number; after: Response; created: Response };

  beforeAll(async () => {
    // Disabled after it signed in, before it used its token: every operation reads the customer from the database.
    const email = newEmail("disabled");
    const customerId = await insertCustomer(email);
    const token = await bearerSignIn(email);
    const visitor = await edgeSignIn(email);
    await disableCustomer(customerId);
    const client = new KeyClient();
    fresh = {
      byKey: await sweep(customerOperations("key"), () => client.headers(token)),
      byEdge: await sweep(customerOperations("edge"), () => visitor.headers()),
    };
    // Disabled while the guard trusted its last answer: refused once that answer ends, at most a minute later (here
    // the key is removed, as its expiry would).
    const otherEmail = newEmail("disabled-cached");
    const otherId = await insertCustomer(otherEmail);
    const otherToken = await bearerSignIn(otherEmail);
    const pricedOfferId = await newPricedOffer();
    const key = redisKeys.customerAccess(alphaId, "test", otherId).key;
    const beforeList = await client.get("/v1/bookings", otherToken);
    const ttl = await redis.client.ttl(key);
    await disableCustomer(otherId);
    await redis.client.del(key);
    cached = {
      before: beforeList,
      ttl,
      after: await client.get("/v1/bookings", otherToken),
      created: await client.post("/v1/checkouts", { pricedOfferId }, otherToken),
    };
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W29-SECURITY AC3] is refused with 401 UNAUTHENTICATED by every customer-scope operation, by key and on the edge", () => {
    expect(fresh.byKey).toEqual([]);
    expect(fresh.byEdge).toEqual([]);
  });

  it("[FIX-W29-SECURITY AC3] is refused by bookings.list and checkout.create once the guard's cached answer of at most a minute ends", () => {
    expect(cached.before.status).toBe(200);
    expect(cached.ttl).toBeGreaterThan(0);
    expect(cached.ttl).toBeLessThanOrEqual(60);
    expect(outcome(cached.after)).toEqual([401, "UNAUTHENTICATED"]);
    expect(outcome(cached.created)).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("createCheckout", cached.created);
  });
});

describe("a checkout.create that read the customer before account.delete committed", () => {
  let customerId = "";
  let deletion: Response;
  let created: Response;
  let state: Awaited<ReturnType<typeof customerState>>;

  beforeAll(async () => {
    const email = newEmail("race-after");
    customerId = await insertCustomer(email);
    const token = await bearerSignIn(email);
    const pricedOfferId = await newPricedOffer();
    // CheckoutRepository is provided by more than one module: the spy sits on the class.
    const readCustomer = CheckoutRepository.prototype.customer;
    const read = barrier();
    const deleted = barrier();
    let reads = 0;
    // checkout.create reads the customer (active), then waits until the deletion has committed.
    const spy = vi.spyOn(CheckoutRepository.prototype, "customer").mockImplementation(async function (
      this: CheckoutRepository,
      trx,
      id,
    ) {
      const row = await readCustomer.call(this, trx, id);
      reads += 1;
      if (reads === 1) {
        read.pass();
        await deleted.reached;
      }
      return row;
    });
    try {
      const client = new KeyClient();
      const creating = Promise.resolve(client.post("/v1/checkouts", { pricedOfferId }, token));
      await untilReached(read.reached, creating, "checkout.create");
      deletion = await client.post("/v1/account/deletion", { currentPassword: PASSWORD }, token);
      deleted.pass();
      created = await creating;
    } finally {
      deleted.pass();
      spy.mockRestore();
    }
    state = await customerState(customerId);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W29-SECURITY AC3] answers 401 UNAUTHENTICATED and leaves no checkout of the deleted customer", () => {
    expect(deletion.status).toBe(202);
    expect(outcome(created)).toEqual([401, "UNAUTHENTICATED"]);
    expectResponseToMatch("createCheckout", created);
    expect(state).toEqual({ status: "deleted", checkouts: [] });
  });
});

describe("a checkout.create whose insert waits for the lock of an account.delete", () => {
  let deletion: Response;
  let created: Response;
  let state: Awaited<ReturnType<typeof customerState>>;

  beforeAll(async () => {
    const email = newEmail("race-during");
    const customerId = await insertCustomer(email);
    const token = await bearerSignIn(email);
    const pricedOfferId = await newPricedOffer();
    const accounts = api.app.get(AccountRepository, { strict: false });
    const markDeleted = accounts.markDeleted.bind(accounts);
    const locked = barrier();
    const resume = barrier();
    // The deletion's transaction holds the customer's FOR UPDATE lock (and its other locks) until resumed.
    const spy = vi.spyOn(accounts, "markDeleted").mockImplementation(async (trx, deleted) => {
      locked.pass();
      await resume.reached;
      await markDeleted(trx, deleted);
    });
    try {
      const client = new KeyClient();
      const deleting = Promise.resolve(
        client.post("/v1/account/deletion", { currentPassword: PASSWORD }, token),
      );
      await untilReached(locked.reached, deleting, "account.delete");
      // checkout.create reads the customer (still active: nothing has committed), and its insert's foreign key waits
      // for the deletion's lock.
      const creating = Promise.resolve(client.post("/v1/checkouts", { pricedOfferId }, token));
      await untilReached(untilWaitingForLock(), creating, "checkout.create");
      resume.pass();
      [deletion, created] = await Promise.all([deleting, creating]);
    } finally {
      resume.pass();
      spy.mockRestore();
    }
    state = await customerState(customerId);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W29-SECURITY AC3] answers 401 UNAUTHENTICATED once the deletion committed, without a deadlock, and leaves no checkout", () => {
    expect(deletion.status).toBe(202);
    expect(outcome(created)).toEqual([401, "UNAUTHENTICATED"]);
    expect(state).toEqual({ status: "deleted", checkouts: [] });
    expect(api.sink.text()).not.toContain("customer.account_deletion_deadlock");
  });
});
