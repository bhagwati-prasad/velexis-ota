import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getBookingTokenCookie, serializePage } from "@velexis/ota-sdk/next";
import { isVelexisError, type Booking } from "@velexis/ota-sdk";
import { currentCustomer, customerClient, getStorefront, velexisConfig } from "@/lib/velexis";
import { formatInstant, formatLocalDateTime, formatMoney } from "@/lib/format";
import { BookingContactsForm } from "./contacts-form";
import { CancelPanel } from "./cancel-panel";
import { TicketingStatus } from "./ticketing-status";

/**
 * Booking detail for a customer (session cookie) or a guest (booking-token cookie set by checkout / lookup):
 * itinerary, travellers, tickets, payments, documents, timeline, contact update and cancellation with refund preview.
 */
export default async function BookingPage({ params, searchParams }: { params: Promise<{ bookingId: string }>; searchParams: Promise<{ new?: string; pending?: string; refresh?: string }> }) {
  const [{ bookingId }, sp] = await Promise.all([params, searchParams]);
  const [session, guestToken, sf] = await Promise.all([currentCustomer(), getBookingTokenCookie(bookingId, { config: velexisConfig }), getStorefront()]);
  if (!session && !guestToken) redirect(`/bookings/lookup?bookingId=${encodeURIComponent(bookingId)}`);

  const vx = await customerClient({ bookingId });
  let booking: Booking;
  try {
    // `refresh` synchronises with Amadeus (throttled server-side); fall back to stored data if the supplier is slow.
    booking = await vx.bookings.get({ bookingId, refresh: sp.refresh === "1" }).catch((e: unknown) => {
      if (sp.refresh === "1" && isVelexisError(e) && e.code.startsWith("SUPPLIER_")) return vx.bookings.get({ bookingId });
      throw e;
    });
  } catch (e) {
    if (isVelexisError(e, "NOT_FOUND")) notFound();
    if (isVelexisError(e, "UNAUTHENTICATED")) redirect(`/bookings/lookup?bookingId=${encodeURIComponent(bookingId)}`);
    throw e;
  }

  const [documents, events] = await Promise.all([
    booking.allowedActions.canDownloadDocuments ? vx.bookings.listDocuments({ bookingId, limit: 20 }).then(serializePage) : null,
    vx.bookings.listEvents({ bookingId, limit: 10 }).then(serializePage),
  ]);
  const locale = sf.defaultLocale;
  const ticketingOpen = booking.ticketing.status === "pending" || booking.ticketing.status === "in_progress" || booking.status === "pending";

  return (
    <section className="booking">
      {sp.new && <div className="notice">Thank you! Your booking {booking.reference} is confirmed. A confirmation e-mail is on its way.</div>}
      {sp.pending && <div className="notice">We are confirming your booking with the airline. This page updates automatically — please do not book again.</div>}
      <h1>
        Booking {booking.reference} <span className={`status status-${booking.status}`}>{booking.status.replace("_", " ")}</span>
      </h1>
      <p className="muted">
        {booking.recordLocators.map((r) => `${r.originSystemCode} ${r.reference}`).join(" · ")} · booked {formatInstant(booking.createdAt, locale)} · last synced{" "}
        {formatInstant(booking.lastSyncedAt, locale)} {booking.allowedActions.canRefresh && <Link href={`/bookings/${bookingId}?refresh=1`}>Refresh</Link>}
      </p>

      {ticketingOpen && <TicketingStatus bookingId={booking.id} />}

      <h2>Itinerary</h2>
      {booking.itineraries.map((it) => (
        <div key={it.index}>
          <h3>
            {it.originCode} → {it.destinationCode} · {formatLocalDateTime(it.departureAt, locale)}
          </h3>
          <ul>
            {it.segments.map((s) => (
              <li key={s.id}>
                {s.carrierName ?? s.carrierCode} {s.flightNumber} · {formatLocalDateTime(s.departure.at, locale)} {s.departure.iataCode} →{" "}
                {formatLocalDateTime(s.arrival.at, locale)} {s.arrival.iataCode} · {s.cabin} {s.brandedFareLabel ?? ""} · {s.status}
                {s.scheduleChanged && <span className="tag">schedule changed</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <h2>Travellers</h2>
      <ul>
        {booking.travelers.map((t) => (
          <li key={t.id}>
            {t.name?.firstName} {t.name?.lastName} ({t.travelerType.toLowerCase()}) {t.ticketNumbers?.length ? `· e-ticket ${t.ticketNumbers.join(", ")}` : ""}
          </li>
        ))}
      </ul>
      {booking.ancillaries.length > 0 && (
        <>
          <h2>Extras</h2>
          <ul>
            {booking.ancillaries.map((a) => (
              <li key={a.id}>
                {a.label} {a.seatNumber && `· seat ${a.seatNumber}`} · {formatMoney(a.price, locale)} · {a.status}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Payment</h2>
      <p>
        Total {formatMoney(booking.totals.total, locale)} · paid {formatMoney(booking.totals.paid, locale)}
        {Number(booking.totals.refunded.amount) > 0 && <> · refunded {formatMoney(booking.totals.refunded, locale)}</>}
      </p>

      {documents && documents.data.length > 0 && (
        <>
          <h2>Documents</h2>
          <ul>
            {documents.data.map((d) => (
              <li key={d.id}>
                {d.status === "ready" ? <a href={`/bookings/${bookingId}/documents/${d.id}`}>{d.fileName}</a> : `${d.fileName} (${d.status})`}{" "}
                <span className="muted">{d.kind.replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {booking.allowedActions.canModifyContacts && <BookingContactsForm booking={booking} />}

      {booking.cancellation ? (
        <div className="notice">
          Cancelled {formatInstant(booking.cancellation.cancelledAt, locale)} · refund {booking.cancellation.refundStatus.replace(/_/g, " ")}
          {booking.cancellation.refund && ` · ${formatMoney(booking.cancellation.refund.amount, locale)}`}
        </div>
      ) : booking.allowedActions.canCancel ? (
        <CancelPanel bookingId={booking.id} version={booking.version} />
      ) : (
        booking.allowedActions.reasons.canCancel && <p className="muted">Online cancellation is not available ({booking.allowedActions.reasons.canCancel.replace(/_/g, " ")}).</p>
      )}

      <h2>History</h2>
      <ol className="timeline">
        {events.data.map((e) => (
          <li key={e.id}>
            {formatInstant(e.createdAt, locale)} — {e.summary}
          </li>
        ))}
      </ol>
      <p className="muted">Need help? {sf.support.email}</p>
    </section>
  );
}
