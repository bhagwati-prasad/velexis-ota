"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { ConsoleAmadeusFlightOffersResult, FlightAvailabilitySearchResult, Money, Schemas } from "@velexis/ota-sdk";
import type { VelexisErrorData } from "@velexis/ota-sdk/react";
import { availabilityAction, priceRawOfferAction, rawOffersAction } from "./actions";
import { ErrorMessage } from "@/components/error-message";
import { formatLocalDateTime, formatMoney } from "@/lib/format";

type Priced = { id: string; price: { total: Money }; netPrice?: Money; lastTicketingDate?: string | null; expiresAt: string };

export function SearchConsole({ canPrice }: { canPrice: boolean }) {
  const [mode, setMode] = useState<"availability" | "offers">("availability");
  const [avail, setAvail] = useState<FlightAvailabilitySearchResult>();
  const [offers, setOffers] = useState<ConsoleAmadeusFlightOffersResult>();
  const [priced, setPriced] = useState<Record<string, Priced>>({});
  const [error, setError] = useState<VelexisErrorData>();
  const [pending, start] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    const carriers = s("carriers").toUpperCase().split(/[\s,]+/).filter(Boolean);
    setError(undefined);
    start(async () => {
      if (mode === "availability") {
        const r = await availabilityAction({
          origin: s("origin").toUpperCase(),
          destination: s("destination").toUpperCase(),
          date: s("date"),
          time: s("time") ? `${s("time")}:00` : undefined,
          adults: Number(s("adults") || 1),
          carriers,
          bookingClass: s("bookingClass").toUpperCase() || undefined,
          includeClosedContent: f.get("closed") === "on",
        });
        if (r.ok) setAvail(r.data);
        else setError(r.error);
      } else {
        const r = await rawOffersAction({
          originLocationCode: s("origin").toUpperCase(),
          destinationLocationCode: s("destination").toUpperCase(),
          departureDate: s("date"),
          returnDate: s("returnDate") || undefined,
          adults: Number(s("adults") || 1),
          nonStop: f.get("nonStop") === "on" || undefined,
          includedAirlineCodes: carriers.length ? carriers : undefined,
          max: 20,
        });
        if (r.ok) setOffers(r.data);
        else setError(r.error);
      }
    });
  }

  const price = (offer: Schemas["AmadeusFlightOffer"]) =>
    start(async () => {
      const r = await priceRawOfferAction(offer);
      if (r.ok) setPriced((p) => ({ ...p, [offer.id]: r.data }));
      else setError(r.error);
    });

  return (
    <div>
      <div className="tabs">
        <button type="button" aria-pressed={mode === "availability"} onClick={() => setMode("availability")}>Availability (AN)</button>
        <button type="button" aria-pressed={mode === "offers"} onClick={() => setMode("offers")}>Raw offers (FXD)</button>
      </div>
      <form onSubmit={onSubmit} className="filters-bar">
        <input name="origin" placeholder="From (CDG)" maxLength={3} required />
        <input name="destination" placeholder="To (JFK)" maxLength={3} required />
        <input name="date" type="date" required />
        {mode === "availability" ? <input name="time" type="time" aria-label="From time" /> : <input name="returnDate" type="date" aria-label="Return date" />}
        <input name="adults" type="number" min={1} max={9} defaultValue={1} aria-label="Adults" />
        <input name="carriers" placeholder="Carriers (AF KL)" />
        {mode === "availability" ? (
          <>
            <input name="bookingClass" placeholder="Class (Y)" maxLength={1} />
            <label>
              <input type="checkbox" name="closed" /> Include closed classes
            </label>
          </>
        ) : (
          <label>
            <input type="checkbox" name="nonStop" /> Non-stop
          </label>
        )}
        <button type="submit" disabled={pending}>{pending ? "Asking Amadeus…" : "Search"}</button>
      </form>
      <ErrorMessage error={error} showFields />

      {mode === "availability" && avail && (
        <table className="grid">
          <thead>
            <tr>
              <th>Flight</th>
              <th>Departure</th>
              <th>Arrival</th>
              <th>Equip.</th>
              <th>Classes (seats)</th>
            </tr>
          </thead>
          <tbody>
            {avail.data.flatMap((a) =>
              a.segments.map((s, i) => (
                <tr key={`${a.id}-${s.id}`} className={i > 0 ? "connection" : undefined}>
                  <td>
                    {s.carrierCode}
                    {s.number} {s.operating && s.operating.carrierCode !== s.carrierCode && <span className="muted">op {s.operating.carrierCode}</span>}
                  </td>
                  <td>
                    {s.departure.iataCode} {formatLocalDateTime(s.departure.at)}
                  </td>
                  <td>
                    {s.arrival.iataCode} {formatLocalDateTime(s.arrival.at)}
                  </td>
                  <td>{s.aircraft?.code}</td>
                  <td className="mono">
                    {s.closedStatus
                      ? s.closedStatus
                      : s.classes.map((c) => `${c.class ?? "?"}${c.closedStatus ? (c.closedStatus === "WAITLIST_OPEN" ? "L" : c.closedStatus === "ON_REQUEST" ? "R" : "C") : c.numberOfBookableSeats ?? 0}`).join(" ")}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}

      {mode === "offers" && offers && (
        <>
          <p className="muted">
            {offers.amadeus.data.length} offers · {offers.call.durationMs} ms · correlation {offers.call.correlationId ?? "—"}
          </p>
          <table className="grid">
            <thead>
              <tr>
                <th>#</th>
                <th>Itineraries</th>
                <th>Validating</th>
                <th>Net total</th>
                <th>Seats</th>
                <th>TL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {offers.amadeus.data.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>
                    {(o.itineraries ?? []).map((it, i) => (
                      <div key={i}>
                        {it.segments.map((s) => `${s.carrierCode ?? ""}${s.number ?? ""} ${s.departure?.iataCode ?? ""}-${s.arrival?.iataCode ?? ""} ${formatLocalDateTime(s.departure?.at)}`).join(" / ")}{" "}
                        <span className="muted">{it.duration}</span>
                      </div>
                    ))}
                  </td>
                  <td>{o.validatingAirlineCodes?.join(",")}</td>
                  <td>{o.price?.grandTotal ? `${o.price.grandTotal} ${o.price.currency ?? ""}` : "—"}</td>
                  <td>{o.numberOfBookableSeats}</td>
                  <td>{o.lastTicketingDate}</td>
                  <td>
                    {canPrice &&
                      (priced[o.id] ? (
                        <span>
                          {priced[o.id].id}: sell {formatMoney(priced[o.id].price.total)} (net {formatMoney(priced[o.id].netPrice)})
                        </span>
                      ) : (
                        <button type="button" disabled={pending} onClick={() => price(o)}>Price</button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
