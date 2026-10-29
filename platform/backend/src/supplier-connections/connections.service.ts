// The Amadeus connection use cases of the portal (platform/docs/api-inventory-resources.md §3, flows/
// amadeus-connection.md §E; scope PF-53). Who may call them is TenantRoleGuard's (the membership arrives here checked);
// this service owns the transaction of a change, its audit row and the `connection` invalidation after the commit
// (architecture §4).
//
// `list` (`listAmadeusConnections`, PBE-027) reads the OTA's connections without the client secret's ciphertext.
//
// `updateSettings` (`updateAmadeusConnection`, PBE-040; owners and admins, `If-Match`) changes the settings the OTA
// backend applies to Amadeus calls in one environment: the default, queuing and owner offices, the ticketing defaults
// of new flight orders and the queues it polls into its queue snapshots. A field that is sent replaces the stored
// value (`ticketingDefaults` as a whole object, `monitoredQueues` as a whole list); the offices themselves
// (`office_ids`), the credentials and the status are never changed here.
//
// 1. The request validation has checked the body against `UpdateAmadeusConnectionRequest` (shapes, the 9-character
//    office ids, queue numbers 0–99, at most 20 distinct queues, at least one field).
// 2. One transaction (`runInTransaction`): the tenant's row with `FOR SHARE` (gone, or not visible to members: `404
//    NOT_FOUND`), so a suspension waits for this change or this change sees it; then the connection of `environment`,
//    locked and read without the client secret's ciphertext (`404 NOT_FOUND` without one). A stale `If-Match` answers
//    `412 PRECONDITION_FAILED`, a tenant that is not `active` `409 TENANT_NOT_ACTIVE` with `details.status` (PADR-0014
//    item 5: a suspended OTA's connections are read-only), in this order, as updatePaymentConnection does.
// 3. Every office id of the body must be one of the connection's `office_ids` (`officeProblems`): the three office
//    defaults (PBE-040 step 1) and, as the document's rules say, the `officeId` of each `ticketingDefaults.
//    automatedProcess` entry and of each monitored queue, because the OTA backend acts on the shared Velexis account
//    only for the OTA's own offices (ADR-0012, office isolation). Another office answers `400 VALIDATION_FAILED` with a
//    field error on each such field (the message never holds the value). The check needs the locked row, so it comes
//    after the version: a caller with a stale copy of the offices reloads first.
// 4. The fields that differ from the stored values (`settingsChanges`; jsonb compared by value, whatever the order of
//    an object's keys, a list in its order) are written with `version + 1`, audited once as `amadeus.settings_updated`
//    (the changed fields before and after, and the environment: office ids and queue numbers, no secret), and
//    `{type: "connection", tenantId}` is published after the commit, so the OTA backend drops its cached connection and
//    uses the new settings within seconds. A body that changes nothing writes, audits and publishes nothing, and the
//    connection is answered as it is (as updatePaymentConnection and updateTenant do).
//
// The answer is the row without its ciphertext; the controller maps it with `toAmadeusConnection` (never the secret)
// and sets `ETag`. "Now" is the injected Clock's time.
import { isDeepStrictEqual } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import { AuditService } from "../audit/audit.service";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import type { AmadeusEnvironment } from "./amadeus-accounts.repository";
import {
  SupplierConnectionsRepository,
  type SupplierConnectionSettings,
  type SupplierConnectionView,
} from "./supplier-connections.repository";

export type UpdateAmadeusConnectionRequest = components["schemas"]["UpdateAmadeusConnectionRequest"];

/** The message of a field error for an office outside the connection's offices; it never holds the value. */
export const NOT_A_CONNECTION_OFFICE = "Must be one of the connection's offices (officeIds).";

/** The office defaults of the request, each with the column it replaces. */
const OFFICE_FIELDS = [
  ["defaultOfficeId", "default_office_id"],
  ["queuingOfficeId", "queuing_office_id"],
  ["ownerOfficeId", "owner_office_id"],
] as const;

/** The jsonb settings of the request, each with the column it replaces. */
const JSON_FIELDS = [
  ["ticketingDefaults", "ticketing_defaults"],
  ["monitoredQueues", "monitored_queues"],
] as const;

const VISIBLE_STATUSES: ReadonlySet<string> = new Set(MEMBER_VISIBLE_TENANT_STATUSES);

/**
 * A field error for each office id of `request` that is not one of `officeIds`, in the order of the body: the three
 * office defaults, then each `ticketingDefaults.automatedProcess` entry and each monitored queue. Empty when every
 * office id of the body is one of the connection's.
 */
export function officeProblems(
  request: UpdateAmadeusConnectionRequest,
  officeIds: readonly string[],
): FieldError[] {
  const allowed = new Set(officeIds);
  const problems: FieldError[] = [];
  const check = (path: string, officeId: string | undefined): void => {
    if (officeId !== undefined && !allowed.has(officeId)) {
      problems.push({ path, code: "unknown", message: NOT_A_CONNECTION_OFFICE });
    }
  };
  for (const [field] of OFFICE_FIELDS) {
    check(`/${field}`, request[field]);
  }
  (request.ticketingDefaults?.automatedProcess ?? []).forEach((entry, index) => {
    check(`/ticketingDefaults/automatedProcess/${index}/officeId`, entry.officeId);
  });
  (request.monitoredQueues ?? []).forEach((queue, index) => {
    check(`/monitoredQueues/${index}/officeId`, queue.officeId);
  });
  return problems;
}

/** The fields of a request that differ from the stored settings: the columns to write, and the audit's values. */
export interface SettingsChanges {
  /** The columns to write; empty when the request changes nothing. */
  readonly columns: SupplierConnectionSettings;
  /** The changed fields as the API names them, with the stored values. */
  readonly before: Readonly<Record<string, unknown>>;
  /** The changed fields as the API names them, with the requested values. */
  readonly after: Readonly<Record<string, unknown>>;
}

/**
 * The fields of `request` that differ from the stored settings of `current`. An office compares as text; the jsonb
 * settings compare by value (`isDeepStrictEqual`: an object's keys in any order, as PostgreSQL's jsonb reorders them;
 * a list in its order, since the poller reads the queues in it). A field that is not sent is not a change.
 */
export function settingsChanges(
  current: Pick<
    SupplierConnectionView,
    "default_office_id" | "queuing_office_id" | "owner_office_id" | "ticketing_defaults" | "monitored_queues"
  >,
  request: UpdateAmadeusConnectionRequest,
): SettingsChanges {
  const columns: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [field, column] of [...OFFICE_FIELDS, ...JSON_FIELDS]) {
    const requested: unknown = request[field];
    const stored: unknown = current[column];
    if (requested === undefined || isDeepStrictEqual(requested, stored)) {
      continue;
    }
    columns[column] = requested;
    before[field] = stored;
    after[field] = requested;
  }
  return { columns: columns as SupplierConnectionSettings, before, after };
}

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly connections: SupplierConnectionsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** listAmadeusConnections: the tenant's Amadeus connections, `test` first, read without the secret's ciphertext. */
  async list(tenantId: string): Promise<SupplierConnectionView[]> {
    return this.connections.listForTenant(tenantId);
  }

  /**
   * updateAmadeusConnection: replaces the settings `request` sends on the tenant's Amadeus connection of `environment`
   * when `expectedVersion` is the connection's version, the tenant is `active` and every office id of the body is one
   * of the connection's offices (see the file header).
   */
  async updateSettings(
    membership: TenantMembership,
    environment: AmadeusEnvironment,
    expectedVersion: number,
    request: UpdateAmadeusConnectionRequest,
  ): Promise<SupplierConnectionView> {
    const { tenantId, accountId } = membership;
    return runInTransaction(this.db, async (trx) => {
      const tenantStatus = await this.connections.tenantStatusForShare(trx, tenantId);
      if (tenantStatus === undefined || !VISIBLE_STATUSES.has(tenantStatus)) {
        throw new AppError("NOT_FOUND");
      }
      const current = await this.connections.lockViewForTenant(trx, tenantId, environment);
      if (current === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (current.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (tenantStatus !== "active") {
        throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenantStatus } });
      }
      const problems = officeProblems(request, current.office_ids);
      if (problems.length > 0) {
        throw new AppError("VALIDATION_FAILED", { fieldErrors: problems });
      }
      const { columns, before, after } = settingsChanges(current, request);
      if (Object.keys(columns).length === 0) {
        return current;
      }
      const updated = await this.connections.updateSettings(trx, current.id, columns, this.clock.now());
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "amadeus.settings_updated",
        targetType: "supplier_connection",
        targetId: current.id,
        tenantId,
        before,
        after,
        details: { environment },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
      return updated;
    });
  }
}
