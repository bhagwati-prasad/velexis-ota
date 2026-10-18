// The Amadeus office pool of the platform admin (platform/docs/api-inventory-admin.md §5, flows/amadeus-connection.md
// §A and §C, PADR-0012; scope PF-90): list, add in bulk, edit notes, assign to an OTA and retire. Who may call them is
// AdminAuthGuard's (`platform_admin`). This service owns the transactions, their audit rows (`actor_type =
// 'platform_admin'`) and the invalidations after the commit. Release (`adminReleaseAmadeusOffice`) comes in M5
// (PBE-054).
//
// - Add: the ids are upper-cased (the OpenAPI document checks 9 letters or digits); an id that the account's pool holds
//   already, or that repeats an earlier id of the request, is skipped, and both lists keep the request order. One
//   `amadeus_office.added` audit row names the created and skipped ids.
// - Notes: `If-Match` carries the office's version (`412 PRECONDITION_FAILED`); any status.
// - Assign: the office row is locked first and must be `available` (`409 AMADEUS_OFFICE_UNAVAILABLE`), so of two
//   concurrent assignments of one office one wins and the other sees it taken. Then, under the tenant's connection lock
//   of that environment: `409 CONFLICT` when the OTA uses its own credentials there (`tenant_credentials`) or already
//   has an assigned office of that account (`office_already_assigned`). The office becomes `assigned`, and the OTA's
//   `velexis` connection of the environment is created, or completed, with `office_ids = {office}`, the default,
//   queuing and owner offices set to it and `status = 'active'`. After the commit: `connection` and `amadeus_account`
//   invalidations. A tenant that is gone (`deleted`, `deprovisioning`) or unknown answers `404`.
// - Retire: only an `available` office (`409 CONFLICT`, `not_available`), with the admin's reason in the audit row;
//   `amadeus_account` invalidation (an office status changed, platform architecture §6.3).
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import {
  AmadeusAccountsRepository,
  type AmadeusEnvironment,
  type AmadeusOfficeStatus,
} from "./amadeus-accounts.repository";
import {
  AmadeusOfficesRepository,
  type AmadeusOfficeInsert,
  type AmadeusOfficeView,
} from "./amadeus-offices.repository";
import { SupplierConnectionsRepository, toAmadeusConnection } from "./supplier-connections.repository";

export type AdminAmadeusOffice = components["schemas"]["AdminAmadeusOffice"];
export type AdminAmadeusOfficeList = components["schemas"]["AdminAmadeusOfficeList"];
export type AddAmadeusOfficesRequest = components["schemas"]["AddAmadeusOfficesRequest"];
export type AmadeusOfficesAdded = components["schemas"]["AmadeusOfficesAdded"];
export type UpdateAmadeusOfficeRequest = components["schemas"]["UpdateAmadeusOfficeRequest"];
export type AssignAmadeusOfficeRequest = components["schemas"]["AssignAmadeusOfficeRequest"];
export type AmadeusOfficeAssigned = components["schemas"]["AmadeusOfficeAssigned"];
export type AdminReasonRequest = components["schemas"]["AdminReasonRequest"];

/** The query of `adminListAmadeusOffices`, as the validation interceptor coerced it (`limit` defaults to 50). */
export interface ListAmadeusOfficesQuery {
  readonly accountId?: string | undefined;
  readonly environment?: AmadeusEnvironment | undefined;
  readonly status?: AmadeusOfficeStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The page size without `limit` (the document's default). */
export const DEFAULT_OFFICE_PAGE_LIMIT = 50;

/** Tenants that are gone: no office is assigned to them (`404`). */
const GONE_TENANT_STATUSES: ReadonlySet<string> = new Set(["deleted", "deprovisioning"]);

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The API's office of a row with its environment and tenant key. */
export function toAdminAmadeusOffice(row: AmadeusOfficeView): AdminAmadeusOffice {
  return {
    id: row.id,
    amadeusAccountId: row.amadeus_account_id,
    officeId: row.office_id,
    environment: row.environment as AdminAmadeusOffice["environment"],
    status: row.status as AdminAmadeusOffice["status"],
    assignedTenant:
      row.assigned_tenant_id === null || row.tenant_key === null
        ? null
        : { id: row.assigned_tenant_id, key: row.tenant_key },
    assignedAt: iso(row.assigned_at),
    releaseRequestedAt: iso(row.release_requested_at),
    releasedAt: iso(row.released_at),
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/** One entry of a bulk addition, upper-cased, and whether it repeats an earlier entry of the request. */
export interface OfficeIdEntry {
  readonly officeId: string;
  readonly repeat: boolean;
}

/** The entries of a bulk addition in request order, upper-cased, each repeat of an earlier entry marked. */
export function officeIdEntries(officeIds: readonly string[]): OfficeIdEntry[] {
  const seen = new Set<string>();
  return officeIds.map((raw) => {
    const officeId = raw.trim().toUpperCase();
    const repeat = seen.has(officeId);
    seen.add(officeId);
    return { officeId, repeat };
  });
}

/** An opaque cursor: base64url of `{"id": "<office row id>"}`, the last office of the page. */
export function encodeOfficeCursor(officeRowId: string): string {
  return Buffer.from(JSON.stringify({ id: officeRowId }), "utf8").toString("base64url");
}

const OFFICE_ROW_ID = /^amo_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The office row id of a cursor of this list, or `undefined` when it is not one. */
export function decodeOfficeCursor(cursor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const id: unknown = (value as Record<string, unknown>)["id"];
    return Object.keys(value).length === 1 && typeof id === "string" && OFFICE_ROW_ID.test(id)
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "Is not a cursor of this list." }],
  });
}

@Injectable()
export class AmadeusOfficesService {
  constructor(
    private readonly offices: AmadeusOfficesRepository,
    private readonly accounts: AmadeusAccountsRepository,
    private readonly connections: SupplierConnectionsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** adminListAmadeusOffices: one page of offices, oldest first, with the filters of the query. */
  async list(query: ListAmadeusOfficesQuery): Promise<AdminAmadeusOfficeList> {
    const limit = query.limit ?? DEFAULT_OFFICE_PAGE_LIMIT;
    let afterId: string | undefined;
    if (query.cursor !== undefined) {
      afterId = decodeOfficeCursor(query.cursor);
      if (afterId === undefined || !(await this.offices.exists(afterId))) {
        throw invalidCursor();
      }
    }
    const rows = await this.offices.list(
      { accountId: query.accountId, environment: query.environment, status: query.status },
      afterId,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminAmadeusOffice),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeOfficeCursor(last.id) : null,
        limit,
      },
    };
  }

  /** adminAddAmadeusOffices: the new offices of the account's pool, `available`, and the skipped ids. */
  async add(
    claims: Pick<AccessTokenClaims, "sub">,
    request: AddAmadeusOfficesRequest,
  ): Promise<AmadeusOfficesAdded> {
    const entries = officeIdEntries(request.officeIds);
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      const account = await this.accounts.find(request.amadeusAccountId, trx);
      if (account === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const rows: AmadeusOfficeInsert[] = entries
        .filter((entry) => !entry.repeat)
        .map(({ officeId }) => ({
          id: this.ids.new("amo"),
          amadeus_account_id: account.id,
          office_id: officeId,
          notes: request.notes ?? null,
          created_at: now,
          updated_at: now,
        }));
      const inserted = new Map(
        (await this.offices.insertNew(trx, rows)).map((row) => [row.office_id, row] as const),
      );
      const created: AmadeusOfficeView[] = [];
      const skipped: string[] = [];
      for (const { officeId, repeat } of entries) {
        const row = repeat ? undefined : inserted.get(officeId);
        if (row === undefined) {
          skipped.push(officeId);
        } else {
          created.push({ ...row, environment: account.environment, tenant_key: null });
        }
      }
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "amadeus_office.added",
        targetType: "amadeus_account",
        targetId: account.id,
        details: {
          environment: account.environment,
          created: created.map((row) => row.office_id),
          skipped,
          ...(request.notes === undefined ? {} : { notes: request.notes }),
        },
      });
      return { created: created.map(toAdminAmadeusOffice), skipped };
    });
  }

  /** adminUpdateAmadeusOffice: new notes (`null` clears them), with `version + 1` and an audit row. */
  async updateNotes(
    claims: Pick<AccessTokenClaims, "sub">,
    officeRowId: string,
    version: number,
    request: UpdateAmadeusOfficeRequest,
  ): Promise<AdminAmadeusOffice> {
    const notes = request.notes ?? null;
    return runInTransaction(this.db, async (trx) => {
      const office = await this.lockedOffice(trx, officeRowId);
      if (office.version !== version) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (notes !== office.notes) {
        await this.offices.updateNotes(trx, office.id, notes, this.clock.now());
        await this.audit.record(trx, {
          actorType: "platform_admin",
          actorAccountId: claims.sub,
          action: "amadeus_office.updated",
          targetType: "amadeus_office",
          targetId: office.id,
          ...(office.assigned_tenant_id === null ? {} : { tenantId: office.assigned_tenant_id }),
          before: { notes: office.notes },
          after: { notes },
          details: { officeId: office.office_id },
        });
      }
      return toAdminAmadeusOffice(await this.view(trx, office.id));
    });
  }

  /** adminAssignAmadeusOffice: the office assigned to the OTA and its `velexis` connection (see the file header). */
  async assign(
    claims: Pick<AccessTokenClaims, "sub">,
    officeRowId: string,
    request: AssignAmadeusOfficeRequest,
  ): Promise<AmadeusOfficeAssigned> {
    const now = this.clock.now();
    const { tenantId } = request;
    return runInTransaction(this.db, async (trx) => {
      const office = await this.lockedOffice(trx, officeRowId);
      if (office.status !== "available") {
        throw new AppError("AMADEUS_OFFICE_UNAVAILABLE");
      }
      const account = await this.accounts.find(office.amadeus_account_id, trx);
      const tenant = await this.connections.tenant(trx, tenantId);
      if (account === undefined || tenant === undefined || GONE_TENANT_STATUSES.has(tenant.status)) {
        throw new AppError("NOT_FOUND");
      }
      const environment = account.environment as AmadeusEnvironment;
      await this.connections.lockTenantEnvironment(trx, tenantId, environment);
      const existing = await this.connections.lockForTenant(trx, tenantId, environment);
      if (existing !== undefined && existing.credential_source !== "velexis") {
        throw new AppError("CONFLICT", { details: { reason: "tenant_credentials" } });
      }
      if ((await this.offices.assignedTo(trx, account.id, tenantId)) !== undefined) {
        throw new AppError("CONFLICT", { details: { reason: "office_already_assigned" } });
      }

      await this.offices.assign(trx, office.id, tenantId, now);
      const velexisOffice = { amadeusAccountId: account.id, officeId: office.office_id };
      const connection =
        existing === undefined
          ? await this.connections.insertVelexis(trx, {
              ...velexisOffice,
              id: this.ids.new("sc"),
              tenantId,
              environment,
              createdByAccountId: claims.sub,
              now,
            })
          : await this.connections.completeVelexis(trx, existing.id, velexisOffice, now);

      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "amadeus_office.assigned",
        targetType: "amadeus_office",
        targetId: office.id,
        tenantId,
        before: {
          status: office.status,
          ...(existing === undefined
            ? {}
            : { connectionStatus: existing.status, connectionOfficeIds: [...existing.office_ids] }),
        },
        after: {
          status: "assigned",
          tenantId,
          connectionStatus: connection.status,
          connectionOfficeIds: [...connection.office_ids],
        },
        details: {
          officeId: office.office_id,
          environment,
          connectionId: connection.id,
          connectionCreated: existing === undefined,
        },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "amadeus_account", id: account.id });
      return {
        office: toAdminAmadeusOffice(await this.view(trx, office.id)),
        connection: toAmadeusConnection(connection),
      };
    });
  }

  /** adminRetireAmadeusOffice: an available office `retired`, with the reason in the audit row. */
  async retire(
    claims: Pick<AccessTokenClaims, "sub">,
    officeRowId: string,
    request: AdminReasonRequest,
  ): Promise<AdminAmadeusOffice> {
    return runInTransaction(this.db, async (trx) => {
      const office = await this.lockedOffice(trx, officeRowId);
      if (office.status !== "available") {
        throw new AppError("CONFLICT", { details: { reason: "not_available" } });
      }
      await this.offices.retire(trx, office.id, this.clock.now());
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "amadeus_office.retired",
        targetType: "amadeus_office",
        targetId: office.id,
        before: { status: office.status },
        after: { status: "retired" },
        details: { officeId: office.office_id, reason: request.reason },
      });
      this.invalidations.publishAfterCommit(trx, {
        v: 1,
        type: "amadeus_account",
        id: office.amadeus_account_id,
      });
      return toAdminAmadeusOffice(await this.view(trx, office.id));
    });
  }

  /** The office `officeRowId`, locked; `404 NOT_FOUND` when there is none. */
  private async lockedOffice(trx: PlatformTransaction, officeRowId: string) {
    const office = await this.offices.lock(trx, officeRowId);
    if (office === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return office;
  }

  /** The office as stored now in `trx`, with its environment and tenant key. */
  private async view(trx: PlatformTransaction, officeRowId: string): Promise<AmadeusOfficeView> {
    const view = await this.offices.findView(officeRowId, trx);
    if (view === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return view;
  }
}
