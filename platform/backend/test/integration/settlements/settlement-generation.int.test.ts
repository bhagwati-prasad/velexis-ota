// The monthly settlement drafts (PBE-059; platform/docs/flows/stripe-payments-account.md §F items 1–3, PADR-0003
// items 2–8, api-inventory-admin.md §6 `adminGenerateSettlements`, scope PF-63 AC1) on this file's database clone and
// this worker's Redis database: the API (createTestApp) and the worker's module graph (WorkerModule, as dist/worker.js
// builds it, with the API's FakeClock and without its job schedulers, so nothing runs behind the tests' backs). Stripe
// is the FakeStripe of test/support/fake-stripe.ts in both: each test puts the month's balance transactions, charges,
// refunds, disputes and PaymentIntents there, and nothing reaches Stripe.
//
// - The generator itself (SettlementGenerator of the worker) builds one draft per tenant and balance currency, with
//   one line per balance transaction, the carry-forward of earlier negative balances and the totals; a second run
//   gives the same drafts; approved and paid statements are never touched and their transactions are skipped; a run
//   for one tenant leaves the others alone; a voided draft makes room for a new one; a carried-forward balance goes to
//   the earliest open draft only; a draft that no transaction names any more is rebuilt empty.
// - The job: `adminGenerateSettlements` queues it (or refuses: a month that has not ended, an unknown tenant, Redis
//   down), `settlements.monthly` queues the previous month through the `platform-maintenance` processor, and the
//   worker's processor runs it, trying again after a Stripe outage and giving up without a Stripe key.
//
// The FakeClock stands on 2026-11-03 at 05:00 UTC, when `settlements.monthly` runs for October 2026. Every test
// starts without statements (the clone is this file's own), and with an empty FakeStripe.
import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import { expectResponseToMatch, responseChecker } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry, PLATFORM_SCHEDULES } from "../../../src/common/queues/scheduler.registry";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import { Clock } from "../../../src/common/clock";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import {
  SETTLEMENT_GENERATE_ACTOR,
  SettlementGenerator,
} from "../../../src/settlements/settlement-generator";
import { SETTLEMENTS_MONTHLY_JOB } from "../../../src/settlements/settlements-monthly.scheduler";
import { SETTLEMENT_GENERATE_JOB, SettlementJobs } from "../../../src/settlements/settlements.processor";
import { WorkerModule } from "../../../src/worker.module";
import {
  insertAccount,
  insertPlan,
  insertSettlement,
  insertSettlementLine,
  insertTenant,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeStripe, type FakeStripeObject } from "../../support/fake-stripe";

/**
 * The database clone, the API's and the worker's Nest module graphs and the platform document of
 * expectResponseToMatch; the bound allows for the parallel load of a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker to finish a job (it takes milliseconds; under Vitest's 5 s). */
const WAIT_MS = 4_000;
/** When `settlements.monthly` runs for October 2026. */
const NOW = new Date("2026-11-03T05:00:00.000Z");
const OCTOBER = "2026-10-01T00:00:00.000Z";
// A documentation address (RFC 5737) only.
const ADMIN_IP = "198.51.100.59";
const FAMILY = testId("asn", 59_000);

type Row = Record<string, unknown>;

const stripe = new FakeStripe();
let t: TestApp;
let pool: PlatformPool;
let worker: TestingModule;
let generator: SettlementGenerator;
let settlementsQueue: Queue;
let maintenanceQueue: Queue;
let admin: string;
let feePlan: string;
const workerLogs = new LogSink();

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, both module graphs and the platform document's response checker.
  t = await createTestApp({ overrides: [{ provide: StripeClient, useValue: stripe }] });
  t.clock.set(NOW);
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  responseChecker("platform");
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
  generator = worker.get(SettlementGenerator, { strict: false });
  settlementsQueue = worker.get<Queue>(getQueueToken(PLATFORM_QUEUE.settlements), { strict: false });
  maintenanceQueue = worker.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
  admin = (await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true })).id;
  feePlan = (await insertPlan(pool, { code: "settle150", settlement_fee_bps: 150 })).code;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(async () => {
  stripe.reset();
  t.clock.set(NOW);
  await pool.query("DELETE FROM platform.settlement_lines");
  await pool.query("UPDATE platform.settlements SET carried_to_id = NULL");
  await pool.query("DELETE FROM platform.settlements");
});

// ---- Stripe objects as the generator reads them ------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Unix seconds on a day of October 2026. */
const onDay = (day: number, hour = 12) => Date.UTC(2026, 9, day, hour) / 1000;

const velexis = (tenantId: string, n: string) => ({
  velexis_tenant_id: tenantId,
  velexis_environment: "test",
  payment_id: `pay_${n}`,
  checkout_id: `chk_${n}`,
});

function charge(id: string, amount: number, metadata: Json, extra: Json = {}): FakeStripeObject {
  return {
    id,
    object: "charge",
    amount,
    amount_captured: amount,
    currency: "eur",
    metadata,
    payment_intent: `pi_${id.slice(3)}`,
    ...extra,
  } as FakeStripeObject;
}

function source(
  object: "refund" | "dispute",
  id: string,
  chargeId: string,
  amount: number,
): FakeStripeObject {
  return { id, object, charge: chargeId, amount, currency: "eur", payment_intent: null } as FakeStripeObject;
}

function txn(
  id: string,
  category: string,
  amount: number,
  fee: number,
  sourceId: string,
  created: number,
  currency = "eur",
): FakeStripeObject {
  return {
    id,
    object: "balance_transaction",
    amount,
    fee,
    net: amount - fee,
    currency,
    created,
    reporting_category: category,
    source: sourceId,
  } as FakeStripeObject;
}

/** Two OTAs: A on a plan with a 1.5 % settlement fee, B on the seeded plan (0). */
async function twoTenants(): Promise<{ a: PlatformRow<"tenants">; b: PlatformRow<"tenants"> }> {
  return {
    a: await insertTenant(pool, { plan_code: feePlan }),
    b: await insertTenant(pool),
  };
}

/**
 * October for A and B: A in EUR two charges, a refund, a lost dispute, a won dispute (withdrawn and reinstated); A in
 * USD one charge; B one EUR charge. Also a charge of a tenant the platform does not know, Velexis's own subscription
 * income (no tenant) and a payout (not settled).
 */
function putOctober(a: string, b: string): void {
  const stranger = testId("ten", 99_999);
  stripe.put(
    charge("ch_A1", 100_000, velexis(a, "A1")),
    charge("ch_A2", 50_000, velexis(a, "A2")),
    charge("ch_A3", 30_000, velexis(a, "A3")),
    charge("ch_A4", 25_000, velexis(a, "A4"), { currency: "usd" }),
    charge("ch_B1", 40_000, velexis(b, "B1")),
    charge("ch_X1", 10_000, velexis(stranger, "X1")),
    charge("ch_sub", 4_900, { velexis_subscription_id: "sub_1" }, { payment_intent: null }),
    source("refund", "re_A1", "ch_A1", 20_000),
    source("dispute", "du_A2", "ch_A2", 50_000),
    source("dispute", "du_A3", "ch_A3", 30_000),
    { id: "po_1", object: "payout" } as FakeStripeObject,
    txn("txn_A1", "charge", 100_000, 1_475, "ch_A1", onDay(2)),
    txn("txn_A2", "charge", 50_000, 775, "ch_A2", onDay(3)),
    txn("txn_A4", "charge", 25_000, 755, "ch_A4", onDay(4), "usd"),
    txn("txn_B1", "charge", 40_000, 595, "ch_B1", onDay(5)),
    txn("txn_X1", "charge", 10_000, 175, "ch_X1", onDay(5, 13)),
    txn("txn_sub", "charge", 4_900, 170, "ch_sub", onDay(6)),
    txn("txn_reA1", "refund", -20_000, 0, "re_A1", onDay(8)),
    txn("txn_duA2", "dispute", -50_000, 1_500, "du_A2", onDay(9)),
    txn("txn_duA3", "dispute", -30_000, 1_500, "du_A3", onDay(10)),
    txn("txn_po1", "payout", -100_000, 0, "po_1", onDay(11)),
    txn("txn_drA3", "dispute_reversal", 30_000, 0, "du_A3", onDay(20)),
  );
}

// ---- Reads -------------------------------------------------------------------------------------------------------

/** The tenant's statements of `environment` (default `test`), by currency and month. */
async function statementsOf(tenantId: string, environment = "test"): Promise<Row[]> {
  const { rows } = await pool.query(
    `SELECT * FROM platform.settlements WHERE tenant_id = $1 AND environment = $2
      ORDER BY currency, period_start, created_at, id`,
    [tenantId, environment],
  );
  return rows as Row[];
}

/** The tenant's October statement in `currency`, not void. */
async function octoberOf(tenantId: string, currency: string): Promise<Row> {
  const row = (await statementsOf(tenantId)).find(
    (each) =>
      each["currency"] === currency &&
      (each["period_start"] as Date).toISOString() === OCTOBER &&
      each["status"] !== "void",
  );
  if (row === undefined) {
    throw new Error(`no October ${currency} statement of ${tenantId}`);
  }
  return row;
}

async function linesOf(settlementId: unknown): Promise<Row[]> {
  const { rows } = await pool.query(
    `SELECT * FROM platform.settlement_lines WHERE settlement_id = $1
      ORDER BY occurred_at, balance_transaction_id NULLS LAST`,
    [settlementId],
  );
  return rows as Row[];
}

/** What a statement is, without what a rebuild renews (version, generation time). */
function contentOf(row: Row): Row {
  const { version: _version, generated_at: _generated, updated_at: _updated, ...content } = row;
  return content;
}

/** What a line is, without its id and creation time (a rebuild inserts new rows). */
function lineContentOf(row: Row): Row {
  const { id: _id, created_at: _created, ...content } = row;
  return content;
}

/** The audit rows of `action`, of the tenants `tenantIds` only when given (the log is never emptied). */
async function auditOf(action: string, tenantIds?: readonly string[]): Promise<Row[]> {
  const { rows } = await pool.query(
    `SELECT * FROM platform.platform_audit_log WHERE action = $1 AND ($2::text[] IS NULL OR tenant_id = ANY($2))
      ORDER BY id`,
    [action, tenantIds ?? null],
  );
  return rows as Row[];
}

const TOTAL_COLUMNS = [
  "gross_amount",
  "refunds_amount",
  "disputes_amount",
  "stripe_fees_amount",
  "velexis_fees_amount",
  "adjustments_amount",
  "net_amount",
] as const;

function totalsOf(row: Row): Row {
  return Object.fromEntries(TOTAL_COLUMNS.map((column) => [column, row[column]]));
}

// ---- Jobs --------------------------------------------------------------------------------------------------------

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

async function adminHeaders(): Promise<Record<string, string>> {
  const { token } = await t.app.get(TokenService).sign({
    aud: "platform_admin",
    sub: admin,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
    mfa_at: nowSeconds(),
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

const generate = (body: unknown, headers?: Record<string, string>) =>
  t.http
    .post("/v1/admin/settlements/generate")
    .set(headers ?? {})
    .send(body as object);

/** The jobs of `queue` in any state. */
async function jobsOf(queue: Queue): Promise<Job[]> {
  const jobs = await queue.getJobs(["waiting", "active", "delayed", "prioritized", "completed", "failed"]);
  return jobs.filter((job): job is Job => job !== undefined);
}

/**
 * Waits until `count` jobs of `queue` match `filter` and every one of them has finished (completed, or failed for
 * good), promoting a delayed retry at once instead of waiting for its backoff; returns them, re-read.
 */
async function settled(queue: Queue, filter: (job: Job) => boolean, count = 1): Promise<Job[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const jobs = (await jobsOf(queue)).filter(filter);
    const states = await Promise.all(jobs.map((job) => job.getState()));
    if (jobs.length >= count && states.every((state) => state === "completed" || state === "failed")) {
      return Promise.all(jobs.map(async (job) => (await queue.getJob(job.id ?? "")) ?? job));
    }
    for (const [index, state] of states.entries()) {
      if (state === "delayed") {
        await jobs[index]?.promote();
      }
    }
    expect(Date.now(), "the jobs to finish").toBeLessThan(deadline);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const isGenerate = (job: Job) => job.name === SETTLEMENT_GENERATE_JOB;

/**
 * The `settlement.generate_failed` lines logged so far. nestjs-pino keeps one root logger per process, so the lines of
 * the worker's graph may reach either sink; both are read.
 */
function failureLines(): Row[] {
  return [...t.logs.lines, ...workerLogs.lines].filter(
    (line) => line["msg"] === "settlement.generate_failed",
  );
}

beforeEach(async () => {
  // Jobs of an earlier test are done; drop them so each test sees its own.
  await settlementsQueue.obliterate({ force: true });
  await maintenanceQueue.obliterate({ force: true });
});

// ---- The generator ------------------------------------------------------------------------------------------------

describe("the generation of a month's drafts (flow §F items 2 and 3)", () => {
  it("[PBE-059 AC1] builds one draft per tenant and balance currency, with a line per transaction, the carried-forward balance and the totals", async () => {
    const { a, b } = await twoTenants();
    putOctober(a.id, b.id);
    // A's negative September in EUR, not absorbed yet; August's balance was absorbed by September already. Neither a
    // live statement nor one of another currency is absorbed.
    const september = await insertSettlement(pool, a, {
      environment: "test",
      period_start: new Date("2026-09-01T00:00:00Z"),
      period_end: new Date("2026-10-01T00:00:00Z"),
      status: "carried_forward",
      refunds_amount: "45.50",
      net_amount: "-45.50",
    });
    await insertSettlement(pool, a, {
      environment: "test",
      period_start: new Date("2026-08-01T00:00:00Z"),
      period_end: new Date("2026-09-01T00:00:00Z"),
      status: "carried_forward",
      refunds_amount: "10.00",
      net_amount: "-10.00",
      carried_to_id: september.id,
    });
    for (const other of [
      { environment: "live", currency: "EUR" },
      { environment: "test", currency: "GBP" },
    ]) {
      await insertSettlement(pool, a, {
        ...other,
        period_start: new Date("2026-09-01T00:00:00Z"),
        period_end: new Date("2026-10-01T00:00:00Z"),
        status: "carried_forward",
        refunds_amount: "7.00",
        net_amount: "-7.00",
      });
    }

    const result = await generator.generate({ periodStart: new Date(OCTOBER) });

    expect(result).toEqual({
      periodStart: OCTOBER,
      environment: "test",
      tenantId: null,
      transactions: 11,
      ignored: 1,
      withoutTenant: 1,
      unknownTenant: 1,
      otherTenants: 0,
      alreadySettled: 0,
      lines: 8,
      rebuilt: 3,
      untouched: 0,
    });
    const eur = await octoberOf(a.id, "EUR");
    expect(eur).toMatchObject({
      status: "draft",
      environment: "test",
      period_end: new Date("2026-11-01T00:00:00Z"),
      fee_bps: 150,
      line_count: 7,
      version: 1,
      generated_at: NOW,
      carried_to_id: null,
    });
    expect(totalsOf(eur)).toEqual({
      gross_amount: "1500.00",
      refunds_amount: "200.00",
      disputes_amount: "530.00",
      stripe_fees_amount: "22.50",
      velexis_fees_amount: "19.50",
      adjustments_amount: "-45.50",
      net_amount: "682.50",
    });
    const lines = await linesOf(eur["id"]);
    expect(
      lines.map((line) => [
        line["line_type"],
        line["balance_transaction_id"],
        line["amount"],
        line["stripe_fee"],
      ]),
    ).toEqual([
      ["carry_forward", null, "-45.50", "0.00"],
      ["charge", "txn_A1", "1000.00", "14.75"],
      ["charge", "txn_A2", "500.00", "7.75"],
      ["refund", "txn_reA1", "-200.00", "0.00"],
      ["dispute", "txn_duA2", "-500.00", "15.00"],
      ["dispute", "txn_duA3", "-300.00", "15.00"],
      ["dispute_reversal", "txn_drA3", "300.00", "0.00"],
    ]);
    expect(lines[0]).toMatchObject({
      tenant_id: a.id,
      occurred_at: new Date(OCTOBER),
      description: `Balance carried forward from 2026-09 (${september.id})`,
    });
    expect(lines[3]).toMatchObject({
      source_id: "re_A1",
      payment_intent_id: "pi_A1",
      velexis_payment_id: "pay_A1",
      checkout_id: "chk_A1",
      occurred_at: new Date(onDay(8) * 1000),
    });
    expect(totalsOf(await octoberOf(a.id, "USD"))).toEqual({
      gross_amount: "250.00",
      refunds_amount: "0.00",
      disputes_amount: "0.00",
      stripe_fees_amount: "7.55",
      velexis_fees_amount: "3.75",
      adjustments_amount: "0.00",
      net_amount: "238.70",
    });
    const bEur = await octoberOf(b.id, "EUR");
    expect(bEur).toMatchObject({
      fee_bps: 0,
      line_count: 1,
      net_amount: "394.05",
      velexis_fees_amount: "0.00",
    });
    // No GBP draft: A had no GBP transaction in October; its GBP and live balances wait for a month that has some.
    expect((await statementsOf(a.id)).map((row) => [row["currency"], row["status"]])).toEqual([
      ["EUR", "carried_forward"],
      ["EUR", "carried_forward"],
      ["EUR", "draft"],
      ["GBP", "carried_forward"],
      ["USD", "draft"],
    ]);

    const audit = await auditOf("settlement.generated", [a.id, b.id]);
    const usd = await octoberOf(a.id, "USD");
    expect(audit.map((row) => row["target_id"]).sort()).toEqual([eur["id"], bEur["id"], usd["id"]].sort());
    expect(audit.find((row) => row["target_id"] === eur["id"])).toMatchObject({
      actor_type: "system",
      actor_account_id: null,
      actor_label: SETTLEMENT_GENERATE_ACTOR,
      target_type: "settlement",
      tenant_id: a.id,
      details: {
        periodStart: OCTOBER,
        environment: "test",
        currency: "EUR",
        alreadySettled: 0,
        after: { lineCount: 7, netAmount: "682.50" },
      },
    });
  });

  it("[PBE-059 AC2] gives the same drafts when it runs twice, rebuilding a changed draft from scratch", async () => {
    const { a, b } = await twoTenants();
    putOctober(a.id, b.id);
    await generator.generate({ periodStart: new Date(OCTOBER) });
    const first = [...(await statementsOf(a.id)), ...(await statementsOf(b.id))];
    const firstLines = await Promise.all(
      first.map(async (row) => (await linesOf(row["id"])).map(lineContentOf)),
    );
    // A partial draft: a line lost, and a manual adjustment the rebuild does not keep (the contract says so).
    const eur = await octoberOf(a.id, "EUR");
    await pool.query("DELETE FROM platform.settlement_lines WHERE balance_transaction_id = 'txn_reA1'");
    await insertSettlementLine(
      pool,
      { id: eur["id"] as string, tenant_id: a.id },
      {
        line_type: "adjustment",
        balance_transaction_id: null,
        payment_intent_id: null,
        amount: "12.00",
        stripe_fee: "0.00",
        description: "Manual adjustment",
        created_by_account_id: admin,
      },
    );
    t.clock.set(new Date(NOW.getTime() + 60_000));

    const again = await generator.generate({ periodStart: new Date(OCTOBER) });

    expect(again).toMatchObject({ rebuilt: 3, untouched: 0, lines: 8, alreadySettled: 0 });
    const second = [...(await statementsOf(a.id)), ...(await statementsOf(b.id))];
    expect(second.map(contentOf)).toEqual(first.map(contentOf));
    expect(second.map((row) => row["version"])).toEqual(first.map((row) => (row["version"] as number) + 1));
    expect(second.map((row) => row["generated_at"])).toEqual(second.map(() => t.clock.now()));
    const secondLines = await Promise.all(
      second.map(async (row) => (await linesOf(row["id"])).map(lineContentOf)),
    );
    expect(secondLines).toEqual(firstLines);
    expect((await auditOf("settlement.generated", [a.id, b.id])).at(-1)).toMatchObject({
      details: { before: expect.objectContaining({ lineCount: expect.any(Number) }) },
    });
  });

  it("[PBE-059 AC2] never touches an approved or paid statement, and skips a transaction already on one", async () => {
    const { a, b } = await twoTenants();
    putOctober(a.id, b.id);
    await generator.generate({ periodStart: new Date(OCTOBER) });
    const approvedId = (await octoberOf(a.id, "EUR"))["id"];
    const paidId = (await octoberOf(a.id, "USD"))["id"];
    await pool.query(
      `UPDATE platform.settlements SET status = 'approved', approved_at = $2, approved_by_account_id = $3,
              version = version + 1 WHERE id = $1`,
      [approvedId, NOW, admin],
    );
    await pool.query(
      `UPDATE platform.settlements SET status = 'paid', approved_at = $2, approved_by_account_id = $3, paid_at = $2,
              paid_by_account_id = $3, payout_reference = 'BANK-REF-59', version = version + 2 WHERE id = $1`,
      [paidId, NOW, admin],
    );
    // A September statement of B, paid, already holds one of October's transactions.
    const paidSeptember = await insertSettlement(pool, b, {
      environment: "test",
      period_start: new Date("2026-09-01T00:00:00Z"),
      period_end: new Date("2026-10-01T00:00:00Z"),
      status: "paid",
      gross_amount: "400.00",
      stripe_fees_amount: "5.95",
      net_amount: "394.05",
      line_count: 1,
      paid_at: NOW,
      payout_reference: "BANK-REF-58",
    });
    await pool.query("DELETE FROM platform.settlement_lines WHERE balance_transaction_id = 'txn_B1'");
    await insertSettlementLine(pool, paidSeptember, {
      balance_transaction_id: "txn_B1",
      payment_intent_id: "pi_B1",
      amount: "400.00",
      stripe_fee: "5.95",
    });
    const before = await Promise.all(
      [approvedId, paidId, paidSeptember.id].map(async (id) => ({
        statement: (await pool.query("SELECT * FROM platform.settlements WHERE id = $1", [id]))
          .rows[0] as Row,
        lines: await linesOf(id),
      })),
    );
    t.clock.set(new Date(NOW.getTime() + 60_000));

    const result = await generator.generate({ periodStart: new Date(OCTOBER) });

    expect(result).toMatchObject({ rebuilt: 1, untouched: 2, alreadySettled: 1, lines: 0 });
    const after = await Promise.all(
      [approvedId, paidId, paidSeptember.id].map(async (id) => ({
        statement: (await pool.query("SELECT * FROM platform.settlements WHERE id = $1", [id]))
          .rows[0] as Row,
        lines: await linesOf(id),
      })),
    );
    expect(after).toEqual(before);
    // B's October draft is rebuilt without the transaction the paid September statement holds.
    expect(await octoberOf(b.id, "EUR")).toMatchObject({
      status: "draft",
      line_count: 0,
      net_amount: "0.00",
    });
    expect(await linesOf((await octoberOf(b.id, "EUR"))["id"])).toEqual([]);
  });

  it("[PBE-059] rebuilds only the tenant asked for, and a new draft once the old one is void", async () => {
    const { a, b } = await twoTenants();
    putOctober(a.id, b.id);
    await generator.generate({ periodStart: new Date(OCTOBER) });
    const aBefore = await statementsOf(a.id);
    const voided = await octoberOf(b.id, "EUR");
    await pool.query("DELETE FROM platform.settlement_lines WHERE settlement_id = $1", [voided["id"]]);
    await pool.query(
      `UPDATE platform.settlements SET status = 'void', voided_at = $2, void_reason = 'Wrong fee plan', line_count = 0
        WHERE id = $1`,
      [voided["id"], NOW],
    );
    t.clock.set(new Date(NOW.getTime() + 60_000));

    const result = await generator.generate({ periodStart: new Date(OCTOBER), tenantId: b.id });

    expect(result).toMatchObject({ tenantId: b.id, rebuilt: 1, untouched: 0, otherTenants: 8, lines: 1 });
    expect(await statementsOf(a.id)).toEqual(aBefore);
    const bStatements = await statementsOf(b.id);
    expect(bStatements.map((row) => [row["id"] === voided["id"], row["status"], row["line_count"]])).toEqual([
      [true, "void", 0],
      [false, "draft", 1],
    ]);
    expect(bStatements[0]).toMatchObject({ void_reason: "Wrong fee plan", net_amount: "394.05" });
  });

  it("[PBE-059] leaves a carried-forward balance to the earliest open draft, and rebuilds a draft no transaction names any more", async () => {
    // January 2027: December is carried forward already, and October is generated again.
    t.clock.set(new Date("2027-01-04T09:00:00.000Z"));
    const { a, b } = await twoTenants();
    putOctober(a.id, b.id);
    // A's negative August in EUR, not absorbed yet, and A's September draft, still open: the next draft absorbs a
    // balance (PADR-0003 item 7), so September's does and October's never counts it a second time. December's negative
    // balance comes after October and is never October's.
    const august = await insertSettlement(pool, a, {
      environment: "test",
      period_start: new Date("2026-08-01T00:00:00Z"),
      period_end: new Date("2026-09-01T00:00:00Z"),
      status: "carried_forward",
      refunds_amount: "20.00",
      net_amount: "-20.00",
    });
    const september = await insertSettlement(pool, a, {
      environment: "test",
      period_start: new Date("2026-09-01T00:00:00Z"),
      period_end: new Date("2026-10-01T00:00:00Z"),
    });
    await insertSettlement(pool, a, {
      environment: "test",
      period_start: new Date("2026-12-01T00:00:00Z"),
      period_end: new Date("2027-01-01T00:00:00Z"),
      status: "carried_forward",
      refunds_amount: "5.00",
      net_amount: "-5.00",
    });

    await generator.generate({ periodStart: new Date(OCTOBER) });

    const october = await octoberOf(a.id, "EUR");
    expect(totalsOf(october)).toMatchObject({ adjustments_amount: "0.00", net_amount: "728.00" });
    expect((await linesOf(october["id"])).map((line) => line["line_type"])).not.toContain("carry_forward");

    // September's draft is voided, so October's takes August over; and B's charge now names a tenant the platform does
    // not know, so B's October draft, which no transaction names any more, is rebuilt empty.
    await pool.query(
      `UPDATE platform.settlements SET status = 'void', voided_at = $2, void_reason = 'Generated by mistake'
        WHERE id = $1`,
      [september.id, t.clock.now()],
    );
    stripe.reset();
    putOctober(a.id, testId("ten", 99_997));

    const again = await generator.generate({ periodStart: new Date(OCTOBER) });

    expect(again).toMatchObject({ unknownTenant: 2, rebuilt: 3, untouched: 0, lines: 7 });
    const absorbing = await octoberOf(a.id, "EUR");
    expect(absorbing).toMatchObject({ id: october["id"], line_count: 7, version: 2 });
    expect(totalsOf(absorbing)).toMatchObject({ adjustments_amount: "-20.00", net_amount: "708.00" });
    expect((await linesOf(absorbing["id"]))[0]).toMatchObject({
      line_type: "carry_forward",
      amount: "-20.00",
      description: `Balance carried forward from 2026-08 (${august.id})`,
    });
    const emptied = await octoberOf(b.id, "EUR");
    expect(emptied).toMatchObject({ status: "draft", line_count: 0, version: 2 });
    expect(totalsOf(emptied)).toEqual(Object.fromEntries(TOTAL_COLUMNS.map((column) => [column, "0.00"])));
    expect(await linesOf(emptied["id"])).toEqual([]);
  });
});

// ---- The job -----------------------------------------------------------------------------------------------------

describe("the settlement.generate job (flow §F item 1, api-inventory-admin.md §6)", () => {
  it("[PBE-059] adminGenerateSettlements queues a month that has ended, and the worker builds its drafts", async () => {
    const { a, b } = await twoTenants();
    putOctober(a.id, b.id);

    const res = await generate({ periodStart: "2026-10-01T00:00:00Z", tenantId: a.id }, await adminHeaders());

    expect(res.status).toBe(202);
    expectResponseToMatch("adminGenerateSettlements", res, { document: "platform" });
    expect(res.text).toBe("");
    const requestId = res.headers["x-request-id"] as string;
    const [job] = await settled(settlementsQueue, isGenerate);
    expect(job?.data).toEqual({ periodStart: OCTOBER, tenantId: a.id, requestId });
    expect(job?.returnvalue).toMatchObject({ tenantId: a.id, rebuilt: 2, lines: 7 });
    expect((await statementsOf(a.id)).map((row) => row["currency"])).toEqual(["EUR", "USD"]);
    expect(await statementsOf(b.id)).toEqual([]);
    expect(await auditOf("settlement.generation_requested", [a.id])).toEqual([
      expect.objectContaining({
        actor_type: "platform_admin",
        actor_account_id: admin,
        target_type: "settlement",
        target_id: null,
        tenant_id: a.id,
        request_id: requestId,
        details: { periodStart: OCTOBER, tenantId: a.id },
      }),
    ]);
    // The drafts' audit rows carry the request that queued the job.
    expect((await auditOf("settlement.generated", [a.id])).map((row) => row["request_id"])).toEqual([
      requestId,
      requestId,
    ]);
  });

  it("[PBE-059] adminGenerateSettlements refuses a month that has not ended, an unknown tenant and a caller without an admin token", async () => {
    const requestsBefore = (await auditOf("settlement.generation_requested")).length;
    const headers = await adminHeaders();
    for (const periodStart of ["2026-11-01T00:00:00Z", "2027-02-01T00:00:00Z"]) {
      const res = await generate({ periodStart }, headers);
      expect(res.status, periodStart).toBe(400);
      expectResponseToMatch("adminGenerateSettlements", res, { document: "platform" });
      expect(res.body.error.fieldErrors).toEqual([
        { path: "/periodStart", code: "period_not_closed", message: "Choose a month that has ended." },
      ]);
    }
    const midMonth = await generate({ periodStart: "2026-10-15T00:00:00Z" }, headers);
    expect(midMonth.status).toBe(400);
    expectResponseToMatch("adminGenerateSettlements", midMonth, { document: "platform" });
    const unknown = await generate(
      { periodStart: OCTOBER.replace(".000", ""), tenantId: testId("ten", 99_998) },
      headers,
    );
    expect(unknown.status).toBe(404);
    expectResponseToMatch("adminGenerateSettlements", unknown, { document: "platform" });
    const anonymous = await generate({ periodStart: "2026-10-01T00:00:00Z" }, t.bffHeaders(ADMIN_IP));
    expect(anonymous.status).toBe(401);
    expectResponseToMatch("adminGenerateSettlements", anonymous, { document: "platform" });

    expect(await jobsOf(settlementsQueue)).toEqual([]);
    expect(await auditOf("settlement.generation_requested")).toHaveLength(requestsBefore);
  });

  it("[PBE-059] adminGenerateSettlements answers 503 when Redis does not take the job, and writes no audit row", async () => {
    const requestsBefore = (await auditOf("settlement.generation_requested")).length;
    const apiQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.settlements), { strict: false });
    vi.spyOn(apiQueue, "add").mockRejectedValueOnce(new Error("Connection is closed."));

    const res = await generate({ periodStart: "2026-10-01T00:00:00Z" }, await adminHeaders());

    expect(res.status).toBe(503);
    expectResponseToMatch("adminGenerateSettlements", res, { document: "platform" });
    expect(await auditOf("settlement.generation_requested")).toHaveLength(requestsBefore);
    expect(await jobsOf(settlementsQueue)).toEqual([]);
  });

  it("[PBE-059] settlements.monthly queues the previous month through the maintenance processor", async () => {
    const { a, b } = await twoTenants();
    putOctober(a.id, b.id);
    expect(PLATFORM_SCHEDULES.find((schedule) => schedule.id === SETTLEMENTS_MONTHLY_JOB)).toMatchObject({
      pattern: "0 5 3 * *",
      features: ["settlements"],
    });

    await maintenanceQueue.add(SETTLEMENTS_MONTHLY_JOB, {});

    const [monthly] = await settled(maintenanceQueue, (job) => job.name === SETTLEMENTS_MONTHLY_JOB);
    expect(monthly?.returnvalue).toEqual({ periodStart: OCTOBER });
    const [job] = await settled(settlementsQueue, isGenerate);
    expect(job?.data).toEqual({ periodStart: OCTOBER });
    expect(job?.returnvalue).toMatchObject({ tenantId: null, rebuilt: 3, untouched: 0 });
    expect((await octoberOf(a.id, "EUR"))["net_amount"]).toBe("728.00");
  });

  it("[PBE-059] tries again after a Stripe outage, and gives up at once without a Stripe key", async () => {
    const { a, b } = await twoTenants();
    putOctober(a.id, b.id);
    const jobs = worker.get(SettlementJobs, { strict: false });
    const failuresBefore = failureLines().length;
    stripe.failNext("balanceTransactions.list", FakeStripe.apiError(503));

    expect(await jobs.enqueue({ periodStart: OCTOBER, tenantId: b.id })).toBe(true);

    const [retried] = await settled(settlementsQueue, isGenerate);
    expect(await retried?.getState()).toBe("completed");
    expect(retried?.attemptsMade).toBe(2);
    expect(retried?.returnvalue).toMatchObject({ rebuilt: 1, lines: 1 });
    expect(failureLines().slice(failuresBefore)).toEqual([
      expect.objectContaining({
        level: 50,
        code: "STRIPE_API_ERROR",
        failure: "STRIPE_API_ERROR: Stripe answered 503",
        periodStart: OCTOBER,
        tenantId: b.id,
      }),
    ]);
    // Described, never Stripe's error object with its message and request.
    expect(JSON.stringify(failureLines())).not.toContain("Fake Stripe answered");

    await settlementsQueue.obliterate({ force: true });
    stripe.notConfigured();
    expect(await jobs.enqueue({ periodStart: OCTOBER })).toBe(true);

    const [unconfigured] = await settled(settlementsQueue, isGenerate);
    expect(await unconfigured?.getState()).toBe("failed");
    expect(unconfigured?.attemptsMade).toBe(1);
    expect(unconfigured?.failedReason).toBe("STRIPE_NOT_CONFIGURED: STRIPE_SECRET_KEY is not set");
  });
});
