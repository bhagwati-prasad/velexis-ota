// The OTA's own Stripe API keys, the API's side (PBE-057; flows/stripe-payments-account.md §D items 1, 2 and 4,
// PADR-0011 item 5, PADR-0010; scope PF-62 AC1). Who may call it is decided before it runs: TenantRoleGuard (owners and
// admins: `changeConnections`), RecentMfaGuard (`x-mfa-step-up`: `403 MFA_REQUIRED` without MFA, `401 REAUTH_REQUIRED`
// without a TOTP step-up in the last 15 minutes) and FeatureGuard (`x-feature: own_stripe`, `403 FEATURE_DISABLED`).
//
// `submit` (`submitStripeApiKeys`, `PUT …/payment-connections/{environment}/api-keys`):
//
// 1. The request validation has checked the body against `SubmitStripeApiKeysRequest` (`pk_(test|live)_…`,
//    `(sk|rk)_(test|live)_…`, `whsec_…`, each at most 255 characters). Every key must belong to the path's environment:
//    `pk_<env>_`, and `sk_<env>_` or `rk_<env>_`; the webhook signing secret must meet the OTA backend's own rule,
//    STRIPE_WEBHOOK_SECRET_PATTERN of ota/backend/src/config.ts (`whsec_` and 8 or more of `[A-Za-z0-9+/=_-]`; lead
//    decision (2l) of 2026-10-31), because the OTA's receiver checks the decrypted secret with it and refuses every
//    delivery otherwise. Each broken rule answers `400 VALIDATION_FAILED` with a field error on `/publishableKey`,
//    `/secretKey` or `/webhookSecret` whose message never holds the value (`stripeKeyProblems`).
// 2. One transaction (`runInTransaction`): the tenant's row with `FOR SHARE` (gone, or not visible to members: `404
//    NOT_FOUND`; not `active`: `409 TENANT_NOT_ACTIVE` with `details.status`, PADR-0014 item 5); then the slot's
//    advisory lock (CredentialSubmissionsService.lockSlot, the lock `submit` takes again), so two submissions of the
//    environment at the same moment (a double click) run one after the other and the second reads what the first
//    stored; the connection of the environment is read without a lock (the worker's apply locks the submission, then
//    the connection: lock order of credentials-verify.processor.ts). Its id names the webhook URL; an environment
//    without a connection keeps the id of its latest submission of own Stripe keys, or gets a new `ppc_…`, which the
//    verification gives the connection it creates (so a submission typed again, or twice at once, keeps the URL the
//    owner configured in Stripe). Then
//    CredentialSubmissionsService.submit (PBE-052) with `kind = 'stripe_api_keys'`: it supersedes the open submission
//    of that environment (its secrets erased), stores `public_data = {publishableKey, connectionId}` and both secrets
//    envelope-encrypted with the submission's associated data, writes the audit row `payments.api_keys_submitted`
//    (no secret; this service writes none of its own, lead decision (1f) of 2026-10-31) and, after the commit,
//    enqueues `credentials.verify {submissionId}`.
// 3. The answer is `202 {submission, webhookUrl, webhookEvents}`: the submission as `getCredentialSubmission` answers
//    it (`pending`), the OTA backend's receiver of this connection,
//    `https://api.<STOREFRONT_BASE_DOMAIN>/webhooks/stripe/c/<ppc_id>` (the OTA API's host of decisions.md §4,
//    `api.ota.example.com`), and the payment events to enable in the OTA's Stripe dashboard. The webhook secret is only
//    proved by Stripe's first delivery to the OTA backend; the portal asks the owner to send a test event.
//
// The worker's side, `GET /v1/account` and the switch of the connection, is stripe-api-keys.verifier.ts.
//
// `listConnections` (`listPaymentConnections`, PBE-027) answers the OTA's connections without their ciphertexts
// (`toPaymentConnectionWith`), with the webhook URL of an `api_keys` connection and each connection's
// `pendingSubmission`: the latest submission of own Stripe keys of its environment while it is open or after it failed,
// so the portal shows a rejection next to the connection it left untouched.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantMembership } from "../common/auth/tenant-role.guard";
import {
  CredentialSubmissionsService,
  toCredentialSubmission,
} from "../common/credentials/credential-submissions.service";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import {
  PaymentConnectionsRepository,
  type ApiKeysSubmissionSummary,
  type PaymentConnectionView,
  type PaymentEnvironment,
} from "./payment-connections.repository";

export type SubmitStripeApiKeysRequest = components["schemas"]["SubmitStripeApiKeysRequest"];
export type StripeApiKeysSubmitted = components["schemas"]["StripeApiKeysSubmitted"];
export type PendingCredentialSubmission = components["schemas"]["PendingCredentialSubmission"];

/** What a connection's answer adds to its row: the webhook URL (`api_keys` mode) and the pending submission. */
export interface PaymentConnectionExtras {
  readonly webhookUrl?: string | null;
  readonly pendingSubmission?: PendingCredentialSubmission | null;
}

/** A connection of `listConnections`: the row, read without its ciphertexts, and what its answer adds. */
export interface ListedPaymentConnection {
  readonly row: PaymentConnectionView;
  readonly extras: PaymentConnectionExtras;
}

/**
 * The OTA backend's rule for a Stripe webhook signing secret (`STRIPE_WEBHOOK_SECRET_PATTERN` of
 * ota/backend/src/config.ts): `whsec_` and 8 or more characters of `[A-Za-z0-9+/=_-]`. The platform never stores a
 * secret the OTA's receiver refuses (lead decision (2l) of 2026-10-31).
 */
export const STRIPE_WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/=_-]{8,}$/;

/** The payment events the OTA's webhook endpoint must send (flows/stripe-payments-account.md §D item 2). */
export const STRIPE_WEBHOOK_EVENTS: readonly string[] = Object.freeze([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "payment_intent.amount_capturable_updated",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
]);

/** The non-secret fields of a submission of own Stripe keys, as `public_data` stores them and the verifier reads. */
export interface StripeApiKeysPublicData {
  /** `pk_<env>_…`: the OTA's publishable key (not a secret). */
  readonly publishableKey: string;
  /** `ppc_…`: the connection the keys are for, the one the answered webhook URL names. */
  readonly connectionId: string;
}

/** The statuses a `pendingSubmission` shows: an open submission, or one that failed (the portal shows why). */
const PENDING_SUBMISSION_STATUSES: ReadonlySet<string> = new Set(["pending", "verifying", "failed"]);

const VISIBLE_STATUSES: ReadonlySet<string> = new Set(MEMBER_VISIBLE_TENANT_STATUSES);

/** The messages of the field errors; none holds the value. */
const MESSAGES = {
  publishableKey: (environment: PaymentEnvironment) =>
    `Must be a publishable key of Stripe's ${environment} mode (pk_${environment}_…).`,
  secretKey: (environment: PaymentEnvironment) =>
    `Must be a secret or restricted key of Stripe's ${environment} mode (sk_${environment}_… or rk_${environment}_…).`,
  webhookSecret:
    "Must be the endpoint's signing secret: whsec_ and at least 8 more letters, digits or + / = _ -.",
} as const;

/**
 * A field error for each key of `request` that does not belong to `environment`, and for a webhook signing secret
 * that breaks STRIPE_WEBHOOK_SECRET_PATTERN, in body order. Empty when every rule holds. Never holds a value.
 */
export function stripeKeyProblems(
  request: SubmitStripeApiKeysRequest,
  environment: PaymentEnvironment,
): FieldError[] {
  const problems: FieldError[] = [];
  if (!request.publishableKey.startsWith(`pk_${environment}_`)) {
    problems.push({
      path: "/publishableKey",
      code: "environment",
      message: MESSAGES.publishableKey(environment),
    });
  }
  if (
    !request.secretKey.startsWith(`sk_${environment}_`) &&
    !request.secretKey.startsWith(`rk_${environment}_`)
  ) {
    problems.push({ path: "/secretKey", code: "environment", message: MESSAGES.secretKey(environment) });
  }
  if (!STRIPE_WEBHOOK_SECRET_PATTERN.test(request.webhookSecret)) {
    problems.push({ path: "/webhookSecret", code: "pattern", message: MESSAGES.webhookSecret });
  }
  return problems;
}

/**
 * The OTA backend's webhook receiver of the connection `connectionId`: `https://api.<storefrontBaseDomain>/webhooks/
 * stripe/c/<ppc_id>` (decisions.md §4: the OTA API is `api.ota.example.com` next to the `<key>.ota.example.com`
 * storefronts). Stripe needs an HTTPS endpoint.
 */
export function stripeWebhookUrl(storefrontBaseDomain: string, connectionId: string): string {
  return `https://api.${storefrontBaseDomain}/webhooks/stripe/c/${connectionId}`;
}

/**
 * The `webhookUrl` of a connection's answer (`PaymentConnection.webhookUrl`): its receiver (`stripeWebhookUrl`) in
 * `api_keys` mode, `null` in the other modes. Every answer of a connection shows it, the portal's and the admin's.
 */
export function paymentConnectionWebhookUrl(
  storefrontBaseDomain: string,
  row: Pick<PaymentConnectionView, "id" | "account_mode">,
): string | null {
  return row.account_mode === "api_keys" ? stripeWebhookUrl(storefrontBaseDomain, row.id) : null;
}

/** The `pendingSubmission` of a submission summary: shown while it is open or after it failed, else `null`. */
export function pendingSubmissionOf(
  summary: ApiKeysSubmissionSummary | undefined,
): PendingCredentialSubmission | null {
  if (summary === undefined || !PENDING_SUBMISSION_STATUSES.has(summary.status)) {
    return null;
  }
  return {
    id: summary.id,
    status: summary.status as PendingCredentialSubmission["status"],
    errorCode: summary.status === "failed" ? summary.error_code : null,
  };
}

@Injectable()
export class StripeApiKeysService {
  private readonly storefrontBaseDomain: string;

  constructor(
    private readonly submissions: CredentialSubmissionsService,
    private readonly connections: PaymentConnectionsRepository,
    private readonly ids: IdGenerator,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.storefrontBaseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** The OTA backend's webhook receiver of the connection `connectionId` (see `stripeWebhookUrl`). */
  webhookUrlOf(connectionId: string): string {
    return stripeWebhookUrl(this.storefrontBaseDomain, connectionId);
  }

  /** submitStripeApiKeys: a new submission of the OTA's own Stripe keys for `environment` (see the file header). */
  async submit(
    membership: TenantMembership,
    environment: PaymentEnvironment,
    request: SubmitStripeApiKeysRequest,
  ): Promise<StripeApiKeysSubmitted> {
    const problems = stripeKeyProblems(request, environment);
    if (problems.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors: problems });
    }
    const { tenantId, accountId } = membership;
    const { submission, connectionId } = await runInTransaction(this.db, async (trx) => {
      const tenantStatus = await this.connections.tenantStatusForShare(trx, tenantId);
      if (tenantStatus === undefined || !VISIBLE_STATUSES.has(tenantStatus)) {
        throw new AppError("NOT_FOUND");
      }
      if (tenantStatus !== "active") {
        throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenantStatus } });
      }
      // The slot's lock before the reads (`submit` takes it again without waiting): a submission of this environment
      // at the same moment (a double click) waits for this one and reads the connection id it stored.
      await this.submissions.lockSlot(trx, { tenantId, kind: "stripe_api_keys", environment });
      const existing = await this.connections.findViewForTenant(tenantId, environment, trx);
      const id =
        existing?.id ??
        (await this.connections.latestApiKeysConnectionId(trx, tenantId, environment)) ??
        this.ids.new("ppc");
      const publicData: StripeApiKeysPublicData = {
        publishableKey: request.publishableKey,
        connectionId: id,
      };
      const row = await this.submissions.submit(trx, {
        tenantId,
        kind: "stripe_api_keys",
        environment,
        publicData: { ...publicData },
        secrets: { secret: request.secretKey, webhookSecret: request.webhookSecret },
        submittedBy: accountId,
      });
      return { submission: row, connectionId: id };
    });
    return {
      submission: toCredentialSubmission(submission),
      webhookUrl: this.webhookUrlOf(connectionId),
      webhookEvents: [...STRIPE_WEBHOOK_EVENTS],
    };
  }

  /** The webhook URL a connection's answer shows: its receiver in `api_keys` mode, `null` in the other modes. */
  webhookUrlFor(row: Pick<PaymentConnectionView, "id" | "account_mode">): string | null {
    return paymentConnectionWebhookUrl(this.storefrontBaseDomain, row);
  }

  /**
   * listPaymentConnections: the tenant's Stripe connections, `test` first, read without the ciphertexts, with the
   * webhook URL of an `api_keys` connection and each one's `pendingSubmission` (see the file header); the controller
   * maps them with `toPaymentConnectionWith`.
   */
  async listConnections(tenantId: string): Promise<ListedPaymentConnection[]> {
    const [rows, latest] = await Promise.all([
      this.connections.listForTenant(tenantId),
      this.connections.latestApiKeysSubmissions(tenantId),
    ]);
    const byEnvironment = new Map(latest.map((summary) => [summary.environment, summary]));
    return rows.map((row) => ({
      row,
      extras: {
        webhookUrl: this.webhookUrlFor(row),
        pendingSubmission: pendingSubmissionOf(byEnvironment.get(row.environment)),
      },
    }));
  }

  /** The pending submission of own Stripe keys of the tenant's `environment`, as a connection's answer shows it. */
  async pendingSubmissionFor(
    tenantId: string,
    environment: PaymentEnvironment,
  ): Promise<PendingCredentialSubmission | null> {
    const latest = await this.connections.latestApiKeysSubmissions(tenantId);
    return pendingSubmissionOf(latest.find((summary) => summary.environment === environment));
  }
}
