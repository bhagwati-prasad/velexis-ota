/**
 * @velexis/ota-sdk/react — optional React hooks for client components (React 18.3+ / 19, Next.js App Router).
 *
 * ```tsx
 * // app/providers.tsx
 * "use client";
 * import { VelexisProvider } from "@velexis/ota-sdk/react";
 * import { createBrowserClient } from "@velexis/ota-sdk/next";
 * const client = createBrowserClient();
 * export function Providers({ storefront, session, children }) {
 *   return <VelexisProvider client={client} storefront={storefront} session={session}>{children}</VelexisProvider>;
 * }
 * ```
 *
 * Rules
 * - Hooks run in client components only (`"use client"`). They never hold the secret key or refresh tokens: give the
 *   provider a browser client (publishable key + same-origin proxy, see `@velexis/ota-sdk/next` `createBrowserClient`).
 * - Every hook exposes `{ data, error, loading }`; `error` is a {@link VelexisError} (use `error.code`, `error.fieldErrors`,
 *   `instanceof PriceChangedError` …). Aborted requests (unmount, new input) are ignored, never surfaced as errors.
 * - Hooks fetch with `cache: "no-store"` semantics (the SDK default for priced / personal data). Server-rendered data
 *   can be handed in as `initial…` options so the first paint needs no client request. Pass **plain data** across the
 *   server → client boundary: SDK `Page` objects carry methods — convert them with `toPageData()` (re-exported by
 *   `@velexis/ota-sdk/next` as `serializePage`) / `toResultsPageData()`; server actions return errors as
 *   {@link VelexisErrorData} (`toActionError()`), rebuilt with {@link fromErrorData}. Customer / anonymous server
 *   clients receive customer scope, so their results need no further redaction.
 * - Nothing here caches across components except the provider's storefront/session snapshot.
 */
import type { ReactNode, JSX } from "react";
import type { VelexisClient } from "./index";
import type { Schemas, RequestOptions, Money, Page, VelexisError, ErrorCode } from "./shared";
import type { LocationSubType } from "./identity";
import type {
  FlightSearch,
  FlightSearchParams,
  FlightSearchStatus,
  FlightOffer,
  FlightResultFilters,
  FlightResultsPage,
  FlightOfferSort,
  FlightOfferView,
  FlightFacets,
  FlightDictionaries,
  UpsellResult,
  FlightUpsellParams,
  FlightPriceParams,
  PricedOffer,
  AncillaryCatalogue,
  AncillaryOption,
  AncillarySelection,
  FareRuleSet,
} from "./flights";
import type {
  Checkout,
  TravelerInput,
  ContactInput,
  RemarkInput,
  Payment,
  CreateCheckoutPaymentParams,
  PaymentCardHint,
  CheckoutCompletion,
  CompleteCheckoutParams,
  Booking,
  BookingSummary,
  BookingListTimeframe,
  BookingListSort,
  UpdateBookingParams,
  CancelBookingParams,
  CancellationQuote,
  CancellationResult,
  BookingDocument,
  BookingTicketingStatus,
} from "./bookings";

/* ------------------------------------------------------------------------------------------------------------ */
/* Plain (serialisable) data shapes                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/** A {@link Page} without its methods — safe to pass from a server component to a client component. */
export interface PageData<T> {
  data: T[];
  page: { nextCursor: string | null; limit: number };
}

/** A {@link FlightResultsPage} without its methods (serialisable). */
export type FlightResultsPageData = Omit<FlightResultsPage, "next" | typeof Symbol.asyncIterator>;

/** Strip the methods of an SDK page so it can cross the RSC boundary (`initialPage` props, server action results). */
export declare function toPageData<T>(page: Page<T> | PageData<T>): PageData<T>;
/** Strip the methods of a flight results page (keeps facets, dictionaries, total, expiresAt, warnings). */
export declare function toResultsPageData(page: FlightResultsPage | FlightResultsPageData): FlightResultsPageData;

/**
 * A {@link VelexisError} flattened to plain data — what a server action returns instead of throwing
 * (class instances do not survive the server action boundary). `@velexis/ota-sdk/next` `toActionError()` produces it.
 */
export interface VelexisErrorData {
  /** Error class name (`"PriceChangedError"`, `"ValidationError"`, `"VelexisError"` …). */
  name: string;
  /** Public error code (the API's `x-error-catalogue`) or a client-side code. */
  code: ErrorCode | "NETWORK_ERROR" | "TIMEOUT" | "ABORTED";
  /** Localised message from the API (safe to show); `INTERNAL_ERROR` for non-SDK errors. */
  message: string;
  /** HTTP status (0 for client-side failures). */
  status: number;
  requestId: string | null;
  fieldErrors: Schemas["FieldError"][];
  /**
   * Code-specific details (`newPrice`, `pricedOfferId`, `bookingId`, `lockedUntil`, `retryAfterSeconds` …). Never
   * contains a guest booking token: `toActionError()` and the proxy remove `bookingToken` / `bookingTokenExpiresAt`
   * (they are stored in the httpOnly `vx_bt_<bookingId>` cookie instead).
   */
  details?: Record<string, unknown>;
  retryable: boolean;
}

/**
 * Re-create a typed SDK error from {@link VelexisErrorData} in a client component, by the classes of `@velexis/ota-sdk`:
 * 400 / 422 → `ValidationError`, 401 → `AuthenticationError`, 402 → `PaymentError`, 403 → `PermissionError`,
 * 404 → `NotFoundError`, 409 → `ConflictError` (`PRICE_CHANGED` → `PriceChangedError`, `SOLD_OUT` → `SoldOutError`),
 * 410 → `ExpiredError`, 429 → `RateLimitError`, 424 / 502 / 504 and `SUPPLIER_UNAVAILABLE` → `SupplierError`,
 * 500 / other 503 → `ServerError`, status 0 → `ConnectionError`. Codes without a dedicated class — `412
 * PRECONDITION_FAILED`, `423 ACCOUNT_LOCKED` — become a plain `VelexisError` (match on `code`).
 */
export declare function fromErrorData(data: VelexisErrorData): VelexisError;

/* ------------------------------------------------------------------------------------------------------------ */
/* Client shape the hooks need                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Customer session operations of a **cookie-session** client (the browser client of `@velexis/ota-sdk/next` implements it
 * by calling your `/api/auth/[action]` route handlers): tokens are set as httpOnly cookies by the server, so these
 * methods never return them.
 */
export interface VelexisSessionAuth {
  /** Sign in (route handler `POST /api/auth/sign-in`). @throws AuthenticationError `INVALID_CREDENTIALS`, PermissionError `EMAIL_NOT_VERIFIED`, VelexisError `ACCOUNT_LOCKED`, RateLimitError. */
  signIn(params: Schemas["SignInRequest"], options?: RequestOptions): Promise<{ customer: Schemas["Customer"] }>;
  /** Sign up (route handler `POST /api/auth/sign-up`). `signedIn` is false when the OTA requires email verification first. */
  signUp(
    params: Schemas["SignUpRequest"],
    options?: RequestOptions,
  ): Promise<{ customer: Schemas["Customer"]; signedIn: boolean; emailVerification: Schemas["EmailVerificationStatus"] }>;
  /** Sign out (route handler `POST /api/auth/sign-out`; clears the cookies even when the API call fails). */
  signOut(params?: { scope?: "current" | "all" }, options?: RequestOptions): Promise<void>;
  /** Current customer + session metadata, or `null` when signed out (proxied `GET /v1/auth/session`). */
  getSession(options?: RequestOptions): Promise<Schemas["AuthSessionInfo"] | null>;
}

/**
 * The client the hooks work with: the customer-scope namespaces of {@link VelexisClient} plus a cookie-session `auth`.
 * `createBrowserClient()` of `@velexis/ota-sdk/next` returns a compatible object. A plain `createVelexisClient({ publishableKey })`
 * works for every hook except {@link useSession} / {@link useAuth} (wrap its `auth` in your own {@link VelexisSessionAuth}).
 */
export type VelexisReactClient = Pick<VelexisClient, "storefront" | "reference" | "flights" | "checkout" | "bookings" | "account"> & {
  readonly auth: VelexisSessionAuth;
};

/* ------------------------------------------------------------------------------------------------------------ */
/* Provider                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** Props of {@link VelexisProvider}. */
export interface VelexisProviderProps {
  /** Browser client (never a secret-key client). Create it once at module level, not inside a component. */
  client: VelexisReactClient;
  /** Storefront config fetched on the server (root layout, cached with ISR) — avoids a client round trip. */
  storefront?: Schemas["StorefrontConfig"];
  /** Session fetched on the server (`getSession()` of `@velexis/ota-sdk/next`): `null` = signed out, omitted = unknown (fetched lazily). */
  session?: Schemas["AuthSessionInfo"] | null;
  /** Default locale / currency for hook calls (e.g. from the `vx_locale` / `vx_currency` cookies). */
  locale?: string;
  currency?: string;
  /** Called for every error surfaced by a hook (logging, toasts). */
  onError?: (error: VelexisError) => void;
  children?: ReactNode;
}

/** Makes a Velexis client, the storefront config and the session available to the hooks below. Client component. */
export declare function VelexisProvider(props: VelexisProviderProps): JSX.Element;

/** The client given to {@link VelexisProvider}. Throws when used outside the provider. */
export declare function useVelexis(): VelexisReactClient;

/* ------------------------------------------------------------------------------------------------------------ */
/* Common state shapes                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** State of a read hook. */
export interface AsyncState<T> {
  /** Last successful result (kept while re-loading). */
  data: T | undefined;
  /** Last error (cleared on the next successful load); `ABORTED` is never reported. */
  error: VelexisError | undefined;
  /** True while a request is in flight. */
  loading: boolean;
  /** Re-run the request. */
  reload(): Promise<void>;
}

/** State of a mutation. */
export interface MutationState {
  /** True while the mutation runs. */
  pending: boolean;
  /** Last mutation error. */
  error: VelexisError | undefined;
  /** `fieldErrors` of the last `ValidationError` (`TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `VALIDATION_FAILED` …), keyed by JSON pointer. */
  fieldErrors: Record<string, Schemas["FieldError"]>;
  /** Clear `error` / `fieldErrors`. */
  reset(): void;
}

/** A price change surfaced by `PriceChangedError` (pricing, ancillaries, payment, completion). */
export interface PriceChangeNotice {
  oldPrice: Money | undefined;
  newPrice: Money | undefined;
  /** New priced offer the server already stored (`details.pricedOfferId`). */
  pricedOfferId: string | undefined;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Storefront & session                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** Result of {@link useStorefront}. */
export interface UseStorefrontResult extends AsyncState<Schemas["StorefrontConfig"]> {
  /** Shortcut for `data?.features` (all false until loaded). */
  features: Schemas["StorefrontFeatures"];
  /** Format money with the currency's decimals (from the storefront currencies, fallback 2) and the active locale. */
  formatMoney(money: Money | null | undefined): string;
}

/** Storefront config from the provider (or `storefront.get` on first use). */
export declare function useStorefront(): UseStorefrontResult;

/** Result of {@link useSession}. */
export interface UseSessionResult {
  /** `undefined` while unknown, `null` when signed out. */
  session: Schemas["AuthSessionInfo"] | null | undefined;
  customer: Schemas["Customer"] | null | undefined;
  status: "loading" | "authenticated" | "unauthenticated";
  error: VelexisError | undefined;
  /** Re-read the session (after sign-in in another tab, after a server action changed it). */
  refresh(): Promise<void>;
}

/** The signed-in customer (provider snapshot, refreshed through `client.auth.getSession()`). */
export declare function useSession(): UseSessionResult;

/** Result of {@link useAuth}. */
export interface UseAuthResult extends MutationState {
  /** Sign in; updates {@link useSession} on success. */
  signIn(params: Schemas["SignInRequest"]): Promise<{ customer: Schemas["Customer"] }>;
  /** Sign up; signs in when the OTA does not require verification first. */
  signUp(params: Schemas["SignUpRequest"]): ReturnType<VelexisSessionAuth["signUp"]>;
  /** Sign out (current session or all). */
  signOut(scope?: "current" | "all"): Promise<void>;
}

/** Sign-in / sign-up / sign-out with state; tokens stay in httpOnly cookies. */
export declare function useAuth(): UseAuthResult;

/* ------------------------------------------------------------------------------------------------------------ */
/* Search form                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** Options of {@link useLocationSearch}. */
export interface UseLocationSearchOptions {
  /** Debounce in ms (default 200). */
  debounceMs?: number;
  /** Minimum keyword length before searching (default 2, the API minimum). */
  minLength?: number;
  /** Max suggestions (default 8). */
  limit?: number;
  /** Restrict to airports and/or cities. */
  subType?: LocationSubType[];
  /** Restrict to one country. */
  countryCode?: string;
}

/** Result of {@link useLocationSearch}. */
export interface UseLocationSearchResult extends AsyncState<Schemas["Location"][]> {
  /** Suggestions (empty below `minLength`). */
  locations: Schemas["Location"][];
}

/**
 * Debounced airport/city autocomplete (`reference.locations.search`). Cancels stale requests with an `AbortSignal`.
 * Public data: works with the publishable key directly against the API.
 */
export declare function useLocationSearch(keyword: string, options?: UseLocationSearchOptions): UseLocationSearchResult;

/* ------------------------------------------------------------------------------------------------------------ */
/* Results                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** Options of {@link useFlightSearch}. */
export interface UseFlightSearchOptions {
  /** Existing search (`srch_…`), e.g. from the URL. */
  searchId?: string;
  /** The search as created on the server (avoids a `getSearch` round trip). */
  initialSearch?: FlightSearch;
  /** First results page rendered on the server ({@link toResultsPageData}). */
  initialPage?: FlightResultsPageData;
  /** Initial filters (e.g. parsed from the URL). */
  filters?: FlightResultFilters;
  /** Initial sort (default `best`). */
  sort?: FlightOfferSort;
  /** Page size (default 20). */
  limit?: number;
  /** `summary` (default) or `full`. */
  view?: FlightOfferView;
  /** Debounce filter changes in ms before re-querying (default 250). */
  filterDebounceMs?: number;
  /**
   * Re-check a completed search every N ms (`flights.getSearch`) and flip `expired` when the server reports
   * `status: "expired"` or `expiresAt` passes (default 60 000; 0 disables). A `pending` search (created with
   * `resultOptions: { async: true }`) is always polled every `retryAfterSeconds` (min 1 s) until `completed` — then the
   * first results page loads — or `failed` (`error` = the search's `error`).
   */
  pollIntervalMs?: number;
  /** Called when filters/sort change (e.g. to mirror them into the URL with `router.replace`). */
  onQueryChange?: (query: { filters: FlightResultFilters; sort: FlightOfferSort }) => void;
}

/** Result of {@link useFlightSearch}. */
export interface UseFlightSearchResult {
  search: FlightSearch | undefined;
  /** `search.status`: `pending` (async search running), `completed`, `failed`, `expired`. */
  status: FlightSearchStatus | undefined;
  /** True while an asynchronous search is still running at Amadeus (`status === "pending"`). */
  pending: boolean;
  /** Offers loaded so far (first page + `loadMore` pages) for the current filters/sort. */
  offers: FlightOffer[];
  /** Offers matching the current filters. */
  total: number;
  facets: FlightFacets | undefined;
  dictionaries: FlightDictionaries | undefined;
  warnings: Schemas["Warning"][];
  filters: FlightResultFilters;
  sort: FlightOfferSort;
  /** Replace or merge filters (`merge` default true); drops the cursor and reloads page 1. */
  setFilters(filters: FlightResultFilters, merge?: boolean): void;
  /** Change the sort; drops the cursor and reloads page 1. */
  setSort(sort: FlightOfferSort): void;
  /** Clear all filters. */
  clearFilters(): void;
  /** Load the next page (no-op when `hasMore` is false). */
  loadMore(): Promise<void>;
  hasMore: boolean;
  /**
   * Create a new search (`flights.search`) and load its first page: synchronous by default (up to 60 s), or pass
   * `resultOptions: { async: true }` to return at once and poll while `pending`.
   */
  create(params: FlightSearchParams, options?: RequestOptions): Promise<FlightSearch>;
  /** True while `create` runs. */
  searching: boolean;
  /** True while a results page loads. */
  loading: boolean;
  /** True when the offers expired (`SEARCH_EXPIRED` or `expiresAt` passed) — offer "search again" with `search.criteria.request`. */
  expired: boolean;
  error: VelexisError | undefined;
}

/**
 * Create a search and browse its results with server-side filters (several departure / arrival windows per itinerary
 * are ORed), sort, facets and cursor pagination (`flights.search` + `flights.getSearch` + `flights.listResults`).
 */
export declare function useFlightSearch(options?: UseFlightSearchOptions): UseFlightSearchResult;

/* ------------------------------------------------------------------------------------------------------------ */
/* Offer, upsell, pricing, ancillaries                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** One offer in full view (`flights.getOffer`); `error.code === "OFFER_EXPIRED"` → search again. */
export declare function useOffer(offerId: string | null | undefined, options?: { initial?: FlightOffer }): AsyncState<FlightOffer>;

/** Options of {@link useUpsell}. */
export interface UseUpsellOptions extends Omit<FlightUpsellParams, "offerId"> {
  /** Load immediately (default true); with false call `load()` (e.g. when the fare-family drawer opens). */
  enabled?: boolean;
  initial?: UpsellResult;
}

/** Result of {@link useUpsell}. */
export interface UseUpsellResult extends AsyncState<UpsellResult> {
  /** Load (or re-load) the fare families. */
  load(): Promise<UpsellResult | undefined>;
  /** Currently selected fare-family offer (defaults to the base offer). */
  selectedOfferId: string | undefined;
  select(offerId: string): void;
}

/** Branded-fare upsell (`flights.upsell`) with a selected fare family. Empty `offers` = the airline publishes none. */
export declare function useUpsell(offerId: string | null | undefined, options?: UseUpsellOptions): UseUpsellResult;

/** Result of {@link usePricing}. */
export interface UsePricingResult extends MutationState {
  /** Last priced offer. */
  pricedOffer: PricedOffer | undefined;
  /** Price (or re-price) offers (`flights.price`). A `PriceChangedError` is caught and exposed as `priceChange`. */
  price(params: FlightPriceParams, options?: RequestOptions): Promise<PricedOffer | undefined>;
  /** Set when `expectedTotal` differed from the confirmed total. */
  priceChange: PriceChangeNotice | null;
  /** Accept the new price: loads the stored priced offer (`flights.getPricedOffer`) and clears `priceChange`. */
  acceptPriceChange(): Promise<PricedOffer | undefined>;
  /** Fare rules of the priced offer (`flights.getFareRules`), loaded on demand. */
  loadFareRules(): Promise<FareRuleSet | undefined>;
  fareRules: FareRuleSet | undefined;
}

/** Pricing with price-change handling. Prefer a server action for the final price before checkout. */
export declare function usePricing(options?: { initial?: PricedOffer }): UsePricingResult;

/** Selection key helpers of {@link useAncillaries}. */
export interface AncillaryChoice {
  option: AncillaryOption;
  travelerId: string;
  /** Required when `option.requiresSeatNumber`. */
  seatNumber?: string;
  quantity?: number;
}

/** Result of {@link useAncillaries}. */
export interface UseAncillariesResult extends AsyncState<AncillaryCatalogue> {
  /** Current selections as sent to `checkout.setAncillaries` / `flights.price({ additionalServices })`. */
  selections: AncillarySelection[];
  /** Add or replace the selection for (option, traveller). */
  select(choice: AncillaryChoice): void;
  /** Remove the selection for (option, traveller). */
  remove(optionId: string, travelerId: string): void;
  clear(): void;
  isSelected(optionId: string, travelerId: string): boolean;
  /** Options per traveller and kind (seats only when `catalogue.seatsSupported`). */
  optionsFor(travelerId: string): { checkedBags: AncillaryOption[]; cabinBags: AncillaryOption[]; otherServices: AncillaryOption[]; seats: AncillaryOption[] };
  /** Sum of the selected option prices (display only — the confirmed amount comes from re-pricing). */
  estimatedTotal: Money | null;
}

/** Ancillary catalogue of a priced offer (`flights.getAncillaries`) + local selection state. */
export declare function useAncillaries(
  pricedOfferId: string | null | undefined,
  options?: { initial?: AncillaryCatalogue; initialSelections?: AncillarySelection[] },
): UseAncillariesResult;

/* ------------------------------------------------------------------------------------------------------------ */
/* Checkout                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** Outcome of {@link UseCheckoutResult.complete}. */
export type CheckoutCompletionOutcome =
  /** Booked (tickets issued or pending per the OTA's ticketing policy). Guest tokens are never included (cookie only). */
  | { status: "booked"; completion: CheckoutCompletion }
  /**
   * `SUPPLIER_TIMEOUT`: a pending booking exists — show it and poll `useTicketingStatus`; never complete again. Guests
   * can poll because the guest token of the pending booking (`error.details.bookingToken` upstream) was stored in the
   * httpOnly `vx_bt_<bookingId>` cookie — by the proxy on the default path, by `completeCheckout()` /
   * `captureBookingToken()` on the server-action path. It is never part of `error.details` here.
   */
  | { status: "pending"; bookingId: string; error: VelexisError }
  /** `CHECKOUT_ALREADY_COMPLETED` (e.g. a second tab): go to the booking. */
  | { status: "already_completed"; bookingId: string; error: VelexisError }
  /** `PRICE_CHANGED`: the authorisation was voided and the checkout moved to the new price — pay again. */
  | { status: "price_changed"; priceChange: PriceChangeNotice; error: VelexisError }
  /** Any other error (`SOLD_OUT`, `PAYMENT_DECLINED`, `CHECKOUT_INCOMPLETE`, validation …). */
  | { status: "failed"; error: VelexisError };

/** Options of {@link useCheckout}. */
export interface UseCheckoutOptions {
  /** Checkout rendered on the server. */
  initial?: Checkout;
  /**
   * How to complete the checkout. Default: `client.checkout.complete` through the same-origin proxy, which moves a
   * guest `bookingToken` — of the new booking, and of the pending booking after `504 SUPPLIER_TIMEOUT` — into its
   * httpOnly cookie, so the `pending` outcome can be polled. Or pass a server action to keep completion fully
   * server-side: a server action returning `completeCheckout(params, { config })` of `@velexis/ota-sdk/next` stores those
   * tokens the same way (a hand-written action must call `captureBookingToken()` for both cases).
   */
  completeAction?: (params: CompleteCheckoutParams) => Promise<CheckoutCompletion | { error: VelexisErrorData }>;
  /** Stable idempotency key per completion attempt (default `complete-<checkoutId>-<paymentId>`). */
  completionKey?: (params: CompleteCheckoutParams) => string;
}

/** Result of {@link useCheckout}. */
export interface UseCheckoutResult extends MutationState {
  checkout: Checkout | undefined;
  loading: boolean;
  /** Re-read the checkout (`checkout.get`). */
  refresh(): Promise<void>;
  /** `checkout.setTravelers` with `ifMatch = checkout.version`. */
  setTravelers(travelers: TravelerInput[]): Promise<Checkout | undefined>;
  /** `checkout.setContacts`. */
  setContacts(contacts: ContactInput[]): Promise<Checkout | undefined>;
  /** `checkout.setAncillaries` (re-prices with Amadeus); `expectedTotal` defaults to the displayed total. */
  setAncillaries(selections: AncillarySelection[], expectedTotal?: Money): Promise<Checkout | undefined>;
  /** `checkout.setRemarks`. */
  setRemarks(remarks: RemarkInput[]): Promise<Checkout | undefined>;
  /** `checkout.createPayment` (feed `clientSecret` / `providerPublicKey` to the PSP SDK, or follow `redirectUrl`). */
  createPayment(params: Omit<CreateCheckoutPaymentParams, "checkoutId">, options?: RequestOptions): Promise<Payment | undefined>;
  /**
   * `checkout.updatePayment`: set / replace the card brand (+ BIN) of a payment still in `requires_payment_method` (e.g.
   * from the PSP card element's brand event) and re-quote the card fee; updates `checkout.totals.cardFee` / `total`.
   * `PRICE_CHANGED` → `priceChange` (the payment was cancelled: create a new one); `PAYMENT_NOT_UPDATABLE` → create a new payment.
   */
  updatePayment(paymentId: string, card: PaymentCardHint, expectedTotal?: Money): Promise<Payment | undefined>;
  /** Poll `checkout.getPayment` until `authorized` / `captured` / `failed` / `cancelled` (default every 2 s, max 120 s). */
  waitForPayment(paymentId: string, options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Payment>;
  /**
   * Complete (books and issues). Resolves with an explicit outcome instead of throwing, because some failures must
   * never lead to a second attempt: `pending` (`SUPPLIER_TIMEOUT` — the order may exist; poll the booking) and
   * `already_completed` (`CHECKOUT_ALREADY_COMPLETED`). The error is also exposed as `error`.
   */
  complete(params?: Omit<CompleteCheckoutParams, "checkoutId">): Promise<CheckoutCompletionOutcome>;
  /** Set by `PriceChangedError` from `setAncillaries`, `createPayment`, `updatePayment` or `complete`. */
  priceChange: PriceChangeNotice | null;
  /** `checkout.progress.missing` as a map (JSON pointer → field error) for form hints. */
  missing: Record<string, Schemas["FieldError"]>;
}

/** Drive a checkout from client components (travellers, contacts, extras, payment, completion). */
export declare function useCheckout(checkoutId: string, options?: UseCheckoutOptions): UseCheckoutResult;

/* ------------------------------------------------------------------------------------------------------------ */
/* Bookings                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** Options of {@link useBookings}. */
export interface UseBookingsOptions {
  limit?: number;
  sort?: BookingListSort;
  departureFrom?: string;
  departureTo?: string;
  /** Booked at or after this instant (ISO-8601). */
  createdFrom?: string;
  /** Booked before this instant (ISO-8601, exclusive). */
  createdTo?: string;
  /** First page rendered on the server ({@link toPageData}). */
  initialPage?: PageData<BookingSummary>;
}

/** Result of {@link useBookings}. */
export interface UseBookingsResult extends AsyncState<BookingSummary[]> {
  bookings: BookingSummary[];
  hasMore: boolean;
  loadMore(): Promise<void>;
}

/** "My trips" for one tab (`bookings.list({ timeframe })`, customer session required). */
export declare function useBookings(timeframe: BookingListTimeframe, options?: UseBookingsOptions): UseBookingsResult;

/** Options of {@link useBooking}. */
export interface UseBookingOptions {
  initial?: Booking;
  /** Synchronise with Amadeus on mount (`refresh: true`, throttled server-side). */
  refreshFromSupplier?: boolean;
  /** Poll ticketing while `pending` / `in_progress` (default true). */
  pollTicketing?: boolean;
}

/** Result of {@link useBooking}. */
export interface UseBookingResult extends AsyncState<Booking>, Omit<MutationState, "error"> {
  booking: Booking | undefined;
  /** Re-read; `supplier: true` synchronises with Amadeus first. */
  refresh(options?: { supplier?: boolean }): Promise<void>;
  /** `bookings.update` with `ifMatch = booking.version`. */
  update(changes: Omit<UpdateBookingParams, "bookingId" | "ifMatch">): Promise<Booking | undefined>;
  /** `bookings.quoteCancellation` (valid 10 min). */
  quoteCancellation(): Promise<CancellationQuote | undefined>;
  quote: CancellationQuote | undefined;
  /** `bookings.cancel` with `ifMatch` and `expectedRefund` from the quote; `REFUND_AMOUNT_CHANGED` refreshes the quote. */
  cancel(params: Omit<CancelBookingParams, "bookingId" | "ifMatch">): Promise<CancellationResult | undefined>;
  /** Documents (`bookings.listDocuments`), loaded on demand. */
  documents: BookingDocument[] | undefined;
  loadDocuments(): Promise<void>;
  /** Ticketing progress (`bookings.getTicketingStatus`), polled per `pollAfterSeconds`. */
  ticketing: BookingTicketingStatus | undefined;
}

/** One booking for a customer or a guest (the proxy adds the guest token from its httpOnly cookie). */
export declare function useBooking(bookingId: string, options?: UseBookingOptions): UseBookingResult;

/**
 * Poll ticketing after `checkout.complete` until a final status (`bookings.getTicketingStatus`, `refresh: true`), also
 * for the pending booking of a `SUPPLIER_TIMEOUT`. Customers are identified by their session cookie, guests by the
 * `vx_bt_<bookingId>` cookie the proxy / `completeCheckout()` stored (the proxy attaches it).
 */
export declare function useTicketingStatus(bookingId: string | null | undefined, options?: { initial?: BookingTicketingStatus }): AsyncState<BookingTicketingStatus>;
