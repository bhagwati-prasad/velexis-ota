// The pure helpers of support/ota.ts (OFE-008). The database and Redis helpers run in the storefront journey
// (specs/storefront/search.e2e.ts), against the stack's own database.
import { describe, expect, it } from "vitest";
import { customerScopeLeaks, DEMO_TENANT_SCHEMA, newTenantId, searchIdOf } from "../support/ota";
import { STOREFRONT_URL } from "../support/stack";

describe("searchIdOf", () => {
  it("reads the search id that the results page wrote into its address [OFE-008 AC1]", () => {
    expect(
      searchIdOf(`${STOREFRONT_URL}/search.html?from=MAD&search=srch_01M5XN79WJM4DFVFXWB7Z3SWS3&stops=0`),
    ).toBe("srch_01M5XN79WJM4DFVFXWB7Z3SWS3");
  });

  it("names the page, never the query string, when there is no valid id [OFE-008 AC1]", () => {
    expect(() => searchIdOf(`${STOREFRONT_URL}/search.html?from=MAD`)).toThrow(
      "the address /search.html has no search=srch_… id",
    );
    expect(() => searchIdOf(`${STOREFRONT_URL}/search.html?search=srch_x'--`)).toThrow(/has no search=srch_/);
  });
});

describe("newTenantId", () => {
  it("is ten_ and a ULID, as the platform writes tenant ids [OFE-008 AC1]", () => {
    const id = newTenantId();
    expect(id).toMatch(/^ten_0[0-9A-HJKMNP-TV-Z]{25}$/);
    expect(newTenantId()).not.toBe(id);
  });
});

describe("DEMO_TENANT_SCHEMA", () => {
  it("is the schema the OTA backend's dev:seed provisions [OFE-008 AC1]", () => {
    expect(DEMO_TENANT_SCHEMA).toBe("tenant_demo");
  });
});

describe("customerScopeLeaks", () => {
  it("finds net amounts, markups, margins, diagnostics and supplier details at any depth [OF-02 AC1]", () => {
    expect(
      customerScopeLeaks({
        data: [
          {
            price: { total: { amount: "98.47", currency: "EUR" } },
            netPrice: { amount: "90.00", currency: "EUR" },
          },
          { markup: { amount: "8.47" }, breakdown: { netBase: "80.00", NetTaxes: "10.00" } },
          { amadeus: { price: { grandTotal: "98.47", margins: [] } }, price: { total: { amount: "98.47" } } },
        ],
        meta: { diagnostics: { supplierMs: 120 } },
        error: { supplier: { code: "38189" }, supplierRequestId: "x" },
      }),
    ).toEqual([
      { pointer: "/data/0/netPrice", reason: "net_field" },
      { pointer: "/data/1/markup", reason: "console_only_field" },
      { pointer: "/data/1/breakdown/netBase", reason: "net_field" },
      { pointer: "/data/1/breakdown/NetTaxes", reason: "net_field" },
      { pointer: "/data/2/amadeus/price/margins", reason: "console_only_field" },
      { pointer: "/meta/diagnostics", reason: "console_only_field" },
      // `supplierMs` inside it is a `supplier*` key too: the walk names every one.
      { pointer: "/meta/diagnostics/supplierMs", reason: "console_only_field" },
      { pointer: "/error/supplier", reason: "console_only_field" },
      { pointer: "/error/supplierRequestId", reason: "console_only_field" },
    ]);
  });

  it("finds the verbatim Amadeus dictionaries, never another `amadeus` block [OF-02 AC1]", () => {
    expect(customerScopeLeaks({ dictionaries: { carriers: {}, amadeus: { locations: {} } } })).toEqual([
      { pointer: "/dictionaries/amadeus", reason: "console_only_field" },
    ]);
    expect(customerScopeLeaks({ amadeus: { id: "2" }, dictionaries: { carriers: {} } })).toEqual([]);
  });

  it("finds an embedded Amadeus offer that was not rewritten to the selling total [OF-02 AC1]", () => {
    const offer = (grandTotal: string) => ({
      price: { total: { amount: "98.47", currency: "EUR" } },
      amadeus: { price: { grandTotal } },
    });
    expect(customerScopeLeaks({ data: [offer("98.47")] })).toEqual([]);
    expect(customerScopeLeaks({ data: [offer("90.00")] })).toEqual([
      { pointer: "/data/0/amadeus/price/grandTotal", reason: "amadeus_price" },
    ]);
  });

  it("finds nothing in selling prices only, and escapes keys in its pointers [OF-02 AC1]", () => {
    expect(
      customerScopeLeaks({
        data: [{ price: { total: { amount: "98.47", currency: "EUR" } }, summary: { stops: 0 } }],
        meta: null,
      }),
    ).toEqual([]);
    expect(customerScopeLeaks(null)).toEqual([]);
    expect(customerScopeLeaks("netPrice")).toEqual([]);
    expect(customerScopeLeaks({ "a/b~c": { netPrice: null } })).toEqual([
      { pointer: "/a~1b~0c/netPrice", reason: "net_field" },
    ]);
  });
});
