// The return to Velexis payments (PBE-057; flows/stripe-payments-account.md §E, PADR-0011 items 4, 6 and 7, PADR-0003).
// Who may call it is decided before it runs: TenantRoleGuard (owners only) and RecentMfaGuard (`x-mfa-step-up`: `403
// MFA_REQUIRED` without MFA, `401 REAUTH_REQUIRED` without a TOTP step-up in the last 15 minutes). It is behind no
// switch, so an OTA can always come back to the Velexis account.
//
// `useVelexis` (`useVelexisPayments`, `POST …/payment-connections/{environment}/use-velexis`), in this order:
//
// 1. A first read, with no lock and no transaction (none is open during a Stripe call): the OTA's members must see it
//    (`404 NOT_FOUND`), it must be `active` (`409 TENANT_NOT_ACTIVE` with `details.status`, PADR-0014 item 5), the
//    environment must have a connection (`404 NOT_FOUND`), and a `live` connection that is not in `velexis` mode yet
//    needs a `verified` payout account (`422 PAYOUT_ACCOUNT_REQUIRED`), because Velexis then collects the OTA's money
//    and settles it (PADR-0003): checked before Stripe is asked anything.
// 2. A `connect_standard` connection disconnects Velexis from the OTA's account: `stripe.oauth.deauthorize({client_id,
//    stripe_user_id})` with Velexis's key (idempotency key `use_velexis_deauthorize:<ppc_id>:<version>`), best effort:
//    a failure is logged as `payments.use_velexis_deauthorize_failed` with Stripe's type, status and code only and does
//    not block (PADR-0011 item 6). It is skipped, and the skip logged (`payments.use_velexis_deauthorize_skipped`),
//    when the account is no longer connected (a Stripe deauthorisation disabled the connection: `disconnected_at`
//    set), when another `connect_standard` connection still holds it with `disconnected_at` empty (one OAuth serves
//    both environments of an OTA, PADR-0011 item 2: deauthorising it would cut that connection off; the rule of
//    FIX-W37-PLATFORM for the Connect callback), or when that cannot be read.
// 3. One transaction (`runInTransaction`): the tenant `FOR SHARE` again (`404`, `409`); the open submission of own
//    Stripe keys of the environment is superseded with its secrets erased (CredentialSubmissionsService.supersedeOpen,
//    before the connection: lock order of credentials-verify.processor.ts), so a verification still running cannot
//    switch the connection back to `api_keys` after the owner chose Velexis; then the connection `FOR UPDATE` (`404`).
//    - In `velexis` mode already: answered as it is, `200`, no write and no invalidation (the document's "unchanged");
//      an open submission it superseded is still audited (below).
//    - Otherwise a `live` connection needs a `verified` payout account read `FOR SHARE` (`422`, everything rolled
//      back), and the connection becomes `velexis`: no account reference, publishable key, secrets or key id, no
//      capabilities, no `connected_at`, `disconnected_at`, `last_verified_at` or `last_error`, `active`, the owner in
//      `created_by_account_id`, `version + 1` (`switchToVelexis`). A connection a platform admin disabled (`disabled`
//      without `disconnected_at`, `adminSetConnectionStatus`) switches its mode but stays `disabled`: the owner's
//      choice never lifts the admin's disable (as the Connect callback never does, FIX-W36-PLATFORM); the admin
//      re-enables it.
//    One audit row `payments.switched_to_velexis` (the mode, the account and the status before and after, the
//    environment, what became of the deauthorisation and the superseded submission; never a secret), and `{type:
//    "connection", tenantId}` after the commit of a switch.
//
// Switching never moves existing payments: the OTA backend keeps capturing and refunding each payment on the account
// recorded with it (PADR-0011 item 7). The answer is the row without its ciphertexts; the controller maps it with
// `toPaymentConnection` and sets `ETag`. "Now" is the injected Clock's time.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService, type AuditDetails, type AuditValues } from "../audit/audit.service";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { CredentialSubmissionsService } from "../common/credentials/credential-submissions.service";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { idempotencyKey, StripeClient } from "../common/stripe/stripe.client";
import type { PlatformBackendConfig } from "../config";
import {
  PaymentConnectionsRepository,
  type PaymentConnectionView,
  type PaymentEnvironment,
} from "./payment-connections.repository";
import { disabledByAdmin, stripeConnectFailureOf } from "./stripe-connect.service";

/** What became of the deauthorisation of a `connect_standard` connection (`details.deauthorization` of the audit). */
export type DeauthorizationOutcome = "not_needed" | "deauthorized" | "skipped" | "failed";

const VISIBLE_STATUSES: ReadonlySet<string> = new Set(MEMBER_VISIBLE_TENANT_STATUSES);

/** `422 PAYOUT_ACCOUNT_REQUIRED`: Velexis collects a live OTA's money only with a verified payout account. */
function payoutAccountRequired(): AppError<"PAYOUT_ACCOUNT_REQUIRED"> {
  return new AppError("PAYOUT_ACCOUNT_REQUIRED", {
    message:
      "The live connection returns to Velexis payments only with a verified payout account of the OTA.",
  });
}

@Injectable()
export class UseVelexisService {
  private readonly clientId: string | undefined;

  constructor(
    private readonly connections: PaymentConnectionsRepository,
    private readonly submissions: CredentialSubmissionsService,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly stripe: StripeClient,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(UseVelexisService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.clientId = config.get("STRIPE_CONNECT_CLIENT_ID", { infer: true });
  }

  /** useVelexisPayments: the connection of `environment` back on the Velexis account (see the file header). */
  async useVelexis(
    membership: TenantMembership,
    environment: PaymentEnvironment,
  ): Promise<PaymentConnectionView> {
    const { tenantId, accountId } = membership;
    const tenant = await this.connections.tenantLabel(tenantId);
    if (tenant === undefined || tenant.deleted_at !== null || !VISIBLE_STATUSES.has(tenant.status)) {
      throw new AppError("NOT_FOUND");
    }
    if (tenant.status !== "active") {
      throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenant.status } });
    }
    const first = await this.connections.findViewForTenant(tenantId, environment);
    if (first === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (
      first.account_mode !== "velexis" &&
      environment === "live" &&
      (await this.connections.payoutAccountStatus(tenantId)) !== "verified"
    ) {
      throw payoutAccountRequired();
    }
    const deauthorization = await this.deauthorize(first);

    return runInTransaction(this.db, async (trx) => {
      const tenantStatus = await this.connections.tenantStatusForShare(trx, tenantId);
      if (tenantStatus === undefined || !VISIBLE_STATUSES.has(tenantStatus)) {
        throw new AppError("NOT_FOUND");
      }
      if (tenantStatus !== "active") {
        throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenantStatus } });
      }
      const superseded = await this.submissions.supersedeOpen(trx, {
        tenantId,
        kind: "stripe_api_keys",
        environment,
      });
      const current = await this.connections.lockForTenant(trx, tenantId, environment);
      if (current === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const supersededIds = superseded.map((submission) => submission.id);
      const details = {
        environment,
        deauthorization,
        ...(supersededIds.length === 0 ? {} : { supersededSubmissionIds: supersededIds }),
      };
      const before = {
        accountMode: current.account_mode,
        accountReference: current.account_reference,
        status: current.status,
      };
      if (current.account_mode === "velexis") {
        if (supersededIds.length > 0) {
          // The connection stays as it is; the submission the owner's choice made moot is on record.
          await this.record(trx, membership, current, before, before, details);
        }
        return current;
      }
      if (
        environment === "live" &&
        (await this.connections.payoutAccountStatusForShare(trx, tenantId)) !== "verified"
      ) {
        throw payoutAccountRequired();
      }
      const updated = await this.connections.switchToVelexis(trx, current.id, {
        status: disabledByAdmin(current) ? "disabled" : "active",
        switchedByAccountId: accountId,
        now: this.clock.now(),
      });
      await this.record(
        trx,
        membership,
        updated,
        before,
        {
          accountMode: updated.account_mode,
          accountReference: updated.account_reference,
          status: updated.status,
        },
        details,
      );
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
      return updated;
    });
  }

  /** The audit row `payments.switched_to_velexis` of the connection `row` (never a secret). */
  private async record(
    trx: PlatformTransaction,
    membership: TenantMembership,
    row: PaymentConnectionView,
    before: AuditValues,
    after: AuditValues,
    details: AuditDetails,
  ): Promise<void> {
    await this.audit.record(trx, {
      actorType: "account",
      actorAccountId: membership.accountId,
      action: "payments.switched_to_velexis",
      targetType: "payment_connection",
      targetId: row.id,
      tenantId: membership.tenantId,
      before,
      after,
      details,
    });
  }

  /**
   * Step 2 of the file header: disconnects Velexis from the OTA's account of a `connect_standard` connection, best
   * effort. Never throws: a refusal or failure is logged (Stripe's type, status and code only).
   */
  private async deauthorize(row: PaymentConnectionView): Promise<DeauthorizationOutcome> {
    if (row.account_mode !== "connect_standard" || row.account_reference === null) {
      return "not_needed";
    }
    const accountReference = row.account_reference;
    const fields = { tenantId: row.tenant_id, connectionId: row.id, stripeAccount: accountReference };
    if (row.disconnected_at !== null) {
      // Velexis's access to the account was revoked in Stripe already.
      this.logger.info({ ...fields, reason: "disconnected" }, "payments.use_velexis_deauthorize_skipped");
      return "skipped";
    }
    try {
      if ((await this.connections.connectedHolderOf(accountReference, row.id)) !== undefined) {
        this.logger.warn(
          { ...fields, reason: "still_connected" },
          "payments.use_velexis_deauthorize_skipped",
        );
        return "skipped";
      }
    } catch (error) {
      // Without knowing who else holds the account, it is left connected.
      this.logger.warn(
        { ...fields, reason: "lookup_failed", failure: error instanceof Error ? error.name : "Error" },
        "payments.use_velexis_deauthorize_skipped",
      );
      return "skipped";
    }
    if (this.clientId === undefined) {
      this.logger.warn(
        { ...fields, failure: "STRIPE_CONNECT_CLIENT_ID is not set" },
        "payments.use_velexis_deauthorize_failed",
      );
      return "failed";
    }
    try {
      await this.stripe
        .api()
        .oauth.deauthorize(
          { client_id: this.clientId, stripe_user_id: accountReference },
          { idempotencyKey: idempotencyKey("use_velexis_deauthorize", `${row.id}:${row.version}`) },
        );
      this.logger.info(fields, "payments.use_velexis_deauthorized");
      return "deauthorized";
    } catch (error) {
      this.logger.warn(
        { ...fields, failure: stripeConnectFailureOf("oauth.deauthorize", error).summary },
        "payments.use_velexis_deauthorize_failed",
      );
      return "failed";
    }
  }
}
