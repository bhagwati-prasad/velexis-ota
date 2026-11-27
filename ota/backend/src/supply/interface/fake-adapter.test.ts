// The fake adapter (test/supply/fake-adapter.ts; OBE-110) implements the supplier interface, a test scripts its
// outcomes, delays, offers and capabilities and reads its calls, and no build ships it: the build's TypeScript
// configuration compiles `src` only, and no file that ships imports the test folder (multi-supplier plan §9.1,
// ADR-0025 item 7).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AppError } from "@velexis/errors";
import ts from "typescript";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  FAKE_CAPABILITIES,
  FAKE_SUPPLIER,
  FakeAdapter,
  fakeCallContext,
  fakeOffer,
  type FakePreparedSearch,
} from "../../../test/supply/fake-adapter";
import { APP_DIR } from "../../config";
import {
  PRICE_OUTCOMES,
  SEARCH_OUTCOMES,
  type NeutralConfirmedOffer,
  type NeutralPricingReply,
  type PriceQuery,
  type SearchQuery,
  type SupplierAdapter,
  type SupplierCapabilities,
} from "./index";

const QUERY: SearchQuery = {
  request: {
    mode: "simple",
    originLocationCode: "LHR",
    destinationLocationCode: "JFK",
    departureDate: "2027-03-01",
    adults: 1,
  } as SearchQuery["request"],
  currency: "EUR",
  defaults: { maxResults: 150 },
  scope: "customer",
};

/** Prepares QUERY on `adapter` and answers its prepared request. */
function prepared(adapter: FakeAdapter): FakePreparedSearch {
  const preparation = adapter.search.prepare(QUERY);
  if (preparation.kind !== "prepared") {
    throw new Error(`expected a prepared request, got ${preparation.kind}`);
  }
  return preparation.request;
}

/** A Price query for `offers` as the fake stored them. */
function priceQuery(adapter: FakeAdapter, offers = [fakeOffer()]): PriceQuery {
  return {
    offers: offers.map((offer, index) => ({
      id: `off_${index}`,
      supplierOfferRef: offer.supplierOfferRef,
      payload: adapter.payloadOf(offer),
      travelerIds: offer.travelerPricings.map((pricing) => pricing.travelerId),
      currency: offer.price.currency,
    })),
    body: {},
    include: [],
    forceClass: false,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the fake adapter", () => {
  it("implements the supplier interface", () => {
    expectTypeOf<FakeAdapter>().toExtend<SupplierAdapter<FakePreparedSearch>>();
    const adapter: SupplierAdapter<FakePreparedSearch> = new FakeAdapter();
    expect(adapter.supplier).toBe(FAKE_SUPPLIER);
    expect(adapter.readers.supplier).toBe(FAKE_SUPPLIER);
    expect(adapter.capabilities).toEqual(FAKE_CAPABILITIES);
  });

  it("answers the capabilities a test scripts, row by row", () => {
    const adapter = new FakeAdapter({ capabilities: { findOrder: "none" } });
    expect(adapter.capabilities.findOrder).toBe("none");
    const extras: SupplierCapabilities["extras"] = { bags: false, seats: false, afterBooking: false };
    adapter.scriptCapabilities({ extras });
    expect(adapter.capabilities).toEqual({ ...FAKE_CAPABILITIES, findOrder: "none", extras });
  });

  it("prepares purely: the same query gives the same answer, and a scripted skip or problem", () => {
    const adapter = new FakeAdapter();
    expect(adapter.search.prepare(QUERY)).toEqual(adapter.search.prepare(QUERY));
    expect(adapter.search.prepare(QUERY)).toEqual({ kind: "prepared", request: { query: QUERY } });
    adapter.scriptPrepare({ kind: "skipped", reason: "journeys" });
    expect(adapter.search.prepare(QUERY)).toEqual({ kind: "skipped", reason: "journeys" });
    const problem = { path: "/adults", code: "invalid", message: "Too many.", kind: "validation" } as const;
    adapter.scriptPrepare({ kind: "problem", problem });
    expect(adapter.search.prepare(QUERY)).toEqual({ kind: "problem", problem });
    expect(adapter.callsOf("search.prepare")).toHaveLength(5);
  });

  it.each(SEARCH_OUTCOMES.filter((outcome) => outcome !== "skipped"))(
    "answers a scripted Search outcome: %s",
    async (outcome) => {
      const adapter = new FakeAdapter();
      const offers = [fakeOffer(), fakeOffer()];
      adapter.scriptSearch(outcome === "ok" ? { outcome, offers, unreadable: 1 } : { outcome });
      const result = await adapter.search.send(fakeCallContext(), prepared(adapter));
      expect(result.outcome).toBe(outcome);
      if (result.outcome === "ok") {
        expect(result.offers.map(({ offer }) => offer.supplierOfferRef)).toEqual(
          offers.map((offer) => offer.supplierOfferRef),
        );
        expect(result.unreadable).toBe(1);
      } else if (result.outcome !== "empty") {
        expect(result.error).toBeInstanceOf(AppError);
      }
    },
  );

  it.each(PRICE_OUTCOMES)("answers a scripted Price outcome: %s", async (outcome) => {
    const adapter = new FakeAdapter();
    const error = new AppError("SUPPLIER_REJECTED", { message: "Scripted." });
    adapter.scriptPrice(outcome === "priced" ? { outcome } : { outcome, error });
    const result = await adapter.price.send(
      fakeCallContext({ operation: "flights.price" }),
      priceQuery(adapter),
    );
    expect(result.outcome).toBe(outcome);
    if (result.outcome !== "priced") {
      expect(result.error).toBe(error);
    }
  });

  it("uses scripted answers in order, then the default", async () => {
    const adapter = new FakeAdapter().scriptSearch(
      { outcome: "failed" },
      { outcome: "ok", offers: [fakeOffer()] },
    );
    const context = fakeCallContext();
    const outcomes = [];
    for (let call = 0; call < 3; call += 1) {
      outcomes.push((await adapter.search.send(context, prepared(adapter))).outcome);
    }
    expect(outcomes).toEqual(["failed", "ok", "empty"]);
  });

  it("answers after the scripted delay, on the global timers", async () => {
    vi.useFakeTimers();
    const adapter = new FakeAdapter().scriptSearch({ outcome: "ok", offers: [fakeOffer()], delayMs: 2000 });
    let settled = false;
    const answer = adapter.search.send(fakeCallContext(), prepared(adapter)).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await answer;
    expect(result.outcome).toBe("ok");
    expect(result.call?.durationMs).toBe(2000);
  });

  it("stops waiting when the deadline aborts the call: Search times out, Price is unavailable", async () => {
    vi.useFakeTimers();
    const adapter = new FakeAdapter()
      .scriptSearch({ outcome: "ok", offers: [fakeOffer()], delayMs: 5000 })
      .scriptPrice({ outcome: "priced", delayMs: 5000 });
    const deadline = new AbortController();
    const search = adapter.search.send(fakeCallContext({ signal: deadline.signal }), prepared(adapter));
    const price = adapter.price.send(fakeCallContext({ signal: deadline.signal }), priceQuery(adapter));
    await vi.advanceTimersByTimeAsync(1000);
    deadline.abort();
    const [searched, priced] = await Promise.all([search, price]);
    expect(searched).toMatchObject({ outcome: "timed_out", error: { code: "SUPPLIER_TIMEOUT" } });
    expect(priced).toMatchObject({ outcome: "unavailable", error: { code: "SUPPLIER_UNAVAILABLE" } });
    expect(
      adapter.calls.filter((call) => call.action !== "search.prepare").map((call) => call.aborted),
    ).toEqual([true, true]);
  });

  it("answers a call whose signal has already aborted without waiting", async () => {
    const adapter = new FakeAdapter().scriptSearch({ outcome: "ok", offers: [fakeOffer()], delayMs: 60_000 });
    const result = await adapter.search.send(
      fakeCallContext({ signal: AbortSignal.abort() }),
      prepared(adapter),
    );
    expect(result.outcome).toBe("timed_out");
  });

  it("stores its offers so that its readers read them back, and refuses another supplier's data", async () => {
    const adapter = new FakeAdapter();
    const other = new FakeAdapter({ supplier: "other-fake" });
    const offer = fakeOffer({ supplierOfferRef: "ref-1" });
    adapter.scriptSearch({ outcome: "ok", offers: [offer] });
    const result = await adapter.search.send(fakeCallContext(), prepared(adapter));
    if (result.outcome !== "ok") {
      throw new Error(`expected ok, got ${result.outcome}`);
    }
    const [stored] = result.offers;
    expect(adapter.readers.offer.readOffer(stored?.payload)).toEqual(offer);
    expect(other.readers.offer.readOffer(stored?.payload)).toBeUndefined();
    expect(adapter.readers.offer.readOffer({ supplier: FAKE_SUPPLIER })).toBeUndefined();
    expect(adapter.readers.offer.readOffer("not an offer")).toBeUndefined();
  });

  it("prices the offers asked, in order, and its readers read the stored answer again", async () => {
    const adapter = new FakeAdapter().scriptPrice({
      outcome: "priced",
      confirm: (offer) => ({ ...offer, price: { ...offer.price, total: "410.00", grandTotal: "410.00" } }),
      warnings: [{ title: "Price changed" }],
    });
    const offers = [fakeOffer(), fakeOffer()];
    const query = priceQuery(adapter, offers);
    const result = await adapter.price.send(fakeCallContext({ operation: "flights.price" }), query);
    if (result.outcome !== "priced") {
      throw new Error(`expected priced, got ${result.outcome}`);
    }
    expect(
      result.pricedOffer.offers.map(({ offerId, supplierOfferRef }) => ({ offerId, supplierOfferRef })),
    ).toEqual(query.offers.map(({ id, supplierOfferRef }) => ({ offerId: id, supplierOfferRef })));
    expect(result.pricedOffer.offers.map(({ parsed }) => parsed.price.total)).toEqual(["410.00", "410.00"]);
    const reply = adapter.readers.pricedOffer.readPricingReply(result.response);
    expect(reply.warnings).toEqual([{ title: "Price changed" }]);
    const requested = query.offers.map(({ id, supplierOfferRef, currency }) => ({
      id,
      supplierOfferRef,
      currency,
    }));
    expect(adapter.readers.pricedOffer.confirmedOffers(requested, reply)).toEqual(result.pricedOffer.offers);
    // Another currency, a missing offer, or another supplier's answer cannot be stored as a priced offer.
    expect(
      adapter.readers.pricedOffer.confirmedOffers(
        [{ ...(requested[0] as (typeof requested)[0]), currency: "USD" }],
        reply,
      ),
    ).toBeUndefined();
    expect(
      adapter.readers.pricedOffer.confirmedOffers(
        [{ id: "off_9", supplierOfferRef: "absent", currency: "EUR" }],
        reply,
      ),
    ).toBeUndefined();
    const foreign = new FakeAdapter({ supplier: "other-fake" }).readers.pricedOffer.readPricingReply(
      result.response,
    );
    expect(foreign.flightOffers).toEqual([]);
  });

  it("confirms the offers asked for whatever else the answer holds, but never an offer answered twice", () => {
    const adapter = new FakeAdapter();
    const [first, second] = [fakeOffer(), fakeOffer()];
    const requested = [first, second].map((offer, index) => ({
      id: `off_${index}`,
      supplierOfferRef: offer.supplierOfferRef,
      currency: offer.price.currency,
    }));
    const answer = (...payloads: unknown[]): NeutralPricingReply =>
      adapter.readers.pricedOffer.readPricingReply({ supplier: FAKE_SUPPLIER, flightOffers: payloads });
    const read = (reply: NeutralPricingReply): NeutralConfirmedOffer[] | undefined =>
      adapter.readers.pricedOffer.confirmedOffers(requested, reply);
    // An offer that was not asked for, even one the fake cannot read, does not stop the others.
    const extra = new FakeAdapter({ supplier: "other-fake" }).payloadOf(fakeOffer());
    expect(
      read(answer(extra, adapter.payloadOf(second), "not an offer", adapter.payloadOf(first)))?.map(
        ({ offerId, supplierOfferRef }) => ({ offerId, supplierOfferRef }),
      ),
    ).toEqual(requested.map(({ id, supplierOfferRef }) => ({ offerId: id, supplierOfferRef })));
    // A requested offer that is answered twice, or that the fake cannot read, cannot be stored as a priced offer.
    expect(
      read(answer(adapter.payloadOf(first), adapter.payloadOf(second), adapter.payloadOf(first))),
    ).toBeUndefined();
    expect(
      read(answer(adapter.payloadOf(first), new FakeAdapter({ supplier: "other-fake" }).payloadOf(second))),
    ).toBeUndefined();
  });

  it("refuses to price an offer that is not its own", async () => {
    const adapter = new FakeAdapter();
    const query = priceQuery(new FakeAdapter({ supplier: "other-fake" }));
    const result = await adapter.price.send(fakeCallContext(), query);
    expect(result).toMatchObject({ outcome: "refused", error: { code: "SUPPLIER_REJECTED" } });
  });

  it("records every call with its context, input and outcome", async () => {
    const adapter = new FakeAdapter().scriptSearch({ outcome: "empty" }).scriptPrice({ outcome: "sold_out" });
    const request = prepared(adapter);
    const searchContext = fakeCallContext({ searchId: "srch_1" });
    const priceContext = fakeCallContext({ operation: "flights.price" });
    const query = priceQuery(adapter);
    await adapter.search.send(searchContext, request);
    await adapter.price.send(priceContext, query);
    expect(adapter.calls).toEqual([
      { action: "search.prepare", query: QUERY },
      { action: "search.send", context: searchContext, request, outcome: "empty", aborted: false },
      { action: "price.send", context: priceContext, query, outcome: "sold_out", aborted: false },
    ]);
    expect(adapter.callsOf("price.send")).toHaveLength(1);
  });
});

describe("the build output", () => {
  /** The files the OTA backend's build compiles (`pnpm build`: `tsc -p tsconfig.build.json`). */
  function buildFiles(): string[] {
    const file = join(APP_DIR, "tsconfig.build.json");
    const parsed = ts.getParsedCommandLineOfConfigFile(file, undefined, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    });
    if (parsed === undefined) {
      throw new Error(`cannot read ${file}`);
    }
    expect(parsed.options.rootDir).toBe(join(APP_DIR, "src"));
    return parsed.fileNames.map((name) => relative(APP_DIR, name));
  }

  it("compiles src only, without the tests, so the fake adapter is in no build output", () => {
    const files = buildFiles();
    expect(files).toContain("src/supply/interface/index.ts");
    expect(files.filter((name) => !name.startsWith("src/"))).toEqual([]);
    expect(files.filter((name) => name.endsWith(".test.ts"))).toEqual([]);
    expect(files.filter((name) => name.includes("fake-adapter"))).toEqual([]);
  });

  it("no file that ships imports the test folder", () => {
    const testFolder = join(APP_DIR, "test");
    const importers = buildFiles().flatMap((name) => {
      const path = join(APP_DIR, name);
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false);
      return source.statements.flatMap((statement) => {
        const specifier =
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : undefined;
        return specifier?.startsWith(".") === true &&
          resolve(path, "..", specifier).startsWith(`${testFolder}/`)
          ? [`${name} → ${specifier}`]
          : [];
      });
    });
    expect(importers).toEqual([]);
    expect(readdirSync(join(testFolder, "supply"))).toContain("fake-adapter.ts");
  });
});
