# Build your own frontend

This guide is for OTAs that want a storefront of their own instead of, or next to, the hosted one: built in any framework (Next.js, React, Angular, Vue or plain HTML), hosted on their own domain, and calling the Velexis OTA API at `https://api.ota.example.com` through the JS SDK `@velexis/ota-sdk` ([`decisions.md`](../../../docs/mvp/decisions.md) §2). It explains the keys and origins, where tokens may live, what the hosted storefront has that your frontend does not, the shopping, checkout and account flows with Stripe, errors, retries, pagination and idempotency keys, and what to check before going live. The hosted storefront in this folder is the reference implementation (§13.1).

Related: [storefront README](../README.md), [SDK README](../../sdk/README.md), [`../../sdk/docs/extensions.md`](../../sdk/docs/extensions.md), SDK guides [B1–B3](../../../docs/velexis-sdk/sdk/docs/) (Next.js code, the same method calls), [OpenAPI contract](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml), [checkout with Stripe](../../docs/flows/checkout-stripe.md), [platform: API keys](../../../platform/docs/flows/api-keys.md), [scope §1.2](../../docs/scope.md#12-programs).

The samples use the placeholder hosts of [`decisions.md`](../../../docs/mvp/decisions.md) §4. Replace `https://api.ota.example.com` with the API URL Velexis gives you, `pk_test_…` with your publishable key and `https://platform.example.com` with the portal's address.

## 1. What is different from the hosted storefront

| Topic | Hosted storefront | Your own frontend |
|---|---|---|
| Host | `<key>.ota.example.com` or a verified custom domain, served by Velexis | Your domain, your hosting |
| API | Same-origin `/api` through Caddy | `https://api.ota.example.com` |
| Credential | Edge credential added by Caddy | Publishable key `pk_…` (browser, allowed origins) or secret key `sk_…` scoped `storefront` (your server) |
| SDK mode | Cookie mode (`session: "cookie"`) | Token mode (`publishableKey`) or server mode (`secretKey`); cookie mode needs the edge and is not available to you |
| Customer sessions | httpOnly cookies set by the API, CSRF header | Access and refresh tokens that **you** keep (recommended: httpOnly cookies set by your own server, §2.1) |
| Guest access to a booking | `__Host-vx_bt` cookie | The `bookingToken` that `checkout.complete` and `bookings.lookup` return, sent as `X-Booking-Token` |
| Payment methods | Stripe and the airline card | **Stripe only**: the airline card is refused to keys (`403 SCOPE_NOT_ALLOWED`, [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)); `storefront.get` never lists `airline_card` and gives `payment.airlineCard: null` |
| E-mail links | To the hosted storefront's pages | Also to the hosted storefront's pages (§8.3) |
| Branding, pages | Runtime settings | Yours; `storefront.get` still gives currencies, features, legal versions and the payment configuration |

Also not available to keys in the MVP (the methods exist and answer `501 NOT_IMPLEMENTED` as a `ServerError`, [scope §3](../../docs/scope.md#3-the-96-contract-operations)): saved travellers, account preferences and data exports, extras after booking (`bookings.getAncillaries`, `.createPayment`, `.addAncillaries`), `storefront.resolve` and hosting keys. An asynchronous search (`resultOptions.async`) answers `403 FEATURE_DISABLED`.

## 2. Choose an architecture

### 2.1 Your own server with a secret key (recommended)

A server of yours (Next.js, Nuxt, Angular SSR, Express, a small Node or edge function) holds a secret key `sk_…` scoped `storefront` and calls the API; the browser talks only to your server. The customer's access and refresh tokens stay in httpOnly cookies on your domain, so no script on your pages can read them, and the browser never needs the API's CORS answers (§2.4). Your server forwards each visitor's address with `endUser`, so the API's rate limits count the visitor, not your server. Sample: §8.

### 2.2 Browser app with a publishable key and a bundler

A single-page app built with a bundler (Vite, webpack, esbuild, Rollup) imports the ESM build and calls the API from the browser with a publishable key `pk_…`. It is the simplest to host, but the customer's tokens live in the page's JavaScript, which is your risk to accept: keep them in memory only (§8.4), never in `localStorage` or `sessionStorage`. The API checks every call's `Origin` against the key's allowed origins (§3) and opens its answers to the origins the key lists (§2.4). Samples: §7, §8.4.

### 2.3 Plain HTML with the IIFE

Small sites load `velexis-sdk.iife.js` with a `<script>` tag and use `window.Velexis` with a publishable key, as §2.2, with the same CORS answers (§2.4). Sample: §6.

### 2.4 Browser calls to the API from your own origin

Your pages and the API are on different origins, so the browser applies CORS to every call. Each SDK call carries `X-Api-Key` (and `Content-Type`, `Idempotency-Key`, `Authorization` or `X-Booking-Token` where they apply), so the browser first asks with an `OPTIONS` preflight. The API answers every preflight with `204`, your origin in `Access-Control-Allow-Origin` and every method and header the SDK sends, and the browser keeps that answer for up to two hours. Those headers are the only ones a browser may send: a header of your own (the client's or a call's `headers` option) that the API does not know makes the browser refuse the call before it is sent. The actual answer is opened to your page only when the publishable key lists your page's origin (§3): it then carries `Access-Control-Allow-Origin` with that origin and exposes `X-Request-Id`, `Retry-After`, `ETag` and `Location`, so the SDK's errors keep their `requestId` and `retryAfterSeconds`, the errors of the call included (`401 UNAUTHENTICATED`, `403 TENANT_SUSPENDED`, `429 RATE_LIMITED`, a validation error).

Your page cannot read an answer that the API gives before it accepts your key: an origin the key does not list (`403 ORIGIN_NOT_ALLOWED`), a wrong, revoked or expired key (`401 INVALID_API_KEY`), a body it cannot parse or that is too large, or a path that is no operation; nor the proxy's own `503 SERVICE_UNAVAILABLE` while the API restarts. The browser reports a CORS error in its console instead, and the SDK throws a `ConnectionError` (`NETWORK_ERROR`, §10.1) once its retries are spent (§10.2); the browser's network panel shows the answer and its code. Check the key and its allowed origins in the portal when every call fails this way. The API never allows credentials: no cookie travels to it, and the SDK calls it with `credentials: "omit"`.

A secret key never goes to a browser: `createVelexisClient({ secretKey })` throws a `TypeError` when `document` exists.

## 3. Keys and allowed origins

Owners and admins of the OTA manage keys in the portal: `https://platform.example.com/otas/<tenantId>/api-keys` ([platform: API keys](../../../platform/docs/flows/api-keys.md)).

| Key | Where | Settings | Rules |
|---|---|---|---|
| Publishable `pk_test_…` / `pk_live_…` | Browser code (§2.2, §2.3) | Allowed origins: exact origins such as `https://<your domain>`; `http://localhost:<port>` only for test keys; no wildcards | Customer scope only. A call whose `Origin` is not listed answers `403 ORIGIN_NOT_ALLOWED`; with no origin listed, the key works only from code that sends no `Origin` (a server) |
| Secret `sk_test_…` / `sk_live_…` | Your server only (§2.1) | Scope `storefront` (the default) | Customer scope, refused on every console operation. Keep it in your server's secret store, never in a repository, a bundle or a log |

- **Test and live.** A test key sees only test searches, checkouts, payments and bookings, a live key only live ones (anything of the other environment is `404`). Live keys can be created once the OTA is live (`LIVE_MODE_NOT_ENABLED` before).
- **Shown once.** The portal shows a new key once. Roll a key to replace it without downtime (the old one keeps working for the period you choose); revoke a leaked key at once.
- **Origins change without a new key**: edit the key in the portal; the API applies the change within a minute.

## 4. Install the SDK

From version 1.0.0 the SDK is on npm as `@velexis/ota-sdk` ([SDK README §9](../../sdk/README.md#9-versioning-publishing-and-what-is-deferred)): ES modules with types, no dependencies.

| Build | Use | Import |
|---|---|---|
| ESM `dist/velexis-sdk.mjs` | Bundlers, Node.js 22, edge runtimes | `import { createVelexisClient } from "@velexis/ota-sdk"` |
| IIFE `dist/velexis-sdk.iife.js` | Plain HTML | `<script src="/vendor/velexis-sdk.iife.js">`, then `Velexis.createVelexisClient(…)` |

- **Self-host the IIFE**: copy `node_modules/@velexis/ota-sdk/dist/velexis-sdk.iife.js` to your site, so your CSP stays `script-src 'self'`. From the versioned CDN copy instead, add the `integrity` hash of the release notes and `crossorigin="anonymous"`.
- **Pin the version** (`"@velexis/ota-sdk": "1.0.0"`) and read the CHANGELOG before upgrading: a major version may change types or behaviour.
- **One client per page** in a browser. On a server, one client per process for anonymous calls, and per request `client.withOptions({ accessToken, endUser })` for the visitor's own calls: `withOptions` shares nothing mutable, so one visitor's token never reaches another's request.

| Option | Default | Notes |
|---|---|---|
| `publishableKey` / `secretKey` | — | Exactly one |
| `baseUrl` | `https://api.ota.example.com` | The API URL Velexis gives you |
| `locale`, `currency` | — | `Accept-Language`, `X-Currency`; also per call |
| `accessToken`, `refreshToken`, `bookingToken` | — | A string or a function called before every request |
| `onSessionRefreshed`, `onSessionExpired` | — | Store the rotated tokens; clear them |
| `endUser` | — | Server mode: `{ ip, userAgent }` of the visitor, or a function giving it |
| `timeoutMs`, `maxRetries` | 30 000, 2 | Long operations have their own timeouts (§10.2) |
| `onResponse` | — | `{ method, path, status, requestId, durationMs }` for your monitoring; the SDK never logs |

## 5. Bootstrap with `storefront.get`

`storefront.get()` gives everything the shell needs, from the OTA's settings ([B1 §2](../../../docs/velexis-sdk/sdk/docs/B1.md)). It is public and cacheable: cache it for up to 5 minutes (the API caches it for 5 minutes too).

| Field | Use |
|---|---|
| `environment` | `test`: show your own test banner and keep the pages out of search engines |
| `features` | Hide what is off: `customerAccounts` (sign-in), `guestCheckout`, `ancillaries`, `brandedFareUpsell`; the API refuses a disabled feature with `403 FEATURE_DISABLED` |
| `currencies`, `defaultCurrency`, `locales` | Switchers; pass the choice as the client's `currency` and `locale` |
| `auth.passwordPolicy`, `auth.emailVerification` | Sign-up form checks; whether sign-up returns a session (§8) |
| `legal.termsVersion` | Send it back in `auth.signUp` |
| `payment` | `publishableKey`, `accountId`, `supportedMethods`, `cardBrands`, `pspCardBrands` for Stripe (§7.2) |
| `primaryUrl`, `domains` | The hosted storefront's address, where the e-mail links lead (§8.3) |

A suspended OTA answers every call with `403 TENANT_SUSPENDED`: show a maintenance page.

## 6. Search, results and pagination

`flights.search` asks Amadeus and waits for the answer (allow up to 60 s; the SDK's timeout for it is 60 s), stores the offers and returns a `FlightSearch` (`srch_…`). `flights.listResults` then pages, filters and sorts the stored offers without calling Amadeus again ([B2 §2–§3](../../../docs/velexis-sdk/sdk/docs/B2.md)). Prices are live: results expire about 30 minutes after the search (`410 SEARCH_EXPIRED`), offers with them (`410 OFFER_EXPIRED`); search again with the same criteria.

The sample is a plain HTML page with the IIFE: the storefront's name and test banner, a search, the first page of results by price and a "More offers" button. It writes data with `textContent` only.

```html
<!-- search.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Flights</title>
    <!-- No inline script: your CSP can stay script-src 'self' (§11). -->
    <script src="/vendor/velexis-sdk.iife.js" defer></script>
    <script src="/search.js" defer></script>
  </head>
  <body>
    <p id="test-banner" hidden>Test environment: no real booking or payment is made.</p>
    <h1 id="name">Flights</h1>
    <form id="search">
      <label>From <input name="from" required value="MAD" /></label>
      <label>To <input name="to" required value="PAR" /></label>
      <label>Departure <input name="date" type="date" required /></label>
      <button>Search</button>
    </form>
    <p id="status" role="status"></p>
    <ul id="offers"></ul>
    <button id="more" type="button" hidden>More offers</button>
  </body>
</html>
```

```js
// search.js
// The IIFE defines window.Velexis. A publishable key is public: the API accepts it only from its allowed origins.
const velexis = Velexis.createVelexisClient({
  publishableKey: "pk_test_…",
  baseUrl: "https://api.ota.example.com",
});

const $ = (selector) => document.querySelector(selector);
// Money is { amount, currency } with a decimal string: format it, never compute with it as a JS number.
const money = ({ amount, currency }) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
let page = null; // the last page of results

function showError(error) {
  // Your own words per code; never the API's details. The request id is what the OTA's support asks for.
  if (Velexis.isVelexisError(error, "SEARCH_EXPIRED")) {
    $("#status").textContent = "These results have expired. Please search again.";
  } else if (Velexis.isVelexisError(error, "RATE_LIMITED")) {
    $("#status").textContent = "Too many searches. Please try again in a minute.";
  } else {
    $("#status").textContent = `Something went wrong (reference ${error.requestId ?? "none"}).`;
  }
}

function render(offers) {
  for (const offer of offers) {
    const item = document.createElement("li");
    const { originCode, destinationCode, maxStops } = offer.summary;
    item.textContent = `${originCode} → ${destinationCode}, ${maxStops} stop(s): ${money(offer.price.total)}`;
    $("#offers").append(item);
  }
  $("#more").hidden = page.page.nextCursor === null;
}

velexis.storefront.get().then((storefront) => {
  $("#name").textContent = storefront.name;
  $("#test-banner").hidden = storefront.environment !== "test";
}, showError);

$("#search").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  $("#offers").replaceChildren();
  $("#more").hidden = true;
  $("#status").textContent = "Searching…";
  try {
    const search = await velexis.flights.search({
      mode: "simple",
      originLocationCode: form.get("from"),
      destinationLocationCode: form.get("to"),
      departureDate: form.get("date"),
      adults: 1,
      resultOptions: { limit: 0 }, // the first page comes from listResults
    });
    page = await velexis.flights.listResults({ searchId: search.id, sort: "price", limit: 10 });
    $("#status").textContent = `${page.total} offers`;
    render(page.data);
  } catch (error) {
    showError(error);
  }
});

$("#more").addEventListener("click", async () => {
  try {
    page = await page.next(); // the same filters and sort, the next cursor
    render(page.data);
  } catch (error) {
    showError(error);
  }
});
```

**Pagination.** Every list method returns a `Page`: `data`, `page.nextCursor` (`null` on the last page), `next()` (the next `Page`, or `null`), and `for await (const item of page)` across all pages, each fetched when the previous one is used up. The extra fields of a response (`total`, `facets` of `listResults`) stay on the page. A cursor belongs to its filters and sort: when they change, start again without one.

**After the results** ([B2 §3–§6](../../../docs/velexis-sdk/sdk/docs/B2.md)): `listResults` takes the filters of the facets (stops, carriers, price, time bands, cabins, bags, refundability, fare families); `flights.getOffer` gives one offer in full; `flights.upsell` the fare families of an offer (when `features.brandedFareUpsell`); `flights.price` confirms the price with the airline (§7.1); `flights.getAncillaries` and `flights.getFareRules` the extras and conditions of a priced offer. `reference.locations.search` feeds an airport and city field: prefix matching on English names and exact IATA codes, so debounce it and abort stale calls with `options.signal`.

## 7. Checkout with Stripe

The steps are those of the hosted storefront ([flow](../../docs/flows/checkout-stripe.md), [B3 §2](../../../docs/velexis-sdk/sdk/docs/B3.md)): price, open a checkout, travellers, contacts (extras and remarks optional), create the payment, Stripe.js with the payment's keys, the card fee for the card's brand, confirm with Stripe, complete. The samples are two ES modules for a bundler: `src/velexis.js` (§8.4) and `src/checkout.js`.

### 7.1 Price and fill the checkout

```js
// src/checkout.js
import { PriceChangedError, isVelexisError } from "@velexis/ota-sdk";
import { velexis } from "./velexis.js";

/** Confirms the offer's price with the airline at the price the traveller saw. */
export async function priceOffer(offer) {
  try {
    const priced = await velexis.flights.price({ offerIds: [offer.id], expectedTotal: offer.price.total });
    return { pricedOfferId: priced.id, total: priced.price.total };
  } catch (error) {
    if (error instanceof PriceChangedError) {
      // The new price is stored: show error.oldPrice and error.newPrice, and go on with error.pricedOfferId once the
      // traveller accepts it.
      return { pricedOfferId: error.pricedOfferId, total: error.newPrice, changed: true };
    }
    throw error; // OFFER_EXPIRED: search again; SOLD_OUT: back to the results
  }
}

/** Opens a checkout and fills the traveller and the contact; `progress.missing` names what is still missing. */
export async function fillCheckout(pricedOfferId, traveller, contact) {
  let checkout = await velexis.checkout.create({ pricedOfferId });
  // `requirements.travelers[i].requiredFields` and `requirements.contact` say which fields the airline needs.
  checkout = await velexis.checkout.setTravelers({
    checkoutId: checkout.id,
    ifMatch: checkout.version,
    travelers: [{ travelerId: "1", ...traveller }],
  });
  checkout = await velexis.checkout.setContacts({
    checkoutId: checkout.id,
    ifMatch: checkout.version,
    contacts: [{ purpose: "STANDARD", isPrimary: true, ...contact }],
  });
  return checkout;
}
```

`travelerId` is the Amadeus traveller id (`"1"`, `"2"`, …), never the `ctr_…` row id. Responses never contain a document number (`numberMasked` only); a document sent back without `number` keeps the stored one. A field the airline refuses comes back as `422 TRAVELER_DATA_INVALID` or `CONTACT_DATA_INVALID` with `fieldErrors[].path` (`/travelers/0/documents/0/expiryDate`), which you show next to the field.

### 7.2 Pay with Stripe.js

Load Stripe.js on the payment page only, with `<script src="https://js.stripe.com/v3/"></script>` (never bundled; Stripe requires that). `checkout.createPayment({ method: "card", termsAccepted: true, returnUrl })` creates the payment and its Stripe PaymentIntent (authorised now, captured only once the airline accepted the order) and returns `clientSecret` and `providerPublicKey`. Initialise Stripe with that key and, when `storefront.get().payment.accountId` is set, `stripeAccount: accountId`: the OTA takes payments on its own Stripe account through Stripe Connect, where the PaymentIntent lives.

```js
// src/checkout.js (continued)

/** Creates the payment and mounts Stripe's Payment Element in `mountPoint`. */
export async function startCardPayment(checkout, storefront, mountPoint) {
  const payment = await velexis.checkout.createPayment({
    checkoutId: checkout.id,
    method: "card",
    termsAccepted: true, // the traveller ticked your terms box
    returnUrl: new URL(`/checkout/return?checkout=${checkout.id}`, location.origin).href,
  });
  const { accountId } = storefront.payment; // the OTA's acct_… in Connect mode, else null
  const stripe = accountId
    ? Stripe(payment.providerPublicKey, { stripeAccount: accountId })
    : Stripe(payment.providerPublicKey);
  const elements = stripe.elements({ clientSecret: payment.clientSecret });
  elements.create("payment").mount(mountPoint);
  return { payment, stripe, elements };
}

/** "Review": the card fee for the card's brand, before the traveller pays. */
export async function reviewCard({ payment, stripe, elements }, storefront) {
  const { error: invalid } = await elements.submit();
  if (invalid) throw invalid;
  const { confirmationToken, error } = await stripe.createConfirmationToken({ elements });
  if (error) throw error;
  const stripeBrand = confirmationToken.payment_method_preview.card?.brand;
  const brand = storefront.payment.pspCardBrands.find((b) => b.psp === stripeBrand)?.amadeus;
  const updated = brand
    ? await velexis.checkout.updatePayment({ paymentId: payment.id, card: { brand } })
    : payment;
  await elements.fetchUpdates(); // the PaymentIntent's new amount
  return { confirmationToken, amount: updated.amount, cardFee: updated.cardFee }; // show both before "Pay"
}

/** "Pay": Stripe confirms the card (3-D Secure in its own frame), then the checkout completes. */
export async function payAndComplete({ payment, stripe }, confirmationToken, amount, checkoutId) {
  // Where Stripe sends the traveller back after a method that leaves the page (Redirects, below).
  const returnUrl = new URL(`/checkout/return?checkout=${checkoutId}&payment=${payment.id}`, location.origin);
  const { error } = await stripe.confirmPayment({
    clientSecret: payment.clientSecret,
    confirmParams: { confirmation_token: confirmationToken.id, return_url: returnUrl.href },
    redirect: "if_required",
  });
  if (error) throw error; // a declined card or a failed 3-D Secure: show error.message and let the traveller retry
  return completeCheckout(checkoutId, payment.id, amount);
}
```

- **Card fee.** The fee depends on the card's brand. `updatePayment` re-quotes it and changes the amount of the **same** PaymentIntent; call it before "Pay" and show `amount` and `cardFee`. It answers `409 PAYMENT_NOT_UPDATABLE` once confirmation has started (create a new payment) and `409 PRICE_CHANGED` when the fare moved (show the new total, create a new payment).
- **Redirects.** Some methods leave the page; Stripe then opens the `return_url` of `confirmPayment`, which names the checkout and the payment. There, read `checkout.getPayment({ paymentId })` again every 2 seconds while its `status` is `processing` or `requires_action`, and complete only once it is `authorized` or `captured` ([B3 §2.6](../../../docs/velexis-sdk/sdk/docs/B3.md)): the API keeps a `402 PAYMENT_REQUIRED` with the completion's key (§10.3). Any other status (`failed`, `cancelled`, `requires_payment_method`) means a new payment.
- **PCI.** Card data goes from Stripe's iframes to Stripe only; your pages, your server and Velexis never see it.

### 7.3 Complete with a stable idempotency key

`checkout.complete` creates the Amadeus order, captures the payment and issues the tickets per the OTA's policy; the SDK allows it 90 s. Pass an idempotency key derived from the checkout and the payment: a repeated call with the same key, including the SDK's own retries after a network error, replays the stored outcome and never books twice ([OADR-0003](../../docs/adr/0003-booking-orchestration-and-supplier-timeout-recovery.md)).

```js
// src/checkout.js (continued)

/** Books and tickets. A guest's bookingToken is the only key to the booking: keep it (§9). */
export async function completeCheckout(checkoutId, paymentId, expectedTotal) {
  try {
    const done = await velexis.checkout.complete(
      { checkoutId, paymentId, expectedTotal },
      { idempotencyKey: `complete-${checkoutId}-${paymentId}` },
    );
    return { bookingId: done.booking.id, reference: done.booking.reference, bookingToken: done.bookingToken };
  } catch (error) {
    if (isVelexisError(error, "SUPPLIER_TIMEOUT")) {
      // The airline did not answer in time and the order may exist. Never complete again with another key: show
      // "we are confirming your booking" and poll bookings.getTicketingStatus for details.bookingId.
      const { bookingId, bookingToken } = error.details;
      return { bookingId, bookingToken, pending: true };
    }
    // PRICE_CHANGED or SOLD_OUT: the authorisation is voided, nothing is charged. PAYMENT_REQUIRED or PAYMENT_DECLINED:
    // the card is not authorised; the API keeps that answer with this key, so the traveller pays with a new payment
    // (§7.2). CHECKOUT_ALREADY_COMPLETED: details.bookingId is the booking.
    throw error;
  }
}
```

After completion, `bookings.getTicketingStatus({ bookingId, refresh: true })` tells the confirmation page when tickets are issued (poll every `pollAfterSeconds`; [B3 §2.8](../../../docs/velexis-sdk/sdk/docs/B3.md)).

## 8. Customer accounts and sessions

Customers are the OTA's, shared by every frontend of the OTA: a customer who signed up on the hosted storefront signs in on yours with the same password.

### 8.1 Sessions

`auth.signUp`, `auth.signIn`, `auth.refresh`, `auth.resetPassword` and `auth.changePassword` return a session: an access token (15 minutes) and a refresh token (12 hours, or 30 days with `rememberMe`). Every refresh rotates the refresh token, and presenting a rotated refresh token again revokes the whole session (`401 REFRESH_TOKEN_REUSED`): the API has no grace period, unlike the remark in [B1 §3.4](../../../docs/velexis-sdk/sdk/docs/B1.md). So refresh each refresh token **once**, and write the new pair back before anything else uses the old one. In server code, de-duplicate refreshes per token, as the sample does; with several server instances, keep a visitor on one instance or share the lock.

### 8.2 Your own server with httpOnly cookies

The server keeps the secret key and the tokens; the browser gets httpOnly cookies and calls your routes with JSON bodies. Routes that change something accept only `Content-Type: application/json`, which a form on another site cannot send, and the cookies are `SameSite=Lax`. The sample is Node.js 22 with the SDK and no framework, in three modules: `session.mjs` (the client, the cookies and the session of a request), `server.mjs` (the account routes and the HTTP server) and `bookings.mjs` (§9). The same calls fit Express, Fastify, Next.js, Nuxt or Angular SSR.

```js
// session.mjs
import { createVelexisClient, isVelexisError } from "@velexis/ota-sdk";

export const velexis = createVelexisClient({
  secretKey: process.env.VELEXIS_SECRET_KEY, // sk_test_… scoped storefront, from your secret store
  baseUrl: "https://api.ota.example.com",
});

const ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax; Path=/";

export function readCookies(req) {
  const pairs = (req.headers.cookie ?? "").split(";").filter((part) => part.includes("="));
  return Object.fromEntries(pairs.map((part) => part.trim().split(/=(.*)/s).slice(0, 2)));
}

export const cookie = (name, value, expires) =>
  `${name}=${value}; Expires=${new Date(expires).toUTCString()}; ${ATTRIBUTES}`;

// The access cookie ends 60 s before its token, so a request never carries an expired one.
export const sessionCookies = (session) => [
  cookie("vx_at", session.accessToken, Date.parse(session.accessTokenExpiresAt) - 60_000),
  cookie("vx_rt", session.refreshToken, session.refreshTokenExpiresAt),
];
export const clearedCookies = [`vx_at=; Max-Age=0; ${ATTRIBUTES}`, `vx_rt=; Max-Age=0; ${ATTRIBUTES}`];

/** The visitor behind a request: the API's rate limits count the visitor, not your server. */
export function endUserOf(req) {
  // Behind your own proxy or load balancer, take the visitor's address from the header it sets.
  return { ip: req.socket.remoteAddress, userAgent: req.headers["user-agent"] };
}

// One refresh per refresh token: concurrent requests of a visitor share it, and for 10 s a late request that still
// carries the old token gets the same new pair instead of presenting the rotated token again.
const refreshes = new Map();
function refreshOnce(refreshToken, endUser) {
  if (!refreshes.has(refreshToken)) {
    const refreshed = velexis.auth.refresh({ refreshToken }, { endUser });
    refreshes.set(refreshToken, refreshed);
    refreshed.finally(() => setTimeout(() => refreshes.delete(refreshToken), 10_000).unref()).catch(() => {});
  }
  return refreshes.get(refreshToken);
}

/** A client for one request, acting for the visitor's session if there is one. */
export async function clientFor(req, res) {
  const endUser = endUserOf(req);
  const cookies = readCookies(req);
  let accessToken = cookies.vx_at;
  if (!accessToken && cookies.vx_rt) {
    try {
      const { session } = await refreshOnce(cookies.vx_rt, endUser);
      accessToken = session.accessToken;
      res.setHeader("Set-Cookie", sessionCookies(session));
    } catch (error) {
      if (!isVelexisError(error, "REFRESH_TOKEN_INVALID") && !isVelexisError(error, "REFRESH_TOKEN_REUSED")) {
        throw error;
      }
      res.setHeader("Set-Cookie", clearedCookies); // signed out: sign in again
    }
  }
  return velexis.withOptions(accessToken ? { endUser, accessToken } : { endUser });
}
```

```js
// server.mjs
import { createServer } from "node:http";
import { isVelexisError } from "@velexis/ota-sdk";
import { bookingRoutes } from "./bookings.mjs";
import { clearedCookies, clientFor, endUserOf, readCookies, sessionCookies, velexis } from "./session.mjs";

let storefront = null; // storefront.get, kept for 5 minutes
async function termsVersion() {
  if (!storefront || Date.now() - storefront.at > 300_000) {
    storefront = { at: Date.now(), value: await velexis.storefront.get() };
  }
  return storefront.value.legal.termsVersion;
}

const routes = {
  "POST /api/sign-up": async (req, res, body) => {
    const result = await velexis.auth.signUp(
      {
        email: body.email,
        password: body.password,
        firstName: body.firstName,
        lastName: body.lastName,
        marketingConsent: body.marketingConsent === true, // unticked by default
        termsVersion: await termsVersion(),
      },
      { endUser: endUserOf(req) },
    );
    // No session when the OTA requires a verified e-mail before the first sign-in.
    if (result.session) res.setHeader("Set-Cookie", sessionCookies(result.session));
    return { signedIn: result.session !== null };
  },
  "POST /api/sign-in": async (req, res, body) => {
    const { session, customer } = await velexis.auth.signIn(
      { email: body.email, password: body.password, rememberMe: body.rememberMe === true },
      { endUser: endUserOf(req) },
    );
    res.setHeader("Set-Cookie", sessionCookies(session));
    return { firstName: customer.firstName };
  },
  "GET /api/me": async (req, res) => {
    const { customer } = await (await clientFor(req, res)).auth.getSession();
    return { firstName: customer.firstName, emailVerified: customer.emailVerified };
  },
  "GET /api/trips": async (req, res, body, url) => {
    const client = await clientFor(req, res);
    const page = await client.bookings.list({
      timeframe: url.searchParams.get("tab") ?? "upcoming", // upcoming, past, cancelled
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: 20,
    });
    return { trips: page.data, nextCursor: page.page.nextCursor };
  },
  "POST /api/sign-out": async (req, res) => {
    const { vx_rt: refreshToken } = readCookies(req);
    await (await clientFor(req, res)).auth.signOut(refreshToken ? { refreshToken } : {}).catch(() => {});
    res.setHeader("Set-Cookie", clearedCookies);
    return {};
  },
  ...bookingRoutes,
};

/** An API error as your browser code needs it: the code to choose a text, the request id for support. */
function failure(error) {
  if (error instanceof SyntaxError) return [400, { code: "INVALID_JSON" }];
  if (error instanceof RangeError) return [413, { code: "BODY_TOO_LARGE" }];
  if (!isVelexisError(error)) return [500, { code: "INTERNAL_ERROR" }];
  return [
    error.status || 502,
    { code: error.code, requestId: error.requestId, fieldErrors: error.fieldErrors },
  ];
}

const MAX_BODY = 16_384; // the routes take small JSON bodies: never read an unbounded one into memory

async function readJson(req) {
  if (req.method === "GET") return {};
  if (!req.headers["content-type"]?.startsWith("application/json")) return null;
  req.setEncoding("utf8");
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY) throw new RangeError("request body too large");
  }
  return JSON.parse(text || "{}");
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/^\/api\/bookings\/bkg_\w+/, "/api/bookings/:id");
  const route = routes[`${req.method} ${path}`];
  let status = 200;
  let body;
  try {
    const input = await readJson(req);
    if (!route) [status, body] = [404, { code: "NOT_FOUND" }];
    else if (input === null) [status, body] = [415, { code: "JSON_ONLY" }];
    else body = await route(req, res, input, url);
  } catch (error) {
    [status, body] = failure(error);
  }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}).listen(Number(process.env.PORT ?? 3000));
```

Sign-in and sign-up refusals reach the browser as codes it maps to its own texts: `INVALID_CREDENTIALS` ("e-mail or password is wrong"), `ACCOUNT_LOCKED` (`details.lockedUntil`), `EMAIL_NOT_VERIFIED`, `EMAIL_ALREADY_REGISTERED`, `PASSWORD_TOO_WEAK` (`details.violations`), `RATE_LIMITED` ([B1 §6](../../../docs/velexis-sdk/sdk/docs/B1.md)).

### 8.3 Verification and password reset e-mails

The API sends the verification, password-reset and booking e-mails, and their links always lead to the OTA's **hosted** storefront (`/account/verify.html?token=…`, `/account/reset-password.html?token=…`, `/booking.html?id=…` on `storefront.get().primaryUrl`), whatever frontend the customer used ([OADR-0015](../../docs/adr/0015-storefront-build-urls-and-hosting.md) point 5). `returnPath` is accepted and not kept. The hosted pages verify the address or set the new password; the customer then signs in on your frontend with `auth.signIn`. So keep the hosted storefront's branding in line with yours (OTA admin, storefront settings), and offer "Forgot password?" on your sign-in page with `auth.requestPasswordReset({ email }, { endUser })`, which answers the same whether or not the account exists.

### 8.4 Sessions in a browser-only app

With a publishable key (§2.2, §2.3) the tokens are in the page. Keep them in a module's memory; a reload signs the customer out. The SDK refreshes once on `401 TOKEN_EXPIRED` (one refresh at a time per client) and hands the new pair to `onSessionRefreshed`.

```js
// src/velexis.js
import { createVelexisClient } from "@velexis/ota-sdk";

let session = null; // in memory only: never in localStorage or sessionStorage, which every script can read

export const velexis = createVelexisClient({
  publishableKey: "pk_test_…",
  baseUrl: "https://api.ota.example.com",
  accessToken: () => session?.accessToken,
  refreshToken: () => session?.refreshToken,
  onSessionRefreshed: (next) => {
    session = next;
  },
  onSessionExpired: () => {
    session = null;
  },
});

export async function signIn(email, password) {
  const { customer } = await velexis.auth.signIn({ email, password }); // onSessionRefreshed stores its session
  return customer;
}

export async function signOut() {
  try {
    await velexis.auth.signOut({ scope: "current" });
  } finally {
    session = null;
  }
}
```

## 9. Guests and my bookings

- **Guest bookings.** `checkout.complete` returns a `bookingToken` for a guest (and for a `SUPPLIER_TIMEOUT`, in `error.details`); `bookings.lookup({ bookingReference, lastName })` gives one later. The token opens that one booking until its `expiresAt`. On a server, keep it in an httpOnly cookie per booking (`vx_bt_<bookingId>`, as below), pass it per call as `options.bookingToken` and never put it in a page; in a browser-only app keep it in memory, like the session (§8.4). Never put it in a URL or browser storage.
- **My bookings.** `bookings.list({ timeframe })` (customers only) lists `upcoming`, `past` and `cancelled` trips as a `Page` (the `/api/trips` route of §8.2). A signed-in customer's own bookings need no booking token.
- **A booking.** `bookings.get` gives the booking with `allowedActions` (which buttons to show, `reasons` for those that are off) and `version`, the `ifMatch` of every change. `bookings.update` changes contacts and adds remarks (traveller documents and loyalty numbers answer `403 FEATURE_DISABLED` in the MVP); `bookings.listDocuments` and `bookings.getDocumentDownloadUrl` give the e-tickets, itinerary and invoices (a 5-minute URL; redirect to it, never cache it).
- **Cancellation** is a quote, then a confirmation with the quoted refund and an idempotency key derived from the booking, its version and that refund; `allowedActions.canCancel` says whether the OTA offers it.

```js
// bookings.mjs
import { clientFor, cookie, endUserOf, readCookies, velexis } from "./session.mjs";

/** The visitor's access to one booking: their session, else the booking's guest token from its cookie. */
async function bookingAccess(req, res, url) {
  const bookingId = url.pathname.split("/")[3];
  const bookingToken = readCookies(req)[`vx_bt_${bookingId}`];
  return { bookingId, client: await clientFor(req, res), options: bookingToken ? { bookingToken } : {} };
}

export const bookingRoutes = {
  "POST /api/bookings/lookup": async (req, res, body) => {
    const found = await velexis.bookings.lookup(
      { bookingReference: body.bookingReference, lastName: body.lastName },
      { endUser: endUserOf(req) }, // 5 failures per 15 minutes per visitor and per reference
    );
    res.setHeader("Set-Cookie", cookie(`vx_bt_${found.bookingId}`, found.bookingToken, found.expiresAt));
    return { bookingId: found.bookingId };
  },
  "GET /api/bookings/:id": async (req, res, body, url) => {
    const { bookingId, client, options } = await bookingAccess(req, res, url);
    const booking = await client.bookings.get({ bookingId }, options);
    return {
      reference: booking.reference,
      status: booking.status,
      version: booking.version,
      allowedActions: booking.allowedActions,
    };
  },
  "GET /api/bookings/:id/cancellation-quote": async (req, res, body, url) => {
    const { bookingId, client, options } = await bookingAccess(req, res, url);
    const quote = await client.bookings.quoteCancellation({ bookingId }, options);
    return {
      cancellable: quote.cancellable,
      mode: quote.mode,
      refund: quote.estimatedRefund,
      reason: quote.notAllowedReason,
    };
  },
  "POST /api/bookings/:id/cancel": async (req, res, body, url) => {
    const { bookingId, client, options } = await bookingAccess(req, res, url);
    const { version, refund } = body; // the booking's version and the quote's estimatedRefund the traveller confirmed
    const { cancellation } = await client.bookings.cancel(
      { bookingId, ifMatch: version, reasonCode: "change_of_plans", expectedRefund: refund },
      // The same request replays, never cancels twice; another refund is another request with another key (§10.3).
      { ...options, idempotencyKey: `cancel-${bookingId}-${version}-${refund.amount}-${refund.currency}` },
    );
    // REFUND_AMOUNT_CHANGED: show details.newRefund and ask again; PRECONDITION_FAILED: reload the booking.
    return { status: cancellation.status, refund: cancellation.refund };
  },
};
```

`server.mjs`'s router replaces the booking id in the path, so these routes are named `/api/bookings/:id…`. Customers and guests use the same routes: a signed-in customer's session wins, and the guest cookie is sent only when there is one.

## 10. Errors, retries and idempotency

### 10.1 Errors

Every failure is a `VelexisError` subclass with `code`, `status`, `message`, `fieldErrors`, `details`, `requestId` and `retryable`; test it with `isVelexisError(error, code)` or `instanceof` ([SDK README §5.3](../../sdk/README.md#53-behaviour-shared-by-all-methods-internalhttpjs)).

| Class | Status | Codes that deserve their own screen or text |
|---|---|---|
| `ValidationError` | 400, 422 | `VALIDATION_FAILED`, `TRAVELER_DATA_INVALID`, `CONTACT_DATA_INVALID` (show `fieldErrors[].path` at the field), `CHECKOUT_INCOMPLETE`, `PASSWORD_TOO_WEAK` |
| `AuthenticationError` | 401 | `INVALID_CREDENTIALS`, `UNAUTHENTICATED` (sign in), `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `INVALID_API_KEY` (your configuration) |
| `PaymentError` | 402 | `PAYMENT_REQUIRED`, `PAYMENT_DECLINED` |
| `PermissionError` | 403 | `ORIGIN_NOT_ALLOWED` and `SCOPE_NOT_ALLOWED` (your configuration), `FEATURE_DISABLED`, `TENANT_SUSPENDED` (maintenance page), `EMAIL_NOT_VERIFIED` |
| `NotFoundError` | 404 | `NOT_FOUND`, also for a resource of the other environment or another customer |
| `ConflictError` | 409 | `PriceChangedError` (`PRICE_CHANGED`: `oldPrice`, `newPrice`), `SoldOutError` (`SOLD_OUT`: back to the results), `CHECKOUT_ALREADY_COMPLETED`, `PAYMENT_NOT_UPDATABLE`, `REFUND_AMOUNT_CHANGED` |
| `ExpiredError` | 410 | `SEARCH_EXPIRED`, `OFFER_EXPIRED`, `CHECKOUT_EXPIRED`: search or price again |
| `VelexisError` | 412, 423 | `PRECONDITION_FAILED` (reload, re-apply), `ACCOUNT_LOCKED` |
| `RateLimitError` | 429 | `RATE_LIMITED`: `retryAfterSeconds` |
| `SupplierError` | 424, 502, 503, 504 | `SUPPLIER_TIMEOUT` ("we are confirming your booking", §7.3), `SUPPLIER_UNAVAILABLE` ("airlines are not answering, try again") |
| `ServerError` | 500, 501, 503 | `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `NOT_IMPLEMENTED` (a deferred method) |
| `ConnectionError` | 0 | `NETWORK_ERROR`, `TIMEOUT`, `ABORTED` (your own `signal`) |

Show your own texts per code; `message` is a safe English fallback, but never show `details` or a stack. Print `requestId` on every error screen: it is the line the OTA's support and Velexis find in their logs. A method can also throw a `TypeError` before any request (an invalid option or parameter): that is a bug in your code.

### 10.2 Retries and timeouts

The SDK retries at most twice (`maxRetries`) on `429`, `503`, `504` and network errors, for `GET`, `PUT` and `DELETE` and for every request carrying an `Idempotency-Key`, with exponential back-off (0.5 s, 1 s, 2 s …, never above 8 s) or the answer's `Retry-After`; a `Retry-After` above 30 s ends the call at once. It never retries a timeout or an abort. Timeouts are per attempt: 30 s, 60 s for `flights.search`, `flights.upsell` and `flights.price`, 90 s for `checkout.complete`.

### 10.3 Idempotency keys

The SDK sends a new `Idempotency-Key` with every state-changing `POST` and keeps it across that call's retries, so a retry after a lost answer replays the stored result instead of acting twice. Where the **traveller** may repeat an action (a double click, a reload, a second tab), pass your own key derived from what the action is about, so the second request replays the first: `complete-<checkoutId>-<paymentId>` for `checkout.complete` (§7.3), `cancel-<bookingId>-<version>-<refund amount>-<currency>` for `bookings.cancel` (§9). A key is 16 to 128 visible ASCII characters; reusing one with another body answers `409 IDEMPOTENCY_KEY_REUSED`. The API keeps a refusal (a final `4xx`) with its key for 24 hours too, so a request that differs after a refusal needs another key: that is why the cancellation key holds the refund, which changes after `409 REFUND_AMOUNT_CHANGED`, and why a refused completion (`402`, `409 PRICE_CHANGED`) is followed by a new payment, whose id makes a new key.

## 11. Security checklist

- **CSP.** Allow your own origin, the API and Stripe only, with no inline script (a starting point, from the hosted storefront's, [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)):

  ```text
  Content-Security-Policy: default-src 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; style-src 'self'; img-src 'self' data: https://api.ota.example.com; font-src 'self'; connect-src 'self' https://api.ota.example.com https://api.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
  ```

  `img-src` takes the API for the OTA's logo and images (`storefront.get` gives their absolute URLs); with the architecture of §2.1 only, `connect-src` needs your own origin and Stripe.
- **No tokens in browser storage.** Server: httpOnly, `Secure`, `SameSite=Lax` cookies (§8.2). Browser-only: memory (§8.4). Never `localStorage`, `sessionStorage`, URLs or logs.
- **Secret keys** live in your server's secret store and environment; the SDK refuses them in a browser. One key per deployment, so a leak is revoked without stopping the others.
- **The visitor's address.** From a server, pass `endUser` (`X-Velexis-End-User-IP` and `-Agent`) on every call made for a visitor: without it every visitor shares your server's rate limits. The API ignores these headers from publishable keys.
- **Rate limits** you will meet ([architecture §8](../../docs/architecture.md#8-rate-limits)): sign-in 10 per minute per visitor, and an e-mail address locked for 15 minutes after 5 wrong passwords, from any visitor (`423 ACCOUNT_LOCKED`); sign-up, password reset and verification e-mails 5 per hour per visitor and 3 per hour per e-mail; search, upsell and price 30 per minute per visitor from a browser (publishable keys; a secret key's calls are not counted by this limit); `bookings.lookup` 5 failures per 15 minutes per visitor and per reference; `checkout.createPayment` and `checkout.complete` 10 per minute per visitor.
- **HTML from data.** Write API data with `textContent` and `createElement`, never through `innerHTML`; content pages (`storefront.getPage`) arrive as parsed blocks for that reason.
- **PCI scope** stays with Stripe: the card is typed into Stripe's iframes on a page that loads Stripe.js and your own scripts only, and your server never receives it. The airline card, which would put card data through the API, is not offered to your frontend.

## 12. Framework notes

The SDK has no framework dependency; the calls of §6 to §9 are the same everywhere.

- **Next.js (App Router).** Server components, server actions and route handlers with the secret key: [B1](../../../docs/velexis-sdk/sdk/docs/B1.md), [B2](../../../docs/velexis-sdk/sdk/docs/B2.md) and [B3](../../../docs/velexis-sdk/sdk/docs/B3.md) are written for it. Their `@velexis/ota-sdk/next` helpers are post-MVP and not in the package yet; write the few you need as in §8.2 (cookies, `endUser`, the refresh once per token).
- **React or Vue SPA.** The modules of §7 and §8.4 as they are; abort a component's calls when it unmounts (`options.signal` with an `AbortController`), and debounce the location search.
- **Angular.** A service that holds the client of §8.4 and returns its promises; the SDK uses `fetch`, so `HttpClient` is not needed. With Angular SSR, use the server pattern of §8.2 on the server side.
- **Plain HTML.** §6 with the IIFE.

## 13. Testing and going live

- **Test first.** Test keys reach the OTA's test environment: the Amadeus test system and Stripe's test mode (card `4242 4242 4242 4242`; with 3-D Secure `4000 0027 6000 3184`). Nothing is charged or ticketed for real, and `storefront.get().environment` is `test`.
- **Going live.** Live keys exist once the OTA is live in the portal. Create a live publishable key with your production origins and a live secret key, deploy them as secrets, and check that `storefront.get().environment` is `live`.
- **Go-live checklist.**
  - Keys: live keys deployed, test keys gone from production, allowed origins exact, secret key only on the server.
  - Pages: terms and privacy links from `storefront.get().legal`, `termsVersion` sent at sign-up, the support contact, a maintenance page for `TENANT_SUSPENDED`, an error page that shows `requestId`.
  - Booking: a full test booking with Stripe's test cards (3-D Secure included), a cancellation, a guest lookup.
  - Monitoring: `onResponse` reports `5xx` answers and slow calls to your monitoring, with their request ids.

### 13.1 The reference implementation

The hosted storefront (this folder) uses the same calls in cookie mode; read its code next to this guide.

| Topic | Hosted storefront |
|---|---|
| Client and configuration | [`src/lib/client.js`](../src/lib/client.js), [`src/lib/config.js`](../src/lib/config.js) (storefront.get cached 5 minutes) |
| Errors to page states | [`src/lib/errors.js`](../src/lib/errors.js) |
| Search form, location field | [`src/components/search-form.js`](../src/components/search-form.js), [`src/components/location-combobox.js`](../src/components/location-combobox.js) |
| Results, filters, pagination | [`src/pages/search.js`](../src/pages/search.js), [`src/components/filters.js`](../src/components/filters.js), [`src/components/load-more.js`](../src/components/load-more.js) |
| Offer, fare families, price | [`src/pages/offer.js`](../src/pages/offer.js), [`src/pages/price.js`](../src/pages/price.js) |
| Checkout, Stripe, completion | [`src/pages/checkout.js`](../src/pages/checkout.js), [`src/pages/checkout-pay-card.js`](../src/pages/checkout-pay-card.js), [`src/pages/checkout-complete.js`](../src/pages/checkout-complete.js), [`src/pages/confirmation.js`](../src/pages/confirmation.js) |
| Accounts | `src/pages/account-*.js` |
| My bookings, a booking, guest lookup | [`src/pages/bookings.js`](../src/pages/bookings.js), [`src/pages/booking.js`](../src/pages/booking.js), [`src/components/cancel-dialog.js`](../src/components/cancel-dialog.js), [`src/pages/lookup.js`](../src/pages/lookup.js) |
