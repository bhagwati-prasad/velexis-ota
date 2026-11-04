// The rate limits of architecture §8, one test per limit, through the API's real routes (OBE-084 step 2;
// ota/docs/security-review.md §3.2, common/http/rate-limits.ts, OADR-0009 point 8, OADR-0011 points 8 and 9): each
// limit is used up from one end user (an IP address, an e-mail address, a reference, a staff session, a tenant), the
// next request answers `429 RATE_LIMITED` with `Retry-After` within the window, and another end user in the same moment
// is not limited. The request limits count every request the guards let through to the rate-limit guard, so the
// requests carry bodies the validation then refuses (`[]`, placeholder path values) and reach no use case; the
// counters that only count failures (bookings.lookup) or decide in the handler (the customer sign-in lockout, the
// airline card's attempts per checkout and the tenant's decline suspension) are driven through their handlers:
//
//   auth.signIn                       10 per minute per end-user IP (the edge's client address)
//   console.auth.signIn               10 per minute per X-Velexis-End-User-IP through the OTA admin's service caller;
//                                     two end users do not share a bucket, and the service key without the header is
//                                     `400 VALIDATION_FAILED` (OADR-0011 point 9)
//   customer sign-in lockout          5 failures per identity lock it for 15 minutes (`423 ACCOUNT_LOCKED`), whatever
//                                     the address
//   account e-mails                   5 per hour per IP and 3 per hour per e-mail across auth.signUp,
//                                     auth.requestPasswordReset and auth.resendVerification
//   shopping                          30 per minute per IP across flights.search, upsell and price for the edge and
//                                     publishable keys; secret keys are not counted
//   bookings.lookup                   5 failures per 15 minutes per IP and per tenant and reference
//   checkout payments                 10 per minute per IP across checkout.createPayment and checkout.complete
//   checkout.completeWithAirlineCard  5 per minute per IP, 60 per hour per tenant; 3 declined attempts per checkout
//                                     and a suspended method refuse the card unsent (the counters, whose counting
//                                     OBE-051's airline-card-completion.int.test.ts proves with the Amadeus stub, are
//                                     set at their limit here)
//   console operations                600 per minute per staff session or key
//   /v1/assets/*, /v1/files/*         120 per minute per IP across getPublicAsset and downloadFile
//
// Addresses are documentation ranges (RFC 5737, RFC 3849), a new one for every end user, so no limit's bucket meets
// another test's. Edge and publishable-key requests come "through Caddy": `X-Forwarded-For` carries the client address,
// which Express takes as `req.ip` from the loopback peer (`trust proxy loopback`). All requests run in `beforeAll` hooks
// with budgets of their own; the tests read what they answered.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { otaOperations, type OtaOperationId } from "@velexis/api-types/operations";
import { hashApiKey, sha256Hex } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
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
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STOREFRONT_COOKIES } from "../../../src/common/http/cookie-writer";
import { RATE_LIMITS, type RateLimitId } from "../../../src/common/http/rate-limits";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { hashCustomerPassword } from "../../../src/identity/sign-in.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import {
  newApiKey,
  newCsrfToken,
  TEST_STOREFRONT_BASE_DOMAIN,
  testApiCredentials,
} from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;

/** Every limit some test of this file uses up (the coverage test compares it with RATE_LIMITS). */
const EXERCISED = new Set<RateLimitId>();
/** The handler-side counters of architecture §8 that are not throttlers, each with its test below. */
const HANDLER_COUNTERS = ["signInLockout", "airlineCardAttempts", "airlineCardDeclines"] as const;
const EXERCISED_COUNTERS = new Set<(typeof HANDLER_COUNTERS)[number]>();

const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 90_000);
/** The console limit's 601 requests and the tenant's 61 airline-card completions; the budget only stops a hang. */
const LIMIT_TIMEOUT_MS = 120_000;
/** Each other limit's requests: a few dozen, well under a second; the budget allows for a busy 4-CPU runner. */
const SHORT_TIMEOUT_MS = 60_000;

/** Stripe's documented Visa test number: the airline-card body only, never sent anywhere here. */
const TEST_PAN = "4242424242424242";
const PASSWORD = `Fjord-${randomBytes(9).toString("base64url")}`;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;

interface Tenant {
  readonly key: "alpha" | "beta" | "gamma";
  /** The tenant's schema; gamma has none: its requests end at the limits or the validation, before any tenant data. */
  readonly schema: "tenant_alpha" | "tenant_beta" | null;
  readonly host: string;
  id: string;
}
const alpha: Tenant = {
  key: "alpha",
  schema: "tenant_alpha",
  host: `alpha.${TEST_STOREFRONT_BASE_DOMAIN}`,
  id: "",
};
const beta: Tenant = {
  key: "beta",
  schema: "tenant_beta",
  host: `beta.${TEST_STOREFRONT_BASE_DOMAIN}`,
  id: "",
};
/** A third OTA for the per-tenant airline-card limit, whose bucket no other test touches. */
const gamma: Tenant = { key: "gamma", schema: null, host: `gamma.${TEST_STOREFRONT_BASE_DOMAIN}`, id: "" };

let alphaPk = "";
let alphaSk = "";
/** A `console:automation` key of alpha that may read bookings: a key-only console caller with its own bucket. */
let automationKey = "";
/** The signed-in customer of the lockout test. */
let customerEmail = "";

// ---- End users ------------------------------------------------------------------------------------------------------

/**
 * Every end-user value a limit of this file counted (addresses, e-mail addresses, booking references), for the check
 * that none of them is kept in clear in a Redis key or a log line.
 */
const TRACKED_VALUES = new Set<string>();
const tracked = (value: string): string => {
  TRACKED_VALUES.add(value);
  return value;
};

let v4Counter = 0;
let v6Counter = 0;
/** A new IPv4 documentation address (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24): 762 of them. */
function newIpv4(): string {
  v4Counter += 1;
  const nets = ["192.0.2", "198.51.100", "203.0.113"];
  const net = nets[Math.floor((v4Counter - 1) / 254)];
  if (net === undefined) {
    throw new Error("out of IPv4 documentation addresses");
  }
  return tracked(`${net}.${((v4Counter - 1) % 254) + 1}`);
}
/** A new IPv6 /64 of the documentation range: the limits count an IPv6 user per /64. */
function newIpv6(): string {
  v6Counter += 1;
  return tracked(`2001:db8:${(v6Counter >> 16) & 0xffff}:${v6Counter & 0xffff}::1`);
}

const newEmail = (label: string): string => tracked(`${label}-${randomBytes(5).toString("hex")}@example.com`);

// ---- Requests -------------------------------------------------------------------------------------------------------

/** The storefront edge of `tenant` from the client address `ip` (through Caddy), with the CSRF pair of a write. */
function edge(tenant: Tenant, ip: string): Record<string, string> {
  const csrf = newCsrfToken();
  return {
    "X-Velexis-Edge": testApiCredentials().edgeSecret,
    "X-Velexis-Host": tenant.host,
    "X-Forwarded-For": ip,
    "X-Forwarded-Host": tenant.host,
    Origin: `https://${tenant.host}`,
    "X-CSRF-Token": csrf,
    Cookie: `${STOREFRONT_COOKIES.csrf}=${csrf}`,
    "Idempotency-Key": randomUUID(),
  };
}

/** Alpha's publishable key from its storefront origin, from the browser address `ip`. */
const publishable = (ip: string): Record<string, string> => ({
  "X-Api-Key": alphaPk,
  Origin: `https://${alpha.host}`,
  "X-Forwarded-For": ip,
  "Idempotency-Key": randomUUID(),
});

/** Alpha's secret key from a storefront server that forwards its end user's address. */
const secret = (ip: string): Record<string, string> => ({
  "X-Api-Key": alphaSk,
  "X-Velexis-End-User-IP": ip,
  "Idempotency-Key": randomUUID(),
});

/** The OTA admin's server: the service key on the loopback, with the staff member's address (or none). */
function service(ip: string | undefined, bearer?: string): Record<string, string> {
  return {
    "X-Api-Key": testApiCredentials().serviceKey,
    ...(ip === undefined ? {} : { "X-Velexis-End-User-IP": ip }),
    "X-Velexis-End-User-Agent": "Mozilla/5.0 (rate limits)",
    "X-Velexis-Environment": "test",
    "Idempotency-Key": randomUUID(),
    ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
  };
}

const post = (path: string, headers: Record<string, string>, body: unknown = []): Promise<Response> =>
  request(api.server)
    .post(path)
    .set(headers)
    .send(body as object)
    .then();
const get = (path: string, headers: Record<string, string>): Promise<Response> =>
  request(api.server).get(path).set(headers).then();

/** Sends `count` requests one after another, each built by `send(index)`. */
async function times(count: number, send: (index: number) => Promise<Response>): Promise<Response[]> {
  const answers: Response[] = [];
  for (let index = 0; index < count; index += 1) {
    answers.push(await send(index));
  }
  return answers;
}

const codeOf = (res: Response): string | undefined =>
  (res.body as { error?: { code?: string } } | undefined)?.error?.code;
const answer = (res: Response): [number, string | undefined] => [res.status, codeOf(res)];

/**
 * The checks of a limit's refusal: `429 RATE_LIMITED` with `Retry-After` in whole seconds within the window, in the
 * document's error envelope for the operation.
 */
function expectLimited(operationId: OtaOperationId, res: Response, windowSeconds: number): void {
  expect(answer(res)).toEqual([429, "RATE_LIMITED"]);
  const retryAfter = Number(res.headers["retry-after"]);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
  expectResponseToMatch(operationId, res);
}

/** None of the answers is a refusal of a rate limit, and none carries `Retry-After`. */
function expectNotLimited(answers: readonly Response[]): void {
  for (const res of answers) {
    expect(res.status).not.toBe(429);
    expect(res.headers["retry-after"]).toBeUndefined();
  }
}

// ---- Fixtures ------------------------------------------------------------------------------------------------------

async function insertTenant(tenant: Tenant): Promise<void> {
  tenant.id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenant.id,
      key: tenant.key,
      name: `${tenant.key} Travel`,
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/Madrid",
      storefront_environment: "test",
    })
    .execute();
  if (tenant.schema === null) {
    return;
  }
  await tenantTx(tenantDb, tenant.schema, async (trx) => {
    await seedStorefrontSettings(trx, {
      name: `${tenant.key} Travel`,
      defaultCurrency: "EUR",
      defaultLocale: "en",
    });
    await trx.updateTable("storefront_settings").set({ airline_card_enabled_test: true }).execute();
  });
}

async function issueKey(kind: "pk" | "sk", scopes: readonly string[] = []): Promise<string> {
  const key = newApiKey(kind);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: alpha.id,
      name: kind === "pk" ? "Storefront (test)" : `Server ${scopes.join(" ") || "(unscoped)"}`,
      kind: kind === "pk" ? "publishable" : "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
      scopes: [...scopes],
      ...(kind === "pk" ? { allowed_origins: [`https://${alpha.host}`] } : {}),
    })
    .execute();
  return key;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A member of alpha (owner) and a portal token for it, as the platform's createConsoleToken stores one. */
async function portalToken(): Promise<string> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: newEmail("owner"),
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
    .values({ id: staffId, tenant_id: alpha.id, account_id: accountId, role: "owner", status: "active" })
    .execute();
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  await redis.client.set(
    redisKeys.portalToken(sha256Hex(token)).key,
    JSON.stringify({
      v: 1,
      accountId,
      tenantId: alpha.id,
      membershipId: staffId,
      role: "owner",
      mfa: true,
      issuedAt: new Date().toISOString(),
      requestId: randomUUID(),
    }),
    "EX",
    300,
    "NX",
  );
  return token;
}

/** A staff session of a new owner of alpha, through the service key: its access token. */
async function staffSession(): Promise<string> {
  const res = await post("/v1/console/auth/sign-in", service(newIpv6()), {
    grantType: "portal_token",
    portalToken: await portalToken(),
  });
  const token = (res.body as { session?: { accessToken?: string } }).session?.accessToken;
  if (res.status !== 200 || token === undefined) {
    throw new Error(`the staff sign-in answered ${res.status} ${JSON.stringify(res.body)}`);
  }
  return token;
}

async function insertCustomer(passwordHash: string): Promise<string> {
  const id = newId("cus");
  const email = newEmail("lockout");
  await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id,
        email,
        status: "active",
        first_name: "Anna",
        last_name: "Berg",
        email_verified_at: new Date(),
      })
      .execute();
    await trx
      .insertInto("customer_identities")
      .values({
        id: newId("cid"),
        customer_id: id,
        provider: "password",
        provider_subject: email,
        password_hash: passwordHash,
        email,
        email_verified_at: new Date(),
      })
      .execute();
  });
  return email;
}

beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const operation of otaOperations) {
    try {
      checker.check(operation.operationId, { status: 429, body: {} });
    } catch {
      // An operation without a documented 429: nothing to compile.
    }
  }
  let passwordHash: string;
  [db, redis, passwordHash] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    hashCustomerPassword(PASSWORD),
  ]);
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
  await insertTenant(alpha);
  await insertTenant(beta);
  await insertTenant(gamma);
  alphaPk = await issueKey("pk");
  alphaSk = await issueKey("sk", ["storefront"]);
  automationKey = await issueKey("sk", ["console:automation", "bookings:read"]);
  customerEmail = await insertCustomer(passwordHash);
  // AIRLINE_CARD_ENABLED, so that an airline-card completion reaches its limits (step 3 of the completion).
  api = await createTestApp({ database: db, redis, env: { AIRLINE_CARD_ENABLED: "true" } });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

// ---- auth.signIn and console.auth.signIn: 10 per minute per end-user IP ---------------------------------------------

describe("auth.signIn: 10 per minute per end-user IP (architecture §8)", () => {
  let used: Response[];
  let limited: Response;
  let otherIp: Response;
  let forwarded: Response[];
  let forwardedLimited: Response;

  beforeAll(async () => {
    EXERCISED.add("signIn");
    const ip = newIpv4();
    used = await times(10, () => post("/v1/auth/sign-in", edge(alpha, ip)));
    limited = await post("/v1/auth/sign-in", edge(alpha, ip));
    otherIp = await post("/v1/auth/sign-in", edge(alpha, newIpv4()));
    // A storefront server's sign-ins count per the end user's address it forwards, not per the server.
    const endUser = newIpv4();
    forwarded = await times(10, () => post("/v1/auth/sign-in", secret(endUser)));
    forwardedLimited = await post("/v1/auth/sign-in", secret(endUser));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the 11th sign-in in a minute from one address 429 with Retry-After, and another address not", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("signIn", limited, RATE_LIMITS.signIn.windowSeconds);
    expect(answer(otherIp)).toEqual([400, "VALIDATION_FAILED"]);
  });

  it("[OBE-084 AC1] counts a secret key's sign-ins per the X-Velexis-End-User-IP its server forwards", () => {
    expectNotLimited(forwarded);
    expectLimited("signIn", forwardedLimited, RATE_LIMITS.signIn.windowSeconds);
  });
});

describe("console.auth.signIn through the OTA admin's service caller: 10 per minute per forwarded end-user IP", () => {
  let used: Response[];
  let limited: Response;
  let otherEndUser: Response;
  let ipv6Neighbour: Response;
  let missing: Response;
  let invalid: Response;

  beforeAll(async () => {
    const endUser = newIpv4();
    used = await times(10, () => post("/v1/console/auth/sign-in", service(endUser)));
    limited = await post("/v1/console/auth/sign-in", service(endUser));
    // Another staff member signing in through the same admin server in the same moment.
    otherEndUser = await post("/v1/console/auth/sign-in", service(newIpv4()));
    // An IPv6 end user counts per /64: ten from one address, the eleventh from another address of the same /64.
    const net = newIpv6().replace(/::1$/, "");
    await times(10, () => post("/v1/console/auth/sign-in", service(`${net}::1`)));
    ipv6Neighbour = await post("/v1/console/auth/sign-in", service(tracked(`${net}::2`)));
    missing = await post("/v1/console/auth/sign-in", service(undefined));
    invalid = await post("/v1/console/auth/sign-in", service("not-an-address"));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the 11th sign-in of one staff member's address 429, and another staff member's not: the admin server's address is no shared bucket", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("consoleSignIn", limited, RATE_LIMITS.signIn.windowSeconds);
    expect(answer(otherEndUser)).toEqual([400, "VALIDATION_FAILED"]);
    expectLimited("consoleSignIn", ipv6Neighbour, RATE_LIMITS.signIn.windowSeconds);
  });

  it("[OBE-084 AC1] answers the service key without a valid X-Velexis-End-User-IP 400 VALIDATION_FAILED at the header, without its value", () => {
    for (const [res, code] of [
      [missing, "required"],
      [invalid, "format"],
    ] as const) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expect(res.body.error.fieldErrors).toEqual([
        expect.objectContaining({ path: "/header/X-Velexis-End-User-IP", code }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain("not-an-address");
      expectResponseToMatch("consoleSignIn", res);
    }
  });
});

describe("the customer sign-in lockout: 5 failures per identity for 15 minutes (architecture §8, ADR-0008)", () => {
  let failures: Response[];
  let rightPassword: Response;
  let otherCustomer: Response;

  beforeAll(async () => {
    EXERCISED_COUNTERS.add("signInLockout");
    // Every attempt from an address of its own: the lockout counts the identity, not the address.
    failures = await times(5, () =>
      post("/v1/auth/sign-in", edge(alpha, newIpv4()), {
        email: customerEmail,
        password: `${PASSWORD}-wrong`,
      }),
    );
    rightPassword = await post("/v1/auth/sign-in", edge(alpha, newIpv4()), {
      email: customerEmail,
      password: PASSWORD,
    });
    otherCustomer = await post("/v1/auth/sign-in", edge(alpha, newIpv4()), {
      email: newEmail("unknown"),
      password: PASSWORD,
    });
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] refuses the fifth failure and then the right password with 423 ACCOUNT_LOCKED and Retry-After, from any address", () => {
    expect(failures.slice(0, 4).map(answer)).toEqual([1, 2, 3, 4].map(() => [401, "INVALID_CREDENTIALS"]));
    for (const res of [failures[4] as Response, rightPassword]) {
      expect(answer(res)).toEqual([423, "ACCOUNT_LOCKED"]);
      const retryAfter = Number(res.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(15 * 60);
      expectResponseToMatch("signIn", res);
    }
    // Another identity is not locked.
    expect(answer(otherCustomer)).toEqual([401, "INVALID_CREDENTIALS"]);
  });
});

// ---- Account e-mails: 5 per hour per IP, 3 per hour per e-mail ------------------------------------------------------

/** The three operations of the account e-mails' row, as their bodies (each refused by the validation). */
const ACCOUNT_MAIL = [
  { operationId: "signUp", path: "/v1/auth/sign-up" },
  { operationId: "requestPasswordReset", path: "/v1/auth/password-resets" },
  { operationId: "resendEmailVerification", path: "/v1/auth/email-verification/resend" },
] as const;

/** A body with the e-mail the per-e-mail limit counts and a property no schema of the three takes. */
const mailBody = (email: string): JsonObject => ({ email, unexpected: true });

describe("auth.signUp, auth.requestPasswordReset, auth.resendVerification: 5 per hour per IP", () => {
  let used: Response[];
  let limited: Response;
  let otherIp: Response;

  beforeAll(async () => {
    EXERCISED.add("accountMailPerIp");
    const ip = newIpv4();
    // Five requests of the three operations, each with an e-mail of its own: one bucket per address for the row.
    used = await times(5, (index) => {
      const target = ACCOUNT_MAIL[index % ACCOUNT_MAIL.length] ?? ACCOUNT_MAIL[0];
      return post(target.path, edge(alpha, ip), mailBody(newEmail("per-ip")));
    });
    limited = await post("/v1/auth/sign-up", edge(alpha, ip), mailBody(newEmail("per-ip")));
    otherIp = await post("/v1/auth/sign-up", edge(alpha, newIpv4()), mailBody(newEmail("per-ip")));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the sixth account e-mail request of the hour from one address 429, and another address not", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("signUp", limited, RATE_LIMITS.accountMailPerIp.windowSeconds);
    expect(answer(otherIp)).toEqual([400, "VALIDATION_FAILED"]);
  });
});

describe("auth.signUp, auth.requestPasswordReset, auth.resendVerification: 3 per hour per e-mail", () => {
  let used: Response[];
  let limited: Response;
  let upperCase: Response;
  let otherEmail: Response;

  beforeAll(async () => {
    EXERCISED.add("accountMailPerEmail");
    const email = newEmail("per-email");
    // One request of each operation, each from an address of its own: the bucket is the e-mail's.
    used = await Promise.all(
      ACCOUNT_MAIL.map((target) => post(target.path, edge(alpha, newIpv4()), mailBody(email))),
    );
    limited = await post("/v1/auth/password-resets", edge(alpha, newIpv4()), mailBody(email));
    // The address is compared trimmed and in lower case.
    upperCase = await post("/v1/auth/sign-up", edge(alpha, newIpv4()), mailBody(` ${email.toUpperCase()} `));
    otherEmail = await post("/v1/auth/sign-up", edge(alpha, newIpv4()), mailBody(newEmail("per-email")));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the fourth account e-mail request of the hour for one e-mail 429 from any address, and another e-mail not", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("requestPasswordReset", limited, RATE_LIMITS.accountMailPerEmail.windowSeconds);
    expectLimited("signUp", upperCase, RATE_LIMITS.accountMailPerEmail.windowSeconds);
    expect(answer(otherEmail)).toEqual([400, "VALIDATION_FAILED"]);
  });
});

// ---- Shopping: 30 per minute per IP for the edge and publishable keys -------------------------------------------------

describe("flights.search, flights.upsell, flights.price: 30 per minute per IP (edge, pk_)", () => {
  let used: Response[];
  let limited: Response;
  let otherIp: Response;
  let secretKey: Response[];

  beforeAll(async () => {
    EXERCISED.add("shopping");
    const ip = newIpv4();
    const routes = ["/v1/flight-searches", "/v1/flight-offers/~/upsells", "/v1/priced-offers"];
    // The storefront page and its publishable key from one browser address share the bucket.
    used = await times(30, (index) =>
      post(
        routes[index % routes.length] ?? "/v1/flight-searches",
        index % 2 === 0 ? edge(alpha, ip) : publishable(ip),
      ),
    );
    limited = await post("/v1/priced-offers", publishable(ip));
    otherIp = await post("/v1/flight-searches", edge(alpha, newIpv4()));
    // A storefront server with a secret key is not counted (the Amadeus buckets limit it).
    const endUser = newIpv4();
    secretKey = await times(31, () => post("/v1/flight-searches", secret(endUser)));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the 31st shopping request in a minute from one address 429, another address not, and never a secret key", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("priceFlightOffers", limited, RATE_LIMITS.shopping.windowSeconds);
    expect(answer(otherIp)).toEqual([400, "VALIDATION_FAILED"]);
    expectNotLimited(secretKey);
  });
});

// ---- bookings.lookup: 5 failures per 15 minutes per IP and per reference ---------------------------------------------

const lookupBody = (reference: string): JsonObject => ({ bookingReference: reference, lastName: "Sample" });
const newReference = (): string => tracked(`VX${randomBytes(3).toString("hex").toUpperCase()}`);

describe("bookings.lookup: 5 failures per 15 minutes per IP", () => {
  let failures: Response[];
  let limited: Response;
  let otherIp: Response;

  beforeAll(async () => {
    EXERCISED.add("lookupFailuresPerIp");
    const ip = newIpv4();
    failures = await times(5, () => post("/v1/bookings/lookup", edge(alpha, ip), lookupBody(newReference())));
    limited = await post("/v1/bookings/lookup", edge(alpha, ip), lookupBody(newReference()));
    otherIp = await post("/v1/bookings/lookup", edge(alpha, newIpv4()), lookupBody(newReference()));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the lookup after five failures from one address 429 without matching it, and another address not", () => {
    expect(failures.map(answer)).toEqual(failures.map(() => [404, "NOT_FOUND"]));
    expectNotLimited(failures);
    expectLimited("lookupBooking", limited, RATE_LIMITS.lookupFailuresPerIp.windowSeconds);
    expect(answer(otherIp)).toEqual([404, "NOT_FOUND"]);
  });
});

describe("bookings.lookup: 5 failures per 15 minutes per tenant and reference", () => {
  let failures: Response[];
  let limited: Response;
  let otherReference: Response;
  let otherTenant: Response;

  beforeAll(async () => {
    EXERCISED.add("lookupFailuresPerReference");
    const reference = newReference();
    failures = await times(5, () =>
      post("/v1/bookings/lookup", edge(alpha, newIpv4()), lookupBody(reference)),
    );
    // The reference in lower case is the same reference.
    limited = await post("/v1/bookings/lookup", edge(alpha, newIpv4()), lookupBody(reference.toLowerCase()));
    otherReference = await post("/v1/bookings/lookup", edge(alpha, newIpv4()), lookupBody(newReference()));
    // The bucket is the tenant's: another OTA's lookups of the same reference are its own.
    otherTenant = await post("/v1/bookings/lookup", edge(beta, newIpv4()), lookupBody(reference));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the lookup after five failures of one reference 429 from any address, another reference or another OTA not", () => {
    expect(failures.map(answer)).toEqual(failures.map(() => [404, "NOT_FOUND"]));
    expectLimited("lookupBooking", limited, RATE_LIMITS.lookupFailuresPerReference.windowSeconds);
    expect(answer(otherReference)).toEqual([404, "NOT_FOUND"]);
    expect(answer(otherTenant)).toEqual([404, "NOT_FOUND"]);
  });
});

// ---- Checkout payments: 10 per minute per IP ------------------------------------------------------------------------

describe("checkout.createPayment, checkout.complete: 10 per minute per IP", () => {
  let used: Response[];
  let limited: Response;
  let otherIp: Response;

  beforeAll(async () => {
    EXERCISED.add("checkoutPayment");
    const ip = newIpv4();
    used = await times(10, (index) =>
      post(index % 2 === 0 ? "/v1/checkouts/~/payments" : "/v1/checkouts/~/complete", edge(alpha, ip)),
    );
    limited = await post("/v1/checkouts/~/complete", edge(alpha, ip));
    otherIp = await post("/v1/checkouts/~/payments", edge(alpha, newIpv4()));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the 11th payment request in a minute from one address 429, and another address not", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("completeCheckout", limited, RATE_LIMITS.checkoutPayment.windowSeconds);
    expect(answer(otherIp)).toEqual([400, "VALIDATION_FAILED"]);
  });
});

// ---- checkout.completeWithAirlineCard ---------------------------------------------------------------------------------

/** A checkout id of the document's shape that no checkout has: the limits come before the checkout is read. */
const newCheckoutId = (): string => newId("chk");
const AIRLINE_CARD_PATH = (checkoutId: string): string =>
  `/v1/checkouts/${checkoutId}/airline-card-completion`;

/** A well-formed airline-card body: Stripe's test number, a future expiry; it reaches the limits of step 3. */
function airlineCardBody(): JsonObject {
  return {
    paymentId: newId("pay"),
    expectedTotal: { amount: "100.00", currency: "EUR" },
    card: {
      brand: "VISA",
      holderName: "Anna Berg",
      number: TEST_PAN,
      expiryMonth: 12,
      expiryYear: new Date().getUTCFullYear() + 2,
      securityCode: "123",
    },
  };
}

describe("checkout.completeWithAirlineCard: 5 per minute per IP", () => {
  let used: Response[];
  let limited: Response;
  let otherIp: Response;

  beforeAll(async () => {
    EXERCISED.add("airlineCardPerIp");
    const ip = newIpv4();
    used = await times(5, () => post(AIRLINE_CARD_PATH("~"), edge(alpha, ip)));
    limited = await post(AIRLINE_CARD_PATH("~"), edge(alpha, ip));
    otherIp = await post(AIRLINE_CARD_PATH("~"), edge(alpha, newIpv4()));
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the sixth airline-card completion in a minute from one address 429, and another address not", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("completeCheckoutWithAirlineCard", limited, RATE_LIMITS.airlineCardPerIp.windowSeconds);
    expect(answer(otherIp)).toEqual([400, "VALIDATION_FAILED"]);
  });
});

describe("checkout.completeWithAirlineCard: 3 declined attempts per checkout, and 20 declines per tenant and hour", () => {
  let atLimit: Response;
  let belowLimit: Response;
  let suspended: Response;
  let suspendedOtherTenant: Response;
  let leftAfter: { attempts: string | null; suspended: string | null };

  beforeAll(async () => {
    EXERCISED_COUNTERS.add("airlineCardAttempts");
    EXERCISED_COUNTERS.add("airlineCardDeclines");
    // A checkout with three declined cards (the counter as the completion leaves it), and one with two.
    const exhausted = newCheckoutId();
    const attemptsKey = redisKeys.acChk(alpha.id, "test", exhausted);
    await redis.client.set(attemptsKey.key, "3", "EX", attemptsKey.ttlSeconds);
    const twice = newCheckoutId();
    const twiceKey = redisKeys.acChk(alpha.id, "test", twice);
    await redis.client.set(twiceKey.key, "2", "EX", twiceKey.ttlSeconds);
    atLimit = await post(AIRLINE_CARD_PATH(exhausted), edge(alpha, newIpv4()), airlineCardBody());
    belowLimit = await post(AIRLINE_CARD_PATH(twice), edge(alpha, newIpv4()), airlineCardBody());
    // The tenant's 20th decline of the hour sets the suspension flag for an hour.
    const flag = redisKeys.acSuspended(alpha.id, "test");
    await redis.client.set(flag.key, "1", "EX", flag.ttlSeconds);
    suspended = await post(AIRLINE_CARD_PATH(newCheckoutId()), edge(alpha, newIpv4()), airlineCardBody());
    suspendedOtherTenant = await post(
      AIRLINE_CARD_PATH(newCheckoutId()),
      edge(beta, newIpv4()),
      airlineCardBody(),
    );
    leftAfter = {
      attempts: await redis.client.get(attemptsKey.key),
      suspended: await redis.client.get(flag.key),
    };
    await redis.client.del(flag.key);
  }, SHORT_TIMEOUT_MS);

  it("[OBE-084 AC1] refuses a card for a checkout with three declined attempts unsent with 403 PAYMENT_ATTEMPTS_EXCEEDED, and not one with two", () => {
    expect(answer(atLimit)).toEqual([403, "PAYMENT_ATTEMPTS_EXCEEDED"]);
    expectResponseToMatch("completeCheckoutWithAirlineCard", atLimit);
    // Two declines: past the limits, the checkout itself is looked for (none has this id).
    expect(answer(belowLimit)).toEqual([404, "NOT_FOUND"]);
    expect(leftAfter.attempts).toBe("3");
    for (const res of [atLimit, belowLimit]) {
      expect(JSON.stringify(res.body)).not.toContain(TEST_PAN);
    }
  });

  it("[OBE-084 AC1] refuses every card of the tenant while the method is suspended (403 FEATURE_DISABLED, reason suspended), and not another OTA's", () => {
    expect([...answer(suspended), suspended.body.error.details]).toEqual([
      403,
      "FEATURE_DISABLED",
      { feature: "airlineCard", reason: "suspended" },
    ]);
    expectResponseToMatch("completeCheckoutWithAirlineCard", suspended);
    // Another OTA's completion goes on to look for its checkout (none has this id).
    expect(answer(suspendedOtherTenant)).toEqual([404, "NOT_FOUND"]);
    expect(leftAfter.suspended).toBe("1");
  });
});

describe("checkout.completeWithAirlineCard: 60 per hour per tenant", () => {
  let used: Response[];
  let limited: Response;
  let otherTenant: Response;

  beforeAll(async () => {
    EXERCISED.add("airlineCardPerTenant");
    // Gamma's storefront, every completion from a visitor of its own.
    used = await times(60, () => post(AIRLINE_CARD_PATH("~"), edge(gamma, newIpv4())));
    limited = await post(AIRLINE_CARD_PATH("~"), edge(gamma, newIpv4()));
    otherTenant = await post(AIRLINE_CARD_PATH("~"), edge(beta, newIpv4()));
  }, LIMIT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the tenant's 61st airline-card completion of the hour 429 whatever the address, and another OTA's not", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("completeCheckoutWithAirlineCard", limited, RATE_LIMITS.airlineCardPerTenant.windowSeconds);
    expect(answer(otherTenant)).toEqual([400, "VALIDATION_FAILED"]);
  });
});

// ---- Console operations: 600 per minute per staff session or key ------------------------------------------------------

describe("console operations: 600 per minute per staff session or key", () => {
  let used: Response[];
  let limited: Response;
  let otherSession: Response;
  let keyOnly: Response[];
  let keyLimited: Response;
  let otherKey: Response;
  let deniedRows: number;

  beforeAll(async () => {
    EXERCISED.add("console");
    const [first, second] = [await staffSession(), await staffSession()];
    // Every console operation counts in the one bucket of the staff session, from any address.
    used = await times(600, () => get("/v1/console/auth/me", service(newIpv6(), first)));
    limited = await get("/v1/console/bookings", service(newIpv6(), first));
    otherSession = await get("/v1/console/auth/me", service(newIpv6(), second));
    // A key-only console caller has the bucket of its key.
    keyOnly = await times(600, () => get("/v1/console/bookings", { "X-Api-Key": automationKey }));
    keyLimited = await get("/v1/console/bookings", { "X-Api-Key": automationKey });
    const freshKey = await issueKey("sk", ["console:automation", "bookings:read"]);
    otherKey = await get("/v1/console/bookings", { "X-Api-Key": freshKey });
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .selectFrom("staff_actions")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("outcome", "=", "denied")
        .executeTakeFirstOrThrow(),
    );
    deniedRows = Number(rows.count);
  }, LIMIT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers a staff session's 601st console call in a minute 429, and another session not", () => {
    expect(used.map(answer)).toEqual(used.map(() => [200, undefined]));
    expectNotLimited(used);
    expectLimited("consoleListBookings", limited, RATE_LIMITS.console.windowSeconds);
    expect(answer(otherSession)).toEqual([200, undefined]);
  });

  it("[OBE-084 AC1] answers a key-only caller's 601st console call 429, another key not, and writes no staff_actions row for a refusal", () => {
    expect(keyOnly.map(answer)).toEqual(keyOnly.map(() => [200, undefined]));
    expectNotLimited(keyOnly);
    expectLimited("consoleListBookings", keyLimited, RATE_LIMITS.console.windowSeconds);
    expect(answer(otherKey)).toEqual([200, undefined]);
    // OADR-0011 point 8 as decided on 2026-10-21: a 429 is the rate_limit.exceeded line only.
    expect(deniedRows).toBe(0);
    const refusals = api.sink.records().filter((line) => line["msg"] === "rate_limit.exceeded");
    expect(refusals.filter((line) => line["limit"] === RATE_LIMITS.console.name)).toHaveLength(2);
  });
});

// ---- Public downloads: 120 per minute per IP --------------------------------------------------------------------------

describe("/v1/assets/* and /v1/files/*: 120 per minute per IP", () => {
  let used: Response[];
  let limited: Response;
  let otherIp: Response;

  beforeAll(async () => {
    EXERCISED.add("publicDownloads");
    const ip = newIpv4();
    // Images and signed files of every OTA share the visitor's one bucket (no credential: a browser's plain GET).
    used = await times(120, (index) =>
      get(index % 2 === 0 ? "/v1/assets/alpha/~.png" : "/v1/files/~", { "X-Forwarded-For": ip }),
    );
    limited = await get("/v1/assets/beta/~.png", { "X-Forwarded-For": ip });
    otherIp = await get("/v1/files/~", { "X-Forwarded-For": newIpv4() });
  }, LIMIT_TIMEOUT_MS);

  it("[OBE-084 AC1] answers the 121st image or file request in a minute from one address 429, and another address not", () => {
    expect(used.map(answer)).toEqual(used.map(() => [400, "VALIDATION_FAILED"]));
    expectNotLimited(used);
    expectLimited("getPublicAsset", limited, RATE_LIMITS.publicDownloads.windowSeconds);
    expect(answer(otherIp)).toEqual([400, "VALIDATION_FAILED"]);
  });
});

// ---- Coverage --------------------------------------------------------------------------------------------------------

describe("the limits of architecture §8", () => {
  it("[OBE-084 AC1] has a test for every limit of RATE_LIMITS and every handler-side counter", () => {
    expect([...EXERCISED].sort()).toEqual((Object.keys(RATE_LIMITS) as RateLimitId[]).sort());
    expect([...EXERCISED_COUNTERS].sort()).toEqual([...HANDLER_COUNTERS].sort());
  });

  it("[OBE-084 AC1] keeps no counted address, e-mail address or reference in clear in a Redis key or a log line", async () => {
    // The file's own Redis database (useRedis): every key the limits above wrote, the hour-long windows still open.
    const keys = await redis.client.keys("*");
    const throttled = keys.filter((key) => key.startsWith("rl:"));
    // Each throttler counter is `rl:<throttler>:<SHA-256 of the tracker>` (rate-limits.ts, redis.keys.ts).
    expect(throttled.filter((key) => !/^rl:ota_[a-z_]+:[0-9a-f]{64}$/.test(key))).toEqual([]);
    expect(throttled.map((key) => key.split(":")[1])).toEqual(
      expect.arrayContaining([RATE_LIMITS.accountMailPerIp.name, RATE_LIMITS.accountMailPerEmail.name]),
    );
    expect(TRACKED_VALUES.size).toBeGreaterThan(100);
    const text = `${keys.join("\n")}\n${api.sink.text()}`.toLowerCase();
    expect([...TRACKED_VALUES].filter((value) => text.includes(value.toLowerCase()))).toEqual([]);
  });
});
