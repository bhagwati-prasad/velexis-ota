// The connection and domain reads of the portal (PBE-027; platform/docs/api-inventory-resources.md §2–§4, scope §1.2
// "See Amadeus and payment connections (masked)", PF-40) through the HTTP pipeline (createTestApp) on this file's
// database clone: `listAmadeusConnections` and `listPaymentConnections` for owners, admins and finance members only,
// `test` before `live`, mapped without any secret (rows with every ciphertext column filled are read, and no answer has
// a property ending in `Ciphertext` or a byte of a ciphertext), and `listDomains` for every member, with the DNS
// records of a custom domain. OTAs, members and connections are written with the builders; tokens come from the
// application's TokenService. Every answer is checked against the platform document. TenantRoleGuard's `404` for
// non-members on these routes is tested with every tenant route in test/integration/tenants/tenants.int.test.ts.
import { expectResponseToMatch } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import {
  insertAccount,
  insertAmadeusAccount,
  insertPaymentConnection,
  insertSupplierConnection,
  insertTenantDomain,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
  velexisSource,
} from "../../builders/platform-rows";
import { insertMember, insertOta, TEST_BASE_DOMAIN, type InsertedOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

const FAMILY = testId("asn", 1);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.31";
/** Who may see the connections (scope §1.2). */
const CONNECTION_READERS: readonly TenantRole[] = ["owner", "admin", "finance"];

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;

/** The OTA with every kind of row: its members by role, a stranger, and what was written. */
let ota: InsertedOta;
const members = new Map<TenantRole | "stranger", string>();

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);

  ota = await insertOta(pool);
  for (const role of TENANT_ROLES) {
    const account = await insertAccount(pool);
    await insertMember(pool, ota.tenant, account, role);
    members.set(role, account.id);
  }
  members.set("stranger", (await insertAccount(pool)).id);

  // Amadeus: the `velexis` test connection through an office of the Velexis account, and a `live` connection with the
  // OTA's own credentials, whose secret is a ciphertext.
  const velexisAccount = await insertAmadeusAccount(pool);
  await insertSupplierConnection(pool, ota.tenant, {
    ...velexisSource(velexisAccount),
    office_ids: ["NCE1A0042"],
    default_office_id: "NCE1A0042",
    queuing_office_id: "NCE1A0042",
    owner_office_id: "NCE1A0042",
    monitored_queues: [{ officeId: "NCE1A0042", queueId: 50, category: 0 }],
    ticketing_defaults: { ticketingAgreement: { option: "DELAY_TO_CANCEL", delay: "2D" }, issue: false },
    status: "active",
  });
  await insertSupplierConnection(pool, ota.tenant, {
    environment: "live",
    client_id: "ota-live-client",
    status: "pending_verification",
    last_error: "HTTP 401 invalid_client (Amadeus code 38187)",
  });

  // Stripe: the `velexis` test connection, and a `live` connection with the OTA's own keys (both secrets ciphertexts).
  await insertPaymentConnection(pool, ota.tenant, { statement_descriptor_suffix: "AGENCY TRAVEL" });
  await insertPaymentConnection(pool, ota.tenant, {
    environment: "live",
    account_mode: "api_keys",
    account_reference: "acct_1TestOwnAccount",
    publishable_key: "pk_live_1TestPublishableKeyOnly",
    secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    webhook_secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    encryption_key_id: PLACEHOLDER_KEK_ID,
    statement_descriptor_suffix: null,
    capabilities: {
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
      extra: "not a flag",
    },
    connected_at: new Date("2026-10-05T08:00:00Z"),
    status: "pending",
  });

  // Domains: a pending custom domain next to the sub-domain of insertOta.
  await insertTenantDomain(pool, ota.tenant, {
    hostname: "travel.example.net",
    kind: "custom",
    verification_status: "pending",
    verification_token: "vx-verify-ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    verified_at: null,
    verification_deadline_at: new Date("2026-10-08T09:00:00Z"),
    last_checked_at: new Date("2026-10-05T09:05:00Z"),
    last_check_error: "txt_missing",
  });
  // The database clone and the Nest module graph (Ajv compilation of the document included) are the expensive part,
  // and CI runs every package at once on 4 CPUs.
}, 60_000);

afterAll(async () => {
  await t?.close();
});

/** The headers of a portal call by the member of `role` (or the stranger). */
async function as(who: TenantRole | "stranger"): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: members.get(who) ?? "",
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** The error code of an envelope answer. */
function errorOf(res: Response): string {
  return (res.body as { error: { code: string } }).error.code;
}

/** Every property name in a JSON value, at any depth. */
function propertyNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(propertyNames);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([name, child]) => [name, ...propertyNames(child)]);
  }
  return [];
}

const url = (resource: string): string => `/v1/tenants/${ota.tenant.id}/${resource}`;

describe("listAmadeusConnections and listPaymentConnections", () => {
  it("[PBE-027 AC5] answer owners, admins and finance members, 403 to agents and viewers, 404 to non-members", async () => {
    const outcomes: Record<string, [number, number]> = {};
    for (const who of [...TENANT_ROLES, "stranger"] as const) {
      const amadeus = await t.http.get(url("amadeus-connections")).set(await as(who));
      const payment = await t.http.get(url("payment-connections")).set(await as(who));
      expectResponseToMatch("listAmadeusConnections", amadeus, { document: "platform" });
      expectResponseToMatch("listPaymentConnections", payment, { document: "platform" });
      outcomes[who] = [amadeus.status, payment.status];
      if (amadeus.status !== 200) {
        expect([errorOf(amadeus), errorOf(payment)], who).toEqual(
          who === "stranger" ? ["NOT_FOUND", "NOT_FOUND"] : ["FORBIDDEN", "FORBIDDEN"],
        );
      }
    }

    expect(outcomes).toEqual({
      owner: [200, 200],
      admin: [200, 200],
      agent: [403, 403],
      finance: [200, 200],
      viewer: [403, 403],
      stranger: [404, 404],
    });
    expect(CONNECTION_READERS.every((role) => outcomes[role]?.[0] === 200)).toBe(true);
  });

  it("[PBE-027 AC5] answer no property ending in Ciphertext and no byte of a ciphertext", async () => {
    for (const role of CONNECTION_READERS) {
      for (const resource of ["amadeus-connections", "payment-connections"]) {
        const res = await t.http.get(url(resource)).set(await as(role));

        expect(res.status, `${role} ${resource}`).toBe(200);
        expect(propertyNames(res.body).filter((name) => /ciphertext$/i.test(name))).toEqual([]);
        expect(res.text).not.toContain(PLACEHOLDER_CIPHERTEXT);
        expect(res.text).not.toContain(Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8").toString("base64"));
        expect(res.text).not.toContain(Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8").toString("hex"));
        expect(res.text).not.toContain(PLACEHOLDER_KEK_ID);
      }
    }
  });

  it("maps the Amadeus connections, test first, with the OTA's own client id but never a secret", async () => {
    const res = await t.http.get(url("amadeus-connections")).set(await as("finance"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          id: expect.stringMatching(/^sc_/),
          environment: "test",
          credentialSource: "velexis",
          status: "active",
          officeIds: ["NCE1A0042"],
          defaultOfficeId: "NCE1A0042",
          queuingOfficeId: "NCE1A0042",
          ownerOfficeId: "NCE1A0042",
          clientId: null,
          ticketingDefaults: { ticketingAgreement: { option: "DELAY_TO_CANCEL", delay: "2D" }, issue: false },
          monitoredQueues: [{ officeId: "NCE1A0042", queueId: 50, category: 0 }],
          lastVerifiedAt: null,
          lastError: null,
          pendingSubmission: null,
          version: 1,
        },
        {
          id: expect.stringMatching(/^sc_/),
          environment: "live",
          credentialSource: "tenant",
          status: "pending_verification",
          officeIds: [expect.stringMatching(/^NCE1B/)],
          defaultOfficeId: expect.stringMatching(/^NCE1B/),
          queuingOfficeId: null,
          ownerOfficeId: null,
          clientId: "ota-live-client",
          ticketingDefaults: {},
          monitoredQueues: [],
          lastVerifiedAt: null,
          lastError: "HTTP 401 invalid_client (Amadeus code 38187)",
          pendingSubmission: null,
          version: 1,
        },
      ],
    });
    expectResponseToMatch("listAmadeusConnections", res, { document: "platform" });
  });

  it("maps the payment connections, test first, with the publishable key and capability flags only", async () => {
    const res = await t.http.get(url("payment-connections")).set(await as("admin"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          id: expect.stringMatching(/^ppc_/),
          environment: "test",
          provider: "stripe",
          accountMode: "velexis",
          status: "active",
          accountReference: null,
          publishableKey: null,
          statementDescriptorSuffix: "AGENCY TRAVEL",
          capabilities: {},
          connectedAt: null,
          disconnectedAt: null,
          webhookUrl: null,
          pendingSubmission: null,
          version: 1,
        },
        {
          id: expect.stringMatching(/^ppc_/),
          environment: "live",
          provider: "stripe",
          accountMode: "api_keys",
          status: "pending",
          accountReference: "acct_1TestOwnAccount",
          publishableKey: "pk_live_1TestPublishableKeyOnly",
          statementDescriptorSuffix: null,
          capabilities: { chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true },
          connectedAt: "2026-10-05T08:00:00.000Z",
          disconnectedAt: null,
          webhookUrl: null,
          pendingSubmission: null,
          version: 1,
        },
      ],
    });
    expectResponseToMatch("listPaymentConnections", res, { document: "platform" });
  });

  it("answer an empty list for an OTA without connections", async () => {
    const empty = await insertOta(pool);
    const owner = await insertAccount(pool);
    await insertMember(pool, empty.tenant, owner, "owner");
    const { token } = await tokens.sign({
      aud: "portal",
      sub: owner.id,
      sid: FAMILY,
      ev: true,
      amr: ["pwd"],
    });
    const headers = { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };

    for (const resource of ["amadeus-connections", "payment-connections"]) {
      const res = await t.http.get(`/v1/tenants/${empty.tenant.id}/${resource}`).set(headers);
      expect([res.status, res.body], resource).toEqual([200, { data: [] }]);
    }
  });
});

describe("listDomains", () => {
  it("answers every member the sub-domain first, then the custom domains with their DNS records", async () => {
    for (const role of TENANT_ROLES) {
      const res = await t.http.get(url("domains")).set(await as(role));

      expect(res.status, role).toBe(200);
      expectResponseToMatch("listDomains", res, { document: "platform" });
    }
    const res = await t.http.get(url("domains")).set(await as("viewer"));

    expect(res.body).toEqual({
      data: [
        {
          id: ota.domain.id,
          hostname: `${ota.tenant.key}.${TEST_BASE_DOMAIN}`,
          kind: "subdomain",
          purpose: "storefront",
          isPrimary: true,
          verificationStatus: "verified",
          dnsRecords: [],
          verificationDeadlineAt: null,
          lastCheckedAt: null,
          lastCheckError: null,
          tlsStatus: "pending",
          tlsExpiresAt: null,
          createdAt: ota.domain.created_at.toISOString(),
        },
        {
          id: expect.stringMatching(/^dom_/),
          hostname: "travel.example.net",
          kind: "custom",
          purpose: "storefront",
          isPrimary: false,
          verificationStatus: "pending",
          dnsRecords: [
            {
              type: "TXT",
              name: "_velexis.travel.example.net",
              value: "vx-verify-ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
            },
            { type: "CNAME", name: "travel.example.net", value: `${ota.tenant.key}.${TEST_BASE_DOMAIN}` },
          ],
          verificationDeadlineAt: "2026-10-08T09:00:00.000Z",
          lastCheckedAt: "2026-10-05T09:05:00.000Z",
          lastCheckError: "txt_missing",
          tlsStatus: "pending",
          tlsExpiresAt: null,
          createdAt: expect.any(String),
        },
      ],
    });
  });

  it("answers 404 to a non-member", async () => {
    const res = await t.http.get(url("domains")).set(await as("stranger"));

    expect([res.status, errorOf(res)]).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("listDomains", res, { document: "platform" });
  });
});
