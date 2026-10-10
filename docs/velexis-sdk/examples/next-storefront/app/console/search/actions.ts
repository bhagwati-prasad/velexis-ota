"use server";

import { toActionError } from "@velexis/ota-sdk/next";
import type { ConsoleAmadeusFlightOffersResult, FlightAvailabilitySearchResult, PricedOffer, Schemas } from "@velexis/ota-sdk";
import { mustBeStaff, staffClient } from "@/lib/velexis";
import type { ActionResult } from "@/lib/action-state";

export interface AvailabilityInput {
  origin: string;
  destination: string;
  date: string;
  time?: string;
  adults: number;
  carriers?: string[];
  bookingClass?: string;
  includeClosedContent: boolean;
}

/** Amadeus-like availability screen: open booking classes and seats per class (`flights.availability`, staff token). */
export async function availabilityAction(input: AvailabilityInput): Promise<ActionResult<FlightAvailabilitySearchResult>> {
  await mustBeStaff({ roles: ["owner", "admin", "agent"] });
  try {
    const vx = await staffClient();
    const result = await vx.flights.availability(
      {
        query: {
          originDestinations: [
            { id: "1", originLocationCode: input.origin, destinationLocationCode: input.destination, departureDateTime: { date: input.date, time: input.time || undefined } },
          ],
          travelers: Array.from({ length: Math.max(1, input.adults) }, (_, i) => ({ id: String(i + 1), travelerType: "ADULT" as const })),
          sources: ["GDS"],
          searchCriteria: {
            includeClosedContent: input.includeClosedContent,
            class: input.bookingClass || undefined,
            flightFilters: input.carriers?.length ? { carrierRestrictions: { includedCarrierCodes: input.carriers } } : undefined,
          },
        },
      },
      { timeoutMs: 60_000 },
    );
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Raw Flight Offers Search GET — verbatim Amadeus offers with NET prices (never show them to customers). */
export async function rawOffersAction(params: { originLocationCode: string; destinationLocationCode: string; departureDate: string; returnDate?: string; adults: number; nonStop?: boolean; includedAirlineCodes?: string[]; max?: number }): Promise<ActionResult<ConsoleAmadeusFlightOffersResult>> {
  await mustBeStaff({ permissions: ["amadeus:read"] });
  try {
    const vx = await staffClient();
    return { ok: true, data: await vx.console.amadeus.getFlightOffers({ ...params, max: params.max ?? 20 }, { timeoutMs: 60_000 }) };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Price a raw Amadeus offer in console scope (`flights.price({ amadeusFlightOffers })`) → `prc_…` for an assisted booking. */
export async function priceRawOfferAction(offer: Schemas["AmadeusFlightOffer"]): Promise<ActionResult<Pick<PricedOffer, "id" | "price" | "netPrice" | "markup" | "lastTicketingDate" | "expiresAt">>> {
  await mustBeStaff({ permissions: ["amadeus:read", "bookings:write"] });
  try {
    const vx = await staffClient();
    const p = await vx.flights.price({ amadeusFlightOffers: [offer], include: ["bags", "detailed-fare-rules"], fareRules: true });
    return { ok: true, data: { id: p.id, price: p.price, netPrice: p.netPrice, markup: p.markup, lastTicketingDate: p.lastTicketingDate, expiresAt: p.expiresAt } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
