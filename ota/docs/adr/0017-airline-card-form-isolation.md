# OADR-0017: Airline-card form isolation on the storefront

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA frontend and SDK tech lead. Decided during planning; revisit when a card vault or forwarding service takes the card off the storefront page (ADR-0011 follow-up), when any third-party script is wanted on checkout pages, or before airline-card payments go live after the M6 review (the review decides whether the residual risk of a shared origin is accepted or a dedicated card-entry origin is built).
**Revisions:** 2026-10-12 (planning review): point 3 adds COOP and `worker-src 'none'`, point 5 forbids reading state written by other pages, point 7 limits the method to the edge, point 8 extends the inventory to the whole origin, and the Consequences state the residual risk of sharing the origin with Stripe.js and the other pages.

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

   It is added in the deploy Caddyfile (Follow-ups) and mirrored in `vite preview` for the E2E tests. The same path also gets:

   - `Cross-Origin-Opener-Policy: same-origin`, while **no other storefront page sends COOP `same-origin`**. Any other page of the origin (the Stripe page with Stripe.js, an OTA content page, a page with an XSS) that opens the card page with `window.open` therefore lands in a different browsing context group: its window handle reports `closed` and gives no access to the card inputs. `frame-ancestors 'none'` already stops same-origin framing.
   - `Cache-Control: no-store`.

   Every storefront page's CSP gets `worker-src 'none'`, so no script on the origin can register a service worker that would sit in front of the card page.
4. **The form cannot leak by itself.**
   - The card inputs have **no `name` attributes**, and the form is `method="post"` with no `action`, so a submission without JavaScript sends nothing.
   - Inputs use `autocomplete="cc-name"`, `cc-number`, `cc-exp-month`, `cc-exp-year` and `cc-csc`, so browsers and password managers can fill them, plus `inputmode="numeric"`.
   - A `<noscript>` notice explains that this method needs JavaScript.
5. **What the page's JavaScript may do with card values.**
   - Read them from the inputs only at submit time, into one local object passed directly to `checkout.completeWithAirlineCard`.
   - Before that, send only the brand (detected locally from the first digits) and the first six digits (BIN) to `checkout.updatePayment`, for the card-fee quote ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §B.5 allows BIN and last 4).
   - Never write them to `localStorage`, `sessionStorage`, IndexedDB, cookies, the URL, `history.state`, a `CustomEvent`, the console or an error message.
   - Never read state that other pages of the origin can write: the page takes the checkout and payment ids from its URL and everything else from the API (`checkout.get`, a fresh `storefront.get`), not from the `sessionStorage` configuration copy.
   - Clear all card inputs after success, after a decline or error, and on `pagehide`, so Back navigation and the browser's back-forward cache do not restore them.
6. **One attempt per submit.**
   - Each submit generates a new idempotency key.
   - The SDK does not retry the call.
   - On `504 SUPPLIER_TIMEOUT` the page goes to the confirmation page in pending mode and never re-sends the card ([`checkout-airline-card.md`](../flows/checkout-airline-card.md)).
   - Field errors never echo the value.
7. **Shown only when allowed.** The method appears only when `storefront.get` lists `airline_card` in `payment.supportedMethods`, which the backend does only for the storefront **edge** caller (the completion operation is edge-only, so `pk_` and `sk_` storefronts are never invited to collect card data) and only when `AIRLINE_CARD_ENABLED` and the tenant's setting for the storefront environment are on. That means test only until the M6 review. The edge-only fields are added per request, never taken from a cache filled by another caller ([OADR-0012](0012-storefront-settings-assets-and-pages.md) point 7).
8. **Integrity and evidence.**
   - Any script served on the storefront origin could draw a look-alike card form, so the PCI DSS 6.4.3 inventory covers **every** storefront page and entry bundle, and Stripe.js on the Stripe page (by URL, with its justification), not only this page ([storefront README](../../frontend/README.md#10-security), OFE-023).
   - The daily integrity job of ADR-0011 §C (11.6.1) hashes this page's HTML, scripts and security headers, and the Stripe page's; extending it to every page listed in the inventory is requested from the healthcheck's owner (X-030).
   - Playwright asserts that the page makes no third-party request, that no card value appears in storage, cookies, the URL or `history.state` after each path (success, decline, timeout, validation error), and that the inputs are empty after leaving the page.

## Consequences

### Positive

- The only code that runs in the document holding the card inputs is first-party code served from the storefront origin, built from this repository, inventoried and hashed daily.
- The card fields live in one small page with one entry bundle, which keeps the code that touches card values reviewable for the M6 penetration test and the SAQ D evidence.
- The Stripe page keeps Stripe.js without ever sharing a document with raw card fields, and COOP cuts the window handle another page could get on the card page.

### Negative

- Two payment pages to maintain instead of one, and a path-specific CSP rule in Caddy.
- Autofill is the browser's: we cannot stop a browser from offering to save the card.
- A compromised first-party build (supply chain) could still read the card; the integrity check detects changes outside deploys but cannot prevent a malicious release. Dependency review and the small bundle are the mitigations.
- **Residual risk of a shared origin.** The card page shares its origin with every storefront page, including `/checkout/pay-card.html`, which loads the third-party Stripe.js, and the OTA-managed `/p/*` pages. COOP, `frame-ancestors 'none'`, `worker-src 'none'` and point 5 stop those scripts from reading the real card page, but a malicious or compromised script on any of them could still draw a look-alike card form or send the visitor elsewhere. The frontend PCI scope is therefore the whole storefront origin, not one page: every entry bundle and Stripe.js are in the 6.4.3 inventory and the 11.6.1 checks (OFE-023, X-030, OBE-085). The M6 review (OBE-086) accepts this or asks for the dedicated origin below.

### Follow-ups

- **Deploy (Caddyfile):** add the path-specific CSP of point 3 for `/checkout/pay-airline.html` (and `/checkout/pay-airline`) in the storefront snippet, replacing the general header for that path.
- **Deploy (Caddyfile):** COOP `same-origin` and `Cache-Control: no-store` on the card page only, and `worker-src 'none'` in the general storefront CSP (OFE-014; `caddy-smoke.sh` asserts that no other path sends COOP `same-origin`).
- **Healthcheck (X-030):** compare every page of the inventory daily, not only the two payment pages.
- **M6:** include the whole origin in the script inventory review, the daily integrity check and the penetration test before `airline_card_enabled_live` may be set; record the decision on the residual risk.
- Revisit with a card vault or forwarding service: the form would then become the provider's iframe on the provider's origin, and card values would no longer pass through any script of the storefront origin.

## Alternatives considered

- **Airline-card fields on the same page as Stripe's Payment Element.** Stripe.js (third-party) would share the document with raw card numbers, against the payment-page rules of ADR-0011.
- **A dedicated card-entry origin** (one shared host such as `pay.ota.example.com`, or one per tenant, serving only the card page with the strict CSP and COOP). The strongest isolation: no other page, and neither Stripe.js nor an XSS elsewhere, shares the origin. Not chosen for the MVP because it needs a session hand-off to the other origin (a one-time token, since the `__Host-` checkout cookies cannot cross origins), its own CSRF handling, certificates for custom domains, and a new Caddy host, all for a method that stays test-only until M6. Revisit at the M6 review if the residual risk above is not accepted, and in any case before checkout pages get more third-party scripts.
- **Building the form inside the checkout data page and switching sections.** Simpler navigation, but the data page's bundle (more code, shared components) would share the document with the card.
- **Disabling browser autofill (`autocomplete="off"`).** Browsers ignore it for card fields anyway, and it hurts accessibility and conversion.

## References

- [`decisions.md`](../../../docs/mvp/decisions.md) §2, [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §B–§C, [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md)
- [OADR-0004](0004-airline-card-data-handling.md), [OADR-0015](0015-storefront-build-urls-and-hosting.md), [OADR-0016](0016-sdk-packaging-and-type-contract.md)
- [`../flows/checkout-airline-card.md`](../flows/checkout-airline-card.md), [`../api-changes.md`](../api-changes.md) §3, [`../../frontend/docs/pages.md`](../../frontend/docs/pages.md) §9
