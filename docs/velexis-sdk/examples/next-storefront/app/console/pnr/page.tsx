import Link from "next/link";
import { isVelexisError, type PnrLookupResult } from "@velexis/ota-sdk";
import { consoleApi, mustBeStaff } from "@/lib/velexis";
import { formatLocalDateTime, formatMoney } from "@/lib/format";
import { ImportForm } from "./import-form";

/** PNR lookup by record locator (Amadeus Get Flight Order By Record Locator) + import of orders created outside Velexis. */
export default async function PnrPage({ searchParams }: { searchParams: Promise<{ rl?: string }> }) {
  const me = await mustBeStaff({ roles: ["owner", "admin", "agent"], returnTo: "/console/pnr" });
  const { rl } = await searchParams;
  const reference = rl?.trim().toUpperCase();

  let result: PnrLookupResult | null = null;
  let problem: string | null = null;
  if (reference) {
    try {
      result = await (await consoleApi()).bookings.findByRecordLocator({ reference, include: ["bags"] });
    } catch (e) {
      if (isVelexisError(e, "NOT_FOUND")) problem = `No order found for ${reference}.`;
      else if (isVelexisError(e, "SUPPLIER_REJECTED")) problem = `Amadeus rejected the lookup: ${e.supplier?.code ?? ""} ${e.supplier?.title ?? e.message}`;
      else if (isVelexisError(e, "VALIDATION_FAILED")) problem = "That is not a valid record locator.";
      else throw e;
    }
  }

  return (
    <section>
      <h1>PNR lookup</h1>
      <form method="get" className="filters-bar">
        <input name="rl" defaultValue={reference} placeholder="Record locator, e.g. L2P9XC" pattern="[A-Za-z0-9]{5,8}" required autoFocus />
        <button type="submit">Retrieve</button>
      </form>
      {problem && <p className="error">{problem}</p>}
      {result && (
        <>
          <p className="muted">
            {result.matches.length} order(s) · {result.originSystemCode} · {result.call.durationMs} ms · correlation {result.call.correlationId ?? "—"}
          </p>
          {result.warnings.length > 0 && <p className="notice">{result.warnings.map((w) => w.title).join(" · ")}</p>}
          {result.matches.map((m) => (
            <article key={m.flightOrderId} className="pnr-match">
              <h2>
                {m.summary.recordLocators.map((r) => `${r.originSystemCode} ${r.reference}`).join(" · ")}{" "}
                {m.bookingId ? (
                  <Link href={`/console/bookings/${m.bookingId}`}>
                    booking {m.bookingReference} ({m.bookingStatus})
                  </Link>
                ) : (
                  <span className="tag">not in Velexis</span>
                )}
              </h2>
              <p>
                {m.summary.travelers.map((t) => `${t.lastName}/${t.firstName}`).join(", ")} · total {formatMoney(m.summary.grandTotal)} · TL {m.summary.lastTicketingDate ?? "—"} · queue office{" "}
                {m.summary.queuingOfficeId ?? "—"} · tickets {m.summary.ticketNumbers.join(", ") || "none"}
              </p>
              <ul>
                {m.summary.segments.map((s) => (
                  <li key={s.segmentId}>
                    {s.carrierCode}
                    {s.number} {s.originCode}-{s.destinationCode} {formatLocalDateTime(s.departureAt)} {s.bookingStatus ?? ""}
                  </li>
                ))}
              </ul>
              <details>
                <summary>Verbatim Amadeus order</summary>
                <pre className="json">{JSON.stringify(m.amadeus, null, 2)}</pre>
              </details>
              {m.importable && me.permissions.includes("bookings:write") && <ImportForm reference={result.reference} flightOrderId={m.flightOrderId} />}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
