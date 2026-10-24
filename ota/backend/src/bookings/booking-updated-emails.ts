// The `booking.updated` e-mails (OADR-0013 item 4 as revised on 2026-10-23, lead decision (3) of 2026-10-23,
// FIX-W28-NOTIFY): what tells the traveller that a booking changed after it was made. Two use cases send them, each in
// the transaction that records the change (the outbox of OADR-0013 item 1):
//   - bookings.update when it changed the contacts (booking-changes.service.ts, OBE-048);
//   - console.bookings.patch with `notifyCustomer` after a change Amadeus answered
//     (console/console-booking-actions.service.ts, OBE-062).
//
// The full e-mail goes to the booking's contact e-mail as it is after the change, in the primary contact's language
// when it is a locale (else the storefront's default locale), with the booking as it is now: its reference, record
// locator, total, the primary contact's name, the travellers and flights, the link to the booking page on the
// storefront host (`/booking.html?id=bkg_…`, OADR-0015 point 5) and `update.contactsChanged`; the sender attaches the
// newest ready itinerary, or the e-mail points to the booking page (notifications/attachments.ts, OADR-0013 item 8).
//
// When the change moved the contact e-mail, the previous address gets the short notice of the same key
// (`update.contactNotice: true`, CONTACT_NOTICE_VARIABLE), in the previous primary contact's language when it is a
// locale (else the default locale): the booking reference and nothing else of the booking (every other booking
// variable is empty: no names, flights, amounts, link, and never the new address) and no attachment, so whoever reads
// the old mailbox learns only that the contact details changed and whom to tell if nobody asked for it.
//
// Dedupe keys `<prefix>:<bkg_…>:v<version>:new|old`, the prefix the caller's (`booking.contacts_updated` for
// bookings.update, `booking.patched` for the console). A call the outbox refuses (InvalidNotificationError, raised before
// any SQL) is logged and skipped: the change happened at Amadeus and is recorded all the same. Log lines carry ids only,
// never an address.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { SharedConfig } from "../config";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import type { TemplateKey } from "../notifications/templates/registry";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import {
  BookingsRepository,
  type BookingRow,
  type BookingSegmentRow,
  type BookingTravelerRow,
} from "./bookings.repository";

/** The template of both e-mails (see the file header). */
export const BOOKING_UPDATED_TEMPLATE: TemplateKey = "booking.updated";

/** A BCP 47 tag the outbox accepts as a locale (outbox.service.ts). */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** The booking an e-mail describes, as it is after the change. */
export interface UpdatedBooking {
  readonly booking: Pick<
    BookingRow,
    "id" | "reference" | "recordLocator" | "totalAmount" | "currency" | "customerId"
  >;
  readonly travelers: readonly Pick<BookingTravelerRow, "firstName" | "lastName">[];
  readonly segments: readonly Pick<
    BookingSegmentRow,
    "departureIata" | "arrivalIata" | "departureLocal" | "arrivalLocal" | "carrierCode" | "flightNumber"
  >[];
}

/** Who gets the full e-mail: the booking's primary contact after the change. */
export interface UpdatedBookingContact {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** The contact's language; used as the locale when it is one. */
  readonly language: string | null;
}

/** One change to tell the traveller about (see the file header). */
export interface BookingUpdatedInput extends UpdatedBooking {
  /** The tenant's key: the storefront host of the booking link. */
  readonly tenantKey: string;
  readonly contact: UpdatedBookingContact;
  /** The booking's contact e-mail before the change; the notice goes to it when it differs from `contact.email`. */
  readonly previousEmail: string | null;
  /** The previous primary contact's language: the notice's locale when it is one. */
  readonly previousLanguage: string | null;
  /** The change replaced the booking's contact details. */
  readonly contactsChanged: boolean;
  /** The first part of the dedupe keys, such as `booking.contacts_updated`. */
  readonly dedupePrefix: string;
  /** The booking's `version` after the change. */
  readonly version: number;
}

/** What `send` queued. */
export interface BookingUpdatedResult {
  /** The full e-mail to the contact e-mail was queued now. */
  readonly updated: boolean;
  /** The notice to the previous address was queued now (`false` when the address did not change). */
  readonly notice: boolean;
}

/** The variables of the full e-mail (see the file header). */
export function bookingUpdatedData(
  input: UpdatedBooking & {
    readonly contact: Pick<UpdatedBookingContact, "firstName" | "lastName">;
    readonly bookingUrl: string;
    readonly contactsChanged: boolean;
  },
): Record<string, unknown> {
  return {
    booking: {
      reference: input.booking.reference,
      recordLocator: input.booking.recordLocator ?? "",
      url: input.bookingUrl,
      total: { amount: input.booking.totalAmount, currency: input.booking.currency },
      contact: { firstName: input.contact.firstName ?? "", lastName: input.contact.lastName ?? "" },
      travellers: input.travelers.map((traveler) => ({
        firstName: traveler.firstName,
        lastName: traveler.lastName,
      })),
      segments: input.segments.map((segment) => ({
        origin: segment.departureIata,
        destination: segment.arrivalIata,
        departureAt: segment.departureLocal,
        arrivalAt: segment.arrivalLocal,
        carrierCode: segment.carrierCode,
        flightNumber: segment.flightNumber,
      })),
    },
    update: { contactNotice: false, contactsChanged: input.contactsChanged },
  };
}

/**
 * The variables of the notice to the previous contact address: the booking reference, and every other booking variable
 * empty (see the file header).
 */
export function contactNoticeData(reference: string): Record<string, unknown> {
  return {
    booking: {
      reference,
      recordLocator: "",
      url: "",
      total: { amount: "", currency: "" },
      contact: { firstName: "", lastName: "" },
      travellers: [],
      segments: [],
    },
    update: { contactNotice: true, contactsChanged: true },
  };
}

/** The booking page of a booking on its storefront host (OADR-0015 point 5). */
export function bookingPageUrl(tenantKey: string, baseDomain: string, bookingId: string): string {
  return `${storefrontUrl(tenantKey, baseDomain)}/booking.html?id=${bookingId}`;
}

/** Queues the `booking.updated` e-mails of a change (see the file header). Both callers are in the API. */
@Injectable()
export class BookingUpdatedEmails {
  private readonly baseDomain: string;

  constructor(
    private readonly outbox: OutboxService,
    private readonly bookings: BookingsRepository,
    config: ConfigService<SharedConfig, true>,
    @InjectPinoLogger(BookingUpdatedEmails.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** Queues, in `trx`, the full e-mail and, when the contact e-mail moved, the notice (see the file header). */
  async send(trx: TenantTransaction, input: BookingUpdatedInput): Promise<BookingUpdatedResult> {
    const settings = await this.bookings.settings(trx);
    const localeOf = (language: string | null): string =>
      language !== null && LOCALE.test(language) ? language : (settings?.defaultLocale ?? "en");
    const key = `${input.dedupePrefix}:${input.booking.id}:v${input.version}`;
    const updated = await this.enqueue(trx, input, {
      to: input.contact.email,
      locale: localeOf(input.contact.language),
      dedupeKey: `${key}:new`,
      data: bookingUpdatedData({
        ...input,
        bookingUrl: bookingPageUrl(input.tenantKey, this.baseDomain, input.booking.id),
      }),
    });
    const previous = input.previousEmail;
    const moved = previous !== null && previous.toLowerCase() !== input.contact.email.toLowerCase();
    const notice = moved
      ? await this.enqueue(trx, input, {
          to: previous,
          locale: localeOf(input.previousLanguage),
          dedupeKey: `${key}:old`,
          data: contactNoticeData(input.booking.reference),
        })
      : false;
    return { updated, notice };
  }

  /** One e-mail; `false` when it was queued before (its dedupe key) or the outbox refused it (logged). */
  private async enqueue(
    trx: TenantTransaction,
    input: BookingUpdatedInput,
    email: {
      readonly to: string;
      readonly locale: string;
      readonly dedupeKey: string;
      readonly data: Record<string, unknown>;
    },
  ): Promise<boolean> {
    try {
      const result = await this.outbox.enqueue(trx, {
        templateKey: BOOKING_UPDATED_TEMPLATE,
        to: email.to,
        locale: email.locale,
        customerId: input.booking.customerId,
        bookingId: input.booking.id,
        dedupeKey: email.dedupeKey,
        data: email.data,
      });
      return result.queued;
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error(
        { bookingId: input.booking.id, template: BOOKING_UPDATED_TEMPLATE, err: error },
        "bookings.update_email_invalid",
      );
      return false;
    }
  }
}
