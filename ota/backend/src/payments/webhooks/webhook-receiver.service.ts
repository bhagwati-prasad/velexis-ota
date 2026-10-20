// The receiver of the Velexis Stripe account's webhooks (receiveStripeVelexisWebhook, `POST
// /webhooks/stripe/velexis/{environment}`; OBE-039, OADR-0010 point 4, ADR-0011 (A) "webhooks", architecture flow (d)).
// Stripe delivers each event of the Velexis account here; the controller hands over the raw body (a Buffer: the raw
// body parser of `/webhooks/*`), the path's environment and `Stripe-Signature`. In order:
//
//   1. the signature is verified on the raw bytes with the endpoint's secret (STRIPE_WEBHOOK_SECRET_VELEXIS_<ENV>,
//      `stripe.webhooks.constructEvent`, Stripe's 5-minute tolerance): a missing secret, a changed body, another secret
//      or a stale timestamp is `400 INVALID_REQUEST` (`details.reason: signature_invalid`), and nothing of the body is
//      read before;
//   2. `livemode` must match the path's environment, and `metadata.velexis_environment` too wherever it is present;
//   3. the tenant comes from `metadata.velexis_tenant_id` of the event's object, because only Velexis creates
//      PaymentIntents on this account (OADR-0010 point 4); an object without Velexis metadata that names its
//      PaymentIntent (a dispute: Stripe copies no metadata to disputes, fixtures/README.md) takes the PaymentIntent's,
//      read from Stripe with the Velexis key of the path's environment;
//   4. inside that tenant only, the payment by `metadata.payment_id`, then by the PaymentIntent id; it must be a Stripe
//      payment of the path's environment whose PaymentIntent, when set, is the event's;
//   5. one transaction of the tenant writes the `payment_events` row (`source = webhook`, `type = webhook.<type>`,
//      `provider_event_id` = the event id, a payload of ids, statuses and amounts only, through the shared redactor);
//      an event id already stored is a duplicate (`payment_events_provider_uq`) and writes nothing;
//   6. `stripe.event {tenantId, paymentEventId}` goes to `ota-stripe-events` with the event id as the BullMQ job id,
//      also for a duplicate: BullMQ adds one job per id, so a delivery whose job was lost queues it again and a
//      repeated one adds nothing; then the answer is `200 {received: true}`.
//
// Acknowledged with `200` and without effect: an unknown or unusable tenant (neither active nor suspended), an unknown
// payment, and every mismatch of steps 2 to 4, which is a security event (`securityEvent` in the log line, no payload),
// so the signed events of one tenant can never write into another tenant's schema. `503 SERVICE_UNAVAILABLE` when the
// event cannot be queued (Redis down, ENQUEUE_TIMEOUT_MS) or the PaymentIntent of a dispute cannot be read: Stripe sends
// the event again, and the delivery that finds it stored queues it. A database failure is a `500`, which Stripe also
// retries. The event body is never logged, stored whole or trusted for state: the worker reads the objects again
// (stripe-events.processor.ts).
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import type { JobsOptions, Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { Clock } from "../../common/clock";
import { IdGenerator } from "../../common/ids";
import { OTA_QUEUE } from "../../common/queues/queue-names";
import type { ApiConfig } from "../../config";
import { PlatformCache } from "../../tenancy/platform-cache";
import type { PlatformTenant, TenantStatus } from "../../tenancy/platform-read.types";
import { TenantContext, type TenantEnvironment } from "../../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../../tenancy/tenant-tx";
import { PaymentsRepository, type PaymentRow } from "../payments.repository";
import { StripeClientFactory } from "../stripe/stripe-client.factory";

/** The name of the job that processes a stored Stripe event (`ota-stripe-events`). */
export const STRIPE_EVENT_JOB = "stripe.event";

/** The payload of `stripe.event`: the tenant and the stored event, nothing else (ADR-0009). */
export interface StripeEventJobData {
  readonly tenantId: string;
  readonly paymentEventId: string;
}

/** The BullMQ job of `stripe.event` for a stored event; the Stripe event id is its job id (OADR-0010 point 4). */
export function stripeEventJob(
  data: StripeEventJobData,
  stripeEventId: string,
): { readonly name: string; readonly data: StripeEventJobData; readonly opts: JobsOptions } {
  return { name: STRIPE_EVENT_JOB, data, opts: { jobId: stripeEventId } };
}

/** The endpoint of this receiver, as the stored payload and the log lines name it. */
export const VELEXIS_ENDPOINT = "velexis";

/** How long queueing the job may take before the delivery answers 503 (Stripe sends it again). */
export const ENQUEUE_TIMEOUT_MS = 2000;

/** The tenant statuses whose payment events are stored: their schema exists and their payments still move. */
export const WEBHOOK_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** Ids of the shape Velexis writes into the metadata (`<prefix>_`, letters, digits, `_`); others are not ours. */
const TENANT_ID = /^ten_[0-9A-Za-z_]{1,60}$/;
const PAYMENT_ID = /^pay_[0-9A-Za-z_]{1,60}$/;
/** A Stripe object id (`pi_…`, `ch_…`, `re_…`, `dp_…`, `evt_…`), for the stored payload and the logs. */
const STRIPE_ID = /^[a-z]{2,8}_[0-9A-Za-z_]{1,250}$/;

/** What became of a delivery that passed the signature check. */
export type WebhookOutcome =
  "stored" | "duplicate" | "tenant_unknown" | "tenant_unavailable" | "payment_unknown" | "mismatch";

/** The safe facts of a verified event: ids, the type, the status and amounts of its object. */
export interface EventFacts {
  readonly eventId: string;
  readonly type: string;
  readonly livemode: boolean;
  /** `payment_intent`, `charge`, `refund`, `dispute`, … */
  readonly objectType: string | null;
  readonly objectId: string | null;
  /** The PaymentIntent the object is (`payment_intent`) or names (its `payment_intent`), or `null`. */
  readonly paymentIntentId: string | null;
  /** The charge a refund or dispute names, or `null`. */
  readonly chargeId: string | null;
  /** The Velexis keys of the object's metadata (`velexis_tenant_id`, `velexis_environment`, `payment_id`). */
  readonly metadata: VelexisMetadata;
}

/** The metadata keys Velexis writes on its PaymentIntents (ADR-0011 "metadata"); `null` when absent. */
export interface VelexisMetadata {
  readonly tenantId: string | null;
  readonly environment: string | null;
  readonly paymentId: string | null;
}

/** The answer to a verified delivery (controller: `200 {received: true}`). */
export interface WebhookReceipt {
  readonly outcome: WebhookOutcome;
  /** The stored event (`stored`, `duplicate`). */
  readonly paymentEventId: string | null;
}

/** Why a verified event was acknowledged without effect, for the log line. */
type Ignored = Exclude<WebhookOutcome, "stored" | "duplicate">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stringOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 255 ? value : null;

/** A Stripe reference: the id string, or the id of an expanded object. */
function referenceOf(value: unknown): string | null {
  const id = isRecord(value) ? value["id"] : value;
  return typeof id === "string" && STRIPE_ID.test(id) ? id : null;
}

const integerOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** The Velexis keys of a Stripe `metadata` object. */
export function velexisMetadataOf(metadata: unknown): VelexisMetadata {
  const source = isRecord(metadata) ? metadata : {};
  return {
    tenantId: stringOf(source["velexis_tenant_id"]),
    environment: stringOf(source["velexis_environment"]),
    paymentId: stringOf(source["payment_id"]),
  };
}

/** The facts of a verified event (see EventFacts). */
export function eventFactsOf(event: Stripe.Event): EventFacts {
  const object: unknown = (event.data as { object?: unknown } | undefined)?.object;
  const source = isRecord(object) ? object : {};
  const objectType = stringOf(source["object"]);
  const objectId = referenceOf(source["id"]);
  return {
    eventId: event.id,
    type: event.type,
    livemode: event.livemode,
    objectType,
    objectId,
    paymentIntentId: objectType === "payment_intent" ? objectId : referenceOf(source["payment_intent"]),
    chargeId: objectType === "charge" ? objectId : referenceOf(source["charge"]),
    metadata: velexisMetadataOf(source["metadata"]),
  };
}

/**
 * The payload stored with the event (`payment_events.payload`): the endpoint, the event's ids, type and creation time,
 * and the status and amounts (Stripe's integer minor units) of its object. Never the object itself: a PaymentIntent
 * holds its client secret, a charge the card's details and billing data.
 */
export function storedPayloadOf(event: Stripe.Event, facts: EventFacts): Record<string, unknown> {
  const object: unknown = (event.data as { object?: unknown } | undefined)?.object;
  const source = isRecord(object) ? object : {};
  const created = integerOf(event.created);
  const payload = {
    endpoint: VELEXIS_ENDPOINT,
    eventId: facts.eventId,
    type: facts.type,
    livemode: facts.livemode,
    createdAt: created === null ? null : new Date(created * 1000).toISOString(),
    apiVersion: stringOf(event.api_version),
    object: {
      type: facts.objectType,
      id: facts.objectId,
      status: stringOf(source["status"]),
      currency: stringOf(source["currency"]),
      amount: integerOf(source["amount"]),
      amountCapturable: integerOf(source["amount_capturable"]),
      amountReceived: integerOf(source["amount_received"]),
      amountRefunded: integerOf(source["amount_refunded"]),
      reason: stringOf(source["reason"]),
    },
    paymentIntentId: facts.paymentIntentId,
    chargeId: facts.chargeId,
  };
  return redactPayload(payload);
}

/** The values a verified delivery hands to the tenant transaction. */
interface Delivery {
  readonly environment: TenantEnvironment;
  readonly event: Stripe.Event;
  readonly facts: EventFacts;
  /** The metadata the tenant came from (the object's, or its PaymentIntent's). */
  readonly metadata: VelexisMetadata;
  readonly tenant: PlatformTenant;
}

@Injectable()
export class WebhookReceiverService {
  constructor(
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly clients: StripeClientFactory,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    private readonly tx: TenantTx,
    private readonly repository: PaymentsRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectQueue(OTA_QUEUE.stripeEvents) private readonly queue: Queue,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(WebhookReceiverService.name);
  }

  /** Receives one delivery of the Velexis endpoint of `environment` (see the file header). */
  async receiveVelexis(
    environment: TenantEnvironment,
    rawBody: unknown,
    signature: string | undefined,
  ): Promise<WebhookReceipt> {
    const event = this.verify(environment, rawBody, signature);
    const facts = eventFactsOf(event);
    const base = {
      endpoint: `${VELEXIS_ENDPOINT}/${environment}`,
      eventId: facts.eventId,
      eventType: facts.type,
    };
    if (facts.livemode !== (environment === "live")) {
      return this.ignored("mismatch", { ...base, check: "livemode" });
    }
    const metadata = await this.velexisMetadata(environment, facts);
    if (metadata.environment !== null && metadata.environment !== environment) {
      return this.ignored("mismatch", { ...base, check: "metadata_environment" });
    }
    if (metadata.tenantId === null || !TENANT_ID.test(metadata.tenantId)) {
      return this.ignored("tenant_unknown", base);
    }
    const tenant = await this.cache.tenantById(metadata.tenantId);
    if (tenant === null) {
      return this.ignored("tenant_unknown", { ...base, tenantId: metadata.tenantId });
    }
    if (!WEBHOOK_TENANT_STATUSES.includes(tenant.status)) {
      return this.ignored("tenant_unavailable", {
        ...base,
        tenantId: tenant.id,
        tenantStatus: tenant.status,
      });
    }
    const delivery: Delivery = { environment, event, facts, metadata, tenant };
    const stored = await this.tenants.run(
      {
        tenantId: tenant.id,
        key: tenant.key,
        schemaName: tenant.schemaName,
        environment,
        caller: { type: "anonymous", id: "anonymous" },
        actor: { type: "system", id: null },
        requestId: this.tenants.requestId() ?? this.ids.newId("req"),
      },
      () => this.tx.run((trx) => this.store(trx, delivery)),
    );
    if ("ignored" in stored) {
      return this.ignored(stored.ignored, { ...base, tenantId: tenant.id, ...stored.log });
    }
    await this.enqueue({ tenantId: tenant.id, paymentEventId: stored.paymentEventId }, facts.eventId);
    this.logger.info(
      {
        ...base,
        tenantId: tenant.id,
        paymentId: stored.paymentId,
        paymentEventId: stored.paymentEventId,
        duplicate: stored.duplicate,
      },
      stored.duplicate ? "payments.webhook_duplicate" : "payments.webhook_stored",
    );
    return { outcome: stored.duplicate ? "duplicate" : "stored", paymentEventId: stored.paymentEventId };
  }

  /** Step 1: the event, verified on the raw body; `400 INVALID_REQUEST` otherwise. */
  private verify(
    environment: TenantEnvironment,
    rawBody: unknown,
    signature: string | undefined,
  ): Stripe.Event {
    const refused = (): AppError =>
      new AppError("INVALID_REQUEST", {
        message: "The Stripe signature of the request is not valid.",
        details: { reason: "signature_invalid" },
      });
    const secret =
      environment === "live"
        ? this.config.get("STRIPE_WEBHOOK_SECRET_VELEXIS_LIVE", { infer: true })
        : this.config.get("STRIPE_WEBHOOK_SECRET_VELEXIS_TEST", { infer: true });
    if (secret === undefined) {
      this.logger.error(
        { endpoint: `${VELEXIS_ENDPOINT}/${environment}` },
        "payments.webhook_secret_missing",
      );
      throw refused();
    }
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || signature === undefined || signature === "") {
      this.logger.warn(
        { endpoint: `${VELEXIS_ENDPOINT}/${environment}`, reason: "no_body_or_signature" },
        "payments.webhook_signature_invalid",
      );
      throw refused();
    }
    try {
      return Stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (error) {
      // Stripe's error carries the header and the payload: only its type is logged.
      const reason =
        error instanceof Stripe.errors.StripeSignatureVerificationError ? "signature_mismatch" : "unreadable";
      this.logger.warn(
        { endpoint: `${VELEXIS_ENDPOINT}/${environment}`, reason },
        "payments.webhook_signature_invalid",
      );
      throw refused();
    }
  }

  /**
   * Step 3: the metadata the tenant comes from. The object's own when it carries Velexis metadata; otherwise, for an
   * object that names its PaymentIntent (a dispute), the PaymentIntent's, read from Stripe on the Velexis account of the
   * environment (`503` when Stripe cannot be read, so Stripe delivers the event again).
   */
  private async velexisMetadata(environment: TenantEnvironment, facts: EventFacts): Promise<VelexisMetadata> {
    if (
      facts.metadata.tenantId !== null ||
      facts.paymentIntentId === null ||
      facts.objectType === "payment_intent"
    ) {
      return facts.metadata;
    }
    const client = this.clients.velexisClient(environment);
    if (client === undefined) {
      this.logger.warn(
        { endpoint: `${VELEXIS_ENDPOINT}/${environment}`, eventId: facts.eventId },
        "payments.webhook_no_stripe_keys",
      );
      return facts.metadata;
    }
    try {
      const intent = await client.paymentIntents.retrieve(facts.paymentIntentId);
      return velexisMetadataOf(intent.metadata);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.statusCode === 404) {
        return facts.metadata;
      }
      this.logger.warn(
        {
          endpoint: `${VELEXIS_ENDPOINT}/${environment}`,
          eventId: facts.eventId,
          stripeErrorType: error instanceof Stripe.errors.StripeError ? error.type : "unknown",
          statusCode: error instanceof Stripe.errors.StripeError ? (error.statusCode ?? null) : null,
        },
        "payments.webhook_intent_unreadable",
      );
      throw new AppError("SERVICE_UNAVAILABLE", {
        message: "The event cannot be processed now; send it again.",
      });
    }
  }

  /** Steps 4 and 5, in the tenant's transaction. */
  private async store(
    trx: TenantTransaction,
    delivery: Delivery,
  ): Promise<
    | {
        readonly paymentEventId: string;
        readonly paymentId: string;
        readonly duplicate: boolean;
      }
    | { readonly ignored: Ignored; readonly log: Record<string, unknown> }
  > {
    const { environment, facts, metadata } = delivery;
    const payment = await this.findPayment(trx, metadata, facts);
    if ("ignored" in payment) {
      return payment;
    }
    const row = payment.row;
    const log = { paymentId: row.id };
    if (row.provider !== "stripe") {
      return { ignored: "mismatch", log: { ...log, check: "payment_provider" } };
    }
    if (row.environment !== environment) {
      return { ignored: "mismatch", log: { ...log, check: "payment_environment" } };
    }
    if (
      row.providerPaymentId !== null &&
      facts.paymentIntentId !== null &&
      row.providerPaymentId !== facts.paymentIntentId
    ) {
      return { ignored: "mismatch", log: { ...log, check: "payment_intent" } };
    }
    const now = this.clock.now();
    const id = this.ids.newId("pev");
    const inserted = await this.repository.insertProviderEvent(trx, {
      id,
      payment_id: row.id,
      type: `webhook.${facts.type}`.slice(0, 200),
      source: "webhook",
      provider_event_id: facts.eventId,
      status_from: null,
      status_to: null,
      amount: null,
      currency: null,
      payload: JSON.stringify(storedPayloadOf(delivery.event, facts)),
      created_at: now,
      updated_at: now,
    });
    if (inserted) {
      return { paymentEventId: id, paymentId: row.id, duplicate: false };
    }
    const existing = await this.repository.eventIdByProviderEventId(trx, facts.eventId);
    if (existing === undefined) {
      throw new Error("a provider event that was not inserted is not stored either");
    }
    return { paymentEventId: existing, paymentId: row.id, duplicate: true };
  }

  /** Step 4: the payment by `metadata.payment_id`, then by the PaymentIntent, in the current tenant only. */
  private async findPayment(
    trx: TenantTransaction,
    metadata: VelexisMetadata,
    facts: EventFacts,
  ): Promise<
    { readonly row: PaymentRow } | { readonly ignored: Ignored; readonly log: Record<string, unknown> }
  > {
    const paymentId =
      metadata.paymentId !== null && PAYMENT_ID.test(metadata.paymentId) ? metadata.paymentId : null;
    if (paymentId !== null) {
      const row = await this.repository.payment(trx, paymentId);
      if (row !== undefined) {
        return { row };
      }
    }
    if (facts.paymentIntentId !== null) {
      const id = await this.repository.paymentIdByProviderId(trx, "stripe", facts.paymentIntentId);
      const row = id === undefined ? undefined : await this.repository.payment(trx, id);
      if (row !== undefined) {
        // The PaymentIntent belongs to another payment than the metadata names.
        return paymentId === null || row.id === paymentId
          ? { row }
          : { ignored: "mismatch", log: { paymentId: row.id, check: "payment_id" } };
      }
    }
    return { ignored: "payment_unknown", log: {} };
  }

  /** Step 6: queues the job, or answers 503 so that Stripe delivers the event again. */
  private async enqueue(data: StripeEventJobData, stripeEventId: string): Promise<void> {
    const job = stripeEventJob(data, stripeEventId);
    let timer: NodeJS.Timeout | undefined;
    const added = this.queue.add(job.name, job.data, job.opts).then(
      () => "added" as const,
      (error: unknown) => {
        this.logger.warn({ tenantId: data.tenantId, err: error }, "payments.webhook_enqueue_failed");
        return "failed" as const;
      },
    );
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), ENQUEUE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([added, timedOut]);
      if (result === "added") {
        return;
      }
      if (result === "timeout") {
        this.logger.warn(
          { tenantId: data.tenantId, timeoutMs: ENQUEUE_TIMEOUT_MS },
          "payments.webhook_enqueue_timeout",
        );
      }
      throw new AppError("SERVICE_UNAVAILABLE", {
        message: "The event cannot be processed now; send it again.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** An event acknowledged without effect: logged (a mismatch as a security event), answered 200. */
  private ignored(outcome: Ignored, log: Record<string, unknown>): WebhookReceipt {
    if (outcome === "mismatch") {
      this.logger.warn({ ...log, securityEvent: "payments.webhook_mismatch" }, "payments.webhook_mismatch");
    } else {
      this.logger.warn({ ...log, outcome }, "payments.webhook_ignored");
    }
    return { outcome, paymentEventId: null };
  }
}
