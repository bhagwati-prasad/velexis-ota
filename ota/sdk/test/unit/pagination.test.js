// Cursor pagination (ota/sdk/README.md §5.3, the contract's `Page<T>`, task SDK-003): a list operation (one with a
// `cursor` query parameter) resolves with a Page whose `next()` and async iterator fetch the following pages with the
// same params and options, lazily, keeping the extra fields of each response.
import { describe, expect, it, vi } from "vitest";

import { createCore } from "../../src/internal/client.js";
import { isPageBody } from "../../src/internal/pagination.js";
import { op } from "../../src/internal/operations.js";
import { NotFoundError, Page } from "../../src/index.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

const PK = "pk_test_sdk003_fake";

/**
 * A list response body.
 * @param {unknown[]} data
 * @param {string | null} nextCursor
 * @param {Record<string, unknown>} [extra]
 */
const pageBody = (data, nextCursor, extra = {}) => ({ data, page: { nextCursor, limit: 2 }, ...extra });

/** @param {import("../helpers/fake-fetch.js").Answer[]} answers */
function setup(answers) {
  const fake = createFakeFetch(answers);
  const core = createCore({ publishableKey: PK, fetch: fake.fetch });
  return { fake, core };
}

describe("Page", () => {
  it("walks three pages with for await, sending the same params and options with each cursor [SDK-003 AC1]", async () => {
    const { fake, core } = setup([
      { body: pageBody([{ id: "bkg_1" }, { id: "bkg_2" }], "c2") },
      { body: pageBody([{ id: "bkg_3" }, { id: "bkg_4" }], "c3") },
      { body: pageBody([{ id: "bkg_5" }], null) },
    ]);

    /** @type {Page<{ id: string }>} */
    const page = await core.call(
      op.bookings_list,
      { timeframe: "upcoming", limit: 2 },
      { accessToken: "at_customer", headers: { "X-Trace": "list" } },
    );
    expect(fake.requests).toHaveLength(1);

    const ids = [];
    for await (const booking of page) {
      ids.push(booking.id);
    }

    expect(ids).toEqual(["bkg_1", "bkg_2", "bkg_3", "bkg_4", "bkg_5"]);
    expect(fake.requests.map((request) => request.searchParams.get("cursor"))).toEqual([null, "c2", "c3"]);
    for (const request of fake.requests) {
      expect(request.path).toBe("/v1/bookings");
      expect(request.searchParams.get("timeframe")).toBe("upcoming");
      expect(request.searchParams.get("limit")).toBe("2");
      expect(request.headers).toMatchObject({ authorization: "Bearer at_customer", "x-trace": "list" });
    }
    expect(fake.remaining).toBe(0);
  });

  it("has data and page, next() for the following page, and null after the last one [SDK-003 AC1]", async () => {
    const { fake, core } = setup([
      { body: pageBody([{ code: "ES" }, { code: "FR" }], "c2") },
      { body: pageBody([{ code: "IT" }], null) },
    ]);

    /** @type {Page<{ code: string }>} */
    const first = await core.call(op.reference_countries_list, { limit: 2 });
    expect(first).toBeInstanceOf(Page);
    expect(first.data).toEqual([{ code: "ES" }, { code: "FR" }]);
    expect(first.page).toEqual({ nextCursor: "c2", limit: 2 });

    const second = await first.next();
    expect(second).toBeInstanceOf(Page);
    expect(second?.data).toEqual([{ code: "IT" }]);
    expect(second?.page.nextCursor).toBeNull();
    expect(await second?.next()).toBeNull();
    expect(fake.requests).toHaveLength(2);
  });

  it("keeps the extra fields of each response and serialises to plain data [SDK-003 AC1]", async () => {
    const { core } = setup([
      {
        body: pageBody([{ id: "off_1" }], "c2", {
          searchId: "srch_1",
          total: 3,
          facets: { stops: [] },
          warnings: [{ title: "partial" }],
          next: "not a method",
        }),
      },
    ]);

    /** @type {any} */
    const page = await core.call(op.flights_listResults, { searchId: "srch_1" });

    expect(page).toMatchObject({
      searchId: "srch_1",
      total: 3,
      facets: { stops: [] },
      warnings: [{ title: "partial" }],
    });
    expect(typeof page.next).toBe("function");
    expect(JSON.parse(JSON.stringify(page))).toEqual({
      searchId: "srch_1",
      total: 3,
      facets: { stops: [] },
      warnings: [{ title: "partial" }],
      data: [{ id: "off_1" }],
      page: { nextCursor: "c2", limit: 2 },
    });
  });

  it("fetches lazily: breaking out of the loop fetches no further page [SDK-003 AC1]", async () => {
    const { fake, core } = setup([{ body: pageBody([1, 2], "c2") }, { body: pageBody([3, 4], "c3") }]);

    /** @type {Page<number>} */
    const page = await core.call(op.reference_currencies_list, {});
    const seen = [];
    for await (const item of page) {
      seen.push(item);
      if (item === 3) {
        break;
      }
    }

    expect(seen).toEqual([1, 2, 3]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.remaining).toBe(0);
  });

  it("rejects the iteration with the mapped error of a failing page [SDK-003 AC1]", async () => {
    const { core } = setup([{ body: pageBody(["a"], "c2") }, errorResponse(404, "NOT_FOUND")]);

    /** @type {Page<string>} */
    const page = await core.call(op.bookings_listEvents, { bookingId: "bkg_1" });
    const seen = [];
    const iterate = async () => {
      for await (const item of page) {
        seen.push(item);
      }
    };

    await expect(iterate()).rejects.toBeInstanceOf(NotFoundError);
    expect(seen).toEqual(["a"]);
  });

  it("is used only for list operations whose body is a page [SDK-003 AC1]", async () => {
    const { core } = setup([{ body: pageBody([1], null) }, { body: { data: [1, 2] } }]);

    expect(await core.call(op.storefront_get)).toEqual(pageBody([1], null));
    expect(await core.call(op.reference_airlines_list, {})).toEqual({ data: [1, 2] });
    expect(isPageBody(pageBody([], null))).toBe(true);
    expect(isPageBody({ data: [], page: { nextCursor: 3, limit: 2 } })).toBe(false);
    expect(isPageBody({ data: {}, page: { nextCursor: null, limit: 2 } })).toBe(false);
    expect(isPageBody([])).toBe(false);
    expect(isPageBody(null)).toBe(false);
  });

  it("can be built with any loader, which it calls with the next cursor [SDK-003 AC1]", async () => {
    const load = vi.fn(async (/** @type {string} */ cursor) => new Page(pageBody([cursor], null), load));
    const page = new Page(pageBody(["first"], "c2"), load);

    const items = [];
    for await (const item of page) {
      items.push(item);
    }

    expect(items).toEqual(["first", "c2"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("c2");
  });
});
