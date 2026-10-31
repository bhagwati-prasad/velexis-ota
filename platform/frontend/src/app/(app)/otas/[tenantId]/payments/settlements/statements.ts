import type { components } from "@velexis/api-types/platform";

import { DEFAULT_LOCALE } from "@/components/money";
import { otaPath } from "@/lib/roles";

/**
 * What the settlements list, a statement's page and the CSV route handler share (README §2
 * `/otas/[tenantId]/payments/settlements`; flows/stripe-payments-account.md §F; PF-63 AC3): the statuses the portal
 * shows, the statement id, the month of a statement, the paths and the CSV file's name. Next.js lets a page or a route
 * module export only its own fields, so these live here. Plain functions without secrets.
 */

/** A statement as `listSettlements` answers it. */
export type SettlementSummary = components["schemas"]["SettlementSummary"];
/** A statement with its totals, as `getSettlement` answers it. */
export type Settlement = components["schemas"]["Settlement"];
/** The statuses of a statement the portal shows. */
export type StatementStatus = SettlementSummary["status"];

/**
 * The statuses the portal API answers (`SettlementSummary.status`). Drafts and voided drafts never reach the portal:
 * the API leaves them out of the list and answers `404` for them; a statement in any other status is not shown either.
 */
export const STATEMENT_STATUSES: readonly StatementStatus[] = Object.freeze([
  "approved",
  "paid",
  "carried_forward",
]);

/** `status` is one the portal shows (never `draft` or `void`). */
export function isShownStatus(status: string): status is StatementStatus {
  return (STATEMENT_STATUSES as readonly string[]).includes(status);
}

/** A statement id as the platform issues it (`stl_` + ULID); the `SettlementId` pattern of the platform document. */
const SETTLEMENT_ID = /^stl_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `value` is a statement id. */
export function isSettlementId(value: unknown): value is string {
  return typeof value === "string" && SETTLEMENT_ID.test(value);
}

/** Statements cover calendar months in UTC, so their months and dates are shown in UTC. */
export const STATEMENT_TIME_ZONE = "UTC";

/** The month of a statement from its `periodStart` ("January 2027", in UTC), or the value itself when it is no date. */
export function statementMonth(periodStart: string): string {
  const instant = Date.parse(periodStart);
  if (!Number.isFinite(instant)) {
    return periodStart;
  }
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    month: "long",
    year: "numeric",
    timeZone: STATEMENT_TIME_ZONE,
  }).format(instant);
}

/** The Velexis fee rate of `feeBps` basis points in words: 200 → "2%", 125 → "1.25%". */
export function feeRate(feeBps: number): string {
  return new Intl.NumberFormat(DEFAULT_LOCALE, { style: "percent", maximumFractionDigits: 2 }).format(
    feeBps / 10_000,
  );
}

/** The list of statements: `/otas/<tenantId>/payments/settlements`. */
export function statementsPath(tenantId: string): string {
  return otaPath(tenantId, "/payments/settlements");
}

/** A statement's page: `/otas/<tenantId>/payments/settlements/<settlementId>`. */
export function statementPath(tenantId: string, settlementId: string): string {
  return `${statementsPath(tenantId)}/${encodeURIComponent(settlementId)}`;
}

/** The CSV of a statement's lines, served by the route handler: `…/<settlementId>/lines.csv`. */
export function linesCsvPath(tenantId: string, settlementId: string): string {
  return `${statementPath(tenantId, settlementId)}/lines.csv`;
}

const CURRENCY = /^[A-Z]{3}$/;

/**
 * The name of a statement's CSV file, as the API names it (`downloadSettlementLines`'s `Content-Disposition`):
 * `velexis-statement-<yyyy-mm>-<currency>.csv`, the month of `periodStart` in UTC. A value the API never answers
 * (no date, another currency shape) gives `velexis-statement.csv`, so nothing from the answer reaches the header
 * unchecked.
 */
export function statementFileName(statement: Pick<Settlement, "periodStart" | "currency">): string {
  const instant = Date.parse(statement.periodStart);
  if (!Number.isFinite(instant) || !CURRENCY.test(statement.currency)) {
    return "velexis-statement.csv";
  }
  const start = new Date(instant);
  const year = String(start.getUTCFullYear()).padStart(4, "0");
  const month = String(start.getUTCMonth() + 1).padStart(2, "0");
  return year.length === 4
    ? `velexis-statement-${year}-${month}-${statement.currency}.csv`
    : "velexis-statement.csv";
}
