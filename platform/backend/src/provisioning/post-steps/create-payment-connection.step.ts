// Post-step `create_payment_connection` (PBE-022; platform/docs/flows/provisioning.md §3, flows/stripe-payments-
// account.md §A step 1, ADR-0011; scope PF-60): every new OTA takes card payments on the Velexis Stripe account from
// the start. The step inserts the `test` connection: `stripe`, `account_mode = 'velexis'`, `capture_mode = 'manual'`,
// `active`, and the card statement descriptor suffix derived from the OTA's name (payment-connections/descriptor.ts;
// the tenant key when the name gives none). No secret is stored: the OTA backend uses Velexis's keys from its
// environment file. `ON CONFLICT (tenant_id, provider, environment) DO NOTHING`: a second run, or a tenant that has a
// Stripe test connection already, changes nothing. The live row comes at go-live (M5).
import { Injectable } from "@nestjs/common";
import { IdGenerator } from "../../common/ids";
import { statementDescriptorSuffix } from "../../payment-connections/descriptor";
import { PaymentConnectionsRepository } from "../../payment-connections/payment-connections.repository";
import type { PostStep, PostStepContext, PostStepOutcome } from "./post-steps.runner";

@Injectable()
export class CreatePaymentConnectionStep implements PostStep {
  readonly name = "create_payment_connection";

  constructor(
    private readonly payments: PaymentConnectionsRepository,
    private readonly ids: IdGenerator,
  ) {}

  async run({ trx, job, now }: PostStepContext): Promise<PostStepOutcome> {
    await this.payments.insertVelexisIfAbsent(trx, {
      id: this.ids.new("ppc"),
      tenantId: job.tenant_id,
      environment: "test",
      statementDescriptorSuffix: statementDescriptorSuffix(job.tenant_name, job.tenant_key),
      createdByAccountId: null,
      now,
    });
    return { status: "succeeded" };
  }
}
