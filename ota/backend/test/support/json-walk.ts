// Test support: a walk over a JSON answer and the customer-scope check built on it (OBE-026;
// ota/docs/flows/search-and-price.md §6, ota/docs/architecture.md §9, OADR-0005). Customer scope (the storefront
// edge, publishable keys, and secret keys without `X-Velexis-Scope: console`) sees selling amounts only: the OTA
// document marks net amounts, markups and the supplier's own details "Console scope only", and the verbatim Amadeus
// data that carries net amounts is rewritten to selling amounts before it leaves the API (offers.mapper.ts and
// priced-offers.mapper.ts).
//
//   const leaks = customerScopeLeaks(res.body, { netAmounts: ["92.15", "98.47"] });
//   expect(leaks).toEqual([]);   // each leak names its JSON pointer (RFC 6901) and what it is
//
// What counts as a leak:
//
//   net_field             a key `net*` (netPrice, netTotal, netBase, net, …), at any depth
//   console_only_field    a key the document keeps to console scope: `markup*` (OfferMarkup, markupRuleId),
//                         `margin*` (Amadeus `price.margins`, booking margins), `diagnostics`
//                         (FlightSearchDiagnostics), `supplier*` (the error envelope's SupplierIssue,
//                         supplierRequestId), and `amadeus` inside
//                         `dictionaries` (the verbatim Amadeus dictionaries)
//   net_amount            a string value equal to one of `netAmounts`: the supplier's own amounts (the net totals
//                         the tenant stored for its offers), which a rewritten Amadeus block never carries
//   amadeus_price         an object with a selling `price.total.amount` whose `amadeus.price.grandTotal` differs from
//                         it: the embedded Amadeus offer was not rewritten to the selling price
//
// The checks are deliberately stricter than the document (any key starting with `net`): a new field that trips them
// is either console data in the wrong scope or a name to reconsider.

/** One value of a JSON document, with where it is. */
export interface JsonEntry {
  /** RFC 6901 pointer of the value: `""` for the root, `/offers/0/price` below it. */
  readonly pointer: string;
  /** The property name or array index under which the value sits; `null` for the root. */
  readonly key: string | number | null;
  /** The `key` of the object or array that holds the value; `null` for the root and the root's own entries. */
  readonly parentKey: string | number | null;
  readonly value: unknown;
}

/** `segment` escaped for a JSON pointer (RFC 6901: `~` → `~0`, `/` → `~1`). */
function escapeSegment(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Calls `visit` for the root and for every value below it, depth first, in document order (object properties in their
 * insertion order, array items by index).
 */
export function walkJson(value: unknown, visit: (entry: JsonEntry) => void): void {
  const walk = (
    current: unknown,
    pointer: string,
    key: string | number | null,
    parentKey: string | number | null,
  ): void => {
    visit({ pointer, key, parentKey, value: current });
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${pointer}/${index}`, index, key));
    } else if (isObject(current)) {
      for (const [name, item] of Object.entries(current)) {
        walk(item, `${pointer}/${escapeSegment(name)}`, name, key);
      }
    }
  };
  walk(value, "", null, null);
}

/** The pointers of every value for which `predicate` holds. */
export function findInJson(value: unknown, predicate: (entry: JsonEntry) => boolean): string[] {
  const found: string[] = [];
  walkJson(value, (entry) => {
    if (predicate(entry)) {
      found.push(entry.pointer);
    }
  });
  return found;
}

/** Keys of net amounts. */
export const NET_FIELD = /^net/i;

/** Keys that only console scope may see (the file header). */
export const CONSOLE_ONLY_FIELD = /^(?:markup|margin|diagnostics$|supplier)/i;

/** Why a value must not be in a customer-scope answer. */
export type LeakReason = "net_field" | "console_only_field" | "net_amount" | "amadeus_price";

export interface JsonLeak {
  readonly pointer: string;
  readonly reason: LeakReason;
}

export interface CustomerScopeOptions {
  /** The supplier's net amounts that must not appear anywhere in the answer (decimal strings, `"92.15"`). */
  readonly netAmounts?: Iterable<string> | undefined;
}

/** `value.price.total.amount` and `value.amadeus.price.grandTotal` when both are strings. */
function sellingAndAmadeusTotal(value: unknown): { selling: string; amadeus: string } | undefined {
  if (!isObject(value) || !isObject(value["price"]) || !isObject(value["amadeus"])) {
    return undefined;
  }
  const total = value["price"]["total"];
  const amadeusPrice = value["amadeus"]["price"];
  const selling = isObject(total) ? total["amount"] : undefined;
  const amadeus = isObject(amadeusPrice) ? amadeusPrice["grandTotal"] : undefined;
  return typeof selling === "string" && typeof amadeus === "string" ? { selling, amadeus } : undefined;
}

/**
 * Every value of a customer-scope answer that customer scope must not see (the file header), in document order. An
 * empty list is a clean answer.
 */
export function customerScopeLeaks(value: unknown, options: CustomerScopeOptions = {}): JsonLeak[] {
  const netAmounts = new Set(options.netAmounts ?? []);
  const leaks: JsonLeak[] = [];
  walkJson(value, ({ pointer, key, parentKey, value: current }) => {
    if (typeof key === "string") {
      if (NET_FIELD.test(key)) {
        leaks.push({ pointer, reason: "net_field" });
      } else if (CONSOLE_ONLY_FIELD.test(key) || (key === "amadeus" && parentKey === "dictionaries")) {
        leaks.push({ pointer, reason: "console_only_field" });
      }
    }
    if (typeof current === "string" && netAmounts.has(current)) {
      leaks.push({ pointer, reason: "net_amount" });
    }
    const prices = sellingAndAmadeusTotal(current);
    if (prices !== undefined && prices.selling !== prices.amadeus) {
      leaks.push({ pointer: `${pointer}/amadeus/price/grandTotal`, reason: "amadeus_price" });
    }
  });
  return leaks;
}
