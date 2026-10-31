// The consumer of `ota-stripe-events` (OBE-039; OADR-0010 point 5, ADR-0011 (A) "webhooks", architecture flow (d)). It
// runs in the worker only. The webhook receiver (webhooks/webhook-receiver.service.ts) stored the event as a
// `payment_events` row and queued `stripe.event {tenantId, paymentEventId}` with the Stripe event id as job id; this
// processor never trusts the event body. Per job:
//
//   1. the tenant through the platform cache (`active` or `suspended`, as the receiver; otherwise skipped), then, in
//      its context, the stored event and its payment;
//   2. the object is read again from Stripe on the account it lives on (StripeClientFactory.withAccount):
//        endpoint `velexis`      the Velexis key of the payment's environment (the events of the `velexis` endpoint
//                                are about objects of the Velexis account, whatever the tenant's connection says now,
//                                so a connection switched or disabled since never stops a capture or a refund from
//                                being recorded);
//        `connect`, `connection` (OBE-078) the account the payment was created on (`payments.metadata.connection`,
//                                payment-gateway.ts `recordedPaymentAccount`), which the receiver checked is the
//                                `acct_…` the event came from and the stored payload names (the account, not the
//                                mode), called by the gateway's one rule (stripe.gateway.ts `paymentTargetOf`, with
//                                the tenant's payment connection of the environment through the 60-second platform
//                                cache; FIX-W37-OTA): a `connect_standard` payment with the Velexis key and
//                                `Stripe-Account: <acct_…>`, or with the key of the tenant's `api_keys` connection of
//                                that same `acct_…` once the OTA moved the account to its own keys (lead decision (2l)
//                                of 2026-10-31); an `api_keys` payment with the key the tenant's connection holds for
//                                that same `acct_…` (any status; decrypted by the factory for this job only), or
//                                through the Connect path on that account once the tenant connected it with Connect
//                                Standard (lead decision (2i) of 2026-10-30). An account that cannot be reached (no
//                                Velexis keys, a key that cannot be decrypted, no connection of the tenant holding an
//                                `api_keys` payment's account any more) fails the job for BullMQ's retries, logged
//                                with ids only:
//        payment_intent.amount_capturable_updated, .succeeded, .payment_failed, .canceled
//                                   the PaymentIntent (with its payment method and latest charge): authorised,
//                                   captured, declined (back to requires_payment_method with the decline code) or
//                                   cancelled, as payment-state.ts allows from the row's status;
//        charge.refunded, charge.refund.updated
//                                   the charge and its refunds: each refund row of the payment (by Stripe id, else by
//                                   the `refund_id` Velexis wrote in it) takes its state, and the payment its captured
//                                   and refunded amounts and `captured`, `partially_refunded` or `refunded`; a refund
//                                   of a booking that becomes `succeeded` writes the booking's customer-visible
//                                   `refund.succeeded` event, the only one that says refunded (OBE-068, lead decision
//                                   6 of 2026-10-22: the request wrote `refund.requested`);
//        charge.dispute.created     the dispute: a `payment.dispute_created` event and a staff alert (outbox
//                                   `staff.manual_review` to `ops_alert_email`, else the owners, else
//                                   OPS_ALERT_EMAIL: notifications/staff-recipients.ts; disputes are alerted, not
//                                   managed, in the MVP);
//      other types are stored by the receiver and ignored here;
//   3. the state read is applied in one short transaction under the row's lock and with its `version`
//      (PaymentsRepository.updatePayment, updateRefund), with a `payment_events` row (`source = webhook`) per change.
//      The Stripe calls happen outside any transaction (architecture §4). A dispute's transaction, whose alert
//      references the payment's booking, locks the booking first (`FOR KEY SHARE`), then the payment, and a refund
//      event's transaction the refunds' bookings (`FOR KEY SHARE`, for their booking events), the payment, then its
//      refunds: the lock order checkout, booking, payment, refund (OADR-0003 point 11).
//
// An object whose metadata names another tenant, environment or payment is a security event (logged without the
// object) and changes nothing; so is a stored Connect or connection event whose payment does not live on the event's
// `acct_…` (the receiver refuses those already). A Stripe failure that can pass (connection, timeout, 5xx, rate
// limit) fails the job for BullMQ's retries; a permanent one (the object does not exist on the account, a refused
// request) fails it at once (`UnrecoverableError`). Processing twice is harmless: the second run finds the row in the
// state Stripe reports and writes nothing. Log lines carry ids, types, statuses and Stripe's error codes, never an object of Stripe.
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redactPayload } from "@velexis/logger";
import { UnrecoverableError, type Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import type { WorkerConfig } from "../config";
import { jobTenant } from "../jobs/fan-out";
import { StaffRecipients } from "../notifications/staff-recipients";
import { PlatformCache } from "../tenancy/platform-cache";
import { PlatformReadRepository } from "../tenancy/platform-read.repository";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { ACCOUNT_REFERENCE, recordedPaymentAccount, type GatewayState } from "./payment-gateway";
import {
  matchRefund,
  providerStateUpdate,
  refundedState,
  refundUpdate,
  type ProviderRefund,
} from "./payment-state";
import { PaymentsRepository, type PaymentEventRow, type PaymentRow } from "./payments.repository";
import {
  StripeAccountUnavailableError,
  StripeClientFactory,
  type StripeAccountTarget,
  type StripeRequestScope,
} from "./stripe/stripe-client.factory";
import {
  fromMinorUnits,
  parsePaymentConnection,
  paymentTargetOf,
  stateOfPaymentIntent,
} from "./stripe/stripe.gateway";
import {
  CONNECT_ENDPOINT,
  CONNECTION_ENDPOINT,
  STRIPE_EVENT_JOB,
  VELEXIS_ENDPOINT,
  WEBHOOK_TENANT_STATUSES,
  type StripeEventJobData,
} from "./webhooks/webhook-receiver.service";

/** The PaymentIntent events whose PaymentIntent is read again and applied. */
export const PAYMENT_INTENT_EVENTS: readonly string[] = Object.freeze([
  "payment_intent.amount_capturable_updated",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);

/** The refund events whose charge and refunds are read again and applied. */
export const REFUND_EVENTS: readonly string[] = Object.freeze(["charge.refunded", "charge.refund.updated"]);

/** The dispute event that raises a staff alert. */
export const DISPUTE_CREATED = "charge.dispute.created";

/** The refunds of a charge read at most (Stripe's page limit); a charge has a handful. */
export const REFUNDS_PAGE_LIMIT = 100;

/** The template and dedupe key of the dispute alert. */
const DISPUTE_ALERT_TEMPLATE = "staff.manual_review";
const disputeDedupeKey = (disputeId: string): string => `staff.dispute:${disputeId}`;

const TENANT_ID = /^ten_[0-9A-Za-z_]{1,60}$/;
const PAYMENT_EVENT_ID = /^pev_[0-9A-Za-z_]{1,60}$/;
const STRIPE_ID = /^[a-z]{2,8}_[0-9A-Za-z_]{1,250}$/;
const REFUND_ID = /^rfd_[0-9A-Za-z_]{1,60}$/;

/** The payload of a `stripe.event` job, or `undefined` when it is not one (extra fields included). */
export function parseStripeEventJobData(data: unknown): StripeEventJobData | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data) || Object.keys(data).length !== 2) {
    return undefined;
  }
  const { tenantId, paymentEventId } = data as Record<string, unknown>;
  return typeof tenantId === "string" &&
    TENANT_ID.test(tenantId) &&
    typeof paymentEventId === "string" &&
    PAYMENT_EVENT_ID.test(paymentEventId)
    ? { tenantId, paymentEventId }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Stripe reference: the id string, or the id of an expanded object. */
function referenceOf(value: unknown): string | null {
  const id = isRecord(value) ? value["id"] : value;
  return typeof id === "string" && STRIPE_ID.test(id) ? id : null;
}

/** What the processor reads of a stored webhook payload (webhook-receiver.service.ts, `storedPayloadOf`). */
export interface StoredEventFacts {
  readonly endpoint: string | null;
  /** The Stripe event type, from the row's `type` (`webhook.<type>`). */
  readonly type: string;
  readonly objectId: string | null;
  readonly paymentIntentId: string | null;
  readonly chargeId: string | null;
}

/** The facts of a stored webhook event. */
export function storedFactsOf(event: Pick<PaymentEventRow, "type" | "payload">): StoredEventFacts {
  const payload = isRecord(event.payload) ? event.payload : {};
  const object = isRecord(payload["object"]) ? payload["object"] : {};
  return {
    endpoint: typeof payload["endpoint"] === "string" ? payload["endpoint"] : null,
    type: event.type.startsWith("webhook.") ? event.type.slice("webhook.".length) : event.type,
    objectId: referenceOf(object["id"]),
    paymentIntentId: referenceOf(payload["paymentIntentId"]),
    chargeId: referenceOf(payload["chargeId"]),
  };
}

/** The endpoints whose events are read again and applied. */
const PROCESSED_ENDPOINTS: readonly string[] = Object.freeze([
  VELEXIS_ENDPOINT,
  CONNECT_ENDPOINT,
  CONNECTION_ENDPOINT,
]);

/**
 * The OTA's Stripe account a stored Connect or connection event came from (`account` of the stored payload, OBE-078),
 * or `null` (a `velexis` event, or a value the receiver did not write).
 */
export function storedAccountOf(event: Pick<PaymentEventRow, "payload">): string | null {
  const payload = isRecord(event.payload) ? event.payload : {};
  const account = payload["account"];
  return typeof account === "string" && account.length <= 255 && ACCOUNT_REFERENCE.test(account)
    ? account
    : null;
}

/** The account of a job's reads, or why it is not the payment's. */
type ReadAccount =
  { readonly target: StripeAccountTarget } | { readonly mismatch: string } | { readonly unavailable: string };

/** The request options of a read on `scope`'s account: `Stripe-Account` in `connect_standard` mode, else none. */
function readOptionsOf(scope: StripeRequestScope): Stripe.RequestOptions | undefined {
  // The SDK skips an options argument that is `undefined` and refuses an empty object (an unknown argument to it).
  return scope.stripeAccount === undefined ? undefined : { stripeAccount: scope.stripeAccount };
}

/** What one `stripe.event` job did. */
export type StripeEventOutcome =
  "applied" | "unchanged" | "stale" | "ignored" | "mismatch" | "alerted" | "missing";

/** What a finished `stripe.event` job returns (BullMQ keeps it with the job): ids and the outcome, never more. */
export type StripeEventResult =
  | {
      readonly tenantId: string;
      readonly paymentEventId: string;
      readonly type: string | null;
      readonly outcome: StripeEventOutcome;
    }
  | { readonly tenantId: string; readonly outcome: "skipped"; readonly reason: string };

/** The event, its payment and the payment's currency minor units, as read at the start of a job. */
interface StoredEvent {
  readonly event: PaymentEventRow;
  readonly facts: StoredEventFacts;
  readonly payment: PaymentRow;
  readonly minorUnits: number;
}

/** The Velexis keys of a Stripe object's metadata, as strings or `undefined`. */
function metadataOf(object: {
  metadata?: Stripe.Metadata | null;
}): Readonly<Record<string, string | undefined>> {
  return isRecord(object.metadata) ? (object.metadata as Record<string, string | undefined>) : {};
}

/** Applies the state of a stored Stripe event, read again from Stripe, inside the tenant's context (file header). */
@Injectable()
export class StripeEventHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly repository: PaymentsRepository,
    private readonly clients: StripeClientFactory,
    private readonly staffRecipients: StaffRecipients,
    private readonly config: ConfigService<WorkerConfig, true>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    @InjectPinoLogger(StripeEventHandler.name) private readonly logger: PinoLogger,
    private readonly cache: PlatformCache,
    private readonly platform: PlatformReadRepository,
  ) {}

  async handle(
    paymentEventId: string,
  ): Promise<{ readonly type: string | null; readonly outcome: StripeEventOutcome }> {
    const stored = await this.tx.run((trx) => this.read(trx, paymentEventId));
    if (stored === undefined) {
      this.logger.warn({ paymentEventId }, "payments.stripe_event_missing");
      return { type: null, outcome: "missing" };
    }
    const { facts, payment } = stored;
    const handled =
      PAYMENT_INTENT_EVENTS.includes(facts.type) ||
      REFUND_EVENTS.includes(facts.type) ||
      facts.type === DISPUTE_CREATED;
    if (
      !handled ||
      facts.endpoint === null ||
      !PROCESSED_ENDPOINTS.includes(facts.endpoint) ||
      payment.provider !== "stripe"
    ) {
      this.logger.debug({ paymentEventId, type: facts.type }, "payments.stripe_event_ignored");
      return { type: facts.type, outcome: "ignored" };
    }
    const environment = payment.environment === "live" ? "live" : "test";
    const account = await this.readAccountOf(stored, facts.endpoint, environment);
    if ("mismatch" in account) {
      return { type: facts.type, outcome: this.mismatch(stored, account.mismatch) };
    }
    if ("unavailable" in account) {
      return this.notConfigured(paymentEventId, environment, account.unavailable, null);
    }
    let outcome: StripeEventOutcome;
    try {
      outcome = await this.clients.withAccount(account.target, async (client, scope) => {
        const options = readOptionsOf(scope);
        if (PAYMENT_INTENT_EVENTS.includes(facts.type)) {
          return await this.paymentIntent(client, options, stored);
        }
        if (REFUND_EVENTS.includes(facts.type)) {
          return await this.refunds(client, options, stored);
        }
        return await this.dispute(client, options, stored);
      });
    } catch (error) {
      if (error instanceof StripeAccountUnavailableError) {
        return this.notConfigured(paymentEventId, environment, error.reason, error.connectionId);
      }
      throw error;
    }
    this.logger.info(
      {
        paymentEventId,
        paymentId: payment.id,
        type: facts.type,
        accountMode: account.target.accountMode,
        outcome,
      },
      "payments.stripe_event_processed",
    );
    return { type: facts.type, outcome };
  }

  /**
   * The account the stored event's object is read from again (file header, step 2): the Velexis account of the
   * environment for the `velexis` endpoint; for `connect` and `connection` the account the payment was created on,
   * which must be the event's `acct_…` (the account is compared, not the mode), called by the gateway's one rule
   * (`paymentTargetOf` of stripe.gateway.ts, with the tenant's payment connection of the environment through the
   * 60-second platform cache; FIX-W37-OTA, lead decision (2l) of 2026-10-31: until then this file had its own copy).
   */
  private async readAccountOf(
    stored: StoredEvent,
    endpoint: string,
    environment: "test" | "live",
  ): Promise<ReadAccount> {
    if (endpoint === VELEXIS_ENDPOINT) {
      return { target: { accountMode: "velexis", environment } };
    }
    const recorded = recordedPaymentAccount(stored.payment.metadata);
    const account = storedAccountOf(stored.event);
    if (
      recorded === null ||
      recorded.accountMode === "velexis" ||
      account === null ||
      recorded.accountReference !== account
    ) {
      return { mismatch: "payment_account" };
    }
    const tenantId = this.tenants.require().tenantId;
    const connection = await this.cache.connection(
      "payment",
      tenantId,
      environment,
      () => this.platform.paymentConnection(tenantId, environment),
      parsePaymentConnection,
    );
    const target = paymentTargetOf({ tenantId, environment }, recorded, connection);
    return target === undefined ? { unavailable: "payment_account_unavailable" } : { target };
  }

  /**
   * An account the job cannot read from: a configuration gap that a restart with the keys, or the platform's next
   * connection change, repairs, so BullMQ retries the job meanwhile. Logged with ids and the reason only.
   */
  private notConfigured(
    paymentEventId: string,
    environment: "test" | "live",
    reason: string,
    connectionId: string | null,
  ): never {
    this.logger.error(
      { paymentEventId, environment, reason, connectionId },
      "payments.stripe_event_not_configured",
    );
    throw new Error(`the Stripe account of the payment cannot be read (${environment}): ${reason}`);
  }

  private async read(trx: TenantTransaction, paymentEventId: string): Promise<StoredEvent | undefined> {
    const event = await this.repository.event(trx, paymentEventId);
    if (event === undefined || event.source !== "webhook") {
      return undefined;
    }
    const payment = await this.repository.payment(trx, event.paymentId);
    if (payment === undefined) {
      return undefined;
    }
    const minorUnits = (await this.repository.currencyMinorUnits(trx, payment.currency)) ?? 2;
    return { event, facts: storedFactsOf(event), payment, minorUnits };
  }

  // ---- PaymentIntents --------------------------------------------------------------------------------------------

  private async paymentIntent(
    client: Stripe,
    options: Stripe.RequestOptions | undefined,
    stored: StoredEvent,
  ): Promise<StripeEventOutcome> {
    const { payment, facts } = stored;
    const intentId = payment.providerPaymentId ?? facts.paymentIntentId;
    if (intentId === null) {
      return "ignored";
    }
    const intent = await this.stripe("paymentIntents.retrieve", stored, () =>
      client.paymentIntents.retrieve(intentId, { expand: ["payment_method", "latest_charge"] }, options),
    );
    if (!this.isOurs(metadataOf(intent), payment) || intent.id !== intentId) {
      return this.mismatch(stored, "payment_intent_metadata");
    }
    return await this.applyIntent(stored, stateOfPaymentIntent(intent, stored.minorUnits));
  }

  /** Applies a PaymentIntent's state under the row's lock and with its `version`. */
  private async applyIntent(stored: StoredEvent, state: GatewayState): Promise<StripeEventOutcome> {
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const current = await this.repository.payment(trx, stored.payment.id, true);
      if (current === undefined) {
        return "missing";
      }
      const update = providerStateUpdate(current, state, now);
      if (update.kind === "unchanged") {
        return "unchanged";
      }
      if (update.kind === "refused") {
        this.logger.info(
          { paymentId: current.id, from: update.from, to: update.to, paymentEventId: stored.event.id },
          "payments.provider_state_not_applied",
        );
        return "stale";
      }
      if (!(await this.repository.updatePayment(trx, current.id, current.version, update.values))) {
        throw new Error("the payment changed while its locked row was updated");
      }
      const amount =
        update.status === "authorized"
          ? update.values["amount_authorized"]
          : update.status === "captured"
            ? update.values["amount_captured"]
            : undefined;
      await this.event(trx, current, stored, {
        type: `payment.${update.status}`,
        statusFrom: current.status,
        statusTo: update.status,
        amount: typeof amount === "string" ? amount : undefined,
        payload: {
          cardBrand: state.card?.brand ?? null,
          cardLast4: state.card?.last4 ?? null,
          threeDSecure: state.threeDSecure?.status ?? null,
          failureCode: state.failure?.code ?? null,
          declineCode: state.failure?.declineCode ?? null,
        },
        now,
      });
      return "applied";
    });
  }

  // ---- Refunds ---------------------------------------------------------------------------------------------------

  private async refunds(
    client: Stripe,
    options: Stripe.RequestOptions | undefined,
    stored: StoredEvent,
  ): Promise<StripeEventOutcome> {
    const { facts, payment } = stored;
    let chargeId = facts.type === "charge.refunded" ? facts.objectId : facts.chargeId;
    if (facts.type === "charge.refund.updated" && facts.objectId !== null) {
      const refundId = facts.objectId;
      const refund = await this.stripe("refunds.retrieve", stored, () =>
        client.refunds.retrieve(refundId, {}, options),
      );
      chargeId = referenceOf(refund.charge) ?? chargeId;
    }
    if (chargeId === null) {
      return "ignored";
    }
    const id = chargeId;
    const charge = await this.stripe("charges.retrieve", stored, () =>
      client.charges.retrieve(id, {}, options),
    );
    const intentId = payment.providerPaymentId ?? facts.paymentIntentId;
    const chargeMetadata = metadataOf(charge);
    if (
      intentId === null ||
      referenceOf(charge.payment_intent) !== intentId ||
      (chargeMetadata["payment_id"] !== undefined && !this.isOurs(chargeMetadata, payment))
    ) {
      return this.mismatch(stored, "charge");
    }
    const listed = await this.stripe("refunds.list", stored, () =>
      client.refunds.list({ charge: id, limit: REFUNDS_PAGE_LIMIT }, options),
    );
    const refunds: ProviderRefund[] = listed.data.map((refund) => {
      const refundMetadata = metadataOf(refund);
      const ownRefundId = refundMetadata["refund_id"];
      return {
        providerRefundId: refund.id,
        status: refund.status,
        amount: fromMinorUnits(refund.amount, stored.minorUnits),
        failureReason:
          typeof refund.failure_reason === "string" && /^[a-z0-9_]{1,64}$/.test(refund.failure_reason)
            ? refund.failure_reason
            : null,
        refundId: ownRefundId !== undefined && REFUND_ID.test(ownRefundId) ? ownRefundId : null,
      };
    });
    return await this.applyRefunds(stored, refunds, {
      amountCaptured: fromMinorUnits(charge.amount_captured, stored.minorUnits),
      amountRefunded: fromMinorUnits(charge.amount_refunded, stored.minorUnits),
    });
  }

  /**
   * Applies the refunds and the charge's amounts under the rows' locks and with their `version`: the payment first,
   * then its refunds (lead decision of 2026-10-21, OADR-0003 point 11: checkout, booking, payment, refund), as
   * `refund.submit` takes them (RefundsRepository.lockParents). A refund of a booking that Stripe reports `succeeded`
   * also writes the booking's customer-visible `refund.succeeded` event (lead decision 6 of 2026-10-22, OBE-068: only
   * Stripe's answer makes a refund refunded), so the refunds' bookings are locked `FOR KEY SHARE` before the payment.
   */
  private async applyRefunds(
    stored: StoredEvent,
    refunds: readonly ProviderRefund[],
    charge: { readonly amountCaptured: string; readonly amountRefunded: string },
  ): Promise<StripeEventOutcome> {
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      // The bookings the refund events reference, before the payment (their foreign keys take FOR KEY SHARE).
      const refundBookings = await this.repository.refundBookingIds(trx, stored.payment.id);
      await this.repository.lockBookings(trx, [...refundBookings.values()], "key share");
      const current = await this.repository.payment(trx, stored.payment.id, true);
      if (current === undefined) {
        return "missing";
      }
      const rows = await this.repository.refundsOfPayment(trx, current.id);
      let changed = false;
      for (const refund of refunds) {
        const row = matchRefund(rows, refund);
        if (row === undefined) {
          // A refund made outside Velexis (the Stripe Dashboard): the payment's amounts below still follow the charge.
          this.logger.warn(
            { paymentId: current.id, providerRefundId: refund.providerRefundId },
            "payments.refund_unmatched",
          );
          continue;
        }
        const update = refundUpdate(row, refund, now);
        if (update === undefined) {
          continue;
        }
        if (!(await this.repository.updateRefund(trx, row.id, row.version, update.values))) {
          throw new Error("the refund changed while its locked row was updated");
        }
        changed = true;
        if (update.status !== row.status) {
          await this.event(trx, current, stored, {
            type: `refund.${update.status}`,
            statusFrom: row.status,
            statusTo: update.status,
            amount: row.amount,
            payload: { refundId: row.id, providerRefundId: refund.providerRefundId },
            now,
          });
          const bookingId = refundBookings.get(row.id);
          if (update.status === "succeeded" && bookingId !== undefined) {
            await this.repository.insertRefundBookingEvent(trx, {
              id: this.ids.newId("evt"),
              kind: "succeeded",
              bookingId,
              refundId: row.id,
              paymentId: current.id,
              amount: row.amount,
              currency: row.currency,
              actor: { type: "system", id: null },
              requestId: stored.event.providerEventId,
              now,
            });
          }
        }
      }
      const paymentUpdate = refundedState(current, charge, now);
      if (paymentUpdate !== undefined) {
        if (!(await this.repository.updatePayment(trx, current.id, current.version, paymentUpdate.values))) {
          throw new Error("the payment changed while its locked row was updated");
        }
        changed = true;
        await this.event(trx, current, stored, {
          type: `payment.${paymentUpdate.status}`,
          statusFrom: current.status,
          statusTo: paymentUpdate.status,
          amount: String(paymentUpdate.values["amount_refunded"]),
          payload: { amountCaptured: paymentUpdate.values["amount_captured"] },
          now,
        });
      }
      return changed ? "applied" : "unchanged";
    });
  }

  // ---- Disputes --------------------------------------------------------------------------------------------------

  private async dispute(
    client: Stripe,
    options: Stripe.RequestOptions | undefined,
    stored: StoredEvent,
  ): Promise<StripeEventOutcome> {
    const { facts, payment } = stored;
    const disputeId = facts.objectId;
    if (disputeId === null) {
      return "ignored";
    }
    const dispute = await this.stripe("disputes.retrieve", stored, () =>
      client.disputes.retrieve(disputeId, {}, options),
    );
    const intentId = payment.providerPaymentId ?? facts.paymentIntentId;
    if (intentId === null || referenceOf(dispute.payment_intent) !== intentId) {
      return this.mismatch(stored, "dispute");
    }
    const currency = /^[a-z]{3}$/.test(dispute.currency) ? dispute.currency.toUpperCase() : payment.currency;
    const amount = fromMinorUnits(dispute.amount, stored.minorUnits);
    const dueBy = dispute.evidence_details?.due_by ?? null;
    const evidenceDueBy = typeof dueBy === "number" ? new Date(dueBy * 1000).toISOString() : null;
    const reason = /^[a-z_]{1,64}$/.test(dispute.reason) ? dispute.reason : "unknown";
    const outcome = await this.tx.run(async (trx): Promise<StripeEventOutcome> => {
      const now = this.clock.now();
      // The alert's outbox row references the payment's booking (its foreign key takes FOR KEY SHARE on it): the
      // booking's lock comes before the payment's, the lock order of a transaction that locks both (OADR-0003 point 11).
      if (payment.bookingId !== null) {
        await this.repository.lockBookings(trx, [payment.bookingId], "key share");
      }
      // The payment's row lock serialises two jobs about the same dispute (two events, or a job BullMQ runs again
      // after a stall), so the check below sees the other one's event and the dispute is recorded once.
      const current = await this.repository.payment(trx, payment.id, true);
      if (current === undefined) {
        return "missing";
      }
      if (
        await this.repository.hasEvent(trx, current.id, "payment.dispute_created", "disputeId", dispute.id)
      ) {
        return "unchanged";
      }
      await this.event(trx, current, stored, {
        type: "payment.dispute_created",
        amount,
        currency,
        payload: {
          disputeId: dispute.id,
          chargeId: referenceOf(dispute.charge),
          reason,
          status: dispute.status,
          evidenceDueBy,
        },
        now,
      });
      await this.alert(trx, current, {
        disputeId: dispute.id,
        reason,
        amount,
        currency,
        evidenceDueBy,
      });
      return "alerted";
    });
    if (outcome === "alerted") {
      this.logger.warn(
        { paymentId: payment.id, disputeId: dispute.id, reason, evidenceDueBy },
        "payments.dispute_created",
      );
    }
    return outcome;
  }

  /** The staff alert of a dispute (outbox `staff.manual_review`, once per dispute). */
  private async alert(
    trx: TenantTransaction,
    payment: PaymentRow,
    dispute: {
      readonly disputeId: string;
      readonly reason: string;
      readonly amount: string;
      readonly currency: string;
      readonly evidenceDueBy: string | null;
    },
  ): Promise<void> {
    const facts = await this.repository.alertFacts(trx, payment.bookingId);
    const adminUrl = this.config.get("PUBLIC_OTA_ADMIN_URL");
    const consolePath =
      payment.bookingId === null ? `payments/${payment.id}` : `bookings/${payment.bookingId}`;
    const consoleUrl = new URL(consolePath, adminUrl.endsWith("/") ? adminUrl : `${adminUrl}/`).toString();
    // The deadline only: in `velexis` mode the dispute is on the Velexis Stripe account, whose Dashboard the OTA's
    // staff cannot open, so the alert does not send them there.
    const due =
      dispute.evidenceDueBy === null ? "" : ` Stripe needs the evidence by ${dispute.evidenceDueBy}.`;
    await this.staffRecipients.enqueue(trx, {
      templateKey: DISPUTE_ALERT_TEMPLATE,
      locale: facts.defaultLocale ?? "en",
      data: {
        booking: {
          reference: facts.bookingReference ?? "",
          recordLocator: facts.recordLocator ?? "",
          consoleUrl,
        },
        review: {
          reason:
            `The card payment ${payment.id} (${dispute.amount} ${dispute.currency}) is disputed at Stripe: ` +
            `dispute ${dispute.disputeId}, reason ${dispute.reason}.${due}`,
        },
      },
      dedupeKey: disputeDedupeKey(dispute.disputeId),
      bookingId: payment.bookingId,
    });
  }

  // ---- Shared ----------------------------------------------------------------------------------------------------

  /** Whether a Stripe object's Velexis metadata names this tenant, this environment and this payment. */
  private isOurs(metadata: Readonly<Record<string, string | undefined>>, payment: PaymentRow): boolean {
    const tenant = this.tenants.require();
    return (
      metadata["payment_id"] === payment.id &&
      metadata["velexis_tenant_id"] === tenant.tenantId &&
      metadata["velexis_environment"] === payment.environment
    );
  }

  /** An object read from Stripe that is not this payment's: a security event, nothing changes. */
  private mismatch(stored: StoredEvent, check: string): StripeEventOutcome {
    this.logger.warn(
      {
        securityEvent: "payments.stripe_event_mismatch",
        check,
        paymentId: stored.payment.id,
        paymentEventId: stored.event.id,
        type: stored.facts.type,
      },
      "payments.stripe_event_mismatch",
    );
    return "mismatch";
  }

  /** Runs one Stripe read; a failure that can pass is retried by BullMQ, a permanent one ends the job. */
  private async stripe<T>(operation: string, stored: StoredEvent, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeError)) {
        throw error;
      }
      const statusCode = typeof error.statusCode === "number" ? error.statusCode : null;
      this.logger.warn(
        {
          operation,
          paymentEventId: stored.event.id,
          stripeErrorType: error.type,
          stripeCode: typeof error.code === "string" ? error.code : null,
          statusCode,
          stripeRequestId: typeof error.requestId === "string" ? error.requestId : null,
        },
        "payments.stripe_event_read_failed",
      );
      const message = `Stripe ${operation} failed: ${error.type}${statusCode === null ? "" : `, HTTP ${statusCode}`}`;
      const permanent = statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
      throw permanent ? new UnrecoverableError(message) : new Error(message);
    }
  }

  /** Appends a `payment_events` row (`source = webhook`) for a change the event caused. */
  private async event(
    trx: TenantTransaction,
    payment: PaymentRow,
    stored: StoredEvent,
    event: {
      readonly type: string;
      readonly statusFrom?: string | undefined;
      readonly statusTo?: string | undefined;
      readonly amount?: string | undefined;
      readonly currency?: string | undefined;
      readonly payload?: Record<string, unknown>;
      readonly now: Date;
    },
  ): Promise<void> {
    await this.repository.insertEvent(trx, {
      id: this.ids.newId("pev"),
      payment_id: payment.id,
      type: event.type,
      source: "webhook",
      status_from: event.statusFrom ?? null,
      status_to: event.statusTo ?? null,
      amount: event.amount ?? null,
      currency: event.amount === undefined ? null : (event.currency ?? payment.currency),
      payload: JSON.stringify(
        redactPayload({
          ...event.payload,
          providerEventId: stored.event.providerEventId,
          paymentEventId: stored.event.id,
        }),
      ),
      created_at: event.now,
      updated_at: event.now,
    });
  }
}

/**
 * The consumer of `ota-stripe-events` (architecture §6, concurrency 4): `stripe.event {tenantId, paymentEventId}`
 * applies one stored event (see the file header); any other job fails at once.
 */
@Processor(OTA_QUEUE.stripeEvents, otaWorkerOptions(OTA_QUEUE.stripeEvents))
export class StripeEventsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly handler: StripeEventHandler,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    @InjectPinoLogger(StripeEventsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<StripeEventResult> {
    const data = job.name === STRIPE_EVENT_JOB ? parseStripeEventJobData(job.data) : undefined;
    if (data === undefined) {
      this.logger.error(
        { queue: job.queueName, jobId: job.id, jobName: String(job.name).slice(0, 64) },
        "payments.stripe_event_job_invalid",
      );
      throw new UnrecoverableError("the job is not stripe.event {tenantId, paymentEventId}");
    }
    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !WEBHOOK_TENANT_STATUSES.includes(tenant.status)) {
      const reason = tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`;
      this.logger.warn({ tenantId: data.tenantId, reason }, "payments.stripe_event_tenant_skipped");
      return { tenantId: data.tenantId, outcome: "skipped", reason };
    }
    const { type, outcome } = await this.tenants.run(jobTenant(tenant, job), () =>
      this.handler.handle(data.paymentEventId),
    );
    return { tenantId: tenant.id, paymentEventId: data.paymentEventId, type, outcome };
  }

  /** A job failed: logged with its id and attempt and the error's name, never the error (it may quote SQL). */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      { queue: OTA_QUEUE.stripeEvents, jobId: job?.id, attempt: job?.attemptsMade, code: error.name },
      "payments.stripe_event_job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections); job failures are the `failed` events above. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: OTA_QUEUE.stripeEvents, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}
