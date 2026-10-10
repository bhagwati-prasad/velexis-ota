# Next.js integration guide (`@velexis/ota-sdk/next` + `@velexis/ota-sdk/react`)

This guide shows how to build an OTA storefront **and** its staff console with Next.js 15 (App Router) on Velexis.
Declarations: `sdk/src/next.d.ts`, `sdk/src/react.d.ts`. A complete, type-checked example lives in
`examples/next-storefront/`.

```
Browser ──(public data, pk_…)──────────────────────────────▶ api.velexis.travel
   │
   ├─(customer / guest calls)─▶ /api/velexis/[...path]  ──(sk_… + httpOnly cookie token + visitor IP)──▶ api.velexis.travel
   │                                                     ──(pk_… + Origin, when the call carries no token)─▶
   ├─(sign-in / sign-up …)────▶ /api/auth/[action]      ──(sk_… + visitor IP, sets httpOnly cookies)──────▶ api.velexis.travel
   └─(server actions)─────────▶ Next.js server           ──(sk_… + cookie token + visitor IP)─────────────▶ api.velexis.travel
middleware.ts: tenant host → keys, session refresh, /account + /console protection
```

---

## 1. Install

```bash
npm install @velexis/ota-sdk
```

Next.js ≥ 15.0 and React ≥ 18.3 (React 19 recommended: `useActionState`). The SDK uses the platform `fetch`, so it runs
in server components, server actions, route handlers, the edge middleware and client components. The `next` subpath
ships a `react-server` build (server helpers) and a browser build (only `createBrowserClient` and the types); calling a
server helper from a client component throws.

## 2. Environment variables and keys

| Variable | Where | Value |
|---|---|---|
| `VELEXIS_SECRET_KEY` | server only | Storefront `sk_test_…` / `sk_live_…` with key scope **`storefront`** (refused on every console operation, so an unguarded server action can never reach the back office). **Never** prefix with `NEXT_PUBLIC_`. |
| `VELEXIS_CONSOLE_SECRET_KEY` | server only, optional | `sk_…` with key scope **`console`** (console calls only with a staff token). Used by `createServerClient({ as: "staff" })` and the staff helpers; falls back to `VELEXIS_SECRET_KEY`. |
| `NEXT_PUBLIC_VELEXIS_PUBLISHABLE_KEY` | browser | `pk_test_…` / `pk_live_…`. Allow-list your storefront origins for it in the Velexis portal (direct browser calls **and** token-less proxied calls use it). |
| `VELEXIS_API_URL` | server | Default `https://api.velexis.travel` (or the OTA's custom API host). |
| `NEXT_PUBLIC_VELEXIS_API_URL` | browser | Same host, for direct public calls from the browser. |
| `VELEXIS_HOSTING_KEY` | server, optional | Multi-domain hosting (section 10): one `hk_…` for every OTA domain of the deployment. |
| `VELEXIS_TENANTS` | server, optional | Multi-domain hosting without a hosting key: JSON host → `{ tenantKey, secretKey, consoleSecretKey?, publishableKey, baseUrl? }`. |

Test keys use the OTA's Amadeus **test** connection; live keys the production one. `storefront.environment` /
`console.auth.me().tenant.environment` tell the UI which one is active — show a banner in test. Never use a
`console:automation` key in a web deployment: it allows console calls without a staff token.

## 3. Files to add

| File | Content |
|---|---|
| `lib/velexis-config.ts` | `export const velexisConfig = defineVelexisConfig({ tenants?, signInPath, consoleSignInPath, endUser?, cookies? })` — imported by server code **and** middleware, so keep it free of server-only imports. |
| `lib/velexis.ts` | Thin wrappers: `customerClient()` = `createServerClient({ config, as: "customer" })`, `anonymousClient()` (`as: "anonymous"`), `staffClient()` (`as: "staff"`), `getStorefront()` (public client + `storefrontCacheOptions`), `mustBeCustomer()` / `mustBeStaff()`. Add `import "server-only"`. |
| `middleware.ts` | `velexisMiddleware({ config, customerPaths: ["/account"], consolePaths: ["/console"], publicPaths: [...] })` + a literal `config.matcher`. |
| `app/api/velexis/[...path]/route.ts` | `export const { GET, POST, PUT, PATCH, DELETE } = createProxyHandler({ config })`. |
| `app/api/auth/[action]/route.ts` | `export const { POST } = createAuthHandlers({ config })`. |
| `app/providers.tsx` (`"use client"`) | `createBrowserClient({ publishableKey })` once (`useState(() => …)`), `<VelexisProvider client storefront>`. |

```tsx
// app/layout.tsx (server component)
const [sf, tenant] = await Promise.all([getStorefront(), getTenant({ config: velexisConfig })]);
return (
  <html lang={sf.defaultLocale}>
    <body>
      <Providers publishableKey={tenant.publishableKey} storefront={sf}>{children}</Providers>
    </body>
  </html>
);
```

## 4. Middleware

```ts
// middleware.ts
import type { NextRequest } from "next/server";
import { velexisMiddleware } from "@velexis/ota-sdk/next";
import { velexisConfig } from "@/lib/velexis-config";

const handler = velexisMiddleware({
  config: velexisConfig,
  customerPaths: ["/account"],
  consolePaths: ["/console"],
  publicPaths: ["/account/sign-in", "/account/sign-up", "/console/sign-in"],
});
export function middleware(req: NextRequest) { return handler(req); }
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|api/velexis).*)"] };
```

The helpers take a structural `VelexisNextRequest` and return a Web `Response`: that is their public contract
(`next.d.ts` does not import `next/server`, whose internal declarations do not compile with `skipLibCheck: false`). A
`NextRequest` is assignable to it and a `NextResponse` is a `Response`, as the example's `middleware.ts` shows.

What it does, in order:

1. **Tenant**: resolves the host with `config.tenants` (multi-domain) and sets the trusted request header
   `x-velexis-tenant` (a client-sent copy is always removed). Unknown host → 404 (`unknownTenant`).
2. **Customer session**: the `vx_at` cookie expires 60 s before the access token; when it is gone and `vx_rt` exists the
   middleware calls `auth.refresh`, writes the rotated cookies on the response **and** onto the current request, so the
   server components of this very render see a valid token. `REFRESH_TOKEN_INVALID` / `REFRESH_TOKEN_REUSED` clear the
   cookies. Refresh failures never block public pages. Concurrent refreshes (tabs, prefetch) are safe: the API returns
   the same pair for 10 s.
3. **Staff session** on `/console/*`: same with `console.auth.refresh` and the `vx_staff_*` cookies.
4. **Protection**: `/account/*` without a customer session → `signInPath?next=…`; `/console/*` without a staff session →
   `consoleSignInPath?next=…`. Roles/permissions are checked in pages and actions (`requireStaff`), not in middleware.

Exclude `/api/velexis` from the matcher: the proxy refreshes tokens itself.

## 5. Server vs client: who calls what

| Code | Client | Key | Token | Use for |
|---|---|---|---|---|
| Server component | `createServerClient()` | storefront secret (publishable for token-less `checkout.*`) | customer cookie (or none) | pages that render personal or priced data |
| Server component (cacheable) | `createPublicServerClient()` | storefront secret | none, reads no cookies | storefront config, reference data, SEO pages |
| Server action / route handler | `createServerClient()` | storefront secret (publishable for token-less `checkout.*`) | customer cookie; writes rotated cookies | every mutation: search, price, checkout steps, completion, lookup, cancel, profile |
| Console page / action | `createServerClient({ as: "staff" })` | console secret | staff cookie (**required**) | `console.*`, `flights.availability`, raw Amadeus |
| Guest booking pages | `createServerClient({ bookingId })` | storefront secret | `vx_bt_<bookingId>` cookie | booking detail, documents, update, cancel, extras |
| Client component | `createBrowserClient()` (via `useVelexis()`) | publishable (direct) / proxy | httpOnly cookies, added by the proxy | autocomplete, results filtering, upsell, extras, payment polling, ticketing polling |

Rules:

- **Data scope.** Publishable keys, plain secret keys and customer tokens all get **customer scope**: selling amounts
  only (also inside `amadeus` blocks), no `netPrice` / `markup` / `diagnostics`, and customer-bound searches / priced
  offers are readable only with that customer's token. Results of customer and anonymous server clients can therefore
  be passed to client components as they are. Console scope needs a staff token (or a secret key sending
  `X-Velexis-Scope: console`, never in a storefront). `toCustomerView()` is only for staff-client data shown to
  customers: it drops `netPrice`, `markup`, `diagnostics`, `pricing`, `supplier` and the net `amadeus` block of
  console-priced objects, and returns `CustomerView<T>` (those properties removed / optional in the type).
- **Ownership.** The API lets any secret key of the OTA read and change customer checkouts and payments. So customer /
  anonymous server clients send `checkout.*` calls that carry no customer token with the **publishable** key (plus
  the storefront `Origin`), and the proxy does the same for token-less browser calls: a signed-out visitor who opens
  `/checkout/<someone else's chk_…>` gets `404`, guest checkouts keep working by their unguessable id. Searches, priced
  offers and bookings are protected by the API itself (customer or booking token required).
- **End users.** Every call the helpers make for a request carries the visitor's IP and user agent
  (`X-Velexis-End-User-IP` / `-Agent`, honoured for secret and hosting keys): per-IP rate limits (sign-up, sign-in,
  reset e-mails, autocomplete, guest lookup) and sign-in lockouts apply per visitor, not to your server. Configure
  where the IP comes from with `endUser: { ipHeader, trustedHops }` (default: the last `x-forwarded-for` entry,
  written by your own edge). `createPublicServerClient()` reads no headers — pass `endUser: await getEndUser()` when it
  acts for a visitor, or use an anonymous server client.
- **Tokens never reach JavaScript.** Token-returning calls (`auth.signIn/signUp/refresh/resetPassword/changePassword`,
  `console.auth.signIn/refresh`) run in route handlers or server actions. Guest booking tokens (`checkout.complete`,
  its `504 SUPPLIER_TIMEOUT`, `bookings.lookup`) go into `vx_bt_<bookingId>` cookies: `completeCheckout()` /
  `captureBookingToken()` in server actions, `captureBookingTokens` in the proxy.
- **Server actions are public HTTP endpoints.** Re-check identity in each one (`requireCustomer`, `requireStaff`) and
  validate inputs; never trust IDs posted by the client for authorisation — the API checks ownership with the token.
- **Return data, not errors** (section 5.1).
- **`redirect()` outside `try`.** `redirect()` throws a control-flow error; compute the target inside `try/catch` and
  redirect after it (`toActionError` and `completeCheckout` re-throw Next.js control-flow errors as a safety net).
- **Idempotency.** State-changing POSTs get an `Idempotency-Key` automatically; pass a **stable** one for actions that
  must never run twice: `checkout.complete` (`complete-${checkoutId}-${paymentId}`, the `completeCheckout()` default),
  `bookings.cancel` (`cancel-${bookingId}-${version}`), console `issue` / `cancel` (one key per click, generated when
  the form renders).
- **Optimistic locking.** Render the resource `version` into the form and send it as `ifMatch`; on
  `PRECONDITION_FAILED` / `VERSION_CONFLICT` reload (`router.refresh()`) and let the user retry.

### 5.1 The RSC / server-action boundary

Only plain data crosses from server components to client components and back from server actions:

| Value | Problem | Use |
|---|---|---|
| `Page<T>` (`next()`, async iterator) | methods are not serialisable | `serializePage(page)` / `toPageData(page)` → `PageData<T>`; `toResultsPageData(page)` for flight results |
| `VelexisError` and subclasses | class instances do not survive | `toActionError(e)` → `VelexisErrorData` (`code`, `status`, `fieldErrors`, `details`, `requestId`, `retryable`); `fromErrorData(data)` rebuilds the class in the client |
| `CheckoutCompletion.bookingToken`, `error.details.bookingToken` | guest secret | stored in a cookie by `completeCheckout()` / `captureBookingToken()`; `toActionError` always removes `details.bookingToken` / `bookingTokenExpiresAt` |

`fromErrorData` maps by status like the SDK: 400/422 `ValidationError`, 401 `AuthenticationError`, 402
`PaymentError`, 403 `PermissionError`, 404 `NotFoundError`, 409 `ConflictError` (`PriceChangedError`, `SoldOutError`),
410 `ExpiredError`, 429 `RateLimitError`, 424/502/504 `SupplierError`, 500/503 `ServerError`. Codes without a
dedicated class — `412 PRECONDITION_FAILED`, `423 ACCOUNT_LOCKED` — are a plain `VelexisError`: match on `code`.

```ts
// app/checkout/[checkoutId]/actions.ts
"use server";
import { completeCheckout, toActionError } from "@velexis/ota-sdk/next";

export async function completeCheckoutAction(params: CompleteCheckoutParams) {
  return completeCheckout(params, { config: velexisConfig }); // → useCheckout({ completeAction })
}

export async function saveContactsAction(checkoutId: string, version: number, contacts: ContactInput[]) {
  try {
    return { ok: true, data: await (await customerClient()).checkout.setContacts({ checkoutId, ifMatch: version, contacts }) };
  } catch (e) {
    return { ok: false, error: toActionError(e) }; // CONTACT_DATA_INVALID → error.fieldErrors
  }
}
```

### Sessions and cookies

| Cookie | Content | Attributes |
|---|---|---|
| `vx_at` | customer access token | httpOnly, Secure, SameSite=Lax, path `/`, expires 60 s before the token |
| `vx_rt` | customer refresh token (rotating) | httpOnly, Secure, SameSite=Lax, path `/`, 12 h or 30 days (`rememberMe`) |
| `vx_session` | `"1"` hint that a customer session exists | **not** httpOnly; contains no secret; lets the browser client route customer-optional calls via the proxy |
| `vx_staff_at` / `vx_staff_rt` | staff tokens | httpOnly, Secure, **SameSite=Strict**; refresh token path `/console` |
| `vx_bt_<bookingId>` | guest booking token | httpOnly, Secure, SameSite=Lax, expires with the token (≥ 30 days from checkout, 24 h from lookup) |
| `vx_locale` / `vx_currency` | visitor choice | readable; validate against `storefront.locales` / `storefront.currencies` |

Customer auth from the browser uses `useAuth()` → `/api/auth/sign-in` etc.; from a form it can equally be a server
action (`signInCustomer()`, or `auth.signUp` with an anonymous server client + `setSessionCookies()`). Staff sign-in is
a server action with `signInStaff()` (`STAFF_MFA_REQUIRED` → show the TOTP field). `getSession()` /
`getStaffSession()` are deduplicated per request; `requireCustomer()` / `requireStaff(roles | { roles, permissions })`
redirect when signed out.

### The proxy (`/api/velexis/[...path]`)

The browser client sends calls that need a token — and `checkout.complete` / `bookings.lookup`, which return guest
booking tokens — to the proxy (`mode: "hybrid"`, the default; customer-optional calls go direct while signed out). The
proxy:

- forwards only the **allow-list** (`DEFAULT_PROXY_ALLOW_LIST`: storefront, reference, `auth.getSession`, anonymous
  auth forms, `account.*`, `flights.*` except `availability`, `checkout.*` incl. `updatePayment`, `bookings.*` incl.
  extras after booking); `/v1/console/**`, `/v1/flight-availabilities`, `storefront.resolve` and token-returning auth
  endpoints are refused even if configured;
- picks the key per call (`forwardKey: "auto"`): calls carrying the customer access token or a guest booking token, and
  public / anonymous-form calls, go with the tenant's **secret** key plus the visitor's IP; customer-optional calls
  **without** a customer token (signed-out search, pricing, checkout, payment) go with the **publishable** key and the
  storefront `Origin`. A signed-out request therefore gets exactly the ownership checks of a browser call: another
  customer's checkout or payment answers `404` instead of being readable with the secret key;
- answers `401 UNAUTHENTICATED` itself for `customer` rules without a session and `customer-or-booking` rules without
  a customer or guest token;
- runs **body guards** (`DEFAULT_PROXY_GUARDS`): rejects `amadeusFlightOffers` on pricing and oversized checkout
  `metadata`;
- refreshes an expired customer token and sets the rotated cookies on the response;
- moves guest `bookingToken`s into httpOnly cookies and nulls them in the body (`captureBookingTokens`):
  `checkout.complete` `201`, its `504 SUPPLIER_TIMEOUT` (`error.details.bookingToken` of the pending booking — the guest
  can then poll it with `useTicketingStatus`), `bookings.lookup`;
- never forwards client-sent `X-Api-Key`, `Authorization`, `X-Booking-Token`, `X-Velexis-Scope`, `X-Velexis-Host` or
  `X-Velexis-End-User-*`; checks `Origin` on state-changing methods, limits body size, never caches
  (`Cache-Control: no-store`) and passes `X-Request-Id` through. Responses are customer scope; `redactConsoleFields`
  stays on as defence in depth.

### React hooks (`@velexis/ota-sdk/react`)

All hooks need `<VelexisProvider client={createBrowserClient()}>` and return `{ data, error, loading }` (+ actions);
`error` is a `VelexisError`; aborted requests are never reported. Hand server-rendered data in through `initial…`
options (plain data only).

| Hook | Wraps | Notes |
|---|---|---|
| `useStorefront()` | `storefront.get` | provider snapshot; `features`, `formatMoney()` |
| `useSession()` / `useAuth()` | `/api/auth/*`, proxied `auth.getSession` | `status`, `customer`; `signIn/signUp/signOut` with `pending/error` |
| `useLocationSearch(keyword, opts)` | `reference.locations.search` | debounce (200 ms), min length 2, abort stale |
| `useFlightSearch(opts)` | `flights.search`, `getSearch`, `listResults` | `create` (sync, or `resultOptions.async` → `pending` polled per `retryAfterSeconds`), `setFilters/setSort/clearFilters` (several time windows per itinerary are ORed), `loadMore/hasMore`, `facets`, `expired`, `onQueryChange` for URL sync |
| `useOffer(id)` / `useUpsell(id)` | `flights.getOffer` / `flights.upsell` | upsell `select(offerId)`, lazy `load()` |
| `usePricing()` | `flights.price`, `getPricedOffer`, `getFareRules` | `priceChange` + `acceptPriceChange()` |
| `useAncillaries(pricedOfferId)` | `flights.getAncillaries` | local `selections`, `select/remove/optionsFor`, `estimatedTotal` |
| `useCheckout(id, { completeAction })` | `checkout.*` | `setTravelers/Contacts/Ancillaries/Remarks`, `createPayment`, `updatePayment` (card brand → fee), `waitForPayment`, `complete()` → explicit outcome |
| `useBookings(timeframe)` / `useBooking(id)` | `bookings.list` / `bookings.*` | `loadMore`; `update`, `quoteCancellation`, `cancel`, documents, ticketing polling |
| `useTicketingStatus(id)` | `bookings.getTicketingStatus` | polls per `pollAfterSeconds` until final (guests via their `vx_bt_` cookie) |

## 6. Caching rules

| Data | Rule |
|---|---|
| `storefront.get` | Cacheable: `storefrontCacheOptions(tenantKey)` = `{ next: { revalidate: 300, tags: ["velexis:storefront:<tenant>"] } }`; call `revalidateTag()` when staff change settings. Use `createPublicServerClient()` so the root layout does not read cookies. |
| `reference.*` | Cacheable: `referenceCacheOptions()` (24 h, tag `velexis:reference`); airports/airlines up to 7 days. Client autocomplete goes direct to the API (CDN-cacheable). |
| `flights.*` (search, results, offers, upsell, pricing, ancillaries, fare rules) | **Never cache** — live, priced, time-limited (`expiresAt`). The SDK sends `cache: "no-store"`; never pass `next.revalidate`. |
| `checkout.*`, `bookings.*`, `account.*`, `auth.*` | **Never cache** — personal / priced. After a mutation `revalidatePath()` the pages that show it. |
| `console.*` | **Never cache.** |
| Pages | A page that calls `createServerClient()` reads cookies and is dynamic. Keep public pages (home, SEO landing pages) on `createPublicServerClient()` and load the session client-side (`useSession()`) if the header needs it. |

Do not put priced data into `unstable_cache`, `React.cache` across requests, or a CDN. `React.cache` **within** one
request (as `getSession()` does) is fine.

## 7. The storefront flow

| Page | Server | Client | SDK |
|---|---|---|---|
| `/` search form | storefront (cached) | `LocationInput` → `useLocationSearch` (debounced, aborts stale requests) | `reference.locations.search` |
| submit | server action `searchFlights` (`timeoutMs: 60_000`; or `resultOptions.async` on hosts with short function limits) → `redirect(/flights/search?searchId=…)` | `useActionState` pending UI | `flights.search` (simple mode; advanced = full Amadeus body) |
| `/flights/search` | `getSearch` + first `listResults` page (skipped while `pending`) → `toResultsPageData()` | `useFlightSearch`: filters / sort / facets / `loadMore`, async-search and expiry polling, URL sync | `flights.getSearch`, `flights.listResults` |
| `/flights/offers/[id]` | `getOffer` (full view, customer scope) | `useUpsell` (fare families) + "Continue" server action | `flights.getOffer`, `flights.upsell` |
| continue | server action: `flights.price({ offerIds, include, expectedTotal })` → `checkout.create` → redirect; `PriceChangedError` → show & accept (`e.pricedOfferId`) | | `flights.price`, `checkout.create` |
| `/checkout/[id]` | `checkout.get`, `flights.getAncillaries(basePricedOfferId)`, saved travellers (`serializePage`) | travellers & contacts → server actions; extras → `useCheckout().setAncillaries` (re-priced, `expectedTotal`); payment → card type from `storefront.payment.pspCardBrands` (`amadeus` brand sent as `card.brand`), `createPayment` + PSP SDK, `updatePayment` when the card type changes, `waitForPayment`; completion → `completeCheckout()` server action via `useCheckout({ completeAction })` | `checkout.*` |
| `/bookings` | `bookings.list({ timeframe })` tabs, cursor links; guests: `listBookingTokenCookies()` | | `bookings.list` |
| `/bookings/[id]` | `bookings.get` (customer or guest cookie), documents, events | contacts update, cancel (quote → confirm with `reasonCode` + `expectedRefund`), `useTicketingStatus`; extra bags after booking: server actions `bookings.getAncillaries` → `bookings.createPayment` → `bookings.addAncillaries` | `bookings.*` |
| `/bookings/lookup` | | server action (anonymous client) → `captureBookingToken(result)` → redirect | `bookings.lookup` |
| documents | route handler → `getDocumentDownloadUrl` → 302 | | |

`checkout.complete` outcomes that must **never** be retried as a new booking: `SUPPLIER_TIMEOUT` (a pending booking
exists — `details.bookingId`; show it and poll) and `CHECKOUT_ALREADY_COMPLETED`. `useCheckout().complete()` returns
them as explicit outcomes (`pending`, `already_completed`). For guests, `pending` can be polled only because the pending
booking's token went into `vx_bt_<bookingId>` — the proxy (default path) and `completeCheckout()` (server action) both
do that; a hand-written action must call `captureBookingToken(e)` before returning `toActionError(e)`.

## 8. The console

- All console code is server-side: pages call `requireStaff({ permissions })`, mutations are server actions that call
  `requireStaff` again, then `createServerClient({ as: "staff" })` (console secret key + staff cookie). The staff client
  refuses to run without the staff cookie, and the API refuses key-only console calls unless the key has the
  `console:automation` scope — never deploy such a key with the web app.
- Typical pages: bookings work list (`console.bookings.list` filters → URL search params, cursor links), booking detail
  (`get`, `retrieve` for the verbatim Amadeus order, `patch`, `issue`, `cancel`, `resync`, `addNote`), PNR lookup
  (`findByRecordLocator` + `import`), queues (`queues.list` — first page reads Amadeus and stores a snapshot, `cursor`
  pages the snapshot), availability (`flights.availability` with the staff token) and raw offers
  (`console.amadeus.getFlightOffers`, net prices; price for selling with `flights.price({ amadeusFlightOffers })`).
- `bookings.patch` merges `remarks` (send only the new one), `travelers` and `contacts` with the stored order;
  `ticketingAgreement` takes `option` + `delay` (`dateTime` is read-only).
- Hide actions with `booking.consoleActions` and `me.permissions`; the API enforces them anyway (`FORBIDDEN`).

## 9. Errors

Match on `error.code` (stable) rather than messages. Common handling:

| Code | UI |
|---|---|
| `OFFER_EXPIRED`, `SEARCH_EXPIRED`, `CHECKOUT_EXPIRED` | "Prices expired" + search again (`search.criteria.request`) |
| `SEARCH_NOT_COMPLETED` | async search still running (`details.retryAfterSeconds`) or failed — poll `getSearch` / search again |
| `PRICE_CHANGED` (`PriceChangedError`) | show `oldPrice` → `newPrice`, continue with `pricedOfferId` |
| `SOLD_OUT` | back to results |
| `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID`, `VALIDATION_FAILED`, `CHECKOUT_INCOMPLETE` | inline messages from `fieldErrors[].path` (JSON pointers) |
| `PAYMENT_NOT_UPDATABLE` | the payment left `requires_payment_method` — create a new payment |
| `UNAUTHENTICATED`, `TOKEN_EXPIRED` | signed-out UI / redirect to sign-in |
| `PRECONDITION_FAILED` (412), `VERSION_CONFLICT` | reload and retry |
| `ACCOUNT_LOCKED` (423) | "locked until `details.lockedUntil`" + password reset |
| `SUPPLIER_TIMEOUT` on completion / cancellation / issue | outcome unknown: poll / resync, never repeat blindly |
| `RATE_LIMITED` | wait `retryAfterSeconds` |
| `TENANT_SUSPENDED` | maintenance page (`app/error.tsx`) |
| `HOST_NOT_ALLOWED` | hosting-key setup: the host is not a verified domain of an OTA the key may act for |

Log `error.requestId`; staff can find the Amadeus call with `console.supplierRequests.list({ requestId })`.

## 10. Multi-tenant storefront hosting

### A. One Next.js app per OTA (recommended default)

One deployment per OTA with its own `VELEXIS_SECRET_KEY` / `NEXT_PUBLIC_VELEXIS_PUBLISHABLE_KEY` and domain. Simplest
isolation (separate env, logs, cache, rate limits, deploys), custom code per OTA is easy. Omit `tenants` from the config.

### B. One Next.js app serving many OTA domains

For platforms hosting many white-label storefronts from one codebase, use a Velexis **hosting key**:

```ts
// lib/velexis-config.ts
export const velexisConfig = defineVelexisConfig({
  tenants: tenantsFromHostingKey(), // VELEXIS_HOSTING_KEY; storefront.resolve per host, cached for cacheTtlSeconds
});
```

- The middleware maps `host` → tenant (`storefront.resolve`: `tenantKey`, `publishableKey`, custom `apiBaseUrl`) and
  sets the trusted `x-velexis-tenant` header; `createServerClient`, `getTenant`, the proxy and the auth handlers then
  call with the hosting key plus `X-Velexis-Host` — the API treats that like the OTA's secret key. The app holds one
  secret per environment instead of every OTA's secret key. Unknown or unverified hosts resolve to 404.
- Alternative without a hosting key: `tenants: tenantsFromEnv("VELEXIS_TENANTS")` (or a resolver over your own KV
  store) with each OTA's `secretKey` / `consoleSecretKey` / `publishableKey` — keep that map in a secret store and
  rotate per tenant.
- The root layout passes the tenant's **publishable** key to `createBrowserClient`, because `NEXT_PUBLIC_*` variables
  are build-time constants.
- Cache per tenant: `storefrontCacheOptions(tenant.tenantKey)` tags `velexis:storefront:<tenant>`; never share cached
  storefront data between hosts. Reference data is shared (`velexis:reference`).
- Cookies are host-only by default (no `domain` attribute), so sessions never leak between OTA domains. Do not set a
  parent `domain` when tenants share a parent domain (`acme.example.com`, `globex.example.com`).
- Each publishable key's origin allow-list must contain the tenant's domains.
- Choose A when OTAs need custom code, separate compliance boundaries or independent release cycles; choose B for
  configuration-only white-label storefronts.

## 11. Security checklist

- [ ] `VELEXIS_SECRET_KEY` scoped `storefront`, console key scoped `console` (no `console:automation` in the web app);
      server env only; no `NEXT_PUBLIC_` prefix; `import "server-only"` in `lib/velexis.ts`.
- [ ] Tokens only in httpOnly cookies (`Secure`, `SameSite=Lax` customers / `Strict` staff); never in `localStorage`,
      URLs, props or server-action return values; guest booking tokens likewise (`completeCheckout`,
      `captureBookingToken`, proxy `captureBookingTokens`; `toActionError` drops `details.bookingToken`).
- [ ] Every server action and route handler re-checks identity/permissions (`requireCustomer`, `requireStaff`).
- [ ] Console server actions use `as: "staff"` (no key-only calls); console pages never import into client components.
- [ ] Storefront code never sends `X-Velexis-Scope: console`; staff-client data shown to customers goes through
      `toCustomerView()` or is re-read in customer scope.
- [ ] Proxy keeps `forwardKey: "auto"` (token-less customer-optional calls with the publishable key), the default
      allow-list and guards.
- [ ] `endUser.ipHeader` / `trustedHops` match your hosting edge, so per-IP limits and lockouts apply per visitor.
- [ ] Auth handlers and proxy keep the same-origin check (CSRF); add your production origins to `allowedOrigins` only if needed.
- [ ] `next` redirect parameters are validated (relative paths starting with `/`, not `//`).
- [ ] No priced or personal data in caches (section 6); `Cache-Control: no-store` on personal route handlers.
- [ ] Publishable key origin allow-list configured; separate test/live keys per environment.
- [ ] Stable idempotency keys for completion, cancellation, issuance; never re-book after `SUPPLIER_TIMEOUT`.
- [ ] `ifMatch` sent for booking/profile/checkout updates.
- [ ] Payments: card data only in the PSP's UI; show the card fee before confirming (`updatePayment` when the card type
      changes); follow `redirectUrl` flows.
- [ ] Error pages show `requestId`/digest, not raw API messages, in production.
- [ ] Multi-tenant: host → tenant resolution in middleware only, client `x-velexis-tenant` stripped, per-tenant cache tags.

## 12. Known limitations (tracked as SDK/API findings)

- SDK `Page` objects and error classes have no `toJSON()` in `shared.d.ts`, so they still need `serializePage` /
  `toActionError` at the RSC boundary.
- The `ErrorCode` union of `shared.d.ts` does not list the area codes yet (`PASSWORD_TOO_WEAK`, `STAFF_MFA_REQUIRED`,
  `CHECKOUT_ALREADY_COMPLETED`, `SEARCH_NOT_COMPLETED`, `HOST_NOT_ALLOWED` …); they work through its `string` fallback
  without autocompletion. `shared.d.ts` also has no error class for `412` / `423` (plain `VelexisError`).
- No seat map: chargeable seats are chosen by typing a seat number.
