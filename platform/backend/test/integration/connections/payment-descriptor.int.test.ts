// The statement descriptor update (PBE-038; platform/docs/api-inventory-resources.md §4 `updatePaymentConnection`,
// flows/stripe-payments-account.md §A item 3, ADR-0011 Velexis mode, scope PF-60) through the HTTP pipeline
// (createTestApp) on this file's database clone and this worker's Redis database: owners and admins change the card
// statement descriptor suffix of a payment connection with `If-Match`; the row gets `version + 1`, one
// `payments.descriptor_updated` audit row, and `vx:invalidate {type: "connection", tenantId}` follows the commit. A
// suffix that breaks Stripe's rules answers `400 VALIDATION_FAILED` without echoing it, a stale `If-Match` `412`, an
// environment without a connection `404` and a suspended OTA `409 TENANT_NOT_ACTIVE` (also when the suspension commits
// while the change waits for the tenant's row); none of them writes, audits or publishes anything. Every answer is
// checked against the platform document.
//
// OTAs, members and connections are written with the builders; tokens come from the application's TokenService.
// "Nothing was published" is proved without waiting on time: after the request the test publishes a marker event of
// its own to the channel, and Redis delivers the channel's messages in the order it received them, so an event of the
// request (sent before its answer) would arrive before the marker.
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import { PaymentConnectionsService } from "../../../src/payment-connections/payment-connections.service";
import {
  insertAccount,
  insertPaymentConnection,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertOta, type OtaOptions } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API (database clone, Nest module graph, Ajv compilation of the document) takes seconds on CI. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for an event on `vx:invalidate` (delivered within milliseconds when it is sent). */
const EVENT_WAIT_MS = 2_000;
/** How long a test waits for a request to queue behind a row lock (it takes milliseconds). */
const LOCK_WAIT_MS = 3_000;
const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.38";

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;
let publisher: Redis;
const events: InvalidationEvent[] = [];
/** Marker events of this file use tenant ids that no OTA has. */
let markers = 0;

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    events.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
  publisher = new Redis(t.redis.url, { lazyConnect: true });
  await publisher.connect();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await publisher?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

/** An OTA with a member of every role, a stranger, and its `velexis` test connection. */
interface Fixture {
  readonly tenant: PlatformRow<"tenants">;
  readonly members: ReadonlyMap<TenantRole | "stranger", string>;
  readonly connection: PlatformRow<"payment_provider_connections">;
}

async function fixture(tenant: OtaOptions["tenant"] = {}): Promise<Fixture> {
  const ota = await insertOta(pool, { tenant });
  const members = new Map<TenantRole | "stranger", string>();
  for (const role of TENANT_ROLES) {
    const account = await insertAccount(pool);
    await insertMember(pool, ota.tenant, account, role);
    members.set(role, account.id);
  }
  members.set("stranger", (await insertAccount(pool)).id);
  const connection = await insertPaymentConnection(pool, ota.tenant, {
    statement_descriptor_suffix: "AGENCY TRAVEL",
  });
  return { tenant: ota.tenant, members, connection };
}

/** The headers of a portal call by the member of `who`. */
async function as(f: Fixture, who: TenantRole | "stranger"): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: f.members.get(who) ?? "",
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** `PATCH …/payment-connections/{environment}` by `who` with `If-Match: ifMatch` and `body`. */
async function update(
  f: Fixture,
  who: TenantRole | "stranger",
  ifMatch: string,
  body: unknown,
  environment = "test",
): Promise<Response> {
  return t.http
    .patch(`/v1/tenants/${f.tenant.id}/payment-connections/${environment}`)
    .set(await as(f, who))
    .set("If-Match", ifMatch)
    .send(body as object);
}

function errorOf(res: Response): {
  code: string;
  details?: Record<string, unknown>;
  fieldErrors?: Array<{ path: string; code: string }>;
} {
  return (
    res.body as {
      error: {
        code: string;
        details?: Record<string, unknown>;
        fieldErrors?: Array<{ path: string; code: string }>;
      };
    }
  ).error;
}

async function connectionRow(id: string): Promise<PlatformRow<"payment_provider_connections">> {
  const { rows } = await pool.query("SELECT * FROM platform.payment_provider_connections WHERE id = $1", [
    id,
  ]);
  return rows[0] as PlatformRow<"payment_provider_connections">;
}

async function auditRowsOf(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = 'payments.descriptor_updated' ORDER BY id",
    [tenantId],
  );
  return rows as Array<Record<string, unknown>>;
}

const connectionEvent = (tenantId: string): InvalidationEvent => ({ v: 1, type: "connection", tenantId });

/**
 * The events of `vx:invalidate` about `tenantId` that arrived before a marker this function publishes now: every
 * event the API sent before this call, since Redis delivers a channel's messages in the order it received them.
 */
async function eventsSoFarAbout(tenantId: string): Promise<InvalidationEvent[]> {
  markers += 1;
  const marker = connectionEvent(testId("ten", 9900 + markers));
  await publisher.publish(INVALIDATION_CHANNEL, JSON.stringify(marker));
  let seen: InvalidationEvent[] = [];
  await vi.waitFor(
    () => {
      const at = events.findIndex((event) => JSON.stringify(event) === JSON.stringify(marker));
      expect(at).toBeGreaterThanOrEqual(0);
      seen = events.slice(0, at).filter((event) => "tenantId" in event && event.tenantId === tenantId);
    },
    { timeout: EVENT_WAIT_MS },
  );
  return seen;
}

/** How many sessions of this file's database wait for a lock. */
async function waitingOnLocks(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return (rows[0] as { waiting: number }).waiting;
}

/** Asserts that the connection, its audit rows and the invalidations are as `f` wrote them. */
async function expectNothingWritten(f: Fixture): Promise<void> {
  const row = await connectionRow(f.connection.id);
  expect([row.statement_descriptor_suffix, row.version]).toEqual(["AGENCY TRAVEL", f.connection.version]);
  expect(await auditRowsOf(f.tenant.id)).toEqual([]);
  expect(await eventsSoFarAbout(f.tenant.id)).toEqual([]);
}

describe("updatePaymentConnection", () => {
  it("[PBE-038 AC1] saves a valid suffix with If-Match, audits it once and publishes a connection invalidation", async () => {
    const f = await fixture();
    const owner = f.members.get("owner");

    const res = await update(f, "owner", `"${f.connection.version}"`, {
      statementDescriptorSuffix: "ACME TRAVEL 24",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectResponseToMatch("updatePaymentConnection", res, { document: "platform" });
    expect(res.headers["etag"]).toBe(`"${f.connection.version + 1}"`);
    expect(res.body).toEqual({
      id: f.connection.id,
      environment: "test",
      provider: "stripe",
      accountMode: "velexis",
      status: "active",
      accountReference: null,
      publishableKey: null,
      statementDescriptorSuffix: "ACME TRAVEL 24",
      capabilities: {},
      connectedAt: null,
      disconnectedAt: null,
      webhookUrl: null,
      pendingSubmission: null,
      version: f.connection.version + 1,
    });
    const row = await connectionRow(f.connection.id);
    expect(row.statement_descriptor_suffix).toBe("ACME TRAVEL 24");
    expect(row.version).toBe(f.connection.version + 1);
    expect(row.updated_at.toISOString()).toBe(t.clock.now().toISOString());

    const audit = await auditRowsOf(f.tenant.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "account",
      actor_account_id: owner,
      target_type: "payment_connection",
      target_id: f.connection.id,
      tenant_key: f.tenant.key,
      ip_address: PERSON_IP,
      details: {
        environment: "test",
        before: { statementDescriptorSuffix: "AGENCY TRAVEL" },
        after: { statementDescriptorSuffix: "ACME TRAVEL 24" },
      },
    });
    // Exactly one event about the tenant, the connection invalidation.
    expect(await eventsSoFarAbout(f.tenant.id)).toEqual([connectionEvent(f.tenant.id)]);

    // The list answers the new suffix and version, and the new ETag works for the next change.
    const list = await t.http
      .get(`/v1/tenants/${f.tenant.id}/payment-connections`)
      .set(await as(f, "finance"));
    expect(list.body).toMatchObject({
      data: [{ id: f.connection.id, statementDescriptorSuffix: "ACME TRAVEL 24", version: row.version }],
    });
    const next = await update(f, "owner", res.headers["etag"] as string, {
      statementDescriptorSuffix: "ACME",
    });
    expect([next.status, next.headers["etag"]]).toEqual([200, `"${row.version + 1}"`]);
  });

  it("lets owners and admins change the suffix, answers 403 to the other roles and 404 to non-members", async () => {
    const f = await fixture();
    const outcomes: Record<string, number> = {};
    let version = f.connection.version;
    for (const who of [...TENANT_ROLES, "stranger"] as const) {
      const res = await update(f, who, `"${version}"`, { statementDescriptorSuffix: `BRAND ${who}` });
      expectResponseToMatch("updatePaymentConnection", res, { document: "platform" });
      outcomes[who] = res.status;
      if (res.status === 200) {
        version += 1;
      } else {
        expect(errorOf(res).code, who).toBe(who === "stranger" ? "NOT_FOUND" : "FORBIDDEN");
      }
    }

    expect(outcomes).toEqual({
      owner: 200,
      admin: 200,
      agent: 403,
      finance: 403,
      viewer: 403,
      stranger: 404,
    });
    const row = await connectionRow(f.connection.id);
    expect([row.statement_descriptor_suffix, row.version]).toEqual(["BRAND admin", f.connection.version + 2]);
    expect(await auditRowsOf(f.tenant.id)).toHaveLength(2);
  });

  it("[PBE-038 AC1] answers VALIDATION_FAILED for ACME*TRAVEL and a 23-character suffix, and writes nothing", async () => {
    const f = await fixture();
    for (const suffix of ["ACME*TRAVEL", "ABCDEFGHIJKLMNOPQRSTUVW"]) {
      const res = await update(f, "owner", `"${f.connection.version}"`, {
        statementDescriptorSuffix: suffix,
      });

      expect(res.status, suffix).toBe(400);
      expectResponseToMatch("updatePaymentConnection", res, { document: "platform" });
      expect(errorOf(res).code).toBe("VALIDATION_FAILED");
      expect(errorOf(res).fieldErrors).toEqual([
        expect.objectContaining({
          path: "/statementDescriptorSuffix",
          code: suffix.length > 22 ? "maxLength" : "pattern",
        }),
      ]);
      // The answer never echoes the value.
      expect(res.text).not.toContain(suffix);
    }
    for (const body of [
      { statementDescriptorSuffix: " ACME" },
      { statementDescriptorSuffix: "1234" },
      { statementDescriptorSuffix: "ACMÉ TRAVEL" },
      { statementDescriptorSuffix: null },
      {},
      { statementDescriptorSuffix: "ACME", accountMode: "api_keys" },
    ]) {
      const res = await update(f, "admin", `"${f.connection.version}"`, body);
      expect([JSON.stringify(body), res.status, errorOf(res).code]).toEqual([
        JSON.stringify(body),
        400,
        "VALIDATION_FAILED",
      ]);
    }
    await expectNothingWritten(f);
  });

  it("refuses a broken suffix in the service too, before any read, whatever reaches it", async () => {
    const f = await fixture();
    const service = t.app.get(PaymentConnectionsService);
    const membership = {
      membershipId: testId("stf", 9901),
      tenantId: f.tenant.id,
      accountId: f.members.get("owner") ?? "",
      role: "owner" as const,
    };

    for (const [suffix, code] of [
      ["ACME*TRAVEL", "forbiddenCharacter"],
      ["A".repeat(23), "maxLength"],
      [" ACME", "start"],
    ] as const) {
      const failure = await service
        .updateStatementDescriptor(membership, "test", f.connection.version, suffix)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({
        code: "VALIDATION_FAILED",
        fieldErrors: [expect.objectContaining({ path: "/statementDescriptorSuffix", code })],
      });
    }
    await expectNothingWritten(f);
  });

  it("[PBE-038 AC1] answers 412 PRECONDITION_FAILED for a stale If-Match and writes nothing", async () => {
    const f = await fixture();
    for (const ifMatch of [`"${f.connection.version + 1}"`, `"${f.connection.version + 5}"`, '"0"']) {
      const res = await update(f, "owner", ifMatch, { statementDescriptorSuffix: "ACME TRAVEL" });

      expect([ifMatch, res.status, errorOf(res).code]).toEqual([ifMatch, 412, "PRECONDITION_FAILED"]);
      expectResponseToMatch("updatePaymentConnection", res, { document: "platform" });
    }
    // An If-Match that is no quoted version is refused by the validation.
    const unquoted = await update(f, "owner", String(f.connection.version), {
      statementDescriptorSuffix: "ACME TRAVEL",
    });
    expect([unquoted.status, errorOf(unquoted).fieldErrors]).toEqual([
      400,
      [expect.objectContaining({ path: "/header/If-Match" })],
    ]);
    await expectNothingWritten(f);
  });

  it("answers 404 for an environment without a connection and 409 TENANT_NOT_ACTIVE for a suspended OTA", async () => {
    const f = await fixture();
    const live = await update(f, "owner", '"1"', { statementDescriptorSuffix: "ACME TRAVEL" }, "live");
    expect([live.status, errorOf(live).code]).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("updatePaymentConnection", live, { document: "platform" });
    const unknown = await update(f, "owner", '"1"', { statementDescriptorSuffix: "ACME TRAVEL" }, "staging");
    expect([unknown.status, errorOf(unknown).code]).toEqual([400, "VALIDATION_FAILED"]);
    await expectNothingWritten(f);

    const suspended = await fixture({
      status: "suspended",
      suspension_reason: "abuse",
      suspended_at: new Date("2026-01-14T09:00:00Z"),
    });
    const res = await update(suspended, "owner", `"${suspended.connection.version}"`, {
      statementDescriptorSuffix: "ACME TRAVEL",
    });
    expect([res.status, errorOf(res).code, errorOf(res).details]).toEqual([
      409,
      "TENANT_NOT_ACTIVE",
      { status: "suspended" },
    ]);
    expectResponseToMatch("updatePaymentConnection", res, { document: "platform" });
    // A stale If-Match is answered first, as updateTenant does.
    const stale = await update(suspended, "owner", `"${suspended.connection.version + 1}"`, {
      statementDescriptorSuffix: "ACME TRAVEL",
    });
    expect([stale.status, errorOf(stale).code]).toEqual([412, "PRECONDITION_FAILED"]);
    await expectNothingWritten(suspended);
  });

  it("waits for a suspension in progress and then answers 409 TENANT_NOT_ACTIVE: the tenant's row is read FOR SHARE", async () => {
    const f = await fixture();
    // A suspension in progress: the tenant's row locked and changed by a transaction of the test, not yet committed.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "UPDATE platform.tenants SET status = 'suspended', suspension_reason = 'abuse', suspended_at = now() " +
          "WHERE id = $1",
        [f.tenant.id],
      );
      const answer = update(f, "owner", `"${f.connection.version}"`, {
        statementDescriptorSuffix: "ACME TRAVEL",
      });
      // Awaited below; a failure before then must not count as unhandled.
      void answer.catch(() => undefined);
      // The request waits for the row (the guard's plain read does not wait); a read without the lock would see the
      // committed `active` status, write the suffix and never wait.
      await expect.poll(waitingOnLocks, { timeout: LOCK_WAIT_MS, interval: 20 }).toBe(1);
      await holder.query("COMMIT");

      const res = await answer;
      expect([res.status, errorOf(res).code, errorOf(res).details]).toEqual([
        409,
        "TENANT_NOT_ACTIVE",
        { status: "suspended" },
      ]);
    } catch (error) {
      await holder.query("ROLLBACK");
      throw error;
    } finally {
      holder.release();
    }
    await expectNothingWritten(f);
  });

  it("answers 404 in the service for a tenant that members no longer see, and writes nothing", async () => {
    // TenantRoleGuard answers 404 for such a tenant before the handler runs; the service re-reads the status under its
    // lock, so a tenant whose deprovisioning started after the guard's read is not changed either.
    const f = await fixture({ status: "deprovisioning" });
    const service = t.app.get(PaymentConnectionsService);
    const membership = {
      membershipId: testId("stf", 9902),
      tenantId: f.tenant.id,
      accountId: f.members.get("owner") ?? "",
      role: "owner" as const,
    };

    const failure = await service
      .updateStatementDescriptor(membership, "test", f.connection.version, "ACME TRAVEL")
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "NOT_FOUND" });
    await expectNothingWritten(f);
  });

  it("answers the connection as it is for the suffix it already has: no write, no audit row, no invalidation", async () => {
    const f = await fixture();
    const res = await update(f, "admin", `"${f.connection.version}"`, {
      statementDescriptorSuffix: "AGENCY TRAVEL",
    });

    expect(res.status).toBe(200);
    expectResponseToMatch("updatePaymentConnection", res, { document: "platform" });
    expect(res.headers["etag"]).toBe(`"${f.connection.version}"`);
    expect(res.body).toMatchObject({
      statementDescriptorSuffix: "AGENCY TRAVEL",
      version: f.connection.version,
    });
    await expectNothingWritten(f);
  });
});
