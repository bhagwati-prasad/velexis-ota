// The e-ticket receipt PDF (OBE-053; OADR-0013 items 6 and 7, ota/docs/flows/ticketing-and-documents.md §3 step 7): one
// per e-ticket (`booking_tickets.document_type = ETICKET`), with the blocks and rules of itinerary.renderer.ts. A
// receipt shows the ticket number in full (that is what it is for), the passenger with the masked identity document,
// the booking's references and the flight coupons the ticket covers. It shows no fare: the ticket's fare is the
// airline's net amount, which customer scope never sees; the booking's selling total is on the itinerary.
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import {
  airlineLabel,
  dataTable,
  documentDefinition,
  factsBlock,
  flightsBlock,
  formatDate,
  headerBlock,
  humanize,
  maskedDocument,
  renderPdf,
  sectionHeading,
  travelerName,
  travelerTypeLabel,
  type DocumentData,
  type DocumentSegment,
  type DocumentTicket,
  type DocumentTraveler,
} from "./itinerary.renderer";

/** The ticket type a receipt is made for (EMD receipts are post-MVP, OADR-0013 item 6). */
export const E_TICKET_TYPE = "ETICKET";

/** The download name of a ticket's receipt (`VX7K2Q9M-eticket-0000000000001.pdf`, the digits of the number). */
export function eTicketReceiptFileName(
  booking: Pick<DocumentData["booking"], "reference">,
  ticket: Pick<DocumentTicket, "documentNumber">,
): string {
  const reference = booking.reference.replace(/[^A-Za-z0-9]/g, "");
  return `${reference}-eticket-${ticket.documentNumber.replace(/[^0-9A-Za-z]/g, "")}.pdf`;
}

/** The ticket's traveller, by row id or by Amadeus traveller id. */
function travelerOf(data: DocumentData, ticket: DocumentTicket): DocumentTraveler | undefined {
  return (
    data.travelers.find((traveler) => traveler.id === ticket.travelerId) ??
    data.travelers.find((traveler) => traveler.amadeusTravelerId === ticket.amadeusTravelerId)
  );
}

/** The segments the ticket covers: those of its segment ids, or every segment when it names none that is known. */
export function couponsOf(data: DocumentData, ticket: DocumentTicket): readonly DocumentSegment[] {
  const ids = new Set(ticket.segmentIds);
  const covered = data.segments.filter((segment) => ids.has(segment.amadeusSegmentId));
  return covered.length === 0 ? data.segments : covered;
}

/** Thrown for a receipt of a ticket the data does not hold, or one that is not an e-ticket. */
export class ReceiptTicketError extends Error {
  override readonly name = "ReceiptTicketError";
}

/** The receipt of the ticket `ticketId` of the booking (see the file header). */
export function eTicketReceiptDefinition(data: DocumentData, ticketId: string): TDocumentDefinitions {
  const ticket = data.tickets.find((candidate) => candidate.id === ticketId);
  if (ticket === undefined || ticket.documentType !== E_TICKET_TYPE) {
    throw new ReceiptTicketError("The booking has no such e-ticket");
  }
  const { booking } = data;
  const traveler = travelerOf(data, ticket);
  const carrier = ticket.validatingCarrier ?? booking.validatingCarrier;
  const cancelled = booking.status === "cancelled";
  const content: Content[] = [
    headerBlock(data, "E-ticket receipt", `Ticket ${ticket.documentNumber}`),
    factsBlock([
      ["Ticket number", ticket.documentNumber],
      ["Ticket status", humanize(ticket.status)],
      ["Issued on", ticket.issuedLocal === null ? "—" : formatDate(ticket.issuedLocal)],
      ["Issuing airline", carrier === null ? "—" : airlineLabel(data, carrier)],
      ["Booking reference", booking.reference],
      ["Airline reference (PNR)", booking.recordLocator ?? "—"],
    ]),
    sectionHeading(data, "Passenger"),
    dataTable(
      ["*", 100, 160],
      ["Name", "Type", "Travel document"],
      [
        traveler === undefined
          ? [{ text: "—" }, "—", "—"]
          : [
              { text: travelerName(traveler), bold: true },
              travelerTypeLabel(traveler.travelerType),
              maskedDocument(traveler),
            ],
      ],
    ),
    sectionHeading(data, "Flight coupons"),
    ...flightsBlock(data, couponsOf(data, ticket)),
    { text: "All times are local to the airport.", style: "notice", margin: [0, 4, 0, 0] },
    {
      text: [
        "This receipt confirms the electronic ticket above. Present it with the travel document you booked with when ",
        "the airline asks for it. Carriage is subject to the airline's conditions of carriage.",
        cancelled ? " The booking is cancelled: this ticket is no longer valid for travel." : "",
      ],
      style: "notice",
      margin: [0, 16, 0, 0],
    },
  ];
  return documentDefinition(data, {
    title: `E-ticket receipt ${ticket.documentNumber}`,
    footerLabel: `E-ticket ${ticket.documentNumber}`,
    createdAt: ticket.issuedAt ?? booking.createdAt,
    content,
    cancelled,
  });
}

/** The receipt's PDF bytes. */
export function renderETicketReceipt(data: DocumentData, ticketId: string): Promise<Buffer> {
  return renderPdf(eTicketReceiptDefinition(data, ticketId));
}
