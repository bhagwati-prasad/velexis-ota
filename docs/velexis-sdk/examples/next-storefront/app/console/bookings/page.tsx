import Link from "next/link";
import type { ConsoleBookingSort, ConsoleBookingStatus, ConsoleListBookingsParams, ConsolePaymentStatus, ConsoleTicketingStatus } from "@velexis/ota-sdk";
import { consoleApi, mustBeStaff } from "@/lib/velexis";
import { formatInstant, formatLocalDateTime, formatMoney } from "@/lib/format";

type SP = Record<string, string | string[] | undefined>;

const STATUSES: ConsoleBookingStatus[] = ["pending", "confirmed", "ticketed", "partially_ticketed", "cancelled", "failed"];
const TICKETING: ConsoleTicketingStatus[] = ["pending", "in_progress", "issued", "partially_issued", "failed", "manual_review", "not_applicable"];
const PAYMENT: ConsolePaymentStatus[] = ["unpaid", "authorized", "paid", "partially_refunded", "refunded", "failed", "not_applicable"];
const SORTS: ConsoleBookingSort[] = ["-created", "created", "departure", "-departure", "ticketingDeadline", "-ticketingDeadline", "total", "-total"];

const list = <T extends string>(v: string | string[] | undefined, allowed: readonly T[]): T[] | undefined => {
  const values = (Array.isArray(v) ? v : v ? v.split(",") : []).filter((x): x is T => (allowed as readonly string[]).includes(x));
  return values.length ? values : undefined;
};
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** All bookings of the OTA (every channel, customers and guests, all statuses) with filters, sort and cursor pages. */
export default async function ConsoleBookingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  await mustBeStaff({ permissions: ["bookings:read"], returnTo: "/console/bookings" });
  const sp = await searchParams;
  const params: ConsoleListBookingsParams = {
    q: one(sp.q),
    status: list(sp.status, STATUSES),
    ticketingStatus: list(sp.ticketingStatus, TICKETING),
    paymentStatus: list(sp.paymentStatus, PAYMENT),
    source: list(sp.source, ["storefront", "console", "import"] as const),
    departureFrom: one(sp.departureFrom),
    departureTo: one(sp.departureTo),
    travelerLastName: one(sp.lastName),
    ticketingDeadlineBefore: one(sp.toIssue) === "24h" ? new Date(Date.now() + 864e5).toISOString() : undefined,
    sort: SORTS.find((s) => s === one(sp.sort)) ?? "-created",
    cursor: one(sp.cursor),
    limit: 50,
  };
  const page = await (await consoleApi()).bookings.list(params);
  const query = (extra: Record<string, string>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "cursor") q.set(k, v);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return `?${q.toString()}`;
  };

  return (
    <section>
      <h1>Bookings {page.totalCount != null && <span className="muted">({page.totalCount})</span>}</h1>
      <form className="filters-bar" method="get">
        <input name="q" placeholder="Reference, PNR, e-mail, last name" defaultValue={params.q} />
        <select name="status" defaultValue={one(sp.status) ?? ""}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select name="ticketingStatus" defaultValue={one(sp.ticketingStatus) ?? ""}>
          <option value="">Any ticketing</option>
          {TICKETING.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select name="paymentStatus" defaultValue={one(sp.paymentStatus) ?? ""}>
          <option value="">Any payment</option>
          {PAYMENT.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select name="source" defaultValue={one(sp.source) ?? ""}>
          <option value="">Any channel</option>
          <option value="storefront">Storefront</option>
          <option value="console">Console</option>
          <option value="import">Import</option>
        </select>
        <label>
          Departure from <input type="date" name="departureFrom" defaultValue={params.departureFrom} />
        </label>
        <label>
          to <input type="date" name="departureTo" defaultValue={params.departureTo} />
        </label>
        <label>
          <input type="checkbox" name="toIssue" value="24h" defaultChecked={one(sp.toIssue) === "24h"} /> Ticketing deadline &lt; 24 h
        </label>
        <select name="sort" defaultValue={params.sort}>
          {SORTS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button type="submit">Filter</button>
        <Link href="/console/bookings">Reset</Link>
      </form>
      <table className="grid">
        <thead>
          <tr>
            <th>Reference</th>
            <th>PNR</th>
            <th>Lead traveller</th>
            <th>Route</th>
            <th>Departure</th>
            <th>Status</th>
            <th>Ticketing</th>
            <th>Deadline</th>
            <th>Payment</th>
            <th>Total</th>
            <th>Net</th>
            <th>Markup</th>
            <th>Sync</th>
          </tr>
        </thead>
        <tbody>
          {page.data.map((b) => (
            <tr key={b.id} className={b.hasScheduleChange ? "attention" : undefined}>
              <td>
                <Link href={`/console/bookings/${b.id}`}>{b.reference}</Link>
                {b.channel !== "storefront" && <span className="tag">{b.channel}</span>}
              </td>
              <td>{b.recordLocator ?? "—"}</td>
              <td>
                {b.leadTravelerName}
                {b.travelersCount > 1 && ` +${b.travelersCount - 1}`}
                <div className="muted">{b.customer?.email ?? "guest"}</div>
              </td>
              <td>
                {b.originCode}–{b.destinationCode} {b.validatingCarrier && <span className="muted">{b.validatingCarrier}</span>}
              </td>
              <td>{formatLocalDateTime(b.departureAt)}</td>
              <td>{b.status}</td>
              <td>{b.ticketingStatus}</td>
              <td>{b.ticketingDeadlineAt ? formatInstant(b.ticketingDeadlineAt) : "—"}</td>
              <td>{b.paymentStatus}</td>
              <td>{formatMoney(b.total)}</td>
              <td>{formatMoney(b.net)}</td>
              <td>{formatMoney(b.markup)}</td>
              <td title={b.lastSyncedAt ?? ""}>{b.syncStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {page.data.length === 0 && <p>No bookings match.</p>}
      <nav className="pager">
        {params.cursor && <Link href={query({})}>First page</Link>}
        {page.page.nextCursor && <Link href={query({ cursor: page.page.nextCursor })}>Next page</Link>}
      </nav>
    </section>
  );
}
