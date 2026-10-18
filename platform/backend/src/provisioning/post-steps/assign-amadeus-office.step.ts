// Post-step `assign_amadeus_office` (PBE-022; platform/docs/flows/provisioning.md §3, flows/amadeus-connection.md §B,
// PADR-0012 item 2; scope PF-50): the new OTA's Amadeus test connection through the Velexis shared account.
//
// Under the tenant's connection lock of `test` (`SupplierConnectionsRepository.lockTenantEnvironment`, the lock an
// admin's assignment takes too):
//
// - The tenant has a `test` connection already (an admin assigned an office first): nothing changes; `succeeded`.
// - No Velexis `test` account row at all: no connection can exist (the composite foreign key needs the account); the
//   step is `skipped`, and ops get an `ops.alert`.
// - The account is `active` and its pool has an `available` office: the oldest one (`created_at`, then id), taken with
//   `FOR UPDATE SKIP LOCKED` so concurrent provisionings get different offices, becomes `assigned` to the tenant, and
//   the `velexis` connection is inserted with `office_ids = {office}`, the default, queuing and owner offices set to it
//   and `status = 'active'`; audit `amadeus_office.assigned` (actor `system`); after the commit an `amadeus_account`
//   invalidation (an office status changed). The job's `result.officeId` is the Amadeus office id. An office the
//   tenant holds already for the account (the partial unique index allows one) is used instead of a new one.
// - Otherwise (no free office, or the account is not `active`): the `velexis` connection is inserted without an office,
//   `pending_verification`, and ops get an `ops.alert`; the tenant still becomes active (no free office is not a
//   provisioning failure), and an admin assigns an office later (`adminAssignAmadeusOffice`).
//
// The alert is queued in the step's transaction with the idempotency key `provisioning.assign_amadeus_office:<jobId>`,
// so a retried step queues it once.
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../../audit/audit.repository";
import { AuditService } from "../../audit/audit.service";
import { IdGenerator } from "../../common/ids";
import { InvalidationPublisher } from "../../common/redis/invalidation.publisher";
import { OutboxService } from "../../notifications/outbox.service";
import {
  AmadeusAccountsRepository,
  type AmadeusAccountRecord,
} from "../../supplier-connections/amadeus-accounts.repository";
import {
  AmadeusOfficesRepository,
  type AmadeusOfficeRecord,
} from "../../supplier-connections/amadeus-offices.repository";
import { SupplierConnectionsRepository } from "../../supplier-connections/supplier-connections.repository";
import type { PostStepJobRow } from "../provisioning-jobs.repository";
import { PROVISIONING_ACTOR_LABEL } from "./activate.step";
import type { PostStep, PostStepContext, PostStepOutcome } from "./post-steps.runner";

/** The environment of the office a new OTA gets: its storefront starts in test (live offices come in M5). */
export const PROVISIONING_AMADEUS_ENVIRONMENT = "test";

/** The step's name, also the prefix of its alert's idempotency key. */
const STEP = "assign_amadeus_office";

/** Why the OTA got no office. */
export type NoOfficeReason = "no_account" | "account_not_active" | "pool_empty";

/** The `ops.alert` of an OTA without a test office. */
export function noOfficeAlert(
  tenant: Pick<PostStepJobRow, "tenant_id" | "tenant_key">,
  reason: NoOfficeReason,
  account?: Pick<AmadeusAccountRecord, "id" | "status">,
): { title: string; message: string } {
  const what =
    reason === "no_account"
      ? "There is no Velexis Amadeus test account, so the OTA has no Amadeus test connection at all."
      : reason === "account_not_active"
        ? `The Velexis Amadeus test account ${account?.id ?? ""} is ${account?.status ?? "not active"}, so the OTA's ` +
          "test connection waits (pending_verification) without an office."
        : "No test office is available in the pool, so the OTA's test connection waits (pending_verification) " +
          "without an office.";
  const action =
    reason === "no_account"
      ? "Create the test account in the platform admin (Amadeus, Accounts), then assign an office to the OTA."
      : "Add offices to the pool or fix the account in the platform admin (Amadeus), then assign an office to the OTA.";
  return {
    title: `No Amadeus test office for the new OTA ${tenant.tenant_key}`,
    message: `The OTA ${tenant.tenant_key} (${tenant.tenant_id}) is active. ${what} ${action}`,
  };
}

@Injectable()
export class AssignAmadeusOfficeStep implements PostStep {
  readonly name = STEP;

  constructor(
    private readonly accounts: AmadeusAccountsRepository,
    private readonly offices: AmadeusOfficesRepository,
    private readonly connections: SupplierConnectionsRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
  ) {}

  async run({ trx, job, event, now }: PostStepContext): Promise<PostStepOutcome> {
    const tenantId = job.tenant_id;
    const environment = PROVISIONING_AMADEUS_ENVIRONMENT;
    await this.connections.lockTenantEnvironment(trx, tenantId, environment);
    const existing = await this.connections.lockForTenant(trx, tenantId, environment);
    if (existing !== undefined) {
      const officeId = existing.credential_source === "velexis" ? existing.default_office_id : null;
      return { status: "succeeded", ...(officeId === null ? {} : { result: { officeId } }) };
    }

    const account = (await this.accounts.list(trx)).find((row) => row.environment === environment);
    if (account === undefined) {
      await this.alert(trx, job, "no_account");
      return { status: "skipped" };
    }
    const office =
      account.status === "active" ? await this.officeFor(trx, account.id, tenantId, now) : undefined;
    if (office === undefined) {
      await this.connections.insertPendingVelexis(trx, {
        id: this.ids.new("sc"),
        tenantId,
        environment,
        amadeusAccountId: account.id,
        createdByAccountId: null,
        now,
      });
      await this.alert(trx, job, account.status === "active" ? "pool_empty" : "account_not_active", account);
      return { status: "succeeded" };
    }

    const connection = await this.connections.insertVelexis(trx, {
      id: this.ids.new("sc"),
      tenantId,
      environment,
      amadeusAccountId: account.id,
      officeId: office.office_id,
      createdByAccountId: null,
      now,
    });
    await this.audit.record(trx, {
      actorType: "system",
      actorLabel: PROVISIONING_ACTOR_LABEL,
      action: "amadeus_office.assigned",
      targetType: "amadeus_office",
      targetId: office.id,
      tenantId,
      tenantKey: job.tenant_key,
      before: { status: office.status },
      after: { status: "assigned", tenantId, connectionStatus: connection.status },
      details: {
        officeId: office.office_id,
        environment,
        connectionId: connection.id,
        connectionCreated: true,
        jobId: job.id,
      },
      requestId: event.requestId,
    });
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "amadeus_account", id: account.id });
    return { status: "succeeded", result: { officeId: office.office_id } };
  }

  /**
   * The office the tenant gets from the account's pool: one it holds already, else the oldest available one, which
   * becomes `assigned` to it. `undefined` when the pool has none free.
   */
  private async officeFor(
    trx: PlatformTransaction,
    accountId: string,
    tenantId: string,
    now: Date,
  ): Promise<AmadeusOfficeRecord | undefined> {
    const held = await this.offices.assignedTo(trx, accountId, tenantId);
    if (held !== undefined) {
      return held;
    }
    const office = await this.offices.lockOldestAvailable(trx, accountId);
    if (office !== undefined) {
      await this.offices.assign(trx, office.id, tenantId, now);
    }
    return office;
  }

  private async alert(
    trx: PlatformTransaction,
    job: PostStepJobRow,
    reason: NoOfficeReason,
    account?: AmadeusAccountRecord,
  ): Promise<void> {
    await this.outbox.queueOpsAlert(trx, {
      ...noOfficeAlert(job, reason, account),
      tenantId: job.tenant_id,
      idempotencyKey: `provisioning.${STEP}:${job.id}`,
    });
  }
}
