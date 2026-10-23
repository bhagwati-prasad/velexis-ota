// The staff alerts of the bookings module (OADR-0013 point 5, OADR-0003 point 5): an outbox `staff.manual_review`
// e-mail to the recipients of OBE-055's StaffRecipients (notifications/staff-recipients.ts: the OTA's
// `ops_alert_email`, else its owners, else, in the worker only, OPS_ALERT_EMAIL), in the storefront's default locale,
// with the booking's reference and a console link, once per dedupe key and recipient. The reconciler's
// alerts (OBE-043) are written with it, and since FIX-W27-SYNC (lead decisions (3) and (5) of 2026-10-23) the alert
// of an airline cancellation of a paid booking, which the background sync or a refresh finds, and the alert of a booking
// queue that is nearly full (a Queue List answer of 400 or more entries, at most once a day per OTA).
//
// It runs in both processes, which do not have the same configuration: the worker links to PUBLIC_OTA_ADMIN_URL
// (`workerStaffAlertOptions`); the API has none, so it links to `https://admin.<STOREFRONT_BASE_DOMAIN>/…`
// (`apiStaffAlertOptions`). StaffRecipients falls back to OPS_ALERT_EMAIL in the worker only; the API skips (and logs)
// an alert of an OTA with neither an alert address nor an owner, as checkout.complete's alerts do.
import { Inject, Injectable, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { SharedConfig, WorkerConfig } from "../config";
import { InvalidNotificationError } from "../notifications/outbox.service";
import { StaffRecipients, type StaffAlertInput } from "../notifications/staff-recipients";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import type { BookingSettingsRow } from "./bookings.repository";

/** The template of every staff alert of the bookings module. */
export const STAFF_ALERT_TEMPLATE = "staff.manual_review";

/** Injection token of the process's StaffAlertOptions. */
export const STAFF_ALERT_OPTIONS = "STAFF_ALERT_OPTIONS";

/** What differs between the processes (see the file header). */
export interface StaffAlertOptions {
  /** The OTA admin's base URL, for the console links. */
  readonly adminUrl: string;
}

/** The worker's options: PUBLIC_OTA_ADMIN_URL. */
export const workerStaffAlertOptions: FactoryProvider<StaffAlertOptions> = {
  provide: STAFF_ALERT_OPTIONS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<WorkerConfig, true>) => ({
    adminUrl: config.get("PUBLIC_OTA_ADMIN_URL", { infer: true }),
  }),
};

/** The API's options: `https://admin.<STOREFRONT_BASE_DOMAIN>`. */
export const apiStaffAlertOptions: FactoryProvider<StaffAlertOptions> = {
  provide: STAFF_ALERT_OPTIONS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<SharedConfig, true>) => ({
    adminUrl: `https://admin.${config.get("STOREFRONT_BASE_DOMAIN", { infer: true })}`,
  }),
};

/** One staff alert. */
export interface StaffAlert {
  /** The OTA's settings (its default locale); `undefined` without a settings row. */
  readonly settings: Pick<BookingSettingsRow, "defaultLocale"> | undefined;
  /** The locale without a settings row (the tenant's default). */
  readonly fallbackLocale: string;
  /** The booking it is about, or `null` for an alert about the OTA (its console link is then `path`). */
  readonly booking: {
    readonly id: string;
    readonly reference: string;
    readonly recordLocator?: string | null;
  } | null;
  /** The console page of an alert without a booking, relative to the OTA admin (`bookings`). */
  readonly path?: string;
  /** Makes the alert once only (`notifications_dedupe_uq`). */
  readonly dedupeKey: string;
  /** What happened and what staff should do: ids, amounts, counts and codes, never a person's data. */
  readonly reason: string;
}

/** Writes the staff alerts (see the file header). */
@Injectable()
export class StaffAlerts {
  constructor(
    private readonly recipients: StaffRecipients,
    @Inject(STAFF_ALERT_OPTIONS) private readonly options: StaffAlertOptions,
    @InjectPinoLogger(StaffAlerts.name) private readonly logger: PinoLogger,
  ) {}

  /** The StaffRecipients input of an alert: everything but its recipients, which StaffRecipients chooses. */
  input(alert: StaffAlert): StaffAlertInput {
    const base = this.options.adminUrl.endsWith("/") ? this.options.adminUrl : `${this.options.adminUrl}/`;
    const page = alert.booking === null ? (alert.path ?? "bookings") : `bookings/${alert.booking.id}`;
    return {
      templateKey: STAFF_ALERT_TEMPLATE,
      locale: alert.settings?.defaultLocale ?? alert.fallbackLocale,
      bookingId: alert.booking?.id ?? null,
      dedupeKey: alert.dedupeKey,
      data: {
        booking: {
          reference: alert.booking?.reference ?? "",
          recordLocator: alert.booking?.recordLocator ?? "",
          consoleUrl: new URL(page, base).toString(),
        },
        review: { reason: alert.reason },
      },
    };
  }

  /**
   * Queues the alert in `trx`; answers whether a new e-mail was queued (`false` for a repeated dedupe key, an OTA
   * without a recipient, which StaffRecipients logs, or a call the outbox refuses, which is logged: the caller's state
   * is recorded all the same).
   */
  async send(trx: TenantTransaction, alert: StaffAlert): Promise<boolean> {
    try {
      return (await this.recipients.enqueue(trx, this.input(alert))).queued;
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.warn(
        { bookingId: alert.booking?.id ?? null, template: STAFF_ALERT_TEMPLATE },
        "bookings.staff_alert_invalid",
      );
      return false;
    }
  }
}
