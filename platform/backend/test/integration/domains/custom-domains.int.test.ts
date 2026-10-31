// The custom domain writes of the portal (PBE-049; platform/docs/api-inventory-resources.md §2, flows/custom-domains.md
// steps 1, 5 and 7, PADR-0004; scope PF-41 AC1, AC4 and AC5) through the HTTP pipeline (createTestApp) on this file's
// database clone and Redis database: `addDomain` (host name rules, both routing options, the plan limit, the plan and
// the switch, a host taken by any OTA, concurrent additions), `makeDomainPrimary` (verified only, exactly one primary,
// both hosts invalidated) and `removeDomain` (custom only, the sub-domain primary again, invalidations, the cached TLS
// `ask` answer gone, the host free again), with their audit rows and the role and tenant-status rules, and the same DNS
// records in the platform admin's view of the OTA (`adminGetTenant`). Every answer is checked against the platform
// document.
//
// The milestone switches are a stand-in for FeatureSwitches whose `custom_domains` a test can turn off, as
// onboarding.int.test.ts does, so the switch-off case needs no second application. OTAs, plans and verified or failed
// domains are written with the builders (the DNS verification is PBE-050's); tokens come from the application's
// TokenService at the FakeClock's time. Redis pub/sub is not scoped to a database index: the subscriber keeps the
// `domain` events of this file's hosts and of its own markers only.
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch } from "@velexis/testing";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURES,
  FEATURE_VARIABLES,
  featuresFor,
  FeatureSwitches,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import { VERIFICATION_TOKEN_PATTERN } from "../../../src/domains/hostname-rules";
import { insertAccount, insertPlan, insertTenantDomain, testId } from "../../builders/platform-rows";
import { insertOta, TEST_BASE_DOMAIN, type InsertedOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** The storefront addresses of this application: the placeholders of `.env.example` (RFC 5737, RFC 3849). */
const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
/** A documentation address (RFC 5737) of the people. */
const PERSON_IP = "203.0.113.49";
const FAMILY = testId("asn", 1);
const HOUR_MS = 60 * 60 * 1000;
/** How long a marker may take to come back on `vx:invalidate`: pub/sub on the loopback interface takes milliseconds. */
const MARKER_WAIT_MS = 3_000;

/** The milestone switches of this application: `custom_domains` on unless a test turns it off. */
class TestSwitches {
  readonly on = new Set<Feature>(["custom_domains"]);

  isEnabled(feature: Feature): boolean {
    return this.on.has(feature);
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(
        FEATURES.map((feature) => [FEATURE_VARIABLES[feature], this.on.has(feature)]),
      ) as FeatureConfig,
    );
  }
}

/** The Domain of the platform document, as the tests read it. */
interface DomainBody {
  readonly id: string;
  readonly hostname: string;
  readonly kind: string;
  readonly purpose: string;
  readonly isPrimary: boolean;
  readonly verificationStatus: string;
  readonly dnsRecords: Array<{ type: string; name: string; value: string }>;
  readonly verificationDeadlineAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckError: string | null;
  readonly tlsStatus: string;
  readonly tlsExpiresAt: string | null;
  readonly createdAt: string;
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let subscriber: Redis;
const switches = new TestSwitches();

/** The people of every OTA of this file, one per role, and a stranger. */
const people: Record<"owner" | "admin" | "agent" | "finance" | "viewer" | "stranger", string> = {
  owner: "",
  admin: "",
  agent: "",
  finance: "",
  viewer: "",
  stranger: "",
};
/** A platform admin with MFA, for the admin's view of an OTA. */
let platformAdmin = "";

/** Plans of this file: two custom domains, one, none in the limits at all. */
const plans = { two: "", one: "", unset: "" };

/** The host names of this file (and its markers): the subscriber keeps their `domain` events only. */
const watched = new Set<string>();
/** The kept events, in the order they arrived. */
const received: InvalidationEvent[] = [];

beforeAll(async () => {
  // The database clone, the Nest module graph and the Ajv validators of the document are the expensive part; 60 s
  // covers a loaded 4-CPU CI runner.
  t = await createTestApp({
    env: { STOREFRONT_IPV4: IPV4, STOREFRONT_IPV6: IPV6 },
    overrides: [{ provide: FeatureSwitches, useValue: switches }],
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  people.owner = (await insertAccount(pool)).id;
  people.admin = (await insertAccount(pool)).id;
  people.agent = (await insertAccount(pool)).id;
  people.finance = (await insertAccount(pool)).id;
  people.viewer = (await insertAccount(pool)).id;
  people.stranger = (await insertAccount(pool)).id;
  platformAdmin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
  plans.two = (await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10, customDomains: 2 } })).code;
  plans.one = (await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10, customDomains: 1 } })).code;
  plans.unset = (await insertPlan(pool, { limits: { staffSeats: 5, apiKeys: 10 } })).code;

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    const event = JSON.parse(message) as InvalidationEvent;
    if (event.type === "domain" && watched.has(event.hostname)) {
      received.push(event);
    }
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, 60_000);

afterAll(async () => {
  await subscriber?.quit();
  await t?.close();
});

// ---- Arrangement ---------------------------------------------------------------------------------------------------

/** A host name of this file: `<label>-<random>.example.net`, watched for `domain` events. */
function host(label: string): string {
  const hostname = `${label}-${randomBytes(4).toString("hex")}.example.net`;
  watched.add(hostname);
  return hostname;
}

/** An OTA (active unless `status` says otherwise) on `planCode`, with one member of each role. */
async function ota(planCode = plans.two, status = "active"): Promise<InsertedOta> {
  const inserted = await insertOta(pool, {
    tenant: { plan_code: planCode, status },
    members: [
      [{ id: people.owner }, "owner"],
      [{ id: people.admin }, "admin"],
      [{ id: people.agent }, "agent"],
      [{ id: people.finance }, "finance"],
      [{ id: people.viewer }, "viewer"],
    ],
  });
  watched.add(inserted.domain.hostname);
  return inserted;
}

/** A verification value of the shape addDomain gives, for the domains the builder writes. */
const BUILDER_TOKEN = "vx-verify-K7Q4M2XP9TRWH5ZDB3NV8QKE1MZT6RYC";

/**
 * A custom storefront domain of `owner` written by the builder (no event is published): verified unless `status` says
 * otherwise, and primary when `primary` is set, after the builder took the flag from the sub-domain.
 */
async function customDomain(
  owner: Pick<InsertedOta, "tenant">,
  hostname: string,
  status: "verified" | "failed" | "pending" = "verified",
  primary = false,
): Promise<string> {
  if (primary) {
    await pool.query("UPDATE platform.tenant_domains SET is_primary = false WHERE tenant_id = $1", [
      owner.tenant.id,
    ]);
  }
  const row = await insertTenantDomain(pool, owner.tenant, {
    hostname,
    kind: "custom",
    is_primary: primary,
    verification_status: status,
    verification_token: BUILDER_TOKEN,
    verification_deadline_at: new Date(t.clock.now().getTime() + 72 * HOUR_MS),
    verified_at: status === "verified" ? t.clock.now() : null,
  });
  return row.id;
}

/** `Authorization: Bearer` with a fresh portal token of `who`, at the FakeClock's time. */
async function bearer(who: keyof typeof people): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: people[who],
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** `Authorization: Bearer` with a fresh platform admin token (password and TOTP), at the FakeClock's time. */
async function adminBearer(): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: platformAdmin,
    sid: testId("asn", 2),
    ev: true,
    amr: ["pwd", "otp"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

const domainsUrl = (tenantId: string): string => `/v1/tenants/${tenantId}/domains`;

/** `addDomain` by `who` (an admin by default), checked against the document. */
async function add(
  tenantId: string,
  hostname: string,
  who: keyof typeof people = "admin",
): Promise<Response> {
  const res = await t.http
    .post(domainsUrl(tenantId))
    .set(await bearer(who))
    .send({ hostname });
  expectResponseToMatch("addDomain", res, { document: "platform" });
  return res;
}

/** `makeDomainPrimary` by `who` (an owner by default), checked against the document. */
async function makePrimary(
  tenantId: string,
  domainId: string,
  who: keyof typeof people = "owner",
): Promise<Response> {
  const res = await t.http.post(`${domainsUrl(tenantId)}/${domainId}/make-primary`).set(await bearer(who));
  expectResponseToMatch("makeDomainPrimary", res, { document: "platform" });
  return res;
}

/** `removeDomain` by `who` (an admin by default), checked against the document. */
async function remove(
  tenantId: string,
  domainId: string,
  who: keyof typeof people = "admin",
): Promise<Response> {
  const res = await t.http.delete(`${domainsUrl(tenantId)}/${domainId}`).set(await bearer(who));
  expectResponseToMatch("removeDomain", res, { document: "platform" });
  return res;
}

/** The error code of an envelope answer, with the request id in the body and the header. */
function errorOf(res: Response): string {
  const { error } = res.body as { error: { code: string; requestId: string } };
  expect(error.requestId).toBe(res.headers["x-request-id"]);
  return error.code;
}

/** The `details` of an envelope answer. */
function detailsOf(res: Response): unknown {
  return (res.body as { error: { details?: unknown } }).error.details;
}

interface StoredDomain {
  readonly id: string;
  readonly tenant_id: string;
  readonly hostname: string;
  readonly kind: string;
  readonly is_primary: boolean;
  readonly verification_status: string;
  readonly verification_token: string | null;
  readonly verification_deadline_at: Date | null;
  readonly created_by_account_id: string | null;
  readonly updated_at: Date;
}

/**
 * The domain rows of a tenant: the sub-domain first (the builder stamps it with the database's time, the API with the
 * FakeClock's), then the custom domains, oldest first.
 */
async function storedDomains(tenantId: string): Promise<StoredDomain[]> {
  const { rows } = await pool.query<StoredDomain>(
    "SELECT * FROM platform.tenant_domains WHERE tenant_id = $1 ORDER BY kind = 'subdomain' DESC, created_at, id",
    [tenantId],
  );
  return rows;
}

/** The host names of the tenant's primary rows: exactly one while the partial unique index holds. */
async function primaryHosts(tenantId: string): Promise<string[]> {
  return (await storedDomains(tenantId)).filter((row) => row.is_primary).map((row) => row.hostname);
}

/** The rows with this host name, in any tenant. */
async function rowsWithHost(hostname: string): Promise<StoredDomain[]> {
  const { rows } = await pool.query<StoredDomain>(
    "SELECT * FROM platform.tenant_domains WHERE hostname = $1",
    [hostname],
  );
  return rows;
}

/** The audit rows about `targetId`, oldest first. */
async function auditRows(targetId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    "SELECT action, actor_type, actor_account_id, target_type, target_id, tenant_id, details " +
      "FROM platform.platform_audit_log WHERE target_id = $1 ORDER BY id",
    [targetId],
  );
  return rows as Array<Record<string, unknown>>;
}

/**
 * Resolves once every event published before the call has reached the subscriber: a marker published now arrives
 * after all of them (Redis delivers a channel's messages in the order it took them, and the API publishes after the
 * commit and before it answers).
 */
async function settle(): Promise<void> {
  const marker = host("marker");
  await t.redis.client.publish(
    INVALIDATION_CHANNEL,
    JSON.stringify({ v: 1, type: "domain", hostname: marker }),
  );
  const deadline = Date.now() + MARKER_WAIT_MS;
  while (!received.some((event) => event.type === "domain" && event.hostname === marker)) {
    if (Date.now() > deadline) {
      throw new Error(`the marker did not come back on ${INVALIDATION_CHANNEL} within ${MARKER_WAIT_MS} ms`);
    }
    await delay(10);
  }
}

/** Sends `send` between two markers and answers its response and the host names of the `domain` events it published. */
async function observe(send: () => Promise<Response>): Promise<{ res: Response; invalidated: string[] }> {
  await settle();
  const from = received.length;
  const res = await send();
  await settle();
  const invalidated = received
    .slice(from)
    .flatMap((event) =>
      event.type === "domain" && !event.hostname.startsWith("marker-") ? [event.hostname] : [],
    );
  return { res, invalidated: invalidated.sort() };
}

/** Caddy's TLS question for `hostname`, from loopback: its status. */
async function ask(hostname: string): Promise<number> {
  const res = await t.http.get("/internal/tls/ask").query({ domain: hostname });
  return res.status;
}

// ---- addDomain -----------------------------------------------------------------------------------------------------

describe("addDomain", () => {
  it("[PBE-049 AC1] stores Travel.Acme.com. as travel.acme.com, pending, with the TXT record and both routing options [PF-41 AC1]", async () => {
    const { tenant, domain: subdomain } = await ota();
    watched.add("travel.acme.com");
    const now = t.clock.now();

    const { res, invalidated } = await observe(() => add(tenant.id, "Travel.Acme.com."));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = res.body as DomainBody;
    const token = body.dnsRecords[0]?.value ?? "";
    expect(token).toMatch(VERIFICATION_TOKEN_PATTERN);
    expect(body).toEqual({
      id: expect.stringMatching(/^dom_[0-9A-HJKMNP-TV-Z]{26}$/),
      hostname: "travel.acme.com",
      kind: "custom",
      purpose: "storefront",
      isPrimary: false,
      verificationStatus: "pending",
      dnsRecords: [
        { type: "TXT", name: "_velexis.travel.acme.com", value: token },
        { type: "CNAME", name: "travel.acme.com", value: `${tenant.key}.${TEST_BASE_DOMAIN}` },
        { type: "A", name: "travel.acme.com", value: IPV4 },
        { type: "AAAA", name: "travel.acme.com", value: IPV6 },
      ],
      verificationDeadlineAt: new Date(now.getTime() + 72 * HOUR_MS).toISOString(),
      lastCheckedAt: null,
      lastCheckError: null,
      tlsStatus: "pending",
      tlsExpiresAt: null,
      createdAt: now.toISOString(),
    });
    // The row, written by the admin; the sub-domain stays primary.
    const rows = await storedDomains(tenant.id);
    expect(rows.map((row) => [row.hostname, row.kind, row.is_primary, row.verification_status])).toEqual([
      [subdomain.hostname, "subdomain", true, "verified"],
      ["travel.acme.com", "custom", false, "pending"],
    ]);
    expect(rows[1]).toMatchObject({
      id: body.id,
      verification_token: token,
      verification_deadline_at: new Date(now.getTime() + 72 * HOUR_MS),
      created_by_account_id: people.admin,
    });
    // Every member reads the same domain in listDomains, after the primary sub-domain.
    const list = await t.http.get(domainsUrl(tenant.id)).set(await bearer("viewer"));
    expectResponseToMatch("listDomains", list, { document: "platform" });
    expect((list.body as { data: DomainBody[] }).data.map(({ hostname }) => hostname)).toEqual([
      subdomain.hostname,
      "travel.acme.com",
    ]);
    expect((list.body as { data: DomainBody[] }).data[1]).toEqual(body);
    // One audit row, without the verification value; nothing announced (a pending domain is served nowhere).
    const audit = await auditRows(body.id);
    expect(audit).toEqual([
      expect.objectContaining({
        action: "domain.added",
        actor_type: "account",
        actor_account_id: people.admin,
        target_type: "domain",
        tenant_id: tenant.id,
        details: {
          after: {
            hostname: "travel.acme.com",
            kind: "custom",
            purpose: "storefront",
            verificationStatus: "pending",
          },
        },
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(token.slice("vx-verify-".length));
    expect(invalidated).toEqual([]);
  });

  it("[PBE-049] shows the platform admin the same DNS records as the portal, A and AAAA included", async () => {
    const { tenant } = await ota();
    const added = (await add(tenant.id, host("admin-view"))).body as DomainBody;

    const res = await t.http.get(`/v1/admin/tenants/${tenant.id}`).set(await adminBearer());

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectResponseToMatch("adminGetTenant", res, { document: "platform" });
    const shown = (res.body as { domains: DomainBody[] }).domains.find(({ id }) => id === added.id);
    expect(shown?.dnsRecords.map(({ type }) => type)).toEqual(["TXT", "CNAME", "A", "AAAA"]);
    expect(shown).toEqual(added);
  });

  it("[PBE-049 AC1] answers DOMAIN_INVALID for acme.ota.example.com, 1.2.3.4 and x.github.io, and stores nothing", async () => {
    const { tenant } = await ota();

    for (const hostname of [
      "acme.ota.example.com",
      "1.2.3.4",
      "x.github.io",
      `${tenant.key}.${TEST_BASE_DOMAIN}`,
      "ota.example.com",
      "api.platform.example.com",
      "localhost",
      "travel.acme.com/x",
      "[2001:db8::1]",
      "shop.herokuapp.com",
    ]) {
      const res = await add(tenant.id, hostname);
      expect([res.status, errorOf(res), detailsOf(res)], hostname).toEqual([
        422,
        "DOMAIN_INVALID",
        undefined,
      ]);
    }
    expect((await storedDomains(tenant.id)).map(({ kind }) => kind)).toEqual(["subdomain"]);
  });

  it("[PBE-049] answers DOMAIN_TAKEN for a host any OTA has, in any status, whatever its spelling", async () => {
    const first = await ota();
    const second = await ota();
    const taken = host("shared");
    const failed = host("failed");
    await customDomain(await ota(), failed, "failed");

    expect((await add(first.tenant.id, taken)).status).toBe(201);
    for (const [tenantId, hostname] of [
      [second.tenant.id, `${taken.toUpperCase()}.`],
      [first.tenant.id, taken],
      [second.tenant.id, failed],
    ] as const) {
      const res = await add(tenantId, hostname);
      expect([res.status, errorOf(res)], hostname).toEqual([409, "DOMAIN_TAKEN"]);
    }
    expect((await rowsWithHost(taken)).map(({ tenant_id }) => tenant_id)).toEqual([first.tenant.id]);
  });

  it("[PBE-049] lets exactly one of two concurrent additions of one host win; the other answers DOMAIN_TAKEN", async () => {
    const [first, second] = [await ota(), await ota()];
    const raced = host("race");

    const answers = await Promise.all([add(first.tenant.id, raced), add(second.tenant.id, raced)]);

    expect(answers.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(answers.filter(({ status }) => status === 409).map(errorOf)).toEqual(["DOMAIN_TAKEN"]);
    expect(await rowsWithHost(raced)).toHaveLength(1);
  });

  it("[PBE-049] counts custom domains in any status against limits.customDomains: PLAN_LIMIT_REACHED with limit and used", async () => {
    const { tenant } = await ota(plans.two);
    await customDomain({ tenant }, host("old-failed"), "failed");

    expect((await add(tenant.id, host("second"))).status).toBe(201);
    const res = await add(tenant.id, host("third"));

    expect([res.status, errorOf(res), detailsOf(res)]).toEqual([
      422,
      "PLAN_LIMIT_REACHED",
      { limit: 2, used: 2 },
    ]);
    expect((await storedDomains(tenant.id)).filter(({ kind }) => kind === "custom")).toHaveLength(2);
  });

  it("[PBE-049] gives the plan's last free domain to one of two concurrent additions only", async () => {
    const { tenant } = await ota(plans.one);

    const answers = await Promise.all([add(tenant.id, host("left")), add(tenant.id, host("right"))]);

    expect(answers.map(({ status }) => status).sort()).toEqual([201, 422]);
    expect(answers.filter(({ status }) => status === 422).map(errorOf)).toEqual(["PLAN_LIMIT_REACHED"]);
    expect((await storedDomains(tenant.id)).filter(({ kind }) => kind === "custom")).toHaveLength(1);
  });

  it("[PBE-049 AC3] answers FEATURE_DISABLED to a plan without custom domains [PF-41 AC5]", async () => {
    // The seeded early_access plan has customDomains 0; the other plan does not set it at all.
    const earlyAccess = await ota("early_access");
    const unset = await ota(plans.unset);

    for (const { tenant } of [earlyAccess, unset]) {
      const res = await add(tenant.id, host("no-plan"), "owner");
      expect([res.status, errorOf(res), detailsOf(res)]).toEqual([
        403,
        "FEATURE_DISABLED",
        { feature: "custom_domains" },
      ]);
      expect((await storedDomains(tenant.id)).map(({ kind }) => kind)).toEqual(["subdomain"]);
    }
  });

  it("[PBE-049 AC3] answers FEATURE_DISABLED while the custom_domains switch is off [PF-41 AC5]", async () => {
    const { tenant } = await ota(plans.two);
    switches.on.delete("custom_domains");
    try {
      const res = await add(tenant.id, host("switched-off"), "owner");

      expect([res.status, errorOf(res), detailsOf(res)]).toEqual([
        403,
        "FEATURE_DISABLED",
        { feature: "custom_domains" },
      ]);
    } finally {
      switches.on.add("custom_domains");
    }
    expect((await storedDomains(tenant.id)).map(({ kind }) => kind)).toEqual(["subdomain"]);
  });

  it("[PBE-049] lets owners and admins add, refuses the other roles with 403 and non-members with 404", async () => {
    const { tenant } = await ota();

    expect((await add(tenant.id, host("by-owner"), "owner")).status).toBe(201);
    for (const who of ["agent", "finance", "viewer"] as const) {
      const res = await add(tenant.id, host(`by-${who}`), who);
      expect([res.status, errorOf(res)], who).toEqual([403, "FORBIDDEN"]);
    }
    const stranger = await add(tenant.id, host("by-stranger"), "stranger");
    expect([stranger.status, errorOf(stranger)]).toEqual([404, "NOT_FOUND"]);
  });

  it("[PBE-049] answers TENANT_NOT_ACTIVE for every write of a suspended OTA, which keeps its domains as they are", async () => {
    const suspended = await ota(plans.two, "suspended");
    const verified = await customDomain(suspended, host("suspended-verified"));

    const added = await add(suspended.tenant.id, host("while-suspended"));
    const primary = await makePrimary(suspended.tenant.id, verified);
    const removed = await remove(suspended.tenant.id, verified);

    for (const res of [added, primary, removed]) {
      expect([res.status, errorOf(res), detailsOf(res)]).toEqual([
        409,
        "TENANT_NOT_ACTIVE",
        { status: "suspended" },
      ]);
    }
    expect(await primaryHosts(suspended.tenant.id)).toEqual([suspended.domain.hostname]);
    expect(await storedDomains(suspended.tenant.id)).toHaveLength(2);
  });
});

// ---- makeDomainPrimary ---------------------------------------------------------------------------------------------

describe("makeDomainPrimary", () => {
  it("[PBE-049 AC2] refuses a pending or failed domain with DOMAIN_NOT_VERIFIED; the sub-domain stays primary", async () => {
    const owner = await ota();
    const pending = (await add(owner.tenant.id, host("pending"))).body as DomainBody;
    const failed = await customDomain(owner, host("failed"), "failed");

    for (const domainId of [pending.id, failed]) {
      const { res, invalidated } = await observe(() => makePrimary(owner.tenant.id, domainId));
      expect([res.status, errorOf(res), invalidated]).toEqual([409, "DOMAIN_NOT_VERIFIED", []]);
    }
    expect(await primaryHosts(owner.tenant.id)).toEqual([owner.domain.hostname]);
  });

  it("[PBE-049 AC2] makes a verified domain primary, exactly one primary remains, and both hosts are invalidated [PF-41 AC4]", async () => {
    const owner = await ota();
    const hostname = host("primary");
    const domainId = await customDomain(owner, hostname);

    const made = await observe(() => makePrimary(owner.tenant.id, domainId, "admin"));

    expect(made.res.status, JSON.stringify(made.res.body)).toBe(200);
    expect(made.res.body).toMatchObject({
      id: domainId,
      hostname,
      isPrimary: true,
      verificationStatus: "verified",
    });
    expect(await primaryHosts(owner.tenant.id)).toEqual([hostname]);
    expect(made.invalidated).toEqual([owner.domain.hostname, hostname].sort());
    const list = await t.http.get(domainsUrl(owner.tenant.id)).set(await bearer("viewer"));
    expect(
      (list.body as { data: DomainBody[] }).data.map(({ hostname: h, isPrimary }) => [h, isPrimary]),
    ).toEqual([
      [hostname, true],
      [owner.domain.hostname, false],
    ]);
    expect(await auditRows(domainId)).toEqual([
      expect.objectContaining({
        action: "domain.primary_changed",
        actor_account_id: people.admin,
        tenant_id: owner.tenant.id,
        details: {
          before: { primaryDomainId: owner.domain.id, primaryHostname: owner.domain.hostname },
          after: { primaryDomainId: domainId, primaryHostname: hostname },
        },
      }),
    ]);

    // The sub-domain can be primary again; still exactly one primary, both hosts invalidated.
    const back = await observe(() => makePrimary(owner.tenant.id, owner.domain.id));

    expect([back.res.status, (back.res.body as DomainBody).isPrimary]).toEqual([200, true]);
    expect(await primaryHosts(owner.tenant.id)).toEqual([owner.domain.hostname]);
    expect(back.invalidated).toEqual([owner.domain.hostname, hostname].sort());
  });

  it("[PBE-049] answers the primary domain unchanged, with no write, no audit row and no invalidation", async () => {
    const owner = await ota();
    const [before] = await storedDomains(owner.tenant.id);

    const { res, invalidated } = await observe(() => makePrimary(owner.tenant.id, owner.domain.id));

    expect([res.status, (res.body as DomainBody).isPrimary, invalidated]).toEqual([200, true, []]);
    const [after] = await storedDomains(owner.tenant.id);
    expect(after?.updated_at).toEqual(before?.updated_at);
    expect(await auditRows(owner.domain.id)).toEqual([]);
  });

  it("[PBE-049] answers 404 for a domain of another OTA, to make primary and to remove", async () => {
    const owner = await ota();
    const other = await ota();
    const othersDomain = await customDomain(other, host("others"));

    const primary = await makePrimary(owner.tenant.id, othersDomain);
    const removed = await remove(owner.tenant.id, othersDomain);

    expect([primary.status, errorOf(primary)]).toEqual([404, "NOT_FOUND"]);
    expect([removed.status, errorOf(removed)]).toEqual([404, "NOT_FOUND"]);
    expect(await storedDomains(other.tenant.id)).toHaveLength(2);
  });
});

// ---- removeDomain --------------------------------------------------------------------------------------------------

describe("removeDomain", () => {
  it("[PBE-049] refuses the sub-domain with CONFLICT and details.reason subdomain", async () => {
    const owner = await ota();

    const { res, invalidated } = await observe(() => remove(owner.tenant.id, owner.domain.id));

    expect([res.status, errorOf(res), detailsOf(res), invalidated]).toEqual([
      409,
      "CONFLICT",
      { reason: "subdomain" },
      [],
    ]);
    expect(await primaryHosts(owner.tenant.id)).toEqual([owner.domain.hostname]);
  });

  it("[PBE-049] removes the primary custom domain: the sub-domain is primary again, both hosts are invalidated and TLS ask stops at once", async () => {
    const owner = await ota();
    const hostname = host("removed-primary");
    const domainId = await customDomain(owner, hostname, "verified", true);
    // Caddy asked for the verified domain a moment ago: its positive answer sits in Redis (written here as TlsAskService
    // writes it, so no invalidation of an earlier step can race with it) and TLS ask serves it from there.
    await t.redis.client.set(`tlsask:${hostname}`, "1", "EX", 60);
    expect(await ask(hostname)).toBe(200);

    // The service deletes the key itself before it answers (PADR-0004 item 6), so it is gone when the answer arrives,
    // whenever the API's `vx:invalidate` subscriber gets to the event.
    let cachedAtAnswer = -1;
    const { res, invalidated } = await observe(async () => {
      const answer = await remove(owner.tenant.id, domainId);
      cachedAtAnswer = await t.redis.client.exists(`tlsask:${hostname}`);
      return answer;
    });

    expect([res.status, res.text]).toEqual([204, ""]);
    expect(cachedAtAnswer).toBe(0);
    expect(await rowsWithHost(hostname)).toEqual([]);
    expect(await primaryHosts(owner.tenant.id)).toEqual([owner.domain.hostname]);
    expect(invalidated).toEqual([owner.domain.hostname, hostname].sort());
    expect(await t.redis.client.exists(`tlsask:${hostname}`)).toBe(0);
    expect(await ask(hostname)).toBe(404);
    expect((await auditRows(domainId)).at(-1)).toEqual(
      expect.objectContaining({
        action: "domain.removed",
        actor_account_id: people.admin,
        tenant_id: owner.tenant.id,
        details: {
          primaryHostname: owner.domain.hostname,
          before: { hostname, verificationStatus: "verified", isPrimary: true },
        },
      }),
    );
  });

  it("[PBE-049] removes a pending domain, announces only its host, and frees the host for another OTA", async () => {
    const owner = await ota();
    const hostname = host("freed");
    const added = (await add(owner.tenant.id, hostname)).body as DomainBody;

    const { res, invalidated } = await observe(() => remove(owner.tenant.id, added.id, "owner"));

    expect([res.status, invalidated]).toEqual([204, [hostname]]);
    expect(await primaryHosts(owner.tenant.id)).toEqual([owner.domain.hostname]);
    expect((await auditRows(added.id)).map(({ action }) => action)).toEqual([
      "domain.added",
      "domain.removed",
    ]);
    const other = await ota();
    const again = await add(other.tenant.id, hostname);
    expect([again.status, (await rowsWithHost(hostname)).map(({ tenant_id }) => tenant_id)]).toEqual([
      201,
      [other.tenant.id],
    ]);
  });

  it("[PBE-049] refuses agents, finance members and viewers with 403", async () => {
    const owner = await ota();
    const domainId = await customDomain(owner, host("kept"));

    for (const who of ["agent", "finance", "viewer"] as const) {
      const removed = await remove(owner.tenant.id, domainId, who);
      const primary = await makePrimary(owner.tenant.id, domainId, who);
      expect([removed.status, errorOf(removed), primary.status, errorOf(primary)], who).toEqual([
        403,
        "FORBIDDEN",
        403,
        "FORBIDDEN",
      ]);
    }
    expect(await storedDomains(owner.tenant.id)).toHaveLength(2);
  });
});
