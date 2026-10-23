// The staff alerts of the bookings module (OADR-0013 point 5, OADR-0003 point 5): an outbox `staff.manual_review`
// e-mail to the OTA's `ops_alert_email`, else its support address, else (in the worker) OPS_ALERT_EMAIL, in the
// storefront's default locale, with the booking's reference and a console link, once per dedupe key. The reconciler's
// alerts (OBE-043) are written with it, and since FIX-W27-SYNC (lead decisions (3) and (5) of 2026-10-23) the alert
// of an airline cancellation of a paid booking, which the background sync or a refresh finds, and the alert of a booking
// queue that is nearly full (a Queue List answer of 400 or more entries, at most once a day per OTA).
//
// It runs in both processes, which do not have the same configuration: the worker links to PUBLIC_OTA_ADMIN_URL and
// falls back to OPS_ALERT_EMAIL (`workerStaffAlertOptions`); the API has neither, so it links to
// `https://admin.<STOREFRONT_BASE_DOMAIN>/…` and skips (and logs) an alert of an OTA without an address
// (`apiStaffAlertOptions`), as checkout.complete's alerts do (booking-orchestrator.service.ts).
import { Inject, Injectable, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { EMAIL_ADDRESS, type SharedConfig, type WorkerConfig } from "../config";
import {
  InvalidNotificationError,
  OutboxService,
  type EnqueueNotificationInput,
} from "../notifications/outbox.service";
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
  /** Velexis ops, when the OTA has no address of its own; `null` skips the alert. */
  readonly fallbackTo: string | null;
}

/** The worker's options: PUBLIC_OTA_ADMIN_URL and OPS_ALERT_EMAIL. */
export const workerStaffAlertOptions: FactoryProvider<StaffAlertOptions> = {
  provide: STAFF_ALERT_OPTIONS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<WorkerConfig, true>) => ({
    adminUrl: config.get("PUBLIC_OTA_ADMIN_URL", { infer: true }),
    fallbackTo: config.get("OPS_ALERT_EMAIL", { infer: true }),
  }),
};

/** The API's options: `https://admin.<STOREFRONT_BASE_DOMAIN>`, no fallback address. */
export const apiStaffAlertOptions: FactoryProvider<StaffAlertOptions> = {
  provide: STAFF_ALERT_OPTIONS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<SharedConfig, true>) => ({
    adminUrl: `https://admin.${config.get("STOREFRONT_BASE_DOMAIN", { infer: true })}`,
    fallbackTo: null,
  }),
};

/** One staff alert. */
export interface StaffAlert {
  /** The OTA's settings (the addresses and the default locale); `undefined` without a settings row. */
  readonly settings: Pick<BookingSettingsRow, "opsAlertEmail" | "supportEmail" | "defaultLocale"> | undefined;
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
    private readonly outbox: OutboxService,
    @Inject(STAFF_ALERT_OPTIONS) private readonly options: StaffAlertOptions,
    @InjectPinoLogger(StaffAlerts.name) private readonly logger: PinoLogger,
  ) {}

  /** The recipient of an alert of an OTA with these settings, or `undefined` when there is none. */
  recipientOf(settings: StaffAlert["settings"]): string | undefined {
    return (
      [settings?.opsAlertEmail, settings?.supportEmail].find(
        (address): address is string =>
          address !== null && address !== undefined && EMAIL_ADDRESS.test(address),
      ) ??
      this.options.fallbackTo ??
      undefined
    );
  }

  /** The outbox input of an alert to `to` (the reconciler queues it through its own enqueue). */
  notification(alert: StaffAlert, to: string): EnqueueNotificationInput {
    const base = this.options.adminUrl.endsWith("/") ? this.options.adminUrl : `${this.options.adminUrl}/`;
    const page = alert.booking === null ? (alert.path ?? "bookings") : `bookings/${alert.booking.id}`;
    return {
      templateKey: STAFF_ALERT_TEMPLATE,
      to,
      locale: alert.settings?.defaultLocale ?? alert.fallbackLocale,
      recipientType: "staff",
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
   * without a recipient, or a call the outbox refuses, which is logged: the caller's state is recorded all the same).
   */
  async send(trx: TenantTransaction, alert: StaffAlert): Promise<boolean> {
    const to = this.recipientOf(alert.settings);
    if (to === undefined) {
      this.logger.warn(
        { bookingId: alert.booking?.id ?? null, dedupeKey: alert.dedupeKey },
        "bookings.staff_alert_without_recipient",
      );
      return false;
    }
    try {
      return (await this.outbox.enqueue(trx, this.notification(alert, to))).queued;
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
