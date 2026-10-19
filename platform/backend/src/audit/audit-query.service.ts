// The reads of `platform_audit_log` (PBE-032; platform/docs/api-inventory-admin.md §7, flows/platform-admin-operations.md
// §I, PADR-0006 "Audit", scope PF-85): the admin's audit search, the CSV export and the recent rows of an account.
// AuditModule owns the table (architecture §2.1), so the admin reaches it only through this service
// (`AuditModule.forApi()`). The rows were redacted when they were written (AuditService), so they are answered as
// stored.
//
// - adminListAudit (`list`): newest first (the identity `id`, which grows with every insert), filtered by OTA, acting
//   account, actor type, exact action, target type and id, and period (`from` inclusive, `to` exclusive, on
//   `created_at`; `from` after `to` answers `400 VALIDATION_FAILED` on `/query/from`). The cursor is opaque: base64url
//   of `{"id": "<row id>"}`, the last row of the page; anything else, or the id of no row, answers `400` on
//   `/query/cursor`.
// - adminExportAudit (`startExport`): the same filters, with a required period of at most one calendar year (`400`
//   on `/query/to` when longer). It first writes its own audit row `audit.exported` (`actor_type = 'platform_admin'`,
//   the filters and the period in `details`: the export is a sensitive read, PADR-0006 Audit item 2) and reads the
//   first batch of rows, so a database failure before any byte is sent still answers the error envelope. The file is
//   then streamed in batches of EXPORT_BATCH_ROWS rows (one query each, newest first, keyset on `id`), at most
//   EXPORT_MAX_ROWS rows; audit-csv.ts writes the records. A failure in the middle of the stream is logged
//   (`audit.export_failed`, the error only) and ends the stream with the error, so the controller aborts the answer
//   instead of ending a truncated file as if it were complete.
// - adminGetAccount's `recentAudit` (`recentForAccount`): the last 50 rows the account acted in or that target it.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import {
  auditCsvHeader,
  auditCsvRecord,
  auditExportDisposition,
  auditExportFilename,
  type AuditEntry,
} from "./audit-csv";
import { AuditService } from "./audit.service";

export type { AuditEntry };
export type AuditEntryList = components["schemas"]["AuditEntryList"];
type AuditActorType = components["schemas"]["AuditActorType"];

/** The filters of adminListAudit and adminExportAudit, as the validation interceptor passes them on. */
export interface AuditFilters {
  readonly tenantId?: string | undefined;
  readonly actorAccountId?: string | undefined;
  readonly actorType?: AuditActorType | undefined;
  readonly action?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  /** RFC 3339 date-time: rows written at or after it. */
  readonly from?: string | undefined;
  /** RFC 3339 date-time: rows written before it. */
  readonly to?: string | undefined;
}

/** The query of adminListAudit (`limit` defaults to the document's 50). */
export interface ListAuditQuery extends AuditFilters {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The query of adminExportAudit: the period is required (the document says so; the service checks it too). */
export type ExportAuditQuery = AuditFilters;

/** Who exports: the admin of the access token. */
export interface AuditExportActor {
  readonly accountId: string;
}

/** A started export: the answer's headers and the CSV text, in chunks. */
export interface AuditExport {
  readonly filename: string;
  readonly disposition: string;
  /** The header record first, then one chunk per batch of rows. */
  readonly chunks: AsyncIterable<string>;
}

/** The page size without `limit` (the document's default). */
export const DEFAULT_AUDIT_PAGE_LIMIT = 50;

/** The most rows an export holds (api-inventory-admin.md §7). */
export const EXPORT_MAX_ROWS = 100_000;

/** The rows of one query of an export, and of one chunk of the file. */
export const EXPORT_BATCH_ROWS = 1_000;

/** The rows of adminGetAccount's `recentAudit` (the document's `maxItems`). */
export const RECENT_ACCOUNT_AUDIT_ROWS = 50;

/** A row of `platform.platform_audit_log`, as the queries select it. */
interface AuditRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly tenant_key: string | null;
  readonly actor_type: string;
  readonly actor_account_id: string | null;
  readonly actor_label: string | null;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly request_id: string | null;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly details: unknown;
  readonly created_at: Date;
}

const AUDIT_COLUMNS = [
  "id",
  "tenant_id",
  "tenant_key",
  "actor_type",
  "actor_account_id",
  "actor_label",
  "action",
  "target_type",
  "target_id",
  "request_id",
  "ip_address",
  "user_agent",
  "details",
  "created_at",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The API's `AuditEntry` of a row. */
export function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    actorType: row.actor_type as AuditActorType,
    actorAccountId: row.actor_account_id,
    actorLabel: row.actor_label,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    details: isPlainObject(row.details) ? row.details : {},
    createdAt: row.created_at.toISOString(),
  };
}

/** An opaque cursor: base64url of `{"id": "<audit row id>"}`, the last row of the page. */
export function encodeAuditCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

/** The largest audit row id: the identity column is a `bigint`. */
const MAX_AUDIT_ID = 9_223_372_036_854_775_807n;

/** The audit row id of a cursor of this list, or `undefined` when it is not one. */
export function decodeAuditCursor(cursor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isPlainObject(value)) {
      return undefined;
    }
    const id = value["id"];
    return Object.keys(value).length === 1 &&
      typeof id === "string" &&
      /^[1-9][0-9]{0,18}$/.test(id) &&
      BigInt(id) <= MAX_AUDIT_ID
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

function fieldError(path: string, code: string, message: string): AppError<"VALIDATION_FAILED"> {
  const fieldErrors: FieldError[] = [{ path, code, message }];
  return new AppError("VALIDATION_FAILED", { fieldErrors });
}

/** The instant of a validated date-time parameter; `400` on `/query/<name>` when JavaScript cannot read it. */
function instantOf(value: string | undefined, name: "from" | "to"): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw fieldError(`/query/${name}`, "format", "Must be a date-time such as 2026-10-01T00:00:00Z.");
  }
  return instant;
}

/** A period of the filters, both ends optional. */
export interface AuditPeriod {
  readonly from: Date | undefined;
  readonly to: Date | undefined;
}

/** The period of `filters`; `from` after `to` answers `400` on `/query/from`. */
export function auditPeriod(filters: Pick<AuditFilters, "from" | "to">): AuditPeriod {
  const from = instantOf(filters.from, "from");
  const to = instantOf(filters.to, "to");
  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
    throw fieldError("/query/from", "after_to", "Must not be after to.");
  }
  return { from, to };
}

/** `instant` plus one calendar year (UTC): the latest `to` of an export that starts at `instant`. */
export function oneYearAfter(instant: Date): Date {
  const end = new Date(instant.getTime());
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return end;
}

/** The period of an export: both ends required, `from` not after `to`, at most one year. */
export function exportPeriod(filters: Pick<AuditFilters, "from" | "to">): {
  readonly from: Date;
  readonly to: Date;
} {
  const { from, to } = auditPeriod(filters);
  if (from === undefined) {
    throw fieldError("/query/from", "required", "Is required.");
  }
  if (to === undefined) {
    throw fieldError("/query/to", "required", "Is required.");
  }
  if (to.getTime() > oneYearAfter(from).getTime()) {
    throw fieldError("/query/to", "range", "The period may span at most one year.");
  }
  return { from, to };
}

/** The filters that narrow the rows, without the period (the audit row of an export names them). */
function narrowingFilters(filters: AuditFilters): Record<string, string> {
  const named: Record<string, string> = {};
  for (const key of [
    "tenantId",
    "actorAccountId",
    "actorType",
    "action",
    "targetType",
    "targetId",
  ] as const) {
    const value = filters[key];
    if (value !== undefined) {
      named[key] = value;
    }
  }
  return named;
}

@Injectable()
export class AuditQueryService {
  constructor(
    private readonly audit: AuditService,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(AuditQueryService.name) private readonly logger: PinoLogger,
  ) {}

  /** adminListAudit (see the file header). */
  async list(query: ListAuditQuery): Promise<AuditEntryList> {
    const period = auditPeriod(query);
    const limit = query.limit ?? DEFAULT_AUDIT_PAGE_LIMIT;
    let beforeId: string | undefined;
    if (query.cursor !== undefined) {
      beforeId = decodeAuditCursor(query.cursor);
      if (beforeId === undefined || !(await this.exists(beforeId))) {
        throw fieldError("/query/cursor", "cursor", "Is not a cursor of this list.");
      }
    }
    const rows = await this.page(query, period, beforeId, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAuditEntry),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeAuditCursor(last.id) : null,
        limit,
      },
    };
  }

  /** adminGetAccount's `recentAudit`: the last rows `accountId` acted in or that target it, newest first. */
  async recentForAccount(accountId: string, limit = RECENT_ACCOUNT_AUDIT_ROWS): Promise<AuditEntry[]> {
    const rows = await this.db
      .selectFrom("platform.platform_audit_log")
      .select(AUDIT_COLUMNS)
      .where((eb) =>
        eb.or([
          eb("actor_account_id", "=", accountId),
          eb.and([eb("target_type", "=", "account"), eb("target_id", "=", accountId)]),
        ]),
      )
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map(toAuditEntry);
  }

  /**
   * adminExportAudit (see the file header): validates the period, writes the export's own audit row, reads the first
   * batch and answers the file's name and its chunks.
   */
  async startExport(actor: AuditExportActor, query: ExportAuditQuery): Promise<AuditExport> {
    const period = exportPeriod(query);
    await runInTransaction(this.db, async (trx) => {
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: actor.accountId,
        action: "audit.exported",
        targetType: "audit_log",
        targetId: null,
        details: {
          filters: narrowingFilters(query),
          from: period.from.toISOString(),
          to: period.to.toISOString(),
          maxRows: EXPORT_MAX_ROWS,
        },
      });
    });
    const first = await this.page(query, period, undefined, EXPORT_BATCH_ROWS);
    return {
      filename: auditExportFilename(period.from, period.to),
      disposition: auditExportDisposition(period.from, period.to),
      chunks: this.csvChunks(query, period, first),
    };
  }

  /** The chunks of an export whose first batch is `first`: the header, then each batch, at most EXPORT_MAX_ROWS rows. */
  private async *csvChunks(
    filters: AuditFilters,
    period: AuditPeriod,
    first: readonly AuditRow[],
  ): AsyncGenerator<string> {
    yield auditCsvHeader();
    let batch = first;
    let written = 0;
    try {
      for (;;) {
        const rows = batch.slice(0, EXPORT_MAX_ROWS - written);
        if (rows.length > 0) {
          yield rows.map((row) => auditCsvRecord(toAuditEntry(row))).join("");
          written += rows.length;
        }
        const last = rows.at(-1);
        if (batch.length < EXPORT_BATCH_ROWS || written >= EXPORT_MAX_ROWS || last === undefined) {
          return;
        }
        batch = await this.page(
          filters,
          period,
          last.id,
          Math.min(EXPORT_BATCH_ROWS, EXPORT_MAX_ROWS - written),
        );
      }
    } catch (error) {
      this.logger.error({ err: error, rowsWritten: written }, "audit.export_failed");
      throw error;
    }
  }

  /** True when an audit row has the id `id`. */
  private async exists(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("platform.platform_audit_log")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Up to `limit` rows of the filters, newest first, older than row `beforeId` when given. */
  private async page(
    filters: AuditFilters,
    period: AuditPeriod,
    beforeId: string | undefined,
    limit: number,
  ): Promise<AuditRow[]> {
    let query = this.db.selectFrom("platform.platform_audit_log").select(AUDIT_COLUMNS);
    const equal = {
      tenant_id: filters.tenantId,
      actor_account_id: filters.actorAccountId,
      actor_type: filters.actorType,
      action: filters.action,
      target_type: filters.targetType,
      target_id: filters.targetId,
    } as const;
    for (const [column, value] of Object.entries(equal) as Array<[keyof typeof equal, string | undefined]>) {
      if (value !== undefined) {
        query = query.where(column, "=", value);
      }
    }
    if (period.from !== undefined) {
      query = query.where("created_at", ">=", period.from);
    }
    if (period.to !== undefined) {
      query = query.where("created_at", "<", period.to);
    }
    if (beforeId !== undefined) {
      query = query.where("id", "<", beforeId);
    }
    return query.orderBy("id", "desc").limit(limit).execute();
  }
}
