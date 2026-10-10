/**
 * @velexis/ota-sdk/next — Next.js 15 App Router integration (server components, server actions, route handlers,
 * middleware, client components).
 *
 * What it gives you
 * - **Server client from cookies** ({@link createServerClient}): secret key + the customer's (or staff member's) access
 *   token from httpOnly cookies, automatic token refresh, rotated tokens written back where Next.js allows it.
 * - **Public server client** ({@link createPublicServerClient}): secret key, no cookies — keeps ISR / `revalidate`
 *   working for storefront and reference data (reading `cookies()` makes a route dynamic).
 * - **Browser client** ({@link createBrowserClient}): publishable key for public data; every call that needs a
 *   customer or guest token goes through the same-origin proxy route ({@link createProxyHandler}) so tokens never
 *   reach browser JavaScript.
 * - **Auth route handlers** ({@link createAuthHandlers}): sign-in / sign-up / sign-out / refresh that set and clear the
 *   httpOnly cookies.
 * - **Middleware** ({@link velexisMiddleware}): session refresh before server components render, tenant host → key
 *   mapping for multi-domain hosting, protection of `/account` and `/console`.
 * - **Guards** ({@link getSession}, {@link requireCustomer}, {@link requireStaff}) and cookie helpers (sessions, guest
 *   booking tokens, locale/currency).
 * - **RSC / server-action boundary helpers**: {@link serializePage}, {@link toActionError} (SDK `Page` objects and error
 *   classes cannot cross it), {@link completeCheckout} and {@link captureBookingToken} (guest booking tokens go into
 *   httpOnly cookies, never into action results).
 *
 * Next.js 15: `cookies()` and `headers()` are async, so every helper that reads them returns a Promise. Cookies can be
 * **written** only in server actions, route handlers and middleware — in server components the helpers skip writing
 * (the middleware has refreshed the token before rendering).
 *
 * Environment variables
 * - `VELEXIS_SECRET_KEY` — storefront `sk_test_…` / `sk_live_…`, key scope `storefront` (server only; never prefix with `NEXT_PUBLIC_`).
 * - `VELEXIS_CONSOLE_SECRET_KEY` — optional `sk_…` with key scope `console`, used for staff clients (`as: "staff"`);
 *   falls back to `VELEXIS_SECRET_KEY` (which then needs the `console` scope for the console pages to work).
 * - `NEXT_PUBLIC_VELEXIS_PUBLISHABLE_KEY` — `pk_test_…` / `pk_live_…` (browser).
 * - `VELEXIS_API_URL` — API base URL for server code (default `https://api.velexis.travel`; custom API host per tenant possible).
 * - `NEXT_PUBLIC_VELEXIS_API_URL` — API base URL for direct browser calls (default `VELEXIS_API_URL`'s public default).
 * - `VELEXIS_HOSTING_KEY` — optional `hk_…` for one app serving several OTA domains ({@link tenantsFromHostingKey}).
 * - `VELEXIS_TENANTS` — optional JSON map host → keys, the alternative to a hosting key ({@link tenantsFromEnv}).
 *
 * Security notes
 * - Data scope: publishable keys, plain secret keys and customer tokens get **customer scope** from the API (selling
 *   amounts only, also inside `amadeus` blocks; no `netPrice` / `markup` / `diagnostics`; customer-bound searches and
 *   priced offers readable only with that customer's token). Console scope comes only with a staff token or a secret key
 *   that sends `X-Velexis-Scope: console`. So storefront server code (customer / anonymous server clients, the proxy)
 *   never receives net cost, and its results can go to client components as they are. {@link toCustomerView} remains as
 *   defence in depth for data fetched with a staff client.
 * - Ownership: the API lets any secret key of the OTA read and change customer checkouts and payments. Customer /
 *   anonymous server clients therefore send token-less `checkout.*` calls with the **publishable** key
 *   ({@link ServerClientIdentity}), and the proxy does the same for browser calls without a customer token
 *   ({@link ProxyHandlerOptions.forwardKey}) — a checkout id from a URL never unlocks someone else's checkout.
 * - The helpers send the visitor's IP and user agent (`X-Velexis-End-User-IP` / `-Agent`) with every secret-key call
 *   made for a request ({@link VelexisEndUserConfig}), so per-IP rate limits and sign-in lockouts apply per visitor, not
 *   to your server.
 * - Never import this module's server helpers into a client component; only {@link createBrowserClient} is client-safe.
 */
import type { ResponseCookie } from "next/dist/compiled/@edge-runtime/cookies";
import type { VelexisClient, HttpMethod } from "./index";
import type { Schemas, RequestOptions, VelexisClientOptions, Page } from "./shared";
import type { AuthApi, EndUserContext } from "./identity";
import type { CheckoutCompletion, CompleteCheckoutParams, CheckoutTimeoutDetails, BookingLookupResult } from "./bookings";
import type { StaffRole, StaffPermission, ConsoleStaffProfile, ConsoleStaffSession } from "./console";
import type { VelexisSessionAuth, VelexisErrorData, PageData } from "./react";

export type { PageData, VelexisErrorData } from "./react";

/* ------------------------------------------------------------------------------------------------------------ */
/* Request / route-handler shapes                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The parts of `NextRequest` (from `next/server`) the helpers use — the **public contract** of every helper that takes
 * a request. It is structural on purpose: importing `next/server` types into this declaration file would pull Next.js'
 * internal declarations into every consumer compiled with `skipLibCheck: false`. A `NextRequest` is assignable to it,
 * so pass the request your middleware / route handler receives; helpers return a Web `Response` (a `NextResponse` is
 * one), which Next.js accepts from middleware and route handlers.
 */
export interface VelexisNextRequest extends Request {
  readonly cookies: {
    get(name: string): { name: string; value: string } | undefined;
    getAll(): Array<{ name: string; value: string }>;
    has(name: string): boolean;
  };
  readonly nextUrl: {
    readonly href: string;
    readonly origin: string;
    readonly host: string;
    readonly hostname: string;
    readonly pathname: string;
    readonly search: string;
    readonly searchParams: URLSearchParams;
  };
}

/** Next.js 15 route-handler context: dynamic `params` are a Promise. */
export interface RouteContext<P extends Record<string, string | string[]>> {
  params: Promise<P>;
}

/** A Next.js route handler (`export const POST = …` in `app/**\/route.ts`). */
export type RouteHandler<P extends Record<string, string | string[]> = Record<string, string | string[]>> = (
  request: Request,
  context: RouteContext<P>,
) => Promise<Response>;

/** A Next.js middleware function (`export default …` in `middleware.ts`). Returns a `NextResponse` (a `Response`). */
export type VelexisMiddleware = (request: VelexisNextRequest) => Promise<Response>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Cookies                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** Cookie attributes (Next.js `ResponseCookie` without name/value/expiry, which the helpers set). */
export type VelexisCookieOptions = Pick<Partial<ResponseCookie>, "domain" | "path" | "secure" | "sameSite" | "httpOnly" | "partitioned" | "priority">;

/** Names of every cookie the helpers read or write. */
export interface VelexisCookieNames {
  /** Customer access token (httpOnly). Default `vx_at`. Expires `accessTokenSkewSeconds` before the token. */
  accessToken: string;
  /** Customer refresh token (httpOnly). Default `vx_rt`. */
  refreshToken: string;
  /**
   * Non-secret hint that a customer session exists (NOT httpOnly, value `"1"`). Lets the browser client route
   * customer-optional calls (search, pricing, checkout) through the proxy so they are bound to the customer. Default `vx_session`.
   */
  sessionHint: string;
  /** Staff access token (httpOnly, SameSite=strict). Default `vx_staff_at`. */
  staffAccessToken: string;
  /** Staff refresh token (httpOnly, SameSite=strict, path `/console` by default). Default `vx_staff_rt`. */
  staffRefreshToken: string;
  /** Prefix of guest booking-token cookies: `<prefix><bookingId>` (httpOnly). Default `vx_bt_`. */
  bookingTokenPrefix: string;
  /** Selected locale (readable by JS). Default `vx_locale`. */
  locale: string;
  /** Selected display currency (readable by JS). Default `vx_currency`. */
  currency: string;
}

/** Default cookie names. */
export declare const DEFAULT_COOKIE_NAMES: Readonly<VelexisCookieNames>;

/** Cookie configuration shared by every helper. */
export interface VelexisCookieConfig {
  /** Override cookie names (e.g. to run two storefronts on sibling sub-domains). */
  names?: Partial<VelexisCookieNames>;
  /** Attributes of customer session cookies. Default `{ httpOnly: true, secure: true, sameSite: "lax", path: "/" }` (`secure: false` on http://localhost). */
  customer?: VelexisCookieOptions;
  /** Attributes of staff cookies. Default `{ httpOnly: true, secure: true, sameSite: "strict", path: "/" }` (refresh token: path `/console`). */
  staff?: VelexisCookieOptions;
  /** Attributes of guest booking-token cookies. Default as `customer`, path `/`. */
  bookingToken?: VelexisCookieOptions;
  /** Let the access-token cookie expire this many seconds before the token so middleware refreshes in time. Default 60. */
  accessTokenSkewSeconds?: number;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Configuration and tenants                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** Keys of one OTA (tenant) shared by both credential kinds. */
export interface VelexisTenantBase {
  /** Tenant key, e.g. `"acme"` (used in cache tags and logs). */
  tenantKey: string;
  /** `pk_…` — handed to the browser client of this tenant's pages (direct public calls; token-less proxied calls). */
  publishableKey: string;
  /** Custom API host of this tenant (default `VELEXIS_API_URL`). */
  baseUrl?: string;
}

/**
 * Keys of one OTA (tenant): either the OTA's own secret key(s), or the deployment's hosting key plus the storefront
 * host the calls are made for (`X-Velexis-Host`; the API then treats the call like that OTA's secret key).
 */
export type VelexisTenantKeys = VelexisTenantBase &
  (
    | {
        /** `sk_…` of this OTA (key scope `storefront`) — server only. */
        secretKey: string;
        /** `sk_…` of this OTA with key scope `console`, for staff clients (default `secretKey`). */
        consoleSecretKey?: string;
        hostingKey?: never;
        host?: never;
      }
    | {
        secretKey?: never;
        consoleSecretKey?: never;
        /** `hk_…` of the deployment — server only. */
        hostingKey: string;
        /** Verified storefront host (lower case, no port) sent as `X-Velexis-Host` with every call. */
        host: string;
      }
  );

/**
 * Host → tenant mapping for **one Next.js app serving several OTA domains**: a record keyed by host
 * (`"www.acme.travel"`, `"acme.localhost:3000"`; `"*.example.com"` wildcards allowed), or a resolver function (may be
 * async) — {@link tenantsFromHostingKey} returns one backed by `storefront.resolve`. Return `null` for unknown hosts
 * (the middleware answers 404).
 */
export type VelexisTenantResolver =
  | Record<string, VelexisTenantKeys>
  | ((host: string) => VelexisTenantKeys | null | Promise<VelexisTenantKeys | null>);

/**
 * Which visitor a server call is made for (`X-Velexis-End-User-IP` / `X-Velexis-End-User-Agent`, honoured by the API for
 * secret and hosting keys only). The helpers read it from the incoming request: the user agent from `user-agent`, the IP
 * from a header **your own hosting edge writes**. Never trust a client-supplied left-most `x-forwarded-for` entry.
 */
export interface VelexisEndUserConfig {
  /** Header holding the visitor IP (default `"x-forwarded-for"`; e.g. `"cf-connecting-ip"`, `"x-real-ip"`, `"fly-client-ip"`). */
  ipHeader?: string;
  /**
   * For comma-separated headers (`x-forwarded-for`): how many right-most entries were appended by proxies you control;
   * the helpers use the entry at that position from the right (default 1 = the last entry, the address your edge saw —
   * correct for Vercel, Netlify and a single load balancer). Values that are not valid IPs are dropped (the API then
   * uses the connection IP).
   */
  trustedHops?: number;
}

/** Configuration shared by every helper of this module. Define it once (`defineVelexisConfig`) and import it where needed. */
export interface VelexisNextConfig {
  /** Storefront secret key (default `process.env.VELEXIS_SECRET_KEY`). Ignored when `tenants` is set. */
  secretKey?: string;
  /**
   * Secret key with key scope `console`, used by staff clients and staff helpers (default
   * `process.env.VELEXIS_CONSOLE_SECRET_KEY`, else `secretKey`). A key scoped `storefront` is refused on every console
   * operation (`SCOPE_NOT_ALLOWED`), even with a staff token. Ignored when `tenants` is set.
   */
  consoleSecretKey?: string;
  /** Publishable key (default `process.env.NEXT_PUBLIC_VELEXIS_PUBLISHABLE_KEY`). Ignored when `tenants` is set. */
  publishableKey?: string;
  /** API base URL (default `process.env.VELEXIS_API_URL` or `https://api.velexis.travel`). */
  baseUrl?: string;
  /** Multi-domain hosting: host → tenant keys. The middleware sets the trusted request header `x-velexis-tenant`. */
  tenants?: VelexisTenantResolver;
  /** How the visitor's IP / user agent are derived from the request; `false` sends none. Default `{ ipHeader: "x-forwarded-for", trustedHops: 1 }`. */
  endUser?: VelexisEndUserConfig | false;
  /** Cookie names and attributes. */
  cookies?: VelexisCookieConfig;
  /** Sign-in page for customers (default `/account/sign-in`). */
  signInPath?: string;
  /** Sign-in page for staff (default `/console/sign-in`). */
  consoleSignInPath?: string;
  /** Extra options for every SDK client created by the helpers (timeouts, retries, `onResponse` logging …). */
  clientOptions?: Omit<
    Partial<VelexisClientOptions>,
    "secretKey" | "publishableKey" | "hostingKey" | "host" | "endUser" | "accessToken" | "refreshToken" | "bookingToken" | "sessionKind"
  >;
}

/** Identity helper giving a config object its type (share it between `lib/velexis.ts` and `middleware.ts`). */
export declare function defineVelexisConfig<T extends VelexisNextConfig>(config: T): T;

/**
 * Parse `process.env[name]` (default `VELEXIS_TENANTS`) — JSON
 * `{ "<host>": { tenantKey, secretKey, consoleSecretKey?, publishableKey, baseUrl? } }`.
 */
export declare function tenantsFromEnv(name?: string): Record<string, VelexisTenantKeys>;

/** Options of {@link tenantsFromHostingKey}. */
export interface HostingKeyTenantsOptions {
  /** Hosting key (default `process.env.VELEXIS_HOSTING_KEY`). Server / middleware only. */
  hostingKey?: string;
  /** API base URL for `storefront.resolve` (default `process.env.VELEXIS_API_URL`). */
  baseUrl?: string;
  /** Upper bound for caching a resolution in memory, in seconds (default and maximum: the answer's `cacheTtlSeconds`, 300). Unknown hosts are cached for 60 s. */
  maxCacheSeconds?: number;
}

/**
 * Tenant resolver for **one deployment serving many OTA domains with a Velexis hosting key** (`hk_…`, recommended over a
 * map of every OTA's secret key): `storefront.resolve({ host })` per host, cached in memory (edge-safe). The resolved
 * tenant carries `hostingKey` + `host` (every call sends `X-Velexis-Host`), the OTA's `publishableKey` and its custom
 * `apiBaseUrl`. Hosts the key may not act for, unverified hosts and OTAs without an active publishable key resolve to
 * `null` (404); suspended OTAs resolve normally so pages render their `TENANT_SUSPENDED` maintenance page.
 *
 * @example
 * // lib/velexis-config.ts
 * export const velexisConfig = defineVelexisConfig({ tenants: tenantsFromHostingKey() });
 */
export declare function tenantsFromHostingKey(options?: HostingKeyTenantsOptions): (host: string) => Promise<VelexisTenantKeys | null>;

/**
 * The tenant of the current request (server components, server actions, route handlers): from the `x-velexis-tenant`
 * header set by {@link velexisMiddleware} (never trusted from the client — the middleware overwrites it), else by
 * resolving the `host` header. Single-tenant apps get the env keys with `tenantKey: "default"`.
 */
export declare function getTenant(options?: { config?: VelexisNextConfig }): Promise<VelexisTenantKeys>;

/**
 * The visitor of the current request per {@link VelexisEndUserConfig} (reads `headers()`), or `undefined` when disabled
 * or unknown. The server clients, auth handlers, proxy and sign-in helpers send it automatically; use it for your own
 * `createVelexisClient` calls (`options.endUser`).
 */
export declare function getEndUser(options?: { config?: VelexisNextConfig }): Promise<EndUserContext | undefined>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Server clients                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** Who the server client acts as. */
export type ServerClientIdentity =
  /**
   * Customer session cookies when present, anonymous otherwise (default). Without a customer access token, calls to
   * `checkout.*` (`/v1/checkouts/**`, `/v1/payments/**`) go with the tenant's **publishable** key and
   * `Origin: <storefront origin>` instead of the secret key, because the API lets a secret key read and change any
   * customer's checkout or payment: a signed-out visitor opening `/checkout/<someone else's chk_…>` gets `404`, exactly
   * as from the browser, while guest checkouts stay usable by their unguessable id.
   */
  | "customer"
  /**
   * Staff session cookies (console pages, console server actions), with the tenant's **console** secret key
   * (`consoleSecretKey`) and `sessionKind: "staff"` (refresh via `console.auth.refresh`; console scope). Requires the
   * staff access/refresh cookie: without it the client rejects every call locally with `AuthenticationError`
   * `UNAUTHENTICATED` — it never sends a key-only console call (which the API refuses with `SCOPE_NOT_ALLOWED` unless the
   * key has the `console:automation` scope, and then acts with that key's permissions, not the visitor's). Still call
   * {@link requireStaff} at the top of every console server action (server actions are public endpoints).
   */
  | "staff"
  /** No user token (storefront secret key; customer scope). `checkout.*` calls use the publishable key as for `"customer"` without a session. */
  | "anonymous";

/** Options of {@link createServerClient}. */
export interface ServerClientOptions
  extends Omit<Partial<VelexisClientOptions>, "secretKey" | "publishableKey" | "hostingKey" | "host" | "sessionKind"> {
  /** Shared configuration (keys, tenants, cookies, end-user headers). */
  config?: VelexisNextConfig;
  /** Identity (default `"customer"`). */
  as?: ServerClientIdentity;
  /** Attach the guest booking token of this booking (cookie `vx_bt_<bookingId>`) to every call (`X-Booking-Token`). */
  bookingId?: string;
  /**
   * Write rotated tokens back into the cookies after an automatic refresh (default true). Writing works in server
   * actions and route handlers; in server components it is skipped silently (the middleware refreshes first).
   */
  persistRefreshedTokens?: boolean;
}

/**
 * A client for server components, server actions and route handlers: the request tenant's secret key (or hosting key +
 * `host`), the customer's or staff member's access + refresh token from httpOnly cookies, `locale` / `currency` from
 * cookies, the visitor's IP / user agent as `endUser` ({@link getEndUser}; override with `endUser`), and automatic
 * refresh (`TOKEN_EXPIRED` → refresh once → retry; `onSessionExpired` clears the cookies where allowed). Token-less
 * `checkout.*` calls use the publishable key (see {@link ServerClientIdentity}), so ids taken from the URL never unlock
 * another customer's checkout.
 *
 * - Customer and anonymous clients get **customer scope** (API default for secret keys): results can be passed to
 *   client components as they are (after {@link serializePage} for pages).
 * - Reads `cookies()` / `headers()` → the route renders dynamically. For cacheable data use {@link createPublicServerClient}.
 * - Create it per request (inside the component / action), never at module level.
 * - Wrap in React `cache()` if several components of one request need it.
 *
 * @example
 * // app/account/page.tsx
 * const vx = await createServerClient();
 * const me = await vx.account.get();
 */
export declare function createServerClient(options?: ServerClientOptions): Promise<VelexisClient>;

/**
 * A storefront secret-key client (customer scope) that reads **no** cookies or headers (single-tenant) — usable in
 * `generateMetadata`, `generateStaticParams`, cached server components and route handlers without opting into dynamic
 * rendering. It sends no end user; pass `endUser` (e.g. from {@link getEndUser}) when a call is made for a visitor
 * (sign-up, password reset). For multi-tenant apps pass the tenant (`getTenant()` reads headers, which makes the route
 * dynamic but keeps `fetch` caching with per-tenant tags — see {@link storefrontCacheOptions}).
 */
export declare function createPublicServerClient(
  options?: { config?: VelexisNextConfig; tenant?: VelexisTenantKeys } & Omit<
    Partial<VelexisClientOptions>,
    "secretKey" | "publishableKey" | "hostingKey" | "host" | "accessToken" | "refreshToken" | "sessionKind"
  >,
): VelexisClient;

/** Cache tags used by the helpers (`revalidateTag(tag)`). */
export declare const VELEXIS_CACHE_TAGS: {
  /** `velexis:storefront:<tenantKey>` */
  storefront(tenantKey?: string): string;
  /** `velexis:reference` (shared by every tenant). */
  readonly reference: string;
};

/** `RequestOptions` for `storefront.get`: `{ next: { revalidate: 300, tags: [storefront tag] } }`. Never use for priced or personal calls. */
export declare function storefrontCacheOptions(tenantKey?: string, revalidateSeconds?: number): RequestOptions;
/** `RequestOptions` for `reference.*`: `{ next: { revalidate: 86400, tags: ["velexis:reference"] } }`. */
export declare function referenceCacheOptions(revalidateSeconds?: number): RequestOptions;

/**
 * Property names that only console scope returns: `netPrice` / `markup` (offers, priced offers, ancillary options,
 * console bookings), `diagnostics` (searches, availability), `pricing` (console booking details) and `supplier`
 * (Amadeus error details on `Error`).
 */
export type ConsoleOnlyField = "netPrice" | "markup" | "diagnostics" | "pricing" | "supplier";

/**
 * Type of {@link toCustomerView}'s result: `T` without the {@link ConsoleOnlyField} properties (recursively), and with
 * `amadeus` optional on object types that declare `netPrice` or `markup` (a console-scope offer / priced offer /
 * ancillary option carries **net** amounts in `amadeus`, so that block is dropped). Other `amadeus` blocks
 * (bookings, tickets, saved travellers, storefront card brands, customer-scope offers) keep their type.
 */
export type CustomerView<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? CustomerView<U>[]
    : T extends object
      ? "netPrice" extends keyof T
        ? CustomerViewWithoutNet<T>
        : "markup" extends keyof T
          ? CustomerViewWithoutNet<T>
          : { [K in keyof T as K extends ConsoleOnlyField ? never : K]: CustomerView<T[K]> }
      : T;

/** Helper of {@link CustomerView}: console-priced object types (`amadeus` becomes optional). */
export type CustomerViewWithoutNet<T> = { [K in keyof T as K extends ConsoleOnlyField | "amadeus" ? never : K]: CustomerView<T[K]> } & {
  [K in keyof T as K extends "amadeus" ? K : never]?: CustomerView<T[K]>;
};

/**
 * Defence in depth for data that may be **console scope** (fetched with a staff client or `X-Velexis-Scope: console`)
 * before it reaches a client component or a customer: removes the {@link ConsoleOnlyField} properties recursively and
 * drops the `amadeus` block of every object that carried `netPrice` or `markup` (its amounts are net). Returns a
 * structural copy typed {@link CustomerView}.
 *
 * Customer-scope data — everything a publishable key, a plain secret key or a customer token receives, i.e. every
 * customer / anonymous server client and the proxy — contains none of these fields, so it does **not** need this
 * function and passes through unchanged (selling-amount `amadeus` blocks are kept). To show a customer what a staff
 * client fetched, prefer re-reading it in customer scope (`{ headers: { "X-Velexis-Scope": "customer" } }` with the
 * staff token): this function can drop net amounts but cannot compute selling amounts.
 */
export declare function toCustomerView<T>(value: T): CustomerView<T>;

/**
 * Strip the methods of an SDK page so it can cross the RSC boundary (props of client components, server action
 * results). Same as `toPageData` of `@velexis/ota-sdk/react`; use `toResultsPageData` for flight results pages.
 */
export declare function serializePage<T>(page: Page<T>): PageData<T>;

/**
 * Flatten an error for a server action result (class instances do not cross the boundary): `name`, `code`, `message`,
 * `status`, `requestId`, `fieldErrors`, `retryable` and `details` — with the guest-token fields `details.bookingToken`
 * / `details.bookingTokenExpiresAt` removed (a `504 SUPPLIER_TIMEOUT` of `checkout.complete` carries them for guests;
 * store them first with {@link captureBookingToken}, or use {@link completeCheckout}). Console `supplier` details are
 * not copied. Non-Velexis errors become `INTERNAL_ERROR` without leaking their message. Re-throws Next.js control-flow
 * errors (`redirect()`, `notFound()`). Rebuild a typed error in the client with `fromErrorData()`.
 */
export declare function toActionError(error: unknown): VelexisErrorData;

/**
 * Store the guest booking token found in `source` in its httpOnly `vx_bt_<bookingId>` cookie (server actions and route
 * handlers; expiry from the source, else 24 h). Accepts:
 * - a {@link CheckoutCompletion} (`booking.id`, `bookingToken`, `bookingTokenExpiresAt`),
 * - a {@link BookingLookupResult} (`bookingId`, `bookingToken`, `expiresAt`),
 * - an SDK error whose `details` carry `bookingId` + `bookingToken` (+ `bookingTokenExpiresAt`) — the guest
 *   `504 SUPPLIER_TIMEOUT` of `checkout.complete` ({@link CheckoutTimeoutDetails}).
 * Resolves with the booking id when a token was stored, else `null` (customer bookings carry no token). Never return the
 * token itself to a client component: null `bookingToken` in a completion you return, and pass errors through
 * {@link toActionError} (which drops it).
 */
export declare function captureBookingToken(
  source: CheckoutCompletion | BookingLookupResult | unknown,
  options?: { config?: VelexisNextConfig },
): Promise<string | null>;

/** Options of {@link completeCheckout}. */
export interface CompleteCheckoutOptions {
  config?: VelexisNextConfig;
  /** Idempotency key (default `complete-<checkoutId>-<paymentId ?? "nopay">`, stable per attempt so retries replay). */
  idempotencyKey?: string;
  /** Timeout (default 90 000 ms). */
  timeoutMs?: number;
}

/**
 * Server-action implementation of `checkout.complete` for `useCheckout({ completeAction })`: customer server client
 * (customer token when signed in, guest otherwise), stable idempotency key, `timeoutMs: 90_000`, then
 * - success → the guest `bookingToken` goes into `vx_bt_<bookingId>` and the completion is returned with
 *   `bookingToken: null`;
 * - `504 SUPPLIER_TIMEOUT` → the pending booking's guest token (`details.bookingToken`) goes into its cookie, so the
 *   booking page and `useTicketingStatus` can poll it; returns `{ error }` with `details.bookingId` (token removed);
 * - any other error → `{ error: toActionError(e) }`.
 * Re-throws Next.js control-flow errors. Server actions are public endpoints: the API checks ownership of the checkout
 * with the customer token (guest checkouts are capability ids).
 *
 * @example
 * // app/checkout/[checkoutId]/actions.ts
 * "use server";
 * export async function completeCheckoutAction(params: CompleteCheckoutParams) {
 *   return completeCheckout(params, { config: velexisConfig });
 * }
 */
export declare function completeCheckout(
  params: CompleteCheckoutParams,
  options?: CompleteCheckoutOptions,
): Promise<CheckoutCompletion | { error: VelexisErrorData }>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Browser client                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** How the browser client routes calls. */
export type BrowserRoutingMode =
  /**
   * Default. Public operations (storefront, reference, anonymous auth forms) go **direct** to the API with the publishable
   * key; operations that need a customer or guest token go through the proxy; customer-optional operations (flights,
   * checkout, payments) go through the proxy while the `vx_session` hint cookie exists, direct otherwise. Operations
   * that return a guest booking token — `checkout.complete` and `bookings.lookup` — always go through the proxy, which
   * moves the token into its httpOnly cookie (also from a `504 SUPPLIER_TIMEOUT`), so it never reaches JavaScript.
   */
  | "hybrid"
  /** Everything through the same-origin proxy (no CORS, no origin allow-list, slightly higher latency). */
  | "proxy"
  /**
   * Everything direct with the publishable key (no customer session: widgets, guest-only storefronts without the proxy
   * route). `checkout.complete`, `bookings.lookup` and guest booking calls are rejected locally (`SCOPE_NOT_ALLOWED`)
   * because their guest token would land in JavaScript — complete through a server action (`completeCheckout`).
   */
  | "direct";

/** Options of {@link createBrowserClient}. */
export interface BrowserClientOptions {
  /** Publishable key (default `process.env.NEXT_PUBLIC_VELEXIS_PUBLISHABLE_KEY`; per-tenant from the layout in multi-domain apps). */
  publishableKey?: string;
  /** API base URL for direct calls (default `process.env.NEXT_PUBLIC_VELEXIS_API_URL` or `https://api.velexis.travel`). */
  baseUrl?: string;
  /** Path of the catch-all proxy route (default `/api/velexis`). */
  proxyPath?: string;
  /** Path of the auth route handlers (default `/api/auth`). */
  authPath?: string;
  /** Routing (default `"hybrid"`). */
  mode?: BrowserRoutingMode;
  /** Default locale / currency (default: the `vx_locale` / `vx_currency` cookies). */
  locale?: string;
  currency?: string;
  /** Called when a proxied call answers `UNAUTHENTICATED` (session ended): e.g. `router.push("/account/sign-in")`. */
  onUnauthenticated?: () => void;
  /** Timeouts / retries / logging (keys and tokens cannot be set here). */
  clientOptions?: Pick<Partial<VelexisClientOptions>, "timeoutMs" | "maxRetries" | "headers" | "onResponse" | "fetch">;
}

/**
 * `auth` of the browser client: token-returning operations go to the auth route handlers (cookies set server-side);
 * the anonymous forms go direct with the publishable key.
 */
export interface BrowserAuthApi extends VelexisSessionAuth {
  verifyEmail: AuthApi["verifyEmail"];
  resendVerification: AuthApi["resendVerification"];
  requestPasswordReset: AuthApi["requestPasswordReset"];
  /** Reset the password via `POST /api/auth/reset-password` (signs in by default; cookies set server-side). */
  resetPassword(params: Schemas["PasswordResetConfirmRequest"], options?: RequestOptions): Promise<{ customer: Schemas["Customer"]; signedIn: boolean }>;
  /** Change the password via `POST /api/auth/change-password` (session rotated server-side). */
  changePassword(params: Schemas["PasswordChangeRequest"], options?: RequestOptions): Promise<{ customer: Schemas["Customer"] }>;
  /** Force a refresh via `POST /api/auth/refresh` (normally the middleware / proxy refresh transparently). */
  refresh(options?: RequestOptions): Promise<{ accessTokenExpiresAt: string } | null>;
}

/** Browser client: customer-scope namespaces only (no `console`), cookie-session `auth`. Compatible with `VelexisProvider`. */
export type BrowserVelexisClient = Omit<VelexisClient, "console" | "auth" | "withOptions"> & {
  readonly auth: BrowserAuthApi;
  /** A new browser client with other routing / locale / currency. */
  withOptions(overrides: Partial<BrowserClientOptions>): BrowserVelexisClient;
};

/**
 * Create the browser client (client components). Safe to create at module level in a `"use client"` file.
 * Secret keys are rejected at runtime (`sk_…` throws). Console methods do not exist on this client.
 */
export declare function createBrowserClient(options?: BrowserClientOptions): BrowserVelexisClient;

/* ------------------------------------------------------------------------------------------------------------ */
/* Auth route handlers                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** Actions served by {@link createAuthHandlers} (`app/api/auth/[action]/route.ts`). */
export type AuthHandlerAction = "sign-in" | "sign-up" | "sign-out" | "refresh" | "reset-password" | "change-password";

/** JSON body returned by the auth handlers (tokens are never included). */
export type AuthHandlerResponse =
  | { ok: true; customer: Schemas["Customer"] | null; signedIn: boolean; emailVerification?: Schemas["EmailVerificationStatus"]; accessTokenExpiresAt?: string }
  | { ok: false; error: VelexisErrorData };

/** Options of {@link createAuthHandlers}. */
export interface AuthHandlerOptions {
  config?: VelexisNextConfig;
  /** Actions to serve (default all). Others answer 404. */
  actions?: AuthHandlerAction[];
  /**
   * CSRF protection: POSTs must carry an `Origin` (or `Referer`) equal to the request host or listed here, and
   * `Content-Type: application/json`. Default: same origin only.
   */
  allowedOrigins?: string[];
  /** Called after a successful sign-in / sign-up (audit, analytics). */
  onSignedIn?: (info: { customer: Schemas["Customer"]; request: Request }) => void | Promise<void>;
  /** Called after sign-out. */
  onSignedOut?: (info: { request: Request }) => void | Promise<void>;
}

/**
 * Route handlers for customer auth with httpOnly cookies:
 * - `POST /api/auth/sign-in` body `SignInRequest` → `auth.signIn`, sets `vx_at` / `vx_rt` (+ `vx_session` hint).
 * - `POST /api/auth/sign-up` body `SignUpRequest` → `auth.signUp`, sets cookies when a session is returned.
 * - `POST /api/auth/sign-out` body `{ scope? }` → `auth.signOut` with the refresh token, always clears cookies.
 * - `POST /api/auth/refresh` → `auth.refresh`, rotates cookies (`REFRESH_TOKEN_INVALID|REUSED` → clears them, 401).
 * - `POST /api/auth/reset-password`, `POST /api/auth/change-password` → store the returned session.
 * Errors answer with the API status and `{ ok: false, error }`. Every upstream call carries the visitor's IP / user agent
 * ({@link getEndUser}), so sign-in lockouts, sign-up limits and session metadata are per visitor.
 *
 * @example
 * // app/api/auth/[action]/route.ts
 * export const { POST } = createAuthHandlers();
 */
export declare function createAuthHandlers(options?: AuthHandlerOptions): { POST: RouteHandler<{ action: string }> };

/* ------------------------------------------------------------------------------------------------------------ */
/* Proxy route handler                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Which token the proxy attaches for an allowed operation (and therefore which key it forwards with, see
 * {@link ProxyHandlerOptions.forwardKey}).
 */
export type ProxyAuthMode =
  /** No user token (public data and anonymous forms: storefront, reference, verify-email, password-reset request, guest lookup). */
  | "none"
  /**
   * Customer access token when the cookie exists (customer-optional operations: flights, checkout, payments). Without
   * it the call is forwarded **with the publishable key**, so the API's ownership rules apply exactly as for a browser
   * call: customer-owned checkouts, payments, searches and priced offers answer `404`; guest ones stay readable by their
   * unguessable id. When the refresh cookie exists but the session cannot be refreshed the proxy answers
   * `401 UNAUTHENTICATED` (signed-out UI) instead of forwarding.
   */
  | "customer-optional"
  /** Customer access token required (401 `UNAUTHENTICATED` without it). */
  | "customer"
  /** Customer token, else the guest booking token cookie of `{bookingId}` in the path; neither → 401 `UNAUTHENTICATED` (nothing forwarded). */
  | "customer-or-booking";

/** One allowed operation: method + path template (as in the OpenAPI document). */
export interface ProxyRule {
  method: HttpMethod;
  /** Path template, e.g. `/v1/bookings/{bookingId}`. `{param}` matches one segment. */
  path: `/v1/${string}`;
  /** SDK method (documentation / logging). */
  sdkMethod?: string;
  auth: ProxyAuthMode;
}

/**
 * Default allow-list: every customer-scope operation of `storefront.get`, `reference`, `auth.getSession` and the
 * anonymous `auth` forms, `account.*`, `flights.*` except `availability`, `checkout.*` (incl. `updatePayment`,
 * `PATCH /v1/payments/{paymentId}`), `bookings.*` (incl. extras after booking: `getAncillaries`, `createPayment`,
 * `addAncillaries`). Never contains `/v1/console/**`, `/v1/flight-availabilities`, `storefront.resolve` or the
 * token-returning `auth` operations (those are served by {@link createAuthHandlers}).
 */
export declare const DEFAULT_PROXY_ALLOW_LIST: readonly ProxyRule[];

/** A request-body check run before forwarding (reject what the storefront never sends, before it reaches the API). */
export interface ProxyGuard {
  method: HttpMethod;
  path: `/v1/${string}`;
  /** Return an error message to reject with `403 SCOPE_NOT_ALLOWED`, or null to allow. */
  check(body: unknown): string | null;
}

/**
 * Default guards: reject `amadeusFlightOffers` on `POST /v1/priced-offers` (console pricing of raw offers) and `metadata`
 * larger than 2 KB on checkouts. Corporate / negotiated fares need no guard: the API refuses them in customer scope
 * unless the storefront enables them.
 */
export declare const DEFAULT_PROXY_GUARDS: readonly ProxyGuard[];

/** Options of {@link createProxyHandler}. */
export interface ProxyHandlerOptions {
  config?: VelexisNextConfig;
  /** Allowed operations (default {@link DEFAULT_PROXY_ALLOW_LIST}). Console paths are refused even if listed. */
  allow?: readonly ProxyRule[];
  /** Body guards (default {@link DEFAULT_PROXY_GUARDS}). */
  guards?: readonly ProxyGuard[];
  /**
   * Key used upstream.
   * - `"auto"` (default): a call that carries a user token from the cookies (customer access token, guest booking token)
   *   or is a `"none"` rule (public / anonymous forms) goes with the tenant's **secret** (or hosting) key plus the
   *   visitor's IP / user agent ({@link getEndUser}) — per-visitor rate limits for lookup, autocomplete and auth forms.
   *   A `"customer-optional"` call **without** a customer token goes with the tenant's **publishable** key and
   *   `Origin: <storefront origin>`, so a signed-out request can never use the secret key to read another customer's
   *   checkout or payment (the API lets secret keys read any customer checkout / payment of the OTA).
   * - `"publishable"`: every call with the publishable key (tokens still attached); per-IP limits then count against
   *   your server's IP, because the API ignores end-user headers for publishable keys.
   * The storefront origin must be on the publishable key's origin allow-list (it already is for direct browser calls).
   */
  forwardKey?: "auto" | "publishable";
  /**
   * Strip console-only fields from responses with {@link toCustomerView} (default true). Defence in depth only: every
   * proxied call is customer scope, so responses carry none (the proxy never forwards a client `X-Velexis-Scope`).
   */
  redactConsoleFields?: boolean;
  /**
   * Move guest booking tokens out of response bodies into httpOnly `vx_bt_<bookingId>` cookies (default true); the body
   * keeps `null` in their place:
   * - `POST /v1/checkouts/{id}/complete` `201` (`bookingToken`, `bookingTokenExpiresAt`, booking `booking.id`),
   * - `POST /v1/checkouts/{id}/complete` `504 SUPPLIER_TIMEOUT` (`error.details.bookingToken` /
   *   `bookingTokenExpiresAt` of the pending booking `error.details.bookingId`) — so a guest can poll the pending booking
   *   (`useTicketingStatus`, booking page) while the browser never sees the token,
   * - `POST /v1/bookings/lookup` `200` (`bookingToken`, `expiresAt`, `bookingId`).
   */
  captureBookingTokens?: boolean;
  /** Refresh an expired customer access token with the refresh-token cookie and set the rotated cookies on the response (default true). */
  refreshSession?: boolean;
  /**
   * Request headers forwarded upstream (default `accept-language`, `x-currency`, `idempotency-key`, `if-match`,
   * `content-type`). `x-api-key`, `authorization`, `x-booking-token`, `x-velexis-scope`, `x-velexis-host` and
   * `x-velexis-end-user-*` are never taken from the browser, even if listed.
   */
  forwardHeaders?: string[];
  /** Max request body in bytes (default 256 KB). */
  maxBodyBytes?: number;
  /** Same-origin check for state-changing methods (default: same origin only). */
  allowedOrigins?: string[];
  /** Hook before forwarding (rate limiting, logging). Return a `Response` to short-circuit. */
  onRequest?: (info: { rule: ProxyRule; request: Request; tenant: VelexisTenantKeys }) => void | Response | Promise<void | Response>;
}

/**
 * Catch-all route forwarding browser calls to the Velexis API with the tenant's key (see
 * {@link ProxyHandlerOptions.forwardKey}) and the cookie tokens, for allowed customer-scope operations only (others:
 * `403 SCOPE_NOT_ALLOWED`, unknown: 404). Responses are never cached (`Cache-Control: no-store`); `X-Request-Id` is
 * passed through; guest booking tokens never reach the browser ({@link ProxyHandlerOptions.captureBookingTokens}).
 *
 * @example
 * // app/api/velexis/[...path]/route.ts
 * export const { GET, POST, PUT, PATCH, DELETE } = createProxyHandler();
 */
export declare function createProxyHandler(options?: ProxyHandlerOptions): {
  GET: RouteHandler<{ path: string[] }>;
  POST: RouteHandler<{ path: string[] }>;
  PUT: RouteHandler<{ path: string[] }>;
  PATCH: RouteHandler<{ path: string[] }>;
  DELETE: RouteHandler<{ path: string[] }>;
};

/* ------------------------------------------------------------------------------------------------------------ */
/* Middleware                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** Options of {@link velexisMiddleware}. */
export interface VelexisMiddlewareConfig {
  config?: VelexisNextConfig;
  /** Refresh customer tokens when the access-token cookie is gone but a refresh token exists (default true). */
  refreshCustomerSession?: boolean;
  /** Refresh staff tokens on console paths (default true). */
  refreshStaffSession?: boolean;
  /** Path prefixes that require a customer session → redirect to `signInPath?next=…` (default `["/account"]`). */
  customerPaths?: string[];
  /** Path prefixes that require a staff session → redirect to `consoleSignInPath?next=…` (default `["/console"]`). */
  consolePaths?: string[];
  /** Paths inside the protected prefixes that stay public (default: the two sign-in paths and `/account/sign-up`, `/account/forgot-password`). */
  publicPaths?: string[];
  /** Unknown host in multi-tenant mode: `"not-found"` (default, 404) or a URL to redirect to (e.g. the Velexis portal). */
  unknownTenant?: "not-found" | string;
  /** Run after the Velexis logic (i18n, A/B …); receives the response built so far. */
  next?: (request: VelexisNextRequest, response: Response) => Response | Promise<Response>;
}

/**
 * Middleware (edge runtime): resolves the tenant from the host (`config.tenants`, e.g. {@link tenantsFromHostingKey};
 * sets the trusted `x-velexis-tenant` request header and strips any client-sent copy), refreshes customer/staff sessions
 * before server components run (with the visitor's IP / user agent; rotated cookies are set on the response **and**
 * forwarded to the current render), protects account and console paths, and clears cookies of revoked sessions.
 * Session refresh failures never block public pages.
 *
 * `config.matcher` must be a literal in `middleware.ts` (Next.js reads it statically); exclude static assets and
 * `/api/velexis` (the proxy refreshes itself).
 *
 * @example
 * // middleware.ts
 * export default velexisMiddleware({ config: velexisConfig });
 * export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|api/velexis).*)"] };
 */
export declare function velexisMiddleware(config?: VelexisMiddlewareConfig): VelexisMiddleware;

/* ------------------------------------------------------------------------------------------------------------ */
/* Sessions and guards                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** The signed-in customer of the current request. */
export interface CustomerSession {
  kind: "customer";
  customer: Schemas["Customer"];
  session: Schemas["AuthSessionDetails"];
}

/**
 * The customer of the current request (`auth.getSession` with the cookie token, deduplicated per request with React
 * `cache()`), or `null` when signed out / the token is invalid. Never throws for auth errors.
 */
export declare function getSession(options?: { config?: VelexisNextConfig }): Promise<CustomerSession | null>;

/** The staff member of the current request (`console.auth.me` with the console key and staff cookie, deduplicated per request), or `null`. */
export declare function getStaffSession(options?: { config?: VelexisNextConfig }): Promise<ConsoleStaffProfile | null>;

/**
 * Require a signed-in customer (server components, server actions, route handlers). Redirects to
 * `signInPath?next=<returnTo>` (Next.js `redirect()`) when signed out.
 */
export declare function requireCustomer(options?: { config?: VelexisNextConfig; returnTo?: string }): Promise<CustomerSession>;

/** Options of {@link requireStaff}. */
export interface RequireStaffOptions {
  config?: VelexisNextConfig;
  /** Allowed roles (any). */
  roles?: StaffRole[];
  /** Required permissions (all). */
  permissions?: StaffPermission[];
  /** Where to send signed-out staff (default `consoleSignInPath?next=<returnTo>`). */
  returnTo?: string;
  /** What to do when signed in without the role/permission: throw `PermissionError` `FORBIDDEN` (default, renders `error.tsx`) or redirect to a path. */
  onForbidden?: "throw" | { redirect: string };
}

/**
 * Require a signed-in staff member, optionally with one of `roles` / all `permissions`. Redirects to the console
 * sign-in page when signed out; see {@link RequireStaffOptions.onForbidden} otherwise.
 */
export declare function requireStaff(roles?: StaffRole[] | RequireStaffOptions): Promise<ConsoleStaffProfile>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Cookie helpers (server actions / route handlers)                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/** Store a customer session in httpOnly cookies (+ `vx_session` hint). Server actions / route handlers only. */
export declare function setSessionCookies(session: Schemas["Session"], options?: { config?: VelexisNextConfig }): Promise<void>;
/** Delete the customer session cookies. */
export declare function clearSessionCookies(options?: { config?: VelexisNextConfig }): Promise<void>;
/** Store a staff session (`ConsoleStaffSession.session`) in httpOnly, SameSite=strict cookies. */
export declare function setStaffSessionCookies(session: Schemas["Session"], options?: { config?: VelexisNextConfig }): Promise<void>;
/** Delete the staff session cookies. */
export declare function clearStaffSessionCookies(options?: { config?: VelexisNextConfig }): Promise<void>;

/** Raw tokens of the current request (server-only; never return them to a client component). */
export declare function readSessionTokens(options?: { config?: VelexisNextConfig }): Promise<{
  accessToken: string | undefined;
  refreshToken: string | undefined;
  staffAccessToken: string | undefined;
  staffRefreshToken: string | undefined;
}>;

/**
 * Sign a customer in from a server action: `auth.signIn` (with the visitor's IP / user agent, so lockouts are per
 * visitor) + {@link setSessionCookies}. Throws SDK errors (`INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`,
 * `ACCOUNT_LOCKED` with `details.lockedUntil`, `RATE_LIMITED`).
 */
export declare function signInCustomer(params: Schemas["SignInRequest"], options?: { config?: VelexisNextConfig }): Promise<Schemas["AuthSessionResult"]["customer"]>;
/** Sign the customer out (`auth.signOut` with the refresh token, errors ignored) and clear the cookies. */
export declare function signOutCustomer(options?: { config?: VelexisNextConfig; scope?: "current" | "all" }): Promise<void>;
/**
 * Sign a staff member in from a server action: `console.auth.signIn` with the console key and the visitor's IP / user
 * agent + {@link setStaffSessionCookies}. Throws SDK errors (`STAFF_MFA_REQUIRED`, `INVALID_CREDENTIALS`,
 * `ACCOUNT_LOCKED`, `STAFF_MEMBERSHIP_INACTIVE` …).
 */
export declare function signInStaff(params: Schemas["ConsoleSignInRequest"], options?: { config?: VelexisNextConfig }): Promise<ConsoleStaffSession>;
/** Sign the staff member out (`console.auth.signOut`, errors ignored) and clear the staff cookies. */
export declare function signOutStaff(options?: { config?: VelexisNextConfig; scope?: "current" | "all" }): Promise<void>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Guest booking tokens                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** Cookie name of a guest booking token: `vx_bt_<bookingId>`. */
export declare function bookingTokenCookieName(bookingId: string, options?: { config?: VelexisNextConfig }): string;
/**
 * Store a guest booking token (from `checkout.complete` / `bookings.lookup` / a `SUPPLIER_TIMEOUT` error's details) in an
 * httpOnly cookie that expires with the token (default 24 h when `expiresAt` is unknown). Server actions / route handlers.
 * {@link captureBookingToken} does this directly from a completion, lookup result or error.
 */
export declare function setBookingTokenCookie(bookingId: string, token: string, expiresAt?: string | Date | null, options?: { config?: VelexisNextConfig }): Promise<void>;
/** The guest booking token of a booking, if this browser has one. */
export declare function getBookingTokenCookie(bookingId: string, options?: { config?: VelexisNextConfig }): Promise<string | undefined>;
/** Delete a guest booking token cookie. */
export declare function clearBookingTokenCookie(bookingId: string, options?: { config?: VelexisNextConfig }): Promise<void>;
/** Every guest booking this browser holds a token for ("bookings on this device"). */
export declare function listBookingTokenCookies(options?: { config?: VelexisNextConfig }): Promise<Array<{ bookingId: string; token: string }>>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Locale / currency                                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

/** Persist the visitor's locale (`vx_locale`, 1 year, readable by JS). Validate it against `storefront.locales` first. */
export declare function setLocaleCookie(locale: string, options?: { config?: VelexisNextConfig }): Promise<void>;
/** Persist the display currency (`vx_currency`). Validate it against `storefront.currencies` first. */
export declare function setCurrencyCookie(currency: string, options?: { config?: VelexisNextConfig }): Promise<void>;
