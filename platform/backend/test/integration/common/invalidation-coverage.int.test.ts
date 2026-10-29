// Invalidation coverage (PBE-036 step 1; platform/docs/architecture.md §6.2 and §6.3, PADR-0016 item 3): the table
// below lists the platform mutations that change a row the OTA backend caches (tenants, API keys, connections,
// memberships, accounts, the shared Amadeus accounts and their offices, plans), each with exactly the `vx:invalidate`
// events it must publish after its commit. Every row runs its mutation through the HTTP pipeline (createTestApp), as
// the portal or the platform admin calls it, on this file's database clone and Redis database, and checks the answer
// against the platform document and the events against the row: the expected events, no other event about this
// file's rows, each once. A mutation added to the table later fails its row until it publishes its event.
//
// What the table does not hold, and where it is proven instead:
// - `domain` events come with the custom domains of M5 (PBE-049 to PBE-051): their operations are still pending
//   (test/contract/pending-operations.ts), and the guard test below fails once one of them is bound, so its row is
//   added with it.
// - Changes the platform worker makes, not a request: provisioning's post-steps (post-steps.int.test.ts) and its
//   failure handler (failure-handler.test.ts), billing sync of Stripe subscriptions (billing-events.int.test.ts), the
//   verification job of a shared Amadeus account (amadeus-accounts.int.test.ts), and the developer's commands
//   (`dev:seed`, `admin:reset-mfa`: dev-seed.int.test.ts, admin-cli.int.test.ts).
//
// How the events are read: a subscriber on `vx:invalidate` keeps the events that name an id, key prefix or plan code
// of this file's rows (Redis pub/sub is not scoped to a database index, and other test files may publish at the same
// time). A row's window opens and closes with a marker event this file publishes itself: Redis delivers the messages
// of a channel in the order it took them, and the API publishes after the commit and before it answers, so once the
// closing marker has arrived every event of the mutation has too (and none of the arrangement's falls inside the
// window). Rows are arranged with the builders, which publish nothing, with fresh ids of the application's
// IdGenerator; tokens come from the application's TokenService at the FakeClock's time, admin tokens with a step-up.
// Passwords, keys, tokens and TOTP secrets are test values that stay in this process; none is printed.
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  INVALIDATION_CHANNEL,
  INVALIDATION_TYPES,
  type InvalidationEvent,
  type InvalidationType,
} from "@velexis/api-types/jobs";
import type { PlatformOperationId } from "@velexis/api-types/operations";
import { generateToken } from "@velexis/crypto";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail } from "@velexis/testing/mailpit";
import { Redis } from "ioredis";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "../../../src/accounts/mfa.service";
import { PasswordPolicy } from "../../../src/auth/password-policy";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { planVersion } from "../../../src/billing/plans.repository";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { IdGenerator } from "../../../src/common/ids";
import type { TenantRole } from "../../../src/memberships/tenant-roles";
import { insertAccountToken, TEST_PASSWORD } from "../../builders/accounts";
import {
  insertAccount,
  insertAmadeusAccount,
  insertAmadeusOffice,
  insertPaymentConnection,
  insertPlan,
  insertRow,
  insertSupplierConnection,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  type AccountRow,
  type PlatformRow,
  type SubscriptionRow,
  type TenantRow,
} from "../../builders/platform-rows";
import { insertMember, insertOta, type InsertedOta } from "../../builders/tenants";
import { PENDING_OPERATIONS } from "../../contract/pending-operations";
import { createTestApp, type TestApp } from "../../support/app";

/**
 * The database clone, the Nest module graph, the Argon2id hash of TEST_PASSWORD and the platform document (parsed for
 * expectResponseToMatch) take seconds; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a marker may take to come back: pub/sub on the loopback interface takes milliseconds. */
const MARKER_WAIT_MS = 3_000;
/** Documentation addresses (RFC 5737) of the people and the platform admin. */
const PERSON_IP = "203.0.113.37";
const ADMIN_IP = "198.51.100.37";
/** An admin's written reason (5–500 characters). */
const REASON = "Invalidation coverage of the platform's mutations (PBE-036).";
/** The new password of the password rows: a test value that meets the rules of PasswordPolicy. */
const NEW_PASSWORD = "Southern-Cross-Lagoon-2027";
/** The custom domain operations of M5 whose rows publish `domain` (PBE-049 to PBE-051). */
const DOMAIN_OPERATIONS: readonly PlatformOperationId[] = [
  "addDomain",
  "removeDomain",
  "checkDomain",
  "makeDomainPrimary",
  "adminRecheckDomain",
  "adminRemoveDomain",
];

let t: TestApp;
let pool: PlatformPool;
let ids: IdGenerator;
let tokens: TokenService;
let passwordHash: string;
let subscriber: Redis;
let markerClient: Redis;
/** The platform admin of the admin rows. */
let admin: PlatformRow<"accounts">;
/** The Velexis shared Amadeus account of the `test` environment (one per environment) and of its office rows. */
let amadeusAccount: PlatformRow<"amadeus_accounts">;

// ---- The events of this file -------------------------------------------------------------------------------------

/** Ids, key prefixes and plan codes of this file's rows: the subscriber keeps the events that name one of them. */
const own = new Set<string>();
/** The kept events, in the order they arrived. */
const received: InvalidationEvent[] = [];
/** The markers on their way, by tenant id, with what resolves their wait. */
const markers = new Map<string, () => void>();

/** Adds `value` (an id, a key prefix or a plan code) to this file's own values and returns it. */
function mine<T extends string>(value: T): T {
  own.add(value);
  return value;
}

/** True when one of the event's fields (`v` and `type` aside) names a value of this file. */
function concernsThisFile(event: Record<string, unknown>): boolean {
  return Object.entries(event).some(
    ([field, value]) => field !== "v" && field !== "type" && typeof value === "string" && own.has(value),
  );
}

function onMessage(channel: string, message: string): void {
  if (channel !== INVALIDATION_CHANNEL) {
    return;
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(message) as Record<string, unknown>;
  } catch {
    return;
  }
  const marker = typeof event["id"] === "string" ? markers.get(event["id"]) : undefined;
  if (event["type"] === "tenant" && marker !== undefined) {
    marker();
    return;
  }
  if (concernsThisFile(event)) {
    received.push(event as unknown as InvalidationEvent);
  }
}

/**
 * Resolves once every event published before the call has reached the subscriber: a marker published now arrives
 * after all of them (see the file header). Rejects after MARKER_WAIT_MS.
 */
async function settle(): Promise<void> {
  const id = ids.new("ten");
  const arrived = new Promise<void>((resolve) => markers.set(id, resolve));
  try {
    await markerClient.publish(INVALIDATION_CHANNEL, JSON.stringify({ v: 1, type: "tenant", id }));
    const outcome = await Promise.race([
      arrived.then(() => "arrived" as const),
      delay(MARKER_WAIT_MS, "late" as const, { ref: false }),
    ]);
    if (outcome === "late") {
      throw new Error(`the marker did not come back on ${INVALIDATION_CHANNEL} within ${MARKER_WAIT_MS} ms`);
    }
  } finally {
    markers.delete(id);
  }
}

/** A request and the events about this file's rows that it published. */
interface Observed {
  readonly response: Response;
  readonly published: readonly InvalidationEvent[];
}

/** Sends `send` inside a window of two markers and answers its response and the events published meanwhile. */
async function observe(send: () => Promise<Response>): Promise<Observed> {
  await settle();
  const from = received.length;
  const response = await send();
  await settle();
  return { response, published: received.slice(from) };
}

/** One text per distinct event, whatever the order of its properties. */
function identity(event: InvalidationEvent): string {
  return JSON.stringify(Object.entries(event).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The events in one order, so lists compare whatever order they were published in. */
function inOrder(events: readonly InvalidationEvent[]): InvalidationEvent[] {
  return [...events].sort((a, b) => (identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0));
}

/** Exactly `expected` was published: each expected event once, and no other event about this file's rows. */
function expectPublished(observed: Observed, expected: readonly InvalidationEvent[]): void {
  expect(inOrder(observed.published)).toEqual(inOrder(expected));
}

/**
 * `<status>` of a success, or `<status> <code>` and the paths of the field errors of an error answer: never a body
 * value (a success may carry a key, a token or recovery codes).
 */
function outcomeOf(res: Response): string {
  if (res.status < 300) {
    return String(res.status);
  }
  const { error } = (res.body ?? {}) as { error?: { code?: string; fieldErrors?: Array<{ path?: string }> } };
  const paths = (error?.fieldErrors ?? []).map(({ path }) => path ?? "?");
  return [String(res.status), error?.code ?? "(no error code)", ...paths].join(" ");
}

// ---- Arrangement -------------------------------------------------------------------------------------------------

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);
const daysAfterNow = (days: number): Date => new Date(t.clock.now().getTime() + days * 24 * 60 * 60 * 1000);

/** The headers of a portal call of `accountId` from PERSON_IP; `claims` over a password sign-in's. */
async function portal(
  accountId: string,
  claims: Partial<AccessTokenInput> = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: ids.new("asn"),
    ev: true,
    amr: ["pwd"],
    ...claims,
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** The headers of a portal call with a TOTP step-up now. */
function steppedUp(accountId: string): Promise<Record<string, string>> {
  return portal(accountId, { amr: ["pwd", "otp"], mfa_at: nowSeconds() });
}

/** The headers of a platform admin call from ADMIN_IP, with a step-up now. */
async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: ids.new("asn"),
    ev: true,
    amr: ["pwd", "otp"],
    mfa_at: nowSeconds(),
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

/** The MFA columns of an account with MFA on (a placeholder secret: nothing here decrypts it). */
function withMfa(): Partial<AccountRow> {
  return {
    mfa_enabled: true,
    mfa_enabled_at: daysAfterNow(-30),
    mfa_secret_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    encryption_key_id: PLACEHOLDER_KEK_ID,
  };
}

/** A portal account of this file: active, verified, signing in with TEST_PASSWORD, unless `overrides` say otherwise. */
function person(overrides: Partial<AccountRow> = {}): Promise<PlatformRow<"accounts">> {
  return insertAccount(pool, {
    id: mine(ids.new("acc")),
    email: uniqueEmail("coverage"),
    password_hash: passwordHash,
    ...overrides,
  });
}

/** An OTA of this file (active unless `tenant` says otherwise) with `members` and, when given, a subscription. */
function ota(
  options: {
    readonly tenant?: Partial<TenantRow>;
    readonly members?: ReadonlyArray<readonly [{ readonly id: string }, TenantRole]>;
    readonly subscription?: Partial<SubscriptionRow>;
  } = {},
): Promise<InsertedOta> {
  return insertOta(pool, {
    tenant: { id: mine(ids.new("ten")), ...options.tenant },
    ...(options.members === undefined ? {} : { members: options.members }),
    ...(options.subscription === undefined
      ? {}
      : { subscription: { id: ids.new("sub"), ...options.subscription } }),
  });
}

/** A key created through createApiKey by `headers` (an owner's), whose prefix is this file's. */
async function apiKey(
  tenantId: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ readonly id: string; readonly prefix: string }> {
  const res = await t.http.post(`/v1/tenants/${tenantId}/api-keys`).set(headers).send(body);
  if (res.status !== 201) {
    throw new Error(`createApiKey answered ${res.status}, not 201`);
  }
  const { apiKey: created } = res.body as { apiKey: { id: string; prefix: string } };
  return { id: created.id, prefix: mine(created.prefix) };
}

/** A plan code of this file (`^[a-z][a-z0-9_]{1,39}$`). */
function planCode(): string {
  return mine(`cov_${randomBytes(6).toString("hex")}`);
}

/** The current `version` of the shared Amadeus account, after setting its `status` for the row. */
async function amadeusAccountAt(status: "active" | "disabled"): Promise<number> {
  const { rows } = await pool.query<{ version: number }>(
    "UPDATE platform.amadeus_accounts SET status = $2 WHERE id = $1 RETURNING version",
    [amadeusAccount.id, status],
  );
  const version = rows[0]?.version;
  if (version === undefined) {
    throw new Error("the shared Amadeus account of this file is gone");
  }
  return version;
}

// ---- The coverage table ------------------------------------------------------------------------------------------

/** A mutation, arranged and ready to send. */
interface Mutation {
  /** The request, sent inside the window of two markers. */
  readonly send: () => Promise<Response>;
  /** The status of its success answer. */
  readonly status: number;
  /** Exactly the events it must publish after its commit, in any order. */
  readonly events: readonly InvalidationEvent[];
}

/** One row of the table. */
interface CoverageRow {
  /** The change, as architecture §6.3 and PBE-036 step 1 name it. */
  readonly change: string;
  /** The operation of the platform document that makes it. */
  readonly operationId: PlatformOperationId;
  /** The types of the events it publishes (`events` of the mutation has exactly these). */
  readonly publishes: readonly InvalidationType[];
  /** Writes the rows the mutation needs (builders publish nothing) and answers the mutation. */
  readonly arrange: () => Promise<Mutation>;
}

const COVERAGE: readonly CoverageRow[] = [
  // ---- tenant: status, plan, storefront environment, profile ----------------------------------------------------
  {
    change: "tenant profile update by the owner",
    operationId: "updateTenant",
    publishes: ["tenant"],
    async arrange() {
      const owner = await person();
      const { tenant } = await ota({ members: [[owner, "owner"]] });
      const headers = await portal(owner.id);
      return {
        send: () =>
          t.http
            .patch(`/v1/tenants/${tenant.id}`)
            .set(headers)
            .set("If-Match", `"${tenant.version}"`)
            .send({ name: "Coverage Travel Group" }),
        status: 200,
        events: [{ v: 1, type: "tenant", id: tenant.id }],
      };
    },
  },
  {
    change: "tenant profile update by a platform admin",
    operationId: "adminUpdateTenant",
    publishes: ["tenant"],
    async arrange() {
      const { tenant } = await ota();
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http
            .patch(`/v1/admin/tenants/${tenant.id}`)
            .set(headers)
            .set("If-Match", `"${tenant.version}"`)
            .send({ legalName: "Coverage Travel SAS" }),
        status: 200,
        events: [{ v: 1, type: "tenant", id: tenant.id }],
      };
    },
  },
  {
    change: "suspend",
    operationId: "adminSuspendTenant",
    publishes: ["tenant"],
    async arrange() {
      const { tenant } = await ota();
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http
            .post(`/v1/admin/tenants/${tenant.id}/suspend`)
            .set(headers)
            .send({ suspensionReason: "abuse", reason: REASON }),
        status: 202,
        events: [{ v: 1, type: "tenant", id: tenant.id }],
      };
    },
  },
  {
    change: "resume",
    operationId: "adminResumeTenant",
    publishes: ["tenant"],
    async arrange() {
      const { tenant } = await ota({
        tenant: { status: "suspended", suspended_at: t.clock.now(), suspension_reason: "abuse" },
      });
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http.post(`/v1/admin/tenants/${tenant.id}/resume`).set(headers).send({ reason: REASON }),
        status: 202,
        events: [{ v: 1, type: "tenant", id: tenant.id }],
      };
    },
  },
  {
    change: "plan change (manual subscription)",
    operationId: "adminUpdateManualSubscription",
    publishes: ["tenant"],
    async arrange() {
      const plan = await insertPlan(pool, { code: planCode(), is_public: false });
      const { tenant, subscription } = await ota({ subscription: { trial_ends_at: daysAfterNow(60) } });
      if (subscription === undefined) {
        throw new Error("insertOta wrote no subscription");
      }
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http
            .patch(`/v1/admin/subscriptions/${subscription.id}`)
            .set(headers)
            .set("If-Match", `"${subscription.version}"`)
            .send({ planCode: plan.code, reason: REASON }),
        status: 200,
        events: [{ v: 1, type: "tenant", id: tenant.id }],
      };
    },
  },
  {
    change: "failed setup retried by a platform admin (status failed → provisioning)",
    operationId: "adminRetryProvisioningJob",
    publishes: ["tenant"],
    async arrange() {
      const { tenant } = await ota({ tenant: { status: "failed", activated_at: null } });
      const job = await insertRow(pool, "provisioning_jobs", {
        id: ids.new("job"),
        tenant_id: tenant.id,
        kind: "provision",
        status: "failed",
        attempt: 1,
        scheduled_at: t.clock.now(),
        finished_at: t.clock.now(),
        error:
          "run_migrations failed: CHECKSUM_MISMATCH: A tenant migration file changed after it was applied.",
      });
      const headers = await adminHeaders();
      return {
        send: () => t.http.post(`/v1/admin/provisioning-jobs/${job.id}/retry`).set(headers),
        status: 202,
        events: [{ v: 1, type: "tenant", id: tenant.id }],
      };
    },
  },
  {
    // FIX-W32-PLATFORM: the owner's retry publishes the event as the admin's does (architecture §6.3).
    change: "failed setup retried by the owner (status failed → provisioning)",
    operationId: "retryProvisioning",
    publishes: ["tenant"],
    async arrange() {
      const owner = await person();
      const { tenant } = await ota({
        tenant: { status: "failed", activated_at: null },
        members: [[owner, "owner"]],
      });
      await insertRow(pool, "provisioning_jobs", {
        id: ids.new("job"),
        tenant_id: tenant.id,
        kind: "provision",
        status: "failed",
        attempt: 5,
        scheduled_at: t.clock.now(),
        finished_at: t.clock.now(),
        error: "run_migrations failed: LOCK_TIMEOUT: The tenant schema was locked by another migration.",
      });
      const headers = await portal(owner.id);
      return {
        send: () => t.http.post(`/v1/tenants/${tenant.id}/provisioning/retry`).set(headers),
        status: 202,
        events: [{ v: 1, type: "tenant", id: tenant.id }],
      };
    },
  },

  // ---- api_key: revoked, expiry set, origins changed ------------------------------------------------------------
  {
    change: "key origins change",
    operationId: "updateApiKey",
    publishes: ["api_key"],
    async arrange() {
      const owner = await person();
      const { tenant } = await ota({ members: [[owner, "owner"]] });
      const headers = await portal(owner.id);
      const key = await apiKey(tenant.id, headers, {
        name: "Website",
        kind: "publishable",
        environment: "test",
        allowedOrigins: ["https://www.coverage.example.com"],
      });
      return {
        send: () =>
          t.http
            .patch(`/v1/tenants/${tenant.id}/api-keys/${key.id}`)
            .set(headers)
            .send({
              allowedOrigins: ["https://www.coverage.example.com", "https://book.coverage.example.com"],
            }),
        status: 200,
        events: [{ v: 1, type: "api_key", prefix: key.prefix }],
      };
    },
  },
  {
    change: "key roll (the old key gets an expiry)",
    operationId: "rollApiKey",
    publishes: ["api_key"],
    async arrange() {
      const owner = await person();
      const { tenant } = await ota({ members: [[owner, "owner"]] });
      const headers = await portal(owner.id);
      const key = await apiKey(tenant.id, headers, { name: "Server", kind: "secret", environment: "test" });
      return {
        send: () =>
          t.http
            .post(`/v1/tenants/${tenant.id}/api-keys/${key.id}/roll`)
            .set(headers)
            .send({ expireOldIn: "24h" }),
        status: 201,
        events: [{ v: 1, type: "api_key", prefix: key.prefix }],
      };
    },
  },
  {
    change: "key revoke",
    operationId: "revokeApiKey",
    publishes: ["api_key"],
    async arrange() {
      const owner = await person();
      const { tenant } = await ota({ members: [[owner, "owner"]] });
      const headers = await portal(owner.id);
      const key = await apiKey(tenant.id, headers, { name: "Server", kind: "secret", environment: "test" });
      return {
        send: () => t.http.post(`/v1/tenants/${tenant.id}/api-keys/${key.id}/revoke`).set(headers),
        status: 200,
        events: [{ v: 1, type: "api_key", prefix: key.prefix }],
      };
    },
  },

  // ---- connection: any change to the tenant's supplier or payment connection --------------------------------------
  {
    change: "connection status (an admin disables the Amadeus connection)",
    operationId: "adminSetConnectionStatus",
    publishes: ["connection"],
    async arrange() {
      const { tenant } = await ota();
      await insertSupplierConnection(pool, tenant, { id: ids.new("sc") });
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http
            .post(`/v1/admin/tenants/${tenant.id}/connections/amadeus/test/status`)
            .set(headers)
            .send({ status: "disabled", reason: REASON }),
        status: 200,
        events: [{ v: 1, type: "connection", tenantId: tenant.id }],
      };
    },
  },
  {
    change: "office assignment (the connection gets the office; the office status changes)",
    operationId: "adminAssignAmadeusOffice",
    publishes: ["connection", "amadeus_account"],
    async arrange() {
      const { tenant } = await ota();
      const office = await insertAmadeusOffice(pool, amadeusAccount, { id: ids.new("amo") });
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http
            .post(`/v1/admin/amadeus-offices/${office.id}/assign`)
            .set(headers)
            .send({ tenantId: tenant.id }),
        status: 200,
        events: [
          { v: 1, type: "connection", tenantId: tenant.id },
          { v: 1, type: "amadeus_account", id: amadeusAccount.id },
        ],
      };
    },
  },
  {
    // PBE-040: the owner's settings of the Amadeus connection (flows/amadeus-connection.md §E).
    change: "Amadeus connection settings (office defaults, ticketing defaults, monitored queues)",
    operationId: "updateAmadeusConnection",
    publishes: ["connection"],
    async arrange() {
      const owner = await person();
      const { tenant } = await ota({ members: [[owner, "owner"]] });
      const connection = await insertSupplierConnection(pool, tenant, {
        id: ids.new("sc"),
        office_ids: ["NCE1A0955", "PAR1A0001"],
        default_office_id: "NCE1A0955",
        status: "active",
      });
      const headers = await portal(owner.id);
      return {
        send: () =>
          t.http
            .patch(`/v1/tenants/${tenant.id}/amadeus-connections/test`)
            .set(headers)
            .set("If-Match", `"${connection.version}"`)
            .send({
              defaultOfficeId: "PAR1A0001",
              monitoredQueues: [{ officeId: "PAR1A0001", queueId: 8, category: 0 }],
            }),
        status: 200,
        events: [{ v: 1, type: "connection", tenantId: tenant.id }],
      };
    },
  },
  {
    change: "payment connection statement descriptor",
    operationId: "updatePaymentConnection",
    publishes: ["connection"],
    async arrange() {
      const owner = await person();
      const { tenant } = await ota({ members: [[owner, "owner"]] });
      const connection = await insertPaymentConnection(pool, tenant, {
        id: ids.new("ppc"),
        statement_descriptor_suffix: "AGENCY TRAVEL",
      });
      const headers = await portal(owner.id);
      return {
        send: () =>
          t.http
            .patch(`/v1/tenants/${tenant.id}/payment-connections/test`)
            .set(headers)
            .set("If-Match", `"${connection.version}"`)
            .send({ statementDescriptorSuffix: "COVERAGE TRAVEL" }),
        status: 200,
        events: [{ v: 1, type: "connection", tenantId: tenant.id }],
      };
    },
  },

  // ---- membership: role, status, removal --------------------------------------------------------------------------
  {
    change: "member role change",
    operationId: "updateMember",
    publishes: ["membership"],
    async arrange() {
      const owner = await person();
      const agent = await person();
      const { tenant, memberships } = await ota({
        members: [
          [owner, "owner"],
          [agent, "agent"],
        ],
      });
      const membership = memberships[1];
      if (membership === undefined) {
        throw new Error("insertOta wrote no agent membership");
      }
      const headers = await portal(owner.id);
      return {
        send: () =>
          t.http
            .patch(`/v1/tenants/${tenant.id}/members/${membership.id}`)
            .set(headers)
            .set("If-Match", `"${membership.version}"`)
            .send({ role: "finance" }),
        status: 200,
        events: [{ v: 1, type: "membership", accountId: agent.id, tenantId: tenant.id }],
      };
    },
  },
  {
    change: "member removal",
    operationId: "removeMember",
    publishes: ["membership"],
    async arrange() {
      const owner = await person();
      const agent = await person();
      const { tenant } = await ota({ members: [[owner, "owner"]] });
      const membership = await insertMember(pool, tenant, agent, "agent");
      const headers = await portal(owner.id);
      return {
        send: () => t.http.delete(`/v1/tenants/${tenant.id}/members/${membership.id}`).set(headers),
        status: 204,
        events: [{ v: 1, type: "membership", accountId: agent.id, tenantId: tenant.id }],
      };
    },
  },
  {
    change: "invitation acceptance",
    operationId: "acceptInvitation",
    publishes: ["membership"],
    async arrange() {
      const owner = await person();
      const invitee = await person();
      const { tenant } = await ota({ members: [[owner, "owner"]] });
      const { token, hash } = generateToken("iv");
      await insertRow(pool, "tenant_invitations", {
        id: ids.new("ivt"),
        tenant_id: tenant.id,
        email: invitee.email,
        role: "agent",
        token_hash: hash,
        status: "pending",
        invited_by_account_id: owner.id,
        expires_at: daysAfterNow(7),
        created_at: t.clock.now(),
        updated_at: t.clock.now(),
      });
      const headers = await portal(invitee.id);
      return {
        send: () => t.http.post("/v1/invitations/accept").set(headers).send({ token }),
        status: 200,
        events: [{ v: 1, type: "membership", accountId: invitee.id, tenantId: tenant.id }],
      };
    },
  },

  // ---- account: disabled, MFA changed, password changed, sessions ended --------------------------------------------
  {
    change: "account disable",
    operationId: "adminDisableAccount",
    publishes: ["account"],
    async arrange() {
      const account = await person();
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http.post(`/v1/admin/accounts/${account.id}/disable`).set(headers).send({ reason: REASON }),
        status: 200,
        events: [{ v: 1, type: "account", accountId: account.id }],
      };
    },
  },
  {
    change: "account enable",
    operationId: "adminEnableAccount",
    publishes: ["account"],
    async arrange() {
      const account = await person({ status: "disabled" });
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http.post(`/v1/admin/accounts/${account.id}/enable`).set(headers).send({ reason: REASON }),
        status: 200,
        events: [{ v: 1, type: "account", accountId: account.id }],
      };
    },
  },
  {
    change: "MFA reset by a platform admin",
    operationId: "adminResetAccountMfa",
    publishes: ["account"],
    async arrange() {
      const account = await person(withMfa());
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http.post(`/v1/admin/accounts/${account.id}/reset-mfa`).set(headers).send({ reason: REASON }),
        status: 200,
        events: [{ v: 1, type: "account", accountId: account.id }],
      };
    },
  },
  {
    change: "MFA turned on",
    operationId: "enableMfa",
    publishes: ["account"],
    async arrange() {
      const account = await person();
      const headers = await portal(account.id);
      const setup = await t.http.post("/v1/me/mfa/setup").set(headers);
      if (setup.status !== 200) {
        throw new Error(`startMfaSetup answered ${setup.status}, not 200`);
      }
      const { secret } = setup.body as { secret: string };
      return {
        send: () =>
          t.http
            .post("/v1/me/mfa/enable")
            .set(headers)
            .send({ code: totpCode(secret, t.clock.now()) }),
        status: 200,
        events: [{ v: 1, type: "account", accountId: account.id }],
      };
    },
  },
  {
    change: "MFA turned off",
    operationId: "disableMfa",
    publishes: ["account"],
    async arrange() {
      const account = await person(withMfa());
      const headers = await steppedUp(account.id);
      return {
        send: () => t.http.post("/v1/me/mfa/disable").set(headers),
        status: 204,
        events: [{ v: 1, type: "account", accountId: account.id }],
      };
    },
  },
  {
    change: "password change",
    operationId: "changePassword",
    publishes: ["account"],
    async arrange() {
      const account = await person();
      const headers = await portal(account.id);
      return {
        send: () =>
          t.http
            .post("/v1/me/password")
            .set(headers)
            .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }),
        status: 204,
        events: [{ v: 1, type: "account", accountId: account.id }],
      };
    },
  },
  {
    change: "password reset",
    operationId: "confirmPasswordReset",
    publishes: ["account"],
    async arrange() {
      const account = await person();
      const { token } = await insertAccountToken(pool, account, {
        id: ids.new("atk"),
        purpose: "password_reset",
        expires_at: daysAfterNow(1),
      });
      return {
        send: () =>
          t.http
            .post("/v1/auth/password-reset/confirm")
            .set(t.bffHeaders(PERSON_IP))
            .send({ token, newPassword: NEW_PASSWORD }),
        status: 204,
        events: [{ v: 1, type: "account", accountId: account.id }],
      };
    },
  },
  {
    change: "sign out everywhere",
    operationId: "signOutEverywhere",
    publishes: ["account"],
    async arrange() {
      const account = await person();
      const headers = await portal(account.id);
      return {
        send: () => t.http.post("/v1/auth/sign-out-everywhere").set(headers),
        status: 204,
        events: [{ v: 1, type: "account", accountId: account.id }],
      };
    },
  },

  // ---- amadeus_account: shared credentials rotated or disabled, office status changed ----------------------------
  {
    change: "shared account rotation (a new client secret)",
    operationId: "adminUpdateAmadeusAccount",
    publishes: ["amadeus_account"],
    async arrange() {
      const version = await amadeusAccountAt("active");
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http
            .patch(`/v1/admin/amadeus-accounts/${amadeusAccount.id}`)
            .set(headers)
            .set("If-Match", `"${version}"`)
            .send({ clientSecret: `coverage-${randomUUID()}` }),
        status: 200,
        events: [{ v: 1, type: "amadeus_account", id: amadeusAccount.id }],
      };
    },
  },
  {
    change: "shared account disabled",
    operationId: "adminUpdateAmadeusAccount",
    publishes: ["amadeus_account"],
    async arrange() {
      const version = await amadeusAccountAt("active");
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http
            .patch(`/v1/admin/amadeus-accounts/${amadeusAccount.id}`)
            .set(headers)
            .set("If-Match", `"${version}"`)
            .send({ status: "disabled" }),
        status: 200,
        events: [{ v: 1, type: "amadeus_account", id: amadeusAccount.id }],
      };
    },
  },
  {
    change: "disabled shared account sent to verification again",
    operationId: "adminVerifyAmadeusAccount",
    publishes: ["amadeus_account"],
    async arrange() {
      await amadeusAccountAt("disabled");
      const headers = await adminHeaders();
      return {
        send: () => t.http.post(`/v1/admin/amadeus-accounts/${amadeusAccount.id}/verify`).set(headers),
        status: 202,
        events: [{ v: 1, type: "amadeus_account", id: amadeusAccount.id }],
      };
    },
  },
  {
    change: "office retired",
    operationId: "adminRetireAmadeusOffice",
    publishes: ["amadeus_account"],
    async arrange() {
      const office = await insertAmadeusOffice(pool, amadeusAccount, { id: ids.new("amo") });
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http.post(`/v1/admin/amadeus-offices/${office.id}/retire`).set(headers).send({ reason: REASON }),
        status: 200,
        events: [{ v: 1, type: "amadeus_account", id: amadeusAccount.id }],
      };
    },
  },

  // ---- plan: limits or features --------------------------------------------------------------------------------
  {
    change: "plan limits change",
    operationId: "adminUpdatePlan",
    publishes: ["plan"],
    async arrange() {
      const plan = await insertPlan(pool, { code: planCode() });
      const headers = await adminHeaders();
      return {
        send: () =>
          t.http
            .patch(`/v1/admin/plans/${plan.code}`)
            .set(headers)
            // A plan's version is derived from `updated_at` (plans.repository.ts): no `version` column.
            .set("If-Match", `"${planVersion(plan.updated_at)}"`)
            .send({ limits: { staffSeats: 20, apiKeys: 10, customDomains: 1, liveMode: true } }),
        status: 200,
        events: [{ v: 1, type: "plan", code: plan.code }],
      };
    },
  },
];

// ---- Set-up --------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  ids = t.app.get(IdGenerator);
  tokens = t.app.get(TokenService);
  passwordHash = await t.app.get(PasswordPolicy).hash(TEST_PASSWORD);
  // Parse the platform document for expectResponseToMatch here (about half a second alone), not in the first row.
  responseChecker("platform");

  subscriber = new Redis(t.redis.url, {
    lazyConnect: true,
    connectionName: "platform-invalidation-coverage",
  });
  subscriber.on("message", onMessage);
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
  markerClient = new Redis(t.redis.url, {
    lazyConnect: true,
    connectionName: "platform-invalidation-markers",
  });
  await markerClient.connect();

  admin = await insertAccount(pool, {
    id: mine(ids.new("acc")),
    email: uniqueEmail("coverage-admin"),
    is_platform_admin: true,
    password_hash: passwordHash,
    ...withMfa(),
  });
  amadeusAccount = await insertAmadeusAccount(pool, { id: mine(ids.new("ama")) });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await markerClient?.quit();
  await subscriber?.quit();
  await t?.close();
}, SETUP_TIMEOUT_MS);

// ---- Tests -------------------------------------------------------------------------------------------------------

describe("the invalidation coverage table", () => {
  for (const { change, operationId, publishes, arrange } of COVERAGE) {
    it(`[PBE-036 AC1] ${change} (${operationId}) publishes exactly its ${publishes.join(" and ")} event`, async () => {
      const mutation = await arrange();
      // The row is consistent: its events are of the types it names.
      expect(mutation.events.map(({ type }) => type).sort()).toEqual([...publishes].sort());

      const observed = await observe(mutation.send);

      expect(outcomeOf(observed.response)).toBe(String(mutation.status));
      expectResponseToMatch(operationId, observed.response, { document: "platform" });
      expectPublished(observed, mutation.events);
    });
  }

  it("[PBE-036 AC1] covers every invalidation type; `domain` waits for the custom domain operations of M5, which are still pending", () => {
    const covered = new Set<InvalidationType>(COVERAGE.flatMap(({ publishes }) => publishes));
    expect(INVALIDATION_TYPES.filter((type) => !covered.has(type))).toEqual(["domain"]);
    // Once one of them is bound, its row (and the `domain` event) belongs in the table.
    const pending = new Set<string>(PENDING_OPERATIONS.map(({ operationId }) => operationId));
    expect(DOMAIN_OPERATIONS.filter((operationId) => !pending.has(operationId))).toEqual([]);
  });

  it("[PBE-036 AC1] a row whose mutation publishes nothing fails, and so does one that publishes more than its events", async () => {
    // A mutation added to the table without its event: here a read in place of a mutation, which publishes nothing.
    const owner = await person();
    const { tenant } = await ota({ members: [[owner, "owner"]] });
    const silent = await observe(async () =>
      t.http.get(`/v1/tenants/${tenant.id}`).set(await portal(owner.id)),
    );
    expect(outcomeOf(silent.response)).toBe("200");
    expect(silent.published).toEqual([]);
    expect(() => expectPublished(silent, [{ v: 1, type: "tenant", id: tenant.id }])).toThrow();

    // An event the row does not name (a mutation that publishes for another row, or twice) fails it too.
    const loud = await observe(async () =>
      t.http
        .patch(`/v1/tenants/${tenant.id}`)
        .set(await portal(owner.id))
        .set("If-Match", `"${tenant.version}"`)
        .send({ name: "Coverage Self Test Travel" }),
    );
    expect(outcomeOf(loud.response)).toBe("200");
    expect(() => expectPublished(loud, [])).toThrow();
    expectPublished(loud, [{ v: 1, type: "tenant", id: tenant.id }]);
  });
});
