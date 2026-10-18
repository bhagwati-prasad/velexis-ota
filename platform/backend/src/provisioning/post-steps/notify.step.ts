// Post-step `notify` (PBE-022; platform/docs/flows/provisioning.md §3, PADR-0013 item 5): the news of the activation,
// after `activate` has committed. In its own transaction it queues the `tenant.welcome` e-mail to every active owner of
// the OTA (`{fullName, tenantName, tenantKey}`) through the outbox, with the job id as the idempotency key, so a
// retried step or a second delivery of the event queues each owner's e-mail once; after its commit it publishes the
// `vx:invalidate` events `tenant` (the status changed) and `connection` (the new Amadeus and Stripe connections), so
// the OTA backend drops what it cached of the tenant while it was provisioning. Duplicate invalidations are harmless.
import { Injectable } from "@nestjs/common";
import { InvalidationPublisher } from "../../common/redis/invalidation.publisher";
import { MembershipsRepository } from "../../memberships/memberships.repository";
import { OutboxService } from "../../notifications/outbox.service";
import type { PostStep, PostStepContext, PostStepOutcome } from "./post-steps.runner";

@Injectable()
export class NotifyStep implements PostStep {
  readonly name = "notify";

  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly outbox: OutboxService,
    private readonly invalidations: InvalidationPublisher,
  ) {}

  async run({ trx, job }: PostStepContext): Promise<PostStepOutcome> {
    const owners = (await this.memberships.listActive(job.tenant_id, trx)).filter(
      (member) => member.role === "owner",
    );
    for (const owner of owners) {
      await this.outbox.queue(trx, {
        templateKey: "tenant.welcome",
        to: owner.email,
        accountId: owner.account_id,
        tenantId: job.tenant_id,
        data: { fullName: owner.full_name, tenantName: job.tenant_name, tenantKey: job.tenant_key },
        idempotencyKey: job.id,
      });
    }
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: job.tenant_id });
    this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId: job.tenant_id });
    return { status: "succeeded" };
  }
}
