// The CSV file of adminExportAudit (PBE-032; platform/docs/api-inventory-admin.md §7, flows/platform-admin-operations.md
// §I, PADR-0006 "Audit"): plain functions from an `AuditEntry` to the lines of the file, so the rules are tested
// without a database (audit-csv.test.ts).
//
// - UTF-8, comma-separated, one header row (AUDIT_CSV_COLUMNS, the order of the OpenAPI document), then one record per
//   row. Records end with CRLF, as RFC 4180 writes them.
// - A cell is quoted when it holds a comma, a double quote, a carriage return or a line feed; a double quote inside is
//   doubled (RFC 4180 item 6 and 7). An empty cell is a `null`. `details` is the row's redacted JSON.
// - CSV injection (OWASP): a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`,
//   so a spreadsheet shows it as text instead of running it as a formula. User agents, actor labels and the JSON of
//   `details` come from outside, so every cell goes through the rule, ids and times included.
// - The file name names the period: `velexis-audit-<from date>-<to date>.csv`, the UTC dates of `from` and `to`.
import type { components } from "@velexis/api-types/platform";

export type AuditEntry = components["schemas"]["AuditEntry"];

/** The columns of the file, in order (the OpenAPI document's `adminExportAudit`). */
export const AUDIT_CSV_COLUMNS = Object.freeze([
  "id",
  "createdAt",
  "tenantId",
  "tenantKey",
  "actorType",
  "actorAccountId",
  "actorLabel",
  "action",
  "targetType",
  "targetId",
  "requestId",
  "ipAddress",
  "userAgent",
  "details",
] as const satisfies ReadonlyArray<keyof AuditEntry>);

/** The end of every record (RFC 4180 item 1). */
export const CSV_RECORD_END = "\r\n";

/** The media type of the answer. */
export const AUDIT_CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/** The first characters a spreadsheet may read as the start of a formula (OWASP, CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** The characters that make RFC 4180 quote a cell. */
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell: `null` is empty; a formula start is neutralised with a leading `'`, then the cell is quoted if needed. */
export function csvCell(value: string | null): string {
  if (value === null || value === "") {
    return "";
  }
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record: the cells joined with commas, ended with CRLF. */
export function csvRecord(values: ReadonlyArray<string | null>): string {
  return `${values.map(csvCell).join(",")}${CSV_RECORD_END}`;
}

/** The header record. */
export function auditCsvHeader(): string {
  return csvRecord(AUDIT_CSV_COLUMNS);
}

/** The record of one audit row. */
export function auditCsvRecord(entry: AuditEntry): string {
  return csvRecord([
    entry.id,
    entry.createdAt,
    entry.tenantId,
    entry.tenantKey,
    entry.actorType,
    entry.actorAccountId,
    entry.actorLabel,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.requestId,
    entry.ipAddress,
    entry.userAgent,
    JSON.stringify(entry.details),
  ]);
}

/** `YYYY-MM-DD` of `instant` in UTC. */
function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** The file name of an export of the period [`from`, `to`). */
export function auditExportFilename(from: Date, to: Date): string {
  return `velexis-audit-${utcDate(from)}-${utcDate(to)}.csv`;
}

/** The `Content-Disposition` of an export of the period [`from`, `to`): always an attachment. */
export function auditExportDisposition(from: Date, to: Date): string {
  return `attachment; filename="${auditExportFilename(from, to)}"`;
}
