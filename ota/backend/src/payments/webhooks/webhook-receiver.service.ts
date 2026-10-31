// The receiver of the OTA backend's Stripe webhooks (OADR-0010 point 4, ADR-0011 (A) "webhooks", architecture flow (d)):
// the Velexis account's (receiveStripeVelexisWebhook, `POST /webhooks/stripe/velexis/{environment}`, OBE-039), the
// Connect endpoint of the OTAs' connected accounts (receiveStripeConnectWebhook, `POST
// /webhooks/stripe/connect/{environment}`, `connect_standard` mode, OBE-078) and the endpoint of one connection in
// `api_keys` mode (receiveStripeConnectionWebhook, `POST /webhooks/stripe/c/{connectionId}`, OBE-078). The controllers
// hand over the raw body (a Buffer: the raw body parser of `/webhooks/*`), the path's parameter and `Stripe-Signature`.
// Each endpoint finds the tenant by its own rule, never by trying sources in turn:
//
//   endpoint                 signing secret                                tenant from
//   velexis/{environment}    STRIPE_WEBHOOK_SECRET_VELEXIS_<ENV>           metadata.velexis_tenant_id (only Velexis
//                                                                          creates PaymentIntents on its account)
//   connect/{environment}    STRIPE_WEBHOOK_SECRET_CONNECT_<ENV>           event.account → the one Stripe
//                                                                          connection of the environment (any mode,
//                                                                          FIX-W37-OTA) with that
//                                                                          `account_reference`, only
//   c/{connectionId}         the connection's own, decrypted here only     the path's connection (`api_keys`), only
//
// On the Connect and `c/` endpoints the OTA controls the Stripe account and can write any metadata, so metadata never
// selects the tenant there: it is only cross-checked. In order:
//
//   1. the signature is verified on the raw bytes with the endpoint's secret (`stripe.webhooks.constructEvent`,
//      Stripe's 5-minute tolerance): a missing secret, a changed body, another secret or a stale timestamp is `400
//      INVALID_REQUEST` (`details.reason: signature_invalid`), and nothing of the body is read before. On `c/` a
//      connection id that names no connection, a connection that is not a Stripe `api_keys` one or has no signing
//      secret, and a secret that cannot be decrypted answer the same `400`, so the endpoint never tells which
//      connection ids exist (the log line says which, with ids only); the decrypted secret lives in this call only;
//   2. `livemode` must match the path's environment (velexis, connect) or the connection's (`c/`), and
//      `metadata.velexis_environment` too wherever it is present;
//   3. the tenant, by the endpoint's rule above; on Connect and `c/`, `metadata.velexis_tenant_id`, wherever it is
//      present, must be that tenant. Velexis only: an object without Velexis metadata that names its PaymentIntent (a
//      dispute: Stripe copies no metadata to disputes, fixtures/README.md) takes the PaymentIntent's, read from Stripe
//      with the Velexis key of the path's environment;
//   4. inside that tenant only, the payment by `metadata.payment_id`, then by the PaymentIntent id; it must be a Stripe
//      payment of the endpoint's environment whose PaymentIntent, when set, is the event's. On Connect and `c/` the
//      payment must also have been created on the endpoint's Stripe account (its `payments.metadata.connection`
//      names that `acct_…`, payment-gateway.ts `recordedPaymentAccount`; the account is compared, never the mode, so a
//      payment taken in one mode on an account the OTA later moved to the other passes), otherwise it is a mismatch
//      of this step, answered `200` without effect (OADR-0010 point 4, note of 2026-10-31), so the worker reads its
//      objects where they live (OADR-0010 point 1 notes: a payment keeps its account);
//   5. one transaction of the tenant writes the `payment_events` row (`source = webhook`, `type = webhook.<type>`,
//      `provider_event_id` = the event id, a payload of ids, statuses and amounts only, through the shared redactor;
//      on Connect and `c/` with the endpoint, the `acct_…` and the connection id); an event id already stored is a
//      duplicate (`payment_events_provider_uq`) and writes nothing;
//   6. `stripe.event {tenantId, paymentEventId}` goes to `ota-stripe-events` with the event id as the BullMQ job id,
//      also for a duplicate: BullMQ adds one job per id, so a delivery whose job was lost queues it again and a
//      repeated one adds nothing; then the answer is `200 {received: true}`. The worker reads the object again on the
//      payment's account (stripe-events.processor.ts).
//
// Acknowledged with `200` and without effect: a Connect event without `account` or for an `acct_…` that no Stripe
// connection of the environment has, or that more than one (several OTAs) has, an unknown or unusable tenant (neither
// active nor suspended), an unknown payment, and every mismatch of steps 2 to 4, which is a security event
// (`securityEvent` in the log line, no payload), so the signed events of one tenant can never write into another
// tenant's schema and raise no staff alert. `503 SERVICE_UNAVAILABLE` when the connection or the tenant cannot be
// looked up, the event cannot be queued (Redis down, ENQUEUE_TIMEOUT_MS) or the PaymentIntent of a dispute cannot be
// read: Stripe sends the event again, and the delivery that finds it stored queues it. A database failure is a `500`, which Stripe also retries. The event
// body is never logged, stored whole or trusted for state: the worker reads the objects again.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { aadFor, decryptValue, type KeyProvider } from "@velexis/crypto";
import { InvalidTenantSchemaError } from "@velexis/db";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import type { JobsOptions, Queue } from "bullmq";
import { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { Clock } from "../../common/clock";
import { IdGenerator } from "../../common/ids";
import { OTA_QUEUE } from "../../common/queues/queue-names";
import { STRIPE_WEBHOOK_SECRET_PATTERN, type ApiConfig } from "../../config";
import { PlatformCache } from "../../tenancy/platform-cache";
import {
  PlatformReadRepository,
  type PlatformPaymentConnection,
} from "../../tenancy/platform-read.repository";
import {
  UnexpectedPlatformValueError,
  type PlatformTenant,
  type TenantStatus,
} from "../../tenancy/platform-read.types";
import { TenantContext, type TenantEnvironment } from "../../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../../tenancy/tenant-tx";
import { ACCOUNT_REFERENCE, recordedPaymentAccount } from "../payment-gateway";
import { PaymentsRepository, type PaymentRow } from "../payments.repository";
import { STRIPE_KEY_PROVIDER, StripeClientFactory } from "../stripe/stripe-client.factory";

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

/** The endpoints of this receiver, as the stored payload names them (`endpoint`). */
export const VELEXIS_ENDPOINT = "velexis";
export const CONNECT_ENDPOINT = "connect";
export const CONNECTION_ENDPOINT = "connection";

/** The endpoints whose Stripe account is an OTA's own: the tenant comes from the account, never from metadata. */
export type AccountEndpoint = typeof CONNECT_ENDPOINT | typeof CONNECTION_ENDPOINT;

/** How long queueing the job may take before the delivery answers 503 (Stripe sends it again). */
export const ENQUEUE_TIMEOUT_MS = 2000;

/** The tenant statuses whose payment events are stored: their schema exists and their payments still move. */
export const WEBHOOK_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** Ids of the shape Velexis writes into the metadata (`<prefix>_`, letters, digits, `_`); others are not ours. */
const TENANT_ID = /^ten_[0-9A-Za-z_]{1,60}$/;
const PAYMENT_ID = /^pay_[0-9A-Za-z_]{1,60}$/;
/** A Stripe object id (`pi_…`, `ch_…`, `re_…`, `dp_…`, `evt_…`), for the stored payload and the logs. */
const STRIPE_ID = /^[a-z]{2,8}_[0-9A-Za-z_]{1,250}$/;

/** The associated data of a connection's webhook signing secret (ADR-0010, as the platform seals it). */
export function connectionWebhookSecretAad(connectionId: string): string {
  return aadFor("platform", "payment_provider_connections", "webhook_secret_ciphertext", connectionId);
}

/** What became of a delivery that passed the signature check. */
export type WebhookOutcome =
  | "stored"
  | "duplicate"
  | "account_unknown"
  | "tenant_unknown"
  | "tenant_unavailable"
  | "payment_unknown"
  | "mismatch";

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

/**
 * The OTA's own Stripe account a Connect or `c/` delivery came from, as the endpoint resolved it: what the tenant came
 * from, what the payment must have been created on, and what the stored payload names (`account`, `connectionId`).
 */
export interface AccountBinding {
  readonly endpoint: AccountEndpoint;
  /** The connection the tenant came from (`ppc_…`). */
  readonly connectionId: string;
  /** The OTA's Stripe account (`acct_…`): `event.account` (Connect) or the connection's `account_reference` (`c/`). */
  readonly accountReference: string;
}

/** The answer to a verified delivery (controller: `200 {received: true}`). */
export interface WebhookReceipt {
  readonly outcome: WebhookOutcome;
  /** The stored event (`stored`, `duplicate`). */
  readonly paymentEventId: string | null;
}

/** Why a verified event was acknowledged without effect, for the log line. */
type Ignored = Exclude<WebhookOutcome, "stored" | "duplicate">;

/** Why a `c/` connection cannot check a delivery (all answer the same `400`; the log line says which). */
type ConnectionUnusable =
  | "connection_unknown"
  | "connection_not_api_keys"
  | "no_webhook_secret"
  | "webhook_secret_unreadable"
  | "webhook_secret_invalid";

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

/** The connected account of a Connect event (`event.account`, `acct_…`), or `null` without a usable one. */
export function connectedAccountOf(event: Stripe.Event): string | null {
  const account: unknown = (event as { account?: unknown }).account;
  return typeof account === "string" && account.length <= 255 && ACCOUNT_REFERENCE.test(account)
    ? account
    : null;
}

/**
 * The payload stored with the event (`payment_events.payload`): the endpoint (with the OTA's account and connection on
 * Connect and `c/`), the event's ids, type and creation time, and the status and amounts (Stripe's integer minor
 * units) of its object. Never the object itself: a PaymentIntent holds its client secret, a charge the card's details
 * and billing data.
 */
export function storedPayloadOf(
  event: Stripe.Event,
  facts: EventFacts,
  account?: AccountBinding,
): Record<string, unknown> {
  const object: unknown = (event.data as { object?: unknown } | undefined)?.object;
  const source = isRecord(object) ? object : {};
  const created = integerOf(event.created);
  const payload = {
    endpoint: account?.endpoint ?? VELEXIS_ENDPOINT,
    ...(account === undefined
      ? {}
      : { account: account.accountReference, connectionId: account.connectionId }),
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
  /** The metadata the payment is looked up with (the object's, or on velexis its PaymentIntent's). */
  readonly metadata: VelexisMetadata;
  readonly tenant: PlatformTenant;
  /** The OTA's own account (Connect, `c/`), or `undefined` on the Velexis endpoint. */
  readonly account: AccountBinding | undefined;
  /** The log fields of the delivery (endpoint, event id and type). */
  readonly log: Readonly<Record<string, unknown>>;
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
    private readonly platform: PlatformReadRepository,
    @Inject(STRIPE_KEY_PROVIDER) private readonly secretKeys: KeyProvider,
  ) {
    logger.setContext(WebhookReceiverService.name);
  }

  /** Receives one delivery of the Velexis endpoint of `environment` (see the file header). */
  async receiveVelexis(
    environment: TenantEnvironment,
    rawBody: unknown,
    signature: string | undefined,
  ): Promise<WebhookReceipt> {
    const endpoint = `${VELEXIS_ENDPOINT}/${environment}`;
    const secret =
      environment === "live"
        ? this.config.get("STRIPE_WEBHOOK_SECRET_VELEXIS_LIVE", { infer: true })
        : this.config.get("STRIPE_WEBHOOK_SECRET_VELEXIS_TEST", { infer: true });
    const event = this.verify(endpoint, secret, rawBody, signature);
    const facts = eventFactsOf(event);
    const base = { endpoint, eventId: facts.eventId, eventType: facts.type };
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
    const tenant = await this.usableTenant(metadata.tenantId, base);
    if ("ignored" in tenant) {
      return tenant.ignored;
    }
    return await this.deliver({
      environment,
      event,
      facts,
      metadata,
      tenant: tenant.tenant,
      account: undefined,
      log: base,
    });
  }

  /**
   * Receives one delivery of the Connect endpoint of `environment` (`connect_standard` mode, see the file header): the
   * tenant only from `event.account`.
   */
  async receiveConnect(
    environment: TenantEnvironment,
    rawBody: unknown,
    signature: string | undefined,
  ): Promise<WebhookReceipt> {
    const endpoint = `${CONNECT_ENDPOINT}/${environment}`;
    const secret =
      environment === "live"
        ? this.config.get("STRIPE_WEBHOOK_SECRET_CONNECT_LIVE", { infer: true })
        : this.config.get("STRIPE_WEBHOOK_SECRET_CONNECT_TEST", { infer: true });
    const event = this.verify(endpoint, secret, rawBody, signature);
    const facts = eventFactsOf(event);
    const base = { endpoint, eventId: facts.eventId, eventType: facts.type };
    if (facts.livemode !== (environment === "live")) {
      return this.ignored("mismatch", { ...base, check: "livemode" });
    }
    const accountReference = connectedAccountOf(event);
    if (accountReference === null) {
      return this.ignored("account_unknown", base);
    }
    const connection = await this.platformRead(base, () =>
      this.platform.connectPaymentConnection(environment, accountReference),
    );
    // The one connection of any mode that holds the account (an OTA that moved it to its own keys included, lead
    // decision (2l) of 2026-10-31); none, or several OTAs, is an unknown account.
    if (
      connection === null ||
      connection.provider !== "stripe" ||
      connection.environment !== environment ||
      connection.accountReference !== accountReference
    ) {
      return this.ignored("account_unknown", { ...base, account: accountReference });
    }
    return await this.deliverOnAccount(environment, event, facts, connection, {
      endpoint: CONNECT_ENDPOINT,
      connectionId: connection.id,
      accountReference,
    });
  }

  /**
   * Receives one delivery of connection `connectionId`'s own endpoint (`api_keys` mode, see the file header): verified
   * with that connection's signing secret, the tenant only from the connection.
   */
  async receiveConnection(
    connectionId: string,
    rawBody: unknown,
    signature: string | undefined,
  ): Promise<WebhookReceipt> {
    const endpoint = `c/${connectionId}`;
    // Nothing is looked up for a delivery that cannot be verified anyway.
    if (!this.hasBodyAndSignature(rawBody, signature)) {
      this.logger.warn({ endpoint, reason: "no_body_or_signature" }, "payments.webhook_signature_invalid");
      throw signatureRefused();
    }
    const found = await this.platformRead({ endpoint }, () =>
      this.platform.paymentConnectionWebhook(connectionId),
    );
    const usable = await this.connectionSecret(connectionId, found);
    if ("unusable" in usable) {
      // The same answer as a wrong signature: the endpoint never tells which connection ids exist.
      this.logger.warn({ endpoint, reason: usable.unusable }, "payments.webhook_connection_unusable");
      throw signatureRefused();
    }
    const { connection, accountReference } = usable;
    const event = this.verify(endpoint, usable.secret, rawBody, signature);
    const facts = eventFactsOf(event);
    const base = { endpoint, eventId: facts.eventId, eventType: facts.type };
    if (facts.livemode !== (connection.environment === "live")) {
      return this.ignored("mismatch", { ...base, check: "livemode" });
    }
    return await this.deliverOnAccount(connection.environment, event, facts, connection, {
      endpoint: CONNECTION_ENDPOINT,
      connectionId: connection.id,
      accountReference,
    });
  }

  /**
   * Steps 2 and 3 of the Connect and `c/` endpoints after `livemode`: the metadata may only confirm the connection's
   * environment and tenant, and the tenant must take payment events; then steps 4 to 6.
   */
  private async deliverOnAccount(
    environment: TenantEnvironment,
    event: Stripe.Event,
    facts: EventFacts,
    connection: PlatformPaymentConnection,
    account: AccountBinding,
  ): Promise<WebhookReceipt> {
    const base = {
      endpoint:
        account.endpoint === CONNECT_ENDPOINT ? `connect/${environment}` : `c/${account.connectionId}`,
      eventId: facts.eventId,
      eventType: facts.type,
      account: account.accountReference,
      connectionId: account.connectionId,
    };
    const metadata = facts.metadata;
    if (metadata.environment !== null && metadata.environment !== environment) {
      return this.ignored("mismatch", { ...base, check: "metadata_environment" });
    }
    if (metadata.tenantId !== null && metadata.tenantId !== connection.tenantId) {
      // The OTA wrote another tenant's id into its own object: never followed, never stored.
      return this.ignored("mismatch", {
        ...base,
        tenantId: connection.tenantId,
        check: "metadata_tenant",
      });
    }
    const tenant = await this.usableTenant(connection.tenantId, base);
    if ("ignored" in tenant) {
      return tenant.ignored;
    }
    return await this.deliver({
      environment,
      event,
      facts,
      metadata,
      tenant: tenant.tenant,
      account,
      log: base,
    });
  }

  /** The tenant of a delivery when it takes payment events (active or suspended), else the acknowledgement. */
  private async usableTenant(
    tenantId: string,
    base: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly tenant: PlatformTenant } | { readonly ignored: WebhookReceipt }> {
    const tenant = await this.cache.tenantById(tenantId);
    if (tenant === null) {
      return { ignored: this.ignored("tenant_unknown", { ...base, tenantId }) };
    }
    if (!WEBHOOK_TENANT_STATUSES.includes(tenant.status)) {
      return {
        ignored: this.ignored("tenant_unavailable", {
          ...base,
          tenantId: tenant.id,
          tenantStatus: tenant.status,
        }),
      };
    }
    return { tenant };
  }

  /** Steps 4 to 6: the payment and the row in the tenant's transaction, the job, the log line. */
  private async deliver(delivery: Delivery): Promise<WebhookReceipt> {
    const { tenant, environment, facts } = delivery;
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
      return this.ignored(stored.ignored, { ...delivery.log, tenantId: tenant.id, ...stored.log });
    }
    await this.enqueue({ tenantId: tenant.id, paymentEventId: stored.paymentEventId }, facts.eventId);
    this.logger.info(
      {
        ...delivery.log,
        tenantId: tenant.id,
        paymentId: stored.paymentId,
        paymentEventId: stored.paymentEventId,
        duplicate: stored.duplicate,
      },
      stored.duplicate ? "payments.webhook_duplicate" : "payments.webhook_stored",
    );
    return { outcome: stored.duplicate ? "duplicate" : "stored", paymentEventId: stored.paymentEventId };
  }

  private hasBodyAndSignature(rawBody: unknown, signature: string | undefined): rawBody is Buffer {
    return Buffer.isBuffer(rawBody) && rawBody.length > 0 && signature !== undefined && signature !== "";
  }

  /** Step 1: the event, verified on the raw body with `secret`; `400 INVALID_REQUEST` otherwise. */
  private verify(
    endpoint: string,
    secret: string | undefined,
    rawBody: unknown,
    signature: string | undefined,
  ): Stripe.Event {
    if (secret === undefined) {
      this.logger.error({ endpoint }, "payments.webhook_secret_missing");
      throw signatureRefused();
    }
    if (!this.hasBodyAndSignature(rawBody, signature) || signature === undefined) {
      this.logger.warn({ endpoint, reason: "no_body_or_signature" }, "payments.webhook_signature_invalid");
      throw signatureRefused();
    }
    try {
      return Stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (error) {
      // Stripe's error carries the header and the payload: only its type is logged.
      const reason =
        error instanceof Stripe.errors.StripeSignatureVerificationError ? "signature_mismatch" : "unreadable";
      this.logger.warn({ endpoint, reason }, "payments.webhook_signature_invalid");
      throw signatureRefused();
    }
  }

  /**
   * Step 1 of `c/`: the connection's signing secret, decrypted with the KEKs of MASTER_KEY_DIR and the row's associated
   * data, when the connection is a Stripe `api_keys` one with a secret; else why not. The secret lives in the caller's
   * call only: never cached, logged, queued or put into an error.
   */
  private async connectionSecret(
    connectionId: string,
    found: Awaited<ReturnType<PlatformReadRepository["paymentConnectionWebhook"]>>,
  ): Promise<
    | {
        readonly connection: PlatformPaymentConnection;
        readonly accountReference: string;
        readonly secret: string;
      }
    | { readonly unusable: ConnectionUnusable }
  > {
    if (found === null || found.connection.id !== connectionId) {
      return { unusable: "connection_unknown" };
    }
    const { connection, webhookSecretCiphertext } = found;
    const accountReference = connection.accountReference;
    if (
      connection.provider !== "stripe" ||
      connection.accountMode !== "api_keys" ||
      accountReference === null ||
      !ACCOUNT_REFERENCE.test(accountReference)
    ) {
      return { unusable: "connection_not_api_keys" };
    }
    if (webhookSecretCiphertext === null || webhookSecretCiphertext === "") {
      return { unusable: "no_webhook_secret" };
    }
    let plaintext: Buffer;
    try {
      plaintext = await decryptValue(Buffer.from(webhookSecretCiphertext, "base64"), {
        aad: connectionWebhookSecretAad(connection.id),
        keys: this.secretKeys,
      });
    } catch {
      // Never the error itself: a missing KEK, another row's ciphertext or a damaged value is enough to know.
      return { unusable: "webhook_secret_unreadable" };
    }
    let secret: string;
    try {
      secret = plaintext.toString("utf8");
    } finally {
      plaintext.fill(0);
    }
    if (!STRIPE_WEBHOOK_SECRET_PATTERN.test(secret)) {
      return { unusable: "webhook_secret_invalid" };
    }
    return { connection, accountReference, secret };
  }

  /**
   * A platform lookup of a delivery (the connection of Connect and `c/`): a read that fails is `503`, so Stripe sends
   * the event again; a row the backend cannot read stays an error (500).
   */
  private async platformRead<T>(base: Readonly<Record<string, unknown>>, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (
        error instanceof AppError ||
        error instanceof UnexpectedPlatformValueError ||
        error instanceof InvalidTenantSchemaError
      ) {
        throw error;
      }
      // The error's name only: a database error may quote the query.
      this.logger.warn(
        { ...base, error: error instanceof Error ? error.name : "unknown" },
        "payments.webhook_connection_lookup_failed",
      );
      throw new AppError("SERVICE_UNAVAILABLE", {
        message: "The event cannot be processed now; send it again.",
        cause: error,
      });
    }
  }

  /**
   * Step 3 of the Velexis endpoint: the metadata the tenant comes from. The object's own when it carries Velexis
   * metadata; otherwise, for an object that names its PaymentIntent (a dispute), the PaymentIntent's, read from Stripe on
   * the Velexis account of the environment (`503` when Stripe cannot be read, so Stripe delivers the event again).
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
    const { environment, facts, metadata, account } = delivery;
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
    if (account !== undefined) {
      // The payment must live on the endpoint's account: a `velexis` payment, or one of another `acct_…`, is not this
      // account's to move (the OTA could name it in its own object's metadata).
      const recorded = recordedPaymentAccount(row.metadata);
      if (recorded === null || recorded.accountReference !== account.accountReference) {
        return { ignored: "mismatch", log: { ...log, check: "payment_account" } };
      }
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
      payload: JSON.stringify(storedPayloadOf(delivery.event, facts, account)),
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

/** The answer to a delivery that cannot be verified: `400 INVALID_REQUEST`, `details.reason: signature_invalid`. */
function signatureRefused(): AppError {
  return new AppError("INVALID_REQUEST", {
    message: "The Stripe signature of the request is not valid.",
    details: { reason: "signature_invalid" },
  });
}
