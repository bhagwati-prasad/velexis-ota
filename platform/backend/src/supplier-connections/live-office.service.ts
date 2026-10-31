// The live Amadeus office of an OTA (PBE-054; platform/docs/flows/amadeus-connection.md §C, PADR-0012 item 3,
// platform/docs/api-inventory-resources.md §3; scope PF-51): the owner's request for live access on the Velexis
// account, and the e-mail to the owners once a platform admin has assigned a live office.
//
// `requestLiveAmadeus` (owners only, TenantRoleGuard; `FEATURE_LIVE_SWITCH`, FeatureGuard): in one transaction,
//
// 1. the tenant's row `FOR SHARE` with its plan's limits (gone or not visible to members: `404 NOT_FOUND`), so a
//    suspension waits for the request or the request sees it. A plan without `limits.liveMode = true` answers `403
//    FEATURE_DISABLED` (`details.feature = live_switch`, as the switch does: PADR-0015 item 2 combines the plan with
//    the switch), then an OTA that is not `active` `409 TENANT_NOT_ACTIVE` with `details.status`;
// 2. under the tenant's connection lock of `live` (`lockTenantEnvironment`, the lock an admin's assignment and the
//    verification of own credentials take too), a live connection of any source answers `409 CONFLICT`
//    (`live_connection_exists`: one is waiting or active already, or the OTA brought its own live credentials);
// 3. without a Velexis live Amadeus account the request is refused with `409 CONFLICT` (`live_account_missing`), and
//    ops get an `ops.alert` (at most one per OTA and UTC day), committed although the request is refused;
// 4. otherwise the live `velexis` connection is inserted on the live account without an office (`office_ids = {}`,
//    `pending_verification`, `insertPendingVelexis`), with the audit row `amadeus.live_requested` (the optional note in
//    `details`), an `ops.alert` to OPS_ALERT_EMAIL with the note, and after the commit a `connection` invalidation (the
//    OTA backend may hold a cached "no live connection"). The answer is `202` with the connection, as the list maps it.
//
// A platform admin then completes the commercial onboarding outside the system and assigns a live office
// (`adminAssignAmadeusOffice`, AmadeusOfficesService), which makes the connection `active` and calls `notifyLiveReady`
// in its transaction: the e-mail `amadeus.live_ready` to every active owner, once per owner and connection version.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { OutboxService } from "../notifications/outbox.service";
import { AmadeusAccountsRepository, type AmadeusEnvironment } from "./amadeus-accounts.repository";
import {
  SupplierConnectionsRepository,
  toAmadeusConnection,
  type AmadeusConnection,
  type LiveRequestTenant,
} from "./supplier-connections.repository";

export type RequestLiveAmadeusRequest = components["schemas"]["RequestLiveAmadeusRequest"];

/** The environment of a live office request. */
export const LIVE_ENVIRONMENT = "live" satisfies AmadeusEnvironment;

/** The template of the e-mail to the owners once a live office is assigned (PADR-0013 item 5, note of 2026-10-31). */
export const LIVE_READY_TEMPLATE = "amadeus.live_ready";

/** Tenant statuses whose members see the OTA: any other answers `404` (TenantRoleGuard refuses them first). */
const VISIBLE_STATUSES: ReadonlySet<string> = new Set(MEMBER_VISIBLE_TENANT_STATUSES);

/**
 * True when a plan's `limits` allow live mode: `liveMode` is `true` (the rule of `PlanLimits` in listPlans, so a plan
 * with incomplete limits never allows it).
 */
export function planAllowsLiveMode(limits: unknown): boolean {
  return (
    limits !== null &&
    typeof limits === "object" &&
    !Array.isArray(limits) &&
    (limits as Record<string, unknown>)["liveMode"] === true
  );
}

/** The OTA a live office alert names. */
export interface LiveAlertTenant {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** The `ops.alert` of a live office request: who asked, the OTA's note and what ops do next. */
export function liveRequestAlert(
  tenant: LiveAlertTenant,
  connectionId: string,
  amadeusAccountId: string,
  note: string | undefined,
): { title: string; message: string } {
  return {
    title: `Live Amadeus office requested: ${tenant.name} (${tenant.key})`,
    message:
      `The owner of ${tenant.name} (${tenant.key}, ${tenant.id}) asked for live Amadeus access on the Velexis live ` +
      `account ${amadeusAccountId}. Its live connection ${connectionId} waits (pending_verification) without an ` +
      "office.\n" +
      (note === undefined ? "The OTA left no note.\n" : `Note from the OTA: ${note}\n`) +
      "Complete the commercial onboarding with the OTA (contract, ticketing agreement) outside the system and record " +
      "it in the office notes, then assign a live office to the OTA in the platform admin (Amadeus, Offices).",
  };
}

/** The `ops.alert` of a live office request refused because Velexis has no live Amadeus account yet. */
export function liveAccountMissingAlert(tenant: LiveAlertTenant): { title: string; message: string } {
  return {
    title: `Live Amadeus request without a Velexis live account: ${tenant.name} (${tenant.key})`,
    message:
      `The owner of ${tenant.name} (${tenant.key}, ${tenant.id}) asked for live Amadeus access, but there is no ` +
      "Velexis live Amadeus account yet, so the request was refused (409 CONFLICT, live_account_missing) and nothing " +
      "was stored.\n" +
      "Create the live account in the platform admin (Amadeus, Accounts), then ask the OTA to request live access " +
      "again.",
  };
}

/** The office and connection a live assignment gave the OTA, for the live-ready e-mail. */
export interface LiveReadyAssignment {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantKey: string;
  readonly officeId: string;
  readonly connectionId: string;
  readonly connectionVersion: number;
}

/** What the request's transaction ended with: the new connection, or the refusal whose alert it committed. */
type LiveRequestOutcome =
  | { readonly kind: "requested"; readonly connection: AmadeusConnection }
  | { readonly kind: "live_account_missing" };

@Injectable()
export class LiveOfficeService {
  constructor(
    private readonly connections: SupplierConnectionsRepository,
    private readonly accounts: AmadeusAccountsRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** requestLiveAmadeus: the OTA's live `velexis` connection, waiting for an office (see the file header). */
  async requestLive(
    membership: TenantMembership,
    request: RequestLiveAmadeusRequest | undefined,
  ): Promise<AmadeusConnection> {
    const { tenantId, accountId } = membership;
    const note = request?.note;
    const now = this.clock.now();
    const outcome = await runInTransaction(this.db, async (trx): Promise<LiveRequestOutcome> => {
      const tenant = await this.requestingTenant(trx, tenantId);
      const alertTenant: LiveAlertTenant = { id: tenantId, key: tenant.key, name: tenant.name };
      await this.connections.lockTenantEnvironment(trx, tenantId, LIVE_ENVIRONMENT);
      if ((await this.connections.lockForTenant(trx, tenantId, LIVE_ENVIRONMENT)) !== undefined) {
        throw new AppError("CONFLICT", { details: { reason: "live_connection_exists" } });
      }
      const account = (await this.accounts.list(trx)).find((row) => row.environment === LIVE_ENVIRONMENT);
      if (account === undefined) {
        await this.outbox.queueOpsAlert(trx, {
          ...liveAccountMissingAlert(alertTenant),
          tenantId,
          idempotencyKey: `amadeus.live_account_missing:${tenantId}:${now.toISOString().slice(0, 10)}`,
        });
        return { kind: "live_account_missing" };
      }

      const connection = await this.connections.insertPendingVelexis(trx, {
        id: this.ids.new("sc"),
        tenantId,
        environment: LIVE_ENVIRONMENT,
        amadeusAccountId: account.id,
        createdByAccountId: accountId,
        now,
      });
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "amadeus.live_requested",
        targetType: "supplier_connection",
        targetId: connection.id,
        tenantId,
        after: {
          environment: LIVE_ENVIRONMENT,
          credentialSource: connection.credential_source,
          status: connection.status,
          amadeusAccountId: account.id,
        },
        details: { environment: LIVE_ENVIRONMENT, ...(note === undefined ? {} : { note }) },
      });
      await this.outbox.queueOpsAlert(trx, {
        ...liveRequestAlert(alertTenant, connection.id, account.id, note),
        tenantId,
        idempotencyKey: `amadeus.live_requested:${connection.id}`,
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
      return { kind: "requested", connection: toAmadeusConnection(connection) };
    });
    if (outcome.kind === "live_account_missing") {
      throw new AppError("CONFLICT", { details: { reason: "live_account_missing" } });
    }
    return outcome.connection;
  }

  /**
   * Queues `amadeus.live_ready` in `trx` to every active owner of the OTA a live office was just assigned to (PBE-054
   * step 2, flows/amadeus-connection.md §C item 3), once per owner and connection version, with the office and a link
   * to the portal's Amadeus page. The caller's transaction is the assignment's (AmadeusOfficesService.assign).
   */
  async notifyLiveReady(trx: PlatformTransaction, assignment: LiveReadyAssignment): Promise<void> {
    const amadeusUrl = this.outbox.portalLink(`/otas/${assignment.tenantId}/amadeus`);
    for (const owner of await this.connections.activeOwners(trx, assignment.tenantId)) {
      await this.outbox.queue(trx, {
        templateKey: LIVE_READY_TEMPLATE,
        to: owner.email,
        accountId: owner.account_id,
        tenantId: assignment.tenantId,
        data: {
          fullName: owner.full_name,
          tenantName: assignment.tenantName,
          tenantKey: assignment.tenantKey,
          officeId: assignment.officeId,
          amadeusUrl,
        },
        idempotencyKey: `amadeus_live_ready:${assignment.connectionId}:${assignment.connectionVersion}`,
      });
    }
  }

  /**
   * The requesting tenant, read `FOR SHARE` (step 1 of the file header): `404` when it is gone, `403 FEATURE_DISABLED`
   * without live mode in its plan, `409 TENANT_NOT_ACTIVE` unless `active`, in this order.
   */
  private async requestingTenant(trx: PlatformTransaction, tenantId: string): Promise<LiveRequestTenant> {
    const tenant = await this.connections.tenantForLiveRequest(trx, tenantId);
    if (tenant === undefined || !VISIBLE_STATUSES.has(tenant.status)) {
      throw new AppError("NOT_FOUND");
    }
    if (!planAllowsLiveMode(tenant.limits)) {
      throw new AppError("FEATURE_DISABLED", { details: { feature: "live_switch" } });
    }
    if (tenant.status !== "active") {
      throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenant.status } });
    }
    return tenant;
  }
}
