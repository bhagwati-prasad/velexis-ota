// A rotation of the OTA backend's token signing key (FIX-W48-OTA, lead decision (15f) of 2026-11-11; ADR-0010
// "Rotation": the old public key stays valid for one token lifetime; ota/docs/runbooks/jwt-key-rotation.md) through the
// API's whole pipeline, against PostgreSQL 16 and Redis 7. Two applications run on the same new signing key: one with
// JWT_PREVIOUS_PUBLIC_KEY_FILE naming the public half of the key the API signed with before the rotation (the test
// process's key, test/helpers/api-env.ts), as during the overlap, and one without it, as after the overlap. A customer
// token (auth.getSession through a secret key) and a staff token (console.auth.me through the OTA admin's service key)
// signed with the old key are accepted during the overlap and refused after it; a token of a key the API never had is
// refused by both; both sign with the new key only. Every answer is checked against the OTA document, and no log line
// holds a token. The file clones the @velexis/testing template (tenant_alpha provisioned) and writes the platform rows
// as the platform does; keys, tokens and names are made up per run.
import { randomBytes, randomInt, randomUUID, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigService } from "@nestjs/config";
import { hashApiKey, sha256Hex } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantSchema,
} from "@velexis/db";
import {
  createTestDatabase,
  expectResponseToMatch,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { decodeProtectedHeader, SignJWT } from "jose";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import type { ApiConfig } from "../../../src/config";
import { SessionsService } from "../../../src/identity/sessions.service";
import { StaffTokens } from "../../../src/identity/staff/staff-sessions";
import { loadSigningKey, TokenService } from "../../../src/identity/token.service";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { TenantContext, type RequestTenant } from "../../../src/tenancy/tenant-context";
import { TenantTx } from "../../../src/tenancy/tenant-tx";
import { newApiKey, testApiCredentials } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let db: TestDatabase;
let redis: TestRedis;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
/** The API during the overlap: the new signing key and the old key's public half. */
let rotating: TestApp;
/** The API after the overlap: the new signing key alone. */
let after: TestApp;
let keyFolder = "";
let tenant: RequestTenant;
let secretKey = "";

/** The old key's tokens: a customer's and a staff member's, signed before the rotation. */
let oldCustomerToken = "";
let oldStaffToken = "";
/** The same claims signed with a key the API never had, under a `kid` of its own. */
let strangerCustomerToken = "";
let strangerStaffToken = "";
/** A token the rotating API signed for the customer's session, and one it signed at the staff sign-in. */
let newCustomerToken = "";
let newStaffToken = "";
/** The `kid`s of the old and the new key. */
let oldKid = "";
let newKid = "";

/** Every token this file made, for the log scans. */
const tokensMade: string[] = [];

/** The OTA admin's server: the service key and the staff member's forwarded IP and user agent (OADR-0009 rule 1.2). */
const ADMIN_HEADERS = (): Record<string, string> => ({
  "X-Api-Key": testApiCredentials().serviceKey,
  "X-Velexis-End-User-IP": `198.51.100.${randomInt(1, 250)}`,
  "X-Velexis-End-User-Agent": "Mozilla/5.0 (OTA admin rotation test)",
  "X-Velexis-Environment": "test",
});

/** Writes `contents` to a new file of the key folder with mode 0600, as an operator installs a key. */
function keyFile(name: string, contents: string): string {
  const path = join(keyFolder, name);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** A configuration as ConfigService holds it with only JWT_PRIVATE_KEY_FILE: a signer on that key alone. */
const signingConfig = (path: string) =>
  ({
    get: (name: string) => (name === "JWT_PRIVATE_KEY_FILE" ? path : undefined),
  }) as unknown as ConfigService<ApiConfig, true>;

/** A portal token in the platform's format (PADR-0007 item 1): `ptk_` and 43 random base62 characters. */
function newPortalToken(): string {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  return token;
}

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** auth.getSession through the tenant's secret key with `token` as the customer's bearer token. */
const getSession = (api: TestApp, token: string) =>
  request(api.server)
    .get("/v1/auth/session")
    .set({ "X-Api-Key": secretKey, Authorization: `Bearer ${token}` });

/** console.auth.me through the OTA admin's service key with `token` as the staff member's bearer token. */
const consoleMe = (api: TestApp, token: string) =>
  request(api.server)
    .get("/v1/console/auth/me")
    .set({ ...ADMIN_HEADERS(), Authorization: `Bearer ${token}` });

// Cloning the template and building two module graphs of the API (Nest, pools, Redis, the OTA document's validators)
// take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own budget,
// and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
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

  // The platform rows of an active test tenant, its secret key and an owner with MFA, as the platform writes them.
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id: tenantId, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  secretKey = newApiKey("sk");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (rotation test)",
      kind: "secret",
      environment: "test",
      prefix: secretKey.slice(0, 14),
      key_hash: hashApiKey(secretKey, testApiCredentials().pepper),
      last4: secretKey.slice(-4),
    })
    .execute();
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
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role: "owner", status: "active" })
    .execute();
  tenant = {
    tenantId,
    key: "alpha",
    schemaName: "tenant_alpha" as TenantSchema,
    environment: "test",
    caller: { type: "key", id: "key_test" },
    actor: { type: "system", id: null },
    requestId: "jwt-key-rotation-int-test",
  };
  const customerId = newId("cus");
  await tenantTx(createTenantDb(otaPool, { appEnv: "test" }), tenant.schemaName, (trx) =>
    trx
      .insertInto("customers")
      .values({
        id: customerId,
        email: `${customerId.toLowerCase()}@example.com`,
        status: "active",
        first_name: "Anna",
        last_name: "Berg",
      })
      .execute(),
  );

  // The keys of the rotation: the new signing key, the public half of the old one, and a stranger's key.
  keyFolder = mkdtempSync(join(tmpdir(), "velexis-ota-rotation-"));
  const pair = () =>
    generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
  const newKeyFile = keyFile("ota-jwt-ed25519.pem", pair());
  const strangerKeyFile = keyFile("stranger.pem", pair());
  const previousFile = keyFile(
    "ota-jwt-ed25519.previous.pub.pem",
    createPublicKey(readFileSync(testApiCredentials().jwtKeyFile, "utf8")).export({
      type: "spki",
      format: "pem",
    }) as string,
  );
  oldKid = loadSigningKey(testApiCredentials().jwtKeyFile).kid;
  newKid = loadSigningKey(newKeyFile).kid;

  [rotating, after] = await Promise.all([
    createTestApp({
      database: db,
      redis,
      env: { JWT_PRIVATE_KEY_FILE: newKeyFile, JWT_PREVIOUS_PUBLIC_KEY_FILE: previousFile },
    }),
    createTestApp({ database: db, redis, env: { JWT_PRIVATE_KEY_FILE: newKeyFile } }),
  ]);

  // A customer session opened by the rotating API (its refresh family), and the tokens of its claims under each key.
  const sessions = rotating.app.get(SessionsService);
  const { issued, tokens } = await rotating.app.get(TenantContext).run(tenant, async () => {
    const started = await rotating.app.get(TenantTx).run((trx) =>
      sessions.start(trx, {
        customerId,
        identityId: null,
        rememberMe: false,
        userAgent: "Mozilla/5.0 (rotation test)",
      }),
    );
    return { issued: started, tokens: await sessions.tokensFor(started) };
  });
  newCustomerToken = tokens.accessToken;
  const customerClaims = { sub: customerId, tid: tenantId, sid: issued.sessionId };
  oldCustomerToken = (
    await new TokenService(signingConfig(testApiCredentials().jwtKeyFile), new Clock()).signCustomerToken(
      customerClaims,
    )
  ).token;
  strangerCustomerToken = (
    await new TokenService(signingConfig(strangerKeyFile), new Clock()).signCustomerToken(customerClaims)
  ).token;

  // A staff family opened by the rotating API through a portal token, as the platform's createConsoleToken stores it.
  const portalToken = newPortalToken();
  await redis.client.set(
    redisKeys.portalToken(sha256Hex(portalToken)).key,
    JSON.stringify({
      v: 1,
      accountId,
      tenantId,
      membershipId: staffId,
      role: "owner",
      mfa: true,
      issuedAt: new Date().toISOString(),
      requestId: randomUUID(),
    }),
    "EX",
    60,
    "NX",
  );
  const signIn = await request(rotating.server)
    .post("/v1/console/auth/sign-in")
    .set({ ...ADMIN_HEADERS(), "Idempotency-Key": randomUUID() })
    .send({ grantType: "portal_token", portalToken });
  expect(answer(signIn)).toEqual([200, undefined]);
  newStaffToken = (signIn.body.session as { accessToken: string }).accessToken;
  const familyId = (
    JSON.parse(Buffer.from(newStaffToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sid: string;
    }
  ).sid;
  const staffClaims = { sub: staffId, tid: tenantId, sid: familyId, role: "owner" as const };
  oldStaffToken = (
    await new StaffTokens(signingConfig(testApiCredentials().jwtKeyFile), new Clock()).sign(staffClaims)
  ).token;
  // A stranger's token that claims the old key's kid: the kid picks the key, and the signature is not that key's.
  strangerStaffToken = await new SignJWT({ typ: "staff", tid: tenantId, roles: ["owner"], sid: familyId })
    .setProtectedHeader({ alg: "EdDSA", kid: oldKid })
    .setSubject(staffId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(loadSigningKey(strangerKeyFile).privateKey);
  tokensMade.push(
    oldCustomerToken,
    oldStaffToken,
    strangerCustomerToken,
    strangerStaffToken,
    newCustomerToken,
    newStaffToken,
  );
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await rotating?.close();
  await after?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
  if (keyFolder !== "") {
    rmSync(keyFolder, { recursive: true, force: true });
  }
});

describe("a rotation of the signing key (JWT_PREVIOUS_PUBLIC_KEY_FILE) [FIX-W48-OTA AC1]", () => {
  it("[FIX-W48-OTA AC1] signs with the new key only, during the overlap as after it", () => {
    expect(newKid).not.toBe(oldKid);
    expect(decodeProtectedHeader(newCustomerToken)).toEqual({ alg: "EdDSA", kid: newKid });
    expect(decodeProtectedHeader(newStaffToken)).toEqual({ alg: "EdDSA", kid: newKid });
    expect([decodeProtectedHeader(oldCustomerToken).kid, decodeProtectedHeader(oldStaffToken).kid]).toEqual([
      oldKid,
      oldKid,
    ]);
  });

  it("[FIX-W48-OTA AC1] accepts the old key's customer and staff tokens while the previous key is configured", async () => {
    const customer = await getSession(rotating, oldCustomerToken);
    const staff = await consoleMe(rotating, oldStaffToken);
    const newCustomer = await getSession(rotating, newCustomerToken);
    const newStaff = await consoleMe(rotating, newStaffToken);

    expect([answer(customer), answer(staff), answer(newCustomer), answer(newStaff)]).toEqual([
      [200, undefined],
      [200, undefined],
      [200, undefined],
      [200, undefined],
    ]);
    expectResponseToMatch("getSession", customer);
    expectResponseToMatch("consoleGetMe", staff);
    expect(customer.body.session.id).toBe(newCustomer.body.session.id);
  });

  it("[FIX-W48-OTA AC1] refuses the old key's tokens once the previous key is removed, and keeps the new key's", async () => {
    const customer = await getSession(after, oldCustomerToken);
    const staff = await consoleMe(after, oldStaffToken);
    const newCustomer = await getSession(after, newCustomerToken);
    const newStaff = await consoleMe(after, newStaffToken);

    expect([answer(customer), answer(staff), answer(newCustomer), answer(newStaff)]).toEqual([
      [401, "UNAUTHENTICATED"],
      [401, "UNAUTHENTICATED"],
      [200, undefined],
      [200, undefined],
    ]);
    expectResponseToMatch("getSession", customer);
    expectResponseToMatch("consoleGetMe", staff);
  });

  it("[FIX-W48-OTA AC1] refuses a token of an unknown kid, and one that claims the old kid with another key, in both", async () => {
    for (const api of [rotating, after]) {
      expect(answer(await getSession(api, strangerCustomerToken))).toEqual([401, "UNAUTHENTICATED"]);
      expect(answer(await consoleMe(api, strangerStaffToken))).toEqual([401, "UNAUTHENTICATED"]);
    }
  });

  it("[FIX-W48-OTA AC1] never writes a token to the log", () => {
    const text = `${rotating.sink.text()}\n${after.sink.text()}`;
    for (const token of tokensMade) {
      expect(text).not.toContain(token);
    }
  });
});
