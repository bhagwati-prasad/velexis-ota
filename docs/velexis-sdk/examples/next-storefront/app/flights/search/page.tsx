import { notFound, redirect } from "next/navigation";
import { toResultsPageData } from "@velexis/ota-sdk/react";
import { isVelexisError, type FlightOfferSort, type FlightResultFilters, type ItineraryTimeWindow } from "@velexis/ota-sdk";
import { customerClient } from "@/lib/velexis";
import { formatLocalDateTime } from "@/lib/format";
import { searchAgainAction } from "../actions";
import { Results } from "./results";

type SearchParams = { searchId?: string; sort?: string; stops?: string; carriers?: string; maxPrice?: string; refundable?: string; dep?: string };

const SORTS: FlightOfferSort[] = ["best", "price", "-price", "duration", "departure", "-departure", "arrival", "-arrival"];

/** Parse filters mirrored into the URL by the client component (shareable result links). */
function parseFilters(sp: SearchParams): FlightResultFilters {
  const f: FlightResultFilters = {};
  if (sp.stops) f.stops = sp.stops.split(",").map(Number).filter((n): n is 0 | 1 | 2 => n === 0 || n === 1 || n === 2);
  if (sp.carriers) f.carriers = sp.carriers.split(",").filter(Boolean);
  if (sp.maxPrice) f.maxPrice = sp.maxPrice;
  if (sp.refundable === "1") f.refundable = true;
  if (sp.dep) f.departureWindow = sp.dep.split(",").filter((w): w is ItineraryTimeWindow => /^\d:\d{2}:\d{2}-\d{2}:\d{2}$/.test(w)).slice(0, 24);
  return f;
}

/**
 * Results page (server component): loads the search and the first filtered page with the customer's token, then hands
 * plain data to the client component for live filtering / sorting / pagination. The secret-key client gets customer
 * scope (selling amounts only), so only the page's methods are stripped (`toResultsPageData`).
 */
export default async function SearchResultsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  if (!sp.searchId) redirect("/");
  const sort = SORTS.includes(sp.sort as FlightOfferSort) ? (sp.sort as FlightOfferSort) : "best";
  const filters = parseFilters(sp);
  const vx = await customerClient();

  const search = await vx.flights.getSearch({ searchId: sp.searchId }).catch((e: unknown) => {
    if (isVelexisError(e, "NOT_FOUND")) notFound();
    throw e;
  });

  const leg = search.summary.legs[0];
  const title = leg ? `${leg.originCode} → ${leg.destinationCode}, ${formatLocalDateTime(leg.departureDate)}` : "Flights";

  if (search.status === "expired") {
    return (
      <section>
        <h1>{title}</h1>
        <p>These results have expired — prices change quickly.</p>
        <form action={searchAgainAction.bind(null, search.id)}>
          <button type="submit">Search again</button>
        </form>
      </section>
    );
  }

  if (search.status === "failed") {
    return (
      <section>
        <h1>{title}</h1>
        <p>The airline systems did not answer ({search.error?.code ?? "SUPPLIER_ERROR"}).</p>
        <form action={searchAgainAction.bind(null, search.id)}>
          <button type="submit">Search again</button>
        </form>
      </section>
    );
  }

  // An asynchronous search (`resultOptions.async`) may still be running: the client component polls it and loads page 1.
  const page =
    search.status === "pending"
      ? null
      : await vx.flights.listResults({ searchId: search.id, ...filters, sort, limit: 20, view: "summary" }).catch((e: unknown) => {
          if (isVelexisError(e, "SEARCH_EXPIRED") || isVelexisError(e, "SEARCH_NOT_COMPLETED")) return null;
          throw e;
        });

  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">
        {search.summary.travelers.total} traveller(s) · {search.summary.travelClass ?? "any cabin"} · {search.status === "pending" ? "searching…" : `${search.resultCount} offers`}
      </p>
      <Results
        searchId={search.id}
        initialSearch={{ ...search, offers: undefined }}
        initialPage={page ? toResultsPageData(page) : undefined}
        initialFilters={filters}
        initialSort={sort}
      />
      {page && <p className="muted">{page.page.nextCursor ? "More results available" : "All results shown"}</p>}
    </section>
  );
}
