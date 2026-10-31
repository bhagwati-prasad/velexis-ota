// Custom storefront domains end to end (OBE-080; ADR-0018 "Custom domain lifecycle", OADR-0009 point 2, OADR-0006
// point 3, PADR-0004 items 4, 5 and 8, PADR-0014 point 5), against PostgreSQL 16, Redis 7 and Mailpit.
//
// The file clones the @velexis/testing template (tenant_alpha provisioned) and plays the platform as velexis_migrator,
// the owner of the platform tables (the OTA backend only reads them): alpha `active` with its sub-domain
// `alpha.ota.example.com` (verified and primary, as createTenant writes it), its storefront settings as provisioning
// seeds them, and an owner who opens the console through the OTA admin's service key with a portal token. The custom
// domain `book.alpha-travel.example` then goes through the lifecycle the platform drives (PBE-049, PBE-050): added
// `pending`, `verified`, made primary (the sub-domain loses the flag in the same transaction), the tenant suspended and
// resumed, and removed (the sub-domain primary again); a second custom domain fails its re-check. After each change the
// platform's `vx:invalidate` event is published on this file's Redis, as the platform publishes it after its commit.
//
// Two processes run in-process on the clone and the Redis database: the API (createTestApp), where the edge (Caddy's
// headers) reaches storefront.get and a search, and the OTA admin reaches console.auth.signIn, me and refresh; and
// the worker (WorkerModule.forRoot, as dist/worker.js builds it), whose ota-notifications consumer renders and sends
// the e-mails through Mailpit. E-mails are queued as the booking and account use cases queue them: in a TenantTx
// transaction of alpha's context through the API's OutboxService, `booking.url` built on the sub-domain with
// renderer.ts `storefrontUrl`, as the cancellation and the other booking use cases build it. Each e-mail goes to a
// recipient of its own (`uniqueEmail`).
//
// The describes run in order and build on each other. Setup and the scenarios that wait for the worker and Mailpit run
// in hooks with explicit budgets; the tests read what they left. The criterion's "within one second" is the bound of
// the waits that follow an invalidation. Every key and token is made up at run time.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { sha256Hex } from "@velexis/crypto";
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
import { extractLinks, uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { loadWorkerConfig } from "../../../src/config";
import { OutboxService, type EnqueueNotificationInput } from "../../../src/notifications/outbox.service";
import { storefrontUrl } from "../../../src/notifications/renderer";
import { TEMPLATE_REGISTRY, type SampleData } from "../../../src/notifications/templates/registry";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { PlatformReadRepository } from "../../../src/tenancy/platform-read.repository";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { TenantContext, type RequestTenant } from "../../../src/tenancy/tenant-context";
import { TenantTx } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import {
  edgeHeaders,
  newCsrfToken,
  testApiCredentials,
  testWorkerVariables,
  TEST_STOREFRONT_BASE_DOMAIN,
} from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * A scenario queues e-mails and waits for the worker to send them through Mailpit: well under a second each locally;
 * the bound allows for CI load and only stops a scenario that hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for one e-mail in Mailpit. */
const MAIL_WAIT_MS = 20_000;
/** The criterion's bound: the storefront follows the platform's invalidation within one second. */
const WITHIN_A_SECOND = { timeout: 1000, interval: 20 } as const;

const SUBDOMAIN_HOST = `alpha.${TEST_STOREFRONT_BASE_DOMAIN}`;
const SUBDOMAIN = `https://${SUBDOMAIN_HOST}`;
/** alpha's custom storefront domain (PADR-0004: a name the platform's host rules accept). */
const CUSTOM_HOST = "book.alpha-travel.example";
const CUSTOM = `https://${CUSTOM_HOST}`;
/** A second custom domain of alpha, which fails its daily re-check (PADR-0004 item 5). */
const SECOND_HOST = "travel.alpha-travel.example";
/** The booking the e-mails are about (they link its page; no row is needed to send them). */
const BOOKING_ID = "bkg_01J9ZA2B4C6D8E0F2G4H6J8K0M";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
const workerSink = new MemorySink();
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let alpha: RequestTenant;
let owner: Member;

const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

// ---- The platform's writes -----------------------------------------------------------------------------------------

/** alpha `active`, its sub-domain verified and primary, as createTenant writes them. */
async function insertAlpha(): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  await insertDomain(id, SUBDOMAIN_HOST, {
    kind: "subdomain",
    verification_status: "verified",
    is_primary: true,
  });
  return id;
}

interface DomainValues {
  readonly kind?: "subdomain" | "custom";
  readonly purpose?: "storefront" | "api" | "console";
  readonly verification_status?: "pending" | "verified" | "failed";
  readonly is_primary?: boolean;
}

/** A `tenant_domains` row (a custom storefront domain, pending, unless told otherwise), as addDomain writes it. */
async function insertDomain(tenantId: string, hostname: string, values: DomainValues = {}): Promise<void> {
  const status = values.verification_status ?? "pending";
  await migrator
    .insertInto("platform.tenant_domains")
    .values({
      id: newId("dom"),
      tenant_id: tenantId,
      hostname,
      kind: values.kind ?? "custom",
      purpose: values.purpose ?? "storefront",
      is_primary: values.is_primary ?? false,
      verification_status: status,
      verification_token: `vx-verify-${randomBytes(20).toString("hex")}`,
      verified_at: status === "verified" ? new Date() : null,
    })
    .execute();
}

/** The verification job's result (PBE-050): `verified`, or `failed` after the re-check failed three times. */
async function setVerification(hostname: string, status: "verified" | "failed"): Promise<void> {
  await migrator
    .updateTable("platform.tenant_domains")
    .set({
      verification_status: status,
      verified_at: status === "verified" ? new Date() : null,
      updated_at: new Date(),
    })
    .where("hostname", "=", hostname)
    .execute();
}

/** makeDomainPrimary (PBE-049): the tenant's other primary storefront host loses the flag before this one gets it. */
async function makePrimary(tenantId: string, hostname: string): Promise<void> {
  await migrator.transaction().execute(async (trx) => {
    await trx
      .updateTable("platform.tenant_domains")
      .set({ is_primary: false, updated_at: new Date() })
      .where("tenant_id", "=", tenantId)
      .where("purpose", "=", "storefront")
      .where("is_primary", "=", true)
      .execute();
    await trx
      .updateTable("platform.tenant_domains")
      .set({ is_primary: true, updated_at: new Date() })
      .where("hostname", "=", hostname)
      .execute();
  });
}

/** removeDomain (PBE-049): the row is deleted, and the sub-domain is primary again when it was the primary one. */
async function removeDomain(tenantId: string, hostname: string): Promise<void> {
  await migrator.transaction().execute(async (trx) => {
    const removed = await trx
      .deleteFrom("platform.tenant_domains")
      .where("hostname", "=", hostname)
      .returning("is_primary")
      .executeTakeFirstOrThrow();
    if (removed.is_primary) {
      await trx
        .updateTable("platform.tenant_domains")
        .set({ is_primary: true, updated_at: new Date() })
        .where("tenant_id", "=", tenantId)
        .where("kind", "=", "subdomain")
        .execute();
    }
  });
}

async function setTenantStatus(tenantId: string, status: "active" | "suspended"): Promise<void> {
  await migrator.updateTable("platform.tenants").set({ status }).where("id", "=", tenantId).execute();
}

/** Publishes an invalidation on `vx:invalidate`, as the platform does after its commit. */
async function publish(...events: InvalidationEvent[]): Promise<void> {
  for (const event of events) {
    await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
  }
}

const domainEvent = (hostname: string): InvalidationEvent => ({ v: 1, type: "domain", hostname });

// ---- The edge ------------------------------------------------------------------------------------------------------

let visitorCount = 0;

/** A visitor's address, a new one per request, so no per-address limit links two requests. */
function nextIp(): string {
  visitorCount += 1;
  return `203.0.113.${(visitorCount % 250) + 1}`;
}

/** storefront.get on `host` as the edge (Caddy's headers). */
function storefrontOn(host: string): Promise<Response> {
  return request(api.server)
    .get("/v1/storefront")
    .set({ ...edgeHeaders(host), "X-Forwarded-For": nextIp() })
    .then((res) => res);
}

/** The tenant key storefront.get answers on `host`, or the refusal's status and code. */
async function servedOn(host: string): Promise<string | [number, unknown]> {
  const res = await storefrontOn(host);
  return res.status === 200 ? (res.body as { tenantKey: string }).tenantKey : answer(res);
}

/** The answer of every host that is not alpha's storefront (OADR-0009 point 2): nothing about the tenant leaks. */
const REFUSED: [number, unknown] = [403, "HOST_NOT_ALLOWED"];

async function expectRefused(host: string): Promise<void> {
  const res = await storefrontOn(host);
  expect([...answer(res), res.body?.error?.details]).toEqual([...REFUSED, { reason: "unknown" }]);
  expectResponseToMatch("getStorefront", res);
}

/**
 * A search posted on `host` as a page of `origin` would post it (CSRF cookie and header, OADR-0006 point 3), with an
 * empty body: a request that passes the CSRF check is refused by the validation that follows (`400`).
 */
function searchFrom(host: string, origin: string): Promise<Response> {
  const csrf = newCsrfToken();
  return request(api.server)
    .post("/v1/flight-searches")
    .set({
      ...edgeHeaders(host),
      "X-Forwarded-For": nextIp(),
      Origin: origin,
      "X-CSRF-Token": csrf,
      Cookie: `__Host-vx_csrf=${csrf}`,
      "Idempotency-Key": randomUUID(),
    })
    .send({})
    .then((res) => res);
}

// ---- The console ---------------------------------------------------------------------------------------------------

interface Member {
  readonly accountId: string;
  readonly staffId: string;
}

async function insertOwner(tenantId: string): Promise<Member> {
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email: `owner.${randomBytes(4).toString("hex")}@example.com`,
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
  return { accountId, staffId };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's createConsoleToken does (PADR-0007). */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: alphaId,
    membershipId: member.staffId,
    role: "owner",
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

const STAFF_HEADERS = {
  "X-Velexis-End-User-IP": "198.51.100.7",
  "X-Velexis-End-User-Agent": "Mozilla/5.0 (custom domains test)",
  "X-Velexis-Environment": "test",
} as const;

/** The console's three answers that carry `ConsoleTenant.storefrontUrl`. */
interface ConsoleStorefrontUrls {
  readonly signIn: unknown;
  readonly me: unknown;
  readonly refresh: unknown;
}

/**
 * `tenant.storefrontUrl` of a new console sign-in of the owner, of console.auth.me right after it and of
 * console.auth.refresh with the sign-in's refresh token.
 */
async function consoleStorefrontUrls(): Promise<ConsoleStorefrontUrls> {
  const signedIn = await request(api.server)
    .post("/v1/console/auth/sign-in")
    .set({ ...STAFF_HEADERS, "X-Api-Key": testApiCredentials().serviceKey, "Idempotency-Key": randomUUID() })
    .send({ grantType: "portal_token", portalToken: await portalTokenFor(owner) });
  expect(answer(signedIn)).toEqual([200, undefined]);
  expectResponseToMatch("consoleSignIn", signedIn);
  const session = signedIn.body as {
    session: { accessToken: string; refreshToken: string };
    tenant: { storefrontUrl?: string };
  };
  const me = await request(api.server)
    .get("/v1/console/auth/me")
    .set({
      ...STAFF_HEADERS,
      "X-Api-Key": testApiCredentials().serviceKey,
      Authorization: `Bearer ${session.session.accessToken}`,
    });
  expect(answer(me)).toEqual([200, undefined]);
  expectResponseToMatch("consoleGetMe", me);
  const refreshed = await request(api.server)
    .post("/v1/console/auth/refresh")
    .set({ ...STAFF_HEADERS, "X-Api-Key": testApiCredentials().serviceKey, "Idempotency-Key": randomUUID() })
    .send({ refreshToken: session.session.refreshToken });
  expect(answer(refreshed)).toEqual([200, undefined]);
  expectResponseToMatch("consoleRefreshSession", refreshed);
  return {
    signIn: session.tenant.storefrontUrl,
    me: (me.body as { tenant: { storefrontUrl?: string } }).tenant.storefrontUrl,
    refresh: (refreshed.body as { tenant: { storefrontUrl?: string } }).tenant.storefrontUrl,
  };
}

// ---- E-mails -------------------------------------------------------------------------------------------------------

/** Queues `input` as a use case of the API does: in a TenantTx transaction of alpha's context. */
async function enqueue(input: EnqueueNotificationInput): Promise<void> {
  const tenants = api.app.get(TenantContext, { strict: false });
  const tx = api.app.get(TenantTx, { strict: false });
  const outbox = api.app.get(OutboxService, { strict: false });
  const queued = await tenants.run(alpha, () => tx.run((trx) => outbox.enqueue(trx, input)));
  expect(queued.queued).toBe(true);
}

/** The links of the e-mails a scenario sends. */
interface SentLinks {
  /** booking.cancelled: the booking page, the brand. */
  readonly booking: readonly string[];
  /** auth.verify_email: the verification link, the brand. */
  readonly account: readonly string[];
  /** The verification token of the account e-mail. */
  readonly token: string;
}

/**
 * Sends a booking.cancelled e-mail (its `booking.url` built on the sub-domain, as the cancellation builds it) and an
 * auth.verify_email e-mail, and answers their links once Mailpit has both.
 */
async function sendEmails(label: string): Promise<SentLinks> {
  const bookingTo = uniqueEmail(`obe080-${label}-booking`);
  const accountTo = uniqueEmail(`obe080-${label}-account`);
  const token = randomBytes(32).toString("base64url");
  await enqueue({
    templateKey: "booking.cancelled",
    to: bookingTo,
    locale: "en",
    data: {
      booking: {
        ...(TEMPLATE_REGISTRY["booking.cancelled"].sampleData["booking"] as SampleData),
        url: `${storefrontUrl("alpha", TEST_STOREFRONT_BASE_DOMAIN)}/booking.html?id=${BOOKING_ID}`,
      },
      refund: { amount: "412.30", currency: "EUR" },
    },
    dedupeKey: null,
  });
  await enqueue({
    templateKey: "auth.verify_email",
    to: accountTo,
    locale: "en",
    data: { customer: { firstName: "Alex" }, expiresAt: "2026-11-02T10:00:00Z" },
    secretData: { token },
    dedupeKey: null,
  });
  const [booking, account] = await Promise.all([
    waitForMessage({ to: bookingTo, timeoutMs: MAIL_WAIT_MS }),
    waitForMessage({ to: accountTo, timeoutMs: MAIL_WAIT_MS }),
  ]);
  return { booking: extractLinks(booking), account: extractLinks(account), token };
}

/** The links an e-mail of `sendEmails` carries on `origin`: the booking page and the brand, the verification link. */
function linksOn(origin: string, token: string): { booking: string[]; account: string[] } {
  return {
    booking: [`${origin}/booking.html?id=${BOOKING_ID}`, origin],
    account: [`${origin}/account/verify.html?token=${token}`, origin],
  };
}

// ---- Setup ---------------------------------------------------------------------------------------------------------

// Cloning the template, parsing the OTA document and starting both module graphs (BullMQ connections, the scheduler
// registration) take a few seconds alone, more on a busy 4-CPU runner: all of it happens once here.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["getStorefront", [200, 403]],
    ["createFlightSearch", [400, 403]],
    ["consoleSignIn", [200]],
    ["consoleGetMe", [200]],
    ["consoleRefreshSession", [200]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
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
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alphaId = await insertAlpha();
  alpha = {
    tenantId: alphaId,
    key: "alpha",
    schemaName: "tenant_alpha" as TenantSchema,
    environment: "test",
    caller: { type: "anonymous", id: "anonymous" },
    actor: { type: "system", id: null },
    requestId: newId("req"),
  };
  owner = await insertOwner(alphaId);
  await tenantTx(tenantDb, "tenant_alpha", (trx) =>
    seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" }),
  );

  api = await createTestApp({ database: db, redis });
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(
    WorkerModule.forRoot(config, { logger: createWorkerLogger(config, workerSink) }),
  );
  await worker.init();
  // No scheduler iteration may fire while the file runs: the e-mails are sent by the `notify` their commit queues.
  const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
}, OPENAPI_SETUP_TIMEOUT_MS);

// ---- The lifecycle -------------------------------------------------------------------------------------------------

describe("a custom domain pending verification", () => {
  it("is not served: 403 HOST_NOT_ALLOWED, while the sub-domain serves the storefront", async () => {
    await insertDomain(alphaId, CUSTOM_HOST);

    await expectRefused(CUSTOM_HOST);
    expect(await servedOn(SUBDOMAIN_HOST)).toBe("alpha");
    // The edge's guards refuse it before the CSRF check, also a write from the domain's own page.
    expect(answer(await searchFrom(CUSTOM_HOST, CUSTOM))).toEqual(REFUSED);
    // Remembered as unknown for 10 s (OADR-0009 point 4), until the platform says otherwise.
    const ttl = await redis.client.ttl(redisKeys.host(CUSTOM_HOST).key);
    expect(ttl > 0 && ttl <= 10).toBe(true);
  });
});

describe("verification", () => {
  it("serves the verified domain within one second of the domain invalidation, in the tenant's storefront environment [OBE-080 AC1]", async () => {
    await setVerification(CUSTOM_HOST, "verified");
    // The cached "unknown" still answers: the invalidation is what ends it, not its 10 s.
    await expectRefused(CUSTOM_HOST);

    await publish(domainEvent(CUSTOM_HOST));

    await vi.waitFor(async () => {
      expect(await servedOn(CUSTOM_HOST)).toBe("alpha");
    }, WITHIN_A_SECOND);
    const res = await storefrontOn(CUSTOM_HOST);
    expect([res.status, (res.body as { environment: string }).environment]).toEqual([200, "test"]);
    expectResponseToMatch("getStorefront", res);
    expect(await servedOn(SUBDOMAIN_HOST)).toBe("alpha");
  });
});

describe("a verified custom domain that is not primary", () => {
  let sent: SentLinks;
  let urls: ConsoleStorefrontUrls;

  beforeAll(async () => {
    sent = await sendEmails("verified");
    urls = await consoleStorefrontUrls();
  }, SCENARIO_TIMEOUT_MS);

  it("leaves the e-mails' links and the console's storefront origin on the sub-domain, still primary", () => {
    expect({ booking: sent.booking, account: sent.account }).toEqual(linksOn(SUBDOMAIN, sent.token));
    expect(urls).toEqual({ signIn: SUBDOMAIN, me: SUBDOMAIN, refresh: SUBDOMAIN });
  });
});

describe("the primary custom domain", () => {
  let sent: SentLinks;
  let urls: ConsoleStorefrontUrls;

  // The platform's makeDomainPrimary, then the e-mails and a console sign-in.
  beforeAll(async () => {
    await makePrimary(alphaId, CUSTOM_HOST);
    await publish(domainEvent(SUBDOMAIN_HOST), domainEvent(CUSTOM_HOST));
    sent = await sendEmails("primary");
    urls = await consoleStorefrontUrls();
  }, SCENARIO_TIMEOUT_MS);

  it("is where the booking e-mails link, and the account e-mails' links too [OBE-080 AC2]", () => {
    expect({ booking: sent.booking, account: sent.account }).toEqual(linksOn(CUSTOM, sent.token));
    expect([...sent.booking, ...sent.account].filter((link) => link.includes(SUBDOMAIN_HOST))).toEqual([]);
  });

  it("is the console's storefront origin (ConsoleTenant.storefrontUrl of sign-in, me and refresh)", () => {
    expect(urls).toEqual({ signIn: CUSTOM, me: CUSTOM, refresh: CUSTOM });
  });

  it("is served, and the sub-domain still is", async () => {
    expect([await servedOn(CUSTOM_HOST), await servedOn(SUBDOMAIN_HOST)]).toEqual(["alpha", "alpha"]);
  });

  it("checks a write's Origin against the request's verified host, on either host", async () => {
    const passed = [await searchFrom(CUSTOM_HOST, CUSTOM), await searchFrom(SUBDOMAIN_HOST, SUBDOMAIN)];
    const crossed = [await searchFrom(CUSTOM_HOST, SUBDOMAIN), await searchFrom(SUBDOMAIN_HOST, CUSTOM)];

    // Past the CSRF check, the empty body is the validation's to refuse.
    for (const res of passed) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
      expectResponseToMatch("createFlightSearch", res);
    }
    // A page of the tenant's other host is another origin (sessions and CSRF cookies are host-only).
    for (const res of crossed) {
      expect([...answer(res), res.body?.error?.details]).toEqual([
        403,
        "CSRF_TOKEN_INVALID",
        { reason: "origin_mismatch" },
      ]);
      expectResponseToMatch("createFlightSearch", res);
    }
  });
});

describe("a suspended tenant", () => {
  let suspendedLinks: SentLinks;
  let custom: string | [number, unknown];
  let subdomain: string | [number, unknown];

  // The platform's tenant.suspend (PADR-0014): the status, then the `tenant` invalidation; e-mails are still sent.
  beforeAll(async () => {
    await setTenantStatus(alphaId, "suspended");
    await publish({ v: 1, type: "tenant", id: alphaId });
    await vi.waitFor(async () => {
      expect(await servedOn(CUSTOM_HOST)).toEqual(REFUSED);
    }, WITHIN_A_SECOND);
    custom = await servedOn(CUSTOM_HOST);
    subdomain = await servedOn(SUBDOMAIN_HOST);
    suspendedLinks = await sendEmails("suspended");
    await setTenantStatus(alphaId, "active");
    await publish({ v: 1, type: "tenant", id: alphaId });
  }, SCENARIO_TIMEOUT_MS);

  it("serves no custom domain (403 HOST_NOT_ALLOWED) and shows its maintenance page on the sub-domain", () => {
    expect(custom).toEqual(REFUSED);
    expect(subdomain).toEqual([403, "TENANT_SUSPENDED"]);
  });

  it("links its e-mails to the sub-domain, which still answers", () => {
    expect({ booking: suspendedLinks.booking, account: suspendedLinks.account }).toEqual(
      linksOn(SUBDOMAIN, suspendedLinks.token),
    );
  });

  it("serves the custom domain again once resumed", async () => {
    await vi.waitFor(async () => {
      expect(await servedOn(CUSTOM_HOST)).toBe("alpha");
    }, WITHIN_A_SECOND);
  });
});

describe("removal", () => {
  it("stops resolving the removed domain within one second of the domain invalidation [OBE-080 AC1]", async () => {
    expect(await servedOn(CUSTOM_HOST)).toBe("alpha");
    await removeDomain(alphaId, CUSTOM_HOST);
    // The cached tenant id still answers: the invalidation is what ends it, not its 60 s.
    expect(await servedOn(CUSTOM_HOST)).toBe("alpha");

    await publish(domainEvent(CUSTOM_HOST), domainEvent(SUBDOMAIN_HOST));

    await vi.waitFor(async () => {
      expect(await servedOn(CUSTOM_HOST)).toEqual(REFUSED);
    }, WITHIN_A_SECOND);
    await expectRefused(CUSTOM_HOST);
    expect(answer(await searchFrom(CUSTOM_HOST, CUSTOM))).toEqual(REFUSED);
    expect(await servedOn(SUBDOMAIN_HOST)).toBe("alpha");
  });
});

describe("after the removal of the primary custom domain", () => {
  let sent: SentLinks;
  let urls: ConsoleStorefrontUrls;

  beforeAll(async () => {
    sent = await sendEmails("removed");
    urls = await consoleStorefrontUrls();
  }, SCENARIO_TIMEOUT_MS);

  it("links the e-mails and the console to the sub-domain, primary again", () => {
    expect({ booking: sent.booking, account: sent.account }).toEqual(linksOn(SUBDOMAIN, sent.token));
    expect(urls).toEqual({ signIn: SUBDOMAIN, me: SUBDOMAIN, refresh: SUBDOMAIN });
  });
});

describe("a failed re-check", () => {
  it("stops serving the domain within one second of the domain invalidation", async () => {
    await insertDomain(alphaId, SECOND_HOST, { verification_status: "verified" });
    await publish(domainEvent(SECOND_HOST));
    await vi.waitFor(async () => {
      expect(await servedOn(SECOND_HOST)).toBe("alpha");
    }, WITHIN_A_SECOND);

    await setVerification(SECOND_HOST, "failed");
    expect(await servedOn(SECOND_HOST)).toBe("alpha");
    await publish(domainEvent(SECOND_HOST));

    await vi.waitFor(async () => {
      expect(await servedOn(SECOND_HOST)).toEqual(REFUSED);
    }, WITHIN_A_SECOND);
    await expectRefused(SECOND_HOST);
  });
});

describe("PlatformReadRepository.primaryStorefrontHost", () => {
  it("answers only a verified, primary custom storefront domain", async () => {
    const repository = api.app.get(PlatformReadRepository, { strict: false });
    const betaId = newId("ten");
    await migrator
      .insertInto("platform.tenants")
      .values({ id: betaId, key: "beta", name: "Beta Travel", status: "active", plan_code: "early_access" })
      .execute();
    const primaryOf = (): Promise<string | null> => repository.primaryStorefrontHost(betaId);
    const seen: Array<string | null> = [await primaryOf()];

    await insertDomain(betaId, "beta.ota.example.com", {
      kind: "subdomain",
      verification_status: "verified",
      is_primary: true,
    });
    seen.push(await primaryOf());
    await insertDomain(betaId, "book.beta-travel.example", { verification_status: "verified" });
    seen.push(await primaryOf());
    // Data the platform's rules never write (only a verified domain becomes primary), read safely all the same.
    await insertDomain(betaId, "pending.beta-travel.example");
    await makePrimary(betaId, "pending.beta-travel.example");
    seen.push(await primaryOf());
    await setVerification("pending.beta-travel.example", "failed");
    seen.push(await primaryOf());
    // The primary host of another purpose is not the storefront's.
    await insertDomain(betaId, "api.beta-travel.example", {
      purpose: "api",
      verification_status: "verified",
      is_primary: true,
    });
    seen.push(await primaryOf());
    await makePrimary(betaId, "book.beta-travel.example");
    seen.push(await primaryOf());

    expect(seen).toEqual([null, null, null, null, null, null, "book.beta-travel.example"]);
    // Not a tenant id: unknown without a query.
    expect(await repository.primaryStorefrontHost("tenant_beta")).toBeNull();
  });
});
