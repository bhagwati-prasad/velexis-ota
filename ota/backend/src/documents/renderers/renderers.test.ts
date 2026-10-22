// The itinerary and e-ticket receipt renderers (OBE-053; OADR-0013 items 6 and 7): deterministic bytes for the same
// booking data, masked identity documents, the receipt's content, the cancelled itinerary, the logo, and the bundled
// fonts and their licence. The PDFs' text is read back with test/support/pdf-text.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync as zlibDeflate } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { pdfText } from "../../../test/support/pdf-text";
import { MASK } from "../../checkout/traveler-documents";
import { APP_DIR } from "../../config";
import {
  couponsOf,
  E_TICKET_TYPE,
  eTicketReceiptDefinition,
  eTicketReceiptFileName,
  ReceiptTicketError,
  renderETicketReceipt,
} from "./e-ticket-receipt.renderer";
import {
  bagsLabel,
  FONT_DIR,
  FONT_FILES,
  formatDate,
  formatMoney,
  formatTime,
  itineraryFileName,
  maskedDocument,
  renderItinerary,
  type DocumentData,
  type DocumentTicket,
} from "./itinerary.renderer";

/** Laying out the first PDF loads pdfmake, pdfkit and the fonts: about a second on a busy 4-CPU runner, once. */
const WARM_UP_TIMEOUT_MS = 20_000;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The full number of the traveller's passport: only its last 4 characters are part of the booking data. */
const PASSPORT_NUMBER = "XK7735612";

const TICKET: DocumentTicket = {
  id: "tkt_01JA4CG7Z4C7F0J3M6Q9U2X5A8",
  travelerId: "btr_01JA4CG7Z4C7F0J3M6Q9U2X5A1",
  amadeusTravelerId: "1",
  documentType: E_TICKET_TYPE,
  documentNumber: "075-2412345678",
  status: "ISSUED",
  segmentIds: ["1"],
  issuedAt: new Date("2026-10-10T09:21:03Z"),
  issuedLocal: "2026-10-10T11:21:03",
  validatingCarrier: "IB",
};

/** A ticketed round trip of one adult, as documents.repository.ts reads it. */
function bookingData(overrides: Partial<DocumentData> = {}): DocumentData {
  return {
    brand: {
      name: "Alpha Travel",
      legalName: "Alpha Travel S.L.",
      supportEmail: "help@alpha-travel.example",
      supportPhone: "+34 910 000 000",
      primaryColor: "#0A7C66",
    },
    logo: null,
    booking: {
      id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
      reference: "VXK7M2Q9",
      status: "ticketed",
      recordLocator: "QW3RTY",
      createdAt: new Date("2026-10-10T09:20:58Z"),
      bookedLocal: "2026-10-10T11:20:58",
      cancelledLocal: null,
      currency: "EUR",
      totalAmount: "1234.50",
      validatingCarrier: "IB",
    },
    travelers: [
      {
        id: "btr_01JA4CG7Z4C7F0J3M6Q9U2X5A1",
        amadeusTravelerId: "1",
        travelerType: "ADULT",
        firstName: "TESTA",
        middleName: "MARIA",
        lastName: "SAMPLE",
        documentType: "PASSPORT",
        documentLast4: PASSPORT_NUMBER.slice(-4),
      },
    ],
    segments: [
      {
        amadeusFlightOfferId: "1",
        amadeusSegmentId: "1",
        itineraryIndex: 0,
        segmentIndex: 0,
        carrierCode: "IB",
        flightNumber: "3436",
        operatingCarrierCode: "IB",
        departureIata: "MAD",
        departureTerminal: "4",
        departureLocal: "2026-11-20T08:15:00",
        arrivalIata: "ORY",
        arrivalTerminal: "1",
        arrivalLocal: "2026-11-20T10:20:00",
        durationMinutes: 125,
        cabin: "ECONOMY",
        bookingClass: "Q",
        includedCheckedBags: { quantity: 1 },
        status: "CONFIRMED",
      },
      {
        amadeusFlightOfferId: "1",
        amadeusSegmentId: "2",
        itineraryIndex: 1,
        segmentIndex: 0,
        carrierCode: "IB",
        flightNumber: "3437",
        operatingCarrierCode: "VY",
        departureIata: "ORY",
        departureTerminal: null,
        departureLocal: "2026-11-27T21:40:00",
        arrivalIata: "MAD",
        arrivalTerminal: "4",
        arrivalLocal: "2026-11-28T00:05:00",
        durationMinutes: 145,
        cabin: "ECONOMY",
        bookingClass: "Q",
        includedCheckedBags: { weight: 23, weightUnit: "KG" },
        status: "CONFIRMED",
      },
    ],
    tickets: [TICKET],
    airports: new Map([
      ["MAD", "Madrid"],
      ["ORY", "Paris Orly"],
    ]),
    airlines: new Map([
      ["IB", "Iberia"],
      ["VY", "Vueling"],
    ]),
    ...overrides,
  };
}

/** A PNG of `size` × `size` pixels of one colour, built by hand (signature, IHDR, IDAT, IEND). */
function pngLogo(size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x3c)]);
  const pixels = zlibDeflate(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let itinerary: Buffer;
let itineraryText: string;
let receipt: Buffer;
let receiptText: string;

beforeAll(async () => {
  itinerary = await renderItinerary(bookingData());
  itineraryText = pdfText(itinerary);
  receipt = await renderETicketReceipt(bookingData(), TICKET.id);
  receiptText = pdfText(receipt);
}, WARM_UP_TIMEOUT_MS);

describe("rendering a booking version", () => {
  it("[OBE-053 AC1] gives the same bytes, and so the same SHA-256, for the same booking data", async () => {
    const again = await renderItinerary(bookingData());
    const receiptAgain = await renderETicketReceipt(bookingData(), TICKET.id);

    expect(itinerary.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(sha256(again)).toBe(sha256(itinerary));
    expect(sha256(receiptAgain)).toBe(sha256(receipt));
    expect(sha256(receipt)).not.toBe(sha256(itinerary));
  });

  it("[OBE-053 AC1] gives other bytes when the booking changed", async () => {
    const base = bookingData();
    const cancelled = await renderItinerary(
      bookingData({
        booking: { ...base.booking, status: "cancelled", cancelledLocal: "2026-10-21T16:05:00" },
      }),
    );

    expect(sha256(cancelled)).not.toBe(sha256(itinerary));
  });
});

describe("a traveller's identity document", () => {
  it("[OBE-053 AC3] appears only masked, as the type and •••••<last 4>, never in full", () => {
    const texts = [itineraryText, receiptText];

    for (const text of texts) {
      expect(text).toContain(`Passport ${MASK}${PASSPORT_NUMBER.slice(-4)}`);
      expect(text).not.toContain(PASSPORT_NUMBER);
      // Every occurrence of the last 4 characters is the masked form's.
      const last4 = PASSPORT_NUMBER.slice(-4);
      const occurrences = [...text.matchAll(new RegExp(last4, "g"))].map((match) => match.index);
      expect(occurrences.length).toBeGreaterThan(0);
      for (const index of occurrences) {
        expect(text.slice(index - MASK.length, index)).toBe(MASK);
      }
    }
    expect(maskedDocument({ documentType: "IDENTITY_CARD", documentLast4: "0042" })).toBe(
      `Identity card ${MASK}0042`,
    );
    expect(maskedDocument({ documentType: null, documentLast4: null })).toBe("—");
  });
});

describe("the itinerary", () => {
  it("shows the references, travellers with their e-tickets, flights by journey and the selling total", () => {
    for (const expected of [
      "Itinerary",
      "Alpha Travel",
      "help@alpha-travel.example",
      "VXK7M2Q9",
      "QW3RTY",
      "Sat 10 Oct 2026",
      "Ticketed",
      "SAMPLE / TESTA MARIA",
      "Adult",
      "075-2412345678",
      "Journey 1: Madrid (MAD) to Paris Orly (ORY)",
      "Journey 2: Paris Orly (ORY) to Madrid (MAD)",
      "IB 3436",
      "Fri 20 Nov 2026",
      "08:15",
      "Madrid (MAD), terminal 4",
      "00:05 (Sat 28 Nov 2026)",
      "Operated by Vueling (VY)",
      "Economy, class Q",
      "1 checked bag",
      "23 KG",
      "EUR 1,234.50",
      "invoices are issued by Alpha Travel S.L.",
      "Page 1 of 1",
    ]) {
      expect(itineraryText, expected).toContain(expected);
    }
    expect(itineraryText).not.toContain("CANCELLED");
    expect(itineraryFileName(bookingData().booking)).toBe("VXK7M2Q9-itinerary.pdf");
  });

  it("of a cancelled booking says so in a banner and a watermark", async () => {
    const base = bookingData();
    const text = pdfText(
      await renderItinerary(
        bookingData({
          booking: { ...base.booking, status: "cancelled", cancelledLocal: "2026-10-21T16:05:00" },
        }),
      ),
    );

    expect(text).toContain("This booking was cancelled on Wed 21 Oct 2026");
    expect(text).toContain("CANCELLED");
    expect(text).toContain("Cancelled");
  });

  it("lists a traveller without a ticket as not issued yet, and renders names outside the fonts without failing", async () => {
    const base = bookingData();
    const text = pdfText(
      await renderItinerary(
        bookingData({
          booking: { ...base.booking, status: "confirmed" },
          tickets: [],
          travelers: base.travelers.map((traveler) => ({ ...traveler, lastName: "SAMPLE 山田" })),
        }),
      ),
    );

    expect(text).toContain("Not issued yet");
    expect(text).toContain("Confirmed");
    expect(text).toContain("SAMPLE");
  });
});

describe("the e-ticket receipt", () => {
  it("shows the ticket in full, the passenger, the references and only the coupons of the ticket, without a fare", () => {
    for (const expected of [
      "E-ticket receipt",
      "Ticket 075-2412345678",
      "Issued",
      "Sat 10 Oct 2026",
      "Iberia (IB)",
      "VXK7M2Q9",
      "QW3RTY",
      "SAMPLE / TESTA MARIA",
      "IB 3436",
    ]) {
      expect(receiptText, expected).toContain(expected);
    }
    // Segment 2 is on no coupon of this ticket; no amount is shown (the ticket's fare is a net amount).
    expect(receiptText).not.toContain("IB 3437");
    expect(receiptText).not.toContain("EUR");
    expect(eTicketReceiptFileName(bookingData().booking, TICKET)).toBe("VXK7M2Q9-eticket-0752412345678.pdf");
  });

  it("covers every segment when the ticket names none it knows, and refuses a ticket that is not an e-ticket", () => {
    const data = bookingData();

    expect(couponsOf(data, { ...TICKET, segmentIds: [] })).toHaveLength(2);
    expect(couponsOf(data, { ...TICKET, segmentIds: ["9"] })).toHaveLength(2);
    expect(() => eTicketReceiptDefinition(data, "tkt_unknown")).toThrow(ReceiptTicketError);
    expect(() =>
      eTicketReceiptDefinition(bookingData({ tickets: [{ ...TICKET, documentType: "EMD" }] }), TICKET.id),
    ).toThrow(ReceiptTicketError);
  });
});

describe("the logo", () => {
  it("is embedded as an image when the OTA has a square PNG or JPEG logo, and the document renders without one", async () => {
    const withLogo = await renderItinerary(
      bookingData({ logo: { contentType: "image/png", bytes: pngLogo(4) } }),
    );

    expect(withLogo.toString("latin1")).toMatch(/\/Subtype \/Image/);
    expect(itinerary.toString("latin1")).not.toMatch(/\/Subtype \/Image/);
    expect(pdfText(withLogo)).toContain("Alpha Travel");
  });
});

describe("formatting", () => {
  it("formats local dates, times, money and bags without the runtime's locale data", () => {
    expect(formatDate("2026-02-28T23:59:00")).toBe("Sat 28 Feb 2026");
    expect(formatDate("2028-02-29")).toBe("Tue 29 Feb 2028");
    expect(formatTime("2026-02-28T07:05:00")).toBe("07:05");
    expect(formatTime("2026-02-28")).toBe("");
    expect(formatMoney("1234567.89", "EUR")).toBe("EUR 1,234,567.89");
    expect(formatMoney("115", "USD")).toBe("USD 115");
    expect(formatMoney("0.50", "GBP")).toBe("GBP 0.50");
    expect(bagsLabel({ quantity: 2 })).toBe("2 checked bags");
    expect(bagsLabel({ quantity: 0 })).toBe("No checked bag");
    expect(bagsLabel(null)).toBe("—");
  });
});

describe("the bundled fonts", () => {
  it("are the files and checksums of fonts/README.md, with their licence, and the build copies them to dist", () => {
    const readme = readFileSync(join(FONT_DIR, "README.md"), "utf8");
    for (const file of [FONT_FILES.normal, FONT_FILES.bold, "OFL.txt"]) {
      const checksum = sha256(readFileSync(join(FONT_DIR, file)));
      expect(readme, file).toContain(`| \`${file}\` |`);
      expect(readme, file).toContain(`\`${checksum}\``);
    }
    expect(readFileSync(join(FONT_DIR, "OFL.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(FONT_DIR).toBe(join(APP_DIR, "src", "documents", "fonts"));
    const manifest = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["build"]).toContain(
      "require('node:fs').cpSync('src/documents/fonts', 'dist/documents/fonts', { recursive: true })",
    );
  });
});
