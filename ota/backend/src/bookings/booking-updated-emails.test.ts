// The `booking.updated` e-mails of a change (FIX-W28-NOTIFY; OADR-0013 item 4 as revised on 2026-10-23), over a fake
// outbox: the full e-mail to the contact e-mail after the change and, when the address moved, the notice to the
// previous one, which carries the booking reference and nothing else of the booking. The variables are checked against
// the key's allow-list as the outbox checks them; the rendering is in notifications/templates/templates.test.ts, the
// sending (attachments, Mailpit) in test/integration/notifications/booking-emails.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidNotificationError,
  type EnqueueNotificationInput,
  type OutboxService,
} from "../notifications/outbox.service";
import { checkTemplateData } from "../notifications/renderer";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import {
  BOOKING_UPDATED_TEMPLATE,
  BookingUpdatedEmails,
  contactNoticeData,
  type BookingUpdatedInput,
} from "./booking-updated-emails";
import type { BookingsRepository } from "./bookings.repository";

const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";

const INPUT: BookingUpdatedInput = {
  tenantKey: "alpha",
  booking: {
    id: BOOKING_ID,
    reference: "VXK7M2Q9",
    recordLocator: "ABC123",
    totalAmount: "110.47",
    currency: "EUR",
    customerId: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1C",
  },
  travelers: [{ firstName: "TESTA", lastName: "SAMPLE" }],
  segments: [
    {
      departureIata: "MAD",
      arrivalIata: "ORY",
      departureLocal: "2027-03-01T10:00:00",
      arrivalLocal: "2027-03-01T12:05:00",
      carrierCode: "IB",
      flightNumber: "3436",
    },
  ],
  contact: { email: "new@example.com", firstName: "TESTB", lastName: "SAMPLE", language: "sv" },
  previousEmail: "old@example.com",
  previousLanguage: "de",
  contactsChanged: true,
  dedupePrefix: "booking.contacts_updated",
  version: 4,
};

function setup(options: { readonly refuse?: boolean; readonly queued?: boolean } = {}) {
  const queued: EnqueueNotificationInput[] = [];
  const outbox = {
    enqueue: vi.fn((_trx: unknown, input: EnqueueNotificationInput) => {
      if (options.refuse === true) {
        return Promise.reject(new InvalidNotificationError("E-mail booking.updated: refused"));
      }
      queued.push(input);
      return Promise.resolve({ notificationId: `ntf_${queued.length}`, queued: options.queued ?? true });
    }),
  };
  const logger = { error: vi.fn() };
  const emails = new BookingUpdatedEmails(
    outbox as unknown as OutboxService,
    { settings: () => Promise.resolve({ defaultLocale: "fr" }) } as unknown as BookingsRepository,
    { get: () => "ota.example.com" } as unknown as ConfigService<never, true>,
    logger as unknown as PinoLogger,
  );
  return { emails, queued, logger };
}

const TRX = {} as TenantTransaction;

describe("BookingUpdatedEmails.send", () => {
  it("[FIX-W28-NOTIFY AC1] e-mails booking.updated with the booking as it is now to the new contact address", async () => {
    const { emails, queued } = setup();

    const result = await emails.send(TRX, INPUT);

    expect(result).toEqual({ updated: true, notice: true });
    expect(queued[0]).toEqual({
      templateKey: BOOKING_UPDATED_TEMPLATE,
      to: "new@example.com",
      locale: "sv",
      customerId: INPUT.booking.customerId,
      bookingId: BOOKING_ID,
      dedupeKey: `booking.contacts_updated:${BOOKING_ID}:v4:new`,
      data: {
        booking: {
          reference: "VXK7M2Q9",
          recordLocator: "ABC123",
          url: `https://alpha.ota.example.com/booking.html?id=${BOOKING_ID}`,
          total: { amount: "110.47", currency: "EUR" },
          contact: { firstName: "TESTB", lastName: "SAMPLE" },
          travellers: [{ firstName: "TESTA", lastName: "SAMPLE" }],
          segments: [
            {
              origin: "MAD",
              destination: "ORY",
              departureAt: "2027-03-01T10:00:00",
              arrivalAt: "2027-03-01T12:05:00",
              carrierCode: "IB",
              flightNumber: "3436",
            },
          ],
        },
        update: { contactNotice: false, contactsChanged: true },
      },
    });
    // Exactly the key's caller variables, as the outbox checks them.
    expect(checkTemplateData(BOOKING_UPDATED_TEMPLATE, queued[0]?.data)).toEqual([]);
  });

  it("[FIX-W28-NOTIFY AC1] sends the previous address a notice with the booking reference only: no traveller, flight, amount, link or new address", async () => {
    const { emails, queued } = setup();

    await emails.send(TRX, INPUT);

    const notice = queued[1];
    // In the previous contact's language.
    expect(notice).toMatchObject({
      templateKey: BOOKING_UPDATED_TEMPLATE,
      to: "old@example.com",
      locale: "de",
      dedupeKey: `booking.contacts_updated:${BOOKING_ID}:v4:old`,
    });
    expect(notice?.data).toEqual(contactNoticeData("VXK7M2Q9"));
    expect(checkTemplateData(BOOKING_UPDATED_TEMPLATE, notice?.data)).toEqual([]);
    const text = JSON.stringify(notice?.data);
    for (const value of [
      "TESTA",
      "TESTB",
      "SAMPLE",
      "ABC123",
      "110.47",
      "MAD",
      "IB",
      "new@example.com",
      "http",
    ]) {
      expect([value, text.includes(value)]).toEqual([value, false]);
    }
  });

  it("[FIX-W28-NOTIFY AC1] sends no notice when the contact e-mail did not move (any case), and uses the default locale without a language", async () => {
    const { emails, queued } = setup();

    const result = await emails.send(TRX, {
      ...INPUT,
      contact: { ...INPUT.contact, email: "Old@Example.com", language: null },
      contactsChanged: false,
      dedupePrefix: "booking.patched",
    });

    expect(result).toEqual({ updated: true, notice: false });
    expect(queued.map((mail) => [mail.to, mail.locale, mail.dedupeKey])).toEqual([
      ["Old@Example.com", "fr", `booking.patched:${BOOKING_ID}:v4:new`],
    ]);
    expect(queued[0]?.data).toMatchObject({ update: { contactNotice: false, contactsChanged: false } });
    expect((await setup().emails.send(TRX, { ...INPUT, previousEmail: null })).notice).toBe(false);
  });

  it("logs and skips an e-mail the outbox refuses, and says when a repeated key queued nothing", async () => {
    const refused = setup({ refuse: true });
    const repeated = setup({ queued: false });

    expect(await refused.emails.send(TRX, INPUT)).toEqual({ updated: false, notice: false });
    expect(refused.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID, template: BOOKING_UPDATED_TEMPLATE }),
      "bookings.update_email_invalid",
    );
    expect(await repeated.emails.send(TRX, INPUT)).toEqual({ updated: false, notice: false });
  });
});
