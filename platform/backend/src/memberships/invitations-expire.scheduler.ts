// `invitations.expire` (platform/docs/architecture.md §5, hourly at minute 5; flows/team-and-ota-admin-sso.md §A step
// 4, PBE-026): the `pending` invitations whose `expires_at` has passed become `expired`, and each gets an
// `invitation.expired` audit row of the system (`actorLabel` = the schedule). Their links stopped working at
// `expires_at` already (InvitationsService checks the expiry at use); the job makes the state visible, frees their
// seats and their addresses for new invitations, and takes them out of the pending list.
//
// The run works in batches of INVITATIONS_EXPIRE_BATCH_SIZE invitations, one transaction each (the updates and their
// audit rows commit together), and skips rows another transaction holds (an acceptance, a resend or a revocation under
// way), which decides on them; the next run takes those still due. A database failure fails the job, and BullMQ tries
// again with the defaults of ADR-0009; the batches committed before the failure stay done. The run logs
// `invitations.expired` with the count when it expired any, never an address.
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../audit/audit.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { MaintenanceJob, type MaintenanceJobHandler } from "../common/queues/maintenance.processor";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { InvitationsRepository, type InvitationStatus } from "./invitations.repository";

/** The schedule and job name (scheduler.registry.ts). */
export const INVITATIONS_EXPIRE_JOB = "invitations.expire";

/** The invitations one transaction expires. */
export const INVITATIONS_EXPIRE_BATCH_SIZE = 500;

/** What a finished run returns (BullMQ keeps it with the job): the count only. */
export interface InvitationsExpireResult {
  readonly expired: number;
}

@Injectable()
@MaintenanceJob(INVITATIONS_EXPIRE_JOB)
export class InvitationsExpireScheduler implements MaintenanceJobHandler {
  constructor(
    private readonly invitations: InvitationsRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(InvitationsExpireScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** One run (see the file header). */
  async run(): Promise<InvitationsExpireResult> {
    const now = this.clock.now();
    let expired = 0;
    for (;;) {
      const count = await runInTransaction(this.db, async (trx) => {
        const rows = await this.invitations.expireDue(trx, now, INVITATIONS_EXPIRE_BATCH_SIZE);
        for (const row of rows) {
          await this.audit.record(trx, {
            actorType: "system",
            actorLabel: INVITATIONS_EXPIRE_JOB,
            action: "invitation.expired",
            targetType: "invitation",
            targetId: row.id,
            tenantId: row.tenant_id,
            before: { status: "pending" satisfies InvitationStatus },
            after: { status: "expired" satisfies InvitationStatus },
            details: { email: row.email, role: row.role },
          });
        }
        return rows.length;
      });
      expired += count;
      if (count < INVITATIONS_EXPIRE_BATCH_SIZE) {
        break;
      }
    }
    const result: InvitationsExpireResult = { expired };
    if (expired > 0) {
      this.logger.info({ ...result }, "invitations.expired");
    }
    return result;
  }
}
