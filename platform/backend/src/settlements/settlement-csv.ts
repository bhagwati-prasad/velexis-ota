// The CSV files of a settlement statement's lines (PBE-060; platform/docs/api-inventory-resources.md §5
// `downloadSettlementLines`, api-inventory-admin.md §6 `adminDownloadSettlementLines`, PADR-0016 item 4, scope PF-63
// AC3): plain functions from the stored lines to the text of the file, so the rules are tested without a database
// (settlement-csv.test.ts).
//
// - UTF-8, comma-separated, one header row with the columns of the inventory, in its order (the portal's
//   PORTAL_SETTLEMENT_CSV_COLUMNS, the admin's ADMIN_SETTLEMENT_CSV_COLUMNS), then one record per line in
//   `occurredAt` order (the repository's order), each ended with CRLF and quoted as RFC 4180 says (audit-csv.ts's
//   `csvCell`, which the audit export uses too). An empty cell is a `null`.
// - **Amounts** (`amount`, `stripeFee`, `originalAmount`) are the stored `numeric(12,2)` decimal strings, signed (a
//   refund or a dispute is negative), without a thousands separator, and kept as they are: a negative amount keeps its
//   `-`, so a spreadsheet reads a number. Only a plain decimal string is written there; anything else throws, so a
//   cell of an amount column can never hold text.
// - **Text cells** (every other column: ids, types, times and the description, which a platform admin may type) go
//   through the OWASP rule against CSV injection: a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage
//   return gets a leading `'`, so a spreadsheet never runs it as a formula.
// - **File names** (`Content-Disposition`, always an attachment): `velexis-statement-<yyyy-mm>-<currency>.csv` for the
//   portal, `velexis-settlement-<tenant key>-<yyyy-mm>-<currency>.csv` for the admin, the month of the statement's
//   period in UTC.
//
// A line never holds card data (the generator reads none), so the files hold none either.
import { csvCell, CSV_RECORD_END } from "../audit/audit-csv";

/** The media type of both files. */
export const SETTLEMENT_CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/** The columns of the portal's file (`downloadSettlementLines`), in the inventory's order. */
export const PORTAL_SETTLEMENT_CSV_COLUMNS = Object.freeze([
  "type",
  "occurredAt",
  "amount",
  "stripeFee",
  "paymentIntentId",
  "velexisPaymentId",
  "checkoutId",
  "description",
] as const);

/** The columns of the admin's file (`adminDownloadSettlementLines`), in the inventory's order. */
export const ADMIN_SETTLEMENT_CSV_COLUMNS = Object.freeze([
  "id",
  "type",
  "occurredAt",
  "amount",
  "stripeFee",
  "originalAmount",
  "originalCurrency",
  "balanceTransactionId",
  "sourceId",
  "paymentIntentId",
  "velexisPaymentId",
  "checkoutId",
  "description",
  "createdByAccountId",
] as const);

/** What a file reads of one stored `settlement_lines` row. */
export interface SettlementCsvLine {
  readonly id: string;
  readonly line_type: string;
  readonly occurred_at: Date;
  /** Signed, `numeric(12,2)` as a decimal string. */
  readonly amount: string;
  readonly stripe_fee: string;
  readonly original_amount: string | null;
  readonly original_currency: string | null;
  readonly balance_transaction_id: string | null;
  readonly source_id: string | null;
  readonly payment_intent_id: string | null;
  readonly velexis_payment_id: string | null;
  readonly checkout_id: string | null;
  readonly description: string | null;
  readonly created_by_account_id: string | null;
}

/** A decimal string as PostgreSQL prints `numeric`: an optional `-`, digits, and decimals after a point. */
const DECIMAL_STRING = /^-?[0-9]+(?:\.[0-9]+)?$/;

/** A line whose amount is not a decimal string: the files never write text in an amount column. */
export class SettlementCsvError extends Error {
  override readonly name = "SettlementCsvError";
}

/** The cell of an amount: the decimal string as it is (its sign included), empty for `null`. */
export function amountCell(value: string | null): string {
  if (value === null) {
    return "";
  }
  if (typeof value !== "string" || !DECIMAL_STRING.test(value)) {
    throw new SettlementCsvError("an amount of a settlement line is not a decimal string");
  }
  return value;
}

/** One record of already-written cells, ended with CRLF. */
function record(cells: readonly string[]): string {
  return `${cells.join(",")}${CSV_RECORD_END}`;
}

/** A text cell: `null` is empty; the OWASP rule and RFC 4180 quoting of audit-csv.ts apply. */
const text = (value: string | null): string => csvCell(value);

/** The header record of the portal's file. */
export function portalSettlementCsvHeader(): string {
  return record(PORTAL_SETTLEMENT_CSV_COLUMNS.map(text));
}

/** The record of one line in the portal's file. */
export function portalSettlementCsvRecord(line: SettlementCsvLine): string {
  return record([
    text(line.line_type),
    text(line.occurred_at.toISOString()),
    amountCell(line.amount),
    amountCell(line.stripe_fee),
    text(line.payment_intent_id),
    text(line.velexis_payment_id),
    text(line.checkout_id),
    text(line.description),
  ]);
}

/** The header record of the admin's file. */
export function adminSettlementCsvHeader(): string {
  return record(ADMIN_SETTLEMENT_CSV_COLUMNS.map(text));
}

/** The record of one line in the admin's file. */
export function adminSettlementCsvRecord(line: SettlementCsvLine): string {
  return record([
    text(line.id),
    text(line.line_type),
    text(line.occurred_at.toISOString()),
    amountCell(line.amount),
    amountCell(line.stripe_fee),
    amountCell(line.original_amount),
    text(line.original_currency === null ? null : line.original_currency.trim()),
    text(line.balance_transaction_id),
    text(line.source_id),
    text(line.payment_intent_id),
    text(line.velexis_payment_id),
    text(line.checkout_id),
    text(line.description),
    text(line.created_by_account_id),
  ]);
}

/** The whole portal file: the header, then the lines in the order given. */
export function portalSettlementCsv(lines: readonly SettlementCsvLine[]): string {
  return portalSettlementCsvHeader() + lines.map(portalSettlementCsvRecord).join("");
}

/** The whole admin file: the header, then the lines in the order given. */
export function adminSettlementCsv(lines: readonly SettlementCsvLine[]): string {
  return adminSettlementCsvHeader() + lines.map(adminSettlementCsvRecord).join("");
}

/** `2027-01` for a period starting on 2027-01-01T00:00:00Z. */
function month(periodStart: Date): string {
  return periodStart.toISOString().slice(0, 7);
}

/** The portal's file name of the statement of `periodStart` in `currency`. */
export function statementCsvFilename(periodStart: Date, currency: string): string {
  return `velexis-statement-${month(periodStart)}-${currency.trim()}.csv`;
}

/** The admin's file name of the statement of OTA `tenantKey`, `periodStart` and `currency`. */
export function adminSettlementCsvFilename(tenantKey: string, periodStart: Date, currency: string): string {
  return `velexis-settlement-${tenantKey}-${month(periodStart)}-${currency.trim()}.csv`;
}

/** The `Content-Disposition` of a file named `filename`: always an attachment. */
export function csvAttachment(filename: string): string {
  return `attachment; filename="${filename}"`;
}
