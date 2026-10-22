// The itinerary PDF and what both booking documents share (OBE-053; OADR-0013 items 6 and 7, ADR-0017,
// ota/docs/flows/ticketing-and-documents.md §3 step 7). e-ticket-receipt.renderer.ts builds the receipts on the blocks
// of this file.
//
// A renderer is a pure function of `DocumentData`, the booking as documents.repository.ts reads it: the booking, its
// travellers, segments and tickets, the OTA's brand from `storefront_settings`, the square logo's bytes (read from
// storage by the processor, never fetched) and the airport and airline names of `reference`. Nothing else goes in, so
// the same data always gives the same bytes (`renderPdf`: the fonts of ../fonts, compression on, and the PDF's
// creation date taken from the data, never from the clock), and the SHA-256 of the file is stable for a booking
// version (OADR-0013 item 7).
//
// What a document shows is what the customer may see (customer scope): selling amounts only (the booking's total, never
// a net price, markup, fare from the ticket or an office), and a traveller's identity document as its type and the
// masked number `•••••<last 4>` of `booking_travelers.document_last4`, the form `TravelerDocument.numberMasked` has. The
// full number never reaches a renderer: the repository does not read `documents_ciphertext`.
//
// Texts are English (the documents' locale is `en`) and dates are formatted here from the local date-times Amadeus
// gives, or from instants converted to the OTA's time zone in SQL, never with the runtime's locale data, so a Node or
// ICU update cannot change a document's bytes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PdfPrinter from "pdfmake";
import type { Content, ContextPageSize, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { MASK } from "../../checkout/traveler-documents";

// ---- The data -------------------------------------------------------------------------------------------------------

/** The OTA as its documents show it (`storefront_settings`). */
export interface DocumentBrand {
  readonly name: string;
  readonly legalName: string | null;
  readonly supportEmail: string | null;
  readonly supportPhone: string | null;
  /** `#RRGGBB`, or `null` for the default colour. */
  readonly primaryColor: string | null;
}

/** The square logo (`storefront_settings.logo_square_asset_id`), PNG or JPEG: the formats a PDF embeds. */
export interface DocumentLogo {
  readonly contentType: "image/png" | "image/jpeg";
  readonly bytes: Buffer;
}

/** The `bookings` row as the documents show it. */
export interface DocumentBooking {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  /** The airline booking reference (Amadeus record locator). */
  readonly recordLocator: string | null;
  /** When the booking was made: the instant (the PDF's creation date) and its local time in the OTA's zone. */
  readonly createdAt: Date;
  /** `YYYY-MM-DDTHH:MM:SS` in the OTA's time zone. */
  readonly bookedLocal: string;
  /** `YYYY-MM-DDTHH:MM:SS` in the OTA's time zone; `null` unless cancelled. */
  readonly cancelledLocal: string | null;
  readonly currency: string;
  /** A decimal string (`numeric::text`). */
  readonly totalAmount: string;
  readonly validatingCarrier: string | null;
}

/** A `booking_travelers` row without its sealed documents. */
export interface DocumentTraveler {
  readonly id: string;
  readonly amadeusTravelerId: string;
  readonly travelerType: string;
  readonly firstName: string;
  readonly middleName: string | null;
  readonly lastName: string;
  /** The main document's type (`PASSPORT`, `IDENTITY_CARD`, …) and the last 4 characters of its number. */
  readonly documentType: string | null;
  readonly documentLast4: string | null;
}

/** A `booking_segments` row; local times as `YYYY-MM-DDTHH:MM:SS`. */
export interface DocumentSegment {
  readonly amadeusFlightOfferId: string;
  readonly amadeusSegmentId: string;
  readonly itineraryIndex: number;
  readonly segmentIndex: number;
  readonly carrierCode: string;
  readonly flightNumber: string;
  readonly operatingCarrierCode: string | null;
  readonly departureIata: string;
  readonly departureTerminal: string | null;
  readonly departureLocal: string;
  readonly arrivalIata: string;
  readonly arrivalTerminal: string | null;
  readonly arrivalLocal: string;
  readonly durationMinutes: number | null;
  readonly cabin: string | null;
  readonly bookingClass: string | null;
  readonly includedCheckedBags: unknown;
  readonly status: string;
}

/** A `booking_tickets` row. */
export interface DocumentTicket {
  readonly id: string;
  /** `booking_travelers.id`, when known. */
  readonly travelerId: string | null;
  readonly amadeusTravelerId: string | null;
  readonly documentType: string;
  /** The ticket number (`000-0000000001`): a receipt shows it in full, it is not an identity document. */
  readonly documentNumber: string;
  readonly status: string;
  /** The Amadeus segment ids the ticket covers (empty: all of them). */
  readonly segmentIds: readonly string[];
  /** The issue instant, and its local date-time in the OTA's zone. */
  readonly issuedAt: Date | null;
  readonly issuedLocal: string | null;
  readonly validatingCarrier: string | null;
}

/** Everything a booking document is rendered from (documents.repository.ts). */
export interface DocumentData {
  readonly brand: DocumentBrand;
  readonly logo: DocumentLogo | null;
  readonly booking: DocumentBooking;
  readonly travelers: readonly DocumentTraveler[];
  /** In itinerary order. */
  readonly segments: readonly DocumentSegment[];
  readonly tickets: readonly DocumentTicket[];
  /** Airport names by IATA code (`reference.airports`, with the city), as far as known. */
  readonly airports: ReadonlyMap<string, string>;
  /** Airline names by IATA code (`reference.airlines`), as far as known. */
  readonly airlines: ReadonlyMap<string, string>;
}

/** The language of every document in the MVP (`booking_documents.locale`). */
export const DOCUMENT_LOCALE = "en";

/** The media type of the documents (`booking_documents.content_type`). */
export const PDF_CONTENT_TYPE = "application/pdf";

// ---- Fonts and printing ---------------------------------------------------------------------------------------------

/** The fonts bundled in the repository (../fonts/README.md); the build copies them next to the compiled code. */
export const FONT_DIR = join(__dirname, "..", "fonts");

/** The font files of the documents: Roboto, regular and medium (the bold); no italics are used. */
export const FONT_FILES = Object.freeze({ normal: "Roboto-Regular.ttf", bold: "Roboto-Medium.ttf" });

/** The family name the definitions use. */
const FONT_FAMILY = "Roboto";

let printer: PdfPrinter | undefined;

/** The printer with the bundled fonts, read once, on the first render (the worker starts without reading them). */
function pdfPrinter(): PdfPrinter {
  if (printer === undefined) {
    const normal = readFileSync(join(FONT_DIR, FONT_FILES.normal));
    const bold = readFileSync(join(FONT_DIR, FONT_FILES.bold));
    printer = new PdfPrinter({ [FONT_FAMILY]: { normal, bold, italics: normal, bolditalics: bold } });
  }
  return printer;
}

/** A failure of pdfmake (which throws strings too) as an Error that names no data. */
export class PdfRenderError extends Error {
  override readonly name = "PdfRenderError";
}

/**
 * The PDF of `definition` (compressed unless the definition says otherwise). pdfmake lays the document out
 * synchronously and pdfkit streams the bytes; the creation date and the producer come from the definition, so equal
 * definitions give equal bytes.
 */
export function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  return new Promise<Buffer>((resolveBytes, rejectBytes) => {
    let document: PDFKit.PDFDocument;
    try {
      document = pdfPrinter().createPdfKitDocument(definition);
    } catch (error) {
      rejectBytes(
        new PdfRenderError("pdfmake could not lay out the document", {
          cause: error instanceof Error ? error : undefined,
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolveBytes(Buffer.concat(chunks)));
    document.on("error", (error: Error) =>
      rejectBytes(new PdfRenderError("pdfkit could not write the document", { cause: error })),
    );
    document.end();
  });
}

// ---- Formatting -------------------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;

/** `Fri 20 Nov 2026` of a local date or date-time (`YYYY-MM-DD…`); the text itself when it is not one. */
export function formatDate(local: string): string {
  const match = LOCAL.exec(local);
  if (match === null) {
    return local;
  }
  const [, year = "", month = "", day = ""] = match;
  const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
  return `${WEEKDAYS[weekday] ?? ""} ${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** `08:15` of a local date-time; `""` without a time. */
export function formatTime(local: string): string {
  const match = LOCAL.exec(local);
  return match?.[4] === undefined ? "" : `${match[4]}:${match[5] ?? "00"}`;
}

/** `EUR 1,234.50` of a decimal string, never through a JavaScript number. */
export function formatMoney(amount: string, currency: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (match === null) {
    return `${currency} ${amount}`;
  }
  const [, sign = "", whole = "", fraction] = match;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${sign}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** `ECONOMY` → `Economy`, `PREMIUM_ECONOMY` → `Premium economy`. */
export function humanize(code: string): string {
  const words = code.toLowerCase().replace(/_/g, " ").trim();
  return words === "" ? code : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

const TRAVELER_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ADULT: "Adult",
  CHILD: "Child",
  HELD_INFANT: "Infant (on lap)",
  SEATED_INFANT: "Infant (own seat)",
  SENIOR: "Senior",
  YOUNG: "Young adult",
  STUDENT: "Student",
});

/** A traveller type as the documents name it. */
export function travelerTypeLabel(type: string): string {
  return TRAVELER_TYPES[type] ?? humanize(type);
}

/** `SAMPLE / TESTA MARIA`: the airline's order of a traveller's names. */
export function travelerName(
  traveler: Pick<DocumentTraveler, "firstName" | "middleName" | "lastName">,
): string {
  const given = [traveler.firstName, traveler.middleName ?? ""]
    .filter((part) => part.trim() !== "")
    .join(" ");
  return given === "" ? traveler.lastName : `${traveler.lastName} / ${given}`;
}

/**
 * The traveller's identity document as a document may show it: its type and the masked number `•••••<last 4>`
 * (`TravelerDocument.numberMasked`); `—` without one. The full number is never part of `DocumentData`.
 */
export function maskedDocument(traveler: Pick<DocumentTraveler, "documentType" | "documentLast4">): string {
  if (traveler.documentType === null && traveler.documentLast4 === null) {
    return "—";
  }
  const masked = `${MASK}${traveler.documentLast4 ?? ""}`;
  return traveler.documentType === null ? masked : `${humanize(traveler.documentType)} ${masked}`;
}

/** `Madrid (MAD)` when the airport is known, else the code. */
export function airportLabel(data: Pick<DocumentData, "airports">, code: string): string {
  const name = data.airports.get(code);
  return name === undefined ? code : `${name} (${code})`;
}

/** `Iberia (IB)` when the airline is known, else the code. */
export function airlineLabel(data: Pick<DocumentData, "airlines">, code: string): string {
  const name = data.airlines.get(code);
  return name === undefined ? code : `${name} (${code})`;
}

/** The checked bags included in a fare (`{quantity}` or `{weight, weightUnit}`), or `—`. */
export function bagsLabel(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "—";
  }
  const { quantity, weight, weightUnit } = value as Record<string, unknown>;
  if (typeof quantity === "number" && Number.isSafeInteger(quantity)) {
    return quantity === 0 ? "No checked bag" : `${quantity} checked bag${quantity === 1 ? "" : "s"}`;
  }
  if (typeof weight === "number" && Number.isFinite(weight)) {
    return `${weight} ${typeof weightUnit === "string" ? weightUnit : "KG"}`;
  }
  return "—";
}

const BOOKING_STATUSES: Readonly<Record<string, string>> = Object.freeze({
  pending: "Pending",
  confirmed: "Confirmed",
  ticketed: "Ticketed",
  partially_ticketed: "Partially ticketed",
  cancelled: "Cancelled",
  failed: "Not confirmed",
});

/** The booking status as a traveller reads it. */
export function bookingStatusLabel(status: string): string {
  return BOOKING_STATUSES[status] ?? humanize(status);
}

/** A file name of `[A-Za-z0-9._-]` only. */
function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "");
}

// ---- Shared blocks ----------------------------------------------------------------------------------------------------

/** The colours of the documents: the OTA's primary colour for headings, else a dark blue. */
const DEFAULT_ACCENT = "#1F3A5F";
const MUTED = "#5F6B7A";
const RULE = "#C9D1DB";

/** The OTA's colour when it is `#RRGGBB`. */
export function accentOf(brand: DocumentBrand): string {
  return brand.primaryColor !== null && /^#[0-9A-Fa-f]{6}$/.test(brand.primaryColor)
    ? brand.primaryColor.toUpperCase()
    : DEFAULT_ACCENT;
}

/** The images dictionary of a definition: the logo as a data URL under `logo` (pdfmake reads nothing else). */
export function imagesOf(data: Pick<DocumentData, "logo">): Record<string, string> {
  return data.logo === null
    ? {}
    : { logo: `data:${data.logo.contentType};base64,${data.logo.bytes.toString("base64")}` };
}

/** The header block: logo, brand and contact on the left, the document's title and reference on the right. */
export function headerBlock(data: DocumentData, title: string, subtitle: string): Content {
  const contact = [data.brand.supportEmail, data.brand.supportPhone].filter(
    (value): value is string => value !== null && value.trim() !== "",
  );
  const brand: Content = {
    stack: [
      { text: data.brand.name, style: "brand" },
      ...(contact.length === 0 ? [] : [{ text: contact.join("  ·  "), style: "muted" }]),
    ],
    margin: [data.logo === null ? 0 : 8, 4, 0, 0],
  };
  return {
    columns: [
      ...(data.logo === null ? [] : [{ image: "logo", fit: [48, 48] as [number, number], width: 48 }]),
      { ...brand, width: "*" },
      {
        width: "auto",
        stack: [
          { text: title, style: "title", alignment: "right" },
          { text: subtitle, style: "muted", alignment: "right" },
        ],
      },
    ],
    columnGap: 0,
    margin: [0, 0, 0, 12],
  };
}

/** A section heading. */
export function sectionHeading(data: DocumentData, text: string): Content {
  return { text, style: "section", color: accentOf(data.brand), margin: [0, 14, 0, 6] };
}

/** Label/value pairs in two columns. */
export function factsBlock(pairs: ReadonlyArray<readonly [string, string]>): Content {
  const rows: TableCell[][] = [];
  for (let index = 0; index < pairs.length; index += 2) {
    const row: TableCell[] = [];
    for (const pair of [pairs[index], pairs[index + 1]]) {
      row.push(
        pair === undefined ? "" : { text: pair[0], style: "label" },
        pair === undefined ? "" : { text: pair[1], style: "value" },
      );
    }
    rows.push(row);
  }
  return {
    table: { widths: [110, "*", 110, "*"], body: rows },
    layout: "noBorders",
  };
}

/** A table with a header row and thin horizontal rules. */
export function dataTable(
  widths: Array<number | string>,
  header: readonly string[],
  body: TableCell[][],
): Content {
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths,
      body: [header.map((text) => ({ text, style: "tableHeader" })), ...body],
    },
    layout: {
      hLineWidth: (index: number) => (index === 0 ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => RULE,
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
  };
}

/** The flights table of `segments`, grouped by journey (`itinerary_index`). */
export function flightsBlock(data: DocumentData, segments: readonly DocumentSegment[]): Content[] {
  const journeys = new Map<string, DocumentSegment[]>();
  for (const segment of segments) {
    const key = `${segment.amadeusFlightOfferId}:${segment.itineraryIndex}`;
    journeys.set(key, [...(journeys.get(key) ?? []), segment]);
  }
  const blocks: Content[] = [];
  let number = 0;
  for (const journey of journeys.values()) {
    number += 1;
    const first = journey[0];
    const last = journey.at(-1);
    if (first === undefined || last === undefined) {
      continue;
    }
    blocks.push({
      text: `Journey ${number}: ${airportLabel(data, first.departureIata)} to ${airportLabel(data, last.arrivalIata)}`,
      style: "journey",
      margin: [0, number === 1 ? 0 : 8, 0, 4],
    });
    blocks.push(
      dataTable(
        [78, 96, "*", "*", 86],
        ["Date", "Flight", "Departure", "Arrival", "Cabin and bags"],
        journey.map((segment) => flightRow(data, segment)),
      ),
    );
  }
  return blocks;
}

/** One segment's row of the flights table. */
function flightRow(data: DocumentData, segment: DocumentSegment): TableCell[] {
  const operated =
    segment.operatingCarrierCode !== null && segment.operatingCarrierCode !== segment.carrierCode
      ? `Operated by ${airlineLabel(data, segment.operatingCarrierCode)}`
      : airlineLabel(data, segment.carrierCode);
  const terminal = (value: string | null) => (value === null || value === "" ? "" : `, terminal ${value}`);
  const cabin = [
    segment.cabin === null ? null : humanize(segment.cabin),
    segment.bookingClass === null ? null : `class ${segment.bookingClass}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const status = segment.status === "CONFIRMED" ? [] : [{ text: humanize(segment.status), style: "warning" }];
  return [
    { stack: [formatDate(segment.departureLocal), ...status] },
    {
      stack: [
        { text: `${segment.carrierCode} ${segment.flightNumber}`, bold: true },
        { text: operated, style: "small" },
      ],
    },
    {
      stack: [
        { text: formatTime(segment.departureLocal), bold: true },
        {
          text: `${airportLabel(data, segment.departureIata)}${terminal(segment.departureTerminal)}`,
          style: "small",
        },
      ],
    },
    {
      stack: [
        {
          text: `${formatTime(segment.arrivalLocal)}${
            segment.arrivalLocal.slice(0, 10) === segment.departureLocal.slice(0, 10)
              ? ""
              : ` (${formatDate(segment.arrivalLocal)})`
          }`,
          bold: true,
        },
        {
          text: `${airportLabel(data, segment.arrivalIata)}${terminal(segment.arrivalTerminal)}`,
          style: "small",
        },
      ],
    },
    {
      stack: [
        { text: cabin === "" ? "—" : cabin },
        { text: bagsLabel(segment.includedCheckedBags), style: "small" },
      ],
    },
  ];
}

/** The page footer: the brand, the booking reference and the page number. */
function footerOf(data: DocumentData, label: string) {
  return (currentPage: number, pageCount: number, _size: ContextPageSize): Content => ({
    columns: [
      { text: `${data.brand.name}  ·  ${label}  ·  Booking ${data.booking.reference}`, style: "footer" },
      { text: `Page ${currentPage} of ${pageCount}`, style: "footer", alignment: "right", width: "auto" },
    ],
    margin: [40, 16, 40, 0],
  });
}

/** The definition around `content`: A4, the fonts, the styles, the fixed metadata and the footer. */
export function documentDefinition(
  data: DocumentData,
  options: {
    readonly title: string;
    readonly footerLabel: string;
    readonly createdAt: Date;
    readonly content: Content[];
    readonly cancelled: boolean;
  },
): TDocumentDefinitions {
  const accent = accentOf(data.brand);
  return {
    pageSize: "A4",
    pageMargins: [40, 40, 40, 56],
    compress: true,
    info: {
      title: options.title,
      author: data.brand.name,
      subject: `Booking ${data.booking.reference}`,
      creator: "Velexis",
      producer: "Velexis",
      // Fixed by the data, so the bytes (and the SHA-256) do not depend on when the document is rendered.
      creationDate: options.createdAt,
    },
    images: imagesOf(data),
    content: options.content,
    footer: footerOf(data, options.footerLabel),
    ...(options.cancelled
      ? { watermark: { text: "CANCELLED", color: "#B42318", opacity: 0.12, bold: true, fontSize: 80 } }
      : {}),
    defaultStyle: { font: FONT_FAMILY, fontSize: 9, color: "#1D2733", lineHeight: 1.15 },
    styles: {
      brand: { fontSize: 14, bold: true, color: accent },
      title: { fontSize: 16, bold: true, color: accent },
      section: { fontSize: 11, bold: true },
      journey: { fontSize: 9.5, bold: true },
      label: { color: MUTED },
      value: { bold: true },
      muted: { color: MUTED },
      small: { fontSize: 8, color: MUTED },
      warning: { fontSize: 8, bold: true, color: "#B42318" },
      tableHeader: { fontSize: 8, bold: true, color: MUTED },
      notice: { fontSize: 8, color: MUTED },
      footer: { fontSize: 7.5, color: MUTED },
      banner: { fontSize: 10, bold: true, color: "#B42318" },
    },
  };
}

// ---- The itinerary ----------------------------------------------------------------------------------------------------

/** The download name of a booking's itinerary (`VX7K2Q9M-itinerary.pdf`). */
export function itineraryFileName(booking: Pick<DocumentBooking, "reference">): string {
  return `${safeFileName(booking.reference)}-itinerary.pdf`;
}

/** The e-ticket numbers of a traveller, in issue order. */
function ticketsOf(data: DocumentData, traveler: DocumentTraveler): string {
  const numbers = data.tickets
    .filter(
      (ticket) =>
        ticket.documentType === "ETICKET" &&
        (ticket.travelerId === traveler.id || ticket.amadeusTravelerId === traveler.amadeusTravelerId),
    )
    .map((ticket) => ticket.documentNumber);
  return numbers.length === 0 ? "Not issued yet" : numbers.join(", ");
}

/**
 * The itinerary of a booking (OADR-0013 item 6): the booking's references and status, its travellers with their masked
 * documents and e-ticket numbers, its flights and its total; a cancelled booking's itinerary says so in a banner and a
 * watermark.
 */
export function itineraryDefinition(data: DocumentData): TDocumentDefinitions {
  const { booking } = data;
  const cancelled = booking.status === "cancelled";
  const issuer = (data.brand.legalName ?? data.brand.name).trim();
  const content: Content[] = [headerBlock(data, "Itinerary", `Booking ${booking.reference}`)];
  if (cancelled) {
    content.push({
      text:
        booking.cancelledLocal === null
          ? "This booking is cancelled. The flights below are no longer reserved."
          : `This booking was cancelled on ${formatDate(booking.cancelledLocal)}. The flights below are no longer reserved.`,
      style: "banner",
      margin: [0, 0, 0, 8],
    });
  }
  content.push(
    factsBlock([
      ["Booking reference", booking.reference],
      ["Airline reference (PNR)", booking.recordLocator ?? "—"],
      ["Booked on", formatDate(booking.bookedLocal)],
      ["Status", bookingStatusLabel(booking.status)],
    ]),
    sectionHeading(data, "Travellers"),
    dataTable(
      ["*", 80, 130, 110],
      ["Name", "Type", "Travel document", "E-ticket"],
      data.travelers.map((traveler) => [
        { text: travelerName(traveler), bold: true },
        travelerTypeLabel(traveler.travelerType),
        maskedDocument(traveler),
        ticketsOf(data, traveler),
      ]),
    ),
    sectionHeading(data, "Flights"),
    ...flightsBlock(data, data.segments),
    { text: "All times are local to the airport.", style: "notice", margin: [0, 4, 0, 0] },
    sectionHeading(data, "Price"),
    factsBlock([["Total price", formatMoney(booking.totalAmount, booking.currency)]]),
    {
      text: [
        `This itinerary is not an invoice: invoices are issued by ${issuer}${issuer.endsWith(".") ? "" : "."} `,
        "Check in with the airline and bring the travel document you booked with. ",
        data.brand.supportEmail === null
          ? ""
          : `Questions about this booking: ${data.brand.supportEmail}, booking ${booking.reference}.`,
      ],
      style: "notice",
      margin: [0, 16, 0, 0],
    },
  );
  return documentDefinition(data, {
    title: `Itinerary ${booking.reference}`,
    footerLabel: "Itinerary",
    createdAt: booking.createdAt,
    content,
    cancelled,
  });
}

/** The itinerary's PDF bytes. */
export function renderItinerary(data: DocumentData): Promise<Buffer> {
  return renderPdf(itineraryDefinition(data));
}
