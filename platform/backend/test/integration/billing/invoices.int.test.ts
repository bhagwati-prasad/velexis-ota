// Invoices: sync and list (PBE-046; subscription-billing flow §D, invoice row, PADR-0002 items 5 and 8, ADR-0017
// "Platform invoices", PADR-0013 item 5, api-inventory-resources §6 `listInvoices`, scope PF-73 AC2): the X-028 fixture
// of `invoice.paid`, under the four invoice event types and signed with a secret made for this file, is posted to
// `POST /webhooks/stripe/billing` of the API (createTestApp, FEATURE_STRIPE_BILLING on), and the worker's module graph
// (WorkerModule, as dist/worker.js builds it, with the API's FakeClock) processes it on this file's database clone and
// Redis database. Stripe is the FakeStripe of test/support/fake-stripe.ts: the handler re-fetches the invoice from it,
// so each test puts there what Stripe would answer; the event payloads carry only the fixture (never read).
//
// Each test arranges OTAs of its own (ids of this file's range), delivers events and waits until their inbox rows are
// done, then reads the rows, the outbox, Mailpit (a unique recipient per owner) and the portal's `listInvoices`. The
// tests of step 4 deliver two events of one invoice at once, which the worker (concurrency 2) runs together, and hold
// a re-fetch at a barrier: Stripe answers when the call is made, and the answer reaches the handler only when the test
// says. The job schedulers are not registered. The Stripe keys are the development values of `.env.example`.
import { randomBytes } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import { uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import { signedStripeEvent, stripeFixture } from "@velexis/testing/stripe";
import type Stripe from "stripe";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import { insertAccount, insertRow, testId, type PlatformRow } from "../../builders/platform-rows";
import { insertMember, insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeStripe } from "../../support/fake-stripe";

/**
 * The database clone, the API's and the worker's Nest module graphs, the platform document and the fixture; the bound
 * allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish an event (it takes milliseconds; under Vitest's 5 s). */
const WAIT = { timeout: 4_000, interval: 20 } as const;
/** How long a test waits for the worker's e-mail to reach Mailpit. */
const MAIL_WAIT_MS = 3_000;

/** The signing secret of `/webhooks/stripe/billing` in this file only. */
const SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const PATH = "/webhooks/stripe/billing";
/** The switched-on application: the development Stripe key of `.env.example` (nothing reaches Stripe). */
const STRIPE_ENV = Object.freeze({
  FEATURE_STRIPE_BILLING: "true",
  STRIPE_SECRET_KEY: "sk_test_replace_me",
  STRIPE_BILLING_WEBHOOK_SECRET: SECRET,
});
/** The first number of this file's ids (`testId`), away from the other test files'. */
const FIRST_ID = 46_000;
const FAMILY = testId("asn", FIRST_ID);

type Row = Record<string, unknown>;
type InvoiceEventType = "invoice.finalized" | "invoice.paid" | "invoice.payment_failed" | "invoice.voided";

const stripe = new FakeStripe();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let tokens: TokenService;
const workerLogs = new LogSink();
let next = FIRST_ID + 1;

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs, the platform document of expectResponseToMatch
  // and the fixture.
  t = await createTestApp({ env: STRIPE_ENV, overrides: [{ provide: StripeClient, useValue: stripe }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  responseChecker("platform");
  stripeFixture("invoice.paid");

  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(t.config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .overrideProvider(JobSchedulerRegistry)
    .useValue({})
    .overrideProvider(StripeClient)
    .useValue(stripe)
    .compile();
  await worker.init();

  // The yen (no minor unit), as the reference loader writes it; the test clones hold EUR, GBP and USD only.
  await pool.query(
    `INSERT INTO reference.currencies (code, numeric_code, name, symbol, minor_units)
     VALUES ('JPY', '392', 'Japanese Yen', '¥', 0)
     ON CONFLICT (code) DO NOTHING`,
  );
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

// ---- Stripe objects and events -----------------------------------------------------------------------------------

/** The Stripe ids of one invoice of this file. */
interface InvoiceIds {
  readonly invoiceId: string;
  readonly subscriptionId: string;
  /** As `billing_customers` allows it: `cus_`, letters and digits. */
  readonly customerId: string;
  readonly number: string;
}

function invoiceIds(customerId?: string, subscriptionId?: string): InvoiceIds {
  const n = next++;
  return {
    invoiceId: `in_test_pbe046_${n}`,
    subscriptionId: subscriptionId ?? `sub_test_pbe046_${n}`,
    customerId: customerId ?? `cus_TestPbe046N${n}`,
    number: `VXTEST-PBE046-${n}`,
  };
}

/** What an invoice of a test is, besides its ids. Amounts in Stripe's minor units. */
interface InvoiceShape {
  readonly status: Stripe.Invoice.Status;
  readonly currency?: string;
  readonly total?: number;
  readonly paid?: number;
  readonly remaining?: number;
  readonly attempts?: number;
  /** False for a one-off invoice without a subscription. */
  readonly subscription?: boolean;
  /** `velexis_tenant_id` of the subscription's metadata on the invoice. */
  readonly tenantId?: string;
  /** The finalization time, in Stripe's Unix seconds; the line's period starts one second before it. */
  readonly finalizedAt?: number;
}

const MONTH_S = 30 * 24 * 60 * 60;

/** The fixture's invoice as Stripe answers a retrieve: `ids` and `shape`. */
function stripeInvoice(ids: InvoiceIds, shape: InvoiceShape): Stripe.Invoice {
  const base = stripeFixture("invoice.paid").data.object;
  const [line] = base.lines.data;
  if (line === undefined) {
    throw new Error("the invoice fixture has no line");
  }
  const total = shape.total ?? 4900;
  const paid = shape.paid ?? (shape.status === "paid" ? total : 0);
  const finalizedAt = shape.finalizedAt ?? base.status_transitions.finalized_at ?? base.created;
  const subscription = shape.subscription ?? true;
  const parent: Stripe.Invoice.Parent | null = subscription
    ? {
        type: "subscription_details",
        quote_details: null,
        subscription_details: {
          metadata: shape.tenantId === undefined ? {} : { velexis_tenant_id: shape.tenantId },
          subscription: ids.subscriptionId,
        },
      }
    : null;
  return {
    ...base,
    id: ids.invoiceId,
    number: ids.number,
    customer: ids.customerId,
    currency: shape.currency ?? "eur",
    status: shape.status,
    total,
    subtotal: total,
    subtotal_excluding_tax: total,
    total_excluding_tax: total,
    amount_due: total,
    amount_paid: paid,
    amount_remaining: shape.remaining ?? total - paid,
    attempt_count: shape.attempts ?? (shape.status === "paid" ? 1 : 0),
    created: finalizedAt,
    effective_at: finalizedAt,
    status_transitions: {
      finalized_at: finalizedAt,
      marked_uncollectible_at: null,
      paid_at: shape.status === "paid" ? finalizedAt + 2 : null,
      voided_at: shape.status === "void" ? finalizedAt + 2 : null,
    },
    hosted_invoice_url: `https://invoice.stripe.com/i/acct_test_velexis/test_${ids.invoiceId}`,
    invoice_pdf: `https://pay.stripe.com/invoice/acct_test_velexis/test_${ids.invoiceId}/pdf`,
    parent,
    lines: {
      ...base.lines,
      data: [
        {
          ...line,
          id: `il_${ids.invoiceId}`,
          invoice: ids.invoiceId,
          amount: total,
          currency: shape.currency ?? "eur",
          period: { start: finalizedAt - 1, end: finalizedAt - 1 + MONTH_S },
        },
      ],
      url: `/v1/invoices/${ids.invoiceId}/lines`,
    },
  } as Stripe.Invoice;
}

/** Puts the invoice of `ids` with `shape` into the FakeStripe, as Stripe would answer a re-fetch now. */
function stripeNow(ids: InvoiceIds, shape: InvoiceShape): void {
  stripe.put(stripeInvoice(ids, shape) as Stripe.Invoice & { id: string });
}

/** A signed delivery of an invoice event. */
interface Delivery {
  readonly eventId: string;
  readonly payload: string;
  readonly header: string;
}

function invoiceEvent(
  type: InvoiceEventType,
  invoiceId: string,
  eventId = `evt_test_pbe046_${next++}`,
): Delivery {
  const { payload, header } = signedStripeEvent(
    "invoice.paid",
    // The other types are the fixture of `invoice.paid` under another type: their payload is never read.
    { id: eventId, type: type as "invoice.paid", data: { object: { id: invoiceId } } },
    SECRET,
    { timestamp: t.clock.now() },
  );
  return { eventId, payload, header };
}

/** Posts `delivery` as Stripe does, without waiting for the worker. */
async function post(delivery: Delivery): Promise<void> {
  const res = await t.http
    .post(PATH)
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", delivery.header)
    .send(delivery.payload);
  expect(res.status).toBe(200);
}

/** Waits until the worker is done with `delivery`; answers its inbox row. */
function doneWith(delivery: Delivery): Promise<Row> {
  return vi.waitFor(async () => {
    const row = (await rowsOf("SELECT * FROM platform.stripe_events WHERE id = $1", [delivery.eventId]))[0];
    expect(["processed", "ignored", "failed"]).toContain(row?.["status"]);
    return row as Row;
  }, WAIT);
}

/** Posts `delivery` and waits until the worker is done with it; answers its inbox row. */
async function deliver(delivery: Delivery): Promise<Row> {
  await post(delivery);
  return doneWith(delivery);
}

// ---- Rows and the portal -------------------------------------------------------------------------------------------

async function rowsOf(text: string, values: unknown[]): Promise<Row[]> {
  return (await pool.query(text, values)).rows as Row[];
}

const invoiceOf = async (invoiceId: string): Promise<Row | undefined> =>
  (await rowsOf("SELECT * FROM platform.invoices WHERE provider_invoice_id = $1", [invoiceId]))[0];

const paymentFailedEmailsOf = (tenantId: string): Promise<Row[]> =>
  rowsOf(
    "SELECT to_email, data FROM platform.email_outbox WHERE tenant_id = $1 AND template = 'billing.payment_failed' " +
      "ORDER BY to_email",
    [tenantId],
  );

/** An account of this file (an address of this test only). */
const newAccount = (label: string): Promise<PlatformRow<"accounts">> =>
  insertAccount(pool, { id: testId("acc", next++), email: uniqueEmail(`${label}-pbe046`) });

/** What an OTA of this file has. */
interface BilledOta {
  readonly tenant: PlatformRow<"tenants">;
  readonly subscription: PlatformRow<"subscriptions">;
  readonly owner: PlatformRow<"accounts">;
}

/**
 * An active OTA that pays the Stripe subscription of `ids` (`active`), whose Stripe Customer `billing_customers` holds,
 * with `owner` as its first owner.
 */
async function arrangeBilledOta(ids: InvoiceIds, owner?: PlatformRow<"accounts">): Promise<BilledOta> {
  const n = next++;
  const person = owner ?? (await newAccount("owner"));
  const ota = await insertOta(pool, {
    tenant: { id: testId("ten", n), key: `pbe${n}`, name: `Agency ${n} Travel` },
    subscription: {
      id: testId("sub", n),
      status: "active",
      billing_provider: "stripe",
      trial_ends_at: null,
      provider_customer_id: ids.customerId,
      provider_subscription_id: ids.subscriptionId,
    },
    members: [[person, "owner"]],
  });
  if (ota.subscription === undefined) {
    throw new Error("arrangeBilledOta: the subscription was not written");
  }
  await insertRow(pool, "billing_customers", {
    tenant_id: ota.tenant.id,
    provider_customer_id: ids.customerId,
    livemode: false,
    billing_email: person.email,
  });
  return { tenant: ota.tenant, subscription: ota.subscription, owner: person };
}

/** The answer of `listInvoices` of `tenantId` for the portal account `accountId`. */
async function listInvoices(accountId: string, tenantId: string): Promise<Response> {
  const { token } = await tokens.sign({ aud: "portal", sub: accountId, sid: FAMILY, ev: true, amr: ["pwd"] });
  return t.http
    .get(`/v1/tenants/${tenantId}/invoices`)
    .set({ Authorization: `Bearer ${token}`, ...t.bffHeaders("203.0.113.46") });
}

/** The `billing.invoice_synced` lines of the worker for `delivery`. */
function syncLinesOf(delivery: Delivery): Array<Record<string, unknown>> {
  return [...t.logs.lines, ...workerLogs.lines].filter(
    (line) => line["msg"] === "billing.invoice_synced" && line["eventId"] === delivery.eventId,
  );
}

/** The worker's `billing.sync_lock_waiting` lines of `delivery`: it waited for the lock of its subscription. */
function lockWaitsOf(delivery: Delivery): Array<Record<string, unknown>> {
  return [...t.logs.lines, ...workerLogs.lines].filter(
    (line) => line["msg"] === "billing.sync_lock_waiting" && line["eventId"] === delivery.eventId,
  );
}

// ---- Held re-fetches ------------------------------------------------------------------------------------------------

/** A gate a test opens once: `opened` resolves when `open()` is called. */
interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return { opened, open };
}

/** A held re-fetch: `answered` opens when Stripe has answered; the handler gets the answer once `release` opens. */
interface Hold {
  readonly answered: Gate;
  readonly release: Gate;
}

/**
 * Holds the `invoices.retrieve` calls numbered `held` (1 is the next call): Stripe answers the state it has when the
 * call is made, and the answer reaches the handler only once the call's `release` opens. Other calls pass through.
 */
function holdInvoiceRetrieves(...held: number[]): Map<number, Hold> {
  const holds = new Map<number, Hold>(held.map((call) => [call, { answered: gate(), release: gate() }]));
  const resource = stripe.api().invoices;
  const retrieve = resource.retrieve.bind(resource) as (id: string) => Promise<Stripe.Invoice>;
  let calls = 0;
  const spy = async (id: string): Promise<Stripe.Invoice> => {
    calls += 1;
    const hold = holds.get(calls);
    const answer = await retrieve(id);
    if (hold !== undefined) {
      hold.answered.open();
      await hold.release.opened;
    }
    return answer;
  };
  vi.spyOn(resource, "retrieve").mockImplementation(spy as unknown as typeof resource.retrieve);
  return holds;
}

/** The hold of call `call` of `holds`. */
function holdOf(holds: Map<number, Hold>, call: number): Hold {
  const hold = holds.get(call);
  if (hold === undefined) {
    throw new Error(`no hold of call ${call}`);
  }
  return hold;
}

// ---- Tests ---------------------------------------------------------------------------------------------------------

describe("invoice.* events (worker) and listInvoices", () => {
  it("[PBE-046 AC1] stores a JPY invoice of 5000 minor units as 5000 and a EUR invoice of 4900 as 49.00 [PF-73 AC2]", async () => {
    const yenIds = invoiceIds();
    const euroIds = invoiceIds();
    const yen = await arrangeBilledOta(yenIds);
    const euro = await arrangeBilledOta(euroIds);
    stripeNow(yenIds, { status: "paid", currency: "jpy", total: 5000 });
    stripeNow(euroIds, { status: "paid", currency: "eur", total: 4900 });

    expect(await deliver(invoiceEvent("invoice.paid", yenIds.invoiceId))).toMatchObject({
      status: "processed",
      tenant_id: yen.tenant.id,
    });
    expect(await deliver(invoiceEvent("invoice.paid", euroIds.invoiceId))).toMatchObject({
      status: "processed",
      tenant_id: euro.tenant.id,
    });

    // The numeric(12,2) columns hold the converted amounts: 5000 yen (not 50.00), 49.00 euros (not 4900).
    expect(await invoiceOf(yenIds.invoiceId)).toMatchObject({
      tenant_id: yen.tenant.id,
      subscription_id: yen.subscription.id,
      currency: "JPY",
      total: "5000.00",
      subtotal: "5000.00",
      tax_amount: "0.00",
      amount_paid: "5000.00",
      amount_due: "0.00",
    });
    expect(await invoiceOf(euroIds.invoiceId)).toMatchObject({
      tenant_id: euro.tenant.id,
      subscription_id: euro.subscription.id,
      currency: "EUR",
      total: "49.00",
      amount_paid: "49.00",
      amount_due: "0.00",
    });
    // The portal answers each amount with its currency's decimals.
    const yenList = await listInvoices(yen.owner.id, yen.tenant.id);
    expect(yenList.status).toBe(200);
    expectResponseToMatch("listInvoices", yenList, { document: "platform" });
    expect(yenList.body).toMatchObject({
      data: [
        {
          number: yenIds.number,
          total: { amount: "5000", currency: "JPY" },
          amountPaid: { amount: "5000", currency: "JPY" },
          amountDue: { amount: "0", currency: "JPY" },
        },
      ],
    });
    const euroList = await listInvoices(euro.owner.id, euro.tenant.id);
    expect(euroList.body).toMatchObject({
      data: [
        {
          total: { amount: "49.00", currency: "EUR" },
          amountPaid: { amount: "49.00", currency: "EUR" },
          amountDue: { amount: "0.00", currency: "EUR" },
        },
      ],
    });
  });

  it("[PBE-046 AC2] lists number, period, total, status and the Stripe links, newest first, to owners and finance members only [PF-73 AC2]", async () => {
    const firstIds = invoiceIds();
    const ota = await arrangeBilledOta(firstIds);
    const secondIds = invoiceIds(firstIds.customerId, firstIds.subscriptionId);
    const base = stripeFixture("invoice.paid").data.object;
    const firstFinalized = base.created;
    const secondFinalized = base.created + MONTH_S;
    stripeNow(firstIds, { status: "paid", finalizedAt: firstFinalized });
    stripeNow(secondIds, { status: "open", finalizedAt: secondFinalized, attempts: 0 });
    for (const delivery of [
      invoiceEvent("invoice.finalized", firstIds.invoiceId),
      invoiceEvent("invoice.paid", firstIds.invoiceId),
      invoiceEvent("invoice.finalized", secondIds.invoiceId),
    ]) {
      expect(await deliver(delivery)).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    }

    const finance = await newAccount("finance");
    await insertMember(pool, ota.tenant, finance, "finance");
    for (const reader of [ota.owner, finance]) {
      const list = await listInvoices(reader.id, ota.tenant.id);
      expect(list.status).toBe(200);
      expectResponseToMatch("listInvoices", list, { document: "platform" });
      const [newest, older] = (list.body as { data: Array<Record<string, unknown>> }).data;
      expect((list.body as { data: unknown[] }).data).toHaveLength(2);
      expect(newest).toEqual({
        id: expect.stringMatching(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/),
        number: secondIds.number,
        status: "open",
        total: { amount: "49.00", currency: "EUR" },
        amountDue: { amount: "49.00", currency: "EUR" },
        amountPaid: { amount: "0.00", currency: "EUR" },
        periodStart: new Date((secondFinalized - 1) * 1000).toISOString(),
        periodEnd: new Date((secondFinalized - 1 + MONTH_S) * 1000).toISOString(),
        issuedAt: new Date(secondFinalized * 1000).toISOString(),
        paidAt: null,
        hostedInvoiceUrl: `https://invoice.stripe.com/i/acct_test_velexis/test_${secondIds.invoiceId}`,
        invoicePdfUrl: `https://pay.stripe.com/invoice/acct_test_velexis/test_${secondIds.invoiceId}/pdf`,
      });
      expect(older).toMatchObject({
        number: firstIds.number,
        status: "paid",
        issuedAt: new Date(firstFinalized * 1000).toISOString(),
        paidAt: new Date((firstFinalized + 2) * 1000).toISOString(),
        hostedInvoiceUrl: `https://invoice.stripe.com/i/acct_test_velexis/test_${firstIds.invoiceId}`,
      });
    }
    // Admins, agents and viewers of the OTA get 403; a member of another OTA 404.
    for (const role of ["admin", "agent", "viewer"] as const) {
      const member = await newAccount(role);
      await insertMember(pool, ota.tenant, member, role);
      const refused = await listInvoices(member.id, ota.tenant.id);
      expect([role, refused.status]).toEqual([role, 403]);
    }
    const strangerIds = invoiceIds();
    const stranger = await arrangeBilledOta(strangerIds);
    expect((await listInvoices(stranger.owner.id, ota.tenant.id)).status).toBe(404);
    // An OTA without a Stripe invoice has an empty list.
    expect((await listInvoices(stranger.owner.id, stranger.tenant.id)).body).toEqual({ data: [] });
    // A suspended OTA's owner still gets the list, to pay or download its invoices (PADR-0014 item 5).
    await pool.query(
      "UPDATE platform.tenants SET status = 'suspended', suspension_reason = 'billing', suspended_at = $2 WHERE id = $1",
      [ota.tenant.id, t.clock.now()],
    );
    const suspended = await listInvoices(ota.owner.id, ota.tenant.id);
    expect(suspended.status).toBe(200);
    expect((suspended.body as { data: unknown[] }).data).toHaveLength(2);
  });

  it("[PBE-046 AC2] a payment failure e-mails the owners, once per invoice and payment attempt, and never once it is paid", async () => {
    const ids = invoiceIds();
    const ota = await arrangeBilledOta(ids);
    const secondOwner = await newAccount("owner2");
    await insertMember(pool, ota.tenant, secondOwner, "owner");
    // Members who never get it: a finance member and an admin.
    const finance = await newAccount("finance");
    await insertMember(pool, ota.tenant, finance, "finance");
    const admin = await newAccount("admin");
    await insertMember(pool, ota.tenant, admin, "admin");
    stripeNow(ids, { status: "open", attempts: 1 });

    const failure = invoiceEvent("invoice.payment_failed", ids.invoiceId);
    expect(await deliver(failure)).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect(await invoiceOf(ids.invoiceId)).toMatchObject({
      status: "open",
      amount_due: "49.00",
      amount_paid: "0.00",
    });
    const owners = [ota.owner.email, secondOwner.email].sort();
    expect((await paymentFailedEmailsOf(ota.tenant.id)).map((row) => row["to_email"])).toEqual(owners);
    const message = await waitForMessage({ to: ota.owner.email, timeoutMs: MAIL_WAIT_MS });
    expect(message.Subject).toBe(`Payment failed for ${ota.tenant.name}: invoice ${ids.number}`);
    expect(message.Text).toContain(`Velexis invoice ${ids.number} (49.00 EUR)`);
    expect(message.Text).toContain(`/otas/${ota.tenant.id}/billing`);

    // The same event again, and another event of the same attempt: no new e-mail.
    expect(await deliver(failure)).toMatchObject({ status: "processed" });
    expect(await deliver(invoiceEvent("invoice.payment_failed", ids.invoiceId))).toMatchObject({
      status: "processed",
    });
    expect(await paymentFailedEmailsOf(ota.tenant.id)).toHaveLength(2);
    // Stripe's next attempt failed too: the owners hear of it once more.
    stripeNow(ids, { status: "open", attempts: 2 });
    expect(await deliver(invoiceEvent("invoice.payment_failed", ids.invoiceId))).toMatchObject({
      status: "processed",
    });
    expect(await paymentFailedEmailsOf(ota.tenant.id)).toHaveLength(4);
    // The owner paid meanwhile: a late failure event writes the paid invoice and e-mails no one.
    stripeNow(ids, { status: "paid", attempts: 3 });
    expect(await deliver(invoiceEvent("invoice.payment_failed", ids.invoiceId))).toMatchObject({
      status: "processed",
    });
    expect(await invoiceOf(ids.invoiceId)).toMatchObject({ status: "paid", amount_due: "0.00" });
    expect(await paymentFailedEmailsOf(ota.tenant.id)).toHaveLength(4);
  });

  it("[PBE-046] re-fetches every event: duplicates and late events of one invoice end in Stripe's current state", async () => {
    const ids = invoiceIds();
    const ota = await arrangeBilledOta(ids);
    stripeNow(ids, { status: "open" });
    const finalized = invoiceEvent("invoice.finalized", ids.invoiceId);
    expect(await deliver(finalized)).toMatchObject({ status: "processed" });
    const created = await invoiceOf(ids.invoiceId);
    expect(created).toMatchObject({ status: "open", number: ids.number });

    stripeNow(ids, { status: "paid" });
    const paid = invoiceEvent("invoice.paid", ids.invoiceId);
    expect(await deliver(paid)).toMatchObject({ status: "processed" });
    // A late copy of the first event, and the paid one again: the re-fetch answers the paid invoice each time.
    expect(await deliver(invoiceEvent("invoice.finalized", ids.invoiceId))).toMatchObject({
      status: "processed",
    });
    expect(await deliver(paid)).toMatchObject({ status: "processed" });
    const rows = await rowsOf("SELECT * FROM platform.invoices WHERE tenant_id = $1", [ota.tenant.id]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: created?.["id"],
        status: "paid",
        amount_paid: "49.00",
        amount_due: "0.00",
      }),
    ]);
    expect(syncLinesOf(paid)).toEqual([
      expect.objectContaining({ created: false, changed: true, stale: false, status: "paid" }),
    ]);

    // A void invoice keeps its number and amounts.
    const voidIds = invoiceIds(ids.customerId, ids.subscriptionId);
    stripeNow(voidIds, { status: "void" });
    expect(await deliver(invoiceEvent("invoice.voided", voidIds.invoiceId))).toMatchObject({
      status: "processed",
    });
    expect(await invoiceOf(voidIds.invoiceId)).toMatchObject({ status: "void", total: "49.00" });
  });

  it("[PBE-046] ignores an invoice of no OTA and fails for good one whose Customer and metadata name different OTAs", async () => {
    const strangerIds = invoiceIds();
    stripeNow(strangerIds, { status: "paid" });
    expect(await deliver(invoiceEvent("invoice.paid", strangerIds.invoiceId))).toMatchObject({
      status: "ignored",
      tenant_id: null,
      last_error: expect.stringMatching(/^UNKNOWN_TENANT: /),
    });
    expect(await invoiceOf(strangerIds.invoiceId)).toBeUndefined();

    const ids = invoiceIds();
    await arrangeBilledOta(ids);
    const other = await arrangeBilledOta(invoiceIds());
    stripeNow(ids, { status: "paid", tenantId: other.tenant.id });
    expect(await deliver(invoiceEvent("invoice.paid", ids.invoiceId))).toMatchObject({
      status: "failed",
      last_error: expect.stringMatching(/^TENANT_MISMATCH: /),
      processed_at: expect.any(Date),
    });
    expect(await invoiceOf(ids.invoiceId)).toBeUndefined();
  });

  it("[PBE-046] fails for good, writing nothing, on a currency reference.currencies lacks and on another invoice's number", async () => {
    const ids = invoiceIds();
    const ota = await arrangeBilledOta(ids);
    // Swiss francs are not in this file's reference data: no exponent to convert with, so nothing is guessed.
    expect(await rowsOf("SELECT code FROM reference.currencies WHERE code = 'CHF'", [])).toEqual([]);
    stripeNow(ids, { status: "paid", currency: "chf" });
    expect(await deliver(invoiceEvent("invoice.paid", ids.invoiceId))).toMatchObject({
      status: "failed",
      tenant_id: ota.tenant.id,
      last_error: expect.stringMatching(/^UNKNOWN_CURRENCY: /),
      processed_at: expect.any(Date),
    });
    expect(await invoiceOf(ids.invoiceId)).toBeUndefined();

    // A second Stripe invoice under the number of a stored one: `invoices.number` is unique.
    const firstIds = invoiceIds(ids.customerId, ids.subscriptionId);
    stripeNow(firstIds, { status: "paid" });
    expect(await deliver(invoiceEvent("invoice.paid", firstIds.invoiceId))).toMatchObject({
      status: "processed",
    });
    const twinIds = { ...invoiceIds(ids.customerId, ids.subscriptionId), number: firstIds.number };
    stripeNow(twinIds, { status: "open" });
    expect(await deliver(invoiceEvent("invoice.finalized", twinIds.invoiceId))).toMatchObject({
      status: "failed",
      tenant_id: ota.tenant.id,
      last_error: expect.stringMatching(/^INVOICE_NUMBER_CONFLICT: /),
      processed_at: expect.any(Date),
    });
    expect(await invoiceOf(twinIds.invoiceId)).toBeUndefined();
    expect(await invoiceOf(firstIds.invoiceId)).toMatchObject({ number: firstIds.number, status: "paid" });
  });
});

describe("overlapping events of one invoice (PBE-046 step 4, PADR-0002 item 5 revision of 2026-10-27)", () => {
  it("[PBE-046] an invoice of a subscription is written under the subscription's lock: the second event re-fetches after the first one's commit", async () => {
    const ids = invoiceIds();
    const ota = await arrangeBilledOta(ids);
    // Stripe's state when the first event re-fetches under the lock (its second call; the first names the subscription).
    stripeNow(ids, { status: "open" });
    const holds = holdInvoiceRetrieves(2);
    const first = invoiceEvent("invoice.finalized", ids.invoiceId);
    await post(first);
    await holdOf(holds, 2).answered.opened;

    // Stripe's newest state, which the second event is about.
    stripeNow(ids, { status: "paid" });
    const second = invoiceEvent("invoice.paid", ids.invoiceId);
    await post(second);
    await vi.waitFor(() => {
      expect(lockWaitsOf(second)).toEqual([
        expect.objectContaining({ providerSubscriptionId: ids.subscriptionId }),
      ]);
    }, WAIT);
    holdOf(holds, 2).release.open();

    expect(await doneWith(first)).toMatchObject({ status: "processed", attempts: 1 });
    expect(await doneWith(second)).toMatchObject({ status: "processed", attempts: 1 });
    // The older answer committed first, then the second event re-fetched the newest state and wrote it.
    expect(await invoiceOf(ids.invoiceId)).toMatchObject({ tenant_id: ota.tenant.id, status: "paid" });
    expect(syncLinesOf(first)).toEqual([expect.objectContaining({ created: true, status: "open" })]);
    expect(syncLinesOf(second)).toEqual([
      expect.objectContaining({ created: false, changed: true, stale: false, status: "paid" }),
    ]);
    expect(stripe.callsOf("invoices.retrieve").filter((call) => call.id === ids.invoiceId)).toHaveLength(4);
  });

  it("[PBE-046] an invoice without a subscription keeps the newest state when the older re-fetch commits last", async () => {
    const ids = invoiceIds();
    const ota = await arrangeBilledOta(ids);
    stripeNow(ids, { status: "open", subscription: false });
    const holds = holdInvoiceRetrieves(1);
    const older = invoiceEvent("invoice.finalized", ids.invoiceId);
    await post(older);
    await holdOf(holds, 1).answered.opened;

    // Stripe's change, then the newer event: its re-fetch starts later and commits first.
    t.clock.advance(1_000);
    stripeNow(ids, { status: "paid", subscription: false });
    const newer = invoiceEvent("invoice.paid", ids.invoiceId);
    expect(await deliver(newer)).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect(await invoiceOf(ids.invoiceId)).toMatchObject({ status: "paid" });
    holdOf(holds, 1).release.open();

    // The older answer arrives last and is not written: the row keeps the newest state.
    expect(await doneWith(older)).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect(await invoiceOf(ids.invoiceId)).toMatchObject({
      status: "paid",
      subscription_id: null,
      provider_synced_at: t.clock.now(),
    });
    expect(syncLinesOf(older)).toEqual([expect.objectContaining({ stale: true, status: "open" })]);
    // No lock: neither event waited.
    expect([...lockWaitsOf(older), ...lockWaitsOf(newer)]).toEqual([]);
  });

  it("[PBE-046] an invoice without a subscription takes the newest state when the newer re-fetch commits last", async () => {
    const ids = invoiceIds();
    const ota = await arrangeBilledOta(ids);
    stripeNow(ids, { status: "open", subscription: false });
    const holds = holdInvoiceRetrieves(1, 2);
    const older = invoiceEvent("invoice.finalized", ids.invoiceId);
    await post(older);
    await holdOf(holds, 1).answered.opened;

    t.clock.advance(1_000);
    stripeNow(ids, { status: "paid", subscription: false });
    const newer = invoiceEvent("invoice.paid", ids.invoiceId);
    await post(newer);
    await holdOf(holds, 2).answered.opened;

    // The older answer commits first, the newer one last.
    holdOf(holds, 1).release.open();
    expect(await doneWith(older)).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect(await invoiceOf(ids.invoiceId)).toMatchObject({ status: "open" });
    holdOf(holds, 2).release.open();
    expect(await doneWith(newer)).toMatchObject({ status: "processed", tenant_id: ota.tenant.id });
    expect(await invoiceOf(ids.invoiceId)).toMatchObject({
      status: "paid",
      provider_synced_at: t.clock.now(),
    });
    expect(syncLinesOf(newer)).toEqual([
      expect.objectContaining({ stale: false, changed: true, status: "paid" }),
    ]);
  });
});
