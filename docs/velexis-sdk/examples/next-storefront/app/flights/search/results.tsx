"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useFlightSearch, useStorefront, type FlightResultsPageData } from "@velexis/ota-sdk/react";
import type { FlightOffer, FlightOfferSort, FlightResultFilters, FlightSearch, FlightDictionaries, ItineraryTimeWindow } from "@velexis/ota-sdk";
import { formatDuration, formatLocalTime } from "@/lib/format";

const SORT_LABELS: Record<FlightOfferSort, string> = {
  best: "Best",
  price: "Cheapest",
  "-price": "Most expensive",
  duration: "Fastest",
  departure: "Earliest departure",
  "-departure": "Latest departure",
  arrival: "Earliest arrival",
  "-arrival": "Latest arrival",
};

export function Results(props: {
  searchId: string;
  initialSearch: FlightSearch;
  initialPage?: FlightResultsPageData;
  initialFilters: FlightResultFilters;
  initialSort: FlightOfferSort;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { formatMoney } = useStorefront();
  const rs = useFlightSearch({
    searchId: props.searchId,
    initialSearch: props.initialSearch,
    initialPage: props.initialPage,
    filters: props.initialFilters,
    sort: props.initialSort,
    limit: 20,
    pollIntervalMs: 60_000,
    // Mirror filters into the URL so results are shareable and survive reloads.
    onQueryChange: ({ filters, sort }) => {
      const q = new URLSearchParams({ searchId: props.searchId, sort });
      if (filters.stops?.length) q.set("stops", filters.stops.join(","));
      if (filters.carriers?.length) q.set("carriers", filters.carriers.join(","));
      if (filters.maxPrice) q.set("maxPrice", filters.maxPrice);
      if (filters.refundable) q.set("refundable", "1");
      if (filters.departureWindow?.length) q.set("dep", filters.departureWindow.join(","));
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    },
  });

  if (rs.pending) return <p aria-live="polite">Searching the airlines… results appear in a moment.</p>;

  if (rs.expired) {
    return (
      <div className="notice">
        These prices expired. <Link href="/">Search again</Link>
      </div>
    );
  }

  const toggle = <T,>(list: T[] | undefined, v: T) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]);
  const facets = rs.facets;

  return (
    <div className="results">
      <aside className="filters" aria-label="Filters">
        <h2>Stops</h2>
        {facets?.stops.map((b) => (
          <label key={b.value}>
            <input
              type="checkbox"
              checked={rs.filters.stops?.includes(Number(b.value) as 0 | 1 | 2) ?? false}
              onChange={() => rs.setFilters({ stops: toggle(rs.filters.stops, Number(b.value) as 0 | 1 | 2) })}
            />
            {b.label ?? b.value} ({b.count}) {b.minPrice && <span className="muted">from {formatMoney(b.minPrice)}</span>}
          </label>
        ))}
        <h2>Airlines</h2>
        {facets?.carriers.map((b) => (
          <label key={b.value}>
            <input type="checkbox" checked={rs.filters.carriers?.includes(b.value) ?? false} onChange={() => rs.setFilters({ carriers: toggle(rs.filters.carriers, b.value) })} />
            {rs.dictionaries?.carriers[b.value]?.name ?? b.label ?? b.value} ({b.count})
          </label>
        ))}
        {facets?.price.max && (
          <>
            <h2>Max price</h2>
            <input
              type="range"
              min={Math.floor(Number(facets.price.min?.amount ?? 0))}
              max={Math.ceil(Number(facets.price.max.amount))}
              defaultValue={rs.filters.maxPrice ?? facets.price.max.amount}
              onChange={(e) => rs.setFilters({ maxPrice: e.target.value })}
            />
            <span>{formatMoney({ amount: rs.filters.maxPrice ?? facets.price.max.amount, currency: facets.price.max.currency })}</span>
          </>
        )}
        {facets?.departureTimes && facets.departureTimes.length > 0 && (
          <>
            <h2>Departure time</h2>
            {/* Windows of the same itinerary are ORed ("morning or evening"), different itineraries ANDed. */}
            {facets.departureTimes.map((t) => {
              const w: ItineraryTimeWindow = `${t.itineraryIndex}:${t.from}-${t.to}`;
              const selected = rs.filters.departureWindow?.includes(w) ?? false;
              const next = toggle(rs.filters.departureWindow, w);
              return (
                <label key={w}>
                  <input type="checkbox" checked={selected} onChange={() => rs.setFilters({ departureWindow: next.length ? next : undefined })} />
                  {t.itineraryIndex === 0 ? "Outbound" : "Return"} {t.band.replace("_", " ")} ({t.count})
                </label>
              );
            })}
          </>
        )}
        <h2>Conditions</h2>
        <label>
          <input type="checkbox" checked={rs.filters.refundable === true} onChange={(e) => rs.setFilters({ refundable: e.target.checked || undefined })} /> Refundable only
        </label>
        <label>
          <input
            type="checkbox"
            checked={(rs.filters.minIncludedCheckedBags ?? 0) > 0}
            onChange={(e) => rs.setFilters({ minIncludedCheckedBags: e.target.checked ? 1 : undefined })}
          />{" "}
          Checked bag included
        </label>
        <button type="button" onClick={rs.clearFilters}>Clear filters</button>
      </aside>

      <div className="offers">
        <div className="toolbar">
          <span>{rs.total} flights</span>
          <label>
            Sort
            <select value={rs.sort} onChange={(e) => rs.setSort(e.target.value as FlightOfferSort)}>
              {Object.entries(SORT_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        </div>
        {rs.error && <p role="alert" className="error">{rs.error.message}</p>}
        {rs.warnings.length > 0 && <p className="muted">{rs.warnings.map((w) => w.title).join(" · ")}</p>}
        {rs.loading && rs.offers.length === 0 && <p>Loading…</p>}
        {!rs.loading && rs.offers.length === 0 && <p>No flights match these filters.</p>}
        <ol>
          {rs.offers.map((o) => (
            <li key={o.id}>
              <OfferCard offer={o} dictionaries={rs.dictionaries} formatMoney={formatMoney} />
            </li>
          ))}
        </ol>
        {rs.hasMore && (
          <button type="button" onClick={() => void rs.loadMore()} disabled={rs.loading}>
            {rs.loading ? "Loading…" : "Show more flights"}
          </button>
        )}
      </div>
    </div>
  );
}

function OfferCard({ offer, dictionaries, formatMoney }: { offer: FlightOffer; dictionaries?: FlightDictionaries; formatMoney: (m: FlightOffer["price"]["total"]) => string }) {
  const s = offer.summary;
  return (
    <article className="offer-card">
      {s.tags?.map((t) => <span key={t} className={`tag tag-${t}`}>{t}</span>)}
      {offer.itineraries.map((it) => (
        <div key={it.index} className="itinerary">
          <strong>{formatLocalTime(it.departureAt)}</strong> {it.originCode} → <strong>{formatLocalTime(it.arrivalAt)}</strong>
          {it.arrivalDayOffset ? <sup>+{it.arrivalDayOffset}</sup> : null} {it.destinationCode} · {formatDuration(it.durationMinutes)} ·{" "}
          {it.stops === 0 ? "Direct" : `${it.stops} stop(s) ${it.stopAirports?.join(", ") ?? ""}`} ·{" "}
          {(it.marketingCarriers ?? []).map((c) => dictionaries?.carriers[c]?.name ?? c).join(", ")}
        </div>
      ))}
      <div className="price">
        <strong>{formatMoney(offer.price.total)}</strong>
        {offer.price.perAdult && <span className="muted"> ({formatMoney(offer.price.perAdult)} per adult)</span>}
        <div className="muted">
          {s.brandedFares?.[0]?.label ?? s.cabins.join("/")}
          {s.includedCheckedBags?.quantity ? ` · ${s.includedCheckedBags.quantity} checked bag(s)` : " · no checked bag"}
          {s.refundable === true && " · refundable"}
          {s.numberOfBookableSeats != null && s.numberOfBookableSeats < 5 && ` · ${s.numberOfBookableSeats} seats left`}
        </div>
        <Link href={`/flights/offers/${offer.id}`}>Select</Link>
      </div>
    </article>
  );
}
