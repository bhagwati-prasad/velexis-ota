// The payment connection use cases of the portal (platform/docs/api-inventory-resources.md §4, flows/
// stripe-payments-account.md §A item 3; ADR-0011, Velexis mode). Who may call them is TenantRoleGuard's (the membership
// arrives here checked); this service owns the transaction of a change, its audit row and the `connection`
// invalidation after the commit (architecture §4).
//
// `updateStatementDescriptor` (`updatePaymentConnection`, PBE-038; owners and admins, `If-Match`) changes the card
// statement descriptor suffix of the connection of one environment: the OTA's brand on its customers' card statements
// for payments on the Velexis Stripe account.
//
// 1. Before any read, the suffix must meet the rules of a typed suffix (descriptor.ts): only ASCII letters, digits and
//    spaces, at least one letter, 2 to 22 characters, the first a letter or a digit, none of Stripe's forbidden
//    characters. The request validation has refused every broken rule already (they are the rules of the document's
//    `StatementDescriptorSuffix`); this check keeps the column safe whatever reaches the service, and answers `400
//    VALIDATION_FAILED` with field errors on `/statementDescriptorSuffix` that never hold the value.
// 2. One transaction (`runInTransaction`): the tenant's row with `FOR SHARE` (gone, or not visible to members: `404
//    NOT_FOUND`), so a suspension waits for this change or this change sees it; then the connection of `environment`,
//    locked (`404 NOT_FOUND` without one). A stale `If-Match` answers `412 PRECONDITION_FAILED`, a tenant that is not
//    `active` `409 TENANT_NOT_ACTIVE` with `details.status` (PADR-0014 item 5: a suspended OTA's connections are
//    read-only), in this order, as updateTenant does.
// 3. A new suffix is written with `version + 1`, audited once as `payments.descriptor_updated` (the suffix before and
//    after, and the environment: a brand name, no secret), and `{type: "connection", tenantId}` is published after the
//    commit, so the OTA backend drops its cached connection and uses the new suffix for new PaymentIntents within
//    seconds. The suffix the connection already has changes nothing: no write, no audit row, no invalidation, and the
//    connection is answered as it is (as updateTenant and adminSetConnectionStatus do).
//
// The answer is the row without its ciphertexts; the controller maps it with `toPaymentConnection` and sets `ETag`.
// "Now" is the injected Clock's time.
import { Inject, Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { AuditService } from "../audit/audit.service";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { statementDescriptorSuffixProblems } from "./descriptor";
import {
  PaymentConnectionsRepository,
  type PaymentConnectionView,
  type PaymentEnvironment,
} from "./payment-connections.repository";

/** The body field of `updatePaymentConnection`, the path of its field errors. */
const SUFFIX_PATH = "/statementDescriptorSuffix";

const VISIBLE_STATUSES: ReadonlySet<string> = new Set(MEMBER_VISIBLE_TENANT_STATUSES);

@Injectable()
export class PaymentConnectionsService {
  constructor(
    private readonly connections: PaymentConnectionsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** listPaymentConnections: the tenant's Stripe connections, `test` first, read without the secrets' ciphertexts. */
  async list(tenantId: string): Promise<PaymentConnectionView[]> {
    return this.connections.listForTenant(tenantId);
  }

  /**
   * updatePaymentConnection: sets the statement descriptor suffix of the tenant's Stripe connection of `environment`
   * to `suffix` when `expectedVersion` is the connection's version and the tenant is `active` (see the file header).
   */
  async updateStatementDescriptor(
    membership: TenantMembership,
    environment: PaymentEnvironment,
    expectedVersion: number,
    suffix: string,
  ): Promise<PaymentConnectionView> {
    const problems = statementDescriptorSuffixProblems(suffix);
    if (problems.length > 0) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: problems.map(({ code, message }) => ({ path: SUFFIX_PATH, code, message })),
      });
    }
    const { tenantId, accountId } = membership;
    return runInTransaction(this.db, async (trx) => {
      const tenantStatus = await this.connections.tenantStatusForShare(trx, tenantId);
      if (tenantStatus === undefined || !VISIBLE_STATUSES.has(tenantStatus)) {
        throw new AppError("NOT_FOUND");
      }
      const current = await this.connections.lockForTenant(trx, tenantId, environment);
      if (current === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (current.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (tenantStatus !== "active") {
        throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenantStatus } });
      }
      if (current.statement_descriptor_suffix === suffix) {
        return current;
      }
      const updated = await this.connections.setStatementDescriptorSuffix(
        trx,
        current.id,
        suffix,
        this.clock.now(),
      );
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "payments.descriptor_updated",
        targetType: "payment_connection",
        targetId: current.id,
        tenantId,
        before: { statementDescriptorSuffix: current.statement_descriptor_suffix },
        after: { statementDescriptorSuffix: updated.statement_descriptor_suffix },
        details: { environment },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
      return updated;
    });
  }
}
