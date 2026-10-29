// console.settings.templates.list, get, put, preview and reset through the API's whole pipeline (OBE-073; api-changes
// part 2 §2.6, OADR-0013 point 3), against PostgreSQL 16, Redis 7 and Mailpit: the tenant's `notification_templates`
// rows next to the code defaults, If-Match and ETag (and the 412 of a put whose row another transaction inserted while
// it ran, held open by the test until the put waits for it), the 422 TEMPLATE_INVALID of a template that does not
// compile or uses a variable outside its key's allow-list [OF-10 AC3], the staff_actions rows, the permissions, tenant
// isolation, and the next e-mail after a put and after a reset, sent by the worker.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform
// rows as the platform does: alpha and beta active in test, accounts and memberships of the roles used. The settings
// rows and the notification templates are seeded as provisioning seeds them (every key's English default as an `en`
// system row); alpha's storefront also offers `fr`, which has no rows. Staff sign in through the OTA admin's service
// key with portal tokens, as console-access.int.test.ts does. The worker's module graph runs in-process
// (WorkerModule.forRoot, as dist/worker.js builds it) and sends through Mailpit; each e-mail goes to a recipient of
// its own (`uniqueEmail`).
// Every answer is checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { sha256Hex } from "@velexis/crypto";
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
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { uniqueEmail, waitForMessage, type MailpitMessage } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { loadWorkerConfig } from "../../../src/config";
import type { NotificationRow } from "../../../src/notifications/outbox.repository";
import { OutboxService } from "../../../src/notifications/outbox.service";
import { TEMPLATE_KEYS, type TemplateKey } from "../../../src/notifications/templates/registry";
import { seedNotificationTemplates, seedStorefrontSettings } from "../../../src/provisioning/seeds";
import { TenantContext, type RequestTenant } from "../../../src/tenancy/tenant-context";
import { TenantTx } from "../../../src/tenancy/tenant-tx";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testApiCredentials, testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type Role = "owner" | "admin" | "agent" | "viewer";
type Schema = "tenant_alpha" | "tenant_beta";
type Json = Record<string, unknown>;

const TEMPLATES = "/v1/console/settings/notification-templates";
const BRAND = "Alpha Travel";
/** A scenario that sends e-mails through the worker and Mailpit; the bound only stops one that hangs. */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for one e-mail. */
const MAIL_WAIT_MS = 20_000;
/** How long a scenario waits at most for a request to block on a lock that the test holds. */
const LOCK_WAIT_MS = 15_000;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alpha: RequestTenant;
let beta: RequestTenant;

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

/** Inserts an active test tenant of a provisioned test schema and returns its context for use cases. */
async function insertTenant(key: "alpha" | "beta"): Promise<RequestTenant> {
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id: tenantId,
      key,
      name: `${key} (platform name)`,
      status: "active",
      plan_code: "early_access",
      time_zone: "Europe/London",
      storefront_environment: "test",
    })
    .execute();
  return {
    tenantId,
    key,
    schemaName: `tenant_${key}` as TenantSchema,
    environment: "test",
    caller: { type: "anonymous", id: "anonymous" },
    actor: { type: "system", id: null },
    requestId: newId("req"),
  };
}

/** A portal account and its membership in one tenant. */
interface Member {
  readonly accountId: string;
  readonly staffId: string;
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
      time_zone: "Europe/London",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, role };
}

/** A staff member signed in through the OTA admin. */
interface Staff {
  readonly member: Member;
  readonly get: (path: string) => request.Test;
  readonly put: (path: string, body: unknown, ifMatch?: string) => request.Test;
  readonly post: (path: string, body?: unknown) => request.Test;
}

/** Signs a new member with `role` in through a new admin client (its own end-user IP); fails unless it answers 200. */
async function signIn(tenant: RequestTenant, role: Role): Promise<Staff> {
  const member = await insertMember(tenant.tenantId, role);
  const portalToken = newPortalToken();
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: tenant.tenantId,
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
    "X-Velexis-End-User-Agent": `Mozilla/5.0 (OTA admin templates test ${randomBytes(3).toString("hex")})`,
    "X-Velexis-Environment": "test",
  };
  const res = await request(api.server)
    .post("/v1/console/auth/sign-in")
    .set({ ...headers, "Idempotency-Key": randomUUID() })
    .send({ grantType: "portal_token", portalToken });
  expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
  const authorization = `Bearer ${(res.body.session as { accessToken: string }).accessToken}`;
  const signed = (test: request.Test): request.Test => test.set(headers).set("Authorization", authorization);
  return {
    member,
    get: (path) => signed(request(api.server).get(path)),
    put: (path, body, ifMatch) => {
      const req = signed(request(api.server).put(path)).send(body as object);
      return ifMatch === undefined ? req : req.set("If-Match", ifMatch);
    },
    post: (path, body) => {
      const req = signed(request(api.server).post(path));
      return body === undefined ? req : req.send(body as object);
    },
  };
}

/** The path of a template, with `/preview` or `/reset`. */
const templatePath = (key: TemplateKey, locale: string, action?: "preview" | "reset"): string =>
  `${TEMPLATES}/${key}/email/${locale}${action === undefined ? "" : `/${action}`}`;

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** Resolves once another backend of the test database waits for a lock that backend `pid` holds. */
async function untilBlockedBy(pid: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const { rows } = await sql<{ blocked: number }>`
      SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE ${pid}::int = ANY (pg_blocking_pids(pid))
    `.execute(migrator);
    if ((rows[0]?.blocked ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`untilBlockedBy: no backend waited for ${pid} within ${LOCK_WAIT_MS} ms`);
    }
    await new Promise((resolveLater) => setTimeout(resolveLater, 10));
  }
}

/** The `notification_templates` row of `key` and `locale` in `schema`. */
async function templateRow(schema: Schema, key: TemplateKey, locale: string): Promise<Json | undefined> {
  return (await tenantTx(tenantDb, schema, (trx) =>
    trx
      .selectFrom("notification_templates")
      .selectAll()
      .where("key", "=", key)
      .where("channel", "=", "email")
      .where("locale", "=", locale)
      .executeTakeFirst(),
  )) as Json | undefined;
}

/** The staff_actions rows of `staffId` in `schema` but its sign-in's (`staff.sign_in`), oldest first. */
async function staffActions(schema: Schema, staffId: string): Promise<Json[]> {
  return (await tenantTx(tenantDb, schema, (trx) =>
    trx
      .selectFrom("staff_actions")
      .selectAll()
      .where("staff_id", "=", staffId)
      .where("action", "!=", "staff.sign_in")
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  )) as Json[];
}

const GOOD = {
  subject: "Your trip {{booking.reference}} is confirmed",
  bodyHtml:
    "<p>Hello {{booking.contact.firstName}},</p><p>Your booking {{booking.reference}} is confirmed.</p>",
  bodyText: "Hello {{booking.contact.firstName}},\nYour booking {{booking.reference}} is confirmed.",
};

// Cloning the template, building the API's and the worker's module graphs (Nest, pools, Redis and BullMQ connections,
// the OTA document's validators) take several seconds alone and much longer on a busy 4-CPU runner: all of it happens
// once here, with its own budget, and the tests only make calls.
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
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alpha = await insertTenant("alpha");
  beta = await insertTenant("beta");
  await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
    await seedStorefrontSettings(trx, { name: BRAND, defaultCurrency: "EUR", defaultLocale: "en" });
    await trx
      .updateTable("storefront_settings")
      .set({ supported_locales: ["en", "fr"] })
      .execute();
    await seedNotificationTemplates(trx);
  });
  await tenantTx(tenantDb, "tenant_beta", async (trx) => {
    await seedStorefrontSettings(trx, { name: "Beta Trips", defaultCurrency: "GBP", defaultLocale: "fr" });
    await seedNotificationTemplates(trx);
  });
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
    WorkerModule.forRoot(config, { logger: createWorkerLogger(config, new MemorySink()) }),
  );
  await worker.init();
  const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // No scheduler iteration may fire while the file runs.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }

  // The first sign-in, read and write of a process open the pools' connections and warm the token and validation
  // code, and the first check of each operation's answers compiles its response validators: done once here, so that
  // no test pays for it.
  const warmUp = await signIn(alpha, "owner");
  const list = await warmUp.get(TEMPLATES);
  expectResponseToMatch("consoleListNotificationTemplates", list);
  const preview = await warmUp.post(templatePath("booking.cancelled", "fr", "preview"), {});
  expectResponseToMatch("consolePreviewNotificationTemplate", preview);
  const reset = await warmUp.post(templatePath("booking.cancelled", "fr", "reset"));
  expectResponseToMatch("consoleResetNotificationTemplate", reset);
  const fallback = await warmUp.get(templatePath("booking.cancelled", "fr"));
  expectResponseToMatch("consoleGetNotificationTemplate", fallback);
  const refused = await warmUp.put(templatePath("booking.cancelled", "fr"), GOOD, '"1"');
  expectResponseToMatch("consolePutNotificationTemplate", refused);
  expect([list.status, preview.status, reset.status, fallback.status, refused.status]).toEqual([
    200, 200, 200, 200, 412,
  ]);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, OPENAPI_SETUP_TIMEOUT_MS);

describe("console.settings.templates.list and get", () => {
  it("lists every key for every supported locale: the seeded rows customised, the code defaults not, to a viewer, unaudited", async () => {
    const viewer = await signIn(alpha, "viewer");

    const res = await viewer.get(TEMPLATES);

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleListNotificationTemplates", res);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const data = res.body.data as Json[];
    expect(data.map((item) => `${String(item["key"])}/${String(item["locale"])}`)).toEqual(
      [...TEMPLATE_KEYS].sort().flatMap((key) => [`${key}/en`, `${key}/fr`]),
    );
    for (const item of data) {
      expect(item["customised"], `${String(item["key"])}/${String(item["locale"])}`).toBe(
        item["locale"] === "en",
      );
    }
    expect(await staffActions("tenant_alpha", viewer.member.staffId)).toEqual([]);
  });

  it("gets the OTA's row with its ETag, and the code default of a locale without one with none", async () => {
    const viewer = await signIn(alpha, "viewer");

    const own = await viewer.get(templatePath("booking.ticketed", "en"));
    const fallback = await viewer.get(templatePath("booking.ticketed", "fr"));

    for (const res of [own, fallback]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleGetNotificationTemplate", res);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    }
    expect(own.body).toMatchObject({ customised: true, isActive: true, version: 1 });
    expect(own.headers["etag"]).toBe('"1"');
    expect(fallback.body).toMatchObject({ locale: "fr", customised: false, version: null, updatedAt: null });
    expect(fallback.body.subject).toBe(own.body.subject);
    expect(fallback.headers["etag"]).toBeUndefined();
  });
});

describe("console.settings.templates.put", () => {
  it("[OBE-073 AC1] refuses a template that does not compile or uses an unknown variable with 422 TEMPLATE_INVALID, saves nothing and audits the refusal [OF-10 AC3]", async () => {
    const owner = await signIn(alpha, "owner");
    const before = await templateRow("tenant_alpha", "booking.confirmed", "en");

    const res = await owner.put(
      templatePath("booking.confirmed", "en"),
      {
        subject: "Booking {{booking.pnr}}",
        bodyHtml: "<p>Hello</p>\n<p>{{#if booking.reference}}</p>",
        bodyText: "Hello {{customer.password}}",
      },
      '"1"',
    );

    expect(answer(res)).toEqual([422, "TEMPLATE_INVALID"]);
    expectResponseToMatch("consolePutNotificationTemplate", res);
    expect(res.body.error.details.errors).toEqual([
      { part: "subject", line: 1, message: '"booking.pnr" is not a variable of booking.confirmed' },
      { part: "bodyHtml", line: 2, message: expect.stringMatching(/^does not parse/) as unknown },
      { part: "bodyText", line: 1, message: '"customer.password" is not a variable of booking.confirmed' },
    ]);
    expect(await templateRow("tenant_alpha", "booking.confirmed", "en")).toEqual(before);
    expect(await staffActions("tenant_alpha", owner.member.staffId)).toMatchObject([
      { action: "settings.templates.put", outcome: "failed" },
    ]);
  });

  it("replaces the OTA's row with its ETag only, answers the new one, and records the template before and after", async () => {
    const owner = await signIn(alpha, "owner");
    const path = templatePath("booking.not_confirmed", "en");
    const seeded = await templateRow("tenant_alpha", "booking.not_confirmed", "en");

    const missing = await owner.put(path, GOOD);
    const stale = await owner.put(path, GOOD, '"7"');
    const saved = await owner.put(path, { ...GOOD, isActive: false }, '"1"');

    expect(answer(missing)).toEqual([412, "PRECONDITION_FAILED"]);
    expect(answer(stale)).toEqual([412, "PRECONDITION_FAILED"]);
    expect(answer(saved)).toEqual([200, undefined]);
    expectResponseToMatch("consolePutNotificationTemplate", saved);
    expect(saved.headers["etag"]).toBe('"2"');
    expect(saved.body).toMatchObject({ ...GOOD, customised: true, isActive: false, version: 2 });
    expect(await templateRow("tenant_alpha", "booking.not_confirmed", "en")).toMatchObject({
      id: seeded?.["id"],
      subject: GOOD.subject,
      is_system: false,
      is_active: false,
      version: 2,
    });
    const actions = await staffActions("tenant_alpha", owner.member.staffId);
    expect(actions.map((row) => [row["action"], row["outcome"]])).toEqual([
      ["settings.templates.put", "failed"],
      ["settings.templates.put", "failed"],
      ["settings.templates.put", "succeeded"],
    ]);
    expect(actions[2]).toMatchObject({
      target_type: "notification_template",
      target_id: "booking.not_confirmed/email/en",
      before: { id: seeded?.["id"], version: 1, subject: seeded?.["subject"], isActive: true },
      after: { id: seeded?.["id"], version: 2, subject: GOOD.subject, isActive: false },
    });
  });

  it("creates a row of a supported locale without If-Match, and refuses a locale the storefront does not offer", async () => {
    const admin = await signIn(alpha, "admin");

    const withIfMatch = await admin.put(templatePath("booking.cancelled", "fr"), GOOD, '"1"');
    const created = await admin.put(templatePath("booking.cancelled", "fr"), GOOD);
    const unsupported = await admin.put(templatePath("booking.cancelled", "de"), GOOD);

    expect(answer(withIfMatch)).toEqual([412, "PRECONDITION_FAILED"]);
    expect(answer(created)).toEqual([200, undefined]);
    expect(created.body).toMatchObject({ locale: "fr", customised: true, isActive: true, version: 1 });
    expect(created.headers["etag"]).toBe('"1"');
    expect(answer(unsupported)).toEqual([422, "UNPROCESSABLE"]);
    expectResponseToMatch("consolePutNotificationTemplate", unsupported);
    expect(unsupported.body.error.details).toEqual({ reason: "locale_not_supported" });
    expect(await templateRow("tenant_alpha", "booking.cancelled", "de")).toBeUndefined();
  });

  it("is refused to a viewer (settings:write) and to an unknown key, channel or locale", async () => {
    const viewer = await signIn(alpha, "viewer");
    const owner = await signIn(alpha, "owner");

    const denied = await viewer.put(templatePath("booking.cancelled", "en"), GOOD, '"1"');
    const unknownKey = await owner.get(`${TEMPLATES}/booking.lost/email/en`);
    const sms = await owner.get(`${TEMPLATES}/booking.cancelled/sms/en`);
    const badLocale = await owner.get(`${TEMPLATES}/booking.cancelled/email/EN_gb`);

    expect(answer(denied)).toEqual([403, "FORBIDDEN"]);
    expect(denied.body.error.details).toMatchObject({ requiredPermission: "settings:write" });
    for (const res of [unknownKey, sms, badLocale]) {
      expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
    }
    expect(await staffActions("tenant_alpha", viewer.member.staffId)).toMatchObject([
      { action: "settings.templates.put", outcome: "denied" },
    ]);
  });
});

describe("console.settings.templates.put racing another put that inserts the row first", () => {
  const key: TemplateKey = "booking.updated";
  const concurrentId = newId("ntt");
  const CONCURRENT_SUBJECT = "Concurrent {{booking.reference}}";
  let raced: Response;
  let racerId: string;

  // The test's own transaction inserts the row of key/email/fr, which has none, and stays open until the put waits for
  // it (a state of PostgreSQL's lock manager, polled): the put read no row, so it inserts one at version 1, and the
  // unique key makes that insert wait for the open transaction. Its commit turns the put's insert into nothing
  // (ON CONFLICT DO NOTHING), which the put answers with 412: the row it did not know of exists now.
  beforeAll(async () => {
    const owner = await signIn(alpha, "owner");
    racerId = owner.member.staffId;
    let pending: Promise<Response> | undefined;
    await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
      await trx
        .insertInto("notification_templates")
        .values({
          id: concurrentId,
          key,
          channel: "email",
          locale: "fr",
          subject: CONCURRENT_SUBJECT,
          body_html: "<p>{{booking.reference}}</p>",
          body_text: "{{booking.reference}}",
        })
        .execute();
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      // A supertest request is a thenable: resolving it sends the request.
      pending = Promise.resolve(owner.put(templatePath(key, "fr"), GOOD));
      await untilBlockedBy(rows[0]?.pid ?? 0);
    });
    if (pending === undefined) {
      throw new Error("the racing put was never sent");
    }
    raced = await pending;
  }, SCENARIO_TIMEOUT_MS);

  it("answers 412, keeps the row the other put inserted and audits the refusal", async () => {
    expect(answer(raced)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("consolePutNotificationTemplate", raced);
    expect(await templateRow("tenant_alpha", key, "fr")).toMatchObject({
      id: concurrentId,
      subject: CONCURRENT_SUBJECT,
      version: 1,
    });
    expect(await staffActions("tenant_alpha", racerId)).toMatchObject([
      { action: "settings.templates.put", outcome: "failed" },
    ]);
  });
});

describe("console.settings.templates.preview", () => {
  it("renders the stored template with its sample data, and a draft with the variables sent, the HTML escaped", async () => {
    const viewer = await signIn(alpha, "viewer");
    const path = templatePath("booking.ticketing_delayed", "en", "preview");

    const stored = await viewer.post(path);
    const draft = await viewer.post(path, {
      subject: "Delayed: {{booking.reference}}",
      bodyHtml: "<p>{{booking.contact.firstName}}</p>",
      variables: { booking: { reference: "VX7K2Q", contact: { firstName: "<b>Anna</b>" } } },
    });

    for (const res of [stored, draft]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consolePreviewNotificationTemplate", res);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    }
    expect(stored.body.subject).toContain("VX7K2M9Q");
    expect(stored.body.html).toContain("Demo Travel");
    expect(draft.body).toMatchObject({ subject: "Delayed: VX7K2Q", html: "<p>&lt;b&gt;Anna&lt;/b&gt;</p>" });
    expect(draft.body.text).toContain("VX7K2Q");
    // A read: no audit row.
    expect(await staffActions("tenant_alpha", viewer.member.staffId)).toEqual([]);
  });

  it("[OBE-073 AC1] refuses a draft that uses an unknown variable with 422 TEMPLATE_INVALID, and variables outside the allow-list with 400", async () => {
    const viewer = await signIn(alpha, "viewer");
    const path = templatePath("booking.ticketing_delayed", "en", "preview");

    const invalid = await viewer.post(path, { bodyText: "{{booking.pnr}}" });
    const variables = await viewer.post(path, { variables: { booking: { pnr: "ABC123" } } });

    expect(answer(invalid)).toEqual([422, "TEMPLATE_INVALID"]);
    expectResponseToMatch("consolePreviewNotificationTemplate", invalid);
    expect(invalid.body.error.details.errors).toEqual([
      { part: "bodyText", line: 1, message: '"booking.pnr" is not a variable of booking.ticketing_delayed' },
    ]);
    expect(answer(variables)).toEqual([400, "VALIDATION_FAILED"]);
    expect(variables.body.error.fieldErrors).toEqual([
      {
        path: "/variables/booking/pnr",
        code: "additionalProperties",
        message: "is not a variable of booking.ticketing_delayed",
      },
    ]);
  });
});

describe("[OBE-073 AC2] reset", () => {
  const customisedTo = uniqueEmail("obe073-customised");
  const defaultTo = uniqueEmail("obe073-default");
  const key: TemplateKey = "account.email_changed";
  const CUSTOM_SUBJECT = "Custom notice for {{customer.firstName}}";
  let put: Response;
  let reset: Response;
  let repeated: Response;
  let resetterId: string;
  let customised: MailpitMessage;
  let fallback: MailpitMessage;
  let customisedRow: NotificationRow | undefined;
  let fallbackRow: NotificationRow | undefined;
  /** The `ntt_` id of the row the put saved. */
  let savedTemplateId: unknown;

  /** Queues an account.email_changed e-mail to `to` in alpha's context, as account.update does. */
  async function queueEmail(to: string): Promise<string> {
    const tenants = api.app.get(TenantContext, { strict: false });
    const tx = api.app.get(TenantTx, { strict: false });
    const outbox = api.app.get(OutboxService, { strict: false });
    const queued = await tenants.run({ ...alpha, requestId: newId("req") }, () =>
      tx.run((trx) =>
        outbox.enqueue(trx, {
          templateKey: key,
          to,
          locale: "en",
          data: { customer: { firstName: "Alex" }, change: { requestedAt: "2026-11-01T10:00:00Z" } },
          dedupeKey: null,
        }),
      ),
    );
    return queued.notificationId;
  }

  async function notificationRow(id: string): Promise<NotificationRow | undefined> {
    return await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("notifications").selectAll().where("id", "=", id).executeTakeFirst(),
    );
  }

  /**
   * The row of `id` once the worker has marked it sent: Mailpit can hold the message a moment before the worker's
   * update commits, so the row is waited for as a state, at most MAIL_WAIT_MS.
   */
  async function sentRow(id: string): Promise<NotificationRow> {
    return await vi.waitFor(
      async () => {
        const current = await notificationRow(id);
        if (current?.status !== "sent") {
          throw new Error(`the notification ${id} is not sent yet`);
        }
        return current;
      },
      { timeout: MAIL_WAIT_MS, interval: 25 },
    );
  }

  beforeAll(async () => {
    const owner = await signIn(alpha, "owner");
    resetterId = owner.member.staffId;
    const current = await owner.get(templatePath(key, "en"));
    put = await owner.put(
      templatePath(key, "en"),
      {
        subject: CUSTOM_SUBJECT,
        bodyHtml: "<p>Hello {{customer.firstName}}, a change was asked for at {{change.requestedAt}}.</p>",
        bodyText: "Hello {{customer.firstName}}, a change was asked for at {{change.requestedAt}}.",
      },
      current.headers["etag"] as string,
    );
    savedTemplateId = (await templateRow("tenant_alpha", key, "en"))?.["id"];
    const first = await queueEmail(customisedTo);
    customised = await waitForMessage({ to: customisedTo, timeoutMs: MAIL_WAIT_MS });
    customisedRow = await sentRow(first);

    reset = await owner.post(templatePath(key, "en", "reset"));
    repeated = await owner.post(templatePath(key, "en", "reset"));
    const second = await queueEmail(defaultTo);
    fallback = await waitForMessage({ to: defaultTo, timeoutMs: MAIL_WAIT_MS });
    fallbackRow = await sentRow(second);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-073 AC2] the e-mail after a put uses the OTA's template", () => {
    expect(answer(put)).toEqual([200, undefined]);
    expect(put.body).toMatchObject({ subject: CUSTOM_SUBJECT, customised: true, version: 2 });
    expect(customised.Subject).toBe("Custom notice for Alex");
    expect(savedTemplateId).toMatch(/^ntt_/);
    expect(customisedRow).toMatchObject({ status: "sent", template_id: savedTemplateId });
  });

  it("[OBE-073 AC2] reset deletes the row and answers the code default, and the next e-mail uses the code default", async () => {
    expect(answer(reset)).toEqual([200, undefined]);
    expectResponseToMatch("consoleResetNotificationTemplate", reset);
    expect(reset.body).toMatchObject({
      key,
      locale: "en",
      customised: false,
      version: null,
      updatedAt: null,
    });
    expect(reset.headers["etag"]).toBeUndefined();
    expect(await templateRow("tenant_alpha", key, "en")).toBeUndefined();
    expect(fallback.Subject).toBe(`The e-mail address of your ${BRAND} account is being changed`);
    expect(fallbackRow).toMatchObject({ status: "sent", template_id: null });
    // The e-mail sent with the deleted row keeps its key; its template reference is gone with the row.
    expect(await notificationRow(customisedRow?.id ?? "")).toMatchObject({
      template_key: key,
      template_id: null,
    });
  });

  it("a second reset changes nothing and answers the default again; both are audited", async () => {
    expect(answer(repeated)).toEqual([200, undefined]);
    expect(repeated.body).toEqual(reset.body);
    const actions = await staffActions("tenant_alpha", resetterId);
    expect(actions.map((row) => [row["action"], row["outcome"], row["target_id"]])).toEqual([
      ["settings.templates.put", "succeeded", `${key}/email/en`],
      ["settings.templates.reset", "succeeded", `${key}/email/en`],
      ["settings.templates.reset", "succeeded", `${key}/email/en`],
    ]);
    expect(actions[1]).toMatchObject({ before: { subject: CUSTOM_SUBJECT, version: 2 }, after: null });
    expect(actions[2]).toMatchObject({ before: null, after: null });
  });
});

describe("tenant isolation", () => {
  it("keeps one OTA's templates from another: beta never sees or changes alpha's rows", async () => {
    const alphaOwner = await signIn(alpha, "owner");
    const betaOwner = await signIn(beta, "owner");
    const created = await alphaOwner.put(templatePath("staff.manual_review", "fr"), {
      subject: "Alpha review {{booking.reference}}",
      bodyHtml: "<p>{{review.reason}}</p>",
      bodyText: "{{review.reason}}",
    });
    expect(answer(created)).toEqual([200, undefined]);

    const betaView = await betaOwner.get(templatePath("staff.manual_review", "fr"));
    const betaList = await betaOwner.get(TEMPLATES);
    const betaReset = await betaOwner.post(templatePath("staff.manual_review", "fr", "reset"));

    expect(betaView.body).toMatchObject({ customised: false, version: null });
    expect(JSON.stringify(betaList.body)).not.toContain("Alpha review");
    // Beta's storefront offers fr only: its seeded en rows are not listed.
    expect((betaList.body.data as Json[]).every((item) => item["locale"] === "fr")).toBe(true);
    expect(answer(betaReset)).toEqual([200, undefined]);
    expect(await templateRow("tenant_alpha", "staff.manual_review", "fr")).toMatchObject({
      subject: "Alpha review {{booking.reference}}",
    });
  });
});
