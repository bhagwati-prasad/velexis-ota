// The Amadeus connection resolver and token provider against PostgreSQL 16, Redis 7 and the Amadeus stub (OBE-017;
// OADR-0001 points 4 and 5, flows/amadeus-connection-and-tokens.md §2 and §3). The file clones the @velexis/testing
// template, writes the platform rows as velexis_migrator does for the platform (shared accounts, tenants, supplier
// connections, the client secrets encrypted with the test KEK as the platform encrypts them), and runs AmadeusModule
// inside the API's module graph: its pool reads them as velexis_ota_app, its Redis client is the file's database.
//
// Two stubs stand in for Amadeus, each accepting one client id and secret only: the test environment's
// (AMADEUS_BASE_URL_TEST) those of the test account, so every token it issues proves that the secret the platform
// encrypted was read back from PostgreSQL and decrypted; the live one's (AMADEUS_BASE_URL_LIVE) other ones, so the live
// account's credentials are refused.
import { randomBytes } from "node:crypto";
import { INVALIDATION_CHANNEL } from "@velexis/api-types/jobs";
import { decryptValue, encryptValue, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  type Insertable,
  type Kysely,
  type PlatformDatabase,
} from "@velexis/db";
import { AppError } from "@velexis/errors";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { startAmadeusStub, TOKEN_OPERATION, type AmadeusStub } from "@velexis/testing/amadeus";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusModule } from "../../../src/amadeus/amadeus.module";
import { ConnectionResolver } from "../../../src/amadeus/connection-resolver";
import { tokenAad, TokenProvider } from "../../../src/amadeus/token-provider";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { testKeyProvider } from "../../helpers/api-env";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type ConnectionInsert = Insertable<PlatformDatabase["platform.supplier_connections"]>;

interface SharedAccount {
  readonly id: string;
  readonly clientId: string;
  /** The client secret in clear: random per run, held by the test only, never written to a file. */
  readonly secret: string;
  /** base64 of the ciphertext the platform stored. */
  readonly ciphertext: string;
}

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let testStub: AmadeusStub;
let liveStub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
/** velexis_migrator, the owner of the platform tables: what writes the file's platform rows. */
let migrator: Kysely<PlatformDatabase>;
let resolver: ConnectionResolver;
let tokens: TokenProvider;
let testAccount: SharedAccount;
let liveAccount: SharedAccount;

/** A random Amadeus office id (`^[A-Z0-9]{9}$`). */
const newOffice = (): string => `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;

/** Inserts the Velexis shared account of `environment`, its secret encrypted as the platform encrypts it. */
async function insertAccount(environment: "test" | "live"): Promise<SharedAccount> {
  const id = newId("ama");
  const secret = randomBytes(24).toString("base64url");
  const clientId = `velexis-${environment}-${randomBytes(4).toString("hex")}`;
  const { ciphertext, kekId } = await encryptValue(secret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys,
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: `Velexis ${environment}`,
      environment,
      base_url:
        environment === "test" ? "https://test.travel.api.amadeus.com" : "https://travel.api.amadeus.com",
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return { id, clientId, secret, ciphertext: ciphertext.toString("base64") };
}

/** Inserts an active tenant with a key nobody else uses. */
async function insertTenant(): Promise<string> {
  const id = newId("ten");
  const key = `amd${randomBytes(5).toString("hex")}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  return id;
}

/** Inserts the tenant's connection on a shared account as provisioning does: one office, default = queuing = owner. */
async function insertConnection(
  tenantId: string,
  account: SharedAccount,
  environment: "test" | "live",
  values: Partial<ConnectionInsert> = {},
): Promise<string> {
  const id = newId("sc");
  const office = newOffice();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id,
      tenant_id: tenantId,
      environment,
      credential_source: "velexis",
      amadeus_account_id: account.id,
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: "active",
      ...values,
    })
    .execute();
  return id;
}

/** The token requests a stub has seen. */
const tokenRequests = (stub: AmadeusStub) =>
  stub.requests().filter((request) => request.operation === TOKEN_OPERATION);

/** Resolves the tenant's connection and gets its token, as the client of OBE-018 will for each call. */
async function tokenFor(tenantId: string, environment: "test" | "live"): Promise<string> {
  return tokens.getToken(await resolver.resolve(tenantId, environment));
}

/** The AppError a promise rejects with, as `[status, code]`. */
async function refusal(promise: Promise<unknown>): Promise<[number, string]> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return [(error as AppError).status, (error as AppError).code];
}

// Cloning the template database, starting two stubs and building the API's module graph (Nest, the pools, Redis and the
// vx:invalidate subscriber) take a few seconds alone and much longer on a busy 4-CPU CI runner: all of it happens once
// here, with its own timeout, and the tests only make calls.
beforeAll(async () => {
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  [testAccount, liveAccount] = await Promise.all([insertAccount("test"), insertAccount("live")]);
  // The test stub knows the test account's credentials only; the live stub knows other credentials than the live
  // account's, so every token request of that account is refused.
  [testStub, liveStub] = await Promise.all([
    startAmadeusStub({ credentials: { clientId: testAccount.clientId, clientSecret: testAccount.secret } }),
    startAmadeusStub({
      credentials: { clientId: "another-client", clientSecret: randomBytes(24).toString("base64url") },
    }),
  ]);
  api = await createTestApp({
    database: db,
    redis,
    imports: [AmadeusModule],
    env: { AMADEUS_BASE_URL_TEST: testStub.url, AMADEUS_BASE_URL_LIVE: liveStub.url },
  });
  resolver = api.app.get(ConnectionResolver);
  tokens = api.app.get(TokenProvider);
}, 120_000);

afterAll(async () => {
  await api?.close();
  await Promise.all([testStub?.stop(), liveStub?.stop()]);
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

describe("the token of the shared account", () => {
  it("is requested once for 50 concurrent calls of two tenants on the account [OBE-017 AC1]", async () => {
    const tenants = [await insertTenant(), await insertTenant()];
    await Promise.all(tenants.map((tenantId) => insertConnection(tenantId, testAccount, "test")));
    await redis.client.del(redisKeys.amadeusToken(testAccount.id, "test").key);
    testStub.clearRequests();

    const issued = await Promise.all(
      Array.from({ length: 50 }, (_, index) => tokenFor(tenants[index % 2] ?? "", "test")),
    );

    expect(new Set(issued).size).toBe(1);
    expect(tokenRequests(testStub)).toEqual([expect.objectContaining({ method: "POST", status: 200 })]);
    // A later call reads the cached token.
    expect(await tokenFor(tenants[0] ?? "", "test")).toBe(issued[0]);
    expect(tokenRequests(testStub)).toHaveLength(1);
  });

  it("is stored in Redis as ciphertext, until expires_in − 60 s [OBE-017 AC2]", async () => {
    const tenantId = await insertTenant();
    await insertConnection(tenantId, testAccount, "test");
    const token = await tokenFor(tenantId, "test");
    const key = redisKeys.amadeusToken(testAccount.id, "test").key;

    const stored = await redis.client.get(key);
    const ttl = await redis.client.ttl(key);

    expect(stored).not.toBeNull();
    expect(stored).not.toContain(token);
    expect(Buffer.from(stored ?? "", "base64").toString("latin1")).not.toContain(token);
    const plaintext = await decryptValue(Buffer.from(stored ?? "", "base64"), {
      aad: tokenAad(testAccount.id, "test"),
      keys,
    });
    expect(plaintext.toString("utf8")).toBe(token);
    expect(ttl).toBeGreaterThan(1700);
    expect(ttl).toBeLessThanOrEqual(1799 - 60);
  });

  it("is a new one after dropToken (the operation-level 401 path)", async () => {
    const tenantId = await insertTenant();
    await insertConnection(tenantId, testAccount, "test");
    const connection = await resolver.resolve(tenantId, "test");
    const before = await tokens.getToken(connection);
    const requests = tokenRequests(testStub).length;

    await tokens.dropToken(connection, before);
    const after = await tokens.getToken(connection);

    expect(after).not.toBe(before);
    expect(tokenRequests(testStub)).toHaveLength(requests + 1);
  });
});

describe("the resolved connection", () => {
  it("serves the shared account through the stub, with the tenant's office", async () => {
    const tenantId = await insertTenant();
    const connectionId = await insertConnection(tenantId, testAccount, "test");

    const resolved = await resolver.resolve(tenantId, "test");

    const office = resolved.officeIds[0];
    expect(resolved).toMatchObject({
      tenantId,
      environment: "test",
      connectionId,
      credentialSource: "velexis",
      credId: testAccount.id,
      clientId: testAccount.clientId,
      encryptedSecret: {
        ciphertext: testAccount.ciphertext,
        aad: `platform.amadeus_accounts.client_secret_ciphertext:${testAccount.id}`,
      },
      baseUrl: testStub.url,
      offices: { queuing: office, owner: office, queue: office, retrieval: office },
    });
  });

  it("is cached with its secret as ciphertext only: no Redis value holds a secret or a token in clear", async () => {
    const tenantId = await insertTenant();
    await insertConnection(tenantId, testAccount, "test");
    const token = await tokenFor(tenantId, "test");

    const cachedConnection = await redis.client.get(redisKeys.conn("amadeus", tenantId, "test").key);
    const cachedAccount = await redis.client.get(redisKeys.amadeusAccount(testAccount.id).key);
    // Every value of every key, whatever its type: since OBE-030 the API also opens its BullMQ queues, whose metadata
    // are hashes.
    const values = await Promise.all(
      (await redis.client.keys("*")).map(async (name) => {
        const type = await redis.client.type(name);
        if (type === "string") {
          return (await redis.client.get(name)) ?? "";
        }
        if (type === "hash") {
          return JSON.stringify(await redis.client.hgetall(name));
        }
        if (type === "list") {
          return JSON.stringify(await redis.client.lrange(name, 0, -1));
        }
        if (type === "set") {
          return JSON.stringify(await redis.client.smembers(name));
        }
        if (type === "zset") {
          return JSON.stringify(await redis.client.zrange(name, 0, -1));
        }
        return JSON.stringify(await redis.client.xrange(name, "-", "+"));
      }),
    );

    expect(JSON.parse(cachedConnection ?? "null")).toMatchObject({
      v: 1,
      value: { tenantId, status: "active" },
    });
    expect(JSON.parse(cachedAccount ?? "null")).toMatchObject({
      v: 1,
      value: { id: testAccount.id, clientSecretCiphertext: testAccount.ciphertext },
    });
    const everything = values.join("\n");
    expect(everything).not.toContain(testAccount.secret);
    expect(everything).not.toContain(token);
  });

  it("follows a `connection` invalidation: a connection the platform disabled answers 424 at once", async () => {
    const tenantId = await insertTenant();
    const connectionId = await insertConnection(tenantId, testAccount, "test");
    await resolver.resolve(tenantId, "test");

    await migrator
      .updateTable("platform.supplier_connections")
      .set({ status: "disabled" })
      .where("id", "=", connectionId)
      .execute();
    await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify({ v: 1, type: "connection", tenantId }));

    await vi.waitFor(
      async () => {
        expect(await refusal(resolver.resolve(tenantId, "test"))).toEqual([424, "SUPPLIER_NOT_CONFIGURED"]);
      },
      { timeout: 5000, interval: 20 },
    );
  });
});

describe("424 SUPPLIER_NOT_CONFIGURED", () => {
  it("answers a tenant without an active connection, without a token request [OBE-017 AC2]", async () => {
    const [none, pending, liveOnly] = [await insertTenant(), await insertTenant(), await insertTenant()];
    await insertConnection(pending, testAccount, "test", { status: "pending_verification" });
    await insertConnection(liveOnly, liveAccount, "live");
    const requests = tokenRequests(testStub).length;

    for (const tenantId of [none, pending, liveOnly]) {
      expect(await refusal(tokenFor(tenantId, "test"))).toEqual([424, "SUPPLIER_NOT_CONFIGURED"]);
    }
    expect(tokenRequests(testStub)).toHaveLength(requests);
  });

  it("answers refused credentials, then answers 424 for 5 minutes without a new token request [OBE-017 AC2]", async () => {
    const [first, second] = [await insertTenant(), await insertTenant()];
    await insertConnection(first, liveAccount, "live");
    await insertConnection(second, liveAccount, "live");
    liveStub.clearRequests();
    const flag = redisKeys.amadeusBadCredentials(liveAccount.id).key;

    expect(await refusal(tokenFor(first, "live"))).toEqual([424, "SUPPLIER_NOT_CONFIGURED"]);
    expect(tokenRequests(liveStub)).toEqual([expect.objectContaining({ status: 401 })]);
    expect(await redis.client.ttl(flag)).toBeGreaterThan(290);
    expect(await redis.client.ttl(flag)).toBeLessThanOrEqual(300);

    // The flag belongs to the credential set: another tenant on the same account is refused without a request too.
    expect(await refusal(tokenFor(first, "live"))).toEqual([424, "SUPPLIER_NOT_CONFIGURED"]);
    expect(await refusal(tokenFor(second, "live"))).toEqual([424, "SUPPLIER_NOT_CONFIGURED"]);
    expect(tokenRequests(liveStub)).toHaveLength(1);
    expect(await redis.client.exists(redisKeys.amadeusToken(liveAccount.id, "live").key)).toBe(0);
    expect(api.sink.text()).not.toContain(liveAccount.secret);
    expect(api.sink.records()).toContainEqual(
      expect.objectContaining({ level: 50, msg: "amadeus.credentials_refused", credId: liveAccount.id }),
    );
  });
});
