# Build your own frontend: guide outline

This page is the outline of the guide for OTAs that want their own storefront instead of, or next to, the hosted one: built in any framework (Next.js, React, Angular, Vue or plain HTML), hosted on their own domain, and calling the Velexis OTA API through the JS SDK ([`decisions.md`](../../../docs/mvp/decisions.md) §2). It fixes the chapters, the decisions each chapter explains and the material it reuses, so the full guide can be written for the M6 launch together with the SDK's npm release. The hosted storefront in this folder is the reference implementation.

Related: [storefront README](../README.md), [SDK README](../../sdk/README.md), [`../../sdk/docs/extensions.md`](../../sdk/docs/extensions.md), SDK guides [B1–B4](../../../docs/velexis-sdk/sdk/docs/) and [Next.js guide](../../../docs/velexis-sdk/sdk/docs/nextjs.md), [Next.js example](../../../docs/velexis-sdk/examples/next-storefront/), [OpenAPI contract](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml), [scope §1.2](../../docs/scope.md#12-programs).

## What is different from the hosted storefront

| Topic | Hosted storefront | Your own frontend |
|---|---|---|
| Host | `<key>.ota.example.com` or a verified custom domain, served by Velexis | Your domain, your hosting |
| API | Same-origin `/api` through Caddy | `https://api.ota.example.com` |
| Credential | Edge credential added by Caddy | Publishable key `pk_…` (browser, allowed origins) or secret key `sk_…` scoped `storefront` (your server) |
| Customer sessions | httpOnly cookies set by the API, CSRF header | Bearer tokens that **you** store (recommended: httpOnly cookies on your own server) |
| Guest access | `__Host-vx_bt` cookie | `X-Booking-Token` (`bookingToken` option) |
| Payment methods | Stripe and the airline card | **Stripe only** (the airline card is refused to keys: `403 SCOPE_NOT_ALLOWED`, [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)) |
| Branding, pages | Runtime settings | Yours; `storefront.get` still gives currencies, features, legal versions and the payment configuration |

## Chapters

1. **Choose an architecture.**
   - Browser-only app with a publishable key: simplest, tokens live in the browser, which is the integrator's risk to accept.
   - App with its own server (Next.js, Nuxt, Angular SSR, a small Node or edge function) with a secret key: tokens stay in httpOnly cookies on your domain; recommended.
   - Plain HTML with the IIFE bundle (`window.Velexis`), publishable key, for small sites.
2. **Get keys and set allowed origins.** In the portal (`https://platform.example.com/otas/<tenantId>/api-keys`): test and live keys, allowed browser origins for `pk_` keys, key scopes. Never ship an `sk_` key to a browser; the SDK refuses it there.
3. **Install the SDK.** `npm install @velexis/ota-sdk` (ESM, types included) or the IIFE from a versioned CDN URL with its SRI hash, preferably self-hosted. Create one client per request on servers, one per page in browsers.
4. **Bootstrap.** `storefront.get`: environment (show your own test banner), currencies, features (`guestCheckout`, `customerAccounts`, `ancillaries`, `brandedFareUpsell`), legal versions for sign-up, payment configuration.
5. **Search and price.** `reference.locations.search`, `flights.search` (synchronous; allow 60 s), `flights.listResults` with facets, `flights.getOffer`, `flights.upsell`, `flights.price`, `getAncillaries`, `getFareRules`. Reuse [B2](../../../docs/velexis-sdk/sdk/docs/B2.md); explain expiry (`SEARCH_EXPIRED`, `OFFER_EXPIRED`) and price changes.
6. **Checkout and Stripe.** `checkout.create` → travellers, contacts, extras, remarks → `createPayment({ method: "card", termsAccepted: true, returnUrl })` → Stripe.js with `providerPublicKey` and `accountId` (Connect mode) → `updatePayment` for the card fee → `confirmPayment` → `checkout.complete` with a **stable idempotency key** → confirmation polling. Reuse [B3](../../../docs/velexis-sdk/sdk/docs/B3.md) §2; explain `SUPPLIER_TIMEOUT` ("never complete again with a new key").
7. **Customer accounts and sessions.** Sign-up with `termsVersion`, verification and reset pages at your own URLs (`returnPath`), sign-in, `onSessionRefreshed` writing rotated tokens back, refresh de-duplication (reusing a rotated refresh token revokes the session family), sign-out. Reuse [B1](../../../docs/velexis-sdk/sdk/docs/B1.md) §3.
8. **Guests and my bookings.** Keeping `bookingToken` per booking (httpOnly cookie on your server), `bookings.lookup`, `bookings.list` tabs, booking detail, documents, contact changes, cancellation quote and confirm. Reuse [B3](../../../docs/velexis-sdk/sdk/docs/B3.md) §3–§4.
9. **Errors.** The error classes, codes worth a dedicated screen (`PRICE_CHANGED`, `SOLD_OUT`, `*_EXPIRED`, `SUPPLIER_TIMEOUT`, `RATE_LIMITED`), `requestId` for support, never showing raw messages to travellers.
10. **Security checklist.** CSP that allows your origin, `api.ota.example.com` and Stripe only; no tokens in `localStorage`; `X-Velexis-End-User-IP` from servers; `sk_` keys in server secrets; rate limits you will meet; PCI scope stays with Stripe.
11. **Framework notes.** Short, tested snippets for Next.js (server actions; the post-MVP `@velexis/ota-sdk/next` helpers when they ship), React SPA (a small token store, `AbortController` in effects), Angular (a service wrapping the client, `HttpClient` not needed), Vue (a composable), plain HTML (IIFE).
12. **Testing and going live.** Test keys against the Amadeus test environment, Stripe test cards, the live switch (live keys only work once the OTA is live), a go-live checklist (keys, origins, legal pages, support contact, monitoring of `onResponse` errors).

## Material to reuse when writing it

| Chapter | Source |
|---|---|
| 3, 9 | [SDK README](../../sdk/README.md) §4–§5, [`extensions.md`](../../sdk/docs/extensions.md) |
| 4–8 | Guides B1–B3 (Next.js code, same method calls), the storefront page specs [`pages.md`](pages.md) and [`pages-account.md`](pages-account.md) |
| 6 | [`../../docs/flows/checkout-stripe.md`](../../docs/flows/checkout-stripe.md) |
| 10 | [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md) (CSP of the hosted storefront as a starting point), [conventions §12](../../../docs/mvp/conventions.md#12-security-checklist-every-pr) |
| 11 | [`nextjs.md`](../../../docs/velexis-sdk/sdk/docs/nextjs.md), the [Next.js example](../../../docs/velexis-sdk/examples/next-storefront/) |

The guide is published with the SDK at M6 (npm release and documentation site are on the launch checklist); until then it stays an outline.
