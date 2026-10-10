import Link from "next/link";
import { isVelexisError, type ConsoleQueuePage } from "@velexis/ota-sdk";
import { consoleApi, mustBeStaff } from "@/lib/velexis";
import { formatInstant, formatLocalDateTime } from "@/lib/format";

/**
 * Office queues (Amadeus Queue List). Without `cursor` a fresh Amadeus read is stored as a snapshot; "next" pages
 * through that snapshot without calling Amadeus again.
 */
export default async function QueuesPage({ searchParams }: { searchParams: Promise<{ queue?: string; category?: string; office?: string; max?: string; cursor?: string }> }) {
  const me = await mustBeStaff({ permissions: ["queues:read"], returnTo: "/console/queues" });
  const sp = await searchParams;
  const offices = me.tenant.supplier.officeIds;
  const office = sp.office && offices.includes(sp.office) ? sp.office : (me.tenant.supplier.queuingOfficeId ?? offices[0]);
  const api = await consoleApi();

  let page: ConsoleQueuePage | null = null;
  let problem: string | null = null;
  if (sp.queue) {
    try {
      page = await api.queues.list({
        queueId: Number(sp.queue),
        category: sp.category ? Number(sp.category) : 0,
        officeId: office ?? undefined,
        max: sp.max ? Number(sp.max) : 200,
        limit: 50,
        cursor: sp.cursor,
      });
    } catch (e) {
      if (isVelexisError(e, "OFFICE_NOT_ALLOWED")) problem = `Office ${office} is not configured on this OTA's Amadeus connection.`;
      else if (isVelexisError(e, "SUPPLIER_REJECTED")) problem = `Amadeus: ${e.supplier?.title ?? e.message}`;
      else throw e;
    }
  }
  const history = await api.queues.listSnapshots({ queueId: sp.queue ? Number(sp.queue) : undefined, officeId: office ?? undefined, limit: 10 });
  const next = page?.page.nextCursor;

  return (
    <section>
      <h1>Queues</h1>
      {!me.tenant.supplier.connected && <p className="error">No Amadeus connection configured for this environment.</p>}
      <form method="get" className="filters-bar">
        <label>
          Queue <input name="queue" type="number" min={0} max={99} defaultValue={sp.queue ?? "50"} required />
        </label>
        <label>
          Category <input name="category" type="number" min={0} max={255} defaultValue={sp.category ?? "0"} />
        </label>
        <label>
          Office
          <select name="office" defaultValue={office ?? ""}>
            {offices.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label>
          Max <input name="max" type="number" min={1} max={250} defaultValue={sp.max ?? "200"} />
        </label>
        <button type="submit">Read queue</button>
      </form>
      {problem && <p className="error">{problem}</p>}
      {page && (
        <>
          <p className="muted">
            Snapshot {page.snapshot.id} · {page.snapshot.itemCount} PNR(s) · {formatInstant(page.snapshot.fetchedAt)} · office {page.snapshot.officeId}
          </p>
          {page.warnings && page.warnings.length > 0 && <p className="notice">{page.warnings.map((w) => w.title).join(" · ")}</p>}
          <table className="grid">
            <thead>
              <tr>
                <th>PNR</th>
                <th>Created</th>
                <th>Travellers</th>
                <th>Segments</th>
                <th>Booking</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map((q) => (
                <tr key={q.pnrId}>
                  <td>
                    <Link href={`/console/pnr?rl=${q.recordLocator}`}>{q.recordLocator}</Link>
                  </td>
                  <td>{q.creationDateTime ? formatInstant(q.creationDateTime) : "—"}</td>
                  <td>{q.travelers.map((t) => `${t.lastName ?? ""}/${t.firstName ?? ""}`).join(", ")}</td>
                  <td>{q.segments.map((s) => `${s.carrierCode ?? ""}${s.number ?? ""} →${s.arrivalIataCode ?? ""} ${formatLocalDateTime(s.arrivalLocalDateTime)}`).join(" · ")}</td>
                  <td>{q.bookingId ? <Link href={`/console/bookings/${q.bookingId}`}>{q.bookingReference} ({q.bookingStatus})</Link> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {next && (
            <Link href={`/console/queues?queue=${sp.queue}&category=${sp.category ?? 0}&office=${office ?? ""}&cursor=${encodeURIComponent(next)}`}>Next page (same snapshot)</Link>
          )}
        </>
      )}
      <h2>Recent snapshots</h2>
      <ul>
        {history.data.map((s) => (
          <li key={s.id}>
            {formatInstant(s.fetchedAt)} · queue {s.queueId}/{s.category} · {s.officeId} · {s.itemCount} PNR(s) · {s.fetchedBy?.name ?? "scheduled poller"}
          </li>
        ))}
      </ul>
    </section>
  );
}
