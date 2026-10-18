// lib/url.js (ota/frontend/README.md §4, §10, OADR-0015 point 3): query helpers with comma lists, in-place query
// changes with history.replaceState, one-time parameters removed from the address bar, safe links, and `next`
// redirects that never leave the storefront.
import { afterEach, describe, expect, it } from "vitest";

import {
  currentPath,
  getList,
  getParam,
  hasUnsafeUrlCharacter,
  nextParam,
  replaceQuery,
  safeNext,
  safeUrl,
  takeParam,
  toQuery,
  withQuery,
} from "../src/lib/url.js";

afterEach(() => {
  history.replaceState(null, "", "/");
});

describe("query helpers", () => {
  it("[OFE-002 AC1] reads single parameters and comma or repeated lists", () => {
    const search = "?from=PAR&stops=0,1&carriers=AF&carriers=KL,%20LH&empty=";

    expect(getParam("from", search)).toBe("PAR");
    expect(getParam("missing", search)).toBeNull();
    expect(getList("stops", search)).toEqual(["0", "1"]);
    expect(getList("carriers", search)).toEqual(["AF", "KL", "LH"]);
    expect(getList("empty", search)).toEqual([]);
    expect(getList("stops", "?stops=0%2C1")).toEqual(["0", "1"]);
  });

  it("[OFE-002 AC1] reads the current page's query by default", () => {
    history.replaceState(null, "", "/search.html?search=srch_01&sort=price");

    expect(getParam("search")).toBe("srch_01");
    expect(currentPath()).toBe("/search.html?search=srch_01&sort=price");
  });

  it("[OFE-002 AC1] builds query strings with comma lists and without empty values", () => {
    expect(
      toQuery({
        from: "PAR",
        to: "NYC",
        stops: [0, 1],
        carriers: ["AF", "KL"],
        refundable: true,
        return: "",
        cursor: null,
        limit: undefined,
        none: [],
      }),
    ).toBe("from=PAR&to=NYC&stops=0,1&carriers=AF,KL&refundable=true");
    expect(toQuery({ q: "a b&c=d" })).toBe("q=a%20b%26c%3Dd");
    expect(withQuery("/search.html", { search: "srch_01" })).toBe("/search.html?search=srch_01");
    expect(withQuery("/search.html", { search: null })).toBe("/search.html");
  });

  it("[OFE-002 AC1] changes the query in place with replaceState, keeping the other parameters and the hash", () => {
    history.replaceState(null, "", "/search.html?from=PAR&to=NYC&cursor=abc#results");
    const before = history.length;

    const target = replaceQuery({ search: "srch_01", cursor: null, to: "JFK" });

    expect(target).toBe("/search.html?from=PAR&to=JFK&search=srch_01#results");
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(target);
    expect(history.length).toBe(before);
  });

  it("[OFE-002 AC1] keeps every value of a repeated parameter it was not asked to change", () => {
    history.replaceState(null, "", "/search.html?stops=0&sort=best&stops=1&carriers=AF&carriers=KL");

    expect(replaceQuery({ sort: "price", carriers: ["LH"] })).toBe(
      "/search.html?stops=0&sort=price&stops=1&carriers=LH",
    );
    expect(getList("stops")).toEqual(["0", "1"]);
    expect(getList("carriers")).toEqual(["LH"]);
  });

  it("[OFE-002 AC1] takes a one-time token out of the address bar", () => {
    history.replaceState(null, "", "/account/verify.html?token=vt_fake_example&lang=en");

    expect(takeParam("token")).toBe("vt_fake_example");
    expect(location.search).toBe("?lang=en");
    expect(takeParam("token")).toBeNull();
  });
});

describe("safe next", () => {
  it("[OFE-002 AC1] sends next=//evil.example to /", () => {
    expect(nextParam("?next=//evil.example")).toBe("/");
    expect(nextParam("?next=%2F%2Fevil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
  });

  it("[OFE-002 AC1] refuses every other way off the storefront", () => {
    for (const value of [
      "https://evil.example/",
      "http:evil.example",
      "javascript:alert(1)",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      // Dot segments that would normalise into a second leading slash.
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/%2E%2E//evil.example",
      " /bookings.html",
      "/bookings.html ",
      "evil.example",
      "bookings.html",
      "",
      `/${"a".repeat(2048)}`,
      null,
      undefined,
      42,
    ]) {
      expect(safeNext(value), JSON.stringify(value)).toBe("/");
    }
    expect(nextParam("")).toBe("/");
  });

  it("[OFE-002 AC1] keeps a path on this storefront with its query and fragment", () => {
    expect(safeNext("/booking.html?id=bkg_01#tickets")).toBe("/booking.html?id=bkg_01#tickets");
    expect(safeNext("/account/")).toBe("/account/");
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/account/../bookings.html")).toBe("/bookings.html");
    expect(nextParam("?next=%2Fbookings.html%3Ftab%3Dpast")).toBe("/bookings.html?tab=past");
  });
});

describe("safe links", () => {
  const LINK = ["https:", "mailto:", "tel:"];

  it("[OFE-002 AC1] accepts same-origin paths and the listed schemes only", () => {
    expect(safeUrl("/p/terms", LINK)).toBe("/p/terms");
    expect(safeUrl("#main", LINK)).toBe("#main");
    expect(safeUrl("?tab=past", LINK)).toBe("?tab=past");
    expect(safeUrl("https://help.example.com/a b", LINK)).toBeNull();
    expect(safeUrl("https://help.example.com/faq", LINK)).toBe("https://help.example.com/faq");
    expect(safeUrl("mailto:help@example.com", LINK)).toBe("mailto:help@example.com");
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,x",
      "//evil.example",
      "",
    ]) {
      expect(safeUrl(bad, LINK), bad).toBeNull();
    }
    expect(safeUrl("https://cdn.example.com/logo.png", [])).toBeNull();
  });

  it("[OFE-002 AC1] spots characters that URL parsers strip or reinterpret", () => {
    for (const text of ["a\tb", "a\nb", "a b", "a\\b", "a\u0000b", "a\u007fb", "a\u0085b"]) {
      expect(hasUnsafeUrlCharacter(text), JSON.stringify(text)).toBe(true);
    }
    expect(hasUnsafeUrlCharacter("/search.html?from=PAR&stops=0,1")).toBe(false);
  });
});
