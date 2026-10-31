import type { components } from "@velexis/api-types/platform";

/**
 * The filters of the audit search (`/audit`, README §2, PF-85) and of its CSV export (`/audit/export.csv`): both read
 * the same URL parameters, so the export is always the file of the list the admin sees. A page module and a route
 * module may export only what Next.js expects of them, so the rules live here, with `auditRowOf`, which the audit and
 * account pages call before they hand rows to the client component `AuditTable`.
 *
 * The URL carries the period as two calendar days in UTC (`from` and `to`, `YYYY-MM-DD`, the value of a date field):
 * the list shows the rows from the start of `from` up to and including the whole day `to`. The API's period is
 * `from` inclusive and `to` exclusive, so `to` is sent as the start of the next day.
 */

type Schemas = components["schemas"];
export type AuditActorType = Schemas["AuditActorType"];

/**
 * The audit actions, a copy of `AUDIT_ACTIONS` in `platform/backend/src/audit/audit-actions.ts` in its order
 * (PADR-0006 Audit item 6: the admin's filter offers the same names). `accounts.test.tsx` fails when the two differ.
 */
export const AUDIT_ACTIONS: readonly string[] = Object.freeze([
  "account.signed_up",
  "account.email_verified",
  "account.updated",
  "account.password_changed",
  "account.password_reset",
  "account.mfa_enabled",
  "account.mfa_disabled",
  "account.recovery_codes_regenerated",
  "account.disabled",
  "account.enabled",
  "account.unlocked",
  "account.mfa_reset",
  "auth.sign_in",
  "auth.sign_in_failed",
  "auth.locked",
  "auth.recovery_code_used",
  "auth.signed_out_everywhere",
  "auth.session_revoked",
  "admin.sign_in",
  "admin.sign_in_failed",
  "admin.granted",
  "admin.revoked",
  "tenant.created",
  "tenant.updated",
  "tenant.activated",
  "tenant.provisioning_failed",
  "tenant.initial_keys_revealed",
  "tenant.suspended",
  "tenant.resumed",
  "tenant.migration_requested",
  "tenant.migrated",
  "tenant.migration_failed",
  "tenant.went_live",
  "provisioning_job.retried",
  "provisioning_job.canceled",
  "queue_job.retried",
  "stripe_event.reprocessed",
  "membership.created",
  "membership.role_changed",
  "membership.removed",
  "invitation.created",
  "invitation.resent",
  "invitation.revoked",
  "invitation.expired",
  "console.token_issued",
  "api_key.created",
  "api_key.updated",
  "api_key.rolled",
  "api_key.revoked",
  "domain.added",
  "domain.verification_restarted",
  "domain.verified",
  "domain.verification_failed",
  "domain.primary_changed",
  "domain.removed",
  "amadeus.settings_updated",
  "amadeus.live_requested",
  "amadeus.credentials_submitted",
  "amadeus.credentials_applied",
  "amadeus.credentials_rejected",
  "amadeus_account.created",
  "amadeus_account.updated",
  "amadeus_account.verification_requested",
  "amadeus_account.verified",
  "amadeus_account.verification_failed",
  "amadeus_office.added",
  "amadeus_office.updated",
  "amadeus_office.assigned",
  "amadeus_office.released",
  "amadeus_office.retired",
  "connection.status_changed",
  "payments.descriptor_updated",
  "payments.connect_connected",
  "payments.connect_status_changed",
  "payments.connect_disconnected",
  "payments.connect_deauthorized_while_disabled",
  "payments.api_keys_submitted",
  "payments.api_keys_applied",
  "payments.api_keys_rejected",
  "payments.switched_to_velexis",
  "payout_account.updated",
  "payout_account.revealed",
  "payout_account.reviewed",
  "settlement.generation_requested",
  "settlement.generated",
  "settlement.adjusted",
  "settlement.approved",
  "settlement.paid",
  "settlement.voided",
  "plan.created",
  "plan.updated",
  "billing.checkout_started",
  "subscription.updated",
  "subscription.resynced",
  "subscription.manually_updated",
  "audit.exported",
]);

/**
 * The kinds of object an audit row is about, a copy of `AUDIT_TARGET_TYPES` of the same backend module in its order;
 * `accounts.test.tsx` fails when the two differ.
 */
export const AUDIT_TARGET_TYPES: readonly string[] = Object.freeze([
  "account",
  "session",
  "tenant",
  "provisioning_job",
  "queue_job",
  "stripe_event",
  "membership",
  "invitation",
  "api_key",
  "domain",
  "supplier_connection",
  "payment_connection",
  "credential_submission",
  "amadeus_account",
  "amadeus_office",
  "payout_account",
  "settlement",
  "plan",
  "subscription",
  "audit_log",
]);

/** The actor types of the platform document, in its order (`AuditActorType`). */
const ACTOR_TYPES: Readonly<Record<AuditActorType, true>> = {
  account: true,
  platform_admin: true,
  api_key: true,
  system: true,
};

/** The URL parameters of the filters, in the order the filter bar shows them. */
export const AUDIT_FILTER_PARAMS = [
  "tenantId",
  "actorAccountId",
  "actorType",
  "action",
  "targetType",
  "targetId",
  "from",
  "to",
] as const;

export type AuditFilterParam = (typeof AUDIT_FILTER_PARAMS)[number];

/** The filters of the URL; an absent or empty parameter is no filter. The period is two UTC days. */
export interface AuditFilters {
  readonly tenantId?: string;
  readonly actorAccountId?: string;
  readonly actorType?: AuditActorType;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  /** The first day of the period (`YYYY-MM-DD`, UTC), included. */
  readonly from?: string;
  /** The last day of the period (`YYYY-MM-DD`, UTC), included. */
  readonly to?: string;
  readonly cursor?: string;
}

/** Why the URL's filters cannot be used. */
export type AuditFilterProblem = "invalid" | "period_order";

export type ParsedAuditFilters =
  | { readonly ok: true; readonly filters: AuditFilters }
  | { readonly ok: false; readonly problem: AuditFilterProblem };

/** The query of the page or the route as Next.js and `URLSearchParams` give it: a repeated parameter is an array. */
export type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

// The parameter rules of `adminListAudit` and `adminExportAudit` in the platform document.
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;
const ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ACTION_MAX_LENGTH = 100;
const TARGET_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const TARGET_ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const CURSOR_MAX_LENGTH = 512;
/** A calendar day as a date field writes it. */
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DAY_MS = 86_400_000;

/** The URL's query as a record, a repeated parameter as an array (as Next.js passes `searchParams` to a page). */
export function searchParamsRecord(query: URLSearchParams): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (const [name, value] of query.entries()) {
    const current = record[name];
    record[name] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  }
  return record;
}

/** A query parameter: `""` when absent, `undefined` when repeated (a URL no filter bar writes). */
function single(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : undefined;
}

/** The instant (epoch ms) of the start of `day` in UTC, or `undefined` when it is no calendar day. */
function startOfDay(day: string): number | undefined {
  if (!DAY.test(day)) {
    return undefined;
  }
  const instant = Date.parse(`${day}T00:00:00Z`);
  // `2026-02-30` parses as March 2 in some engines and not at all in others: only a round trip is a real day.
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === day
    ? instant
    : undefined;
}

function isActorType(value: string): value is AuditActorType {
  return Object.hasOwn(ACTOR_TYPES, value);
}

/** Each filter's rule; `""` is no filter and always passes. */
const RULES: Readonly<Record<AuditFilterParam, (value: string) => boolean>> = {
  tenantId: (value) => TENANT_ID.test(value),
  actorAccountId: (value) => ACCOUNT_ID.test(value),
  actorType: isActorType,
  action: (value) => value.length <= ACTION_MAX_LENGTH && ACTION.test(value),
  targetType: (value) => TARGET_TYPE.test(value),
  targetId: (value) => TARGET_ID.test(value),
  from: (value) => startOfDay(value) !== undefined,
  to: (value) => startOfDay(value) !== undefined,
};

/**
 * The filters of the URL, or the problem with them: a repeated parameter, or a value the API would refuse, is
 * `invalid`; a period whose first day is after its last is `period_order`. The page then says so instead of showing
 * an unfiltered list under a filtered address, and the route exports nothing. The free-text filters are trimmed, as the
 * filter bar trims them.
 */
export function parseAuditFilters(params: SearchParams): ParsedAuditFilters {
  const values: Partial<Record<AuditFilterParam | "cursor", string>> = {};
  for (const name of AUDIT_FILTER_PARAMS) {
    const value = single(params[name])?.trim();
    if (value === undefined || (value !== "" && !RULES[name](value))) {
      return { ok: false, problem: "invalid" };
    }
    if (value !== "") {
      values[name] = value;
    }
  }
  const cursor = single(params["cursor"]);
  if (cursor === undefined || cursor.length > CURSOR_MAX_LENGTH) {
    return { ok: false, problem: "invalid" };
  }
  if (cursor !== "") {
    values.cursor = cursor;
  }
  if (values.from !== undefined && values.to !== undefined && values.from > values.to) {
    return { ok: false, problem: "period_order" };
  }
  return { ok: true, filters: values as AuditFilters };
}

/** The ISO instant of the start of a validated day. */
function instantOf(day: string, plusDays = 0): string {
  return new Date((startOfDay(day) ?? Number.NaN) + plusDays * DAY_MS).toISOString().replace(".000Z", "Z");
}

/** The filters that narrow the rows, as the API's query takes them (both operations share them). */
interface NarrowingQuery {
  tenantId?: string;
  actorAccountId?: string;
  actorType?: AuditActorType;
  action?: string;
  targetType?: string;
  targetId?: string;
}

function narrowingQuery(filters: AuditFilters): NarrowingQuery {
  return {
    ...(filters.tenantId === undefined ? {} : { tenantId: filters.tenantId }),
    ...(filters.actorAccountId === undefined ? {} : { actorAccountId: filters.actorAccountId }),
    ...(filters.actorType === undefined ? {} : { actorType: filters.actorType }),
    ...(filters.action === undefined ? {} : { action: filters.action }),
    ...(filters.targetType === undefined ? {} : { targetType: filters.targetType }),
    ...(filters.targetId === undefined ? {} : { targetId: filters.targetId }),
  };
}

/** The query of `adminListAudit` for the filters: the days become the API's instants (`to` exclusive). */
export function auditListQuery(
  filters: AuditFilters,
): NarrowingQuery & { from?: string; to?: string; cursor?: string } {
  return {
    ...narrowingQuery(filters),
    ...(filters.from === undefined ? {} : { from: instantOf(filters.from) }),
    ...(filters.to === undefined ? {} : { to: instantOf(filters.to, 1) }),
    ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
  };
}

/** Why the filters cannot be exported, or `undefined` when they can. */
export type ExportProblem = "period_missing" | "period_too_long";

/**
 * The export's period rule (`adminExportAudit`): both days are required, and the period, from the start of `from` to
 * the end of `to`, spans at most one calendar year (UTC), as the API counts it.
 */
export function exportProblem(filters: AuditFilters): ExportProblem | undefined {
  if (filters.from === undefined || filters.to === undefined) {
    return "period_missing";
  }
  const latestEnd = new Date(startOfDay(filters.from) ?? Number.NaN);
  latestEnd.setUTCFullYear(latestEnd.getUTCFullYear() + 1);
  return (startOfDay(filters.to) ?? Number.NaN) + DAY_MS > latestEnd.getTime()
    ? "period_too_long"
    : undefined;
}

/** The query of `adminExportAudit` for exportable filters: those of the list, without the cursor. */
export function auditExportQuery(
  filters: AuditFilters & { readonly from: string; readonly to: string },
): NarrowingQuery & { from: string; to: string } {
  return { ...narrowingQuery(filters), from: instantOf(filters.from), to: instantOf(filters.to, 1) };
}

/**
 * The `Content-Disposition` of the export, as the API names its file (`velexis-audit-<from date>-<to date>.csv`, the
 * UTC days of the API's period, so `to` is the day after the last day shown).
 */
export function exportDisposition(filters: { from: string; to: string }): string {
  return `attachment; filename="velexis-audit-${filters.from}-${instantOf(filters.to, 1).slice(0, 10)}.csv"`;
}

/** The URL path of the CSV export. */
export const EXPORT_PATH = "/audit/export.csv";

/** The export link of the filters: the same URL parameters as the list, without the cursor. */
export function exportHref(filters: AuditFilters): string {
  const query = new URLSearchParams();
  for (const name of AUDIT_FILTER_PARAMS) {
    const value = filters[name];
    if (value !== undefined) {
      query.set(name, value);
    }
  }
  const text = query.toString();
  return text === "" ? EXPORT_PATH : `${EXPORT_PATH}?${text}`;
}

/** One row of `adminListAudit` (and of the `recentAudit` of an account). */
export type AuditRow = Schemas["AuditEntry"];

/**
 * The fields of a row that `AuditTable` shows. The rows go to that client component, so everything they hold is sent
 * to the browser: the pages pass only these fields, whatever else an answer might carry. (A server component cannot
 * call a function of a client module, so this lives here.)
 */
export function auditRowOf(row: AuditRow): AuditRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantKey: row.tenantKey,
    actorType: row.actorType,
    actorAccountId: row.actorAccountId,
    actorLabel: row.actorLabel,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    requestId: row.requestId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    details: row.details,
    createdAt: row.createdAt,
  };
}

/** A link to the audit search with `filters` (an empty set gives the bare path). */
export function auditHref(filters: Partial<Record<AuditFilterParam, string>>): string {
  const query = new URLSearchParams();
  for (const name of AUDIT_FILTER_PARAMS) {
    const value = filters[name];
    if (value !== undefined) {
      query.set(name, value);
    }
  }
  const text = query.toString();
  return text === "" ? "/audit" : `/audit?${text}`;
}
