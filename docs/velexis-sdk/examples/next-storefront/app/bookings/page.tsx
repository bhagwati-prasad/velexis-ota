import Link from "next/link";
import { listBookingTokenCookies } from "@velexis/ota-sdk/next";
import type { BookingListTimeframe } from "@velexis/ota-sdk";
import { currentCustomer, customerClient, getStorefront, velexisConfig } from "@/lib/velexis";
import { formatLocalDateTime, formatMoney } from "@/lib/format";

const TABS: { key: Exclude<BookingListTimeframe, "all">; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
  { key: "cancelled", label: "Cancelled" },
];

/** "My trips": tabs upcoming / past / cancelled with cursor pagination (customer session), or guest bookings on this device. */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; cursor?: string }> }) {
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "upcoming";
  const [session, sf] = await Promise.all([currentCustomer(), getStorefront()]);

  if (!session) {
    const guest = await listBookingTokenCookies({ config: velexisConfig });
    return (
      <section>
        <h1>My trips</h1>
        <p>
          <Link href="/account/sign-in?next=/bookings">Sign in</Link> to see all your trips, or <Link href="/bookings/lookup">find a booking</Link> with
          its reference and your last name.
        </p>
        {guest.length > 0 && (
          <>
            <h2>Bookings on this device</h2>
            <ul>
              {guest.map((g) => (
                <li key={g.bookingId}>
                  <Link href={`/bookings/${g.bookingId}`}>{g.bookingId}</Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }

  const vx = await customerClient();
  const page = await vx.bookings.list({ timeframe: tab, cursor: sp.cursor, limit: 10, sort: tab === "upcoming" ? "departure" : "-departure" });
  const locale = sf.defaultLocale;

  return (
    <section>
      <h1>My trips</h1>
      <nav className="tabs" aria-label="Trips">
        {TABS.map((t) => (
          <Link key={t.key} href={`/bookings?tab=${t.key}`} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {page.data.length === 0 && <p>No {tab} trips.</p>}
      <ul className="trip-list">
        {page.data.map((b) => (
          <li key={b.id}>
            <Link href={`/bookings/${b.id}`}>
              <strong>
                {b.originCode} → {b.destinationCityName ?? b.destinationCode}
              </strong>{" "}
              · {formatLocalDateTime(b.departureAt, locale)}
              {b.returnAt && <> – {formatLocalDateTime(b.returnAt, locale)}</>} · {b.leadTravelerName}
              {b.travelersCount > 1 && ` +${b.travelersCount - 1}`} · {formatMoney(b.total, locale)} · {b.reference}
              {b.status === "pending" && " · confirming"}
              {b.ticketingStatus === "pending" || b.ticketingStatus === "in_progress" ? " · tickets pending" : ""}
              {b.hasScheduleChange && <span className="tag">schedule changed</span>}
            </Link>
          </li>
        ))}
      </ul>
      <nav className="pager">
        {sp.cursor && <Link href={`/bookings?tab=${tab}`}>First page</Link>}
        {page.page.nextCursor && <Link href={`/bookings?tab=${tab}&cursor=${encodeURIComponent(page.page.nextCursor)}`}>Next page</Link>}
      </nav>
    </section>
  );
}
