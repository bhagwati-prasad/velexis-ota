// Who receives an OTA's staff alerts (OBE-055; OADR-0013 item 5): `staff.ticketing_failed`, `staff.manual_review` and
// `staff.airline_card_alert`. Both processes queue alerts (checkout.complete in the API, the ticketing, reconciliation,
// payments and webhook jobs in the worker), each with `StaffRecipients.enqueue` in its own tenant transaction.
//
// The recipients, the first rule that gives any:
//   1. the OTA's `storefront_settings.ops_alert_email`, when it is one plain e-mail address (an invalid one is logged
//      and skipped);
//   2. else the e-mail addresses of the tenant's owners, read from the platform (read only: `platform.tenant_memberships`
//      and the readable columns of `platform.accounts`, PlatformReadRepository.ownerEmails): active owner memberships
//      whose account is active or locked, verified and not erased, the founder first, at most MAX_OWNER_RECIPIENTS;
//   3. else Velexis ops (OPS_ALERT_EMAIL), so that no alert is lost when an OTA has neither. Both processes read it
//      (the shared configuration since FIX-W28-NOTIFY, lead decision (4) of 2026-10-23: before, only the worker had it,
//      and an alert the API raised, such as a refresh's, was skipped); a process without it skips (and logs) the alert.
// The owners are read on a second connection of the process's pool while the caller's transaction is open: one short
// read-only query with the platform reads' statement timeout, rare (an alert), and a failure of it never fails the
// caller's change: it is logged and the alert goes to rule 3.
//
// One outbox row per recipient, each with its own dedupe key: the first recipient gets the caller's key as it is, so an
// alert of one recipient is deduplicated as before, and every further owner `<key>:<accountId>`. The answer says
// whether a new row was queued; an alert without any recipient queues nothing and answers `queued: false`. A call the
// outbox refuses (InvalidNotificationError) throws, as `OutboxService.enqueue` does: the callers log and skip it.
// Log lines carry ids, the template and the rule used, never an address.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { EMAIL_ADDRESS } from "../config";
import { PlatformReadRepository } from "../tenancy/platform-read.repository";
import { TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import { OutboxService, type EnqueueNotificationInput } from "./outbox.service";
import { TEMPLATE_REGISTRY, type TemplateKey } from "./templates/registry";

/** The most owners one alert is sent to. */
export const MAX_OWNER_RECIPIENTS = 10;

/** Which rule gave a recipient (see the file header). */
export type StaffRecipientSource = "ops_alert_email" | "owner" | "velexis_ops";

/** One recipient of a staff alert. */
export interface StaffRecipient {
  readonly email: string;
  readonly source: StaffRecipientSource;
  /** The owner's `acc_…` id; `null` for the other rules. */
  readonly accountId: string | null;
}

/** A staff alert to queue: the outbox call without its recipient, which this service chooses. */
export interface StaffAlertInput extends Omit<
  EnqueueNotificationInput,
  "to" | "recipientType" | "customerId" | "dedupeKey"
> {
  /** Makes the alert once only per recipient (`notifications_dedupe_uq`), such as `staff.ticketing_failed:bkg_…`. */
  readonly dedupeKey: string;
}

/** What `enqueue` did. */
export interface StaffAlertResult {
  /** True when at least one new row was queued. */
  readonly queued: boolean;
  /** The recipients the alert went to; none when the OTA has none (the alert is skipped). */
  readonly recipients: readonly StaffRecipient[];
}

/** The dedupe key of the alert to the `index`-th recipient (see the file header). */
export function staffDedupeKey(dedupeKey: string, recipient: StaffRecipient, index: number): string {
  return index === 0 || recipient.accountId === null ? dedupeKey : `${dedupeKey}:${recipient.accountId}`;
}

/** The recipients of the rules after `ops_alert_email`: the owners, else the fallback (see the file header). */
export function ownerRecipients(
  owners: readonly { readonly accountId: string; readonly email: string }[],
  fallback: string | null,
): StaffRecipient[] {
  const seen = new Set<string>();
  const recipients: StaffRecipient[] = [];
  for (const owner of owners) {
    const address = owner.email.toLowerCase();
    if (!EMAIL_ADDRESS.test(owner.email) || seen.has(address)) {
      continue;
    }
    seen.add(address);
    recipients.push({ email: owner.email, source: "owner", accountId: owner.accountId });
  }
  if (recipients.length > 0) {
    return recipients.slice(0, MAX_OWNER_RECIPIENTS);
  }
  return fallback === null ? [] : [{ email: fallback, source: "velexis_ops", accountId: null }];
}

/** Chooses the recipients of the staff alerts and queues them (see the file header). Both processes. */
@Injectable()
export class StaffRecipients {
  /** OPS_ALERT_EMAIL of either process; `null` when the process has none (it is optional). */
  private readonly fallback: string | null;

  constructor(
    private readonly platform: PlatformReadRepository,
    private readonly tenants: TenantContext,
    private readonly outbox: OutboxService,
    config: ConfigService,
    @InjectPinoLogger(StaffRecipients.name) private readonly logger: PinoLogger,
  ) {
    const fallback: unknown = config.get("OPS_ALERT_EMAIL");
    this.fallback = typeof fallback === "string" && EMAIL_ADDRESS.test(fallback) ? fallback : null;
  }

  /** The recipients of the tenant of the current context, in `trx`, an open transaction of `TenantTx.run`. */
  async resolve(trx: TenantTransaction): Promise<readonly StaffRecipient[]> {
    const settings = await trx.selectFrom("storefront_settings").select("ops_alert_email").executeTakeFirst();
    const own = settings?.ops_alert_email ?? null;
    if (own !== null && EMAIL_ADDRESS.test(own)) {
      return [{ email: own, source: "ops_alert_email", accountId: null }];
    }
    const tenant = this.tenants.require();
    if (own !== null) {
      this.logger.warn({ tenantId: tenant.tenantId }, "notifications.ops_alert_email_invalid");
    }
    let owners: readonly { readonly accountId: string; readonly email: string }[] = [];
    try {
      owners = await this.platform.ownerEmails(tenant.tenantId, MAX_OWNER_RECIPIENTS);
    } catch (error) {
      const code = error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "Error";
      this.logger.error({ tenantId: tenant.tenantId, code }, "notifications.staff_owners_unreadable");
    }
    return ownerRecipients(owners, this.fallback);
  }

  /**
   * Queues the staff alert `input` in `trx` to each recipient (see the file header). Throws
   * `InvalidNotificationError` for a call the outbox refuses, and a `TypeError` for a key that is not a staff key.
   */
  async enqueue(trx: TenantTransaction, input: StaffAlertInput): Promise<StaffAlertResult> {
    const key: TemplateKey = input.templateKey;
    if (TEMPLATE_REGISTRY[key].audience !== "staff") {
      throw new TypeError(`StaffRecipients.enqueue: ${key} is not a staff template`);
    }
    const recipients = await this.resolve(trx);
    if (recipients.length === 0) {
      this.logger.warn(
        { bookingId: input.bookingId ?? null, template: key },
        "notifications.staff_alert_without_recipient",
      );
      return { queued: false, recipients };
    }
    let queued = false;
    for (const [index, recipient] of recipients.entries()) {
      const result = await this.outbox.enqueue(trx, {
        ...input,
        to: recipient.email,
        recipientType: "staff",
        dedupeKey: staffDedupeKey(input.dedupeKey, recipient, index),
      });
      queued ||= result.queued;
    }
    this.logger.debug(
      {
        bookingId: input.bookingId ?? null,
        template: key,
        source: recipients[0]?.source,
        recipients: recipients.length,
      },
      "notifications.staff_alert_queued",
    );
    return { queued, recipients };
  }
}
