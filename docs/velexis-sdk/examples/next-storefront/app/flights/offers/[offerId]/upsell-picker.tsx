"use client";

import { useState, useTransition } from "react";
import { useStorefront, useUpsell } from "@velexis/ota-sdk/react";
import type { Money } from "@velexis/ota-sdk";
import { acceptPriceAction, continueWithOfferAction, type ContinueState } from "../../actions";
import { ErrorMessage } from "@/components/error-message";

/**
 * Branded-fare upsell: fare families of the same flights side by side (bags, changes, refunds, amenities), then
 * "Continue" prices the selected offer (Flight Offers Price) and opens the checkout (server action).
 */
export function UpsellPicker({ offerId, baseTotal, upsellEnabled }: { offerId: string; baseTotal: Money; upsellEnabled: boolean }) {
  const { formatMoney } = useStorefront();
  const upsell = useUpsell(offerId, { enabled: upsellEnabled });
  const [state, setState] = useState<ContinueState>({});
  const [pending, start] = useTransition();

  const comparison = upsell.data?.comparison;
  const selected = upsell.selectedOfferId ?? offerId;
  const selectedTotal = comparison?.columns.find((c) => c.offerId === selected)?.price ?? baseTotal;

  const continueWith = () => start(async () => setState(await continueWithOfferAction(selected, selectedTotal)));

  return (
    <div className="upsell">
      {upsellEnabled && upsell.loading && <p>Loading fare options…</p>}
      {upsell.error && upsell.error.code !== "FEATURE_DISABLED" && <p className="muted">Fare options unavailable ({upsell.error.code}).</p>}
      {comparison && comparison.columns.length > 1 && (
        <table className="fare-families">
          <thead>
            <tr>
              <th />
              {comparison.columns.map((col) => (
                <th key={col.offerId}>
                  <label>
                    <input type="radio" name="fare" checked={selected === col.offerId} onChange={() => upsell.select(col.offerId)} />
                    {col.brandedFareLabel ?? col.brandedFare ?? col.cabin}
                  </label>
                  <div>{formatMoney(col.price)}</div>
                  {!col.isBaseOffer && <div className="muted">+{formatMoney(col.priceDifference)}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Checked bags</th>
              {comparison.columns.map((c) => (
                <td key={c.offerId}>{c.includedCheckedBags?.quantity ?? (c.includedCheckedBags?.weight ? `${c.includedCheckedBags.weight}${c.includedCheckedBags.weightUnit ?? ""}` : "—")}</td>
              ))}
            </tr>
            <tr>
              <th>Refundable</th>
              {comparison.columns.map((c) => (
                <td key={c.offerId}>{c.refundable == null ? "?" : c.refundable ? "Yes" : "No"}</td>
              ))}
            </tr>
            <tr>
              <th>Changeable</th>
              {comparison.columns.map((c) => (
                <td key={c.offerId}>{c.changeable == null ? "?" : c.changeable ? "Yes" : "No"}</td>
              ))}
            </tr>
            {comparison.rows.map((row) => (
              <tr key={row.key}>
                <th>{row.label}</th>
                {row.values.map((cell) => (
                  <td key={cell.offerId} className={`cell-${cell.status}`}>
                    {cell.status === "included" ? "✓" : cell.status === "chargeable" ? "fee" : cell.status === "not_offered" ? "—" : "?"}
                    {cell.detail && <span className="muted"> {cell.detail}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {state.priceChange ? (
        <div className="notice" role="alert">
          <p>
            The airline changed the price from {formatMoney(state.priceChange.oldPrice)} to <strong>{formatMoney(state.priceChange.newPrice)}</strong>.
          </p>
          {state.priceChange.pricedOfferId && (
            <button type="button" disabled={pending} onClick={() => start(async () => setState(await acceptPriceAction(state.priceChange!.pricedOfferId!)))}>
              Continue at the new price
            </button>
          )}
        </div>
      ) : (
        <button type="button" onClick={continueWith} disabled={pending}>
          {pending ? "Confirming price…" : `Continue · ${formatMoney(selectedTotal)}`}
        </button>
      )}
      <ErrorMessage error={state.error} />
    </div>
  );
}
