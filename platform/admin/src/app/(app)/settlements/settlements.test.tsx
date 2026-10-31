// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { components } from "@velexis/api-types/platform";
import Link from "next/link";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks: the request scope, navigation and cache of Next.js and the configuration; the real API client talks ----
// ---- to an in-memory platform behind a mocked fetch, so the tests see every call the pages, actions and routes ----
// ---- send, and the pages show what the platform holds after each action (as a revalidation would) ----------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

const navigation = vi.hoisted(() => ({
  pathname: "/",
  searchParams: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() },
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
  redirect: navigation.redirect,
  notFound: navigation.notFound,
}));

const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => nextCache);

const settings = vi.hoisted(() => ({
  APP_ENV: "test" as const,
  PLATFORM_API_URL: "http://127.0.0.1:3100",
  PLATFORM_BFF_KEY: "test_bff_key_0123456789abcdef_0123456789",
}));
vi.mock("@/lib/config", () => ({ getConfig: () => settings }));

import { addSettlementAdjustment, voidSettlement } from "@/app/(app)/settlements/[settlementId]/actions";
import {
  MINOR_UNITS_OTHER_THAN_TWO,
  adjustmentDecimals,
  amountProblem,
} from "@/app/(app)/settlements/[settlementId]/adjustment-amount";
import {
  GET as linesCsv,
  HEAD as linesCsvHead,
} from "@/app/(app)/settlements/[settlementId]/lines.csv/route";
import SettlementPage from "@/app/(app)/settlements/[settlementId]/page";
import { SettlementActions } from "@/app/(app)/settlements/[settlementId]/settlement-actions";
import { generateSettlements } from "@/app/(app)/settlements/actions";
import { GenerateDraftsForm } from "@/app/(app)/settlements/generate-drafts-form";
import SettlementsPage from "@/app/(app)/settlements/page";
import { AssignOfficeForm } from "@/app/(app)/tenants/[tenantId]/assign-office-form";
import { ConnectionStatusForm } from "@/app/(app)/tenants/[tenantId]/connection-status-form";
import { NotesForm } from "@/app/(app)/tenants/[tenantId]/notes-form";
import TenantDetailPage from "@/app/(app)/tenants/[tenantId]/page";
import { PayoutAccountPanel } from "@/app/(app)/tenants/[tenantId]/payout-account";
import { revealPayoutAccount } from "@/app/(app)/tenants/[tenantId]/payout-actions";
import { MigrateForm, SuspendResumeForm } from "@/app/(app)/tenants/[tenantId]/suspend-form";
import { TenantTabs } from "@/app/(app)/tenants/[tenantId]/tabs";
import { FilterBar } from "@/components/filter-bar";
import { REVEAL_DURATION_MS } from "@/components/reveal-panel";
import * as tableComponents from "@/components/ui/table";
import { BFF_KEY_HEADER, END_USER_AGENT_HEADER, END_USER_IP_HEADER } from "@/lib/end-user";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session";
import {
  GENERATE_SETTLEMENTS_STRINGS as G,
  PAYOUT_ACCOUNT_STRINGS as P,
  REASON_STRINGS,
  REVEAL_STRINGS,
  SETTLEMENT_ACTION_STRINGS as A,
  SETTLEMENT_DETAIL_STRINGS as D,
  SETTLEMENT_LIST_STRINGS as L,
  STEP_UP_STRINGS,
  TABLE_STRINGS,
  TENANT_TAB_LABELS,
} from "@/lib/strings";

// ---- Builders (dummy values only: no real token, key, account or bank number) ----------------------------------------

type Schemas = components["schemas"];
type AdminSettlement = Schemas["AdminSettlement"];
type SettlementLine = Schemas["AdminSettlementLine"];
type PayoutAccount = Schemas["PayoutAccount"];

const ACCESS_TOKEN = "pad013-dummy-admin-access-token";
const FORWARDED_FOR = "198.51.100.23, 203.0.113.7";
const USER_AGENT = "Mozilla/5.0 (PAD-013 test)";
const SELF_ID = "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9";
const TENANT_ID = "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F";
/** The EUR draft of the review path: positive net, three lines. */
const DRAFT_ID = "stl_01JD9W3Y7A1C5E9G3J7M1Q5S9V";
/** A draft with a negative net, carried forward when approved. */
const NEGATIVE_ID = "stl_01JD9W4Z8B2D6F0H4K8N2Q6T0W";
/** A JPY draft: the yen has no minor unit. */
const JPY_ID = "stl_01JD9W5A9C3E7G1J5M9P3S7V1X";
const APPROVED_ID = "stl_01JE0A1B2C3D4E5F6G7H8J9K0M";
const PAID_ID = "stl_01JC7T1V5X9Z3B7D1F5H9K3N7Q";
const VOID_ID = "stl_01JE0B2C3D4E5F6G7H8J9K0M1N";
const CARRIED_ID = "stl_01JE0C3D4E5F6G7H8J9K0M1N2P";
const UNKNOWN_ID = "stl_01JE0D4E5F6G7H8J9K0M1N2P3Q";
const TOTP_CODE = "492039";
const REASON = "Agreed with Acme's finance contact on the phone (SUP-512).";
/** The example IBAN and BIC of the platform document; never a real account. */
const IBAN = "NO9386011117947";
const IBAN_GROUPED = "NO93 8601 1117 947";
const BIC = "DNBANOKK";

/**
 * The budget of the warm-up hook: the first render of these pages in a fresh worker loads the module graph of the
 * tables, the tabs, the filter bar and the dialogs, and the first server action runs React's action queue for the first
 * time. On a loaded runner that takes seconds; the hook only stops one that hangs.
 */
const WARM_UP_TIMEOUT_MS = 30_000;

/**
 * How long a step that runs a server action (a round trip through the real `lib/api.ts`) and re-renders the forms may
 * take. Testing Library's 1 s default is enough on an idle machine, not on a loaded CI runner; each test's own 5 s
 * budget is unchanged.
 */
const UI_WAIT = { timeout: 3_000 } as const;

const money = (amount: string, currency = "EUR"): Schemas["Money"] => ({ amount, currency });

function statement(overrides: Partial<AdminSettlement> = {}): AdminSettlement {
  const currency = overrides.currency ?? "EUR";
  return {
    id: DRAFT_ID,
    tenantId: TENANT_ID,
    tenantKey: "acme",
    tenantName: "Acme Travel",
    environment: "live",
    periodStart: "2027-02-01T00:00:00Z",
    periodEnd: "2027-03-01T00:00:00Z",
    currency,
    status: "draft",
    netAmount: money("11204.87", currency),
    lineCount: 3,
    generatedAt: "2027-03-03T05:00:41Z",
    approvedAt: null,
    paidAt: null,
    version: 1,
    grossAmount: money("11800.00", currency),
    refundsAmount: money("150.00", currency),
    disputesAmount: money("0.00", currency),
    stripeFeesAmount: money("212.13", currency),
    velexisFeesAmount: money("233.00", currency),
    adjustmentsAmount: money("0.00", currency),
    feeBps: 200,
    payoutReference: null,
    notes: null,
    carriedToId: null,
    approvedByAccountId: null,
    paidByAccountId: null,
    voidedAt: null,
    voidReason: null,
    payoutAccountStatus: null,
    createdAt: "2027-03-03T05:00:41Z",
    updatedAt: "2027-03-03T05:00:41Z",
    ...overrides,
  };
}

function line(id: string, overrides: Partial<SettlementLine> = {}): SettlementLine {
  return {
    id,
    type: "charge",
    occurredAt: "2027-02-03T10:22:41Z",
    amount: money("1180.00"),
    stripeFee: money("17.40"),
    originalAmount: null,
    balanceTransactionId: "txn_3QFebCharge01",
    sourceId: "ch_3QFebCharge01",
    paymentIntentId: "pi_3QFebCharge01",
    velexisPaymentId: "pay_01JD2K7M1P5R9T3W7Y1A5C9E3G",
    checkoutId: "chk_01JD2K6K0N4Q8S2V6X0Z4B8D2F",
    description: "Booking 9K2M4X OSL-LHR",
    createdByAccountId: null,
    ...overrides,
  };
}

function draftLines(): SettlementLine[] {
  return [
    line("sln_01JD9X1B2C3D4E5F6G7H8J9K0M"),
    line("sln_01JD9X2C3D4E5F6G7H8J9K0M1N", {
      occurredAt: "2027-02-09T16:40:03Z",
      amount: money("412.37"),
      stripeFee: money("6.43"),
      originalAmount: money("4790.00", "NOK"),
      balanceTransactionId: "txn_3QFebCharge02",
      sourceId: "ch_3QFebCharge02",
      paymentIntentId: "pi_3QFebCharge02",
      description: "Booking 4R8T1Z OSL-CPH",
    }),
    line("sln_01JD9X3D4E5F6G7H8J9K0M1N2P", {
      type: "refund",
      occurredAt: "2027-02-11T08:05:59Z",
      amount: money("-150.00"),
      stripeFee: money("0.00"),
      balanceTransactionId: "txn_3QFebRefund01",
      sourceId: "re_3QFebRefund01",
      description: "Partial refund of booking 9K2M4X",
    }),
  ];
}

function payoutAccount(overrides: Partial<PayoutAccount> = {}): PayoutAccount {
  return {
    accountHolderName: "Acme Travel AS",
    countryCode: "NO",
    currency: "NOK",
    scheme: "iban",
    last4: "7947",
    status: "pending_review",
    reviewNote: null,
    updatedAt: "2027-01-20T08:12:44Z",
    version: 3,
    ...overrides,
  };
}

function tenantDetail(): Schemas["AdminTenantDetail"] {
  return {
    tenant: {
      id: TENANT_ID,
      key: "acme",
      name: "Acme Travel",
      legalName: "Acme Travel AS",
      status: "active",
      suspensionReason: null,
      suspendedAt: null,
      billingNotice: null,
      planCode: "early_access",
      defaultCurrency: "EUR",
      countryCode: "NO",
      timeZone: "Europe/Oslo",
      supportEmail: "support@acme-travel.example.com",
      storefrontEnvironment: "live",
      liveEnabledAt: "2026-12-01T09:00:00Z",
      primaryHost: "acme.ota.example.com",
      schemaVersion: "0001_baseline",
      notes: null,
      createdAt: "2026-10-14T08:20:11Z",
      activatedAt: "2026-10-14T08:20:16Z",
      version: 3,
    },
    members: [],
    invitations: [],
    subscription: null,
    amadeusConnections: [],
    paymentConnections: [],
    domains: [],
    recentJobs: [],
    recentAudit: [],
  };
}

// ---- Money of the in-memory platform (decimal strings with two decimals, counted in cents) ---------------------------

function cents(amount: string): bigint {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = amount.replace(/^-/, "").split(".");
  const value = BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  return negative ? -value : value;
}

function decimal(value: bigint): string {
  const negative = value < 0n;
  const size = negative ? -value : value;
  return `${negative ? "-" : ""}${size / 100n}.${String(size % 100n).padStart(2, "0")}`;
}

// ---- The in-memory platform ------------------------------------------------------------------------------------------

interface Platform {
  settlements: Map<string, AdminSettlement>;
  lines: Map<string, SettlementLine[]>;
  payout: PayoutAccount | null;
  /** A TOTP step-up in the last 15 minutes. */
  steppedUp: boolean;
  /** The list answers a next page (`nextCursor`). */
  listHasMore: boolean;
  /** The lines the platform answers per page (smaller than the page's limit, so two pages are few lines). */
  linesPerPage: number;
  overrides: Record<string, Route>;
}

type Route = (request: Request) => Response | Promise<Response>;

let platform: Platform;

function freshPlatform(): Platform {
  const settlements = [
    statement(),
    statement({
      id: NEGATIVE_ID,
      netAmount: money("-415.80"),
      grossAmount: money("2400.00"),
      refundsAmount: money("0.00"),
      disputesAmount: money("2715.00"),
      stripeFeesAmount: money("52.80"),
      velexisFeesAmount: money("48.00"),
      lineCount: 0,
    }),
    statement({
      id: JPY_ID,
      currency: "JPY",
      netAmount: money("120000.00", "JPY"),
      grossAmount: money("124000.00", "JPY"),
      refundsAmount: money("0.00", "JPY"),
      disputesAmount: money("0.00", "JPY"),
      stripeFeesAmount: money("1520.00", "JPY"),
      velexisFeesAmount: money("2480.00", "JPY"),
      adjustmentsAmount: money("0.00", "JPY"),
      lineCount: 0,
    }),
    statement({
      id: APPROVED_ID,
      periodStart: "2027-01-01T00:00:00Z",
      periodEnd: "2027-02-01T00:00:00Z",
      status: "approved",
      approvedAt: "2027-02-05T10:02:11Z",
      approvedByAccountId: SELF_ID,
      lineCount: 0,
      version: 2,
    }),
    statement({
      id: PAID_ID,
      periodStart: "2026-12-01T00:00:00Z",
      periodEnd: "2027-01-01T00:00:00Z",
      status: "paid",
      approvedAt: "2027-01-05T10:02:11Z",
      paidAt: "2027-01-07T00:00:00Z",
      payoutReference: "VX-SETTLE-2026-12-ACME",
      lineCount: 0,
      version: 3,
    }),
    statement({
      id: VOID_ID,
      status: "void",
      voidedAt: "2027-03-04T09:20:44Z",
      voidReason: "Generated before the balance transactions were complete.",
      lineCount: 0,
      version: 2,
    }),
    statement({
      id: CARRIED_ID,
      periodStart: "2026-11-01T00:00:00Z",
      periodEnd: "2026-12-01T00:00:00Z",
      status: "carried_forward",
      netAmount: money("-89.48"),
      approvedAt: "2026-12-05T10:02:11Z",
      lineCount: 0,
      version: 2,
    }),
  ];
  return {
    settlements: new Map(settlements.map((row) => [row.id, row])),
    lines: new Map([[DRAFT_ID, draftLines()]]),
    payout: payoutAccount({ status: "verified" }),
    steppedUp: false,
    listHasMore: false,
    linesPerPage: 2,
    overrides: {},
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An error envelope of the platform API; its `message` must never reach the page. */
function apiError(
  code: string,
  status: number,
  extra: { details?: Record<string, unknown>; fieldErrors?: unknown[] } = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      error: {
        code,
        message: "The API's own text, never shown",
        status,
        requestId: "req_api_pad013",
        ...extra,
      },
    },
    status,
    headers,
  );
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const text = await request.clone().text();
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** A reason as `AdminReason` takes it: 5–500 characters once trimmed. */
function validReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 5 && value.trim().length <= 500;
}

/** The answer of a settlement read or write: the statement with the payout account's status and its `ETag`. */
function settlementAnswer(row: AdminSettlement): Response {
  const answer = { ...row, payoutAccountStatus: platform.payout?.status ?? null };
  return json(answer, 200, { etag: `"${row.version}"` });
}

/** Stores a changed statement with its version raised. */
function store(row: AdminSettlement, changes: Partial<AdminSettlement>): AdminSettlement {
  const next = { ...row, ...changes, version: row.version + 1, updatedAt: "2027-03-04T09:00:00Z" };
  platform.settlements.set(row.id, next);
  return next;
}

function summaryOf(row: AdminSettlement): Schemas["AdminSettlementSummary"] {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantKey: row.tenantKey,
    tenantName: row.tenantName,
    environment: row.environment,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    currency: row.currency,
    status: row.status,
    netAmount: row.netAmount,
    lineCount: row.lineCount,
    generatedAt: row.generatedAt,
    approvedAt: row.approvedAt,
    paidAt: row.paidAt,
    version: row.version,
  };
}

/** Whether `periodStart` names a month that has ended now (UTC), as the API checks it. */
function monthEnded(periodStart: string): boolean {
  const now = new Date();
  return Date.parse(periodStart) < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** Answers one call as the platform API would. */
async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const key = `${request.method} ${path}`;
  const override = platform.overrides[key];
  if (override !== undefined) {
    return override(request);
  }
  const ifMatch = request.headers.get("if-match");

  if (key === "POST /v1/admin/auth/step-up") {
    const body = await bodyOf(request);
    if (body["code"] !== TOTP_CODE) {
      return apiError("MFA_CODE_INVALID", 400);
    }
    platform.steppedUp = true;
    return json(
      {
        accessToken: "pad013-stepped-up-access-token",
        accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        refreshToken: "pad013-stepped-up-refresh-token",
        refreshTokenExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        admin: { id: SELF_ID, email: "lena.holm@velexis.example.com", fullName: "Lena Holm" },
      },
      200,
    );
  }

  if (key === "GET /v1/admin/settlements") {
    const query = url.searchParams;
    const rows = [...platform.settlements.values()].filter(
      (row) =>
        (query.get("status") === null || row.status === query.get("status")) &&
        (query.get("periodStart") === null || row.periodStart === query.get("periodStart")) &&
        (query.get("tenantId") === null || row.tenantId === query.get("tenantId")),
    );
    if (query.get("cursor") === "stale") {
      return apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "never shown" }],
      });
    }
    return json(
      {
        data: rows.map(summaryOf),
        page: {
          nextCursor: platform.listHasMore && query.get("cursor") === null ? "c2xuXzI" : null,
          limit: 50,
        },
      },
      200,
    );
  }

  if (key === "POST /v1/admin/settlements/generate") {
    const body = await bodyOf(request);
    const periodStart = typeof body["periodStart"] === "string" ? body["periodStart"] : "";
    if (!/^[0-9]{4}-(0[1-9]|1[0-2])-01T00:00:00Z$/.test(periodStart) || !monthEnded(periodStart)) {
      return apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/periodStart", code: "period_not_closed", message: "never shown" }],
      });
    }
    if (body["tenantId"] !== undefined && body["tenantId"] !== TENANT_ID) {
      return apiError("NOT_FOUND", 404);
    }
    // As the API sends it: an empty body with `Content-Length: 0`.
    return new Response(null, { status: 202, headers: { "content-length": "0" } });
  }

  const payoutMatch = /^\/v1\/admin\/tenants\/(ten_[0-9A-Z]{26})\/payout-account(\/reveal|\/review)?$/.exec(
    path,
  );
  if (payoutMatch !== null) {
    const [, tenantId, action] = payoutMatch;
    const account = tenantId === TENANT_ID ? platform.payout : null;
    if (account === null) {
      return apiError("NOT_FOUND", 404);
    }
    if (request.method === "GET" && action === undefined) {
      return json(account, 200, { etag: `"${account.version}"` });
    }
    const body = await bodyOf(request);
    if (request.method === "POST" && action === "/reveal") {
      if (!platform.steppedUp) {
        return apiError("REAUTH_REQUIRED", 401);
      }
      if (!validReason(body["reason"])) {
        return apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/reason", code: "minLength" }] });
      }
      return json({ iban: IBAN, bic: BIC }, 200, { "cache-control": "no-store" });
    }
    if (request.method === "POST" && action === "/review") {
      if (ifMatch !== `"${account.version}"`) {
        return apiError("PRECONDITION_FAILED", 412);
      }
      const decision = body["decision"];
      const note = typeof body["note"] === "string" ? body["note"] : null;
      if (decision !== "verified" && !(decision === "rejected" && note !== null && note.trim() !== "")) {
        return apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/note", code: "blank" }] });
      }
      const reviewed: PayoutAccount = {
        ...account,
        status: decision,
        reviewNote: decision === "rejected" ? note : null,
        version: account.version + 1,
      };
      platform.payout = reviewed;
      return json(reviewed, 200, { etag: `"${reviewed.version}"` });
    }
  }

  const settlementMatch = /^\/v1\/admin\/settlements\/(stl_[0-9A-Z]{26})(\/[a-z.-]+)?$/.exec(path);
  if (settlementMatch !== null) {
    const [, settlementId = "", action] = settlementMatch;
    const row = platform.settlements.get(settlementId);
    if (row === undefined) {
      return apiError("NOT_FOUND", 404);
    }
    if (request.method === "GET" && action === undefined) {
      return settlementAnswer(row);
    }
    if (request.method === "GET" && action === "/lines") {
      const all = platform.lines.get(settlementId) ?? [];
      const cursor = url.searchParams.get("cursor");
      const start = cursor === null ? 0 : all.findIndex((item) => item.id === cursor) + 1;
      if (cursor !== null && start === 0) {
        return apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [{ path: "/query/cursor", code: "cursor" }],
        });
      }
      const page = all.slice(start, start + platform.linesPerPage);
      const last = page.at(-1);
      return json(
        {
          data: page,
          page: {
            nextCursor: last !== undefined && start + page.length < all.length ? last.id : null,
            limit: Number(url.searchParams.get("limit") ?? 50),
          },
        },
        200,
      );
    }
    if (request.method === "GET" && action === "/lines.csv") {
      return new Response("id,type\nsln_01JD9X1B2C3D4E5F6G7H8J9K0M,charge\n", {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="velexis-settlement-acme-2027-02-EUR.csv"',
          "cache-control": "no-store",
        },
      });
    }
    const body = await bodyOf(request);
    if (request.method === "POST" && action === "/adjustments") {
      if (!validReason(body["reason"])) {
        return apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/reason", code: "minLength" }] });
      }
      if (row.status !== "draft") {
        return apiError("SETTLEMENT_STATE_INVALID", 409, { details: { status: row.status } });
      }
      const amount = body["amount"] as { amount: string; currency: string };
      if (amount.currency !== row.currency) {
        return apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [{ path: "/amount/currency", code: "currency" }],
        });
      }
      const lineId = `sln_01JE${String(platform.lines.get(settlementId)?.length ?? 0).padStart(22, "0")}`;
      platform.lines.set(settlementId, [
        ...(platform.lines.get(settlementId) ?? []),
        line(lineId, {
          type: "adjustment",
          occurredAt: "2027-03-04T08:51:17Z",
          amount: money(decimal(cents(amount.amount)), row.currency),
          stripeFee: money("0.00", row.currency),
          balanceTransactionId: null,
          sourceId: null,
          paymentIntentId: null,
          velexisPaymentId: null,
          checkoutId: null,
          description: String(body["description"]),
          createdByAccountId: SELF_ID,
        }),
      ]);
      const next = store(row, {
        adjustmentsAmount: money(
          decimal(cents(row.adjustmentsAmount.amount) + cents(amount.amount)),
          row.currency,
        ),
        netAmount: money(decimal(cents(row.netAmount.amount) + cents(amount.amount)), row.currency),
        lineCount: row.lineCount + 1,
      });
      return settlementAnswer(next);
    }
    if (request.method === "POST" && (action === "/approve" || action === "/mark-paid")) {
      if (!platform.steppedUp) {
        return apiError("REAUTH_REQUIRED", 401);
      }
      if (ifMatch !== `"${row.version}"`) {
        return apiError("PRECONDITION_FAILED", 412);
      }
      const positive = cents(row.netAmount.amount) > 0n;
      if (action === "/approve") {
        if (row.status !== "draft") {
          return apiError("SETTLEMENT_STATE_INVALID", 409, { details: { status: row.status } });
        }
        if (positive && platform.payout?.status !== "verified") {
          return apiError("PAYOUT_ACCOUNT_REQUIRED", 422);
        }
        return settlementAnswer(
          store(row, {
            status: positive ? "approved" : "carried_forward",
            approvedAt: "2027-03-04T09:12:30Z",
            approvedByAccountId: SELF_ID,
          }),
        );
      }
      if (row.status !== "approved") {
        return apiError("SETTLEMENT_STATE_INVALID", 409, { details: { status: row.status } });
      }
      if (platform.payout?.status !== "verified") {
        return apiError("PAYOUT_ACCOUNT_REQUIRED", 422);
      }
      return settlementAnswer(
        store(row, {
          status: "paid",
          paidAt: String(body["paidAt"]),
          payoutReference: String(body["payoutReference"]).trim(),
          paidByAccountId: SELF_ID,
        }),
      );
    }
    if (request.method === "POST" && action === "/void") {
      if (!validReason(body["reason"])) {
        return apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/reason", code: "minLength" }] });
      }
      if (row.status !== "draft") {
        return apiError("SETTLEMENT_STATE_INVALID", 409, { details: { status: row.status } });
      }
      platform.lines.delete(settlementId);
      return settlementAnswer(
        store(row, {
          status: "void",
          voidedAt: "2027-03-04T09:20:44Z",
          voidReason: String(body["reason"]),
          lineCount: 0,
        }),
      );
    }
  }

  if (key === `GET /v1/admin/tenants/${TENANT_ID}`) {
    return json(tenantDetail(), 200);
  }
  throw new Error(`unexpected call ${request.method} ${request.url}`);
}

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

/** The calls of `METHOD /path` so far. */
function calls(method: string, path: string): Request[] {
  return fetchMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.method === method && new URL(input.url).pathname === path);
}

/** The JSON bodies of the calls of `METHOD /path` so far (`null` for a call without a body). */
async function bodies(method: string, path: string): Promise<unknown[]> {
  return Promise.all(
    calls(method, path).map(async (request) => {
      const text = await request.clone().text();
      return text === "" ? null : (JSON.parse(text) as unknown);
    }),
  );
}

function sortedQuery(search: string): [string, string][] {
  return [...new URLSearchParams(search).entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Every call carries the admin session and the end-user headers of PADR-0019. */
function expectSessionHeaders(request: Request | undefined): void {
  expect(request?.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request?.headers.get(END_USER_IP_HEADER)).toBe("203.0.113.7");
  expect(request?.headers.get(END_USER_AGENT_HEADER)).toBe(USER_AGENT);
  expect(request?.headers.get(BFF_KEY_HEADER)).toBe(settings.PLATFORM_BFF_KEY);
}

/** The cookie store of the request; `set` records the cookies a step-up writes. */
const cookieStore = {
  get: vi.fn((name: string) => (name === ACCESS_TOKEN_COOKIE ? { name, value: ACCESS_TOKEN } : undefined)),
  has: vi.fn((name: string) => name === ACCESS_TOKEN_COOKIE),
  set: vi.fn(),
};

function resetPlatformApi(): void {
  platform = freshPlatform();
  fetchMock.mockReset();
  fetchMock.mockImplementation(answer);
  vi.stubGlobal("fetch", fetchMock);
  nextHeaders.cookies.mockReset();
  nextHeaders.headers.mockReset();
  nextHeaders.headers.mockResolvedValue(
    new Headers({
      "x-forwarded-for": FORWARDED_FOR,
      "user-agent": USER_AGENT,
      "x-request-id": "req_pad013_admin",
    }),
  );
  cookieStore.set.mockReset();
  nextHeaders.cookies.mockResolvedValue(cookieStore);
  nextCache.revalidatePath.mockReset();
  for (const method of Object.values(navigation.router)) {
    method.mockReset();
  }
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
}

// ---- Rendering and interaction ---------------------------------------------------------------------------------------

/** The page's `searchParams` as Next.js 15 passes them: a repeated parameter is an array. */
function searchParamsOf(search: string): Promise<Record<string, string | string[]>> {
  const record: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(search).entries()) {
    const current = record[name];
    record[name] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  }
  return Promise.resolve(record);
}

function setUrl(pathname: string, search = ""): void {
  navigation.pathname = pathname;
  navigation.searchParams = new URLSearchParams(search);
}

async function openList(search = ""): Promise<void> {
  setUrl("/settlements", search);
  render(await SettlementsPage({ searchParams: searchParamsOf(search) }));
}

async function settlementPage(settlementId: string, search = ""): Promise<ReactElement> {
  return SettlementPage({ params: Promise.resolve({ settlementId }), searchParams: searchParamsOf(search) });
}

/** Renders `/settlements/<id>`; `rerender` renders it again as Next.js does after an action revalidated it. */
async function openSettlement(settlementId: string, search = ""): Promise<{ rerender: () => Promise<void> }> {
  setUrl(`/settlements/${settlementId}`, search);
  const view = render(await settlementPage(settlementId, search));
  return {
    rerender: async () => {
      view.rerender(await settlementPage(settlementId, search));
    },
  };
}

/** Renders `/tenants/<id>` on its connections tab, where the payout account panel loads the account. */
async function openPayoutAccount(): Promise<HTMLElement> {
  setUrl(`/tenants/${TENANT_ID}`, "tab=connections");
  render(await TenantDetailPage({ params: Promise.resolve({ tenantId: TENANT_ID }) }));
  return screen.getByRole("region", { name: P.title });
}

function link(name: string | RegExp, container: HTMLElement = document.body): HTMLAnchorElement {
  return within(container).getByRole("link", { name }) as HTMLAnchorElement;
}

function hrefOf(element: HTMLAnchorElement): string | null {
  return element.getAttribute("href");
}

/** Submits the form of the button named `name` inside `container`, with that button as the submitter. */
function submit(name: string | RegExp, container: HTMLElement = document.body): void {
  const button = within(container).getByRole("button", { name });
  const form = button.closest("form");
  if (form === null) {
    throw new Error("The button is not in a form.");
  }
  fireEvent.submit(form, { submitter: button });
}

function region(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The status the statement's page shows (its first badge, in the statement's fields). */
function statusShown(): string | null | undefined {
  return region(D.detailsTitle).querySelector("[data-status]")?.getAttribute("data-status");
}

/** The review section of the statement's page. */
function review(): HTMLElement {
  return region(A.sectionTitle);
}

/** The notice of the action that just answered (`data-notice="done"` or `"failed"`), once it shows. */
async function notice(kind: "done" | "failed", container: HTMLElement = document.body): Promise<HTMLElement> {
  return waitFor(() => {
    const element = container.querySelector<HTMLElement>(`[data-notice="${kind}"]`);
    if (element === null) {
      throw new Error(`no ${kind} notice yet`);
    }
    return element;
  }, UI_WAIT);
}

/** Answers the step-up dialog with a code and waits until every dialog is closed. */
async function answerStepUp(): Promise<void> {
  const stepUp = await screen.findByRole("dialog", { name: STEP_UP_STRINGS.title }, UI_WAIT);
  fireEvent.change(within(stepUp).getByLabelText(STEP_UP_STRINGS.codeLabel), {
    target: { value: TOTP_CODE },
  });
  submit(STEP_UP_STRINGS.submit, stepUp);
  // The modal dialog hides the rest of the page from the accessibility tree until it closes.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), UI_WAIT);
}

/** Opens a tab with the pointer, as Radix's trigger expects (`mousedown` with the main button). */
function openTab(name: string): HTMLElement {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
  return screen.getByRole("tabpanel");
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    data.set(name, value);
  }
  return data;
}

/** The fields of the adjustment form. */
function fillAdjustment(
  values: { amount: string; description: string; reason: string },
  currency = "EUR",
): void {
  const form = within(review()).getByRole("form", { name: A.adjustmentTitle });
  fireEvent.change(within(form).getByLabelText(A.amountLabel(currency)), {
    target: { value: values.amount },
  });
  fireEvent.change(within(form).getByLabelText(A.descriptionLabel), {
    target: { value: values.description },
  });
  fireEvent.change(within(form).getByLabelText(REASON_STRINGS.label), { target: { value: values.reason } });
  submit(A.addAdjustment, form);
}

// ---- The platform document -------------------------------------------------------------------------------------------

function repositoryRoot(): string {
  let folder = process.cwd();
  while (!existsSync(join(folder, "pnpm-workspace.yaml"))) {
    const parent = dirname(folder);
    if (parent === folder) {
      throw new Error("No pnpm-workspace.yaml above the working directory.");
    }
    folder = parent;
  }
  return folder;
}

/** The lines of the platform OpenAPI document, read once by the warm-up hook (it is large). */
let platformDocument: readonly string[] = [];

/**
 * What an operation of the platform document requires of the admin (PADR-0006 items 4 and 5): `x-reason-required`
 * (a reason in the body) and `x-mfa-step-up` (a TOTP verification in the last 15 minutes), read from its block.
 */
function operationRequirements(operationId: string): { reason: boolean; stepUp: boolean } {
  const start = platformDocument.findIndex((text) => text.trim() === `operationId: ${operationId}`);
  expect(start).toBeGreaterThan(-1);
  const block: string[] = [];
  for (const text of platformDocument.slice(start + 1)) {
    // The next operation of the path, or the next path.
    if (/^\s+operationId:/.test(text) || /^ {2}\//.test(text)) {
      break;
    }
    block.push(text.trim());
  }
  return { reason: block.includes("x-reason-required: true"), stepUp: block.includes("x-mfa-step-up: true") };
}

// ---- The browser payload of the tenant page ----------------------------------------------------------------------------

/** The client components of the tenant page: Next.js sends their props, not their output, to the browser. */
const CLIENT_COMPONENTS: ReadonlySet<unknown> = new Set<unknown>([
  TenantTabs,
  Link,
  FilterBar,
  ...Object.values(tableComponents),
  SuspendResumeForm,
  MigrateForm,
  NotesForm,
  ConnectionStatusForm,
  AssignOfficeForm,
  PayoutAccountPanel,
  SettlementActions,
  GenerateDraftsForm,
]);

/** Roughly the React Server Components payload of a page (as in tenants.test.tsx): what reaches the browser. */
function serverPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(serverPayload);
  }
  if (isValidElement(value)) {
    const { type, props } = value as ReactElement<Record<string, unknown>>;
    if (typeof type === "function" && !CLIENT_COMPONENTS.has(type)) {
      return serverPayload((type as (properties: Record<string, unknown>) => unknown)(props));
    }
    return {
      type: typeof type === "string" ? type : CLIENT_COMPONENTS.has(type) ? "client" : "other",
      component: CLIENT_COMPONENTS.has(type) && typeof type === "function" ? type : undefined,
      props: serverPayload(props),
    };
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, serverPayload(entry)]));
  }
  return value;
}

/** The props of every element of `component` in a payload. */
function propsOf(payload: unknown, component: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value !== null && typeof value === "object") {
      const node = value as { component?: unknown; props?: unknown };
      if (node.component === component && node.props !== null && typeof node.props === "object") {
        found.push(node.props as Record<string, unknown>);
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(payload);
  return found;
}

// ---- Hooks -------------------------------------------------------------------------------------------------------------

/**
 * Once per file, before any test: the first render of these pages in a fresh worker (the tables, the tabs, the filter
 * bar, the dialogs) and the first server action through the real API client are the slowest steps, and on a busy CI
 * runner they would otherwise land in the first test's own five seconds. Nothing of it stays: each test gets a fresh
 * platform and an empty document.
 */
beforeAll(async () => {
  platformDocument = readFileSync(
    join(repositoryRoot(), "platform/backend/openapi/velexis-platform-api.openapi.yaml"),
    "utf8",
  ).split("\n");
  resetPlatformApi();
  await openList();
  fireEvent.click(screen.getByRole("button", { name: G.submit }));
  await screen.findByRole("alertdialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openSettlement(DRAFT_ID);
  fillAdjustment({ amount: "", description: "", reason: "" });
  fireEvent.click(within(review()).getByRole("button", { name: A.void }));
  const dialog = await screen.findByRole("dialog", {}, { timeout: WARM_UP_TIMEOUT_MS });
  fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: REASON } });
  platform.overrides[`POST /v1/admin/settlements/${DRAFT_ID}/void`] = () =>
    apiError("SETTLEMENT_STATE_INVALID", 409, { details: { status: "approved" } });
  submit(A.voidConfirm, dialog);
  await screen.findByText(A.notDraft, {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  await openPayoutAccount();
  openTab(TENANT_TAB_LABELS.connections);
  await screen.findByText(P.holder, {}, { timeout: WARM_UP_TIMEOUT_MS });
  cleanup();
  document.body.replaceChildren();
}, WARM_UP_TIMEOUT_MS);

beforeEach(resetPlatformApi);

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// ---- The adjustment amount ---------------------------------------------------------------------------------------------

describe("settlements/[settlementId]/adjustment-amount.ts: an adjustment's amount", () => {
  it("copies the exponent of every currency of reference.currencies that is not 2", () => {
    const rows = readFileSync(join(repositoryRoot(), "tools/reference-data/data/currencies.csv"), "utf8")
      .trim()
      .split("\n");
    const header = (rows[0] ?? "").split(",");
    const codeColumn = header.indexOf("code");
    const unitsColumn = header.indexOf("minor_units");
    expect(codeColumn).toBeGreaterThan(-1);
    expect(unitsColumn).toBeGreaterThan(-1);
    const expected: Record<string, number> = {};
    for (const row of rows.slice(1)) {
      const cells = row.split(",");
      const units = Number(cells[unitsColumn]);
      if (units !== 2) {
        expected[cells[codeColumn] ?? ""] = units;
      }
    }
    expect({ ...MINOR_UNITS_OTHER_THAN_TWO }).toEqual(expected);
  });

  it("takes signed amounts with no more decimals than the currency has (and the schema's two), trailing zeros aside", () => {
    expect(adjustmentDecimals("EUR")).toBe(2);
    expect(adjustmentDecimals("JPY")).toBe(0);
    expect(adjustmentDecimals("KWD")).toBe(2);
    expect(amountProblem("100.00", "EUR")).toBeUndefined();
    expect(amountProblem(" -25.5 ", "EUR")).toBeUndefined();
    expect(amountProblem("1500.00", "JPY")).toBeUndefined();
    expect(amountProblem("1500.5", "JPY")).toEqual({ kind: "decimals", decimals: 0 });
    expect(amountProblem("12.345", "EUR")).toEqual({ kind: "format" });
    expect(amountProblem("12,50", "EUR")).toEqual({ kind: "format" });
    expect(amountProblem("+12", "EUR")).toEqual({ kind: "format" });
    expect(amountProblem("12345678901", "EUR")).toEqual({ kind: "format" });
    expect(amountProblem("-0.00", "EUR")).toEqual({ kind: "zero" });
    expect(amountProblem("   ", "EUR")).toEqual({ kind: "required" });
  });
});

// ---- The statements ----------------------------------------------------------------------------------------------------

describe("settlements/page.tsx: the statements and the drafts' generation", () => {
  it("[PAD-013 AC1] lists the statements with the filters of the URL, each linking its review [PF-91]", async () => {
    await openList(`status=draft&period=2027-02&tenantId=${TENANT_ID}`);

    const [call, ...more] = calls("GET", "/v1/admin/settlements");
    expect(more).toHaveLength(0);
    expect(sortedQuery(new URL(call?.url ?? "http://x").search)).toEqual([
      ["periodStart", "2027-02-01T00:00:00Z"],
      ["status", "draft"],
      ["tenantId", TENANT_ID],
    ]);
    expectSessionHeaders(call);
    expect(screen.getByRole("heading", { level: 1, name: L.title })).toBeTruthy();
    const table = screen.getByRole("table", { name: L.caption });
    expect(hrefOf(link(DRAFT_ID, table))).toBe(`/settlements/${DRAFT_ID}`);
    expect(hrefOf(within(table).getAllByRole("link", { name: "Acme Travel" })[0] as HTMLAnchorElement)).toBe(
      `/tenants/${TENANT_ID}`,
    );
    expect(within(table).getAllByText("February 2027").length).toBeGreaterThan(0);
    expect(within(table).getByText("€11,204.87")).toBeTruthy();
    expect(within(table).getByText("-€415.80")).toBeTruthy();
    expect(within(table).queryByText(APPROVED_ID)).toBeNull();

    // The list of one OTA links the OTA and the same filters for every OTA.
    const oneTenant = document.querySelector<HTMLElement>('[data-filter="tenant"]');
    expect(oneTenant?.textContent).toContain(L.oneTenant);
    expect(hrefOf(link(L.everyTenant, oneTenant ?? document.body))).toBe(
      "/settlements?status=draft&period=2027-02",
    );

    // Another status keeps the month and the OTA, and goes into the URL.
    fireEvent.change(screen.getByRole("combobox", { name: L.statusLabel }), {
      target: { value: "approved" },
    });
    const [href] = navigation.router.push.mock.calls[0] as [string];
    expect(sortedQuery(new URL(href, "https://admin.invalid").search)).toEqual([
      ["period", "2027-02"],
      ["status", "approved"],
      ["tenantId", TENANT_ID],
    ]);
  });

  it("links the next page with the filters, and shows a notice for filters the API would refuse", async () => {
    platform.listHasMore = true;
    await openList("status=draft");
    const pages = screen.getByRole("navigation", { name: TABLE_STRINGS.paginationLabel });
    expect(hrefOf(link(TABLE_STRINGS.nextPage, pages))).toBe("/settlements?status=draft&cursor=c2xuXzI");
    cleanup();

    fetchMock.mockClear();
    for (const search of ["status=frozen", "period=2027-13", "tenantId=acme", "status=draft&status=paid"]) {
      await openList(search);
      expect(screen.getByText(L.invalidFilters)).toBeTruthy();
      expect(hrefOf(link(L.showAll))).toBe("/settlements");
      cleanup();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await openList("cursor=stale");
    expect(screen.getByText(L.invalidFilters)).toBeTruthy();
    cleanup();

    platform.overrides["GET /v1/admin/settlements"] = () => apiError("UNAUTHENTICATED", 401);
    await expect(SettlementsPage({ searchParams: searchParamsOf("") })).rejects.toThrow(
      "NEXT_REDIRECT /sign-in",
    );
  });

  it("[PAD-013 AC1] generates the drafts of a month that has ended after a confirmation, for every OTA or one", async () => {
    await openList();
    const section = region(G.title);
    const month = within(section).getByLabelText(G.monthLabel) as HTMLSelectElement;
    const period = month.value;
    const now = new Date();
    // The preselected month has ended (the month before the current one, UTC).
    expect(Date.parse(`${period}-01T00:00:00Z`)).toBeLessThan(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    expect(within(section).queryByLabelText(G.onlyTenantLabel)).toBeNull();

    fireEvent.click(within(section).getByRole("button", { name: G.submit }));
    const dialog = await screen.findByRole("alertdialog", {}, UI_WAIT);
    expect(dialog.textContent).toContain("every OTA");
    fireEvent.click(within(dialog).getByRole("button", { name: G.confirm }));
    const done = await notice("done", section);
    expect(done.textContent).toContain(G.queued(month.options[month.selectedIndex]?.textContent ?? ""));
    expect(hrefOf(link(G.showDrafts, done))).toBe(`/settlements?status=draft&period=${period}`);
    expect(await bodies("POST", "/v1/admin/settlements/generate")).toEqual([
      { periodStart: `${period}-01T00:00:00Z` },
    ]);
    expectSessionHeaders(calls("POST", "/v1/admin/settlements/generate")[0]);
    cleanup();

    // A list limited to one OTA rebuilds that OTA's drafts, unless the box is cleared.
    await openList(`tenantId=${TENANT_ID}`);
    const one = region(G.title);
    expect((within(one).getByLabelText(G.onlyTenantLabel) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(one).getByRole("button", { name: G.submit }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", {}, UI_WAIT)).getByRole("button", { name: G.confirm }),
    );
    await notice("done", one);
    expect((await bodies("POST", "/v1/admin/settlements/generate"))[1]).toEqual({
      periodStart: `${period}-01T00:00:00Z`,
      tenantId: TENANT_ID,
    });
  });

  it("shows a month the API calls open at the month field, and sends nothing for a month that has not ended", async () => {
    platform.overrides["POST /v1/admin/settlements/generate"] = () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/periodStart", code: "period_not_closed" }],
      });
    await openList();
    const section = region(G.title);
    fireEvent.click(within(section).getByRole("button", { name: G.submit }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", {}, UI_WAIT)).getByRole("button", { name: G.confirm }),
    );
    const month = within(section).getByLabelText(G.monthLabel);
    await waitFor(() => expect(month.getAttribute("aria-invalid")).toBe("true"), UI_WAIT);
    expect(within(section).getByText(G.periodNotClosed)).toBeTruthy();
    cleanup();

    fetchMock.mockClear();
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    for (const values of [
      { period: current },
      { period: "2027-13" },
      { period: "2026-01", tenantId: "acme" },
    ]) {
      const state = await generateSettlements({ status: "idle" }, formData(values));
      expect(state.status).toBe("failed");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    platform.overrides["POST /v1/admin/settlements/generate"] = () => apiError("TOKEN_EXPIRED", 401);
    await expect(generateSettlements({ status: "idle" }, formData({ period: "2026-01" }))).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: "/settlements" }).toString()}`,
    );
  });
});

// ---- One statement -------------------------------------------------------------------------------------------------------

describe("settlements/[settlementId]/page.tsx: one statement and its review", () => {
  it("shows the totals, the payout account's status, a page of lines with the next one, and the CSV download", async () => {
    await openSettlement(DRAFT_ID);

    expect(
      screen.getByRole("heading", { level: 1, name: D.heading("Acme Travel", "February 2027") }),
    ).toBeTruthy();
    const totals = region(D.totalsTitle);
    for (const shown of ["€11,800.00", "€150.00", "€212.13", "€233.00", "€11,204.87"]) {
      expect(within(totals).getByText(shown)).toBeTruthy();
    }
    expect(within(totals).getByText(D.velexisFees("2.00 %"))).toBeTruthy();
    const payout = region(D.payoutTitle);
    expect(within(payout).getByText("Verified")).toBeTruthy();
    expect(hrefOf(link(D.openPayout("Acme Travel"), payout))).toBe(`/tenants/${TENANT_ID}?tab=connections`);

    const lines = region(D.linesTitle);
    const table = within(lines).getByRole("table", { name: D.linesCaption });
    expect(within(table).getByText("Booking 9K2M4X OSL-LHR")).toBeTruthy();
    expect(within(table).getByText("NOK 4,790.00")).toBeTruthy();
    expect(within(table).queryByText("Partial refund of booking 9K2M4X")).toBeNull();
    const next = link(TABLE_STRINGS.nextPage, lines);
    expect(hrefOf(next)).toBe(`/settlements/${DRAFT_ID}?cursor=sln_01JD9X2C3D4E5F6G7H8J9K0M1N`);
    // A plain link to the route handler, never next/link, whose prefetch would download the file.
    const csv = link(D.downloadCsv, lines);
    expect(hrefOf(csv)).toBe(`/settlements/${DRAFT_ID}/lines.csv`);
    expect(csv.tagName).toBe("A");
    expectSessionHeaders(calls("GET", `/v1/admin/settlements/${DRAFT_ID}/lines`)[0]);
    cleanup();

    await openSettlement(DRAFT_ID, "cursor=sln_01JD9X2C3D4E5F6G7H8J9K0M1N");
    const second = region(D.linesTitle);
    expect(within(second).getByText("Partial refund of booking 9K2M4X")).toBeTruthy();
    expect(hrefOf(link(TABLE_STRINGS.firstPage, second))).toBe(`/settlements/${DRAFT_ID}`);
    cleanup();

    await openSettlement(DRAFT_ID, "cursor=sln_unknown");
    expect(screen.getByText(D.linesInvalid)).toBeTruthy();
  });

  it("[PAD-013 AC1] offers the actions the statement's status allows, and none once it cannot change [PF-91]", async () => {
    const expected: [string, { adjust: boolean; approve: boolean; void: boolean; paid: boolean }][] = [
      [DRAFT_ID, { adjust: true, approve: true, void: true, paid: false }],
      [APPROVED_ID, { adjust: false, approve: false, void: false, paid: true }],
      [PAID_ID, { adjust: false, approve: false, void: false, paid: false }],
      [CARRIED_ID, { adjust: false, approve: false, void: false, paid: false }],
      [VOID_ID, { adjust: false, approve: false, void: false, paid: false }],
    ];
    for (const [settlementId, offers] of expected) {
      await openSettlement(settlementId);
      const section = review();
      const status = platform.settlements.get(settlementId)?.status ?? "draft";
      expect(within(section).getByText(A.intro[status])).toBeTruthy();
      expect(within(section).queryByRole("form", { name: A.adjustmentTitle }) !== null).toBe(offers.adjust);
      expect(within(section).queryByRole("button", { name: A.approve }) !== null).toBe(offers.approve);
      expect(within(section).queryByRole("button", { name: A.void }) !== null).toBe(offers.void);
      expect(within(section).queryByRole("form", { name: A.markPaidTitle }) !== null).toBe(offers.paid);
      cleanup();
    }
  });

  it("[PAD-013 AC1] runs the review from draft to paid with the reasons and step-ups the API requires [PF-91]", async () => {
    // What each operation requires, from the platform document.
    expect(operationRequirements("adminAddSettlementAdjustment")).toEqual({ reason: true, stepUp: false });
    expect(operationRequirements("adminApproveSettlement")).toEqual({ reason: false, stepUp: true });
    expect(operationRequirements("adminMarkSettlementPaid")).toEqual({ reason: false, stepUp: true });
    expect(operationRequirements("adminVoidSettlement")).toEqual({ reason: true, stepUp: false });
    const path = `/v1/admin/settlements/${DRAFT_ID}`;
    const view = await openSettlement(DRAFT_ID);

    // 1. An adjustment with its reason (trimmed), no step-up.
    fillAdjustment({
      amount: "100.00",
      description: " Goodwill credit for the outage ",
      reason: `  ${REASON}  `,
    });
    expect((await notice("done", review())).textContent).toContain(A.added);
    expect(await bodies("POST", `${path}/adjustments`)).toEqual([
      {
        amount: { amount: "100.00", currency: "EUR" },
        description: "Goodwill credit for the outage",
        reason: REASON,
      },
    ]);
    expectSessionHeaders(calls("POST", `${path}/adjustments`)[0]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/settlements/${DRAFT_ID}`);
    await view.rerender();
    expect(within(region(D.totalsTitle)).getByText("€11,304.87")).toBeTruthy();
    expect(within(region(D.detailsTitle)).getByText("2")).toBeTruthy();
    // The saved adjustment emptied the form.
    expect((within(review()).getByLabelText(A.amountLabel("EUR")) as HTMLInputElement).value).toBe("");

    // 2. Approve: the confirmation, then the step-up the API asks for, and the same approval again with If-Match.
    fireEvent.click(within(review()).getByRole("button", { name: A.approve }));
    const confirm = await screen.findByRole(
      "alertdialog",
      {
        name: A.approveTitle("Acme Travel", "February 2027"),
      },
      UI_WAIT,
    );
    expect(confirm.textContent).toContain("€11,304.87");
    fireEvent.click(within(confirm).getByRole("button", { name: A.approveConfirm }));
    await answerStepUp();
    expect((await notice("done", review())).textContent).toContain(A.approved);
    const approvals = calls("POST", `${path}/approve`);
    expect(approvals).toHaveLength(2);
    expect(approvals.map((request) => request.headers.get("if-match"))).toEqual(['"2"', '"2"']);
    expect(await bodies("POST", "/v1/admin/auth/step-up")).toEqual([{ code: TOTP_CODE }]);
    await view.rerender();
    expect(statusShown()).toBe("approved");
    expect(within(review()).queryByRole("form", { name: A.adjustmentTitle })).toBeNull();

    // 3. Mark paid, after the 15 minutes of the step-up have passed: the API asks again.
    platform.steppedUp = false;
    const paidForm = within(review()).getByRole("form", { name: A.markPaidTitle });
    const paidOn = (within(paidForm).getByLabelText(A.paidOnLabel) as HTMLInputElement).value;
    expect(paidOn).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    fireEvent.change(within(paidForm).getByLabelText(A.referenceLabel), {
      target: { value: "  VX-SETTLE-2027-02-ACME " },
    });
    submit(A.markPaid, paidForm);
    await answerStepUp();
    expect((await notice("done", review())).textContent).toContain(A.paid);
    const payments = calls("POST", `${path}/mark-paid`);
    expect(payments.map((request) => request.headers.get("if-match"))).toEqual(['"3"', '"3"']);
    expect(await bodies("POST", `${path}/mark-paid`)).toEqual([
      { paidAt: `${paidOn}T00:00:00Z`, payoutReference: "VX-SETTLE-2027-02-ACME" },
      { paidAt: `${paidOn}T00:00:00Z`, payoutReference: "VX-SETTLE-2027-02-ACME" },
    ]);
    expect(calls("POST", "/v1/admin/auth/step-up")).toHaveLength(2);
    await view.rerender();
    expect(statusShown()).toBe("paid");
    expect(within(region(D.detailsTitle)).getByText("VX-SETTLE-2027-02-ACME")).toBeTruthy();
    expect(within(review()).getByText(A.intro.paid)).toBeTruthy();
    expect(within(review()).queryByRole("form", { name: A.markPaidTitle })).toBeNull();
  });

  it("[PAD-013 AC1] carries a negative draft forward, and voids a draft with its reason", async () => {
    platform.steppedUp = true;
    const negative = await openSettlement(NEGATIVE_ID);
    fireEvent.click(within(review()).getByRole("button", { name: A.approve }));
    const confirm = await screen.findByRole("alertdialog", {}, UI_WAIT);
    expect(confirm.textContent).toContain(A.approveNotPositive);
    fireEvent.click(within(confirm).getByRole("button", { name: A.approveConfirm }));
    expect((await notice("done", review())).textContent).toContain(A.carriedForward);
    await negative.rerender();
    expect(within(review()).getByText(A.intro.carried_forward)).toBeTruthy();
    cleanup();

    const draft = await openSettlement(DRAFT_ID);
    fireEvent.click(within(review()).getByRole("button", { name: A.void }));
    const dialog = await screen.findByRole(
      "dialog",
      { name: A.voidTitle("Acme Travel", "February 2027") },
      UI_WAIT,
    );
    // A reason that is too short is refused at the field, and nothing is sent.
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: "  ok  " } });
    submit(A.voidConfirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
    expect(calls("POST", `/v1/admin/settlements/${DRAFT_ID}/void`)).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), {
      target: { value: ` ${REASON} ` },
    });
    submit(A.voidConfirm, dialog);
    expect((await notice("done", review())).textContent).toContain(A.voided);
    expect(await bodies("POST", `/v1/admin/settlements/${DRAFT_ID}/void`)).toEqual([{ reason: REASON }]);
    await draft.rerender();
    expect(within(region(D.linesTitle)).getByText(D.voidLines)).toBeTruthy();
    expect(within(region(D.detailsTitle)).getByText(REASON)).toBeTruthy();

    // The server action checks the reason itself, so made-up fields send nothing.
    fetchMock.mockClear();
    const state = await voidSettlement(
      { status: "idle" },
      formData({ settlementId: DRAFT_ID, reason: "no" }),
    );
    expect(state.status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[PAD-013 AC1] checks an adjustment's decimals by the currency's exponent before sending, and shows the API's refusal at the field", async () => {
    await openSettlement(JPY_ID);
    const form = (): HTMLElement => within(review()).getByRole("form", { name: A.adjustmentTitle });
    expect(within(form()).getByText(A.amountHint("JPY", 0))).toBeTruthy();
    fillAdjustment({ amount: "1500.5", description: "Goodwill credit", reason: REASON }, "JPY");
    const amount = within(form()).getByLabelText(A.amountLabel("JPY"));
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    expect(within(form()).getByText(A.amountDecimals("JPY", 0))).toBeTruthy();
    expect(calls("POST", `/v1/admin/settlements/${JPY_ID}/adjustments`)).toHaveLength(0);
    // Trailing zeros do not count: 1500.00 yen is 1500 yen.
    fillAdjustment({ amount: "1500.00", description: "Goodwill credit", reason: REASON }, "JPY");
    await notice("done", review());
    expect(await bodies("POST", `/v1/admin/settlements/${JPY_ID}/adjustments`)).toEqual([
      { amount: { amount: "1500.00", currency: "JPY" }, description: "Goodwill credit", reason: REASON },
    ]);
    cleanup();

    await openSettlement(DRAFT_ID);
    fillAdjustment({ amount: "12.345", description: "  ", reason: "ok" });
    expect(within(form()).getByText(A.amountFormat)).toBeTruthy();
    expect(within(form()).getByText(A.descriptionRequired)).toBeTruthy();
    expect(within(form()).getByText(REASON_STRINGS.tooShort)).toBeTruthy();
    expect(document.activeElement).toBe(within(form()).getByLabelText(A.amountLabel("EUR")));
    expect(calls("POST", `/v1/admin/settlements/${DRAFT_ID}/adjustments`)).toHaveLength(0);

    // A saved adjustment, then an approval the API refuses: the earlier "saved" answer of the adjustment form must not
    // look new when the next adjustment is sent, and empty what was typed for it.
    platform.steppedUp = true;
    platform.payout = payoutAccount({ status: "pending_review" });
    fillAdjustment({ amount: "10.00", description: "Goodwill credit", reason: REASON });
    await notice("done", review());
    fireEvent.click(within(review()).getByRole("button", { name: A.approve }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", {}, UI_WAIT)).getByRole("button", {
        name: A.approveConfirm,
      }),
    );
    await notice("failed", review());

    // The API's 422 amount_precision (FIX-W37-PLATFORM) lands at the amount, in the admin's words.
    platform.overrides[`POST /v1/admin/settlements/${DRAFT_ID}/adjustments`] = () =>
      apiError("UNPROCESSABLE", 422, {
        details: { reason: "amount_precision", path: "/amount/amount", currency: "EUR", decimals: 1 },
      });
    fillAdjustment({ amount: "12.34", description: "Goodwill credit", reason: REASON });
    const field = within(form()).getByLabelText(A.amountLabel("EUR"));
    await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"), UI_WAIT);
    expect(within(form()).getByText(A.amountDecimals("EUR", 1))).toBeTruthy();
    expect(document.body.textContent).not.toContain("never shown");
    // What was typed stays for a correction.
    expect((field as HTMLInputElement).value).toBe("12.34");

    // The server action checks the amount itself, so made-up fields send nothing.
    fetchMock.mockClear();
    const state = await addSettlementAdjustment(
      { status: "idle" },
      formData({
        settlementId: JPY_ID,
        currency: "JPY",
        amount: "10.5",
        description: "Credit",
        reason: REASON,
      }),
    );
    expect(state).toEqual({
      status: "failed",
      code: "VALIDATION_FAILED",
      fieldErrors: { amount: A.amountDecimals("JPY", 0) },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("words the API's refusals: a stale version, no verified payout account, a changed carried balance, an ended session", async () => {
    platform.steppedUp = true;
    platform.payout = payoutAccount({ status: "pending_review" });
    await openSettlement(DRAFT_ID);
    // A positive net and an unverified account: the page says so before the approval.
    expect(within(review()).getByText(A.payoutWarning, { exact: false })).toBeTruthy();
    const approve = async (): Promise<HTMLElement> => {
      fireEvent.click(within(review()).getByRole("button", { name: A.approve }));
      fireEvent.click(
        within(await screen.findByRole("alertdialog", {}, UI_WAIT)).getByRole("button", {
          name: A.approveConfirm,
        }),
      );
      return notice("failed", review());
    };
    let failed = await approve();
    expect(failed.textContent).toBe(A.payoutRequired);
    expect(failed.getAttribute("data-code")).toBe("PAYOUT_ACCOUNT_REQUIRED");

    platform.payout = payoutAccount({ status: "verified" });
    platform.overrides[`POST /v1/admin/settlements/${DRAFT_ID}/approve`] = () =>
      apiError("SETTLEMENT_STATE_INVALID", 409, {
        details: { status: "draft", reason: "carry_forward_changed" },
      });
    failed = await approve();
    await waitFor(() => expect(failed.textContent).toBe(A.carryForwardChanged), UI_WAIT);

    // Someone changed the statement meanwhile: the approval is refused as stale and the page offers a full reload.
    platform.overrides = {};
    const row = platform.settlements.get(DRAFT_ID);
    if (row !== undefined) {
      platform.settlements.set(DRAFT_ID, { ...row, version: 5 });
    }
    failed = await approve();
    await waitFor(() => expect(failed.getAttribute("data-code")).toBe("PRECONDITION_FAILED"), UI_WAIT);
    expect(failed.textContent).toContain(A.stale);
    expect(hrefOf(link(A.reload, failed))).toBe(`/settlements/${DRAFT_ID}`);
    cleanup();

    // A statement that is no longer a draft, and an ended session.
    await expect(
      voidSettlement({ status: "idle" }, formData({ settlementId: APPROVED_ID, reason: REASON })),
    ).resolves.toEqual({
      status: "failed",
      code: "SETTLEMENT_STATE_INVALID",
      fieldErrors: {},
      message: A.notDraft,
    });
    platform.overrides[`POST /v1/admin/settlements/${DRAFT_ID}/void`] = () => apiError("TOKEN_EXPIRED", 401);
    await expect(
      voidSettlement({ status: "idle" }, formData({ settlementId: DRAFT_ID, reason: REASON })),
    ).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: `/settlements/${DRAFT_ID}` }).toString()}`,
    );
  });

  it("renders the not-found page for an unknown statement, and for a value that is no statement id without a call", async () => {
    await expect(settlementPage("stl_nope")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(settlementPage(UNKNOWN_ID)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("hands the review actions only the statement's ids, status, version, currency, net and payout status", async () => {
    const payload = serverPayload(await settlementPage(DRAFT_ID));
    const [props, ...more] = propsOf(payload, SettlementActions);
    expect(more).toHaveLength(0);
    expect(Object.keys(props ?? {}).sort()).toEqual(
      [
        "currency",
        "month",
        "netAmount",
        "payoutAccountStatus",
        "settlementId",
        "status",
        "tenantId",
        "tenantName",
        "today",
        "version",
      ].sort(),
    );
  });
});

// ---- The CSV download ------------------------------------------------------------------------------------------------------

describe("settlements/[settlementId]/lines.csv/route.ts: the lines as CSV", () => {
  const CSV_PATH = `/v1/admin/settlements/${DRAFT_ID}/lines.csv`;
  const HEADER = "id,type,occurredAt,amount\n";
  const RECORD = "sln_01JD9X1B2C3D4E5F6G7H8J9K0M,charge,2027-02-03T10:22:41Z,1180.00\n";

  function csvRequest(): Request {
    return new Request(`http://127.0.0.1:3001/settlements/${DRAFT_ID}/lines.csv`);
  }

  function context(settlementId: string = DRAFT_ID): { params: Promise<{ settlementId: string }> } {
    return { params: Promise.resolve({ settlementId }) };
  }

  it("[PAD-013 AC1] streams the API's file with the admin's session, named after the OTA, month and currency, never cached", async () => {
    const encoder = new TextEncoder();
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    platform.overrides[`GET ${CSV_PATH}`] = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
            controller.enqueue(encoder.encode(HEADER));
          },
        }),
        { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } },
      );

    // The answer arrives while the API is still sending: nothing waits for the whole file.
    const response = await linesCsv(csvRequest(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="velexis-settlement-acme-2027-02-EUR.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body?.getReader();
    if (reader === undefined || upstream === undefined) {
      throw new Error("no stream");
    }
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(HEADER);
    upstream.enqueue(encoder.encode(RECORD));
    upstream.close();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value, { stream: true });
    }
    expect(rest).toBe(RECORD);
    // The token goes from the httpOnly cookie to the API on the server, never through the browser.
    expectSessionHeaders(calls("GET", CSV_PATH)[0]);
    expectSessionHeaders(calls("GET", `/v1/admin/settlements/${DRAFT_ID}`)[0]);
  });

  it("aborts the download when the API's stream fails, so a cut file is never complete", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    platform.overrides[`GET ${CSV_PATH}`] = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
            controller.enqueue(new TextEncoder().encode(HEADER));
          },
        }),
        { status: 200 },
      );
    const response = await linesCsv(csvRequest(), context());
    const reader = response.body?.getReader();
    await reader?.read();
    upstream?.error(new Error("socket hang up"));
    await expect(reader?.read()).rejects.toThrow();
  });

  it("answers refusals in the admin's words, an unknown id without a call, HEAD with 405, and an ended session at sign-in", async () => {
    const invalid = await linesCsv(csvRequest(), context("stl_nope"));
    expect(invalid.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();

    const unknown = await linesCsv(csvRequest(), context(UNKNOWN_ID));
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(calls("GET", `/v1/admin/settlements/${UNKNOWN_ID}/lines.csv`)).toHaveLength(0);

    platform.overrides[`GET ${CSV_PATH}`] = () => apiError("RATE_LIMITED", 429, {}, { "retry-after": "60" });
    const limited = await linesCsv(csvRequest(), context());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.text()).not.toContain("never shown");

    platform.overrides[`GET ${CSV_PATH}`] = () => apiError("TOKEN_EXPIRED", 401);
    await expect(linesCsv(csvRequest(), context())).rejects.toThrow(
      `NEXT_REDIRECT /sign-in?${new URLSearchParams({ next: `/settlements/${DRAFT_ID}` }).toString()}`,
    );

    fetchMock.mockClear();
    const head = linesCsvHead();
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
    expect(head.body).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- The payout account of an OTA ------------------------------------------------------------------------------------------

describe("tenants/[tenantId]/payout-account.tsx: the payout account on the OTA's page", () => {
  it("[PAD-013 AC2] reveals the bank details only with a reason and a step-up [PF-64 AC2]", async () => {
    expect(operationRequirements("adminRevealPayoutAccount")).toEqual({ reason: true, stepUp: true });
    const panel = await openPayoutAccount();
    await within(panel).findByText("IBAN ending in 7947", {}, UI_WAIT);
    expect(within(panel).getByText("Acme Travel AS")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(IBAN);
    expect(calls("POST", `/v1/admin/tenants/${TENANT_ID}/payout-account/reveal`)).toHaveLength(0);

    fireEvent.click(within(panel).getByRole("button", { name: P.reveal }));
    const dialog = await screen.findByRole("dialog", { name: P.revealTitle("Acme Travel") }, UI_WAIT);
    // Without a reason nothing is asked.
    submit(P.revealConfirm, dialog);
    expect(within(dialog).getByText(REASON_STRINGS.required)).toBeTruthy();
    expect(calls("POST", `/v1/admin/tenants/${TENANT_ID}/payout-account/reveal`)).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), {
      target: { value: `  Bank transfer of the approved statement ${APPROVED_ID}.  ` },
    });
    submit(P.revealConfirm, dialog);
    // The API asks for the step-up; the same reason goes again with the new session.
    await answerStepUp();
    const revealed = await screen.findByRole("region", { name: P.revealedTitle("Acme Travel") }, UI_WAIT);
    expect(within(revealed).getByText(IBAN_GROUPED)).toBeTruthy();
    expect(within(revealed).getByText(BIC)).toBeTruthy();
    expect(await bodies("POST", `/v1/admin/tenants/${TENANT_ID}/payout-account/reveal`)).toEqual([
      { reason: `Bank transfer of the approved statement ${APPROVED_ID}.` },
      { reason: `Bank transfer of the approved statement ${APPROVED_ID}.` },
    ]);
    expect(calls("POST", "/v1/admin/auth/step-up")).toHaveLength(1);
    expectSessionHeaders(calls("POST", `/v1/admin/tenants/${TENANT_ID}/payout-account/reveal`)[0]);

    // A later reveal that asks for the step-up again carries no identifiers, not even the earlier reveal's: an admin who
    // cancels the dialog leaves no copy behind in the panel's state.
    platform.steppedUp = false;
    await expect(
      revealPayoutAccount(
        { status: "revealed", fields: [{ label: P.iban, value: IBAN_GROUPED }] },
        formData({ tenantId: TENANT_ID, reason: REASON }),
      ),
    ).resolves.toEqual({ status: "idle", stepUp: true });
  });

  it("[PAD-013 AC2] hides the revealed details after 60 seconds, and the panel forgets its copy [PF-64 AC2]", async () => {
    platform.steppedUp = true;
    // Fake timers that also move with real time, so the server actions and the waits run; the 60 seconds are skipped.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    try {
      const panel = await openPayoutAccount();
      await within(panel).findByText("IBAN ending in 7947", {}, UI_WAIT);
      fireEvent.click(within(panel).getByRole("button", { name: P.reveal }));
      const dialog = await screen.findByRole("dialog", {}, UI_WAIT);
      fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: REASON } });
      submit(P.revealConfirm, dialog);
      const revealed = await screen.findByRole("region", { name: P.revealedTitle("Acme Travel") }, UI_WAIT);
      expect(within(revealed).getByText(IBAN_GROUPED)).toBeTruthy();
      // `RevealPanel` starts its 60 seconds in an effect, which runs a moment after the reveal's transition is on the
      // page (on a busy machine, after this test has moved on): the countdown's first tick, as the fake clock moves
      // with real time, shows that the 60 seconds run. Between 1 and 2 seconds of them have passed then.
      await within(revealed).findByText(REVEAL_STRINGS.hidesIn(59), {}, UI_WAIT);

      // 50 seconds later the details still show.
      act(() => {
        vi.advanceTimersByTime(50_000);
      });
      expect(within(revealed).getByText(IBAN_GROUPED)).toBeTruthy();
      // 60 seconds after the reveal the details leave the page, and the panel's own copy with them.
      act(() => {
        vi.advanceTimersByTime(REVEAL_DURATION_MS - 50_000);
      });
      await waitFor(
        () => expect(screen.queryByRole("region", { name: P.revealedTitle("Acme Travel") })).toBeNull(),
        UI_WAIT,
      );
      expect(document.body.innerHTML).not.toContain(IBAN_GROUPED);
      expect(document.body.innerHTML).not.toContain(BIC);
      expect(screen.getByText(REVEAL_STRINGS.hidden)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[PAD-013 AC2] hides the details on 'Hide now', and a new reveal is a new audited call", async () => {
    platform.steppedUp = true;
    const panel = await openPayoutAccount();
    await within(panel).findByText("IBAN ending in 7947", {}, UI_WAIT);
    const reveal = async (): Promise<HTMLElement> => {
      const button = within(panel).getByRole("button", { name: P.reveal }) as HTMLButtonElement;
      await waitFor(() => expect(button.disabled).toBe(false), UI_WAIT);
      fireEvent.click(button);
      const dialog = await screen.findByRole("dialog", {}, UI_WAIT);
      fireEvent.change(within(dialog).getByLabelText(REASON_STRINGS.label), { target: { value: REASON } });
      submit(P.revealConfirm, dialog);
      return screen.findByRole("region", { name: P.revealedTitle("Acme Travel") }, UI_WAIT);
    };
    const first = await reveal();
    fireEvent.click(within(first).getByRole("button", { name: REVEAL_STRINGS.hideNow }));
    await waitFor(() => expect(document.body.innerHTML).not.toContain(IBAN_GROUPED), UI_WAIT);
    const second = await reveal();
    expect(within(second).getByText(IBAN_GROUPED)).toBeTruthy();
    expect(calls("POST", `/v1/admin/tenants/${TENANT_ID}/payout-account/reveal`)).toHaveLength(2);
  });

  it("[PAD-013 AC1] verifies the account and rejects it with a note, with its version in If-Match; a stale one asks to reload", async () => {
    platform.payout = payoutAccount({ status: "pending_review" });
    const panel = await openPayoutAccount();
    await within(panel).findByText(P.pendingNote, {}, UI_WAIT);
    expect(within(panel).getByText("Pending review")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: P.verify })).not.toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: P.verify }));
    fireEvent.click(
      within(
        await screen.findByRole("alertdialog", { name: P.verifyTitle("Acme Travel") }, UI_WAIT),
      ).getByRole("button", { name: P.verifyConfirm }),
    );
    expect((await notice("done", panel)).textContent).toContain(P.verified);
    const path = `/v1/admin/tenants/${TENANT_ID}/payout-account/review`;
    expect(calls("POST", path).map((request) => request.headers.get("if-match"))).toEqual(['"3"']);
    expect(await bodies("POST", path)).toEqual([{ decision: "verified" }]);
    await waitFor(() => expect(within(panel).queryByRole("button", { name: P.verify })).toBeNull(), UI_WAIT);

    // Reject: the note is required, and goes with the new version.
    fireEvent.click(within(panel).getByRole("button", { name: P.reject }));
    const dialog = await screen.findByRole("dialog", { name: P.rejectTitle("Acme Travel") }, UI_WAIT);
    submit(P.rejectConfirm, dialog);
    expect(within(dialog).getByText(P.noteRequired)).toBeTruthy();
    expect(calls("POST", path)).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText(P.noteLabel), {
      target: { value: " The holder does not match the legal name. " },
    });
    submit(P.rejectConfirm, dialog);
    await waitFor(() => expect(calls("POST", path)).toHaveLength(2), UI_WAIT);
    expect((await bodies("POST", path))[1]).toEqual({
      decision: "rejected",
      note: "The holder does not match the legal name.",
    });
    expect(calls("POST", path)[1]?.headers.get("if-match")).toBe('"4"');
    await waitFor(
      () => expect(within(panel).getByText("The holder does not match the legal name.")).toBeTruthy(),
      UI_WAIT,
    );

    // The owner changed the account meanwhile: nothing is saved and the panel offers a full reload.
    if (platform.payout !== null) {
      platform.payout = { ...platform.payout, status: "pending_review", version: 9 };
    }
    fireEvent.click(within(panel).getByRole("button", { name: P.verify }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", {}, UI_WAIT)).getByRole("button", {
        name: P.verifyConfirm,
      }),
    );
    const failed = await notice("failed", panel);
    expect(failed.textContent).toContain(P.stale);
    expect(hrefOf(link(P.reload, failed))).toBe(`/tenants/${TENANT_ID}?tab=connections`);
  });

  it("says when the OTA has no payout account, and the tenant page hands the panel only the OTA's id and name", async () => {
    platform.payout = null;
    const panel = await openPayoutAccount();
    await within(panel).findByText(P.none, {}, UI_WAIT);
    expect(within(panel).queryByRole("button", { name: P.reveal })).toBeNull();
    expect(hrefOf(link(P.statements, panel))).toBe(`/settlements?tenantId=${TENANT_ID}`);
    cleanup();

    const payload = serverPayload(
      await TenantDetailPage({ params: Promise.resolve({ tenantId: TENANT_ID }) }),
    );
    expect(propsOf(payload, PayoutAccountPanel)).toEqual([
      { tenantId: TENANT_ID, tenantName: "Acme Travel" },
    ]);
  });
});
