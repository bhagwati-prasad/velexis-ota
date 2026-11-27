// The neutral offer has the members of today's `ParsedOffer` (shopping/offers.mapper.ts), with the supplier offer
// reference in place of `amadeusId`, and the neutral priced offer builds on it (OBE-110). The mappers keep their types
// until OBE-118 and OBE-119, so these tests compare the two shapes member for member: `pnpm typecheck` checks the type
// assertions, and the runtime checks read the stub's recorded offers through today's readers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { APP_DIR } from "../../config";
import {
  parseOffer,
  type ParsedOffer,
  type SearchDefaults as MapperSearchDefaults,
  type SearchRequestProblem as MapperSearchRequestProblem,
} from "../../shopping/offers.mapper";
import {
  confirmedOffersOf,
  readPricingReply,
  type ConfirmedOffer,
  type PricingInputOffer,
  type PricingReply,
} from "../../shopping/priced-offers.mapper";
import type {
  NeutralConfirmedOffer,
  NeutralOffer,
  NeutralPricedOffer,
  NeutralPricingReply,
  PriceOffer,
  RequestedOffer,
  SearchDefaults,
  SearchRequestProblem,
} from "./index";

const FIXTURES = join(APP_DIR, "..", "..", "tools", "amadeus-stub", "fixtures");

/** The `body` of a recorded answer of the Amadeus stub. */
function recorded(path: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) as { body: Record<string, unknown> }).body;
}

/** Today's parsed offer as the neutral offer: the same members, with `amadeusId` as the reference. */
function neutralOf(parsed: ParsedOffer): NeutralOffer {
  const { amadeusId, ...members } = parsed;
  return { ...members, supplierOfferRef: amadeusId };
}

describe("the neutral offer", () => {
  it("replaces exactly one member of today's parsed offer, amadeusId, with the supplier offer reference", () => {
    expectTypeOf<Exclude<keyof ParsedOffer, keyof NeutralOffer>>().toEqualTypeOf<"amadeusId">();
    expectTypeOf<Exclude<keyof NeutralOffer, keyof ParsedOffer>>().toEqualTypeOf<"supplierOfferRef">();
    expectTypeOf<NeutralOffer["supplierOfferRef"]>().toEqualTypeOf<ParsedOffer["amadeusId"]>();
  });

  it("has every other member of today's parsed offer, with the same type", () => {
    expectTypeOf<Omit<NeutralOffer, "supplierOfferRef">>().toEqualTypeOf<Omit<ParsedOffer, "amadeusId">>();
  });

  it("holds every offer today's parser reads from a recorded search, the reference taking the old id", () => {
    const data = recorded("flight-offers-search/success.json")["data"] as unknown[];
    expect(data.length).toBeGreaterThan(0);
    for (const payload of data) {
      const parsed = parseOffer(payload);
      expect(parsed).toBeDefined();
      const neutral = neutralOf(parsed as ParsedOffer);
      expect(neutral.supplierOfferRef).toBe((payload as { id: string }).id);
      expect(Object.keys(neutral).sort()).toEqual(
        Object.keys(parsed as ParsedOffer)
          .filter((member) => member !== "amadeusId")
          .concat("supplierOfferRef")
          .sort(),
      );
    }
  });
});

describe("the neutral priced offer", () => {
  it("reads a pricing answer as today's reply, member for member", () => {
    expectTypeOf<NeutralPricingReply>().toEqualTypeOf<PricingReply>();
  });

  it("confirms an offer as today's confirmed offer, with the reference and the neutral offer", () => {
    expectTypeOf<
      Exclude<keyof ConfirmedOffer, keyof NeutralConfirmedOffer>
    >().toEqualTypeOf<"amadeusOfferId">();
    expectTypeOf<
      Exclude<keyof NeutralConfirmedOffer, keyof ConfirmedOffer>
    >().toEqualTypeOf<"supplierOfferRef">();
    expectTypeOf<Omit<NeutralConfirmedOffer, "supplierOfferRef" | "parsed">>().toEqualTypeOf<
      Omit<ConfirmedOffer, "amadeusOfferId" | "parsed">
    >();
    expectTypeOf<NeutralConfirmedOffer["parsed"]>().toEqualTypeOf<NeutralOffer>();
    expectTypeOf<NeutralPricedOffer["offers"]>().toEqualTypeOf<readonly NeutralConfirmedOffer[]>();
  });

  it("asks for the offers today's reader and pricing request take, with the reference", () => {
    expectTypeOf<Omit<RequestedOffer, "supplierOfferRef">>().toEqualTypeOf<
      Omit<Parameters<typeof confirmedOffersOf>[0][number], "amadeusOfferId">
    >();
    expectTypeOf<Omit<PriceOffer, "supplierOfferRef" | "currency">>().toEqualTypeOf<
      Omit<PricingInputOffer, "amadeusOfferId">
    >();
  });

  it("holds what today's readers confirm from a recorded pricing answer", () => {
    const reply: NeutralPricingReply = readPricingReply(recorded("flight-offers-price/success.json"));
    const requested = reply.flightOffers.map((payload, index) => {
      const parsed = parseOffer(payload) as ParsedOffer;
      return { id: `off_${index}`, amadeusOfferId: parsed.amadeusId, currency: parsed.price.currency };
    });
    expect(requested.length).toBeGreaterThan(0);
    const today = confirmedOffersOf(requested, reply.flightOffers, parseOffer);
    expect(today).toBeDefined();
    const offers = (today as ConfirmedOffer[]).map(
      ({ amadeusOfferId, parsed, ...members }): NeutralConfirmedOffer => ({
        ...members,
        supplierOfferRef: amadeusOfferId,
        parsed: neutralOf(parsed),
      }),
    );
    const priced: NeutralPricedOffer = { offers, reply };
    expect(priced.offers.map((offer) => offer.supplierOfferRef)).toEqual(
      requested.map((offer) => offer.amadeusOfferId),
    );
    expect(priced.offers.map((offer) => offer.payload)).toEqual(reply.flightOffers);
  });
});

describe("the search types", () => {
  it("take today's search defaults and request problems as they are", () => {
    expectTypeOf<SearchDefaults>().toEqualTypeOf<MapperSearchDefaults>();
    expectTypeOf<SearchRequestProblem>().toEqualTypeOf<MapperSearchRequestProblem>();
  });
});
