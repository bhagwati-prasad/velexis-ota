# Storefront accessibility and performance pass

The pass of task OFE-024 over the hosted storefront ([`ota/frontend`](../frontend/README.md)) before the M6 launch: axe on every page in every main state, the manual screen-reader pass through search and checkout, Lighthouse's mobile figures for the home and results pages, and the font budget of the build. Targets: WCAG 2.2 AA ([storefront README §8](../frontend/README.md#8-accessibility-wcag-22-aa), [conventions §4](../../docs/mvp/conventions.md#4-vanilla-storefront-otafrontend)) and the budgets of [README §9](../frontend/README.md#9-performance-budgets). Each record names its date, commit and machine.

| Part | Result | Status |
|---|---|---|
| Automated pass: axe (WCAG 2.2 A and AA) on every page and state | No serious or critical violation on any of the 20 pages: 120 checks of the shared states and 76 of the pages' own states (2026-11-06) | Done; runs in every `storefront` run |
| Manual screen-reader pass (NVDA, VoiceOver) through search and checkout | Script below; not yet run | **Pending: human step** (no Windows or macOS machine here) |
| Lighthouse mobile, home and results | LCP and INP within target on both; CLS above 0.1 on both | Follow-up tasks OFE-027 and OFE-028 in the plan (§3.3) |
| Font budget: at most 2 families and 120 KB per page | In `scripts/check-budgets.mjs` (every build); every page within it after one fix (§4) | Done |

## 1. Automated pass (axe)

[`tools/e2e/specs/storefront/a11y-pages.e2e.ts`](../../tools/e2e/specs/storefront/a11y-pages.e2e.ts), project `storefront` (the production build in `vite preview` for the demo OTA, proxied to the built OTA API, the OTA worker and the Amadeus stub), under the storefront guards of every storefront journey: no CSP violation, no third-party request, no cookie JavaScript can read but `__Host-vx_csrf`, and axe with the WCAG 2.0, 2.1 and 2.2 A and AA rules on every page it visits, failing on `serious` and `critical` impacts ([`tools/e2e/support/a11y.ts`](../../tools/e2e/support/a11y.ts), which waits for running CSS transitions first).

```bash
pnpm build && E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/a11y-pages.e2e.ts
```

- **Every page.** The spec's first test compares its page list with the HTML files of `ota/frontend/dist/`: a page a later task adds fails the spec until it is covered.
- **The states every page shares** ([`docs/pages.md`](../frontend/docs/pages.md) §2), on each of the 20 pages: loading (storefront.get held while axe looks at the static page), and storefront.get answered `403 TENANT_SUSPENDED`, `403 HOST_NOT_ALLOWED`, `503 SERVICE_UNAVAILABLE`, `429 RATE_LIMITED` and `500` with a request id. The suspended OTA itself, with its own preview, is `search.e2e.ts`'s.
- **Each page's own states**, on data made through the OTA API as the browser's SDK makes it (`StorefrontApi` of `support/ota.ts`: searches, checkouts, airline-card payments, bookings of the demo OTA; no Stripe) and by the pages themselves (sign-up, sign-in, lookup, the airline-card form):

| Page | States |
|---|---|
| Home | the search form; its checks with the focused error summary; the location suggestions; no airport found; the passenger picker; multi-city |
| Results | searching (the search held); five offers; no match for the filters; no flights (the stub's `ZZZ`); prices expired (a search of its own date, expired); the airlines not answering (`504 SUPPLIER_TIMEOUT`, routed) |
| Offer | the fare families; no id; an offer that is gone (`404` of an id never issued); sold out at pricing (`409 SOLD_OUT`, routed) |
| Price | the confirmed price; "Changes and refunds" open with the airline's full fare rules; the airline changed the price (routed: the API's answer with `priceChange.changed`); price expired (routed: `expiresAt` in the past); no id; a price that is gone |
| Checkout | travellers; the travellers' field errors with the summary (routed `422 TRAVELER_DATA_INVALID`, §2 finding 2); contact details; extras; payment with its methods; session expired (`410 CHECKOUT_EXPIRED`, routed); no id |
| Airline card | the card form; the review with the airline's card fee; a number whose check digit is wrong (nothing sent, the summary focused); the stub's declined card; no id |
| Card payment | Stripe.js unavailable (its request aborted: Stripe.js never comes from the network here). The Payment Element itself is the nightly `storefront-stripe` journey's (`checkout-stripe.e2e.ts`), whose guards run axe on that page |
| Complete | a card payment that did not go through (routed: the payment read with method `card` and status `failed`); no id |
| Confirmation | a guest's ticketed booking with "Save your reference"; the customer's; a booking the airline has not confirmed (the stub's `server-error` at Flight Create Orders: `504`, pending); no access (another browser); no id |
| My bookings | the empty upcoming tab of a new customer; one upcoming trip; empty past and cancelled tabs; a visitor sent to sign-in |
| Booking | the customer's booking; the contact dialog; the cancel dialog with its refund preview; "Changes and refunds" open (for a booking synced less than a minute ago the API has no rules yet: `429`, "The fare rules could not be loaded right now" with Try again); a booking not found; a visitor ("Find your booking") |
| Lookup | the form; its checks; no booking found; too many attempts (`429`, routed) |
| Sign-in, sign-up | the forms; sign-up's checks; wrong credentials; a locked account (`423`, routed); a new customer's sign-up; an address that has an account (`409 EMAIL_ALREADY_REGISTERED`, the address signed up first in another browser) |
| Verify, password reset | no token; the new-password form; a token the API refuses; the address confirmed from the e-mail's link (Mailpit); the reset request sent |
| Account | the profile; the deletion dialog; a wrong current password; a profile changed in another tab (`412`, routed) |
| Content page, not found | a published page with headings, lists and links (routed `storefront.getPage`); a page that does not exist; the `404.html` page (status 404) |

What the stack cannot answer on demand is answered in the browser (`page.route`): the API's error envelope, or the API's own answer with one field changed. The pages, their scripts and their headers (the CSP among them) stay the preview's. Three forms are sent with the browser's own checks (`required`, `pattern`) switched off, so that the error state the page shows for the API's refusal is the one axe judges.

**Result (2026-11-06, `task/OFE-024-storefront-a11y-performance` on 37d2b53, the agents' Linux machine, Chromium 141.0.7390.37):** 36 tests passed in 2.9 minutes (2.4 minutes before the second-agent review added the sign-up of a registered address, the new-password form and the waits for the opened disclosures): the 6 shared states on each of the 20 pages (120 axe checks) and 76 axe checks of the pages' own states; axe reported no serious or critical violation anywhere, so no markup had to change for axe.

## 2. Findings and fixes

| # | Finding | Where | Fix |
|---|---|---|---|
| 1 | The visually hidden "Status" heading of the confirmation page had no weight class, so it is set in the heading font at 400: with an OTA's heading family other than its body family, the page loads that family's regular face as well, 142.8 KB of fonts (Merriweather headings on Inter text) against the budget of 120 KB. Hidden text still loads its face | `ota/frontend/confirmation.html` | `font-semibold` like every other heading; the font budget of `check-budgets.mjs` now catches such a heading on every page (§4) |
| 2 | The travellers step sent with its fields empty (the browser's checks off) went on to the contact step: the page sent `{"travelers":[{"travelerId":"1"}]}` and `PUT /v1/checkouts/{id}/travelers` answered `200`. Not an API defect: `TravelerInput` requires only `travelerId` (a form may send a traveller in parts), and the API keeps what is missing in `progress.missing` (`/travelers/0/name`, `REQUIRED`) with `travelersComplete: false`; `checkout.createPayment` later answers `422 CHECKOUT_INCOMPLETE` and the page goes back to the first incomplete step (pages.md §7). The page itself moves on after every `200` without reading `progress.missing`; in a browser the fields' `required` stops the empty form first | `ota/frontend/src/pages/checkout.js` (the travellers step) | Nothing for axe to fix. Whether the step should stay on its own form while `progress.missing` names its fields is a question to the lead (OFE-024's questions). The spec routes the `422 TRAVELER_DATA_INVALID` a refused name gets, so that axe judges the field errors and their summary |
| 3 | Layout shifts above the CLS target on both pages Lighthouse measures | Storefront layout | Follow-up tasks OFE-027 and OFE-028 (§3.3) |

## 3. Performance (Lighthouse)

### 3.1 How it was measured

Lighthouse 13.5.0 (its user-flow API, the default mobile configuration: Moto G Power emulation, simulated slow 4G and 4× CPU slowdown) with puppeteer-core 25.16.0 and the machine's Chromium 141.0.7390.37 headless, installed in a scratch folder (no project dependency), against `vite preview` of the production build on `http://127.0.0.1:4173` with the e2e harness's stack (the built OTA API on the Amadeus stub, demo OTA, test environment). Each page three times; per run a navigation (FCP, LCP, CLS, TBT) and then a timespan with what a traveller does first (INP):

- home `/`: type "Madrid" into From, pick the first suggestion with the arrow and Enter keys, switch One way and Return;
- results `/search.html?trip=oneway&from=MAD&to=PAR&depart=<69 days ahead>&adults=1&children=0&infants=0&cabin=ECONOMY` (the search runs on the page): direct flights only on and off, then sort by price.

INP needs real input, so it comes from the timespan; LCP and CLS from the navigation, as Lighthouse's navigation mode reports them.

### 3.2 Figures (2026-11-06, 37d2b53 with this task's changes, the agents' Linux machine)

| Page | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |
|---|---|---|---|---|---|---|---|
| Home | 1 | 0.92 | 1.67 s | 1.67 s | 0.166 | 0 ms | 19 ms |
| Home | 2 | 0.92 | 1.66 s | 1.66 s | 0.166 | 0 ms | 22 ms |
| Home | 3 | 0.99 | 1.66 s | 1.66 s | 0 | 0 ms | 23 ms |
| **Home, median** | | 0.92 | 1.66 s | **1.66 s** | **0.166** | 0 ms | **22 ms** |
| Results | 1 | 0.76 | 1.55 s | 1.91 s | 0.749 | 0 ms | 42 ms |
| Results | 2 | 0.75 | 1.72 s | 1.94 s | 0.749 | 0 ms | 34 ms |
| Results | 3 | 0.99 | 1.51 s | 2.02 s | 0 | 0 ms | 39 ms |
| **Results, median** | | 0.76 | 1.55 s | **1.94 s** | **0.749** | 0 ms | **39 ms** |

Bytes transferred: home 118 to 124 KB, results 162 KB. Fonts: one family on both pages (Inter 400 and 600 by default, 24.5 KB and 25.3 KB transferred, 48.7 KB together).

**LCP and INP are met on both pages; CLS is not.** Lighthouse's layout-shift culprits:

- **Both pages, 0.127 and 0.039:** `main` and the text under the form move down when the "Test mode: no real bookings or payments" banner (`partials/test-banner.html`, `hidden` in the HTML) is shown after storefront.get answers. A live storefront shows no banner and has no such shift; every test storefront has it. The third runs had no shift because the configuration answered before the first paint.
- **Results, 0.503 (and 0.073, 0.046):** on a phone the filters come before the results in one column; when the facets arrive, the filters grow by about 2 000 px and push the results and the footer down. With a real Amadeus search, which takes seconds, the results always arrive after the first paint, so the shift is the rule, not the exception.

### 3.3 Follow-up tasks (in the plan)

The CLS target is not met, so it has follow-up tasks in [`plans/agent-tasks.md`](plans/agent-tasks.md) (M6, each depending on OFE-024), whose acceptance is the Lighthouse figure measured again with the method of §3.1:

| Task | What it changes | Acceptance |
|---|---|---|
| [OFE-027](plans/agent-tasks.md#ofe-027--keep-the-results-page-from-shifting-on-phones) · Keep the results page from shifting on phones | On narrow screens the filters behind a disclosure above the results, or their space reserved before the facets arrive; the desktop sidebar, every filter's label and keyboard path kept | CLS of the results page ≤ 0.1 in three runs; `search.e2e.ts`, `keyboard-checkout.e2e.ts` and `a11y-pages.e2e.ts` pass |
| [OFE-028](plans/agent-tasks.md#ofe-028--show-the-test-banner-without-moving-the-page) · Show the test banner without moving the page | The banner's space kept from the first paint, or a place where showing it moves nothing and obscures nothing (2.4.11); a live storefront still without banner (OFE-021) | CLS of the home page on a test storefront ≤ 0.1 in three runs; `boot.test.js` still proves banner and `noindex` per environment |

## 4. Font budget

`ota/frontend/scripts/check-budgets.mjs` (every `build`, CI included) adds a FONT row per page: at most 2 families and 120 KB of woff2 files (counted as served: woff2 is compressed already). A page's text has two slots, the body text and the headings, which `lib/theme.js` sets to one bundled family each; the size is the worst choice an OTA can make among the families the page's stylesheets declare, with the faces a browser picks for the body text's weights (every `font-weight` of the stylesheets) and for the headings' (the weight classes of the page's h1 to h3 and `font-heading` elements, 400 without one, 600 for the headings the modules create), plus any preloaded font. Unit tests: `ota/frontend/test/budgets.test.js` (`[OFE-024]`).

After finding 1, every page of the build is at **119.6 KB** worst case (Merriweather body text, 96 KB for its two faces, with Inter headings, 23.9 KB), 1 or 2 families; the default fonts (Inter body and headings) are 47 KB.

## 5. Manual screen-reader pass

**Status: not yet run (human step).** The agents' machine has neither Windows nor macOS; NVDA and VoiceOver need them. Record the run here with its date, the tester, the build (commit) and the browser and screen-reader versions.

| Screen reader | Browser | Platform | Date | Tester | Commit | Result |
|---|---|---|---|---|---|---|
| NVDA (latest stable) | Firefox and Chrome | Windows 11 | | | | |
| VoiceOver | Safari | macOS (latest) | | | | |
| VoiceOver | Safari | iOS (latest) | | | | |

Script (the demo OTA on a local stack, [README §11](../frontend/README.md#11-local-development); the airline-card path with the stub's test card `4111 1111 1111 1111`, no Stripe needed):

1. **Home.** Landmarks and headings list (one `h1` "Search flights"); the skip link; the test banner read once. Trip type radios; From and To comboboxes: typing announces the number of suggestions, the arrow keys read each option, Enter chooses, Escape closes and keeps the text; the departure date; the passenger picker announces its state and each stepper's value; Search sent empty announces the error summary and its links move to the fields.
2. **Results.** "Searching airlines…" announced; then the number of flights; each offer card's route, times, stops, price and "Select" link read in a sensible order; a filter change announces the new count without moving the focus; the sort control.
3. **Offer and price.** The fare families as a radio group with their prices and inclusions; the price page's breakdown; the countdown not announced every second; "Continue to checkout".
4. **Checkout.** The step navigation with the current step; moving to a step reads its heading; every field's label, its required state and its error message; the summary of problems; the contact pre-filled; the payment methods and the terms checkbox.
5. **Airline-card page.** The card fields with their labels and autocomplete; the review with the airline's total; a wrong number's summary; "Do not close this page" while paying; the confirmation read from its heading, with the reference and the tickets.

Record each problem with the page, the step, the screen reader and what was heard; fix or make a task for each before launch.
