"use server";

import { redirect } from "next/navigation";
import { toActionError } from "@velexis/ota-sdk/next";
import { PriceChangedError, isVelexisError, type Money, type CabinClass } from "@velexis/ota-sdk";
import { customerClient, getStorefront } from "@/lib/velexis";
import type { FormState, PriceChange, ActionResult } from "@/lib/action-state";

const CABINS: CabinClass[] = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"];

/** Search form → flights.search (Amadeus Flight Offers Search, up to 60 s) → results page. */
export async function searchFlightsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const origin = String(form.get("origin") ?? "").toUpperCase();
  const destination = String(form.get("destination") ?? "").toUpperCase();
  const departureDate = String(form.get("departureDate") ?? "");
  const tripType = String(form.get("tripType") ?? "round_trip");
  const returnDate = tripType === "round_trip" ? String(form.get("returnDate") ?? "") || undefined : undefined;
  const cabin = String(form.get("travelClass") ?? "ECONOMY") as CabinClass;
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return { message: "Pick departure and destination from the list." };
  if (origin === destination) return { message: "Departure and destination must differ." };

  let searchId: string;
  try {
    const vx = await customerClient(); // binds the search to the signed-in customer, if any
    const search = await vx.flights.search(
      {
        mode: "simple",
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate,
        returnDate,
        adults: Number(form.get("adults") ?? 1),
        children: Number(form.get("children") ?? 0) || undefined,
        infants: Number(form.get("infants") ?? 0) || undefined,
        travelClass: CABINS.includes(cabin) ? cabin : "ECONOMY",
        nonStop: form.get("nonStop") === "on" || undefined,
        currencyCode: (await getStorefront()).defaultCurrency,
        resultOptions: { limit: 20, sort: "best", view: "summary" },
      },
      { timeoutMs: 60_000 },
    );
    searchId = search.id;
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
  redirect(`/flights/search?searchId=${encodeURIComponent(searchId)}`);
}

/** Re-run an expired search with its stored criteria. */
export async function searchAgainAction(searchId: string): Promise<void> {
  const vx = await customerClient();
  const old = await vx.flights.getSearch({ searchId });
  const fresh = await vx.flights.search(old.criteria.request, { timeoutMs: 60_000 });
  redirect(`/flights/search?searchId=${encodeURIComponent(fresh.id)}`);
}

export type ContinueState = FormState & { priceChange?: PriceChange };

/**
 * "Continue with this fare": confirm the price with Flight Offers Price (bags/services/fare rules included) and open a
 * checkout. A price move throws PRICE_CHANGED (the new priced offer is stored) → the customer confirms with
 * {@link acceptPriceAction}.
 */
export async function continueWithOfferAction(offerId: string, shownTotal: Money): Promise<ContinueState> {
  let checkoutId: string;
  try {
    const vx = await customerClient();
    const sf = await getStorefront();
    const priced = await vx.flights.price({
      offerIds: [offerId],
      include: [
        ...(sf.features.ancillaries ? (["bags", "other-services"] as const) : []),
        "detailed-fare-rules",
      ],
      fareRules: true,
      expectedTotal: shownTotal,
    });
    checkoutId = (await vx.checkout.create({ pricedOfferId: priced.id, prefillContactFromAccount: true })).id;
  } catch (e) {
    if (e instanceof PriceChangedError) {
      return { priceChange: { oldPrice: e.oldPrice, newPrice: e.newPrice, pricedOfferId: e.pricedOfferId } };
    }
    if (isVelexisError(e, "UNAUTHENTICATED")) redirect(`/account/sign-in?next=/flights/offers/${offerId}`); // guest checkout disabled
    return { ok: false, error: toActionError(e) };
  }
  redirect(`/checkout/${checkoutId}`);
}

/** Accept a changed price: open the checkout on the priced offer the server already stored. */
export async function acceptPriceAction(pricedOfferId: string): Promise<ContinueState> {
  let checkoutId: string;
  try {
    const vx = await customerClient();
    checkoutId = (await vx.checkout.create({ pricedOfferId, prefillContactFromAccount: true })).id;
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
  redirect(`/checkout/${checkoutId}`);
}

/** Fare rules drawer (server action so the call can bind to the customer; customer scope like every customer-client call). */
export async function loadFareRulesAction(pricedOfferId: string): Promise<ActionResult<{ refundable: boolean | null; changeable: boolean | null; notes: string[] }>> {
  try {
    const vx = await customerClient();
    const rules = await vx.flights.getFareRules({ pricedOfferId });
    return {
      ok: true,
      data: {
        refundable: rules.summary.refundable,
        changeable: rules.summary.changeable,
        notes: rules.categories.map(
          (c) =>
            `${c.category}: ${c.applicable ? "allowed" : "not allowed"}` +
            (c.maxPenalty ? ` (max penalty ${c.maxPenalty.amount} ${c.maxPenalty.currency})` : "") +
            (c.circumstances ? ` — ${c.circumstances}` : ""),
        ),
      },
    };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
