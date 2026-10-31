// The settlement review workflow and the portal's statements (PBE-060; platform/docs/flows/stripe-payments-account.md
// §F items 4 and 5, flows/platform-admin-operations.md "Sequence: settlement review and payout" and §F, PADR-0003 items
// 5–11, api-inventory-admin.md §6, api-inventory-resources.md §5, scope PF-63 AC2 and AC3, PF-91) through the HTTP
// pipeline (createTestApp) on this file's database clone and this worker's Redis database:
//
// - the admin: the list (filters, order, cursor), the detail with the payout account status and its `ETag`, the lines
//   (cursor) and their CSV; adjustments (a reason, drafts only, totals computed again), approval (step-up, `If-Match`,
//   `approved` with a verified payout account or `carried_forward`, a carried-forward balance absorbed once), payment
//   (step-up, `If-Match`, approved only, the owners and finance members e-mailed `settlement.paid`) and void (a
//   reason, drafts only, lines deleted); every write audited once, and a refused one changing nothing;
// - the portal: owners and finance members list and read the approved, paid and carried-forward statements of their
//   OTA and download the lines as CSV with the inventory's columns, never a draft or a voided draft.
//
// The statements are written with the row builders (the generator is PBE-059's and has its own tests); their totals
// come from settlement-formula.ts and their `carry_forward` lines from the generator's own `carryForwardLine`, so they
// are what a generated draft holds. The FakeClock stands on 2026-11-10 at 09:00 UTC; every test starts without
// statements. Every JSON answer is checked against the platform document.
import { expectResponseToMatch } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import { TENANT_ROLES, type TenantRole } from "../../../src/memberships/tenant-roles";
import { EmailTemplates, type EmailTemplateKey } from "../../../src/notifications/templates";
import {
  adminSettlementCsv,
  PORTAL_SETTLEMENT_CSV_COLUMNS,
  portalSettlementCsv,
  type SettlementCsvLine,
} from "../../../src/settlements/settlement-csv";
import { SettlementMoney, settlementTotals } from "../../../src/settlements/settlement-formula";
import { carryForwardLine, settlementPeriod } from "../../../src/settlements/settlement-generator";
import {
  insertAccount,
  insertSettlement,
  insertSettlementLine,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** Starting the API (database clone, Nest module graph, Ajv compilation of the document) takes seconds on CI. */
const SETUP_TIMEOUT_MS = 60_000;
const NOW = "2026-11-10T09:00:00.000Z";
const FAMILY = testId("asn", 60_000);
// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.60";
const ADMIN_IP = "198.51.100.60";
/** A bank transfer's reference (a test value), which no log line may hold. */
const BANK_REFERENCE = "VX-SETTLE-2026-10-TEST";

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
let templates: EmailTemplates;
let admin: PlatformRow<"accounts">;

beforeAll(async () => {
  // Expensive set-up, once per file: the clone, the module graph and the worker's e-mail templates.
  t = await createTestApp();
  t.clock.set(NOW);
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  templates = EmailTemplates.load();
  admin = await insertAccount(pool, { is_platform_admin: true, mfa_enabled: true });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

beforeEach(async () => {
  t.clock.set(NOW);
  await pool.query("DELETE FROM platform.settlement_lines");
  await pool.query("UPDATE platform.settlements SET carried_to_id = NULL");
  await pool.query("DELETE FROM platform.settlements");
});

// ---- People and OTAs ---------------------------------------------------------------------------------------------

type Who = TenantRole | "removedFinance" | "disabledOwner" | "stranger";

/** An OTA with an active member of every role, a removed finance member, a disabled owner, and a stranger. */
interface Fixture {
  readonly tenant: PlatformRow<"tenants">;
  readonly people: ReadonlyMap<Who, PlatformRow<"accounts">>;
}

async function fixture(): Promise<Fixture> {
  const { tenant } = await insertOta(pool);
  const people = new Map<Who, PlatformRow<"accounts">>();
  for (const role of TENANT_ROLES) {
    const account = await insertAccount(pool);
    await insertMember(pool, tenant, account, role);
    people.set(role, account);
  }
  const removedFinance = await insertAccount(pool);
  await insertMembership(pool, tenant, removedFinance, { role: "finance", status: "removed" });
  people.set("removedFinance", removedFinance);
  const disabledOwner = await insertAccount(pool, { status: "disabled" });
  await insertMember(pool, tenant, disabledOwner, "owner");
  people.set("disabledOwner", disabledOwner);
  people.set("stranger", await insertAccount(pool));
  return { tenant, people };
}

function person(f: Fixture, who: Who): PlatformRow<"accounts"> {
  const account = f.people.get(who);
  if (account === undefined) {
    throw new Error(`no ${who} in the fixture`);
  }
  return account;
}

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** The headers of a portal call by `who`. */
async function portal(f: Fixture, who: Who): Promise<Record<string, string>> {
  const claims: AccessTokenInput = {
    aud: "portal",
    sub: person(f, who).id,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
  };
  const { token } = await tokens.sign(claims);
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

/** The headers of an admin call: a `platform_admin` token, with a TOTP step-up now unless `stepUp` is false. */
async function adminHeaders(stepUp = true): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: admin.id,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
    ...(stepUp ? { mfa_at: nowSeconds() } : {}),
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(ADMIN_IP) };
}

/** Writes the OTA's payout account (no bank number: the review never decrypts it) in `status`. */
async function payoutAccount(
  tenantId: string,
  status: "pending_review" | "verified" | "rejected",
): Promise<void> {
  await pool.query(
    `INSERT INTO platform.tenant_payout_accounts
       (tenant_id, account_holder_name, country_code, currency, scheme, bank_details_ciphertext, encryption_key_id,
        last4, status, review_note)
     VALUES ($1, 'Agency Travel AS', 'NO', 'EUR', 'iban', $2, $3, '7947', $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET status = EXCLUDED.status, review_note = EXCLUDED.review_note`,
    [
      tenantId,
      Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
      PLACEHOLDER_KEK_ID,
      status,
      status === "rejected" ? "The holder is not the OTA's legal name." : null,
    ],
  );
}

// ---- Statements ---------------------------------------------------------------------------------------------------

/** One line of a statement as a test writes it; `txn` lines get a balance transaction and Stripe references. */
interface LineSpec {
  readonly type: "charge" | "refund" | "dispute" | "dispute_reversal" | "adjustment" | "carry_forward";
  readonly amount: string;
  readonly fee?: string;
  readonly day?: number;
  readonly description?: string;
}

interface StatementSpec {
  /** 1–12: the month of 2026 (`month: 13` is January 2027). */
  readonly month: number;
  readonly status?: "draft" | "approved" | "paid" | "carried_forward" | "void";
  readonly currency?: string;
  readonly feeBps?: number;
  readonly lines?: readonly LineSpec[];
  /** Earlier carried-forward statements whose balance the generator would put on this draft. */
  readonly absorbs?: ReadonlyArray<PlatformRow<"settlements">>;
}

let txnSequence = 0;

const monthStart = (month: number): Date => new Date(Date.UTC(2026, month - 1, 1));

/**
 * Writes a statement of `tenant` as the generator and the review leave it: its lines (and a `carry_forward` line for
 * `absorbs`), the totals of settlement-formula.ts, and the fields its status needs.
 */
async function statement(
  tenant: Pick<PlatformRow<"tenants">, "id">,
  spec: StatementSpec,
): Promise<{
  readonly row: PlatformRow<"settlements">;
  readonly lines: Array<PlatformRow<"settlement_lines">>;
}> {
  const currency = spec.currency ?? "EUR";
  const period = settlementPeriod(monthStart(spec.month));
  const status = spec.status ?? "draft";
  const feeBps = spec.feeBps ?? 0;
  const specs = [...(spec.lines ?? [])];
  const carry = carryForwardLine(
    (spec.absorbs ?? []).map((carried) => ({
      id: carried.id,
      period_start: carried.period_start,
      net_amount: carried.net_amount,
    })),
    period,
  );
  const amounts = [
    ...specs.map((line) => ({ line_type: line.type, amount: line.amount, stripe_fee: line.fee ?? "0.00" })),
    ...(carry === undefined
      ? []
      : [{ line_type: "carry_forward", amount: carry.amount, stripe_fee: "0.00" }]),
  ];
  const totals = settlementTotals(amounts, { feeBps, decimals: 2 });
  const decided = new Date(Date.UTC(2026, spec.month, 4, 9));
  const row = await insertSettlement(pool, tenant, {
    currency,
    period_start: period.start,
    period_end: period.end,
    status,
    fee_bps: feeBps,
    ...totals,
    ...(status === "void" ? { line_count: 0, voided_at: decided, void_reason: "Generated by mistake" } : {}),
    ...(status === "approved" || status === "paid" || status === "carried_forward"
      ? { approved_at: decided, approved_by_account_id: admin.id }
      : {}),
    ...(status === "paid"
      ? { paid_at: decided, paid_by_account_id: admin.id, payout_reference: "VX-EARLIER-PAYMENT" }
      : {}),
    generated_at: new Date(Date.UTC(2026, spec.month, 3, 5)),
  });
  const lines: Array<PlatformRow<"settlement_lines">> = [];
  if (status === "void") {
    return { row, lines };
  }
  for (const [index, line] of specs.entries()) {
    const fromStripe = line.type !== "adjustment" && line.type !== "carry_forward";
    txnSequence += 1;
    const n = String(txnSequence).padStart(6, "0");
    lines.push(
      await insertSettlementLine(pool, row, {
        line_type: line.type,
        occurred_at: new Date(Date.UTC(2026, spec.month - 1, line.day ?? index + 2, 12)),
        amount: line.amount,
        stripe_fee: line.fee ?? "0.00",
        balance_transaction_id: fromStripe ? `txn_PBE060${n}` : null,
        source_id: fromStripe
          ? `${line.type === "refund" ? "re" : line.type === "charge" ? "ch" : "du"}_PBE060${n}`
          : null,
        payment_intent_id: fromStripe ? `pi_PBE060${n}` : null,
        velexis_payment_id: fromStripe ? `pay_01JD2K7M1P5R9T3W7Y1A5C${n.slice(2)}` : null,
        checkout_id: fromStripe ? `chk_01JD2K6K0N4Q8S2V6X0Z4B${n.slice(2)}` : null,
        description: line.description ?? `Booking ${n}`,
        created_by_account_id: line.type === "adjustment" ? admin.id : null,
      }),
    );
  }
  if (carry !== undefined) {
    lines.push(await insertSettlementLine(pool, row, { ...carry, created_by_account_id: null }));
  }
  return { row, lines };
}

/** October's charges of 1000.00 and 500.00 and a refund of 100.00: net 1355.25 before the Velexis fee. */
const OCTOBER_LINES: readonly LineSpec[] = [
  { type: "charge", amount: "1000.00", fee: "29.25", day: 2 },
  { type: "charge", amount: "500.00", fee: "15.50", day: 5 },
  { type: "refund", amount: "-100.00", fee: "0.00", day: 9 },
];

// ---- Reading what happened ----------------------------------------------------------------------------------------

async function stored(id: string): Promise<PlatformRow<"settlements">> {
  const { rows } = await pool.query("SELECT * FROM platform.settlements WHERE id = $1", [id]);
  return rows[0] as PlatformRow<"settlements">;
}

async function storedLines(id: string): Promise<Array<PlatformRow<"settlement_lines">>> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.settlement_lines WHERE settlement_id = $1 ORDER BY occurred_at, id",
    [id],
  );
  return rows as Array<PlatformRow<"settlement_lines">>;
}

async function auditOf(targetId: string, action?: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    `SELECT * FROM platform.platform_audit_log WHERE target_id = $1 ${action === undefined ? "" : "AND action = $2"}
     ORDER BY id`,
    action === undefined ? [targetId] : [targetId, action],
  );
  return rows as Array<Record<string, unknown>>;
}

interface OutboxRow {
  readonly template: EmailTemplateKey;
  readonly to_email: string;
  readonly account_id: string | null;
  readonly data: Record<string, string>;
}

async function emailsOf(tenantId: string, template: string): Promise<OutboxRow[]> {
  const { rows } = await pool.query(
    "SELECT * FROM platform.email_outbox WHERE tenant_id = $1 AND template = $2 ORDER BY created_at, id",
    [tenantId, template],
  );
  return rows as OutboxRow[];
}

/** The subject, HTML and text of a queued e-mail, rendered by the worker's templates. */
function rendered(row: OutboxRow): string {
  const email = templates.render(
    row.template,
    { data: row.data, secretData: {} },
    { portalUrl: t.config.PUBLIC_PORTAL_URL, adminUrl: t.config.PUBLIC_PLATFORM_ADMIN_URL },
  );
  return [email.subject, email.html, email.text].join("\n");
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

const outcomeOf = (res: Response): string =>
  res.status < 400 ? String(res.status) : `${res.status} ${errorOf(res).code}`;

const adminPath = (id: string, action = ""): string =>
  `/v1/admin/settlements/${id}${action === "" ? "" : `/${action}`}`;

async function approve(id: string, ifMatch: string | undefined, stepUp = true): Promise<Response> {
  const request = t.http.post(adminPath(id, "approve")).set(await adminHeaders(stepUp));
  return ifMatch === undefined ? request : request.set("If-Match", ifMatch);
}

async function markPaid(id: string, ifMatch: string, body: object, stepUp = true): Promise<Response> {
  return t.http
    .post(adminPath(id, "mark-paid"))
    .set(await adminHeaders(stepUp))
    .set("If-Match", ifMatch)
    .send(body);
}

async function voidStatement(id: string, body: object): Promise<Response> {
  return t.http
    .post(adminPath(id, "void"))
    .set(await adminHeaders())
    .send(body);
}

async function adjust(id: string, body: object): Promise<Response> {
  return t.http
    .post(adminPath(id, "adjustments"))
    .set(await adminHeaders())
    .send(body);
}

const etag = (version: number): string => `"${version}"`;

/** The columns of a statement that a refused write must leave as they are. */
const snapshot = (row: PlatformRow<"settlements">): Record<string, unknown> => ({
  status: row.status,
  version: row.version,
  net_amount: row.net_amount,
  adjustments_amount: row.adjustments_amount,
  line_count: row.line_count,
  carried_to_id: row.carried_to_id,
  approved_at: row.approved_at,
  paid_at: row.paid_at,
  voided_at: row.voided_at,
});

// ---- Approval -----------------------------------------------------------------------------------------------------

describe("adminApproveSettlement", () => {
  it("[PBE-060 AC1] approves a positive draft with a step-up, If-Match and a verified payout account, once", async () => {
    const f = await fixture();
    await payoutAccount(f.tenant.id, "verified");
    const { row } = await statement(f.tenant, { month: 10, lines: OCTOBER_LINES, feeBps: 150 });
    const before = snapshot(await stored(row.id));

    const withoutStepUp = await approve(row.id, etag(row.version), false);
    const withoutIfMatch = await approve(row.id, undefined);
    const stale = await approve(row.id, etag(row.version + 1));

    expect([withoutStepUp, withoutIfMatch, stale].map(outcomeOf)).toEqual([
      "401 REAUTH_REQUIRED",
      "400 VALIDATION_FAILED",
      "412 PRECONDITION_FAILED",
    ]);
    expect(errorOf(withoutIfMatch).fieldErrors).toEqual([
      expect.objectContaining({ path: "/header/If-Match" }),
    ]);
    for (const res of [withoutStepUp, withoutIfMatch, stale]) {
      expectResponseToMatch("adminApproveSettlement", res, { document: "platform" });
    }
    expect(snapshot(await stored(row.id))).toEqual(before);
    expect(await auditOf(row.id)).toEqual([]);

    const approved = await approve(row.id, `"${row.version}"`);

    expect(approved.status).toBe(200);
    expectResponseToMatch("adminApproveSettlement", approved, { document: "platform" });
    expect(approved.headers["etag"]).toBe(etag(row.version + 1));
    expect(approved.body).toMatchObject({
      id: row.id,
      tenantId: f.tenant.id,
      tenantKey: f.tenant.key,
      status: "approved",
      netAmount: { amount: row.net_amount, currency: "EUR" },
      approvedAt: NOW,
      approvedByAccountId: admin.id,
      payoutAccountStatus: "verified",
      version: row.version + 1,
    });
    const audit = await auditOf(row.id, "settlement.approved");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin.id,
      tenant_id: f.tenant.id,
      details: expect.objectContaining({
        before: { status: "draft" },
        after: { status: "approved", netAmount: row.net_amount },
        absorbedStatementIds: [],
        payoutAccountStatus: "verified",
        version: row.version + 1,
      }),
    });

    // Approved is immutable: a second approval with the new version is a wrong state.
    const again = await approve(row.id, etag(row.version + 1));
    expect(outcomeOf(again)).toBe("409 SETTLEMENT_STATE_INVALID");
    expect(errorOf(again).details).toEqual({ status: "approved" });
    expectResponseToMatch("adminApproveSettlement", again, { document: "platform" });
    expect(await auditOf(row.id)).toHaveLength(1);
  });

  it("[PBE-060 AC1] refuses a positive net without a verified payout account (PAYOUT_ACCOUNT_REQUIRED)", async () => {
    const f = await fixture();
    const { row } = await statement(f.tenant, { month: 10, lines: OCTOBER_LINES });
    const before = snapshot(await stored(row.id));
    const outcomes: string[] = [];

    outcomes.push(outcomeOf(await approve(row.id, etag(row.version))));
    for (const status of ["pending_review", "rejected"] as const) {
      await payoutAccount(f.tenant.id, status);
      const refused = await approve(row.id, etag(row.version));
      expectResponseToMatch("adminApproveSettlement", refused, { document: "platform" });
      outcomes.push(outcomeOf(refused));
    }

    expect(outcomes).toEqual([
      "422 PAYOUT_ACCOUNT_REQUIRED",
      "422 PAYOUT_ACCOUNT_REQUIRED",
      "422 PAYOUT_ACCOUNT_REQUIRED",
    ]);
    expect(snapshot(await stored(row.id))).toEqual(before);
    expect(await auditOf(row.id)).toEqual([]);
  });

  it("[PBE-060 AC1] carries a net of zero or less forward, without a payout account", async () => {
    const f = await fixture();
    const negative = await statement(f.tenant, {
      month: 10,
      lines: [
        { type: "charge", amount: "200.00", fee: "6.10" },
        { type: "dispute", amount: "-200.00", fee: "15.00" },
      ],
    });
    const zero = await statement(f.tenant, { month: 10, currency: "USD" });

    const carried = await approve(negative.row.id, etag(negative.row.version));
    const empty = await approve(zero.row.id, etag(zero.row.version));

    for (const res of [carried, empty]) {
      expect(res.status).toBe(200);
      expectResponseToMatch("adminApproveSettlement", res, { document: "platform" });
      expect(res.body).toMatchObject({
        status: "carried_forward",
        payoutAccountStatus: null,
        approvedAt: NOW,
      });
    }
    expect((carried.body as { netAmount: unknown }).netAmount).toEqual({ amount: "-21.10", currency: "EUR" });
    expect((empty.body as { netAmount: unknown }).netAmount).toEqual({ amount: "0.00", currency: "USD" });
    expect(await auditOf(negative.row.id, "settlement.approved")).toHaveLength(1);
  });

  it("[PBE-060 AC1] absorbs a carried-forward balance once: the earliest later draft takes it, a second one is refused", async () => {
    const f = await fixture();
    await payoutAccount(f.tenant.id, "verified");
    // September was carried forward with -50.00. October's and November's drafts both hold it (November's was
    // generated before October had a draft): October, the earliest open draft, absorbs it.
    const september = await statement(f.tenant, {
      month: 9,
      status: "carried_forward",
      lines: [{ type: "dispute", amount: "-35.00", fee: "15.00" }],
    });
    expect(september.row.net_amount).toBe("-50.00");
    const october = await statement(f.tenant, { month: 10, lines: OCTOBER_LINES, absorbs: [september.row] });
    const november = await statement(f.tenant, {
      month: 11,
      lines: [{ type: "charge", amount: "300.00", fee: "9.00" }],
      absorbs: [september.row],
    });
    const novemberBefore = snapshot(await stored(november.row.id));

    // November is not the draft that absorbs September while October is open.
    const tooEarly = await approve(november.row.id, etag(november.row.version));
    expect(outcomeOf(tooEarly)).toBe("409 SETTLEMENT_STATE_INVALID");
    expect(errorOf(tooEarly).details).toEqual({ status: "draft", reason: "carry_forward_changed" });
    expectResponseToMatch("adminApproveSettlement", tooEarly, { document: "platform" });

    const approved = await approve(october.row.id, etag(october.row.version));
    expect(approved.status).toBe(200);
    expect((await stored(september.row.id)).carried_to_id).toBe(october.row.id);
    expect((await auditOf(october.row.id, "settlement.approved"))[0]).toMatchObject({
      details: expect.objectContaining({ absorbedStatementIds: [september.row.id] }),
    });

    // Once October absorbed it, November's line counts it a second time: refused, and nothing changes.
    const twice = await approve(november.row.id, etag(november.row.version));
    expect(outcomeOf(twice)).toBe("409 SETTLEMENT_STATE_INVALID");
    expect(errorOf(twice).details).toEqual({ status: "draft", reason: "carry_forward_changed" });
    expect(snapshot(await stored(november.row.id))).toEqual(novemberBefore);
    expect((await stored(september.row.id)).carried_to_id).toBe(october.row.id);
    expect(await auditOf(november.row.id)).toEqual([]);

    // Generated again, November holds no carried-forward balance and is approved.
    await pool.query("DELETE FROM platform.settlement_lines WHERE settlement_id = $1", [november.row.id]);
    await pool.query("DELETE FROM platform.settlements WHERE id = $1", [november.row.id]);
    const regenerated = await statement(f.tenant, {
      month: 11,
      lines: [{ type: "charge", amount: "300.00", fee: "9.00" }],
    });
    const later = await approve(regenerated.row.id, etag(regenerated.row.version));
    expect(later.status).toBe(200);
    expect((later.body as { status: string }).status).toBe("approved");
    expect((await stored(september.row.id)).carried_to_id).toBe(october.row.id);
  });

  it("[PBE-060 AC1] two approvals of one draft at once: one wins, the balance is absorbed and audited once", async () => {
    const f = await fixture();
    await payoutAccount(f.tenant.id, "verified");
    const september = await statement(f.tenant, {
      month: 9,
      status: "carried_forward",
      lines: [{ type: "dispute", amount: "-35.00", fee: "15.00" }],
    });
    const october = await statement(f.tenant, { month: 10, lines: OCTOBER_LINES, absorbs: [september.row] });

    const results = await Promise.all([
      approve(october.row.id, etag(october.row.version)),
      approve(october.row.id, etag(october.row.version)),
    ]);

    expect(results.map(outcomeOf).sort()).toEqual(["200", "412 PRECONDITION_FAILED"]);
    for (const res of results) {
      expectResponseToMatch("adminApproveSettlement", res, { document: "platform" });
    }
    expect((await stored(october.row.id)).version).toBe(october.row.version + 1);
    expect((await stored(september.row.id)).carried_to_id).toBe(october.row.id);
    expect(await auditOf(october.row.id, "settlement.approved")).toHaveLength(1);
  });

  it("[PBE-060 AC1] refuses a draft generated before a balance it now absorbs was carried forward", async () => {
    const f = await fixture();
    await payoutAccount(f.tenant.id, "verified");
    // October's draft was generated while September was still a draft, so it holds no carry-forward line.
    const september = await statement(f.tenant, {
      month: 9,
      lines: [{ type: "dispute", amount: "-30.00", fee: "15.00" }],
    });
    const october = await statement(f.tenant, { month: 10, lines: OCTOBER_LINES });
    expect((await approve(september.row.id, etag(september.row.version))).status).toBe(200);

    const stale = await approve(october.row.id, etag(october.row.version));

    expect(outcomeOf(stale)).toBe("409 SETTLEMENT_STATE_INVALID");
    expect(errorOf(stale).details).toEqual({ status: "draft", reason: "carry_forward_changed" });
    expect((await stored(october.row.id)).status).toBe("draft");
    expect((await stored(september.row.id)).carried_to_id).toBeNull();
  });

  it("[PBE-060 AC1] answers 404 for an unknown statement and 401 without an admin token", async () => {
    const unknown = await approve(testId("stl", 999_999), etag(1));
    const anonymous = await t.http
      .post(adminPath(testId("stl", 999_999), "approve"))
      .set(t.bffHeaders(ADMIN_IP))
      .set("If-Match", etag(1));

    expect([unknown, anonymous].map(outcomeOf)).toEqual(["404 NOT_FOUND", "401 UNAUTHENTICATED"]);
    expectResponseToMatch("adminApproveSettlement", unknown, { document: "platform" });
  });
});

// ---- Payment ------------------------------------------------------------------------------------------------------

describe("adminMarkSettlementPaid", () => {
  it("[PBE-060 AC1] records the transfer of an approved statement with a step-up, If-Match and a verified payout account", async () => {
    const f = await fixture();
    await payoutAccount(f.tenant.id, "verified");
    const draft = await statement(f.tenant, { month: 9, lines: OCTOBER_LINES });
    const { row } = await statement(f.tenant, { month: 10, status: "approved", lines: OCTOBER_LINES });
    const body = { paidAt: "2026-11-07T00:00:00Z", payoutReference: `  ${BANK_REFERENCE} ` };
    const before = snapshot(await stored(row.id));

    const onDraft = await markPaid(draft.row.id, etag(draft.row.version), body);
    const withoutStepUp = await markPaid(row.id, etag(row.version), body, false);
    const future = await markPaid(row.id, etag(row.version), { ...body, paidAt: "2026-11-10T09:00:01Z" });
    const blank = await markPaid(row.id, etag(row.version), { ...body, payoutReference: "   " });
    const stale = await markPaid(row.id, etag(row.version + 1), body);
    await payoutAccount(f.tenant.id, "pending_review");
    const unverified = await markPaid(row.id, etag(row.version), body);
    await payoutAccount(f.tenant.id, "verified");

    expect([onDraft, withoutStepUp, future, blank, stale, unverified].map(outcomeOf)).toEqual([
      "409 SETTLEMENT_STATE_INVALID",
      "401 REAUTH_REQUIRED",
      "400 VALIDATION_FAILED",
      "400 VALIDATION_FAILED",
      "412 PRECONDITION_FAILED",
      "422 PAYOUT_ACCOUNT_REQUIRED",
    ]);
    expect(errorOf(onDraft).details).toEqual({ status: "draft" });
    expect(errorOf(future).fieldErrors).toEqual([
      expect.objectContaining({ path: "/paidAt", code: "future" }),
    ]);
    expect(errorOf(blank).fieldErrors).toEqual([expect.objectContaining({ path: "/payoutReference" })]);
    for (const res of [onDraft, withoutStepUp, future, blank, stale, unverified]) {
      expectResponseToMatch("adminMarkSettlementPaid", res, { document: "platform" });
    }
    expect(snapshot(await stored(row.id))).toEqual(before);
    expect(await auditOf(row.id)).toEqual([]);
    expect(await emailsOf(f.tenant.id, "settlement.paid")).toEqual([]);

    const paid = await markPaid(row.id, etag(row.version), body);

    expect(paid.status).toBe(200);
    expectResponseToMatch("adminMarkSettlementPaid", paid, { document: "platform" });
    expect(paid.headers["etag"]).toBe(etag(row.version + 1));
    expect(paid.body).toMatchObject({
      status: "paid",
      paidAt: "2026-11-07T00:00:00.000Z",
      payoutReference: BANK_REFERENCE,
      paidByAccountId: admin.id,
      version: row.version + 1,
    });
    const audit = await auditOf(row.id, "settlement.paid");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin.id,
      details: expect.objectContaining({
        before: { status: "approved" },
        after: { status: "paid", netAmount: row.net_amount },
        paidAt: "2026-11-07T00:00:00.000Z",
        payoutReference: BANK_REFERENCE,
      }),
    });

    const again = await markPaid(row.id, etag(row.version + 1), body);
    expect(outcomeOf(again)).toBe("409 SETTLEMENT_STATE_INVALID");
    expect(errorOf(again).details).toEqual({ status: "paid" });
    // The bank reference is in the answer and the audit row, never in a log line.
    expect(JSON.stringify(t.logs.lines)).not.toContain(BANK_REFERENCE);
  });

  it("[PBE-060 AC2] e-mails settlement.paid once to every active owner and finance member, and to nobody else", async () => {
    const f = await fixture();
    await payoutAccount(f.tenant.id, "verified");
    const { row } = await statement(f.tenant, { month: 10, status: "approved", lines: OCTOBER_LINES });

    const paid = await markPaid(row.id, etag(row.version), {
      paidAt: "2026-11-07T00:00:00Z",
      payoutReference: BANK_REFERENCE,
    });

    expect(paid.status).toBe(200);
    const emails = await emailsOf(f.tenant.id, "settlement.paid");
    expect(emails.map((email) => email.account_id).sort()).toEqual(
      [person(f, "owner").id, person(f, "finance").id].sort(),
    );
    expect(emails.map((email) => email.to_email).sort()).toEqual(
      [person(f, "owner").email, person(f, "finance").email].sort(),
    );
    const statementUrl = `${t.config.PUBLIC_PORTAL_URL.replace(/\/+$/, "")}/otas/${f.tenant.id}/payments/settlements/${row.id}`;
    for (const email of emails) {
      expect(email.data).toEqual({
        fullName: expect.any(String) as string,
        tenantName: f.tenant.name,
        tenantKey: f.tenant.key,
        period: "October 2026",
        netAmount: `${row.net_amount} EUR`,
        paidOn: "2026-11-07",
        payoutReference: BANK_REFERENCE,
        statementUrl,
      });
      const text = rendered(email);
      expect(text).toContain(`${row.net_amount} EUR`);
      expect(text).toContain("October 2026");
      expect(text).toContain(BANK_REFERENCE);
      expect(text).toContain(statementUrl);
    }
  });
});

// ---- Void ---------------------------------------------------------------------------------------------------------

describe("adminVoidSettlement", () => {
  it("[PBE-060 AC1] voids a draft only, with a reason of 5–500 characters after trimming, and deletes its lines", async () => {
    const f = await fixture();
    const draft = await statement(f.tenant, { month: 10, lines: OCTOBER_LINES });
    const approved = await statement(f.tenant, { month: 9, status: "approved", lines: OCTOBER_LINES });
    const before = snapshot(await stored(draft.row.id));

    const refusals = [
      await voidStatement(draft.row.id, {}),
      await voidStatement(draft.row.id, { reason: "      " }),
      await voidStatement(draft.row.id, { reason: "  oops  " }),
      await voidStatement(approved.row.id, { reason: "Generated before the refunds were in" }),
    ];

    expect(refusals.map(outcomeOf)).toEqual([
      "400 VALIDATION_FAILED",
      "400 VALIDATION_FAILED",
      "400 VALIDATION_FAILED",
      "409 SETTLEMENT_STATE_INVALID",
    ]);
    for (const res of refusals) {
      expectResponseToMatch("adminVoidSettlement", res, { document: "platform" });
    }
    expect(errorOf(refusals[3] as Response).details).toEqual({ status: "approved" });
    expect(snapshot(await stored(draft.row.id))).toEqual(before);
    expect(await storedLines(draft.row.id)).toHaveLength(3);

    const voided = await voidStatement(draft.row.id, { reason: "  Generated before the refunds were in  " });

    expect(voided.status).toBe(200);
    expectResponseToMatch("adminVoidSettlement", voided, { document: "platform" });
    expect(voided.headers["etag"]).toBe(etag(draft.row.version + 1));
    expect(voided.body).toMatchObject({
      status: "void",
      voidedAt: NOW,
      voidReason: "Generated before the refunds were in",
      lineCount: 0,
      netAmount: { amount: draft.row.net_amount, currency: "EUR" },
      grossAmount: { amount: draft.row.gross_amount, currency: "EUR" },
    });
    expect(await storedLines(draft.row.id)).toEqual([]);
    const audit = await auditOf(draft.row.id, "settlement.voided");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "platform_admin",
      details: expect.objectContaining({ reason: "Generated before the refunds were in", deletedLines: 3 }),
    });

    // Its balance transactions can be settled again: a new draft of the month takes the same transaction.
    const fresh = await insertSettlement(pool, f.tenant, {
      period_start: draft.row.period_start,
      period_end: draft.row.period_end,
    });
    const reused = draft.lines[0]?.balance_transaction_id ?? null;
    expect(reused).not.toBeNull();
    await expect(
      insertSettlementLine(pool, fresh, {
        balance_transaction_id: reused,
        amount: "0.00",
        stripe_fee: "0.00",
      }),
    ).resolves.toMatchObject({ balance_transaction_id: reused });

    const again = await voidStatement(draft.row.id, { reason: "Generated before the refunds were in" });
    expect(outcomeOf(again)).toBe("409 SETTLEMENT_STATE_INVALID");
    expect(errorOf(again).details).toEqual({ status: "void" });
  });
});

// ---- Adjustments --------------------------------------------------------------------------------------------------

describe("adminAddSettlementAdjustment", () => {
  it("[PBE-060 AC1] adds a line to a draft with a reason and computes the totals again", async () => {
    const f = await fixture();
    const draft = await statement(f.tenant, { month: 10, lines: OCTOBER_LINES, feeBps: 150 });
    const approved = await statement(f.tenant, { month: 9, status: "approved", lines: OCTOBER_LINES });
    const body = {
      amount: { amount: "100.00", currency: "EUR" },
      description: "  Goodwill credit for the October outage ",
      reason: "Agreed with the OTA's finance contact on 2026-11-09.",
    };
    const before = snapshot(await stored(draft.row.id));

    const refusals = [
      await adjust(draft.row.id, { ...body, reason: "    " }),
      await adjust(draft.row.id, { ...body, description: "   " }),
      await adjust(draft.row.id, { ...body, amount: { amount: "100.00", currency: "USD" } }),
      await adjust(draft.row.id, { ...body, amount: { amount: "0.00", currency: "EUR" } }),
      await adjust(draft.row.id, { ...body, amount: { amount: "1.005", currency: "EUR" } }),
      await adjust(approved.row.id, body),
    ];

    expect(refusals.map(outcomeOf)).toEqual([
      "400 VALIDATION_FAILED",
      "400 VALIDATION_FAILED",
      "400 VALIDATION_FAILED",
      "400 VALIDATION_FAILED",
      "400 VALIDATION_FAILED",
      "409 SETTLEMENT_STATE_INVALID",
    ]);
    expect(refusals.slice(0, 3).map((res) => errorOf(res).fieldErrors?.[0]?.path)).toEqual([
      "/reason",
      "/description",
      "/amount/currency",
    ]);
    for (const res of refusals) {
      expectResponseToMatch("adminAddSettlementAdjustment", res, { document: "platform" });
    }
    expect(snapshot(await stored(draft.row.id))).toEqual(before);

    const credited = await adjust(draft.row.id, body);
    const debited = await adjust(draft.row.id, {
      ...body,
      amount: { amount: "-25.50", currency: "EUR" },
      description: "-25.50 bank charge of the September transfer",
    });

    for (const res of [credited, debited]) {
      expect(res.status).toBe(200);
      expectResponseToMatch("adminAddSettlementAdjustment", res, { document: "platform" });
    }
    expect(debited.headers["etag"]).toBe(etag(draft.row.version + 2));
    const lines = await storedLines(draft.row.id);
    const expected = settlementTotals(lines, { feeBps: 150, decimals: 2 });
    const row = await stored(draft.row.id);
    expect(row).toMatchObject({ ...expected, version: draft.row.version + 2, status: "draft" });
    expect(expected.adjustments_amount).toBe("74.50");
    // The Velexis fee and the rest do not move; the net moves by the adjustments.
    expect(row.velexis_fees_amount).toBe(draft.row.velexis_fees_amount);
    expect(new SettlementMoney(row.net_amount).minus(draft.row.net_amount).toFixed(2)).toBe("74.50");
    expect(debited.body).toMatchObject({
      adjustmentsAmount: { amount: "74.50", currency: "EUR" },
      netAmount: { amount: row.net_amount, currency: "EUR" },
      lineCount: 5,
    });
    const adjustments = lines.filter((line) => line.line_type === "adjustment");
    expect(adjustments).toHaveLength(2);
    // Both were added at the same instant of the FakeClock, so their order is the ids'.
    expect(adjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amount: "100.00",
          stripe_fee: "0.00",
          description: "Goodwill credit for the October outage",
          created_by_account_id: admin.id,
          balance_transaction_id: null,
          occurred_at: new Date(NOW),
        }),
        expect.objectContaining({
          amount: "-25.50",
          description: "-25.50 bank charge of the September transfer",
        }),
      ]),
    );
    const audit = await auditOf(draft.row.id, "settlement.adjusted");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      actor_type: "platform_admin",
      actor_account_id: admin.id,
      details: expect.objectContaining({ reason: body.reason, amount: "100.00", currency: "EUR" }),
    });
  });
});

// ---- The admin's reads --------------------------------------------------------------------------------------------

describe("the admin's reads", () => {
  it("[PBE-060] lists every statement newest period first, filters it and pages it with a cursor", async () => {
    const a = await fixture();
    const b = await fixture();
    await payoutAccount(a.tenant.id, "verified");
    const rows: Array<PlatformRow<"settlements">> = [];
    for (const [ota, spec] of [
      [a, { month: 10, lines: OCTOBER_LINES }],
      [a, { month: 10, currency: "USD" }],
      [b, { month: 10, lines: OCTOBER_LINES }],
      [a, { month: 9, status: "paid", lines: OCTOBER_LINES }],
      [b, { month: 9, status: "void" }],
      [b, { month: 8, status: "carried_forward" }],
    ] as const) {
      rows.push((await statement(ota.tenant, spec)).row);
    }
    const keyOf = (row: PlatformRow<"settlements">): string =>
      row.tenant_id === a.tenant.id ? a.tenant.key : b.tenant.key;
    const byCodePoint = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
    // Newest period first, then OTA key, currency, environment and id.
    const order = [...rows]
      .sort(
        (x, y) =>
          y.period_start.getTime() - x.period_start.getTime() ||
          byCodePoint(keyOf(x), keyOf(y)) ||
          byCodePoint(x.currency, y.currency) ||
          byCodePoint(x.environment, y.environment) ||
          byCodePoint(x.id, y.id),
      )
      .map((row) => row.id);
    const headers = await adminHeaders(false);
    const list = (query: string) => t.http.get(`/v1/admin/settlements${query}`).set(headers);

    const all = await list("");
    expect(all.status).toBe(200);
    expectResponseToMatch("adminListSettlements", all, { document: "platform" });
    expect((all.body as { data: Array<{ id: string }> }).data.map((row) => row.id)).toEqual(order);

    const drafts = await list("?status=draft&periodStart=2026-10-01T00:00:00Z");
    expect((drafts.body as { data: Array<{ id: string }> }).data.map((row) => row.id).sort()).toEqual(
      rows
        .slice(0, 3)
        .map((row) => row.id)
        .sort(),
    );
    const ofB = await list(`?tenantId=${b.tenant.id}`);
    expect(
      (ofB.body as { data: Array<{ tenantId: string }> }).data.every((row) => row.tenantId === b.tenant.id),
    ).toBe(true);
    expect((ofB.body as { data: unknown[] }).data).toHaveLength(3);

    // One at a time with the cursor gives the same order.
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Response = await list(`?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      expect(page.status).toBe(200);
      expectResponseToMatch("adminListSettlements", page, { document: "platform" });
      const body = page.body as {
        data: Array<{ id: string }>;
        page: { nextCursor: string | null; limit: number };
      };
      paged.push(...body.data.map((row) => row.id));
      expect(body.page.limit).toBe(2);
      cursor = body.page.nextCursor;
    } while (cursor !== null);
    expect(paged).toEqual(order);

    const badCursor = await list("?cursor=bm90LWEtY3Vyc29y");
    expect(outcomeOf(badCursor)).toBe("400 VALIDATION_FAILED");
    expect(errorOf(badCursor).fieldErrors).toEqual([expect.objectContaining({ path: "/query/cursor" })]);
    expectResponseToMatch("adminListSettlements", badCursor, { document: "platform" });
  });

  it("[PBE-060] answers one statement with its OTA, payout account status and ETag, and its lines with a cursor", async () => {
    const f = await fixture();
    await payoutAccount(f.tenant.id, "pending_review");
    const september = await statement(f.tenant, { month: 9, status: "carried_forward" });
    await pool.query(
      "UPDATE platform.settlements SET net_amount = '-12.00', adjustments_amount = '-12.00' WHERE id = $1",
      [september.row.id],
    );
    const { row, lines } = await statement(f.tenant, {
      month: 10,
      lines: OCTOBER_LINES,
      feeBps: 150,
      absorbs: [await stored(september.row.id)],
    });
    const headers = await adminHeaders(false);

    const detail = await t.http.get(adminPath(row.id)).set(headers);
    expect(detail.status).toBe(200);
    expectResponseToMatch("adminGetSettlement", detail, { document: "platform" });
    expect(detail.headers["etag"]).toBe(etag(row.version));
    expect(detail.body).toMatchObject({
      id: row.id,
      tenantKey: f.tenant.key,
      tenantName: f.tenant.name,
      environment: "live",
      status: "draft",
      feeBps: 150,
      lineCount: 4,
      payoutAccountStatus: "pending_review",
      adjustmentsAmount: { amount: "-12.00", currency: "EUR" },
    });

    const first = await t.http.get(`${adminPath(row.id, "lines")}?limit=3`).set(headers);
    expect(first.status).toBe(200);
    expectResponseToMatch("adminListSettlementLines", first, { document: "platform" });
    const firstBody = first.body as {
      data: Array<Record<string, unknown>>;
      page: { nextCursor: string | null };
    };
    const rest = await t.http
      .get(`${adminPath(row.id, "lines")}?limit=3&cursor=${firstBody.page.nextCursor ?? ""}`)
      .set(headers);
    expectResponseToMatch("adminListSettlementLines", rest, { document: "platform" });
    const restBody = rest.body as {
      data: Array<Record<string, unknown>>;
      page: { nextCursor: string | null };
    };
    expect(restBody.page.nextCursor).toBeNull();
    const ids = [...firstBody.data, ...restBody.data].map((line) => line["id"]);
    expect(ids).toEqual((await storedLines(row.id)).map((line) => line.id));
    expect(ids).toHaveLength(lines.length);
    // The carry-forward line is on the first day of the month, before the charges.
    expect(firstBody.data[0]).toMatchObject({
      type: "carry_forward",
      occurredAt: "2026-10-01T00:00:00.000Z",
      amount: { amount: "-12.00", currency: "EUR" },
      balanceTransactionId: null,
      createdByAccountId: null,
    });
    expect(firstBody.data[1]).toMatchObject({
      type: "charge",
      amount: { amount: "1000.00", currency: "EUR" },
      stripeFee: { amount: "29.25", currency: "EUR" },
      originalAmount: null,
    });

    const unknown = await t.http.get(adminPath(testId("stl", 999_998))).set(headers);
    const unknownLines = await t.http.get(adminPath(testId("stl", 999_998), "lines")).set(headers);
    const foreignCursor = await t.http
      .get(`${adminPath(september.row.id, "lines")}?cursor=${firstBody.page.nextCursor ?? ""}`)
      .set(headers);
    expect([unknown, unknownLines, foreignCursor].map(outcomeOf)).toEqual([
      "404 NOT_FOUND",
      "404 NOT_FOUND",
      "400 VALIDATION_FAILED",
    ]);
    expectResponseToMatch("adminGetSettlement", unknown, { document: "platform" });
    expectResponseToMatch("adminListSettlementLines", foreignCursor, { document: "platform" });
  });

  it("[PBE-060 AC2] downloads the lines as the admin's CSV, never cached", async () => {
    const f = await fixture();
    const { row } = await statement(f.tenant, {
      month: 10,
      lines: [
        ...OCTOBER_LINES,
        { type: "adjustment", amount: "-10.00", description: "=fee correction, see the note" },
      ],
    });
    const headers = await adminHeaders(false);

    const res = await t.http.get(adminPath(row.id, "lines.csv")).set(headers);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="velexis-settlement-${f.tenant.key}-2026-10-EUR.csv"`,
    );
    const lineRows = (await storedLines(row.id)) as unknown as SettlementCsvLine[];
    expect(res.text).toBe(adminSettlementCsv(lineRows));
    expect(res.text.split("\r\n")[0]).toBe(
      "id,type,occurredAt,amount,stripeFee,originalAmount,originalCurrency,balanceTransactionId,sourceId," +
        "paymentIntentId,velexisPaymentId,checkoutId,description,createdByAccountId",
    );
    expect(res.text).toContain(",-100.00,0.00,");
    expect(res.text).toContain(`,"'=fee correction, see the note",`);

    const unknown = await t.http.get(adminPath(testId("stl", 999_997), "lines.csv")).set(headers);
    expect(outcomeOf(unknown)).toBe("404 NOT_FOUND");
    expectResponseToMatch("adminDownloadSettlementLines", unknown, { document: "platform" });
  });
});

// ---- The portal ---------------------------------------------------------------------------------------------------

describe("the portal's statements", () => {
  /** An OTA with a statement of each status, and another OTA's approved statement. */
  async function statements(): Promise<{
    readonly f: Fixture;
    readonly byStatus: Record<string, PlatformRow<"settlements">>;
    readonly foreign: PlatformRow<"settlements">;
  }> {
    const f = await fixture();
    const byStatus = {
      draft: (await statement(f.tenant, { month: 10, lines: OCTOBER_LINES })).row,
      voided: (await statement(f.tenant, { month: 10, status: "void", currency: "USD" })).row,
      approved: (await statement(f.tenant, { month: 9, status: "approved", lines: OCTOBER_LINES })).row,
      paid: (await statement(f.tenant, { month: 8, status: "paid", lines: OCTOBER_LINES })).row,
      carried: (await statement(f.tenant, { month: 7, status: "carried_forward" })).row,
    };
    const other = await fixture();
    const foreign = (await statement(other.tenant, { month: 9, status: "approved", lines: OCTOBER_LINES }))
      .row;
    return { f, byStatus, foreign };
  }

  it("[PBE-060 AC2] lists the approved, paid and carried-forward statements to owners and finance, never a draft", async () => {
    const { f, byStatus } = await statements();
    const path = `/v1/tenants/${f.tenant.id}/settlements`;

    for (const who of ["owner", "finance"] as const) {
      const res = await t.http.get(path).set(await portal(f, who));
      expect(res.status).toBe(200);
      expectResponseToMatch("listSettlements", res, { document: "platform" });
      expect(res.body).toEqual({
        data: [byStatus["approved"], byStatus["paid"], byStatus["carried"]].map((row) => ({
          id: row?.id,
          periodStart: row?.period_start.toISOString(),
          periodEnd: row?.period_end.toISOString(),
          currency: "EUR",
          status: row?.status,
          netAmount: { amount: row?.net_amount, currency: "EUR" },
          paidAt: row?.paid_at === null || row?.paid_at === undefined ? null : row.paid_at.toISOString(),
        })),
      });
    }
    const others: string[] = [];
    for (const who of ["admin", "agent", "viewer", "stranger", "removedFinance"] as const) {
      const res = await t.http.get(path).set(await portal(f, who));
      expectResponseToMatch("listSettlements", res, { document: "platform" });
      others.push(outcomeOf(res));
    }
    expect(others).toEqual([
      "403 FORBIDDEN",
      "403 FORBIDDEN",
      "403 FORBIDDEN",
      "404 NOT_FOUND",
      "404 NOT_FOUND",
    ]);
  });

  it("[PBE-060 AC2] answers a visible statement's totals and 404 for a draft, a voided draft or another OTA's", async () => {
    const { f, byStatus, foreign } = await statements();
    const get = async (id: string, who: Who = "owner") =>
      t.http.get(`/v1/tenants/${f.tenant.id}/settlements/${id}`).set(await portal(f, who));

    const paid = await get(byStatus["paid"]?.id ?? "", "finance");
    expect(paid.status).toBe(200);
    expectResponseToMatch("getSettlement", paid, { document: "platform" });
    const row = byStatus["paid"] as PlatformRow<"settlements">;
    expect(paid.body).toEqual({
      id: row.id,
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      currency: "EUR",
      status: "paid",
      netAmount: { amount: row.net_amount, currency: "EUR" },
      paidAt: row.paid_at?.toISOString(),
      grossAmount: { amount: "1500.00", currency: "EUR" },
      refundsAmount: { amount: "100.00", currency: "EUR" },
      disputesAmount: { amount: "0.00", currency: "EUR" },
      stripeFeesAmount: { amount: "44.75", currency: "EUR" },
      velexisFeesAmount: { amount: "0.00", currency: "EUR" },
      adjustmentsAmount: { amount: "0.00", currency: "EUR" },
      feeBps: 0,
      lineCount: 3,
      payoutReference: "VX-EARLIER-PAYMENT",
      notes: null,
    });

    const hidden = [
      await get(byStatus["draft"]?.id ?? ""),
      await get(byStatus["voided"]?.id ?? ""),
      await get(foreign.id),
      await get(testId("stl", 999_996)),
      await get(byStatus["approved"]?.id ?? "", "viewer"),
    ];
    expect(hidden.map(outcomeOf)).toEqual([
      "404 NOT_FOUND",
      "404 NOT_FOUND",
      "404 NOT_FOUND",
      "404 NOT_FOUND",
      "403 FORBIDDEN",
    ]);
    for (const res of hidden) {
      expectResponseToMatch("getSettlement", res, { document: "platform" });
    }
  });

  it("[PBE-060 AC2] downloads a statement's lines as CSV with the documented columns, never a draft's", async () => {
    const { f, byStatus, foreign } = await statements();
    const csv = async (id: string, who: Who = "owner") =>
      t.http.get(`/v1/tenants/${f.tenant.id}/settlements/${id}/lines.csv`).set(await portal(f, who));
    const approved = byStatus["approved"] as PlatformRow<"settlements">;

    for (const who of ["owner", "finance"] as const) {
      const res = await csv(approved.id, who);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="velexis-statement-2026-09-EUR.csv"',
      );
      const records = res.text.split("\r\n");
      expect(records[0]?.split(",")).toEqual([...PORTAL_SETTLEMENT_CSV_COLUMNS]);
      expect(records[0]).toBe(
        "type,occurredAt,amount,stripeFee,paymentIntentId,velexisPaymentId,checkoutId,description",
      );
      expect(records).toHaveLength(5);
      expect(res.text).toBe(
        portalSettlementCsv((await storedLines(approved.id)) as unknown as SettlementCsvLine[]),
      );
      expect(records[3]).toMatch(/^refund,2026-09-09T12:00:00\.000Z,-100\.00,0\.00,pi_PBE060/);
      // The portal's file never names a balance transaction or who added a line.
      expect(res.text).not.toContain("txn_");
    }

    const hidden = [
      await csv(byStatus["draft"]?.id ?? ""),
      await csv(byStatus["voided"]?.id ?? ""),
      await csv(foreign.id),
      await csv(approved.id, "agent"),
    ];
    expect(hidden.map(outcomeOf)).toEqual([
      "404 NOT_FOUND",
      "404 NOT_FOUND",
      "404 NOT_FOUND",
      "403 FORBIDDEN",
    ]);
    for (const res of hidden) {
      expectResponseToMatch("downloadSettlementLines", res, { document: "platform" });
    }
  });

  it("[PBE-060 AC2] shows a statement once an admin approved it, with the payment once it is paid", async () => {
    const f = await fixture();
    await payoutAccount(f.tenant.id, "verified");
    const { row } = await statement(f.tenant, { month: 10, lines: OCTOBER_LINES });
    const list = async () =>
      (await t.http.get(`/v1/tenants/${f.tenant.id}/settlements`).set(await portal(f, "owner"))).body as {
        data: Array<{ id: string; status: string; paidAt: string | null }>;
      };

    expect((await list()).data).toEqual([]);
    const approved = await approve(row.id, etag(row.version));
    expect((await list()).data).toEqual([
      expect.objectContaining({ id: row.id, status: "approved", paidAt: null }),
    ]);
    await markPaid(row.id, approved.headers["etag"] as string, {
      paidAt: "2026-11-09T00:00:00Z",
      payoutReference: BANK_REFERENCE,
    });
    expect((await list()).data).toEqual([
      expect.objectContaining({ id: row.id, status: "paid", paidAt: "2026-11-09T00:00:00.000Z" }),
    ]);
  });
});
