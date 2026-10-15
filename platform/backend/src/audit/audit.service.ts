// AuditService.record (PADR-0006, Audit; platform/docs/architecture.md §4): every state change of the platform, and
// every sensitive read, writes one `platform_audit_log` row in the transaction of the change. The service adds what
// the request context knows (request id, the end user's IP and user agent, PADR-0019 item 4) and passes `before`,
// `after` and `details` through the shared redactor of @velexis/logger, so no secret, token or bank number is stored.
//
//   await platformDb.transaction().execute(async (trx) => {
//     await tenants.suspend(trx, tenant.id, reason);
//     await audit.record(trx, {
//       actorType: "platform_admin", actorAccountId: actor.accountId, action: "tenant.suspended",
//       targetType: "tenant", targetId: tenant.id, tenantId: tenant.id,
//       before: { status: "active" }, after: { status: "suspended", suspensionReason: "abuse" }, details: { reason },
//     });
//   });
//
// Outside a request (the worker's jobs and schedulers, the CLI) the context is empty: the row then has no IP and no
// user agent, and the request id is the one the job carries (`entry.requestId`), if any.
import { Injectable, Optional } from "@nestjs/common";
import { redactPayload } from "@velexis/logger";
import { RequestContext, type ActorType } from "../common/http/request-context";
import { isAuditAction, isAuditTargetType, type AuditAction, type AuditTargetType } from "./audit-actions";
import { AuditRepository, type AuditRowInserted, type PlatformTransaction } from "./audit.repository";

/** A plain object of values to record (`before`, `after`); it is redacted before it is stored. */
export type AuditValues = Readonly<Record<string, unknown>>;

/**
 * More facts about the action (the admin's `reason`, an invitation's `email` and `role`, …), stored at the top level of
 * `details`. `before` and `after` are entries of their own, so `details` cannot use those two names.
 */
export type AuditDetails = AuditValues & { readonly before?: never; readonly after?: never };

/** One audit row, as a module records it. */
export interface AuditEntry {
  /** Who acted: an account in the portal, a platform admin, an API key or the system (a job or a CLI command). */
  readonly actorType: ActorType;
  /** `acc_…` of the account; required for `account` and `platform_admin`, absent for `api_key` and `system`. */
  readonly actorAccountId?: string;
  /**
   * A snapshot of the actor: the key prefix for `api_key`, the job or command (and operator) for `system`. For an
   * account it defaults to the account's e-mail address at the time of the action.
   */
  readonly actorLabel?: string;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  /** The id of the object acted on; `null` when the action has no single object (the audit export). */
  readonly targetId: string | null;
  /** `ten_…` of the OTA concerned; absent for account-level actions. */
  readonly tenantId?: string;
  /** A snapshot of the tenant key; defaults to the key of `tenantId` at the time of the action. */
  readonly tenantKey?: string;
  /** The values before the change (only the fields that changed are useful). */
  readonly before?: AuditValues;
  /** The values after the change. */
  readonly after?: AuditValues;
  readonly details?: AuditDetails;
  /**
   * The request id outside an HTTP request: a job carries the `requestId` of the request that queued it. Inside a
   * request the request context's id always wins.
   */
  readonly requestId?: string;
}

/** An entry that breaks the rules of AuditEntry: a programming error, so the caller's transaction rolls back. */
export class InvalidAuditEntryError extends Error {
  override readonly name = "InvalidAuditEntryError";
}

/** The id patterns of the OpenAPI document's `AuditEntry` (`actorAccountId`, `tenantId`). */
const ACCOUNT_ID = /^acc_[0-9A-HJKMNP-TV-Z]{26}$/;
const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The actor types whose rows name an account, and those whose rows never do. */
const ACCOUNT_ACTORS: ReadonlySet<ActorType> = new Set<ActorType>(["account", "platform_admin"]);
const OTHER_ACTORS: ReadonlySet<ActorType> = new Set<ActorType>(["api_key", "system"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Checks an entry that may have reached the service past the compiler (a cast, a value from a job). */
export function assertValidAuditEntry(entry: AuditEntry): void {
  if (!isAuditAction(entry.action)) {
    throw new InvalidAuditEntryError(`unknown audit action ${JSON.stringify(entry.action)}`);
  }
  if (!isAuditTargetType(entry.targetType)) {
    throw new InvalidAuditEntryError(`unknown audit target type ${JSON.stringify(entry.targetType)}`);
  }
  if (ACCOUNT_ACTORS.has(entry.actorType)) {
    if (entry.actorAccountId === undefined || !ACCOUNT_ID.test(entry.actorAccountId)) {
      throw new InvalidAuditEntryError(`an ${entry.actorType} actor needs its acc_ id`);
    }
  } else if (OTHER_ACTORS.has(entry.actorType)) {
    if (entry.actorAccountId !== undefined) {
      throw new InvalidAuditEntryError(`an ${entry.actorType} actor has no account id`);
    }
  } else {
    throw new InvalidAuditEntryError(`unknown actor type ${JSON.stringify(entry.actorType)}`);
  }
  if (entry.tenantId !== undefined && !TENANT_ID.test(entry.tenantId)) {
    throw new InvalidAuditEntryError("tenantId must be a ten_ id");
  }
  for (const key of ["before", "after", "details"] as const) {
    const value = entry[key];
    if (value !== undefined && !isPlainObject(value)) {
      throw new InvalidAuditEntryError(`${key} must be a plain object`);
    }
  }
  if (entry.details !== undefined && ("before" in entry.details || "after" in entry.details)) {
    throw new InvalidAuditEntryError(
      "details cannot hold before or after: pass them as entries of their own",
    );
  }
}

/**
 * The `details` object of a row: the caller's details, then `before` and `after` when given (the shape of the OpenAPI
 * example: `{reason, before: {…}, after: {…}}`), each passed through `redactPayload`. A deep copy: the caller's objects
 * are never changed.
 */
export function auditDetails(
  entry: Pick<AuditEntry, "before" | "after" | "details">,
): Record<string, unknown> {
  const details: Record<string, unknown> = { ...redactPayload(entry.details ?? {}) };
  if (entry.before !== undefined) {
    details["before"] = redactPayload(entry.before);
  }
  if (entry.after !== undefined) {
    details["after"] = redactPayload(entry.after);
  }
  return details;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    // The API's request context (CommonModule.forApi). The worker and the CLI have none.
    @Optional() private readonly context?: RequestContext,
  ) {}

  /**
   * Inserts the row in `trx`, the caller's open transaction: the row commits and rolls back with the change. Throws
   * InvalidAuditEntryError for an entry that breaks the rules above, before any statement runs.
   */
  async record(trx: PlatformTransaction, entry: AuditEntry): Promise<AuditRowInserted> {
    assertValidAuditEntry(entry);
    const context = this.context?.active === true ? this.context : undefined;
    return this.repository.insert(trx, {
      actorType: entry.actorType,
      actorAccountId: entry.actorAccountId ?? null,
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      tenantId: entry.tenantId ?? null,
      tenantKey: entry.tenantKey ?? null,
      requestId: context?.requestId ?? entry.requestId ?? null,
      ipAddress: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      detailsJson: JSON.stringify(auditDetails(entry)),
    });
  }
}
