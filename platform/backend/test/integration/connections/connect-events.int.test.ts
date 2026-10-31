// The Connect account events (PBE-056; Stripe payments flow §C item 5 and "Failure handling", PADR-0011 items 3 and 4,
// api-inventory-admin.md §8, scope PF-61 AC2): the X-028 fixtures `account.updated` and
// `account.application.deauthorized`, signed with a secret made for this file, are posted to
// `POST /webhooks/stripe/connect-accounts` of the API (createTestApp), and the worker's module graph (WorkerModule, as
// dist/worker.js builds it, with the API's FakeClock) processes them on this file's database clone and Redis database.
// Stripe is the FakeStripe of test/support/fake-stripe.ts (a subclass here, so a test can act between a re-fetch and its
// answer): the handler re-fetches the connected account from it, so each test puts there what Stripe would answer.
//
// Each test arranges an OTA of its own (ids of this file's range, so the invalidations of other test files on the same
// Redis server never match) with `connect_standard` connections of one `acct_…`, delivers one event at a time and waits
// until its inbox row is done. The worker's milestone switches are a set this file changes (`own_stripe` on unless a
// test turns it off), and its job schedulers are not registered (JobSchedulerRegistry replaced). The worker's e-mail
// processor sends the owners' e-mails to Mailpit; every address is a `uniqueEmail` of this file. The Stripe settings are
// the development values of `.env.example`, with this file's Connect signing secret. FIX-W37-PLATFORM (lead decision
// (2k) of 2026-10-31): a deauthorisation of connections an admin disabled writes one audit row per connection and
// event (none for one older than the connections), and changes nothing else.
import { randomBytes } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { INVALIDATION_CHANNEL, type InvalidationEvent } from "@velexis/api-types/jobs";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import { signedStripeEvent, stripeFixture } from "@velexis/testing/stripe";
import { Redis } from "ioredis";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StripeEventsProcessor } from "../../../src/billing/sync/stripe-events.processor";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { FeatureSwitches, type Feature } from "../../../src/common/features";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { StripeClient, type StripeApi } from "../../../src/common/stripe/stripe.client";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertPaymentConnection,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeStripe } from "../../support/fake-stripe";

/**
 * The database clone, the API's and the worker's Nest module graphs and the platform document of
 * expectResponseToMatch; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish an event (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 3_000, interval: 20 } as const;
/** How long a test waits for an invalidation published after a commit. */
const EVENT_WAIT = { timeout: 2_000, interval: 20 } as const;
/** How long a test waits for the worker's e-mail to reach Mailpit. */
const MAIL_WAIT_MS = 3_000;

/** The signing secret of `/webhooks/stripe/connect-accounts` in this file only. */
const SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const PATH = "/webhooks/stripe/connect-accounts";
/** The Stripe settings of the application: the development values of `.env.example` and this file's secret. */
const STRIPE_ENV = Object.freeze({
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_CONNECT_CLIENT_ID: "ca_replace_me",
  STRIPE_CONNECT_WEBHOOK_SECRET: SECRET,
});
/** The first number of this file's ids (`testId`), away from the other test files'. */
const FIRST_ID = 56_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;
type ConnectEventType = "account.updated" | "account.application.deauthorized";

/**
 * The FakeStripe with one test hook: `afterRetrieve` runs once, after the next `accounts.retrieve` has its answer and
 * before the handler gets it, so a test can change the connections or the account while the handler waits for Stripe.
 */
class HookedStripe extends FakeStripe {
  afterRetrieve: (() => Promise<void>) | undefined;

  override api(): StripeApi {
    const api = super.api();
    const retrieve = (async (id: string, params?: Stripe.AccountRetrieveParams) => {
      const answer = await api.accounts.retrieve(id, params);
      const hook = this.afterRetrieve;
      this.afterRetrieve = undefined;
      await hook?.();
      return answer;
    }) as StripeApi["accounts"]["retrieve"];
    return { ...api, accounts: { retrieve } };
  }
}

/** The worker's milestone switches: `own_stripe` on unless a test turns it off. */
const switchedOn = new Set<Feature>();
const switches = { isEnabled: (feature: Feature): boolean => switchedOn.has(feature) };

const stripe = new HookedStripe();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let subscriber: Redis;
const invalidations: InvalidationEvent[] = [];
const workerLogs = new LogSink();
let next = FIRST_ID;

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs, the invalidation subscriber, the platform
  // document of expectResponseToMatch and the fixtures.
  t = await createTestApp({ env: STRIPE_ENV, overrides: [{ provide: StripeClient, useValue: stripe }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  responseChecker("platform");
  stripeFixture("account.updated");
  stripeFixture("account.application.deauthorized");

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .overrideProvider(StripeClient)
    .useValue(stripe)
    .overrideProvider(FeatureSwitches)
    .useValue(switches)
    .compile();
  await worker.init();

  subscriber = new Redis(t.redis.url, { lazyConnect: true });
  subscriber.on("message", (_channel: string, message: string) => {
    invalidations.push(JSON.parse(message) as InvalidationEvent);
  });
  await subscriber.connect();
  await subscriber.subscribe(INVALIDATION_CHANNEL);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await subscriber?.quit();
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(() => {
  switchedOn.clear();
  switchedOn.add("own_stripe");
  stripe.reset();
  stripe.afterRetrieve = undefined;
});

// ---- Arrangement ---------------------------------------------------------------------------------------------------

/** A connected Stripe account id of this file (`acct_`, letters and digits, as the connections' CHECK takes it). */
const newAccountId = (): string => `acct_1QTestPbe056Agency${next++}`;

/** A new event id of the fixtures' shape. */
const newEventId = (label: string): string => `evt_test_pbe056_${label}_${next++}`;

/** The FakeClock's time in Stripe's whole seconds. */
const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** What an OTA of this file has: its connections of one `acct_…` and its people. */
interface Ota {
  readonly tenant: PlatformRow<"tenants">;
  readonly accountReference: string;
  readonly test: PlatformRow<"payment_provider_connections">;
  readonly live: PlatformRow<"payment_provider_connections">;
  /** The two active owners, who get the owners' e-mails. */
  readonly owners: ReadonlyArray<PlatformRow<"accounts">>;
  /** Members who never get them: an admin, an owner whose membership was removed, an owner whose account is disabled. */
  readonly others: ReadonlyArray<PlatformRow<"accounts">>;
}

/** The connection columns of a test: `connect_standard` on `accountReference`, connected a day ago, `active`. */
function connectColumns(accountReference: string, connection: Row = {}): Row {
  return {
    id: testId("ppc", next++),
    account_mode: "connect_standard",
    account_reference: accountReference,
    statement_descriptor_suffix: null,
    status: "active",
    capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    connected_at: new Date(t.clock.now().getTime() - DAY_MS),
    ...connection,
  };
}

/** An OTA of this file whose test and live connections are `connect_standard` on one account (`connection` merged). */
async function arrangeOta(connection: Row = {}): Promise<Ota> {
  const n = next++;
  const { tenant } = await insertOta(pool, {
    tenant: {
      id: testId("ten", n),
      key: `pbe${n}`,
      name: `Agency ${n} Travel`,
      storefront_environment: "live",
      live_enabled_at: new Date(t.clock.now().getTime() - 2 * DAY_MS),
    },
  });
  const person = (label: string, status = "active") =>
    insertAccount(pool, { id: testId("acc", next++), email: uniqueEmail(label), status });
  const owners = [await person("owner-pbe056"), await person("owner-pbe056")];
  for (const owner of owners) {
    await insertMember(pool, tenant, owner, "owner");
  }
  const admin = await person("admin-pbe056");
  await insertMember(pool, tenant, admin, "admin");
  const removed = await person("removed-pbe056");
  await insertMembership(pool, tenant, removed, { role: "owner", status: "removed" });
  const disabled = await person("disabled-pbe056", "disabled");
  await insertMember(pool, tenant, disabled, "owner");
  const accountReference = newAccountId();
  const test = await insertPaymentConnection(pool, tenant, connectColumns(accountReference, connection));
  const live = await insertPaymentConnection(pool, tenant, {
    ...connectColumns(accountReference, connection),
    environment: "live",
  });
  return { tenant, accountReference, test, live, owners, others: [admin, removed, disabled] };
}

/** The account as Stripe answers a retrieve: the fixture's account under `id` with the three flags. */
function stripeAccount(
  id: string,
  flags: { readonly charges: boolean; readonly payouts?: boolean; readonly details?: boolean },
): Stripe.Account {
  return {
    ...stripeFixture("account.updated").data.object,
    id,
    charges_enabled: flags.charges,
    payouts_enabled: flags.payouts ?? flags.charges,
    details_submitted: flags.details ?? true,
  };
}

// ---- Deliveries ----------------------------------------------------------------------------------------------------

/** A signed delivery of the endpoint. */
interface Delivery {
  readonly eventId: string;
  readonly payload: string;
  readonly header: string;
}

/**
 * The fixture of `type` for the connected account `account`, created at the FakeClock's second (or `created`), signed
 * with this file's secret at the FakeClock's time; `overrides` deep-merged last.
 */
function connectEvent(
  type: ConnectEventType,
  account: string,
  options: { readonly eventId?: string; readonly created?: number; readonly overrides?: Row } = {},
): Delivery {
  const eventId = options.eventId ?? newEventId(type === "account.updated" ? "updated" : "deauthorized");
  const { payload, header } = signedStripeEvent(
    type,
    {
      id: eventId,
      account,
      created: options.created ?? nowSeconds(),
      ...(type === "account.updated" ? { data: { object: { id: account } } } : {}),
      ...options.overrides,
    } as never,
    SECRET,
    { timestamp: t.clock.now() },
  );
  return { eventId, payload, header };
}

/** Posts `payload` to the Connect endpoint as Stripe does. */
function post(payload: string, header: string | undefined) {
  const call = t.http.post(PATH).set("Content-Type", "application/json");
  return (header === undefined ? call : call.set("Stripe-Signature", header)).send(payload);
}

/** Posts `delivery`, expects the `200`, and waits until the worker is done with it; answers its inbox row. */
async function deliver(delivery: Delivery): Promise<Row> {
  const res = await post(delivery.payload, delivery.header);
  expect(res.status).toBe(200);
  return vi.waitFor(async () => {
    const row = await eventRow(delivery.eventId);
    expect(["processed", "ignored", "failed"]).toContain(row?.["status"]);
    return row as Row;
  }, WAIT);
}

// ---- Rows ----------------------------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const eventRow = async (id: string): Promise<Row | undefined> =>
  (await rowsOf("SELECT * FROM platform.stripe_events WHERE id = $1", [id]))[0];

const connectionOf = async (id: string): Promise<Row> =>
  (await rowsOf("SELECT * FROM platform.payment_provider_connections WHERE id = $1", [id]))[0] as Row;

const connectionsOfTenant = (tenantId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT * FROM platform.payment_provider_connections WHERE tenant_id = $1 ORDER BY environment = 'live', id",
    [tenantId],
  );

const auditOf = (tenantId: string, action: string): Promise<Row[]> =>
  rowsOf(
    "SELECT * FROM platform.platform_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY target_id, id",
    [tenantId, action],
  );

const emailsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT template, to_email, account_id, data FROM platform.email_outbox WHERE tenant_id = $1 ORDER BY id",
    [tenantId],
  );

/** Waits for the `connection` invalidation of `tenantId`. */
async function expectConnectionInvalidation(tenantId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(invalidations).toContainEqual({ v: 1, type: "connection", tenantId });
  }, EVENT_WAIT);
}

/** The log lines `msg` of either process: nestjs-pino keeps one root logger per process, so a line may land in either sink. */
const logLines = (msg: string): Array<Record<string, unknown>> =>
  [...t.logs.lines, ...workerLogs.lines].filter((line) => line["msg"] === msg);

const invalidationsOf = (tenantId: string): InvalidationEvent[] =>
  invalidations.filter((event) => "tenantId" in event && event.tenantId === tenantId);

// ---- Tests ---------------------------------------------------------------------------------------------------------

describe("POST /webhooks/stripe/connect-accounts (receiveStripeConnectAccountEvent)", () => {
  it("[PBE-056] stores a signed Connect event once with its account and endpoint connect_accounts, and refuses the rest", async () => {
    const ota = await arrangeOta();
    stripe.put(stripeAccount(ota.accountReference, { charges: true }));
    const delivery = connectEvent("account.updated", ota.accountReference);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await post(delivery.payload, delivery.header);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectResponseToMatch("receiveStripeConnectAccountEvent", res, { document: "platform" });
    }
    const row = await vi.waitFor(async () => {
      const found = await eventRow(delivery.eventId);
      expect(found?.["status"]).toBe("processed");
      return found as Row;
    }, WAIT);
    expect(row).toMatchObject({
      endpoint: "connect_accounts",
      type: "account.updated",
      livemode: false,
      account: ota.accountReference,
      object_type: "account",
      object_id: ota.accountReference,
      attempts: 1,
      tenant_id: ota.tenant.id,
    });
    expect(
      await rowsOf("SELECT id FROM platform.stripe_events WHERE id = $1", [delivery.eventId]),
    ).toHaveLength(1);

    // Not a Connect event (no `account`), another secret, a changed body, the other mode: refused, nothing stored.
    const withoutAccount = connectEvent("account.updated", ota.accountReference, {
      overrides: { account: undefined },
    });
    const otherSecret = signedStripeEvent(
      "account.updated",
      { id: newEventId("secret"), account: ota.accountReference },
      `whsec_${randomBytes(24).toString("base64url")}`,
      { timestamp: t.clock.now() },
    );
    const changed = connectEvent("account.application.deauthorized", ota.accountReference);
    const liveEvent = connectEvent("account.application.deauthorized", ota.accountReference, {
      overrides: { livemode: true },
    });
    const refused = [
      { delivery: withoutAccount, code: "VALIDATION_FAILED", path: "/account" },
      { delivery: { ...otherSecret, eventId: otherSecret.event.id }, code: "WEBHOOK_SIGNATURE_INVALID" },
      {
        delivery: { ...changed, payload: changed.payload.replace('"livemode": false', '"livemode": true') },
        code: "WEBHOOK_SIGNATURE_INVALID",
      },
      { delivery: liveEvent, code: "VALIDATION_FAILED", path: "/livemode" },
    ];
    for (const { delivery: refusedDelivery, code, path } of refused) {
      const res = await post(refusedDelivery.payload, refusedDelivery.header);

      const { error } = res.body as { error: { code: string; fieldErrors?: Array<{ path: string }> } };
      expect([code, res.status, error.code]).toEqual([code, 400, code]);
      expectResponseToMatch("receiveStripeConnectAccountEvent", res, { document: "platform" });
      if (path !== undefined) {
        expect(error.fieldErrors).toEqual([expect.objectContaining({ path })]);
      }
      expect(await eventRow(refusedDelivery.eventId)).toBeUndefined();
    }
    expect(await connectionOf(ota.test.id)).toMatchObject({ status: "active", version: 1 });
  });
  it("[PBE-056] stores each X-028 fixture of the Connect endpoint as it is, and ends it ignored for an unknown account", async () => {
    // The fixtures as written (the contract test's WEBHOOK_FIXTURES of receiveStripeConnectAccountEvent), signed now.
    for (const type of ["account.updated", "account.application.deauthorized"] as const) {
      const { payload, header, event } = signedStripeEvent(type, undefined, SECRET, {
        timestamp: t.clock.now(),
      });

      const row = await deliver({ eventId: event.id, payload, header });

      expect(row).toMatchObject({
        id: event.id,
        endpoint: "connect_accounts",
        type,
        account: "acct_test_alpha",
        object_type: type === "account.updated" ? "account" : "application",
        stripe_created_at: new Date(event.created * 1000),
        status: "ignored",
        last_error: "UNKNOWN_ACCOUNT: no OTA's Connect connection holds the account",
      });
    }
    expect(stripe.calls).toEqual([]);
  });
});

describe("account.application.deauthorized", () => {
  it("[PBE-056 AC1] disables every connection of the account, keeps connect_standard, audits and e-mails the owners", async () => {
    const ota = await arrangeOta();
    const delivery = connectEvent("account.application.deauthorized", ota.accountReference);

    const row = await deliver(delivery);

    expect(row).toMatchObject({
      status: "processed",
      last_error: null,
      tenant_id: ota.tenant.id,
      object_type: "application",
    });
    const now = t.clock.now();
    for (const connection of await connectionsOfTenant(ota.tenant.id)) {
      // Disabled with the time of the event's processing; the mode, the account and the capabilities stay: no
      // fallback to Velexis mode (PADR-0011 item 4).
      expect(connection).toMatchObject({
        account_mode: "connect_standard",
        account_reference: ota.accountReference,
        status: "disabled",
        disconnected_at: now,
        connected_at: ota.test.connected_at,
        capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
        secret_ciphertext: null,
        publishable_key: null,
        version: 2,
      });
    }
    const audit = await auditOf(ota.tenant.id, "payments.connect_disconnected");
    expect(audit.map((entry) => entry["target_id"])).toEqual([ota.test.id, ota.live.id].sort());
    for (const entry of audit) {
      expect(entry).toMatchObject({
        actor_type: "system",
        actor_account_id: null,
        actor_label: "stripe.connect_events",
        target_type: "payment_connection",
        details: {
          environment: entry["target_id"] === ota.test.id ? "test" : "live",
          accountReference: ota.accountReference,
          eventId: delivery.eventId,
          eventType: "account.application.deauthorized",
          before: { status: "active", disconnectedAt: null },
          after: { accountMode: "connect_standard", status: "disabled", disconnectedAt: now.toISOString() },
        },
      });
    }
    // One e-mail to each active owner, none to the admin, the removed owner or the disabled account.
    const emails = await emailsOf(ota.tenant.id);
    const byAddress = (a: readonly unknown[], b: readonly unknown[]): number =>
      String(a[1]) < String(b[1]) ? -1 : String(a[1]) > String(b[1]) ? 1 : 0;
    expect(
      emails.map((email) => [email["template"], email["to_email"], email["account_id"]]).sort(byAddress),
    ).toEqual(
      ota.owners.map((owner) => ["connection.stripe_disconnected", owner.email, owner.id]).sort(byAddress),
    );
    for (const email of emails) {
      expect(email["data"]).toMatchObject({
        tenantName: ota.tenant.name,
        tenantKey: ota.tenant.key,
        paymentsUrl: expect.stringMatching(new RegExp(`/otas/${ota.tenant.id}/payments$`)) as unknown,
      });
    }
    const [owner] = ota.owners;
    const message = await waitForMessage({ to: owner?.email ?? "", timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`Stripe was disconnected from ${ota.tenant.name}`);
    expect(message.Text).toContain(
      `${ota.tenant.name} (${ota.tenant.key}) was disconnected from Velexis in Stripe`,
    );
    expect(message.Text).toContain(`/otas/${ota.tenant.id}/payments`);
    await expectConnectionInvalidation(ota.tenant.id);
    // Stripe is not asked anything: the signed event is the fact.
    expect(stripe.calls).toEqual([]);
    expect(logLines("stripe_connect.account_deauthorized")).toContainEqual(
      expect.objectContaining({ eventId: delivery.eventId, tenantId: ota.tenant.id }),
    );

    // Stripe delivers it again, and a second deauthorisation event comes: nothing changes, nobody is e-mailed twice.
    const again = await post(delivery.payload, delivery.header);
    expect(again.status).toBe(200);
    const second = await deliver(connectEvent("account.application.deauthorized", ota.accountReference));
    expect(second).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect((await connectionsOfTenant(ota.tenant.id)).map((connection) => connection["version"])).toEqual([
      2, 2,
    ]);
    expect(await auditOf(ota.tenant.id, "payments.connect_disconnected")).toHaveLength(2);
    expect(await emailsOf(ota.tenant.id)).toHaveLength(2);
    expect(await eventRow(delivery.eventId)).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("[PBE-056 AC1] keeps a connection connected again after the event, and one a platform admin disabled", async () => {
    const reconnected = await arrangeOta({ connected_at: t.clock.now() });
    const adminDisabled = await arrangeOta({ status: "disabled" });

    // A late delivery of a deauthorisation older than the connection's `connected_at`.
    const stale = await deliver(
      connectEvent("account.application.deauthorized", reconnected.accountReference, {
        created: nowSeconds() - 3600,
      }),
    );
    // An OTA whose connection an admin disabled: the admin's disable holds (no `disconnected_at`, so a callback
    // still refuses it).
    const kept = await deliver(
      connectEvent("account.application.deauthorized", adminDisabled.accountReference),
    );

    expect(stale).toMatchObject({
      status: "ignored",
      last_error: "STALE_EVENT: the account was connected again after this deauthorisation",
      tenant_id: reconnected.tenant.id,
    });
    expect(kept).toMatchObject({ status: "processed", tenant_id: adminDisabled.tenant.id });
    for (const [ota, status] of [
      [reconnected, "active"],
      [adminDisabled, "disabled"],
    ] as const) {
      for (const connection of await connectionsOfTenant(ota.tenant.id)) {
        expect(connection).toMatchObject({ status, disconnected_at: null, version: 1 });
      }
      expect(await auditOf(ota.tenant.id, "payments.connect_disconnected")).toEqual([]);
      expect(await emailsOf(ota.tenant.id)).toEqual([]);
      expect(invalidationsOf(ota.tenant.id)).toEqual([]);
    }
    expect(logLines("stripe_connect.deauthorized_admin_disabled")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: adminDisabled.tenant.id, connectionId: adminDisabled.test.id }),
      ]),
    );
  });

  it("[FIX-W37-PLATFORM AC5] records the deauthorisation of connections an admin disabled in one audit row each, and changes nothing else", async () => {
    const ota = await arrangeOta({ status: "disabled" });
    const delivery = connectEvent("account.application.deauthorized", ota.accountReference);

    const row = await deliver(delivery);

    expect(row).toMatchObject({ status: "processed", last_error: null, tenant_id: ota.tenant.id });
    // The admin's disable holds: status, disconnected_at and version as they were.
    for (const connection of await connectionsOfTenant(ota.tenant.id)) {
      expect(connection).toMatchObject({ status: "disabled", disconnected_at: null, version: 1 });
    }
    const audit = await auditOf(ota.tenant.id, "payments.connect_deauthorized_while_disabled");
    expect(audit.map((entry) => entry["target_id"])).toEqual([ota.test.id, ota.live.id].sort());
    for (const entry of audit) {
      expect(entry).toMatchObject({
        actor_type: "system",
        actor_account_id: null,
        actor_label: "stripe.connect_events",
        target_type: "payment_connection",
        tenant_key: ota.tenant.key,
      });
      // Exactly these facts: no before or after (nothing changed), no payload, token or e-mail address.
      expect(entry["details"]).toEqual({
        environment: entry["target_id"] === ota.test.id ? "test" : "live",
        accountReference: ota.accountReference,
        eventId: delivery.eventId,
        eventType: "account.application.deauthorized",
        status: "disabled",
      });
    }
    expect(await auditOf(ota.tenant.id, "payments.connect_disconnected")).toEqual([]);
    expect(await emailsOf(ota.tenant.id)).toEqual([]);
    expect(invalidationsOf(ota.tenant.id)).toEqual([]);
    expect(stripe.calls).toEqual([]);

    // The inbox runs the same event again (its row stayed processing after the handler's commit): no second row.
    await pool.query("UPDATE platform.stripe_events SET status = 'processing' WHERE id = $1", [
      delivery.eventId,
    ]);
    expect(
      await worker
        .get(StripeEventsProcessor, { strict: false })
        .processEvent(delivery.eventId, { attemptsMade: 0, opts: { attempts: 5 } }),
    ).toEqual({ eventId: delivery.eventId, status: "processed" });
    expect(await auditOf(ota.tenant.id, "payments.connect_deauthorized_while_disabled")).toHaveLength(2);
    expect(await emailsOf(ota.tenant.id)).toEqual([]);
    for (const connection of await connectionsOfTenant(ota.tenant.id)) {
      expect(connection).toMatchObject({ status: "disabled", disconnected_at: null, version: 1 });
    }

    // A late delivery of a deauthorisation older than the connections (connected a day ago): it revoked an earlier
    // connection, so it writes no row.
    const older = await deliver(
      connectEvent("account.application.deauthorized", ota.accountReference, {
        created: nowSeconds() - 2 * 24 * 3600,
      }),
    );
    expect(older).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect(await auditOf(ota.tenant.id, "payments.connect_deauthorized_while_disabled")).toHaveLength(2);
  });
});

describe("account.updated", () => {
  it("[PBE-056 AC2] turns a pending connection active when the re-fetched account has charges enabled", async () => {
    const ota = await arrangeOta({
      status: "pending",
      capabilities: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false },
    });
    stripe.put(stripeAccount(ota.accountReference, { charges: true, payouts: false }));
    const delivery = connectEvent("account.updated", ota.accountReference, {
      // The payload says nothing true: the handler reads Stripe's answer only (PADR-0002 item 5).
      overrides: { data: { object: { id: ota.accountReference, charges_enabled: false } } },
    });

    const row = await deliver(delivery);

    expect(row).toMatchObject({ status: "processed", last_error: null, tenant_id: ota.tenant.id });
    // The re-fetch that writes, and the one after its commit that confirms it.
    expect(stripe.callsOf("accounts.retrieve")).toEqual([
      expect.objectContaining({ id: ota.accountReference }),
      expect.objectContaining({ id: ota.accountReference }),
    ]);
    const capabilities = { chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true };
    for (const connection of await connectionsOfTenant(ota.tenant.id)) {
      expect(connection).toMatchObject({
        account_mode: "connect_standard",
        account_reference: ota.accountReference,
        status: "active",
        capabilities,
        disconnected_at: null,
        version: 2,
      });
    }
    const audit = await auditOf(ota.tenant.id, "payments.connect_status_changed");
    expect(audit.map((entry) => entry["target_id"])).toEqual([ota.test.id, ota.live.id].sort());
    for (const entry of audit) {
      expect(entry).toMatchObject({
        actor_type: "system",
        actor_label: "stripe.connect_events",
        target_type: "payment_connection",
        details: {
          environment: entry["target_id"] === ota.test.id ? "test" : "live",
          accountReference: ota.accountReference,
          eventId: delivery.eventId,
          eventType: "account.updated",
          before: {
            status: "pending",
            capabilities: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false },
          },
          after: { status: "active", capabilities },
        },
      });
    }
    await expectConnectionInvalidation(ota.tenant.id);
    expect(await emailsOf(ota.tenant.id)).toEqual([]);
  });

  it("[PBE-056 AC2] turns an active connection pending when charges stop, and writes nothing when Stripe confirms the row", async () => {
    const ota = await arrangeOta();
    stripe.put(stripeAccount(ota.accountReference, { charges: true }));

    // Stripe confirms what the connections hold: no write, no audit row, no invalidation.
    const confirmed = await deliver(connectEvent("account.updated", ota.accountReference));
    expect(confirmed).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    // One re-fetch: nothing was written, so there is nothing to confirm.
    expect(stripe.callsOf("accounts.retrieve")).toHaveLength(1);
    expect((await connectionsOfTenant(ota.tenant.id)).map((row) => [row["status"], row["version"]])).toEqual([
      ["active", 1],
      ["active", 1],
    ]);
    expect(await auditOf(ota.tenant.id, "payments.connect_status_changed")).toEqual([]);
    expect(invalidationsOf(ota.tenant.id)).toEqual([]);

    // Stripe stops the account's charges (for example a requirement past due).
    stripe.put(stripeAccount(ota.accountReference, { charges: false }));
    const stopped = await deliver(connectEvent("account.updated", ota.accountReference));

    expect(stopped).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect((await connectionsOfTenant(ota.tenant.id)).map((row) => [row["status"], row["version"]])).toEqual([
      ["pending", 2],
      ["pending", 2],
    ]);
    expect(await auditOf(ota.tenant.id, "payments.connect_status_changed")).toHaveLength(2);
    await expectConnectionInvalidation(ota.tenant.id);
  });

  it("[PBE-056 AC2] re-fetches again when the connections changed during the re-fetch, so the newest answer wins", async () => {
    const ota = await arrangeOta({ status: "pending" });
    stripe.put(stripeAccount(ota.accountReference, { charges: false }));
    // While the handler waits for its (older) answer, another writer changes the test connection and Stripe enables
    // the account's charges: the handler must not commit what it re-fetched first.
    stripe.afterRetrieve = async () => {
      await pool.query(
        "UPDATE platform.payment_provider_connections SET version = version + 1 WHERE id = $1",
        [ota.test.id],
      );
      stripe.put(stripeAccount(ota.accountReference, { charges: true }));
    };

    const row = await deliver(connectEvent("account.updated", ota.accountReference));

    expect(row).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    // The re-fetch whose answer was not committed, the one that wrote, and the one that confirmed it.
    expect(stripe.callsOf("accounts.retrieve")).toHaveLength(3);
    expect((await connectionsOfTenant(ota.tenant.id)).map((connection) => connection["status"])).toEqual([
      "active",
      "active",
    ]);
    expect(logLines("stripe_connect.account_changed_during_refresh")).toContainEqual(
      expect.objectContaining({ tenantId: ota.tenant.id, attempt: 1 }),
    );
  });

  it("[PBE-056 AC2] confirms each write with a re-fetch after its commit, so an older answer never outlives a newer one", async () => {
    // Stripe stops the account's charges and enables them again, one event for each change. The first event's re-fetch
    // answers the stopped charges; while it waits for that answer, the charges come back and the second event runs from
    // start to end on the worker's other slot: its re-fetch finds what the connections hold, so it writes nothing and
    // leaves no trace in their versions. The first event's older answer then commits, and only the re-fetch that
    // follows that commit puts the account's newest state back.
    const ota = await arrangeOta();
    stripe.put(stripeAccount(ota.accountReference, { charges: false }));
    const second = connectEvent("account.updated", ota.accountReference);
    let secondRow: Row | undefined;
    stripe.afterRetrieve = async () => {
      stripe.put(stripeAccount(ota.accountReference, { charges: true }));
      secondRow = await deliver(second);
    };

    const first = await deliver(connectEvent("account.updated", ota.accountReference));

    expect(secondRow).toMatchObject({ status: "processed", last_error: null, tenant_id: ota.tenant.id });
    expect(first).toMatchObject({ status: "processed", last_error: null, tenant_id: ota.tenant.id });
    for (const connection of await connectionsOfTenant(ota.tenant.id)) {
      expect(connection).toMatchObject({
        status: "active",
        capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
        version: 3,
      });
    }
    // The first event's re-fetch, the second event's, then the first event's two re-fetches after its commits: the
    // one that put `active` back, and the one that confirmed it.
    expect(stripe.callsOf("accounts.retrieve")).toHaveLength(4);
    // Each connection went `pending` with the older answer, then `active` again.
    const audit = await auditOf(ota.tenant.id, "payments.connect_status_changed");
    const statusAfter = (entry: Row): unknown => ((entry["details"] as Row)["after"] as Row)["status"];
    expect(
      audit.map((entry) => `${String(entry["target_id"])} ${String(statusAfter(entry))}`).sort(),
    ).toEqual([ota.test.id, ota.live.id].flatMap((id) => [`${id} active`, `${id} pending`]).sort());
    await expectConnectionInvalidation(ota.tenant.id);
  });

  it("[PBE-056] asks Stripe nothing for a deauthorised account, ignores an unreachable one, and keeps an admin's disable", async () => {
    const deauthorized = await arrangeOta({ status: "disabled", disconnected_at: t.clock.now() });
    const unreachable = await arrangeOta({ status: "pending" });
    const adminDisabled = await arrangeOta({
      status: "disabled",
      capabilities: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true },
    });
    stripe.failNext("accounts.retrieve", FakeStripe.apiError(403, "account_invalid"));

    const gone = await deliver(connectEvent("account.updated", deauthorized.accountReference));
    const refused = await deliver(connectEvent("account.updated", unreachable.accountReference));
    stripe.put(stripeAccount(adminDisabled.accountReference, { charges: true }));
    const refreshed = await deliver(connectEvent("account.updated", adminDisabled.accountReference));

    expect(gone).toMatchObject({
      status: "ignored",
      last_error: "ACCOUNT_DISCONNECTED: the OTA deauthorised Velexis from the account",
      tenant_id: deauthorized.tenant.id,
    });
    expect(refused).toMatchObject({
      status: "ignored",
      last_error: "ACCOUNT_UNREACHABLE: Stripe answered 403 for the account",
      tenant_id: unreachable.tenant.id,
    });
    // The admin-disabled account twice: the re-fetch that wrote its capabilities, and the one that confirmed them.
    expect(stripe.callsOf("accounts.retrieve").map((call) => call.id)).toEqual([
      unreachable.accountReference,
      adminDisabled.accountReference,
      adminDisabled.accountReference,
    ]);
    for (const ota of [deauthorized, unreachable]) {
      expect((await connectionsOfTenant(ota.tenant.id)).map((row) => row["version"])).toEqual([1, 1]);
    }
    // The admin's disable stays; the capabilities follow Stripe.
    for (const connection of await connectionsOfTenant(adminDisabled.tenant.id)) {
      expect(connection).toMatchObject({
        status: "disabled",
        disconnected_at: null,
        capabilities: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
        version: 2,
      });
    }
    expect(refreshed).toMatchObject({ status: "processed", tenant_id: adminDisabled.tenant.id });
  });
});

describe("events the handler does not apply", () => {
  it("[PBE-056] ends the events of an account no OTA's Connect connection holds ignored, and Stripe is not asked", async () => {
    // An account no connection holds, and one an `api_keys` connection holds (its own keys, not a Connect account).
    const unknown = newAccountId();
    const apiKeysOta = await arrangeOta();
    await pool.query(
      "UPDATE platform.payment_provider_connections SET account_mode = 'api_keys', publishable_key = $2, " +
        "secret_ciphertext = $3, webhook_secret_ciphertext = $3, encryption_key_id = 'local:v1' WHERE id = $1",
      [apiKeysOta.test.id, "pk_test_TestPbe056Key", Buffer.from("stand-in ciphertext, not an envelope")],
    );
    await pool.query("DELETE FROM platform.payment_provider_connections WHERE id = $1", [apiKeysOta.live.id]);

    const rows = [
      await deliver(connectEvent("account.updated", unknown)),
      await deliver(connectEvent("account.application.deauthorized", unknown)),
      await deliver(connectEvent("account.updated", apiKeysOta.accountReference)),
      await deliver(connectEvent("account.application.deauthorized", apiKeysOta.accountReference)),
    ];

    for (const row of rows) {
      expect(row).toMatchObject({
        status: "ignored",
        last_error: "UNKNOWN_ACCOUNT: no OTA's Connect connection holds the account",
        tenant_id: null,
      });
    }
    expect(stripe.calls).toEqual([]);
    expect(await connectionOf(apiKeysOta.test.id)).toMatchObject({
      account_mode: "api_keys",
      status: "active",
      version: 1,
    });
  });

  it("[PBE-056] stores the events but leaves the connections alone while FEATURE_OWN_STRIPE is off", async () => {
    const ota = await arrangeOta();
    switchedOn.delete("own_stripe");

    const row = await deliver(connectEvent("account.application.deauthorized", ota.accountReference));

    expect(row).toMatchObject({
      status: "ignored",
      last_error: "FEATURE_DISABLED: FEATURE_OWN_STRIPE is off",
    });
    expect((await connectionsOfTenant(ota.tenant.id)).map((connection) => connection["status"])).toEqual([
      "active",
      "active",
    ]);
    expect(await emailsOf(ota.tenant.id)).toEqual([]);
  });
});
