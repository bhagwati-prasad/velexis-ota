# Storefront accessibility and performance pass

The pass of task OFE-024 over the hosted storefront ([`ota/frontend`](../frontend/README.md)) before the M6 launch: axe on every page in every main state, the manual screen-reader pass through search and checkout, Lighthouse's mobile figures for the home and results pages, and the font budget of the build. Targets: WCAG 2.2 AA ([storefront README §8](../frontend/README.md#8-accessibility-wcag-22-aa), [conventions §4](../../docs/mvp/conventions.md#4-vanilla-storefront-otafrontend)) and the budgets of [README §9](../frontend/README.md#9-performance-budgets). Each record names its date, commit and machine.

| Part | Result | Status |
|---|---|---|
| Automated pass: axe (WCAG 2.2 A and AA) on every page and state | No serious or critical violation on any of the 20 pages: 120 checks of the shared states and 76 of the pages' own states (2026-11-06); at phone width, 360 × 800 px, none either: the shared states, every page with a long OTA name, two currencies and a signed-in customer, home and results, with no sideways scrolling and no hidden focus (2026-11-11, OFE-030, §1.1); and with a signed-in customer's compact account menu closed and open on every page, its links by keyboard and by pointer, and the search form's plain form without its script (2026-11-12, OFE-031, §1.1); and home with a signed-in customer's 23-character first name at 800 and 1023 px, the compact menu closed and open (2026-11-13, OFE-032, §1.1) | Done; both run in every `storefront` run |
| Manual screen-reader pass (NVDA, VoiceOver) through search and checkout | Script below; not yet run | **Pending: human step** (no Windows or macOS machine here) |
| Lighthouse mobile, home and results | LCP and INP within target on both; CLS above 0.1 on both (2026-11-06). After OFE-027 (2026-11-10) the results page's own shifts are 0.025 of its 0.152 (0.749 before); the rest, 0.127, was the header growing and the test banner appearing when the configuration arrives, on every page (§3.4). Home on a test storefront: CLS 0.04 in each of three runs since OFE-028, which moved the banner and keeps the header's two rows on a phone from the first paint (2026-11-10, §3.5) | Done: with OFE-027 and OFE-028 merged, home 0.040 and results 0.027 in each of three runs, LCP and INP within target (2026-11-10, §3.6); OFE-029 closed as met by OFE-028 (lead decision 13a of 2026-11-10), and the shifts left with an axe pass at phone width are OFE-030 (§3.3). With OFE-030, at 412 and 360 px, for the demo OTA and for a long name with two currencies: home 0 and results 0.027 and 0.048 in each of three runs, LCP and INP within target (2026-11-11, §3.7). With OFE-031, at 412 and 360 px, as a visitor and as a signed-in customer (`--signed-in`): home 0 and results 0.027 and 0.048 in each of three runs, LCP and INP within target, and nothing in the header moves when `auth.getSession` answers late (2026-11-12, §3.8). With OFE-032 the compact menu applies up to `lg`: with a 23-character first name the home page moves by nothing when the session answers at 768, 800, 850, 900 and 1023 px (0.48 to 0.58 at 768 px before, and up to 850 px with a long OTA name), and from 1024 px the header is as before, where a first name of 50 to 60 characters still wraps the row at 1024 to 1100 px (2026-11-13, §3.8, "Left" a question for the lead) |
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
| Booking | the customer's booking; the contact dialog; the cancel dialog with its refund preview; "Changes and refunds" open (for a booking synced less than a minute ago the API has no rules yet: `429`, "The fare rules will be available in about a minute" with Try again, FIX-W47-OTA); a booking not found; a visitor ("Find your booking") |
| Lookup | the form; its checks; no booking found; too many attempts (`429`, routed) |
| Sign-in, sign-up | the forms; sign-up's checks; wrong credentials; a locked account (`423`, routed); a new customer's sign-up; an address that has an account (`409 EMAIL_ALREADY_REGISTERED`, the address signed up first in another browser) |
| Verify, password reset | no token; the new-password form; a token the API refuses; the address confirmed from the e-mail's link (Mailpit); the reset request sent |
| Account | the profile; the deletion dialog; a wrong current password; a profile changed in another tab (`412`, routed) |
| Content page, not found | a published page with headings, lists and links (routed `storefront.getPage`); a page that does not exist; the `404.html` page (status 404) |

What the stack cannot answer on demand is answered in the browser (`page.route`): the API's error envelope, or the API's own answer with one field changed. The pages, their scripts and their headers (the CSP among them) stay the preview's. Three forms are sent with the browser's own checks (`required`, `pattern`) switched off, so that the error state the page shows for the API's refusal is the one axe judges.

**Result (2026-11-06, `task/OFE-024-storefront-a11y-performance` on 37d2b53, the agents' Linux machine, Chromium 141.0.7390.37):** 36 tests passed in 2.9 minutes (2.4 minutes before the second-agent review added the sign-up of a registered address, the new-password form and the waits for the opened disclosures): the 6 shared states on each of the 20 pages (120 axe checks) and 76 axe checks of the pages' own states; axe reported no serious or critical violation anywhere, so no markup had to change for axe.

### 1.1 At phone width (OFE-030)

Every journey above, `a11y-pages.e2e.ts` included, runs at `lg` or wider. [`tools/e2e/specs/storefront/a11y-phone.e2e.ts`](../../tools/e2e/specs/storefront/a11y-phone.e2e.ts) runs the same axe check (`expectNoSeriousA11yViolations`, through the storefront guards) at **360 × 800 CSS pixels**, a phone held upright (touch, device pixel ratio 2), in the same `storefront` project:

```bash
pnpm --filter @velexis/ota-frontend build && E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/a11y-phone.e2e.ts specs/storefront/a11y-pages.e2e.ts
```

- **Every page** (its page list is compared with `dist/`, as in `a11y-pages.e2e.ts`) **in the states every page shares**: loading (storefront.get held) and storefront.get answered `403 TENANT_SUSPENDED`, `403 HOST_NOT_ALLOWED`, `503`, `429` and `500` (120 axe checks).
- **Every page with the header at its fullest**, once for a visitor and once for a signed-in customer (40 axe checks): storefront.get's own answer with an OTA name too long for one line (57 characters) and a second currency (the selector), routed in the browser; the customer signed up through the OTA API (`auth.signUp`, as the sign-up page's SDK calls it). Each visit checks the whole name in the link's text and title, the selector with both currencies (the card page takes it away; the airline-card page fills only the name of its static header) and the account menu (greeting, "Sign out", or "Sign in").
- **Home and results in the states a traveller meets first** (7 axe checks): the search form, its checks with the focused summary, the location suggestions, the passengers, multi-city; the offers and the "Filters" disclosure opened.
- **Reflow (1.4.10):** on every page and state above, no sideways scrolling at 360 px (`scrollWidth` of the document at most 360 px; not at most `window.innerWidth`, which the phone emulation widens to an overflowing page's width, so a comparison with it could never fail). **Focus not obscured (2.4.11):** every focus stop from the top of the home page to its search button has its centre in the window and nothing over it (the test banner included). **Target size (2.5.8):** axe's `target-size` rule (WCAG 2.2 AA) on every check; the header's currency selector is 28 px high.
- **A signed-in customer's account menu (OFE-031).** The signed-in visit of every page above now finds one "Account" button in the header, collapsed (`aria-expanded="false"`, "Sign out" not shown), judges the page with axe, opens the menu (the greeting, "My account" and "Sign out" in its panel over the page), checks reflow and axe again with it open, and closes it with Escape, the focus back on the button (19 axe checks more: every page but the airline-card page, whose static header has no menu). Every visit also finds the OTA's whole name on the footer's last line, the airline-card page's included.
- **Nothing moves when the session answers late (OFE-031).** On every page that shows the menu (all but the airline-card page, whose static header has none, and sign-in and sign-up, which send a customer on to the account page), at 360 × 800 and at Lighthouse's 412 × 823 (device pixel ratio 1.75), with a customer signed up through the OTA API: storefront.get and then `auth.getSession` are held in the browser after the first paint and then let through to the API (the configuration is never taken from `sessionStorage`), and a `PerformanceObserver` (`buffered`) records every layout shift from the first paint on. When the session answers, no shift moves an element of the header, and the header's height and the start of `main` stay where they were; the home page has no layout shift at all, from the first paint to the signed-in menu.
- **The menu by keyboard and by pointer (OFE-031).** Tab reaches the button; Enter and Space open it; Tab walks "My account" and "Sign out", and Tab past them closes the panel (it never covers the focused element); Escape closes it with the focus back on the button; "My account" and "Sign out" work from the keyboard. By pointer: a tap opens it, a tap on the page outside closes it with the focus back on the button, and "My account" and "Sign out" work (signing out ends the session: a new page shows "Sign in").
- **The search form without its script (OFE-031).** Every script of the build aborted in the browser (`page.route`), as when the page's script fails to load: the home page shows the form's enhanced shape when it has loaded and its plain form (the passenger fieldset, no passenger toggle, no "Multi-city") within 10 s, axe clean, and the plain GET form searches (`/search.html?trip=return&from=MAD&to=PAR&…&adults=1`). With its module the plain form never shows, before or after the 5 s (sampled every frame). The results page's form, in its closed "Change search" panel, keeps the enhanced shape long after the 5 s and shows its plain form within seconds of the panel opening.
- **Up to the large breakpoint (OFE-032).** Home with a customer whose first name has 23 characters ("Maximiliana-Alexandrina", signed up through the OTA API), in a window 900 px high (device pixel ratio 1, no touch) whose width the test sets per visit, for the demo OTA and with the header at its fullest (the long OTA name and two currencies above), each visit with storefront.get and then `auth.getSession` held as above: at 768, 800, 850, 900 and 1023 px the header shows the compact "Account" button (the greeting not in the row), the session's answer moves nothing (no layout shift at all, and none in the header, which keeps its height, as does the navigation, and `main` its start), the home page moves by nothing from the first paint on, and the page needs no sideways scrolling; at 800 and 1023 px axe judges it with the menu closed and open (the whole greeting, "My account" and "Sign out" in the panel), and Escape closes it with the focus back on the button. At 1024 and 1280 px the button is not shown and the greeting, "My account" and "Sign out" stand in the navigation's row, on its one line, which does not wrap when the session answers, and axe judges the page (12 axe checks more: 8 at 800 and 1023 px, 4 at 1024 and 1280 px).

**Result (2026-11-11, `task/OFE-030-phone-layout-shifts-axe` on ad5e666 with this task's changes, the agents' Linux machine, 4 CPUs, headless Chromium 153.0.8010.12):** 44 tests passed in 2.9 minutes (167 axe checks of the spec's own, besides the guards' check at the end of each test); axe reported no serious or critical violation at 360 px, every page reflows and no focus stop is hidden, so no markup had to change for axe. The two runs before that failed on the spec's own expectations (the airline-card page's static header, the card page without a currency selector), not on axe. The review (2026-11-11) found that the reflow check first compared the document's width with `window.innerWidth`, which the phone emulation widens to the width of an overflowing page, so it could not fail; it now compares with 360 px (the header's name without its ellipsis fails it), and the spec passed again with `a11y-pages.e2e.ts` (80 tests in 3.7 minutes), so every page does reflow at 360 px.

**Result with OFE-031 (2026-11-12, `task/OFE-031-phone-account-menu-search-fallback-footer` on 08836fd with this task's changes, the same machine and browser):** `a11y-phone.e2e.ts` has 66 tests (44 before), and they passed with `a11y-pages.e2e.ts` and `account-bookings.e2e.ts` (114 tests in 5.5 minutes): axe reported no serious or critical violation at 360 px for a visitor and for a signed-in customer with the account menu closed and open, every page reflows with the menu open, the menu's links work by keyboard and by pointer, nothing moves when the session answers late (§3.8), and the search form falls back to its plain form without its script. The first run failed on three of the spec's own mistakes and one finding: the reflow check at 412 px compared with 360 px, and a label that also named the children's stepper; and the finding, a tap on `main`'s text focused `main` (`tabindex="-1"`), whose focus closed the menu before the click could give the focus back to the button, so the menu now closes on the press itself (`pointerdown`) and gives the focus back on the click that follows. The review (2026-11-12) found two more: a press outside whose click never came (a touch that became a scroll, `pointercancel`) left its click listener behind, so any later click on the page took the focus up to the button; and Escape closed the panel only with the focus in the menu, which a browser that does not focus a pressed button (Safari, Firefox on macOS) never puts there. The press is now forgotten on `pointercancel` or at the next press, and Escape is heard on the whole document while the panel is open (`auth-pages.test.js`).

**Result with OFE-032 (2026-11-13, `task/OFE-032-compact-menu-below-lg` on facaf119 with this task's changes, the same machine, headless Chromium 153.0.8010.12, Playwright 1.65.0):** `a11y-phone.e2e.ts` has 70 tests (66 before); all passed twice, in 5.1 and 4.7 minutes (the second run is the task's Verify command), with a Redis of their own under the machine's e2e lock: with a 23-character first name the home page moved by nothing at 768, 800, 850, 900 and 1023 px for both storefronts, axe reported no serious or critical violation at 800 and 1023 px with the menu closed or open, and at 1024 and 1280 px the links stood in the row, which did not wrap. Against a scratch build with the menu's `md` breakpoint of before (`lib/session.js` and `partials/header.html` of facaf119, not committed) the first of the new tests failed at 768 px, where the compact menu was missing. The review (2026-11-13) ran the Verify command again with a scratch probe of longer first names beside it (72 tests in 5.5 minutes, all passed; the probe's figures in §3.8 "Left") and corrected this section's count of the new axe checks (12, not 8).

## 2. Findings and fixes

| # | Finding | Where | Fix |
|---|---|---|---|
| 1 | The visually hidden "Status" heading of the confirmation page had no weight class, so it is set in the heading font at 400: with an OTA's heading family other than its body family, the page loads that family's regular face as well, 142.8 KB of fonts (Merriweather headings on Inter text) against the budget of 120 KB. Hidden text still loads its face | `ota/frontend/confirmation.html` | `font-semibold` like every other heading; the font budget of `check-budgets.mjs` now catches such a heading on every page (§4) |
| 2 | The travellers step sent with its fields empty (the browser's checks off) went on to the contact step: the page sent `{"travelers":[{"travelerId":"1"}]}` and `PUT /v1/checkouts/{id}/travelers` answered `200`. Not an API defect: `TravelerInput` requires only `travelerId` (a form may send a traveller in parts), and the API keeps what is missing in `progress.missing` (`/travelers/0/name`, `REQUIRED`) with `travelersComplete: false`; `checkout.createPayment` later answers `422 CHECKOUT_INCOMPLETE` and the page goes back to the first incomplete step (pages.md §7). The page itself moves on after every `200` without reading `progress.missing`; in a browser the fields' `required` stops the empty form first | `ota/frontend/src/pages/checkout.js` (the travellers step) | Nothing for axe to fix. Whether the step should stay on its own form while `progress.missing` names its fields is a question to the lead (OFE-024's questions). The spec routes the `422 TRAVELER_DATA_INVALID` a refused name gets, so that axe judges the field errors and their summary |
| 3 | Layout shifts above the CLS target on both pages Lighthouse measures | Storefront layout | Follow-up tasks OFE-027 and OFE-028 (§3.3); OFE-029 for the header, which OFE-027's measurement found (§3.4); OFE-028 moved the test banner and kept the header's rows on a phone (§3.5); OFE-029 closed on 2026-11-10 as met by that header change (lead decision 13a, §3.6) |
| 4 | Shifts left after OFE-027 and OFE-028 (the search form's enhancement, 0.04 at 412 px and 0.122 on a 360 px phone; the footer of short pages, 0.016; a long OTA name at 640 px and wider; the taller currency selector of an OTA with two or more currencies), and no axe check at phone width: every journey, `a11y-pages.e2e.ts` included, runs at `lg` or wider | Storefront layout; `tools/e2e/specs/storefront/` | Follow-up task [OFE-030](plans/agent-tasks.md#ofe-030--remove-the-layout-shifts-left-on-phones-and-run-axe-at-phone-width) (lead decision 13a of 2026-11-10): CLS at most 0.1 at 360 and 412 px in three runs each on home and results, and axe clean at 360 px (§3.3, §3.5). **Done by OFE-030 (2026-11-11):** each of the four given its final size from the first paint (§3.7), and `a11y-phone.e2e.ts` at 360 px (§1.1) |
| 5 | The account menu of a signed-in customer on a phone: "Hi, ‹name›", "My account" and "Sign out" do not fit beside "Find a booking" and "My bookings" on a 360 or 412 px row, so when `auth.getSession` answers (after the first paint, on every page) the navigation wraps onto a second row and the page moves down by 28 px (0.25 to 0.26 with storefront.get held, on every page but sign-in; the same before OFE-030). With a long OTA name and two currencies the same happens from 640 to 767 px (0.34). Not in Lighthouse's figures, which are a visitor's | `partials/header.html`, `lib/session.js` (`renderAccountMenu`) | Not fixed by OFE-030: each way out changes the header's design for everyone (a third row on every phone, also for visitors and for an OTA without customer accounts, or a compact account menu, a disclosure, in `lib/session.js`), a decision for the lead (OFE-030's questions; §3.7). **Decided (2026-11-11, lead decision (17l), approved by the owner):** follow-up task [OFE-031](plans/agent-tasks.md#ofe-031--keep-a-signed-in-customers-phone-page-still-fall-back-to-the-plain-search-form-and-show-the-otas-full-name-in-the-footer): on phones a signed-in customer's account links sit behind one compact account-menu button in the place the "Sign in" link has from the first paint, so the page does not move when `auth.getSession` answers; Lighthouse and `a11y-phone.e2e.ts` prove it with a signed-in customer (§3.3). **Fixed by OFE-031 (2026-11-12):** below `md` (768 px, which covers the 640 to 767 px case too) one "Account" button, a disclosure, takes the "Sign in" link's place, whose slot keeps the button's width from the first paint; when `auth.getSession` answers late nothing in the header moves at 360 and 412 px on any page, and the home page moves by nothing at all (§3.8, `a11y-phone.e2e.ts`). **Extended by OFE-032 (2026-11-13, lead decision (20h), approved by the owner):** a first name of about 20 characters or more still wrapped the row from 768 px (to 850 px with a long OTA name and two currencies), so the compact menu applies below `lg` (1024 px); with a 23-character first name the home page moves by nothing when the session answers at 768 to 1023 px, and from 1024 px the header is as before (§3.8) |

## 3. Performance (Lighthouse)

### 3.1 How it was measured

Lighthouse 13.5.0 (its user-flow API, the default mobile configuration: Moto G Power emulation, simulated slow 4G and 4× CPU slowdown) with puppeteer-core 25.16.0 and the machine's Chromium 141.0.7390.37 headless, installed in a scratch folder (no project dependency), against `vite preview` of the production build on `http://127.0.0.1:4173` with the e2e harness's stack (the built OTA API on the Amadeus stub, demo OTA, test environment). Each page three times; per run a navigation (FCP, LCP, CLS, TBT) and then a timespan with what a traveller does first (INP):

- home `/`: type "Madrid" into From, pick the first suggestion with the arrow and Enter keys, switch One way and Return;
- results `/search.html?trip=oneway&from=MAD&to=PAR&depart=<69 days ahead>&adults=1&children=0&infants=0&cabin=ECONOMY` (the search runs on the page): direct flights only on and off, then sort by price.

INP needs real input, so it comes from the timespan; LCP and CLS from the navigation, as Lighthouse's navigation mode reports them.

**The script (OFE-027, lead decision 11n of 2026-11-06).** The method is now [`ota/frontend/scripts/lighthouse.mjs`](../frontend/scripts/lighthouse.mjs), so the figures can be repeated: Lighthouse 13.5.0 and puppeteer-core 25.16.0 as exact devDependencies of the storefront, the same configuration, addresses and interactions (on a narrow screen the results timespan first opens the "Filters" disclosure, OFE-027), each run in a new browser with an empty profile. It prints the table of §3.2 with a median row per page and each run's layout shifts with the element each moved most, and exits 1 when a run misses a target. Chromium comes from `--chrome`, else `CHROME_PATH`, else `/opt/pw-browsers/chromium` (the agents' machine); it measures a running preview (`--base-url`, default `http://127.0.0.1:4173`): the local one of [README §11](../frontend/README.md#11-local-development) or the e2e harness's while a run holds its stack (the figures of §3.4: a scratch spec, not committed, held the stack and ran the script). **Phone width (OFE-030):** `--width 412` (the default, Lighthouse's own phone, the Moto G Power's 412 × 823 screen) and `--width 360` (a 360 × 800 phone), repeatable: each page is measured at each width, with the same device pixel ratio (1.75), user agent and throttling (only the flow's `screenEmulation` width and height differ), and the report names each page with its width when a run is not at 412 px. **Signed in (OFE-031):** `--signed-in` measures a signed-in customer: in each run's new browser, before the measured navigation, a customer of the invocation signs in through the storefront's own pages (signed up through the sign-up page in the first run, then signed in through the sign-in page, because the API allows 5 sign-ups per hour per address), the page's `sessionStorage` is emptied so that storefront.get is asked again, and the session's cookies stay for the navigation (Lighthouse's storage reset keeps cookies); each run reports the status of its `auth.getSession` request (`200` signed in, `401` a visitor), and a signed-in run whose navigation was not signed in stops the script.

```bash
pnpm exec turbo run build --filter=@velexis/ota-backend --filter=@velexis/ota-frontend
# a preview on 4173 with the OTA API behind it (README §11), then:
CHROME_PATH=/path/to/chromium pnpm --filter @velexis/ota-frontend lighthouse -- --page results --runs 3 --json /tmp/lighthouse-results.json
# both phones, both pages (OFE-030):
CHROME_PATH=/path/to/chromium pnpm --filter @velexis/ota-frontend lighthouse -- --width 412 --width 360 --runs 3
# the same for a signed-in customer (OFE-031):
CHROME_PATH=/path/to/chromium pnpm --filter @velexis/ota-frontend lighthouse -- --width 412 --width 360 --runs 3 --signed-in
```

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

- **Both pages, 0.127 and 0.039:** `main` and the text under the form move down when the "Test mode: no real bookings or payments" banner (`partials/test-banner.html`, `hidden` in the HTML) is shown after storefront.get answers. A live storefront shows no banner and has no such shift; every test storefront has it. The third runs had no shift because the configuration answered before the first paint. (Corrected in §3.4 and §3.5: the 0.127 is the banner and, on a phone, the header growing in the same frame, which a live storefront has too; the 0.039 is the search form, not the banner.)
- **Results, 0.503 (and 0.073, 0.046):** on a phone the filters come before the results in one column; when the facets arrive, the filters grow by about 2 000 px and push the results and the footer down. With a real Amadeus search, which takes seconds, the results always arrive after the first paint, so the shift is the rule, not the exception.

### 3.3 Follow-up tasks (in the plan)

The CLS target is not met, so it has follow-up tasks in [`plans/agent-tasks.md`](plans/agent-tasks.md) (M6, each depending on OFE-024; OFE-029, which OFE-027's measurement found, on OFE-027 and OFE-028; OFE-030, lead decision 13a of 2026-11-10, on OFE-028; OFE-031, lead decision 17l of 2026-11-11, on OFE-030; OFE-032, lead decision 20h of 2026-11-13, on OFE-031), whose acceptance is the Lighthouse figure measured again with the method of §3.1 (OFE-032's, the layout shift of a late session in `a11y-phone.e2e.ts`):

| Task | What it changes | Acceptance |
|---|---|---|
| [OFE-027](plans/agent-tasks.md#ofe-027--keep-the-results-page-from-shifting-on-phones) · Keep the results page from shifting on phones | On narrow screens the filters behind a disclosure above the results, or their space reserved before the facets arrive; the desktop sidebar, every filter's label and keyboard path kept | CLS of the results page ≤ 0.1 in three runs; `search.e2e.ts`, `keyboard-checkout.e2e.ts` and `a11y-pages.e2e.ts` pass. **Met on 2026-11-10 with OFE-028 merged: 0.027 in each run (§3.6)** |
| [OFE-028](plans/agent-tasks.md#ofe-028--show-the-test-banner-without-moving-the-page) · Show the test banner without moving the page | The banner's space kept from the first paint, or a place where showing it moves nothing and obscures nothing (2.4.11); a live storefront still without banner (OFE-021) | CLS of the home page on a test storefront ≤ 0.1 in three runs; `boot.test.js` still proves banner and `noindex` per environment. **Met on 2026-11-10: 0.04 in each run (§3.5)** |
| [OFE-029](plans/agent-tasks.md#ofe-029--keep-the-header-from-growing-when-the-configuration-arrives) · Keep the header from growing when the configuration arrives (found by OFE-027, §3.4) | The header's final shape from the first paint on a phone, where the OTA's name now pushes the navigation onto a second row | CLS of the home and results pages on a test storefront ≤ 0.1 in three runs, with OFE-027 and OFE-028. The figures are met since OFE-028's header change (home 0.040, results 0.027, §3.6). **Closed on 2026-11-10 (lead decision 13a): met by OFE-028's header change (c99ce87)** |
| [OFE-030](plans/agent-tasks.md#ofe-030--remove-the-layout-shifts-left-on-phones-and-run-axe-at-phone-width) · Remove the layout shifts left on phones and run axe at phone width (lead decision 13a of 2026-11-10) | The shifts §3.5 found left (the search form's enhancement, also on a 360 px phone; the footer of short pages; a long OTA name at 640 px and wider; the taller currency selector), a phone width for `scripts/lighthouse.mjs`, and an axe spec at 360 px | CLS of home and results ≤ 0.1 in three runs each at 360 and 412 px; no serious or critical axe violation at 360 px. **Met on 2026-11-11 (§3.7, §1.1)** |
| [OFE-031](plans/agent-tasks.md#ofe-031--keep-a-signed-in-customers-phone-page-still-fall-back-to-the-plain-search-form-and-show-the-otas-full-name-in-the-footer) · Keep a signed-in customer's phone page still, fall back to the plain search form, and show the OTA's full name in the footer (lead decision 17l of 2026-11-11) | The account menu that §3.7 left (a compact account-menu button on phones in the place of "Sign in"), the search form's plain form when its module has not mounted a few seconds after load, the OTA's whole name in the footer, and a signed-in option for `scripts/lighthouse.mjs` | CLS of home and results ≤ 0.1 in three runs each at 360 and 412 px with a signed-in customer, nothing moving in the header when `auth.getSession` answers late; no serious or critical axe violation at 360 px with the menu open or closed. **Met on 2026-11-12 (§3.8, §1.1)** |
| [OFE-032](plans/agent-tasks.md#ofe-032--keep-the-compact-signed-in-account-menu-up-to-the-large-breakpoint) · Keep the compact signed-in account menu up to the large breakpoint (lead decision 20h of 2026-11-13, §3.8 "Left") | The compact account menu below `lg` (1024 px) instead of below `md`, so a long first name never wraps the navigation's row when the session answers | With a 23-character first name, no layout shift on home when the session answers at 768, 800, 850, 900 and 1023 px; the header unchanged from 1024 px; no serious or critical axe violation at 800 and 1023 px with the menu closed and open. **Met on 2026-11-13 (§3.8, §1.1)** |

### 3.4 The results page after OFE-027 (2026-11-10)

Measured with the script (§3.1) on the agents' Linux machine (4 CPUs, load average about 1; replaced on 2026-11-06, so Chromium is now 153.0.8010.12 instead of 141), against the e2e harness's stack: first the build of 6d8ab82 without this task's changes, then `task/OFE-027-results-page-cls` on 6d8ab82 with them. The build before repeats §3.2's CLS and its culprits exactly.

| Page | Build | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |
|---|---|---|---|---|---|---|---|---|
| Results | before | 1 | 0.75 | 1.74 s | 1.96 s | 0.749 | 0 ms | 37 ms |
| Results | before | 2 | 0.75 | 1.72 s | 1.94 s | 0.749 | 0 ms | 36 ms |
| Results | before | 3 | 0.75 | 1.74 s | 2.00 s | 0.749 | 26 ms | 49 ms |
| Results | OFE-027 | 1 | 0.92 | 1.72 s | 1.96 s | 0.152 | 3 ms | 45 ms |
| Results | OFE-027 | 2 | 0.92 | 1.74 s | 2.01 s | 0.152 | 24 ms | 53 ms |
| Results | OFE-027 | 3 | 0.92 | 1.72 s | 1.98 s | 0.152 | 5 ms | 47 ms |
| **Results, OFE-027, median** | | | 0.92 | 1.72 s | **1.98 s** | **0.152** | 5 ms | **47 ms** |
| Home | OFE-027 | 1 to 3 | 0.92 | 1.56 to 1.66 s | 1.56 to 1.87 s | 0.166 | 2 to 26 ms | 20 to 32 ms |

LCP and INP stay within target (the results timespan has one interaction more, the disclosure's); results transfer 160 KB (164 KB before), fonts 48.7 KB; the home page is unchanged (§3.2's 0.166, OFE-028 and OFE-029). What moved on the results page, from Lighthouse's culprits and a `PerformanceObserver` trace of the same page at 412 × 823 px:

| Shift (before) | Lighthouse | Cause | OFE-027's change (`search.html`, `components/filters.js`) | After |
|---|---|---|---|---|
| The results and the footer pushed down when the facets arrive | 0.503 | On a phone the filters (about 2 000 px) come before the results in one column | The filters behind a "Filters (n)" disclosure above the results, closed by default, in place (disabled) from the searching state on; the desktop sidebar unchanged | gone |
| The results moved up when the count arrives | (inside 0.503 before; 0.099 with the disclosure alone) | The heading row puts "Searching airlines…" and "Sort by" on two rows, "5 flights" and "Sort by" on one | The row stacked below `sm` | gone |
| The results pushed down by the airport names | 0.073 | When flights.search answers, the heading and the summary change from codes to names ("Flights from Adolfo Suárez Madrid–Barajas Airport (MAD) to Paris (PAR)": three lines on a phone, the summary two) | Below `sm` the heading and the summary keep two lines each from the first paint | 0.025 (the heading's third line) |
| The footer leaving the screen, the summary's first line | 0.046 | The footer sat at the bottom of the short page until the skeleton came; the empty summary had no height | `main` at least one screen high; the summary keeps its line from the first paint | gone |
| `main` moved down by the header and the banner | 0.127 | When storefront.get answers, the header grows from 52 to 88 px (the OTA's name, "Demo Travel" instead of "Flights", no longer fits beside the navigation, which wraps to a second row) and the test banner (38 px) appears above it | None (shared partials and `boot()`): OFE-029 and OFE-028 | 0.127 |

**Result.** The results page's CLS fell from 0.749 to 0.152 in each of three runs; of the 0.152, 0.127 is the header and banner shift of every page and 0.025 the results page's own. The target of 0.1 is therefore not met yet: OFE-027's acceptance waits for OFE-028 and OFE-029, measured again with the script (met once OFE-028 was merged: 0.027 in each run, §3.6). A scratch build without the banner (its partial taken out of `dist/`, not a product state) shows the split: results 0.148 (0.121 the header alone, 0.027 the page's own), home 0.161 (0.121 the header, 0.040 the text under the form); the header's growth is about the whole shift that §3.2 put on the banner, and a live storefront with a name as long has it too.

**Review check (2026-11-10, the same build and stack).** The script repeated these figures (results 0.152 and home 0.166 in each of three runs, LCP medians 2.00 s and 1.60 s, INP medians 75 ms and 34 ms; load average about 4). A `PerformanceObserver` trace at 412 × 823 px (its sums equal Lighthouse's CLS) with CSS injected into the page, not a product state, splits the 0.127 frame: without the banner 0.121 (the navigation moves from y 16 to 56 when it wraps); with the header in its final shape from the first paint (the navigation on its own row under the name) and the banner still shown 0.046, so the results page would measure 0.072 and the home page 0.085; with both, 0.027 and 0.040. The header (OFE-029) is therefore what keeps both pages above the target; the banner (OFE-028) adds 0.046.

### 3.5 The test banner and the header (OFE-028, 2026-11-10)

**What moved.** Measured again, with storefront.get also held back in the browser so that it always answers after the first paint (below), the home page's 0.127 of §3.2 is two changes in one frame when the configuration arrives: the banner, shown above the header, pushes the page down by its 38 px; and on a phone the header grows by 36 px, because the OTA's name ("Demo Travel"), longer than the placeholder "Flights", pushes the navigation onto a second row. The second change happens on a live storefront too. The 0.039 is not the banner: the home page's module folds the search form's passenger fieldset into its "Passengers" button, so the text under the form moves up.

**What changed.**

- The banner is fixed to the bottom of the window (`fixed inset-x-0 bottom-0 z-10` in `partials/test-banner.html`; the location suggestions, and on wider screens the passenger panel, open over it), so showing it moves nothing that is painted. While it shows, `components/test-banner.js` keeps its height in `--vx-test-banner-height` on `<html>`, measured when it appears and again on every size change through a `ResizeObserver` (wrapped text on a narrow screen, a font that arrives, zoomed text). `main.css` turns that height into the root's `padding-bottom`, so the end of every page can be scrolled clear of the banner, and into its `scroll-padding-bottom`, so the browser scrolls a focused element above the banner rather than behind it (2.4.11, technique C43).
- A live storefront shows no banner and keeps no space for it (the property is unset, both values are 0); an environment the build does not know is still shown as test (OFE-021), now on the airline-card page too, which mounts the banner with storefront.get's value as it is: the component itself hides it only for `live`. The banner stays the first element of the page, before the skip link and the header, a `role="note"` and not a live region, so a screen reader reads it once, first (`test/boot.test.js`, `[OFE-028 AC2]`).
- On a phone (below 640 px, `max-sm:flex-col max-sm:items-start` in `partials/header.html`) the header's name and navigation are two rows from the first paint, so the OTA's name no longer moves the page when it arrives. A name longer than the placeholder already gave the header these two rows on a phone.

**Lighthouse mobile figures** (the method of §3.1, three runs per page and build: Lighthouse 13.5.0 and puppeteer-core 25.16.0 in a scratch folder, by hand: the pinned script of OFE-027 was not merged yet; headless Chromium 153.0.8010.12; the e2e harness's stack under its lock, the demo OTA in the test environment with one currency, EUR; this task's build on `task/OFE-028-test-banner-cls` (6d8ab82 with this task's changes) in the stack's preview on 4173, and the build of 6d8ab82 itself in a second `vite preview` on 4180 with the same proxy; the agents' Linux machine, 4 CPUs, load average 0.66 at the start):

| Page | Build | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |
|---|---|---|---|---|---|---|---|---|
| Home | 6d8ab82 | 1 | 0.92 | 1.66 s | 1.66 s | 0.166 | 6 ms | 25 ms |
| Home | 6d8ab82 | 2 | 0.92 | 1.57 s | 1.57 s | 0.166 | 8 ms | 28 ms |
| Home | 6d8ab82 | 3 | 0.92 | 1.61 s | 1.63 s | 0.166 | 0 ms | 27 ms |
| Home | OFE-028 | 1 | 0.99 | 1.58 s | 1.82 s | **0.04** | 25 ms | 28 ms |
| Home | OFE-028 | 2 | 0.99 | 1.57 s | 1.78 s | **0.04** | 12 ms | 19 ms |
| Home | OFE-028 | 3 | 0.99 | 1.57 s | 1.79 s | **0.04** | 19 ms | 32 ms |
| **Home, OFE-028, median** | | | 0.99 | 1.57 s | **1.79 s** | **0.04** | 19 ms | **28 ms** |
| Results | 6d8ab82 | 1 | 0.75 | 1.72 s | 1.97 s | 0.749 | 23 ms | 36 ms |
| Results | 6d8ab82 | 2 | 0.75 | 1.73 s | 1.97 s | 0.749 | 16 ms | 38 ms |
| Results | 6d8ab82 | 3 | 0.75 | 1.52 s | 2.05 s | 0.749 | 0 ms | 54 ms |
| Results | OFE-028 | 1 | 0.75 | 1.73 s | 1.98 s | 0.67 | 17 ms | 51 ms |
| Results | OFE-028 | 2 | 0.75 | 1.73 s | 1.96 s | 0.67 | 15 ms | 50 ms |
| Results | OFE-028 | 3 | 0.76 | 1.71 s | 1.92 s | 0.67 | 0 ms | 40 ms |
| **Results, OFE-028, median** | | | 0.75 | 1.73 s | **1.96 s** | **0.67** | 15 ms | **50 ms** |

Bytes transferred: home 119.0 to 124.8 KB (124.5 KB before), results 162.4 to 168.2 KB (162.1 to 167.8 KB before).

- **Home: CLS 0.04 in each of the three runs, at most 0.1 (OFE-028's acceptance); LCP and INP within target.** The one shift left is the search form's (0.04: `main > p.mt-8`, the text under the form). The build of 6d8ab82 had 0.166 in all three runs (0.127 on `main`, 0.039 on that text). The LCP of this build is the same paint as its FCP (observed at 118 to 156 ms on this unthrottled machine, as before); Lighthouse's simulation counts storefront.get in its path when the request ended before that paint, as it did in these runs, hence about 0.2 s more than the FCP.
- **Results: CLS 0.67** (0.749 before): the 0.127 of the banner and the header is gone; what is left is OFE-027's (the filters and the results, 0.546 and 0.078, and the footer, 0.037 and 0.010).

**With storefront.get held** (the same comparison independent of how fast the local API answers, which here was often before the first paint): Playwright 1.64.1 with the same Chromium, `vite preview` of both builds, storefront.get answered in the browser 800 ms after the request (the demo configuration, test environment, its other calls refused), the layout shifts of a `PerformanceObserver` summed until a second after the header shows the OTA's name:

| Page | Window | 6d8ab82 | OFE-028 |
|---|---|---|---|
| Home | 412 × 823 (Lighthouse's phone) | 0.166 | 0.040 (the search form) |
| Find a booking, not found (404) | 412 × 823 | 0.127 | 0.016 (the footer growing as it fills, on a page shorter than the window) |
| Home | 1280 × 720 | 0.063 | 0.037 (the search form) |
| Find a booking, not found (404) | 1280 × 720 | 0.025 | 0 |

A live storefront in the same check: no banner, no space after the page, home 0.040 on the phone (the search form). Focus: Tab through home, find a booking, sign-in, sign-up and the 404 page in both windows met no focused element behind the banner; the same walk without the root's scroll padding left the sign-up button and, on the short pages of the desktop window, five footer links behind it.

**Still moving, not the banner** (task OFE-030 since lead decision 13a of 2026-11-10, §3.3): the search form's enhancement on home and results (0.04 on Lighthouse's phone; on a 360 px phone the trip type radios also wrap onto a second row when "Multi-city" appears, 0.122 with storefront.get held); the footer of a page shorter than the window growing as it fills (0.016); on a window 640 px or wider, an OTA name long enough to push the navigation onto a second row; and the currency selector of an OTA with two or more currencies, a taller control that can make the navigation row grow.

The journeys pass with the banner at the bottom (2026-11-10, the same build and machine): `a11y-pages.e2e.ts` (36 tests: no serious or critical axe violation on any page or state), every spec of the `storefront` project (91 tests, `search.e2e.ts` and `keyboard-checkout.e2e.ts` among them), and the two other journeys that look for the banner, `ota-admin/settings-effects.e2e.ts` (5) and `admin-suspension-storefront.e2e.ts` (7).

### 3.6 Home and results with OFE-027 and OFE-028 merged (2026-11-10)

Measured with the script (§3.1: `node ota/frontend/scripts/lighthouse.mjs --runs 3`, Lighthouse 13.5.0, headless Chromium 153.0.8010.12) by wave 46's integrator on the branch with both tasks merged (d084f1b), against the e2e harness's stack under its lock (the demo OTA's test storefront, EUR; a scratch spec, not committed, held the stack while the script ran); the agents' Linux machine, 4 CPUs, load average 0.75 at the start.

| Page | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |
|---|---|---|---|---|---|---|---|
| Home | 1 | 0.99 | 1.58 s | 1.75 s | 0.040 | 6 ms | 28 ms |
| Home | 2 | 0.99 | 1.56 s | 1.58 s | 0.040 | 0 ms | 24 ms |
| Home | 3 | 0.99 | 1.66 s | 1.66 s | 0.040 | 0 ms | 30 ms |
| **Home, median** | | 0.99 | 1.58 s | **1.66 s** | **0.040** | 0 ms | **28 ms** |
| Results | 1 | 0.98 | 1.72 s | 1.95 s | 0.027 | 10 ms | 52 ms |
| Results | 2 | 0.99 | 1.72 s | 1.92 s | 0.027 | 0 ms | 57 ms |
| Results | 3 | 0.98 | 1.77 s | 2.03 s | 0.027 | 17 ms | 48 ms |
| **Results, median** | | 0.98 | 1.72 s | **1.95 s** | **0.027** | 10 ms | **52 ms** |

Bytes transferred: home 122.1 KB, results 159.8 to 165.5 KB; fonts 48.7 KB on both. The one shift left on each page: home 0.040 (`main > p.mt-8`, the text under the search form, §3.5), results 0.027 (`main > div.mt-6`, the heading's third line, §3.4). The 0.127 of the header and the banner is gone from both pages, as §3.4's trace predicted for the header in its final shape (OFE-028's two rows on a phone) with the banner at the bottom: **every target is met on both pages in each of three runs.** OFE-027's acceptance is met. OFE-029's acceptance figures are met too, by OFE-028's header change; whether that closes OFE-029 (its step 1 also asks for room for the currency selector and the account menu) is the lead's decision. The lead closed it on 2026-11-10 (decision 13a) and planned what is left, the currency selector among it, as OFE-030 (§3.3).

### 3.7 Phones at 360 and 412 px (OFE-030, 2026-11-11)

**What moved, and what changed.** The four shifts §3.5 left, each now given its final size from the first paint (`task/OFE-030-phone-layout-shifts-axe` on ad5e666):

| Shift (before) | Cause | Change | After |
|---|---|---|---|
| The text under the search form, on home and results (0.040 at 412 px; 0.124 at 360 px with storefront.get held) | The page mounts `components/search-form.js` once storefront.get has answered, after the first paint; mounting it folds the passenger fieldset into its "Passengers" button and shows "Multi-city", and at 360 px the trip types then wrapped onto a second row | `main.css`: in a browser with JavaScript on (`@media (scripting: enabled)`), until the module marks the form `data-enhanced`, the form shows its enhanced shape from the first paint (the toggle and "Multi-city", still disabled, shown; the fieldset folded); `"failed"` (enhancing threw) gives the plain form back, and without JavaScript the plain form shows as before. The results page enhances its form when its "Change search" panel opens, and at once when the traveller opened the panel before the page's module ran (`pages/search.js`), so the form never stays in that shape with a passenger toggle that does nothing. The trip types' gap is 16 px instead of 24, so the three fit one row at 360 px | gone |
| The footer of a page shorter than the window, growing as it fills (0.016 at 412 px; 0.010 to 0.020 for an OTA with legal links and support contacts) | The footer sat at the bottom of the window and grew upwards when storefront.get's legal links, content pages and support contacts arrived | `main.css`: every page's `main` is at least one window high (`min-height: 100svh`, as the results page since OFE-027), so the footer starts below the window | gone |
| The header of an OTA with a long name, at 640 px and wider (0.32 to 0.43 at 640 and 768 px for a 57-character name; on a phone 0.23 to 0.37, the name on two lines) | The name pushed the navigation onto a second row, or wrapped itself | `partials/header.html`: a grid, the name on one line cut with an ellipsis (`truncate`; the link's text and its `title`, set by `components/header.js`, keep the whole name); on a phone the name and the currency selector's place on the first row, the navigation on the second; from `sm` one row, where the name's column (at least 8 rem) gives way to the selector and the navigation; a logo is as high as the name's line | gone |
| The currency selector of an OTA with two or more currencies | A control taller than the navigation's links, added to the navigation's row when storefront.get answered | Its own place in the header (`[data-header-currency]`, beside the name, filled by `components/header.js`), 28 px high, the name's line height, and still a 24 px target (2.5.8); the card page still takes it away | gone |

The skip link, the landmarks, every label and keyboard path, the test banner of OFE-028 and the results page of OFE-027 are unchanged. The currency selector, a form control rather than a link, is now in the banner beside the name instead of an item of the "Main" navigation's list, so the keyboard reaches it right after the name, in the order it is shown (it came after "My bookings" before); `boot.test.js` still proves the header's name, logo, currency selector and account menu (`[OFE-030 AC3]` adds the one-line name with its title, the logo and selector no higher than the name's line, and the selector's place).

**With storefront.get held** (the method of §3.5: Playwright 1.64.1 with headless Chromium 153.0.8010.12, `vite preview`-like static serving of each build, storefront.get answered in the browser 800 ms after the request, the layout shifts of a `PerformanceObserver` summed until a second after the header shows the OTA's name; phones as Lighthouse's, device pixel ratio 1.75; the build of ad5e666 before, this task's after):

| Storefront | Window | Home | Results (searching) | Short pages (find a booking, 404, sign-in) |
|---|---|---|---|---|
| Demo OTA (EUR) | 360 × 800 | 0.124 → 0 | 0 → 0 | 0 → 0 |
| Demo OTA | 412 × 823 | 0.040 → 0 | 0 → 0 | 0 → 0 |
| Demo OTA | 640, 768 and 1280 px | 0.026 to 0.043 → 0 | 0 → 0 | 0 → 0 |
| Legal links and support contacts | 360 and 412 px | 0.124 and 0.040 → 0 | 0 → 0 | 0.010 to 0.020 → 0 |
| A 57-character name and two currencies | 360 × 800 | 0.372 → 0 | 0.264 → 0 | 0.239 → 0 |
| A 57-character name and two currencies | 412 × 823 | 0.286 → 0 | 0.256 → 0 | 0.233 → 0 |
| A 57-character name and two currencies | 640 and 768 px | 0.392 and 0.427 → 0 | 0.352 and 0.430 → 0 | 0.324 and 0.400 → 0 |
| A 57-character name and two currencies | 1280 × 720 | 0.038 → 0 | 0.001 → 0 | 0.001 → 0 |

**Lighthouse mobile figures** (the method of §3.1 with the script: `node ota/frontend/scripts/lighthouse.mjs --width 412 --width 360 --runs 3`, Lighthouse 13.5.0, headless Chromium 153.0.8010.12; this task's build in the e2e harness's preview on 4173, whose stack a scratch spec, not committed, held under the machine's e2e lock while the script ran: first the demo OTA's test storefront as it is (EUR), then the same OTA with a 57-character name ("Mediterranean Sunshine Holidays and Flights International") and two currencies (EUR and USD) in its storefront settings, restored afterwards; the agents' Linux machine, 4 CPUs, load average 1.94 at the start of the first set and 1.70 at the start of the second):

| Page | Storefront | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |
|---|---|---|---|---|---|---|---|---|
| Home, 412 px | Demo OTA | 1 | 0.99 | 1.57 s | 1.57 s | 0 | 2 ms | 25 ms |
| Home, 412 px | Demo OTA | 2 | 0.99 | 1.58 s | 1.81 s | 0 | 0 ms | 19 ms |
| Home, 412 px | Demo OTA | 3 | 0.99 | 1.56 s | 1.77 s | 0 | 15 ms | 22 ms |
| Home, 360 px | Demo OTA | 1 | 0.99 | 1.56 s | 1.78 s | 0 | 13 ms | 28 ms |
| Home, 360 px | Demo OTA | 2 | 0.99 | 1.57 s | 1.57 s | 0 | 5 ms | 25 ms |
| Home, 360 px | Demo OTA | 3 | 0.99 | 1.66 s | 1.66 s | 0 | 5 ms | 23 ms |
| Results, 412 px | Demo OTA | 1 | 0.98 | 1.72 s | 1.94 s | 0.027 | 0 ms | 55 ms |
| Results, 412 px | Demo OTA | 2 | 0.98 | 1.71 s | 1.95 s | 0.027 | 9 ms | 50 ms |
| Results, 412 px | Demo OTA | 3 | 0.98 | 1.81 s | 2.04 s | 0.027 | 7 ms | 46 ms |
| Results, 360 px | Demo OTA | 1 | 0.98 | 1.73 s | 1.97 s | 0.048 | 24 ms | 61 ms |
| Results, 360 px | Demo OTA | 2 | 0.98 | 1.72 s | 1.93 s | 0.048 | 0 ms | 61 ms |
| Results, 360 px | Demo OTA | 3 | 0.98 | 1.72 s | 1.92 s | 0.048 | 0 ms | 51 ms |
| Home, 412 px | Long name, two currencies | 1 | 0.99 | 1.56 s | 1.78 s | 0 | 14 ms | 27 ms |
| Home, 412 px | Long name, two currencies | 2 | 0.99 | 1.57 s | 1.57 s | 0 | 21 ms | 25 ms |
| Home, 412 px | Long name, two currencies | 3 | 0.99 | 1.56 s | 1.77 s | 0 | 1 ms | 22 ms |
| Home, 360 px | Long name, two currencies | 1 | 0.99 | 1.57 s | 1.57 s | 0 | 15 ms | 23 ms |
| Home, 360 px | Long name, two currencies | 2 | 0.99 | 1.56 s | 1.56 s | 0 | 0 ms | 24 ms |
| Home, 360 px | Long name, two currencies | 3 | 0.99 | 1.66 s | 1.88 s | 0 | 7 ms | 20 ms |
| Results, 412 px | Long name, two currencies | 1 | 0.99 | 1.71 s | 1.91 s | 0.027 | 0 ms | 48 ms |
| Results, 412 px | Long name, two currencies | 2 | 0.99 | 1.72 s | 1.93 s | 0.027 | 0 ms | 47 ms |
| Results, 412 px | Long name, two currencies | 3 | 0.98 | 1.74 s | 1.99 s | 0.027 | 20 ms | 48 ms |
| Results, 360 px | Long name, two currencies | 1 | 0.98 | 1.73 s | 1.96 s | 0.048 | 7 ms | 60 ms |
| Results, 360 px | Long name, two currencies | 2 | 0.98 | 1.73 s | 1.94 s | 0.048 | 4 ms | 61 ms |
| Results, 360 px | Long name, two currencies | 3 | 0.98 | 1.72 s | 1.93 s | 0.048 | 2 ms | 51 ms |

Medians: home 1.57 to 1.77 s LCP, CLS 0, INP 22 to 25 ms; results 1.93 to 1.95 s LCP, CLS 0.027 at 412 px and 0.048 at 360 px, INP 48 to 61 ms. Bytes transferred: home 116.8 to 122.9 KB, results 160.1 to 166.2 KB; fonts 48.7 KB on both.

- **Every target is met on both pages at both widths, for both storefronts, in each of three runs** (OFE-030's acceptance): CLS at most 0.048, LCP at most 2.04 s, INP at most 61 ms. The home page has no layout shift left (0.040 at 412 px before, §3.6, the search form's).
- **The one shift Lighthouse still sees** is the results page's own (§3.4): `main > div.mt-6`, the results moving down when the heading and the summary change from the airport codes to their names, three lines on a phone instead of the two kept from the first paint; 0.027 at 412 px as before, 0.048 at 360 px, where the longer lines wrap sooner. It is within the target and in the results page of OFE-027, which this task keeps.
- A Lighthouse run does not show whether storefront.get answered before or after the first paint (on this machine the local API often answers first, §3.5), so these figures alone do not prove a configuration that arrives late; the table with storefront.get held does.

The journeys pass with these changes (2026-11-11, the same build and machine, under the e2e lock with a Redis of their own): every spec of the `storefront` project, 135 tests (`a11y-phone.e2e.ts` 44, `a11y-pages.e2e.ts` 36, `search.e2e.ts` 9 and `keyboard-checkout.e2e.ts` 9 among them), and the two other journeys that look at the storefront, `ota-admin/settings-effects.e2e.ts` (5) and `admin-suspension-storefront.e2e.ts` (7): 147 tests passed in 6.0 minutes with two workers.

**Shifts left.**

- **A signed-in customer's account menu on a phone** (§2 finding 5): at 360 and 412 px "Hi, ‹name›", "My account" and "Sign out" do not fit on the navigation's row beside "Find a booking" and "My bookings"; when `auth.getSession` answers, after the first paint of every page (the configuration may come from `sessionStorage`, the session never does), the navigation wraps and the page moves down by 28 px: 0.252 to 0.259 with storefront.get held, on every page but sign-in, for the demo OTA as for a long name (0.234 to 0.294 before this task; the short pages' figure grew from 0.234 to 0.259 because `main` is now a window high). With a long name and two currencies the same happens from 640 to 767 px (0.341; 0.32 to 0.39 before); at 768 px and wider the menu only moves the navigation sideways (at most 0.003). Lighthouse measures a visitor, so its figures do not show it. Each way out changes the header for everyone (a third row on every phone, for visitors too and for an OTA without customer accounts, or a compact account menu, a disclosure, in `lib/session.js`, outside this task's files): a decision for the lead (OFE-030's questions). **Decided on 2026-11-11 (lead decision (17l), approved by the owner):** the compact account menu, task OFE-031 (§3.3), which also makes the search form fall back to its plain form when its module has not mounted a few seconds after load (until then the enhanced shape of the table above, with a passenger toggle that does nothing, would stay) and shows the OTA's full name in the footer, because a phone's header cuts a long name with an ellipsis. **Done by OFE-031 (2026-11-12, §3.8):** nothing in the header moves when the session answers, at 360 and 412 px and, with the compact menu below `md`, from 640 to 767 px too; since OFE-032 (2026-11-13) the compact menu applies up to 1023 px.
- **The airline-card page** fills only the name of its static header (it does not use `boot()`), so its name has no `title`; the link's text is the whole name, as everywhere. Since OFE-031 it also fills the footer's line with the whole name.

### 3.8 A signed-in customer on a phone (OFE-031, 2026-11-12)

**What moved, and what changed** (`task/OFE-031-phone-account-menu-search-fallback-footer` on 08836fd):

| What | Before | Change | After |
|---|---|---|---|
| A signed-in customer's account menu below `md` (§2 finding 5, §3.7) | "Hi, ‹name›", "My account" and "Sign out" in the navigation's row, which wrapped when `auth.getSession` answered after the first paint: the page moved down by 28 px (0.252 to 0.259 with storefront.get held at 360 and 412 px; 0.341 from 640 to 767 px with a long name and two currencies) | `lib/session.js`: below `md` (768 px) one "Account" button with a chevron in the "Sign in" link's place, a disclosure (`aria-expanded`, `aria-controls`), 24 px high with negative margins that keep the row's 20 px line; the greeting, "My account" and "Sign out" in its panel, which CSS shows when the button is expanded (`peer-aria-expanded`), floating under the navigation (`nav` is its containing block, `relative`) at its right edge and never wider than it, the greeting wrapping and never cut; Escape closes it with the focus back on the button, as does a press outside unless it was on another control (the focus goes to that control), and the focus moving on past the menu closes it (2.4.11). `partials/header.html`: the slot is as wide as the button below `md` from the first paint (`max-md:min-w-20`), so the 640 to 767 px row, whose navigation column is as wide as its content, does not move sideways either. From `md` the signed-in links stand in the row as before | 0 in the header at 360 and 412 px, every page (below); 0 from 640 to 767 px, for the demo OTA and for a long name with two currencies (the scratch probe below: 0.0005 to 0.0007 sideways before the slot kept the button's width) |
| The search form of a page whose module never mounts (its script failed to load or threw before mounting) | kept the enhanced shape of OFE-030 for good: a passenger toggle that does nothing and "Multi-city" disabled | `main.css`: the form's own animation (`vx-search-form-plain`, 0 s after a 5 s delay, `forwards`), which no script has to start, sets three custom properties that the shape's rules read with `var()` (an animation cannot override their `!important`), so the plain form shows 5 s after the first paint; a form its module marks `data-enhanced` no longer matches, so its plain form never shows; the timer pauses while the results page's "Change search" panel is closed (its module enhances the form when it opens) | the plain form within 5 s of the first paint, or of the panel opening (`a11y-phone.e2e.ts`, `search-form.test.js`) |
| A long OTA name on a phone | cut with an ellipsis by the header's line (OFE-030); the whole name only in the link's text and `title` | `partials/footer.html`, `components/footer.js`: the footer's last line is the OTA's whole name (`config.name`, wrapping, never cut); the airline-card page fills it too. The footer starts below the window (OFE-030), and the line is its last, so filling it moves nothing | the whole name on every page |

**With storefront.get and `auth.getSession` held** (`a11y-phone.e2e.ts`, §1.1: the build of this task in the e2e harness's preview, the demo OTA (EUR, test environment), a customer signed up through the OTA API; storefront.get held until the static page had painted, then `auth.getSession` held until the configuration had been applied; a `PerformanceObserver` with `buffered` from the first paint on):

| Pages | Window | First paint, storefront.get held | Configuration applied, `auth.getSession` held | Session answered (before: §3.7) |
|---|---|---|---|---|
| The 17 pages that show the menu: home, results, offer, price, checkout, complete, card payment, confirmation, my bookings, booking, find a booking, the account, verify, forgot and reset password pages, a content page, not found | 360 × 800 | 0 | 0 | 0 (0.252 to 0.259) |
| The same | 412 × 823 | 0 | 0 | 0 (0.252 to 0.259) |

On every page and at both widths no shift moved an element of the header, the header kept its height and `main` its start when the session answered, and the home page moved by nothing from the first paint to the signed-in menu (the spec's assertions); every figure of the run was 0, the page's own content after the session included. The check does catch the old menu: run against a scratch build whose signed-in links stood in the row on a phone again (the panel's classes changed, not committed), it failed at 360 px with shifts in the header. The run (2026-11-12, this task's build, under the e2e lock with a Redis of its own; 4 CPUs, load average up to 6.5 from other agents' runs): `a11y-phone.e2e.ts` 66 tests, `a11y-pages.e2e.ts` 36 and `account-bookings.e2e.ts` 12, 114 passed in 5.5 minutes.

**Lighthouse mobile figures** (the method of §3.1 with the script: `node ota/frontend/scripts/lighthouse.mjs --width 412 --width 360 --runs 3`, once as a visitor and once with `--signed-in`; Lighthouse 13.5.0, headless Chromium 153.0.8010.12; this task's build in the e2e harness's preview on 4173, whose stack a scratch spec, not committed, held under the machine's e2e lock while the script ran; the demo OTA's test storefront, EUR; the agents' Linux machine, 4 CPUs, load average 3.41 at the start and 1.83 at the end). Signed in, each run's new browser signed the customer in through the storefront's own pages before the measured navigation (signed up through the sign-up page in the first run, which opens the session on the demo OTA, then through the sign-in page: the API allows 5 sign-ups per hour per address), and its `sessionStorage` was emptied, so storefront.get was asked again as in a visitor's run; every signed-in navigation's `auth.getSession` answered `200` and every visitor's `401` (the script now reports it and stops a signed-in run whose navigation was not signed in).

| Page | Visitor or customer | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |
|---|---|---|---|---|---|---|---|---|
| Home, 412 px | Visitor | 1 | 1.00 | 1.52 s | 1.52 s | 0 | 42 ms | 24 ms |
| Home, 412 px | Visitor | 2 | 0.99 | 1.60 s | 1.60 s | 0 | 3 ms | 32 ms |
| Home, 412 px | Visitor | 3 | 0.99 | 1.62 s | 1.62 s | 0 | 0 ms | 22 ms |
| Home, 360 px | Visitor | 1 | 0.99 | 1.56 s | 1.57 s | 0 | 0 ms | 24 ms |
| Home, 360 px | Visitor | 2 | 0.99 | 1.56 s | 1.56 s | 0 | 27 ms | 23 ms |
| Home, 360 px | Visitor | 3 | 0.99 | 1.66 s | 1.88 s | 0 | 10 ms | 23 ms |
| Results, 412 px | Visitor | 1 | 0.98 | 1.72 s | 2.06 s | 0.027 | 0 ms | 46 ms |
| Results, 412 px | Visitor | 2 | 0.99 | 1.67 s | 2.02 s | 0.027 | 0 ms | 40 ms |
| Results, 412 px | Visitor | 3 | 0.98 | 1.72 s | 1.95 s | 0.027 | 9 ms | 41 ms |
| Results, 360 px | Visitor | 1 | 0.98 | 1.73 s | 2.08 s | 0.048 | 0 ms | 45 ms |
| Results, 360 px | Visitor | 2 | 0.98 | 1.81 s | 2.04 s | 0.048 | 1 ms | 38 ms |
| Results, 360 px | Visitor | 3 | 0.98 | 1.71 s | 1.94 s | 0.048 | 3 ms | 44 ms |
| Home, 412 px | Signed in | 1 | 0.99 | 1.66 s | 1.66 s | 0 | 0 ms | 21 ms |
| Home, 412 px | Signed in | 2 | 0.99 | 1.66 s | 1.66 s | 0 | 0 ms | 24 ms |
| Home, 412 px | Signed in | 3 | 0.99 | 1.66 s | 1.66 s | 0 | 0 ms | 27 ms |
| Home, 360 px | Signed in | 1 | 0.99 | 1.67 s | 1.90 s | 0 | 12 ms | 25 ms |
| Home, 360 px | Signed in | 2 | 0.99 | 1.56 s | 1.77 s | 0 | 0 ms | 29 ms |
| Home, 360 px | Signed in | 3 | 0.99 | 1.53 s | 1.71 s | 0 | 0 ms | 26 ms |
| Results, 412 px | Signed in | 1 | 0.98 | 1.81 s | 2.03 s | 0.027 | 0 ms | 51 ms |
| Results, 412 px | Signed in | 2 | 0.99 | 1.66 s | 2.02 s | 0.027 | 0 ms | 38 ms |
| Results, 412 px | Signed in | 3 | 0.98 | 1.71 s | 1.94 s | 0.027 | 0 ms | 42 ms |
| Results, 360 px | Signed in | 1 | 0.98 | 1.81 s | 2.01 s | 0.048 | 0 ms | 41 ms |
| Results, 360 px | Signed in | 2 | 0.98 | 1.69 s | 2.04 s | 0.048 | 0 ms | 62 ms |
| Results, 360 px | Signed in | 3 | 0.98 | 1.81 s | 2.02 s | 0.048 | 0 ms | 46 ms |

Medians: home LCP 1.57 to 1.77 s, CLS 0, INP 23 to 26 ms; results LCP 2.02 to 2.04 s, CLS 0.027 at 412 px and 0.048 at 360 px, INP 41 to 46 ms, for the visitor and the customer alike. Bytes transferred: home 118.5 to 125.7 KB (the signed-in session's answer adds 0.6 KB), results 161.8 to 169.0 KB; fonts 48.7 KB on both.

- **Every target is met on both pages at both widths, signed in and as a visitor, in each of three runs** (OFE-031's acceptance): CLS at most 0.048, LCP at most 2.08 s, INP at most 62 ms. The home page has no layout shift for a signed-in customer either (Lighthouse and `a11y-phone.e2e.ts`).
- The one shift Lighthouse sees is still the results page's own (§3.4, §3.7): `main > div.mt-6`, the results moving down when the heading and the summary change from the airport codes to their names; 0.027 at 412 px and 0.048 at 360 px, the customer's as the visitor's.
- A Lighthouse run does not show when `auth.getSession` answered (on this machine before or right after the first paint), so these figures alone do not prove a session that answers late; the held answers of `a11y-phone.e2e.ts` above do.

**Left.**

- **From `md` (768 px) the signed-in links stay in the navigation's row, as before** (step 1 keeps the menu as it is from `sm` but where the 640 to 767 px case moved, which the compact menu now covers). A first name long enough still wraps that row when the session answers: a scratch probe (this build served as files, the API answered in the browser, storefront.get and `auth.getSession` held) measured 0.63 (the demo OTA) and 0.53 (a long OTA name and two currencies) at 768 px for a 23-character first name, and no wrap at 900 px and wider (0.005 to 0.007 sideways); a common first name only moves the navigation sideways there (0.002 to 0.004, as §3.7 measured before this task). Whether the compact menu should apply up to `lg`, or the inline greeting be cut at a width, is a question for the lead (OFE-031's questions). **Closed on 2026-11-13 by OFE-032** (lead decision (20h) of 2026-11-13, approved by the owner): the compact menu applies below `lg` (1024 px), and with a 23-character first name the home page moves by nothing when the session answers from 768 to 1023 px; from 1024 px the header is as before (below).
- **A page whose module never mounts** shows its plain form 5 s after the first paint by design; that change of shape is itself a layout shift (0.017 on the home page at 360 px in a scratch probe), only when the script failed. On a connection so slow that the module mounts after the 5 s, the form shows its plain shape first and then the module's, two shifts that a form mounted in time never has.

**Up to the large breakpoint (OFE-032, 2026-11-13).** `lib/session.js` gives the compact menu's classes the `lg` breakpoint instead of `md` (`max-lg:` and `lg:`: the "Account" button shown and the panel floating below 1024 px, the inline group from 1024 px), and `partials/header.html` keeps the slot as wide as the button below `lg` from the first paint (`max-lg:min-w-20`); the menu's keyboard, focus, Escape and outside-press behaviour are OFE-031's, unchanged. From 640 to 1023 px the header is one row whose navigation column is as wide as its content, so the button in the "Sign in" link's 80 px slot moves nothing; from `lg` the classes are those `md` had before. `auth-pages.test.js` compiles `main.css` with Tailwind (as the build does) and checks that every responsive class of the menu switches at `(width < 64rem)` or `(width >= 64rem)`, 1024 px, and nowhere else.

*Method.* A scratch probe, not committed (a Playwright spec under the e2e harness's stack and the machine's e2e lock, with a Redis of its own): one customer per first name, signed up through the OTA API, opened home in a window 900 px high (device pixel ratio 1, no touch) at each width, with storefront.get held until the static page had painted and `auth.getSession` held until the configuration had been applied, then let through; a `PerformanceObserver` (`buffered`) summed the layout shifts of each phase, as `a11y-phone.e2e.ts` does (§1.1). "Before" is the build of the base commit (facaf119), served to the same stack by routing the page's own requests (not `/api/*`) to a copy of its `dist/`, with the preview's headers; "after" is this task's build in the preview. The long OTA name (57 characters) and the second currency (USD) were routed into storefront.get's own answer, as `withFullestHeader` does. Headless Chromium 153.0.8010.12, Playwright 1.65.0, the agents' Linux machine (4 CPUs, load average 0.2 at the start).

The layout shift when the session answered (before → after; the first paint and the configuration's phases were 0 in every case, before and after):

| Storefront | First name | 768 px | 800 px | 850 px | 900 px | 1023 px | 1024 px | 1280 px |
|---|---|---|---|---|---|---|---|---|
| Demo OTA (EUR) | 23 characters | **0.579** → 0 | 0.005 → 0 | 0.005 → 0 | 0.005 → 0 | 0.004 → 0 | 0.004 → 0.004 | 0.002 → 0.002 |
| Demo OTA | "Alba" | 0.003 → 0 | 0.002 → 0 | 0.002 → 0 | 0.002 → 0 | 0.002 → 0 | 0.002 → 0.002 | 0.001 → 0.001 |
| 57-character name, two currencies | 23 characters | **0.481** → 0 | **0.516** → 0 | **0.571** → 0 | 0.006 → 0 | 0.005 → 0 | 0.005 → 0.005 | 0.003 → 0.003 |
| 57-character name, two currencies | "Alba" | 0.003 → 0 | 0.003 → 0 | 0.003 → 0 | 0.003 → 0 | 0.002 → 0 | 0.002 → 0.002 | 0.001 → 0.001 |

- **Before**, the figures in bold are the row wrapping: the header grew from 52 to 72 px and the navigation from one line (20 px) to two (48 px), moving the page down; OFE-031's probe had 0.63 and 0.53 at 768 px with its own window. Every other figure is the wider navigation moving sideways in its row (its left edge from 732 to 429 px at 1024 px with the 23-character name), which no visitor sees as a jump.
- **After**, from 768 to 1023 px nothing moves at all, for both storefronts and both names: the "Account" button takes the "Sign in" link's place in a slot of the same width, and the header, the navigation and `main` stay where they were.
- **From 1024 px nothing changed**: the same figures before and after, to the fourth decimal, the inline greeting, "My account" and "Sign out" in the row, which these names do not wrap there (the header stays 52 px high, the navigation one line).
- **Left (found by the review, 2026-11-13).** From `lg` the signed-in links stay in the row, as the acceptance asks, so a first name much longer than 23 characters still wraps it when the session answers, as before this task. The review's scratch probe (this task's build, the method above, first names of 30, 40, 50 and 60 characters; the contract allows 60) measured 0 at 1023 px for every name (the compact menu) and, from 1024 px, only the sideways movement (0.003 to 0.009) but in three cases where the row wrapped (the header from 52 to 72 px): 60 characters on the demo OTA at 1024 px (0.756), and with the 57-character OTA name and two currencies 50 and 60 characters at 1024 px (0.669) and 60 characters at 1100 px (0.691); at 1152 and 1280 px nothing wrapped. Whether the inline greeting should be cut from `lg` (the whole name kept in its `title`, or the compact menu kept up to `xl`) is a question for the lead (OFE-032's review).

`a11y-phone.e2e.ts` part 6 (§1.1) keeps this: home at 768, 800, 850, 900 and 1023 px with no layout shift from the first paint to the signed-in menu, and at 1024 and 1280 px the links in the row, which does not wrap; axe at 800 and 1023 px with the menu closed and open. Below `md` nothing changed, so the Lighthouse figures above (360 and 412 px) stand.

*The bundled font's swap (wave 51's integrator, 2026-11-13).* The "0 in every case" of the first paint above holds on the agents' machine only, where `system-ui` is Inter itself. On CI's runner, whose `system-ui` is DejaVu Sans, the bundled Inter face (`font-display: swap`, `styles/fonts.css`) replaces the fallback after the first paint on every load, even from the memory cache, and from `md` that moves the navigation sideways (it is right-aligned there) and the search form's labels, button and text: 0.0007 at 768 to 850 px, 0.0006 at 900 px, 0.0005 at 1023 and 1024 px and 0.0003 at 1280 px, the same for both storefronts, in the static paint's phase (E2E run 43371391946 failed on it; the same figures with a fontconfig without Inter on the agents' machine). Every element such a shift names changes its own size, so part 6 leaves those shifts out of its checks of the first paint and the configuration (`withoutFontSwaps`) and reports them in its annotation; the session's answer is still checked with every shift. Below `md` the swap moves nothing (part 5's home page is 0 on CI too). A visitor without Inter installed sees this shift on every page from `md`; whether `fonts.css` should use `font-display: optional` or `fallback`, or `/fonts/*` a cache lifetime (Caddy sends `no-cache` for everything outside `/assets/`), is a question for the lead.

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
