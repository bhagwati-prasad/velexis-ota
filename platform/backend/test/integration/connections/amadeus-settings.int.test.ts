// The Amadeus connection settings update (PBE-040; platform/docs/api-inventory-resources.md §3
// `updateAmadeusConnection`, flows/amadeus-connection.md §E, ADR-0012 office isolation, scope PF-53) through the HTTP
// pipeline (createTestApp) on this file's database clone and this worker's Redis database: owners and admins change the
// default, queuing and owner offices, the ticketing defaults and the monitored queues of a connection with `If-Match`;
// the row gets `version + 1`, one `amadeus.settings_updated` audit row, and `vx:invalidate {type: "connection",
// tenantId}` follows the commit. An office id of the body outside the connection's `office_ids` answers `400
// VALIDATION_FAILED` at its field, a body that breaks the schema `400` too, a stale `If-Match` `412` (also when another
// change commits while this one waits for the connection's row), an environment without a connection `404` and a
// suspended OTA `409 TENANT_NOT_ACTIVE` (also when the suspension commits while the change waits for the tenant's row);
// none of them writes, audits or publishes anything. Every answer is checked against the platform document.
//
// OTAs, members, the Velexis test account and the connections are written with the builders; tokens come from the
// application's TokenService. "Nothing was published" is proved without waiting on time: after the request the test
// publishes a marker event of its own to the channel, and Redis delivers the channel's messages in the order it
// received them, so an event of the request (sent before its answer) would arrive before the marker.
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { AppError } from "@velexis/errors";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import { ConnectionsService } from "../../../src/supplier-connections/connections.service";
import {
  insertAccount,
  insertAmadeusAccount,
  insertSupplierConnection,
  testId,
  velexisSource,
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
const PERSON_IP = "203.0.113.39";
/** The two offices of every connection of this file, and an office that is none of them. */
const NICE = "NCE1A0955";
const PARIS = "PAR1A0001";
const FOREIGN = "LON1A0777";

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;
let publisher: Redis;
/** The Velexis shared account of the `test` environment (one per environment). */
let velexisAccount: PlatformRow<"amadeus_accounts">;
const events: InvalidationEvent[] = [];
/** Marker events of this file use tenant ids that no OTA has. */
let markers = 0;

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  velexisAccount = await insertAmadeusAccount(pool);

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

/** An OTA with a member of every role, a stranger, and its `velexis` test connection on NICE and PARIS. */
interface Fixture {
  readonly tenant: PlatformRow<"tenants">;
  readonly members: ReadonlyMap<TenantRole | "stranger", string>;
  readonly connection: PlatformRow<"supplier_connections">;
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
  const connection = await insertSupplierConnection(pool, ota.tenant, {
    ...velexisSource(velexisAccount),
    office_ids: [NICE, PARIS],
    default_office_id: NICE,
    queuing_office_id: NICE,
    owner_office_id: NICE,
    status: "active",
    last_verified_at: new Date("2026-10-14T08:20:15.000Z"),
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

/** `PATCH …/amadeus-connections/{environment}` by `who` with `If-Match: ifMatch` and `body`. */
async function update(
  f: Fixture,
  who: TenantRole | "stranger",
  ifMatch: string,
  body: unknown,
  environment = "test",
): Promise<Response> {
  return t.http
    .patch(`/v1/tenants/${f.tenant.id}/amadeus-connections/${environment}`)
    .set(await as(f, who))
    .set("If-Match", ifMatch)
    .send(body as object);
}

interface ErrorBody {
  code: string;
  details?: Record<string, unknown>;
  fieldErrors?: Array<{ path: string; code: string; message?: string }>;
}

function errorOf(res: Response): ErrorBody {
  return (res.body as { error: ErrorBody }).error;
}

async function connectionRow(id: string): Promise<PlatformRow<"supplier_connections">> {
  const { rows } = await pool.query("SELECT * FROM platform.supplier_connections WHERE id = $1", [id]);
  return rows[0] as PlatformRow<"supplier_connections">;
}

async function auditRowsOf(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = 'amadeus.settings_updated' ORDER BY id",
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

/** The settings columns and the version of a connection row. */
function settingsOf(row: PlatformRow<"supplier_connections">): Record<string, unknown> {
  return {
    officeIds: row.office_ids,
    defaultOfficeId: row.default_office_id,
    queuingOfficeId: row.queuing_office_id,
    ownerOfficeId: row.owner_office_id,
    ticketingDefaults: row.ticketing_defaults,
    monitoredQueues: row.monitored_queues,
    version: row.version,
  };
}

/** Asserts that the connection, its audit rows and the invalidations are as `f` wrote them. */
async function expectNothingWritten(f: Fixture): Promise<void> {
  expect(settingsOf(await connectionRow(f.connection.id))).toEqual(settingsOf(f.connection));
  expect(await auditRowsOf(f.tenant.id)).toEqual([]);
  expect(await eventsSoFarAbout(f.tenant.id)).toEqual([]);
}

/** Ticketing defaults with every field of `AmadeusTicketingDefaults`, on the connection's offices. */
const TICKETING_DEFAULTS = {
  ticketingAgreement: { option: "DELAY_TO_CANCEL", delay: "2D" },
  automatedProcess: [
    { code: "IMMEDIATE", queue: { number: "8", category: "0" }, officeId: PARIS },
    { code: "DELAYED", delay: "1D", text: "Review before ticketing" },
  ],
  issue: false,
};
const MONITORED_QUEUES = [
  { officeId: PARIS, queueId: 8, category: 0 },
  { officeId: NICE, queueId: 99, category: 254 },
];

describe("updateAmadeusConnection", () => {
  it("[PBE-040 AC1] saves valid settings with If-Match, audits them once and publishes a connection invalidation", async () => {
    const f = await fixture();
    const owner = f.members.get("owner");

    const res = await update(f, "owner", `"${f.connection.version}"`, {
      defaultOfficeId: PARIS,
      queuingOfficeId: PARIS,
      ownerOfficeId: NICE,
      ticketingDefaults: TICKETING_DEFAULTS,
      monitoredQueues: MONITORED_QUEUES,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectResponseToMatch("updateAmadeusConnection", res, { document: "platform" });
    expect(res.headers["etag"]).toBe(`"${f.connection.version + 1}"`);
    expect(res.body).toEqual({
      id: f.connection.id,
      environment: "test",
      credentialSource: "velexis",
      status: "active",
      officeIds: [NICE, PARIS],
      defaultOfficeId: PARIS,
      queuingOfficeId: PARIS,
      ownerOfficeId: NICE,
      clientId: null,
      ticketingDefaults: TICKETING_DEFAULTS,
      monitoredQueues: MONITORED_QUEUES,
      lastVerifiedAt: "2026-10-14T08:20:15.000Z",
      lastError: null,
      pendingSubmission: null,
      version: f.connection.version + 1,
    });
    const row = await connectionRow(f.connection.id);
    expect(settingsOf(row)).toEqual({
      officeIds: [NICE, PARIS],
      defaultOfficeId: PARIS,
      queuingOfficeId: PARIS,
      ownerOfficeId: NICE,
      ticketingDefaults: TICKETING_DEFAULTS,
      monitoredQueues: MONITORED_QUEUES,
      version: f.connection.version + 1,
    });
    // The jsonb columns hold JSON values (an object and a list), not JSON text.
    const { rows: types } = await pool.query(
      "SELECT jsonb_typeof(ticketing_defaults) AS ticketing, jsonb_typeof(monitored_queues) AS queues " +
        "FROM platform.supplier_connections WHERE id = $1",
      [f.connection.id],
    );
    expect(types).toEqual([{ ticketing: "object", queues: "array" }]);
    expect(row.updated_at.toISOString()).toBe(t.clock.now().toISOString());
    // Credentials, account, status and offices stay as they were.
    expect([row.credential_source, row.amadeus_account_id, row.status]).toEqual([
      "velexis",
      velexisAccount.id,
      "active",
    ]);

    const audit = await auditRowsOf(f.tenant.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "account",
      actor_account_id: owner,
      target_type: "supplier_connection",
      target_id: f.connection.id,
      tenant_key: f.tenant.key,
      ip_address: PERSON_IP,
      details: {
        environment: "test",
        before: {
          defaultOfficeId: NICE,
          queuingOfficeId: NICE,
          ticketingDefaults: {},
          monitoredQueues: [],
        },
        after: {
          defaultOfficeId: PARIS,
          queuingOfficeId: PARIS,
          ticketingDefaults: TICKETING_DEFAULTS,
          monitoredQueues: MONITORED_QUEUES,
        },
      },
    });
    // Only the changed fields: the owner office was NICE already.
    const details = audit[0]?.["details"] as { before: object; after: object };
    expect(Object.keys(details.before)).not.toContain("ownerOfficeId");
    // Exactly one event about the tenant, the connection invalidation.
    expect(await eventsSoFarAbout(f.tenant.id)).toEqual([connectionEvent(f.tenant.id)]);

    // The list answers the new settings and version, and the new ETag works for the next change.
    const list = await t.http
      .get(`/v1/tenants/${f.tenant.id}/amadeus-connections`)
      .set(await as(f, "finance"));
    expect(list.body).toEqual({ data: [res.body] });
    const next = await update(f, "admin", res.headers["etag"] as string, { monitoredQueues: [] });
    expect([next.status, next.headers["etag"]]).toEqual([200, `"${row.version + 1}"`]);
    expectResponseToMatch("updateAmadeusConnection", next, { document: "platform" });
    // A field that is not sent keeps its value; `[]` stops polling.
    expect(settingsOf(await connectionRow(f.connection.id))).toMatchObject({
      defaultOfficeId: PARIS,
      ticketingDefaults: TICKETING_DEFAULTS,
      monitoredQueues: [],
      version: row.version + 1,
    });
    expect(await auditRowsOf(f.tenant.id)).toHaveLength(2);
    expect(await eventsSoFarAbout(f.tenant.id)).toEqual([
      connectionEvent(f.tenant.id),
      connectionEvent(f.tenant.id),
    ]);
  });

  it("lets owners and admins change the settings, answers 403 to the other roles and 404 to non-members", async () => {
    const f = await fixture();
    const outcomes: Record<string, number> = {};
    let version = f.connection.version;
    // Each successful change moves the default office to the other office: PARIS, then NICE, …
    const offices = [PARIS, NICE];
    for (const who of [...TENANT_ROLES, "stranger"] as const) {
      const res = await update(f, who, `"${version}"`, {
        defaultOfficeId: offices[(version - f.connection.version) % 2],
      });
      expectResponseToMatch("updateAmadeusConnection", res, { document: "platform" });
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
    expect(row.version).toBe(f.connection.version + 2);
    expect(await auditRowsOf(f.tenant.id)).toHaveLength(2);
  });

  it("[PBE-040 AC1] answers VALIDATION_FAILED for a default office outside office_ids, and for any other office of the body that is not the connection's", async () => {
    const f = await fixture();
    const ifMatch = `"${f.connection.version}"`;

    const res = await update(f, "owner", ifMatch, { defaultOfficeId: FOREIGN });

    expect(res.status).toBe(400);
    expectResponseToMatch("updateAmadeusConnection", res, { document: "platform" });
    expect(errorOf(res)).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [{ path: "/defaultOfficeId", code: "unknown" }],
    });
    // The answer never echoes the value.
    expect(res.text).not.toContain(FOREIGN);

    // Every office of the body is checked, and every field outside the offices is named in one answer.
    const all = await update(f, "admin", ifMatch, {
      defaultOfficeId: NICE,
      queuingOfficeId: FOREIGN,
      ownerOfficeId: FOREIGN,
      ticketingDefaults: {
        automatedProcess: [
          { code: "IMMEDIATE", officeId: PARIS },
          { code: "ERROR", officeId: FOREIGN },
        ],
      },
      monitoredQueues: [
        { officeId: NICE, queueId: 1, category: 0 },
        { officeId: FOREIGN, queueId: 8, category: 0 },
      ],
    });
    expect([all.status, errorOf(all).code]).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch("updateAmadeusConnection", all, { document: "platform" });
    expect(errorOf(all).fieldErrors?.map(({ path }) => path)).toEqual([
      "/queuingOfficeId",
      "/ownerOfficeId",
      "/ticketingDefaults/automatedProcess/1/officeId",
      "/monitoredQueues/1/officeId",
    ]);
    await expectNothingWritten(f);
  });

  it("[PBE-040 AC1] refuses settings that break the schema with VALIDATION_FAILED at the field, and writes nothing", async () => {
    const f = await fixture();
    const queue = { officeId: NICE, queueId: 8, category: 0 };
    const refused: ReadonlyArray<readonly [unknown, string]> = [
      [{}, ""],
      [{ officeIds: [NICE] }, "/officeIds"],
      [{ status: "disabled" }, "/status"],
      [{ defaultOfficeId: "nce1a0955" }, "/defaultOfficeId"],
      [{ queuingOfficeId: null }, "/queuingOfficeId"],
      [
        { ticketingDefaults: { ticketingAgreement: { option: "LATER" } } },
        "/ticketingDefaults/ticketingAgreement/option",
      ],
      [{ ticketingDefaults: { issue: "yes" } }, "/ticketingDefaults/issue"],
      [{ monitoredQueues: [{ ...queue, queueId: 100 }] }, "/monitoredQueues/0/queueId"],
      [{ monitoredQueues: [{ officeId: NICE, queueId: 8 }] }, "/monitoredQueues/0/category"],
      [{ monitoredQueues: [queue, queue] }, "/monitoredQueues"],
      [
        { monitoredQueues: Array.from({ length: 21 }, (_, queueId) => ({ ...queue, queueId })) },
        "/monitoredQueues",
      ],
    ];
    for (const [body, path] of refused) {
      const res = await update(f, "owner", `"${f.connection.version}"`, body);
      expect([body, res.status, errorOf(res).code]).toEqual([body, 400, "VALIDATION_FAILED"]);
      expect([body, errorOf(res).fieldErrors?.map((error) => error.path)]).toEqual([
        body,
        expect.arrayContaining([path]),
      ]);
      expectResponseToMatch("updateAmadeusConnection", res, { document: "platform" });
    }
    await expectNothingWritten(f);
  });

  it("[PBE-040 AC1] answers 412 PRECONDITION_FAILED for a stale If-Match and writes nothing", async () => {
    const f = await fixture();
    for (const ifMatch of [`"${f.connection.version + 1}"`, `"${f.connection.version + 5}"`, '"0"']) {
      const res = await update(f, "owner", ifMatch, { defaultOfficeId: PARIS });

      expect([ifMatch, res.status, errorOf(res).code]).toEqual([ifMatch, 412, "PRECONDITION_FAILED"]);
      expectResponseToMatch("updateAmadeusConnection", res, { document: "platform" });
    }
    // A stale version is answered before the offices are checked: the caller reloads them first.
    const staleForeign = await update(f, "owner", `"${f.connection.version + 1}"`, {
      defaultOfficeId: FOREIGN,
    });
    expect([staleForeign.status, errorOf(staleForeign).code]).toEqual([412, "PRECONDITION_FAILED"]);
    // An If-Match that is no quoted version is refused by the validation.
    const unquoted = await update(f, "owner", String(f.connection.version), { defaultOfficeId: PARIS });
    expect([unquoted.status, errorOf(unquoted).fieldErrors]).toEqual([
      400,
      [expect.objectContaining({ path: "/header/If-Match" })],
    ]);
    await expectNothingWritten(f);
  });

  it("[PBE-040 AC1] answers 412 PRECONDITION_FAILED when another change commits while it waits for the connection's row", async () => {
    const f = await fixture();
    // Another change of the connection in progress: the row locked and moved to the next version by a transaction of
    // the test, not yet committed.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "UPDATE platform.supplier_connections SET default_office_id = $2, version = version + 1 WHERE id = $1",
        [f.connection.id, PARIS],
      );
      const answer = update(f, "owner", `"${f.connection.version}"`, { queuingOfficeId: PARIS });
      // Awaited below; a failure before then must not count as unhandled.
      void answer.catch(() => undefined);
      // The request waits for the row; a read without `FOR UPDATE` would see the committed version, pass the check and
      // overwrite the other change (a lost update) instead of answering 412.
      await expect.poll(waitingOnLocks, { timeout: LOCK_WAIT_MS, interval: 20 }).toBe(1);
      await holder.query("COMMIT");

      const res = await answer;
      expect([res.status, errorOf(res).code]).toEqual([412, "PRECONDITION_FAILED"]);
      expectResponseToMatch("updateAmadeusConnection", res, { document: "platform" });
    } catch (error) {
      await holder.query("ROLLBACK");
      throw error;
    } finally {
      holder.release();
    }
    // Only the other change is stored; the refused one wrote, audited and published nothing.
    expect(settingsOf(await connectionRow(f.connection.id))).toEqual({
      ...settingsOf(f.connection),
      defaultOfficeId: PARIS,
      version: f.connection.version + 1,
    });
    expect(await auditRowsOf(f.tenant.id)).toEqual([]);
    expect(await eventsSoFarAbout(f.tenant.id)).toEqual([]);
  });

  it("answers 404 for an environment without a connection and 409 TENANT_NOT_ACTIVE for a suspended OTA", async () => {
    const f = await fixture();
    const live = await update(f, "owner", '"1"', { defaultOfficeId: NICE }, "live");
    expect([live.status, errorOf(live).code]).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("updateAmadeusConnection", live, { document: "platform" });
    const unknown = await update(f, "owner", '"1"', { defaultOfficeId: NICE }, "staging");
    expect([unknown.status, errorOf(unknown).code]).toEqual([400, "VALIDATION_FAILED"]);
    await expectNothingWritten(f);

    const suspended = await fixture({
      status: "suspended",
      suspension_reason: "abuse",
      suspended_at: new Date("2026-01-14T09:00:00Z"),
    });
    const res = await update(suspended, "owner", `"${suspended.connection.version}"`, {
      defaultOfficeId: PARIS,
    });
    expect([res.status, errorOf(res).code, errorOf(res).details]).toEqual([
      409,
      "TENANT_NOT_ACTIVE",
      { status: "suspended" },
    ]);
    expectResponseToMatch("updateAmadeusConnection", res, { document: "platform" });
    // A stale If-Match is answered first, as updatePaymentConnection does.
    const stale = await update(suspended, "owner", `"${suspended.connection.version + 1}"`, {
      defaultOfficeId: PARIS,
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
      const answer = update(f, "owner", `"${f.connection.version}"`, { defaultOfficeId: PARIS });
      // Awaited below; a failure before then must not count as unhandled.
      void answer.catch(() => undefined);
      // The request waits for the row (the guard's plain read does not wait); a read without the lock would see the
      // committed `active` status, write the settings and never wait.
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
    const service = t.app.get(ConnectionsService);
    const membership = {
      membershipId: testId("stf", 9903),
      tenantId: f.tenant.id,
      accountId: f.members.get("owner") ?? "",
      role: "owner" as const,
    };

    const failure = await service
      .updateSettings(membership, "test", f.connection.version, { defaultOfficeId: PARIS })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "NOT_FOUND" });
    await expectNothingWritten(f);
  });

  it("answers the connection as it is for settings it already has: no write, no audit row, no invalidation", async () => {
    const f = await fixture();
    const res = await update(f, "admin", `"${f.connection.version}"`, {
      defaultOfficeId: NICE,
      queuingOfficeId: NICE,
      ticketingDefaults: {},
      monitoredQueues: [],
    });

    expect(res.status).toBe(200);
    expectResponseToMatch("updateAmadeusConnection", res, { document: "platform" });
    expect(res.headers["etag"]).toBe(`"${f.connection.version}"`);
    expect(res.body).toMatchObject({
      defaultOfficeId: NICE,
      ticketingDefaults: {},
      monitoredQueues: [],
      version: f.connection.version,
    });
    await expectNothingWritten(f);
  });
});
