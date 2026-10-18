// The sort control of the results page (ota/frontend/docs/pages.md §4): a native `<select>` (search.html) with the
// five orders the storefront offers, mirrored in the query string as `sort=` (left out for the default, `best`).
// `best` is the API's score (price 60 %, duration 30 %, stops 10 %); the others are ascending orders of the selling
// total, the total journey time and the outbound departure and arrival times (FlightOfferSort).

/** @typedef {"best" | "price" | "duration" | "departure" | "arrival"} ResultSort */

/** The orders the storefront offers, in the order of the select. */
export const SORTS = /** @type {const} */ (["best", "price", "duration", "departure", "arrival"]);
/** The order without a `sort` parameter. */
export const DEFAULT_SORT = /** @type {ResultSort} */ ("best");

/**
 * A sort value when the storefront offers it, else the default.
 * @param {unknown} value
 * @returns {ResultSort}
 */
export const toSort = (value) =>
  SORTS.includes(/** @type {ResultSort} */ (value)) ? /** @type {ResultSort} */ (value) : DEFAULT_SORT;

/**
 * The sort of a query string (`sort=price`); unknown values give the default.
 * @param {URLSearchParams} params
 * @returns {ResultSort}
 */
export const readSort = (params) => toSort(params.get("sort"));

/**
 * The query-string value of a sort: `null` (no parameter) for the default.
 * @param {ResultSort} sort
 * @returns {string | null}
 */
export const sortParam = (sort) => (sort === DEFAULT_SORT ? null : sort);

/**
 * Mounts the sort select: shows `sort` and calls `onChange` with the chosen order. Returns `{ update, destroy }`.
 * @param {HTMLSelectElement} select
 * @param {{ sort?: ResultSort, onChange: (sort: ResultSort) => void }} props
 */
export function mount(select, { sort = DEFAULT_SORT, onChange }) {
  select.value = sort;
  const onSelect = () => onChange(toSort(select.value));
  select.addEventListener("change", onSelect);
  return {
    /** @param {{ sort: ResultSort }} next */
    update(next) {
      select.value = next.sort;
    },
    destroy() {
      select.removeEventListener("change", onSelect);
    },
  };
}
