// Cursor pagination (ota/sdk/README.md §5.3, the contract's `Page<T>` in shared.d.ts). A list operation answers
// `{ data: T[], page: { nextCursor, limit }, ...extra }`; core.call (internal/client.js) wraps that body in a `Page`
// when the operation takes a `cursor` query parameter. `next()` calls the same operation with the same params and
// options and the next cursor; `for await (const item of page)` walks every item of this and all following pages,
// fetching each page only when the previous one is used up. Extra top-level fields of the body (`total`, `facets`,
// `totalCount`, `snapshot`, `warnings` …) are copied onto the page, so `FlightResultsPage` and the console pages keep
// them. The loader is a private field: `JSON.stringify(page)` gives the data, never a function.

/**
 * The page information of a list response.
 * @typedef {{ nextCursor: string | null, limit: number }} PageInfo
 */

/**
 * Loads the page that starts at a cursor.
 * @template T
 * @typedef {(cursor: string) => Promise<Page<T>>} PageLoader
 */

/**
 * One page of a cursor-paginated list.
 * @template T
 */
export class Page {
  /** @type {PageLoader<T>} */
  #load;

  /**
   * @param {{ data: T[], page: PageInfo } & Record<string, unknown>} body the list response
   * @param {PageLoader<T>} load loads the page at a cursor (the same operation, params and options)
   */
  constructor(body, load) {
    const { data, page, ...extra } = body;
    // Extra fields never replace a member of the page (`next`, the iterator).
    Object.assign(
      this,
      Object.fromEntries(Object.entries(extra).filter(([key]) => !(key in Page.prototype))),
    );
    /** The items of this page. @type {T[]} */
    this.data = data;
    /** The cursor of the next page (`null` on the last page) and the page size. @type {PageInfo} */
    this.page = { nextCursor: page.nextCursor ?? null, limit: page.limit };
    this.#load = load;
  }

  /**
   * Fetches the next page.
   * @returns {Promise<Page<T> | null>} the next page, or `null` when this is the last page
   */
  async next() {
    const cursor = this.page.nextCursor;
    return cursor === null ? null : this.#load(cursor);
  }

  /**
   * Iterates over every item of this and all following pages; the next page is fetched when this one is used up.
   * Breaking out of the loop stops fetching.
   * @returns {AsyncGenerator<T, void, undefined>}
   */
  async *[Symbol.asyncIterator]() {
    /** @type {Page<T> | null} */
    let current = this;
    while (current !== null) {
      yield* current.data;
      current = await current.next();
    }
  }
}

/**
 * Whether a response body is a page of a list: `{ data: [...], page: { nextCursor, limit } }`.
 * @param {unknown} body
 * @returns {body is { data: unknown[], page: PageInfo } & Record<string, unknown>}
 */
export function isPageBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const { data, page } = /** @type {Record<string, unknown>} */ (body);
  if (!Array.isArray(data) || page === null || typeof page !== "object") {
    return false;
  }
  const { nextCursor, limit } = /** @type {Record<string, unknown>} */ (page);
  return (nextCursor === null || typeof nextCursor === "string") && typeof limit === "number";
}
