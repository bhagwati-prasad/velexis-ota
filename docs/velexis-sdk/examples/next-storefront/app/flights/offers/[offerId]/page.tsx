import Link from "next/link";
import { notFound } from "next/navigation";
import { isVelexisError, type FlightOffer } from "@velexis/ota-sdk";
import { customerClient, getStorefront } from "@/lib/velexis";
import { formatDuration, formatLocalDateTime, formatMoney } from "@/lib/format";
import { UpsellPicker } from "./upsell-picker";

/** Offer details (full view) + branded-fare upsell (client component, loads `flights.upsell` on demand). */
export default async function OfferPage({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const [vx, sf] = await Promise.all([customerClient(), getStorefront()]);

  let offer: FlightOffer;
  try {
    offer = await vx.flights.getOffer({ offerId }); // customer scope: selling amounts only, also inside `amadeus`
  } catch (e) {
    if (isVelexisError(e, "NOT_FOUND")) notFound();
    if (isVelexisError(e, "OFFER_EXPIRED")) {
      return (
        <section>
          <h1>This offer has expired</h1>
          <p>Fares are only held for a short time. <Link href="/">Search again</Link></p>
        </section>
      );
    }
    throw e;
  }

  const fareBySegment = new Map((offer.travelerPricings?.[0]?.segments ?? []).map((f) => [f.segmentId, f]));
  const locale = sf.defaultLocale;

  return (
    <section className="offer-details">
      <Link href={`/flights/search?searchId=${offer.searchId}`}>← Back to results</Link>
      <h1>
        {offer.summary.originCode} → {offer.summary.destinationCode}
      </h1>
      {offer.itineraries.map((it) => (
        <div key={it.index} className="itinerary-detail">
          <h2>
            {it.index === 0 ? "Outbound" : "Return"} · {formatLocalDateTime(it.departureAt, locale)} · {formatDuration(it.durationMinutes)}
          </h2>
          <ol>
            {it.segments.map((seg) => {
              const fare = fareBySegment.get(seg.id);
              return (
                <li key={seg.id}>
                  <strong>
                    {seg.carrierName ?? seg.carrierCode} {seg.flightNumber}
                  </strong>
                  {seg.operating && seg.operating.carrierCode !== seg.carrierCode && <> · operated by {seg.operating.carrierName ?? seg.operating.carrierCode}</>}
                  <div>
                    {formatLocalDateTime(seg.departure.at, locale)} {seg.departure.iataCode}
                    {seg.departure.terminal && ` T${seg.departure.terminal}`} → {formatLocalDateTime(seg.arrival.at, locale)} {seg.arrival.iataCode}
                    {seg.arrival.terminal && ` T${seg.arrival.terminal}`}
                  </div>
                  <div className="muted">
                    {seg.aircraft?.name ?? seg.aircraft?.code} · {fare?.cabin ?? seg.cabin} {fare?.class && `(${fare.class})`} ·{" "}
                    {fare?.brandedFareLabel ?? seg.brandedFareLabel ?? ""}
                    {fare?.includedCheckedBags?.quantity != null && ` · ${fare.includedCheckedBags.quantity} checked bag(s)`}
                    {fare?.includedCheckedBags?.weight != null && ` · ${fare.includedCheckedBags.weight}${fare.includedCheckedBags.weightUnit ?? ""}`}
                    {seg.co2Emissions?.[0]?.weight != null && ` · CO₂ ${seg.co2Emissions[0].weight} kg`}
                  </div>
                  {fare?.amenities && fare.amenities.length > 0 && (
                    <ul className="amenities">
                      {fare.amenities.map((a, i) => (
                        <li key={i}>
                          {a.description} {a.status === "chargeable" ? "(fee)" : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {seg.layoverAfter && <p className="muted">Layover {formatDuration(seg.layoverAfter.durationMinutes)}</p>}
                </li>
              );
            })}
          </ol>
        </div>
      ))}

      <div className="price-summary">
        <div>Fare {formatMoney(offer.price.base, locale)}</div>
        <div>Taxes {formatMoney(offer.price.taxes, locale)}</div>
        <div>Fees {formatMoney(offer.price.fees, locale)}</div>
        <div>
          <strong>Total {formatMoney(offer.price.total, locale)}</strong>
        </div>
        {offer.lastTicketingDate && <p className="muted">Book before {offer.lastTicketingDate}</p>}
        <p className="muted">Price confirmed at the next step.</p>
      </div>

      <UpsellPicker offerId={offer.id} baseTotal={offer.price.total} upsellEnabled={sf.features.brandedFareUpsell} />
    </section>
  );
}
