"use client";

import { useAncillaries, useStorefront, type UseCheckoutResult } from "@velexis/ota-sdk/react";
import type { AncillaryCatalogue, AncillaryOption, AncillarySelection, Checkout } from "@velexis/ota-sdk";

/**
 * Extras step: extra checked / cabin bags, other services (priority boarding, airport check-in, fast track) and
 * chargeable seats where the offer supports them. "Apply" re-prices the checkout with Amadeus
 * (`checkout.setAncillaries` + expectedTotal); a price move is shown and must be accepted.
 */
export function AncillariesForm({ checkout, catalogue, seatSelection, checkoutState: co }: { checkout: Checkout; catalogue: AncillaryCatalogue; seatSelection: boolean; checkoutState: UseCheckoutResult }) {
  const { formatMoney } = useStorefront();
  const initialSelections: AncillarySelection[] = checkout.ancillaries.map((a) => ({
    optionId: a.optionId ?? undefined,
    type: a.optionId ? undefined : a.type,
    travelerId: a.travelerId,
    segmentIds: a.optionId ? undefined : a.segmentIds,
    quantity: a.quantity ?? undefined,
    seatNumber: a.seatNumber ?? undefined,
    serviceName: a.optionId ? undefined : a.serviceName ?? undefined,
  }));
  const anc = useAncillaries(checkout.basePricedOfferId, { initial: catalogue, initialSelections });
  const segmentLabel = (ids: string[]) =>
    ids.map((id) => catalogue.segments.find((s) => s.segmentId === id)).map((s) => (s ? `${s.originCode}→${s.destinationCode} ${s.flightNumber}` : "")).join(", ");

  const apply = (expectedTotal = checkout.totals.total) => co.setAncillaries(anc.selections, expectedTotal);

  const OptionRow = ({ option, travelerId }: { option: AncillaryOption; travelerId: string }) => {
    const selected = anc.isSelected(option.id, travelerId);
    const current = anc.selections.find((s) => s.optionId === option.id && s.travelerId === travelerId);
    return (
      <li>
        <label>
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => (e.target.checked ? anc.select({ option, travelerId, quantity: option.quantity ?? 1 }) : anc.remove(option.id, travelerId))}
          />
          {option.label} · {segmentLabel(option.segmentIds)} · {option.price ? formatMoney(option.price) : "price on request"}
        </label>
        {option.requiresSeatNumber && selected && (
          <input
            aria-label="Seat number"
            placeholder="Seat, e.g. 14C"
            pattern="[0-9]{1,2}[A-K]"
            defaultValue={current?.seatNumber ?? ""}
            onBlur={(e) => anc.select({ option, travelerId, seatNumber: e.target.value.toUpperCase() })}
          />
        )}
      </li>
    );
  };

  return (
    <section className="step">
      <h2>Extras</h2>
      {catalogue.travelers.map((t) => {
        const o = anc.optionsFor(t.travelerId);
        return (
          <fieldset key={t.travelerId}>
            <legend>Traveller {t.travelerId}</legend>
            {o.checkedBags.length > 0 && (
              <>
                <h3>Checked bags</h3>
                <ul>{o.checkedBags.map((opt) => <OptionRow key={opt.id} option={opt} travelerId={t.travelerId} />)}</ul>
              </>
            )}
            {o.cabinBags.length > 0 && (
              <>
                <h3>Cabin bags</h3>
                <ul>{o.cabinBags.map((opt) => <OptionRow key={opt.id} option={opt} travelerId={t.travelerId} />)}</ul>
              </>
            )}
            {o.otherServices.length > 0 && (
              <>
                <h3>Services</h3>
                <ul>{o.otherServices.map((opt) => <OptionRow key={opt.id} option={opt} travelerId={t.travelerId} />)}</ul>
              </>
            )}
            {seatSelection && catalogue.seatsSupported && o.seats.length > 0 && (
              <>
                <h3>Seats</h3>
                {/* No seat map in the Velexis API (Amadeus SeatMap Display is not integrated): the customer types a seat number. */}
                <ul>{o.seats.map((opt) => <OptionRow key={opt.id} option={opt} travelerId={t.travelerId} />)}</ul>
              </>
            )}
          </fieldset>
        );
      })}
      <p>
        Selected extras: {anc.estimatedTotal ? formatMoney(anc.estimatedTotal) : formatMoney(checkout.totals.ancillaries)} (confirmed by the airline when applied)
      </p>
      {co.priceChange ? (
        <div className="notice" role="alert">
          New total {formatMoney(co.priceChange.newPrice)} (was {formatMoney(co.priceChange.oldPrice)}).
          <button type="button" disabled={co.pending} onClick={() => co.priceChange?.newPrice && void apply(co.priceChange.newPrice)}>
            Accept new total
          </button>
        </div>
      ) : (
        <button type="button" disabled={co.pending} onClick={() => void apply()}>
          {co.pending ? "Checking with the airline…" : "Apply extras"}
        </button>
      )}
      {anc.selections.length > 0 && (
        <button type="button" disabled={co.pending} onClick={() => { anc.clear(); void co.setAncillaries([]); }}>
          Remove all extras
        </button>
      )}
      {co.error && co.error.code === "ANCILLARY_NOT_AVAILABLE" && <p className="error">One of the extras is no longer available: {String(co.error.details?.reason ?? "")}</p>}
    </section>
  );
}
