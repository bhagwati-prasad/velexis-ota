# OADR-0017: Airline-card form isolation on the storefront

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA frontend and SDK tech lead. Decided during planning; revisit when a card vault or forwarding service takes the card off the storefront page (ADR-0011 follow-up), when any third-party script is wanted on checkout pages, or before airline-card payments go live after the M6 review.

## Context

[`decisions.md`](../../../docs/mvp/decisions.md) §2 adds a second payment method: the traveller's card goes through the OTA backend to Amadeus (`formOfPayments` CREDIT_CARD) and the airline charges it. [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) makes Velexis a PCI DSS service provider for this path. It puts the hosted storefront's payment page inside the cardholder data environment and requires:

- a strict CSP;
- no third-party analytics or tag managers on the payment page;
- an inventory of that page's scripts and a daily integrity check (PCI DSS requirements 6.4.3 and 11.6.1);
- only the hosted storefront may submit a card.

The backend side is in [OADR-0004](0004-airline-card-data-handling.md) and [`api-changes.md`](../api-changes.md) §3: one edge-only call, `checkout.completeWithAirlineCard`, with the card in memory only. The SDK never retries it ([OADR-0016](0016-sdk-packaging-and-type-contract.md)).

On the storefront, the card is typed into **our own page**, not into a provider iframe as with Stripe. Any script running on that page can read it. The Stripe card page must load Stripe.js, a third-party script. The open question is where and how the airline-card form lives, and what its JavaScript may do with the values.

## Decision

1. **A separate page.** The form lives on `/checkout/pay-airline.html` with its own entry bundle (page module, SDK, the few shared `lib/` helpers it needs). It never shares a page with Stripe.js or any other third-party script. The data steps (`/checkout.html`) and the Stripe page (`/checkout/pay-card.html`) are different documents ([OADR-0015](0015-storefront-build-urls-and-hosting.md) point 9).
2. **No third-party code at all on that page.** No Stripe.js, analytics, error-tracking SDK, chat widget, font or image from another origin. Header and footer are static partials. The page's JavaScript budget is 30 KB gzip, which keeps the code reviewable.
3. **A stricter CSP for that path.** Caddy sends a tighter policy for `/checkout/pay-airline.html` that drops every Stripe host:

   ```
   default-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'none';
   img-src 'self' data:; style-src 'self'; font-src 'self'; form-action 'self';
   frame-ancestors 'none'; base-uri 'self'; object-src 'none'
   ```

   It is added in the deploy Caddyfile (Follow-ups) and mirrored in `vite preview` for the E2E tests.
4. **The form cannot leak by itself.**
   - The card inputs have **no `name` attributes**, and the form is `method="post"` with no `action`, so a submission without JavaScript sends nothing.
   - Inputs use `autocomplete="cc-name"`, `cc-number`, `cc-exp-month`, `cc-exp-year` and `cc-csc`, so browsers and password managers can fill them, plus `inputmode="numeric"`.
   - A `<noscript>` notice explains that this method needs JavaScript.
5. **What the page's JavaScript may do with card values.**
   - Read them from the inputs only at submit time, into one local object passed directly to `checkout.completeWithAirlineCard`.
   - Before that, send only the brand (detected locally from the first digits) and the first six digits (BIN) to `checkout.updatePayment`, for the card-fee quote ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §B.5 allows BIN and last 4).
   - Never write them to `localStorage`, `sessionStorage`, IndexedDB, cookies, the URL, `history.state`, a `CustomEvent`, the console or an error message.
   - Clear all card inputs after success, after a decline or error, and on `pagehide`, so Back navigation and the browser's back-forward cache do not restore them.
6. **One attempt per submit.**
   - Each submit generates a new idempotency key.
   - The SDK does not retry the call.
   - On `504 SUPPLIER_TIMEOUT` the page goes to the confirmation page in pending mode and never re-sends the card ([`checkout-airline-card.md`](../flows/checkout-airline-card.md)).
   - Field errors never echo the value.
7. **Shown only when allowed.** The method appears only when `storefront.get` lists `airline_card` in `payment.supportedMethods`, which the backend does only when `AIRLINE_CARD_ENABLED` and the tenant's setting for the storefront environment are on. That means test only until the M6 review.
8. **Integrity and evidence.**
   - The page's scripts are inventoried in the [storefront README](../../frontend/README.md#10-security).
   - The daily integrity job of ADR-0011 §C hashes this page's HTML, scripts and security headers.
   - Playwright asserts that the page makes no third-party request, that no card value appears in storage, cookies, the URL or `history.state` after each path (success, decline, timeout, validation error), and that the inputs are empty after leaving the page.

## Consequences

### Positive

- The only code that can see a card number is first-party code served from the storefront origin, built from this repository, inventoried and hashed daily.
- The PCI scope on the frontend is one small page with one entry bundle, which makes reviews, the M6 penetration test and the SAQ D evidence manageable.
- The Stripe page keeps Stripe.js without ever sharing a document with raw card fields.

### Negative

- Two payment pages to maintain instead of one, and a path-specific CSP rule in Caddy.
- Autofill is the browser's: we cannot stop a browser from offering to save the card.
- A compromised first-party build (supply chain) could still read the card; the integrity check detects changes outside deploys but cannot prevent a malicious release. Dependency review and the small bundle are the mitigations.

### Follow-ups

- **Deploy (Caddyfile):** add the path-specific CSP of point 3 for `/checkout/pay-airline.html` (and `/checkout/pay-airline`) in the storefront snippet, replacing the general header for that path.
- **M6:** include this page in the script inventory review, the daily integrity check and the penetration test before `airline_card_enabled_live` may be set.
- Revisit with a card vault or forwarding service: the form would then become the provider's iframe, and this page would leave PCI scope.

## Alternatives considered

- **Airline-card fields on the same page as Stripe's Payment Element.** Stripe.js (third-party) would share the document with raw card numbers, against the payment-page rules of ADR-0011.
- **A cross-origin iframe on a dedicated host** (for example a separate card-entry origin). Stronger isolation from the storefront's own scripts, but a new host, certificates, CSP and `postMessage` protocol for a page that already has no third-party code. Worth it only if checkout pages ever need third-party scripts.
- **Building the form inside the checkout data page and switching sections.** Simpler navigation, but the data page's bundle (more code, shared components) would share the document with the card.
- **Disabling browser autofill (`autocomplete="off"`).** Browsers ignore it for card fields anyway, and it hurts accessibility and conversion.

## References

- [`decisions.md`](../../../docs/mvp/decisions.md) §2, [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §B–§C, [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)
- [OADR-0004](0004-airline-card-data-handling.md), [OADR-0015](0015-storefront-build-urls-and-hosting.md), [OADR-0016](0016-sdk-packaging-and-type-contract.md)
- [`../flows/checkout-airline-card.md`](../flows/checkout-airline-card.md), [`../api-changes.md`](../api-changes.md) §3, [`../../frontend/docs/pages.md`](../../frontend/docs/pages.md) §9
