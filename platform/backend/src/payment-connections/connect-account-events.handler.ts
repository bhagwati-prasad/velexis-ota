// The Connect account events of the platform's Connect endpoint (PBE-056; Stripe payments flow §C item 5 and "Failure
// handling", PADR-0011 items 3 and 4, api-inventory-admin.md §8, scope PF-61 AC2). ConnectWebhookController stores
// them in the inbox with `endpoint = 'connect_accounts'` and the connected `acct_…` (`stripe_events.account`); the one
// `platform-stripe-events` processor (billing/sync/stripe-events.processor.ts) runs this handler for them while
// FEATURE_OWN_STRIPE is on. The event's `account` is the routing key: the handler works on the `connect_standard`
// payment connections whose `account_reference` it is (`payment_provider_connections_connect_uq` keeps one OTA per
// account and environment, so in practice the test and the live connection of one OTA). An account no OTA's
// `connect_standard` connection holds ends `ignored` (`UNKNOWN_ACCOUNT`), and Stripe is not called.
//
// `account.updated`: re-fetch the account (`stripe.accounts.retrieve(acct_…)`, never the payload, PADR-0002 item 5),
// then refresh every such connection in one transaction: `capabilities` (`chargesEnabled`, `payoutsEnabled`,
// `detailsSubmitted`) and, for a connection that is `pending` or `active`, `status` (`active` when the account can take
// charges, `pending` otherwise), `version + 1`, one `payments.connect_status_changed` audit row per connection that
// changed (status and capabilities before and after, actor `system`), and `{type: "connection", tenantId}` after the
// commit, so the OTA backend stops answering `PAYMENT_PROVIDER_NOT_CONFIGURED` once the account can charge. A
// connection whose values Stripe confirms is not written. Other states are kept: a connection the OTA deauthorised
// (`disabled` with `disconnected_at`) is skipped, and Stripe is not asked at all when every connection is such a one
// (`ACCOUNT_DISCONNECTED`); a connection a platform admin disabled (`disabled` without `disconnected_at`) gets the
// capabilities only and stays `disabled`. Stripe refusing the account (403, `account_invalid`, or 404: Velexis's access
// is gone, the deauthorisation event follows) ends the event `ignored` (`ACCOUNT_UNREACHABLE`); any other Stripe error
// fails the attempt as the processor records failures (retried for a network error, a rate limit or a 5xx).
//
// Two events of one account may run together (the processor's concurrency is 2) and Stripe sends several
// `account.updated` in a row during onboarding, so an older re-fetch must never outlive a newer one. Two rules keep it
// so, without a lock held during the Stripe call and without a transaction open during it:
//
// - the handler reads the connections (their ids and versions) before the re-fetch and locks them in its transaction
//   after it: when any changed meanwhile (another event, the owner, an admin), it commits nothing and re-fetches;
// - a re-fetch that finds nothing to change leaves no trace in the versions, so another event's older answer, fetched
//   before it, could still pass that check and commit after it. So a refresh that wrote is never the last word: the
//   handler re-fetches again after its commit, and the event ends only when a re-fetch made after the last write
//   confirms the connections (or finds every connection deauthorised, gone or out of Stripe's reach meanwhile: the
//   event that wrote is `processed` all the same).
//
// Each round re-fetches once; after REFRESH_TRIES rounds without that confirmation the event fails with the retryable
// `CONNECTION_BUSY`, and BullMQ runs it again later.
//
// `account.application.deauthorized` (the OTA disconnected Velexis in Stripe): one transaction locks the connections
// and sets each `status = 'disabled'` and `disconnected_at` (`version + 1`, the mode stays `connect_standard` and the
// account reference stays: no fallback to Velexis mode, PADR-0011 item 4), one `payments.connect_disconnected` audit row
// per connection, the e-mail `connection.stripe_disconnected` (PADR-0013 item 5) once to every active owner of the OTA
// (keyed by the event, so a re-run sends none twice; none for an OTA its members no longer see) and the `connection`
// invalidation after the commit. Stripe is not called: the event is signed, and its data is the Velexis application,
// not the account. It is idempotent, and two guards keep it from undoing a later decision:
//
// - a connection connected again after the deauthorisation (`connected_at` in a later second than the event's
//   `created`, a late or retried delivery) is kept, and an event that only finds such connections ends `ignored`
//   (`STALE_EVENT`);
// - a connection a platform admin disabled (`disabled` without `disconnected_at`) is kept as it is, so the admin's
//   disable still holds against the OTA's own reconnect (a callback refuses such a connection; FIX-W36-PLATFORM, lead
//   decision (2h) of 2026-10-30); the skip is logged (`stripe_connect.deauthorized_admin_disabled`) and recorded in
//   one audit row per connection and event, `payments.connect_deauthorized_while_disabled` (actor `system`, the
//   environment, the `acct_…`, the event id and type, and the status it keeps; no `before` or `after`, since nothing
//   changes), so the admin sees that the OTA also revoked Velexis in Stripe. Its status, `disconnected_at` and
//   version stay, no e-mail is queued and nothing is invalidated (FIX-W37-PLATFORM, lead decision (2k) of
//   2026-10-31). A re-run of the same event finds its row (`AuditService.hasEventEntry`) and writes none again. A
//   deauthorisation older than such a connection (the stale rule above: it revoked an earlier connection, and Velexis
//   was connected again since) writes no row, since it would tell the admin of a revocation that no longer holds.
//
// Each event resolves to the OTA of its connections (`stripe_events.tenant_id`). Log lines carry the event id, the OTA
// and the `acct_…`; never a payload, a token or an e-mail address. "Now" is the injected Clock's time.
import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { MEMBER_VISIBLE_TENANT_STATUSES } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { StripeClient } from "../common/stripe/stripe.client";
import {
  HandlesStripeEvents,
  StripeEventFailure,
  type StripeEventHandler,
  type StripeEventOutcome,
  type StripeInboxEvent,
} from "../common/stripe/stripe-inbox.service";
import { OutboxService } from "../notifications/outbox.service";
import {
  PaymentConnectionsRepository,
  type ConnectCapabilities,
  type PaymentConnectionView,
} from "./payment-connections.repository";
import { connectCapabilitiesOf } from "./stripe-connect.service";

/** The two event types of the Connect endpoint (PADR-0011 item 3). */
export const ACCOUNT_UPDATED = "account.updated";
export const ACCOUNT_DEAUTHORIZED = "account.application.deauthorized";

/** The `actorLabel` of the audit rows these events write (actor `system`). */
export const CONNECT_EVENTS_ACTOR_LABEL = "stripe.connect_events";

/** The audit action of a deauthorisation that finds a connection a platform admin disabled (nothing changes). */
export const DEAUTHORIZED_WHILE_DISABLED_ACTION = "payments.connect_deauthorized_while_disabled";

/** The e-mail to the owners of a deauthorised connection (PADR-0013 item 5). */
export const STRIPE_DISCONNECTED_TEMPLATE = "connection.stripe_disconnected";

/**
 * How many re-fetches one attempt of `account.updated` makes at most (file header): one that writes and the one that
 * confirms it after its commit, and room for two more when the connections changed during a re-fetch.
 */
export const REFRESH_TRIES = 4;

/** The connection fields the rules below read. */
type ConnectRow = Pick<
  PaymentConnectionView,
  | "id"
  | "tenant_id"
  | "environment"
  | "status"
  | "capabilities"
  | "connected_at"
  | "disconnected_at"
  | "version"
>;

/** A connection the OTA deauthorised in Stripe: `disabled` with `disconnected_at`. */
export function isDeauthorized(row: Pick<ConnectRow, "status" | "disconnected_at">): boolean {
  return row.status === "disabled" && row.disconnected_at !== null;
}

/** A connection a platform admin disabled (`adminSetConnectionStatus`): `disabled` without `disconnected_at`. */
export function isDisabledByAdmin(row: Pick<ConnectRow, "status" | "disconnected_at">): boolean {
  return row.status === "disabled" && row.disconnected_at === null;
}

/**
 * The status of a connection after `account.updated`: `active` when the account can take charges and `pending`
 * otherwise, for a connection that is one of the two; any other status (`disabled`, `error`) is kept.
 */
export function refreshedStatus(current: string, capabilities: ConnectCapabilities): string {
  if (current !== "pending" && current !== "active") {
    return current;
  }
  return capabilities.chargesEnabled ? "active" : "pending";
}

/** True when the stored `capabilities` (jsonb) are exactly `capabilities`. */
export function sameCapabilities(stored: unknown, capabilities: ConnectCapabilities): boolean {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return false;
  }
  const record = stored as Record<string, unknown>;
  const keys = Object.keys(capabilities) as Array<keyof ConnectCapabilities>;
  return Object.keys(record).length === keys.length && keys.every((key) => record[key] === capabilities[key]);
}

/** True when two reads of an account's connections are the same rows at the same versions. */
export function sameRowVersions(
  before: ReadonlyArray<Pick<ConnectRow, "id" | "version">>,
  after: ReadonlyArray<Pick<ConnectRow, "id" | "version">>,
): boolean {
  return (
    before.length === after.length &&
    before.every((row, index) => row.id === after[index]?.id && row.version === after[index]?.version)
  );
}

/**
 * True when the deauthorisation event is older than the connection: the event's `created` (whole seconds) is in an
 * earlier second than `connected_at`, so the OTA connected the account again after it. An event of the same second
 * still applies (disabling is the safe side).
 */
export function isStaleDeauthorization(eventCreatedAt: Date, connectedAt: Date | null): boolean {
  return (
    connectedAt !== null &&
    Math.floor(eventCreatedAt.getTime() / 1000) < Math.floor(connectedAt.getTime() / 1000)
  );
}

/**
 * True when Stripe refused the account itself: 403 (`StripePermissionError`, `account_invalid`: Velexis's access was
 * revoked) or 404 (no such account). Any other error is a failure the processor retries or records.
 */
export function isAccountUnreachable(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeError)) {
    return false;
  }
  return (
    error instanceof Stripe.errors.StripePermissionError ||
    error.code === "account_invalid" ||
    error.statusCode === 403 ||
    error.statusCode === 404
  );
}

/** The capabilities and status of a connection, as the audit rows record them. */
function stateOf(row: Pick<ConnectRow, "status" | "capabilities">): Record<string, unknown> {
  return { status: row.status, capabilities: row.capabilities };
}

/** The OTAs of `rows`, each once, in the rows' order. */
function tenantsOf(rows: ReadonlyArray<Pick<ConnectRow, "tenant_id">>): string[] {
  return [...new Set(rows.map((row) => row.tenant_id))];
}

const ignored = (reason: string, tenantId: string | null = null): StripeEventOutcome => ({
  status: "ignored",
  reason,
  tenantId,
});

@Injectable()
@HandlesStripeEvents("connect_accounts", [ACCOUNT_UPDATED, ACCOUNT_DEAUTHORIZED])
export class ConnectAccountEventsHandler implements StripeEventHandler {
  constructor(
    private readonly connections: PaymentConnectionsRepository,
    private readonly stripe: StripeClient,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(ConnectAccountEventsHandler.name) private readonly logger: PinoLogger,
  ) {}

  async handle(event: StripeInboxEvent): Promise<StripeEventOutcome> {
    const accountReference = event.account;
    if (accountReference === null) {
      // The receiver requires `account`; a row without one was not stored by it.
      return ignored("NO_ACCOUNT: the event names no connected account");
    }
    switch (event.type) {
      case ACCOUNT_UPDATED:
        return this.accountUpdated(event, accountReference);
      case ACCOUNT_DEAUTHORIZED:
        return this.deauthorized(event, accountReference);
      default:
        return ignored(`UNHANDLED_EVENT_TYPE: no handler for ${event.type}`);
    }
  }

  /**
   * `account.updated` (file header): re-fetch, then refresh the connections that did not change meanwhile, round after
   * round, until a re-fetch made after the last write confirms them.
   */
  private async accountUpdated(
    event: StripeInboxEvent,
    accountReference: string,
  ): Promise<StripeEventOutcome> {
    let tenantId: string | null = null;
    // True once a round committed a write: the event is `processed` then, however a later round ends.
    let wrote = false;
    const end = (outcome: StripeEventOutcome): StripeEventOutcome =>
      wrote ? { status: "processed", tenantId } : outcome;
    for (let attempt = 1; attempt <= REFRESH_TRIES; attempt += 1) {
      const seen = await this.connections.connectRowsOfAccount(accountReference);
      const [first] = seen;
      if (first === undefined) {
        return end(ignored("UNKNOWN_ACCOUNT: no OTA's Connect connection holds the account"));
      }
      tenantId = first.tenant_id;
      if (seen.every(isDeauthorized)) {
        return end(ignored("ACCOUNT_DISCONNECTED: the OTA deauthorised Velexis from the account", tenantId));
      }
      let capabilities: ConnectCapabilities;
      try {
        capabilities = connectCapabilitiesOf(await this.stripe.api().accounts.retrieve(accountReference));
      } catch (error) {
        if (isAccountUnreachable(error)) {
          const status = error instanceof Stripe.errors.StripeError ? error.statusCode : undefined;
          return end(
            ignored(
              `ACCOUNT_UNREACHABLE: Stripe answered ${status === undefined ? "an error" : String(status)} for the account`,
              tenantId,
            ),
          );
        }
        throw error;
      }
      const changed = await runInTransaction(this.db, async (trx) => {
        const locked = await this.connections.lockConnectRowsOfAccount(trx, accountReference);
        if (!sameRowVersions(seen, locked)) {
          return undefined;
        }
        return this.refresh(trx, event, accountReference, locked, capabilities);
      });
      const line = { eventId: event.id, tenantId, stripeAccount: accountReference, attempt };
      if (changed === undefined) {
        this.logger.info(line, "stripe_connect.account_changed_during_refresh");
        continue;
      }
      if (changed.length === 0) {
        // Stripe confirms what the connections hold, and nothing was written since they were read.
        this.logger.info(
          { ...line, chargesEnabled: capabilities.chargesEnabled },
          "stripe_connect.account_confirmed",
        );
        return { status: "processed", tenantId };
      }
      wrote = true;
      this.logger.info(
        {
          ...line,
          changed: changed.map((row) => row.id),
          chargesEnabled: capabilities.chargesEnabled,
        },
        "stripe_connect.account_refreshed",
      );
      // The next round re-fetches after this commit and confirms it (file header).
    }
    throw new StripeEventFailure("CONNECTION_BUSY", "no re-fetch of the account confirmed its connections", {
      retryable: true,
      tenantId,
    });
  }

  /** The writes of `account.updated` on the locked connections; answers the connections it changed. */
  private async refresh(
    trx: PlatformTransaction,
    event: StripeInboxEvent,
    accountReference: string,
    locked: readonly PaymentConnectionView[],
    capabilities: ConnectCapabilities,
  ): Promise<PaymentConnectionView[]> {
    const now = this.clock.now();
    const changed: PaymentConnectionView[] = [];
    for (const row of locked) {
      if (isDeauthorized(row)) {
        continue;
      }
      const status = refreshedStatus(row.status, capabilities);
      if (status === row.status && sameCapabilities(row.capabilities, capabilities)) {
        continue;
      }
      const updated = await this.connections.refreshConnectAccount(trx, row.id, {
        capabilities,
        status,
        now,
      });
      await this.audit.record(trx, {
        actorType: "system",
        actorLabel: CONNECT_EVENTS_ACTOR_LABEL,
        action: "payments.connect_status_changed",
        targetType: "payment_connection",
        targetId: updated.id,
        tenantId: updated.tenant_id,
        before: stateOf(row),
        after: { status: updated.status, capabilities },
        details: {
          environment: updated.environment,
          accountReference,
          eventId: event.id,
          eventType: event.type,
        },
      });
      changed.push(updated);
    }
    for (const tenantId of tenantsOf(changed)) {
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
    }
    return changed;
  }

  /** `account.application.deauthorized` (file header): disable the connections, audit, e-mail the owners. */
  private async deauthorized(event: StripeInboxEvent, accountReference: string): Promise<StripeEventOutcome> {
    return runInTransaction(this.db, async (trx): Promise<StripeEventOutcome> => {
      const locked = await this.connections.lockConnectRowsOfAccount(trx, accountReference);
      const [first] = locked;
      if (first === undefined) {
        return ignored("UNKNOWN_ACCOUNT: no OTA's Connect connection holds the account");
      }
      const tenantId = first.tenant_id;
      const now = this.clock.now();
      const disconnected: PaymentConnectionView[] = [];
      let stale = 0;
      for (const row of locked) {
        const context = { eventId: event.id, tenantId: row.tenant_id, connectionId: row.id };
        if (isDeauthorized(row)) {
          continue;
        }
        if (isDisabledByAdmin(row)) {
          this.logger.warn(
            { ...context, stripeAccount: accountReference },
            "stripe_connect.deauthorized_admin_disabled",
          );
          await this.recordDeauthorizedWhileDisabled(trx, event, accountReference, row);
          continue;
        }
        if (isStaleDeauthorization(event.stripeCreatedAt, row.connected_at)) {
          stale += 1;
          this.logger.info(
            { ...context, stripeAccount: accountReference },
            "stripe_connect.deauthorization_stale",
          );
          continue;
        }
        const updated = await this.connections.disconnectConnect(trx, row.id, now);
        await this.audit.record(trx, {
          actorType: "system",
          actorLabel: CONNECT_EVENTS_ACTOR_LABEL,
          action: "payments.connect_disconnected",
          targetType: "payment_connection",
          targetId: updated.id,
          tenantId: updated.tenant_id,
          before: { status: row.status, disconnectedAt: null },
          after: {
            accountMode: updated.account_mode,
            status: updated.status,
            disconnectedAt: now.toISOString(),
          },
          details: {
            environment: updated.environment,
            accountReference,
            eventId: event.id,
            eventType: event.type,
          },
        });
        disconnected.push(updated);
      }
      if (disconnected.length === 0 && stale > 0) {
        return ignored("STALE_EVENT: the account was connected again after this deauthorisation", tenantId);
      }
      for (const disconnectedTenant of tenantsOf(disconnected)) {
        await this.notifyOwners(trx, disconnectedTenant, event);
        this.invalidations.publishAfterCommit(trx, {
          v: 1,
          type: "connection",
          tenantId: disconnectedTenant,
        });
      }
      this.logger.info(
        {
          eventId: event.id,
          tenantId,
          stripeAccount: accountReference,
          disconnected: disconnected.map((row) => row.id),
        },
        "stripe_connect.account_deauthorized",
      );
      return { status: "processed", tenantId };
    });
  }

  /**
   * The audit row of a deauthorisation that found `row` disabled by a platform admin (file header): written once per
   * connection and event, in `trx`, and not for a deauthorisation older than the connection (`isStaleDeauthorization`);
   * the connection itself is not written.
   */
  private async recordDeauthorizedWhileDisabled(
    trx: PlatformTransaction,
    event: StripeInboxEvent,
    accountReference: string,
    row: PaymentConnectionView,
  ): Promise<void> {
    if (isStaleDeauthorization(event.stripeCreatedAt, row.connected_at)) {
      return;
    }
    const target = { targetType: "payment_connection", targetId: row.id } as const;
    if (
      await this.audit.hasEventEntry(trx, {
        action: DEAUTHORIZED_WHILE_DISABLED_ACTION,
        ...target,
        eventId: event.id,
      })
    ) {
      return;
    }
    await this.audit.record(trx, {
      actorType: "system",
      actorLabel: CONNECT_EVENTS_ACTOR_LABEL,
      action: DEAUTHORIZED_WHILE_DISABLED_ACTION,
      ...target,
      tenantId: row.tenant_id,
      details: {
        environment: row.environment,
        accountReference,
        eventId: event.id,
        eventType: event.type,
        status: row.status,
      },
    });
  }

  /**
   * Queues `connection.stripe_disconnected` to every active owner of `tenantId`, once per owner and event, while the
   * OTA's members still see it.
   */
  private async notifyOwners(
    trx: PlatformTransaction,
    tenantId: string,
    event: Pick<StripeInboxEvent, "id">,
  ): Promise<void> {
    const tenant = await this.connections.tenantLabel(tenantId, trx);
    if (
      tenant === undefined ||
      tenant.deleted_at !== null ||
      !(MEMBER_VISIBLE_TENANT_STATUSES as readonly string[]).includes(tenant.status)
    ) {
      return;
    }
    const paymentsUrl = this.outbox.portalLink(`/otas/${tenantId}/payments`);
    for (const owner of await this.connections.activeOwners(trx, tenantId)) {
      await this.outbox.queue(trx, {
        templateKey: STRIPE_DISCONNECTED_TEMPLATE,
        to: owner.email,
        accountId: owner.account_id,
        tenantId,
        data: {
          fullName: owner.full_name,
          tenantName: tenant.name,
          tenantKey: tenant.key,
          paymentsUrl,
        },
        idempotencyKey: `stripe_disconnected:${tenantId}:${event.id}`,
      });
    }
  }
}
