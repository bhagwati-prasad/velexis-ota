import Link from "next/link";
import { notFound } from "next/navigation";
import { isVelexisError, type ConsoleBooking, type Schemas } from "@velexis/ota-sdk";
import { consoleApi, mustBeStaff } from "@/lib/velexis";
import { formatInstant, formatLocalDateTime, formatMoney } from "@/lib/format";
import { CancelForm, IssueForm, NoteForm, PatchForm, ResyncButton } from "./booking-actions";

type Tab = "overview" | "amadeus" | "history";

/**
 * Console booking detail: net/markup pricing, supplier sync, ticketing, the verbatim Amadeus order (retrieve),
 * PATCH (ticketing agreement / remarks), issue, cancel, resync and internal notes.
 */
export default async function ConsoleBookingPage({ params, searchParams }: { params: Promise<{ bookingId: string }>; searchParams: Promise<{ tab?: string; refresh?: string }> }) {
  const [{ bookingId }, sp] = await Promise.all([params, searchParams]);
  const me = await mustBeStaff({ permissions: ["bookings:read"], returnTo: `/console/bookings/${bookingId}` });
  const tab: Tab = sp.tab === "amadeus" || sp.tab === "history" ? sp.tab : "overview";
  const api = await consoleApi();

  let b: ConsoleBooking;
  try {
    b = await api.bookings.get({ bookingId, refresh: sp.refresh === "1", include: ["bags"] });
  } catch (e) {
    if (isVelexisError(e, "NOT_FOUND")) notFound();
    throw e;
  }
  const can = (p: Schemas["StaffPermission"]) => me.permissions.includes(p);

  return (
    <section className="console-booking">
      <h1>
        {b.reference} · {b.recordLocator ?? "no PNR"} <span className={`status status-${b.status}`}>{b.status}</span>
      </h1>
      <p className="muted">
        {b.channel} · {b.environment} · order {b.amadeusOrderId ?? "—"} · queuing office {b.queuingOfficeId ?? "—"} · v{b.version} · sync {b.supplierSync.status}{" "}
        {formatInstant(b.supplierSync.lastSyncedAt)} <Link href={`?refresh=1`}>Refresh from Amadeus</Link>
      </p>
      {b.failure && <p className="error">Failure {b.failure.code}: {b.failure.message} {b.failure.supplier?.code && `(Amadeus ${b.failure.supplier.code} ${b.failure.supplier.title ?? ""})`}</p>}
      {b.supplierSync.differences.length > 0 && <p className="notice">Amadeus differs: {b.supplierSync.differences.map((d) => d.label).join(", ")}</p>}
      <nav className="tabs">
        <Link href="?tab=overview" aria-current={tab === "overview" ? "page" : undefined}>Overview</Link>
        {can("amadeus:read") || me.staff.role === "finance" ? <Link href="?tab=amadeus" aria-current={tab === "amadeus" ? "page" : undefined}>Amadeus order</Link> : null}
        <Link href="?tab=history" aria-current={tab === "history" ? "page" : undefined}>History</Link>
      </nav>

      {tab === "overview" && (
        <>
          <div className="columns">
            <div>
              <h2>Itinerary</h2>
              {b.itineraries.map((it) =>
                it.segments.map((s) => (
                  <p key={s.id}>
                    {s.carrierCode}
                    {s.number} {s.departure.iataCode} {formatLocalDateTime(s.departure.at)} → {s.arrival.iataCode} {formatLocalDateTime(s.arrival.at)} · {s.bookingClass} {s.fareBasis} · {s.status}
                    {s.scheduleChanged && <span className="tag">changed</span>}
                  </p>
                )),
              )}
              <h2>Travellers</h2>
              {b.travelers.map((t) => (
                <p key={t.id}>
                  {t.name?.lastName}/{t.name?.firstName} {t.travelerType} {t.dateOfBirth} · {t.documents?.map((d) => `${d.documentType} ${d.number}`).join(", ")} · tickets {t.ticketNumbers?.join(", ") || "—"}
                </p>
              ))}
              <h2>Contact</h2>
              <p>
                {b.contactEmail} · {b.customer ? <>customer {b.customer.email}</> : "guest"}
              </p>
            </div>
            <div>
              <h2>Pricing</h2>
              <dl>
                <dt>Net</dt>
                <dd>{formatMoney(b.pricing.net)}</dd>
                <dt>Markup</dt>
                <dd>{formatMoney(b.pricing.markup)} {b.pricing.markupRuleName && <span className="muted">({b.pricing.markupRuleName})</span>}</dd>
                <dt>Service fees</dt>
                <dd>{formatMoney(b.pricing.serviceFees)}</dd>
                <dt>Selling</dt>
                <dd>{formatMoney(b.pricing.selling)}</dd>
                <dt>Margin</dt>
                <dd>
                  {formatMoney(b.pricing.margin)} ({b.pricing.marginPercent} %)
                </dd>
                <dt>Payment</dt>
                <dd>
                  {b.paymentStatus} · paid {formatMoney(b.totals.paid)}
                </dd>
              </dl>
              <h2>Ticketing</h2>
              <p>
                {b.ticketing.status} · policy {b.ticketing.policy} · deadline {formatInstant(b.ticketing.deadlineAt)}
                {b.ticketingAgreement && ` · agreement ${b.ticketingAgreement.option ?? ""} ${b.ticketingAgreement.delay ?? b.ticketingAgreement.dateTime ?? ""}`}
              </p>
              <ul>
                {b.tickets.map((t) => (
                  <li key={t.id}>
                    {t.documentType} {t.documentNumber} · {t.status} · {t.travelerName}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="console-actions">
            {b.consoleActions.canResync && can("bookings:write") && <ResyncButton bookingId={b.id} />}
            {b.consoleActions.canIssue && can("bookings:issue") ? (
              <IssueForm bookingId={b.id} version={b.version} unpaid={b.paymentStatus === "unpaid"} canAllowUnpaid={me.staff.role === "owner" || me.staff.role === "admin"} />
            ) : (
              b.consoleActions.reasons.canIssue && <p className="muted">Issue: {String(b.consoleActions.reasons.canIssue)}</p>
            )}
            {b.consoleActions.canPatch && can("bookings:write") && <PatchForm bookingId={b.id} version={b.version} />}
            {b.consoleActions.canCancel && can("bookings:cancel") && <CancelForm bookingId={b.id} version={b.version} paid={b.totals.paid} />}
          </div>

          <h2>Notes</h2>
          <ul>
            {b.notes.map((n) => (
              <li key={n.id}>
                {formatInstant(n.createdAt)} · {n.author.name ?? n.author.type}: {n.text} {n.visibleToCustomer && <span className="tag">customer</span>}
              </li>
            ))}
          </ul>
          {b.consoleActions.canAddNote && <NoteForm bookingId={b.id} />}
        </>
      )}

      {tab === "amadeus" && <AmadeusTab bookingId={b.id} />}

      {tab === "history" && (
        <>
          <h2>Timeline</h2>
          <ol className="timeline">
            {b.events.map((e) => (
              <li key={e.id}>
                {formatInstant(e.createdAt)} · {e.actor.name ?? e.actor.type} · {e.summary} {e.visibleToCustomer ? "" : <span className="muted">(internal)</span>}
              </li>
            ))}
          </ol>
          <h2>Recent Amadeus calls</h2>
          <table className="grid">
            <tbody>
              {b.recentSupplierRequests.map((r) => (
                <tr key={r.id}>
                  <td>{formatInstant(r.createdAt)}</td>
                  <td>{r.amadeusApi}</td>
                  <td>{r.amadeusOperationId}</td>
                  <td>{r.httpStatus}</td>
                  <td>{r.outcome}</td>
                  <td>{r.errorCodes.join(", ")}</td>
                  <td>{r.durationMs} ms</td>
                  <td className="muted">{r.correlationId}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Staff actions</h2>
          <ul>
            {b.recentStaffActions.map((a) => (
              <li key={a.id}>
                {formatInstant(a.createdAt)} · {a.actor.name ?? a.actor.type} · {a.action} · {a.outcome} {a.reason && `— ${a.reason}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Verbatim Amadeus order (Flight Order Management GET with include=bags, fareRules=rebooks,refunds). */
async function AmadeusTab({ bookingId }: { bookingId: string }) {
  const api = await consoleApi();
  try {
    const r = await api.bookings.retrieve({ bookingId, include: ["bags"], fareRules: ["rebooks", "refunds"], updateSnapshot: true });
    return (
      <div>
        <p className="muted">
          Order {r.flightOrderId} · retrieved {formatInstant(r.retrievedAt)} · {r.call.httpStatus} in {r.call.durationMs} ms · office {r.call.officeId ?? "—"} · correlation{" "}
          {r.call.correlationId ?? "—"}
        </p>
        {r.amadeus.warnings && r.amadeus.warnings.length > 0 && <p className="notice">{r.amadeus.warnings.map((w) => w.title).join(" · ")}</p>}
        <pre className="json">{JSON.stringify(r.amadeus.data, null, 2)}</pre>
        {r.amadeus.included && (
          <details>
            <summary>included (bags, …)</summary>
            <pre className="json">{JSON.stringify(r.amadeus.included, null, 2)}</pre>
          </details>
        )}
      </div>
    );
  } catch (e) {
    if (isVelexisError(e, "BOOKING_NOT_MODIFIABLE")) return <p>This booking has no Amadeus order.</p>;
    if (isVelexisError(e, "SUPPLIER_REJECTED") || isVelexisError(e, "SUPPLIER_TIMEOUT") || isVelexisError(e, "SUPPLIER_ERROR")) {
      return (
        <p className="error">
          Amadeus: {e.supplier?.code} {e.supplier?.title ?? e.message} (request {e.requestId})
        </p>
      );
    }
    throw e;
  }
}
