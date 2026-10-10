import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { serializePage } from "@velexis/ota-sdk/next";
import { isVelexisError, type AncillaryCatalogue, type Schemas } from "@velexis/ota-sdk";
import { currentCustomer, customerClient, getStorefront } from "@/lib/velexis";
import { formatDuration, formatInstant, formatLocalDateTime, formatMoney } from "@/lib/format";
import { CheckoutSteps } from "./checkout-steps";

// checkout.complete (Amadeus Create Orders + issuance) may take up to 60 s.
export const maxDuration = 90;

/**
 * Checkout (server component): loads the checkout, the ancillary catalogue of its priced offer and — for signed-in
 * customers — saved travellers, then renders the client step components. Everything is customer scope (selling
 * amounts), so it is passed to the client components as it is; only SDK pages are converted (`serializePage`).
 */
export default async function CheckoutPage({ params }: { params: Promise<{ checkoutId: string }> }) {
  const { checkoutId } = await params;
  const [vx, sf, session] = await Promise.all([customerClient(), getStorefront(), currentCustomer()]);

  // The id comes from the URL: without a customer session the client reads it with the publishable key, so another
  // customer's checkout answers NOT_FOUND (guest checkouts are capability ids and stay readable).
  const checkout = await vx.checkout.get({ checkoutId }).catch((e: unknown) => {
    if (isVelexisError(e, "NOT_FOUND")) notFound();
    throw e;
  });
  if (checkout.status === "completed" && checkout.bookingId) redirect(`/bookings/${checkout.bookingId}?new=1`);
  if (checkout.status === "expired" || checkout.status === "abandoned") {
    return (
      <section>
        <h1>Your checkout has expired</h1>
        <p>
          Fares are held for a limited time. <Link href="/">Search again</Link>
        </p>
      </section>
    );
  }

  let catalogue: AncillaryCatalogue | null = null;
  if (sf.features.ancillaries) {
    catalogue = await vx.flights.getAncillaries({ pricedOfferId: checkout.basePricedOfferId }).catch((e: unknown) => {
      if (isVelexisError(e, "FEATURE_DISABLED") || isVelexisError(e, "OFFER_EXPIRED") || isVelexisError(e, "SUPPLIER_TIMEOUT")) return null;
      throw e;
    });
  }

  let savedTravelers: Schemas["SavedTraveler"][] = [];
  if (session && sf.features.savedTravelers) {
    savedTravelers = serializePage(await vx.account.savedTravelers.list({ limit: 20 })).data;
  }

  const locale = sf.defaultLocale;
  return (
    <section className="checkout">
      <aside className="checkout-summary">
        <h2>Your trip</h2>
        {checkout.itineraries.map((it) => (
          <p key={it.index}>
            {it.originCode} → {it.destinationCode} · {formatLocalDateTime(it.departureAt, locale)} · {formatDuration(it.durationMinutes)} ·{" "}
            {it.stops === 0 ? "direct" : `${it.stops} stop(s)`}
          </p>
        ))}
        <dl>
          <dt>Flights (incl. taxes and fees)</dt>
          <dd>{formatMoney(checkout.totals.offer, locale)}</dd>
          <dt>Extras</dt>
          <dd>{formatMoney(checkout.totals.ancillaries, locale)}</dd>
          {checkout.totals.cardFee && (
            <>
              <dt>Card fee</dt>
              <dd>{formatMoney(checkout.totals.cardFee, locale)}</dd>
            </>
          )}
          <dt>Total</dt>
          <dd>
            <strong>{formatMoney(checkout.totals.total, locale)}</strong>
          </dd>
        </dl>
        {checkout.conditions && (
          <p className="muted">
            {checkout.conditions.refundable ? "Refundable" : checkout.conditions.refundable === false ? "Non-refundable" : "Refund conditions on request"} ·{" "}
            {checkout.conditions.changeable ? "changes allowed" : "no changes"}
          </p>
        )}
        <p className="muted">Held until {formatInstant(checkout.expiresAt, locale)}</p>
      </aside>

      <CheckoutSteps
        initialCheckout={checkout}
        catalogue={catalogue}
        savedTravelers={savedTravelers}
        signedIn={!!session}
        payment={sf.payment}
        termsUrl={sf.legal.termsUrl}
        seatSelection={sf.features.seatSelection}
      />
    </section>
  );
}
