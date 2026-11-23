---
id: usage
title: Storefront — usage guide
summary: How to open an OTA's hosted storefront locally and walk every page (search, results, offer, price, checkout, card and airline-card payment, confirmation, my bookings, booking detail, guest lookup, account, content pages), what each should do, which tables, Redis keys and e-mails change, and what to test when hunting bugs.
---

## What it is

The [[storefront]] (`repo:ota/frontend`, package `@velexis/ota-frontend`) is the public website of **every OTA** at
`<key>.ota.example.com` and on each verified [[custom-domain]] (locally `http://localhost:5173`). Travellers search
Amadeus flights, price them, pay by card through Stripe or with the [[airline-card]], and come back to their bookings as
a guest or as a signed-in customer.

It is **static**: plain HTML pages, Tailwind CSS 4 and one vanilla ES module per page, built once by Vite for all OTAs.
There is no server of its own and no per-OTA build. The **host name picks the OTA**: Caddy (or locally the
[[dev-proxy]]) forwards `/api/*` of the page's own host to the OTA API with the edge headers, and the API resolves the
host to the tenant and its [[storefront-environment]]. Every booking function is a call of `@velexis/ota-sdk` in
[[cookie-mode]], so no key or token ever reaches JavaScript.

```diagram
neighbours
```

Five rules shape every page:

| Rule | What you see | Where it comes from |
|---|---|---|
| [[runtime-configuration]] | Name, logo, colours, currencies, features, legal links, payment methods | `storefront.get` once per page, kept 5 minutes in `sessionStorage` (`vx.storefront.config`); `repo:ota/frontend/src/lib/config.js` |
| [[test-mode-banner]] | "Test mode: no real bookings or payments" fixed at the bottom, `noindex` | Shown unless `environment = live`; `repo:ota/frontend/src/boot.js` (`applyEnvironment`) |
| [[page-state]] | Full-page "temporarily unavailable" / "does not exist", inline Retry states | `pageStateFor(error)` of `repo:ota/frontend/src/lib/errors.js`, texts in `repo:ota/frontend/src/lib/i18n.js` |
| [[host-cookie]]s only | `document.cookie` shows `__Host-vx_csrf` and nothing else | Sessions and guest tokens are httpOnly cookies the API sets (`repo:ota/backend/src/common/http/cookie-writer.ts`) |
| Money from the API | Every total is the API's; the page never adds or multiplies | `formatMoney` of `repo:ota/frontend/src/lib/format.js` (exact decimal strings) |

Every page and its module, at a glance:

```diagram
page-map
```

## Before you start

You need PostgreSQL 16, Redis 7, Mailpit, the [[amadeus-stub]], the OTA API and worker, and this app. The platform
apps are only needed to seed. The storefront dev server serves the [[demo-ota]] ("Demo Travel", `tenant_demo`, EUR)
without any key.

```diagram
flow-local-setup
```

```try
command: pnpm stub:amadeus &
command: pnpm --filter @velexis/platform-backend dev:seed
command: pnpm --filter @velexis/ota-backend dev:seed
command: mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 &
command: pnpm --filter @velexis/ota-backend dev
command: pnpm --filter @velexis/ota-frontend dev
url: http://localhost:5173/
expect: "Search flights" with Demo Travel in the header and the Test mode banner; DevTools shows only the __Host-vx_csrf cookie
```

| What | Where | Notes (development only) |
|---|---|---|
| Storefront (dev, HMR, no CSP) | `http://localhost:5173` | `pnpm --filter @velexis/ota-frontend dev`; the proxy sends `X-Velexis-Host: demo.ota.example.com` |
| Storefront (production build) | `http://localhost:4173` | `pnpm --filter @velexis/ota-frontend build` then `… preview`; same proxy, the Caddyfile's headers and CSP |
| Customer accounts | Create them on `/account/sign-up.html` | No customer is seeded; e-mails land in Mailpit `http://localhost:8025` |
| Test cards (airline card, stub) | `4111 1111 1111 1111` accepted, `4000 0000 0000 0002` declined | Any future expiry up to 2099, security code `123`, holder name of 2 to 64 Latin letters A to Z, spaces, `.`, `'`, `-` (accents are removed before the check and the send: "José Müller" goes as "Jose Muller") |
| Test cards (Stripe) | `4000 0027 6000 3184` (3-D Secure always) | Stripe test mode keys in `ota/backend/.env.local`, `bash tools/dev/stripe-listen.sh` |
| Stub scenarios | Header `X-Stub-Scenario: sold-out` / `price-changed` / `server-error` / `timeout` / `ticketing-failed` | The OTA API forwards it to the stub outside production; set it with a header-editing browser extension on `/api/*` |
| No offers | Destination `ZZZ` | The stub answers an empty search |
| Database | `psql postgres://velexis_ota_app:dev_ota@127.0.0.1:5432/velexis` | Demo tables are in schema `tenant_demo` |
| Redis | `redis-cli -a dev_redis` | `t:<tenantId>:test:sf:*`, `rl:ota_*`, `t:<tenantId>:test:ac:*`, BullMQ `vx:ota-*` |

```warning
Use **Chromium or Firefox** on `http://localhost:5173`. Safari refuses `__Host-` cookies on plain-HTTP localhost, so
every write fails there with `403 CSRF_TOKEN_INVALID`. Do not open the dev server by `127.0.0.1` and by `localhost` in
the same session: cookies are per host.
```

```note
The demo OTA has **no owner**, so its OTA admin cannot be opened. Two switches are off for a new OTA: the airline card
for test (`storefront_settings.airline_card_enabled_test`) and self-service cancellation
(`features.selfServiceCancellation`). The local setup flow above turns both on with one `UPDATE` (development only).
To test an OTA you own, create it in the portal and set `STOREFRONT_DEV_HOST=<key>.ota.example.com` in
`ota/frontend/.env.local`.
```

## Tour

Every page in the order a traveller meets it. All pages share the header (OTA name and logo, currency selector when the
OTA has two or more currencies, **Find a booking**, **My bookings**, the [[account-menu]]), the footer (legal links,
content pages, support contacts) and the [[page-state]]s of a failed `storefront.get`.

### Shared states (every page)

| Try | What should happen | Code |
|---|---|---|
| Load any page normally | Static content first, then theme, header and footer; the [[live-region]] says "Loading" only when the configuration is slow | `repo:ota/frontend/src/boot.js` |
| Suspend the OTA (platform admin) and reload | Full page "This travel site is temporarily unavailable", no Retry, `noindex`; an open tab shows it on its next page (cache dropped on any `403 TENANT_SUSPENDED`) | `repo:ota/frontend/src/lib/client.js` |
| Set `STOREFRONT_DEV_HOST=nope.ota.example.com`, restart Vite, reload (the proxy names this host to the API whatever the browser used) | "This storefront does not exist" (`403 HOST_NOT_ALLOWED`) | `repo:ota/backend/src/tenancy/tenant-resolver.ts` |
| Stop the OTA API, reload | "The service is not available right now. Nothing is lost…" with Retry; the dev proxy answers `503 SERVICE_UNAVAILABLE` with `Retry-After: 30` | `repo:ota/frontend/scripts/vite-plugins.js` |
| Pick another [[display-currency]] in the header | Nothing reloads (WCAG 3.2.2); the screen-reader live region says "Prices will be shown in {currency} from your next search" once, and the same text shows as a small note below the header's end, in a place of no height so nothing moves, until the results page runs its next search or the page is left; the choice is stored in `localStorage` `vx.currency` and sent as `X-Currency` on later calls; prices change only with a new search (only `POST /v1/flight-searches` reads `X-Currency`) | `repo:ota/frontend/src/components/header.js`, `repo:ota/frontend/src/boot.js` |
| Resize to 360 px | No sideways scroll; filters behind "Filters (n)"; below 1024 px the signed-in menu is one "Account" button | `repo:ota/frontend/src/lib/session.js` |

### Home `/`

The search form: trip type (one way, return, multi-city with 2 to 6 legs), From and To comboboxes, dates, passengers
(adults, children, infants), cabin. It is a real `GET` form to `/search.html`, so it works without JavaScript too.

| Try | What should happen |
|---|---|
| Type `Mad` in From | Suggestions from 2 characters (250 ms debounce), Arrow keys move, Enter picks, Escape closes and keeps the text |
| Leave a field empty, pick the same city twice, a past date, a return before departure, 2 infants with 1 adult, 10 seats | Focused error summary with links to the fields; no navigation |
| Open `/?from=LHR&to=PAR&depart=<date>` | Fields pre-filled: "London Heathrow Airport (LHR)", "Paris (PAR)" |
| Disable JavaScript | Plain form: 3-letter code inputs, number fields, no multi-city; after 5 s without the module the plain form appears by CSS |
| Look at the cabin | "No preference" is preselected and sends no `cabin`: a one-way or return search gets the OTA's default cabin (`storefront_settings.search_defaults.cabin`), and a multi-city search goes with no cabin restriction (the API applies no default cabin to ADVANCED searches); a chosen cabin is sent, and a cabin in the address (a deep link, Back, "Change search") preselects it |

Code: `repo:ota/frontend/src/pages/index.js`, `repo:ota/frontend/src/components/search-form.js`,
`repo:ota/frontend/src/components/location-combobox.js`, `repo:ota/frontend/partials/search-form.html`.

### Results `/search.html`

Runs [[flight-search]] once (`flights.search`, 60 s), puts `search=srch_…` into the address, then lists offers 20 at a
time with `flights.listResults`. Filters (stops, airlines, times, price, duration, cabin, bags, refundable,
changeable, branded fares) and sort (Best, Cheapest first, Shortest first, Earliest departure, Earliest arrival) live in
the query string.

| Try | What should happen |
|---|---|
| Search MAD → PAR | Skeletons + "Searching airlines…", then "5 flights" (stub) |
| Reload, Back, Forward | No new `POST /v1/flight-searches`; same results |
| Tick Direct, change sort | "4 flights", `stops=0`, `sort=price` in the address, focus stays on the control |
| Show more flights | Next 20 appended, focus on the first new card |
| Destination `ZZZ` | "No flights found" with one-day-earlier/later and whole-city suggestions |
| Open a bookmarked `search=` after `offer_ttl_minutes` | "Prices have expired" with **Refresh results** |
| Edit the address to a filter the API refuses | The filter is dropped once and the page loads without it |

Code: `repo:ota/frontend/src/pages/search.js`, `repo:ota/frontend/src/components/filters.js`,
`repo:ota/frontend/src/components/offer-card.js`. Tables: `flight_searches`, `flight_offers`, `supplier_requests`.

### Offer `/offer.html?offer=off_…`

One [[flight-offer]] in full: bounds and flights, baggage per traveller type, the search total, seats left, and
"Choose your fare" with the [[fare-family]] cards of the [[branded-fare-upsell]] (`flights.upsell`, only with `features.brandedFareUpsell`).
**Continue with this fare** prices the chosen `off_…` and opens the price page.

| Try | What should happen |
|---|---|
| Pick another fare family, reload | The choice stays (`fare=off_…` in the address) |
| Upsell fails or is off | Only the original fare, no error banner |
| `offer=off_doesnotexist0000000` or an expired offer | "This fare is no longer available" (or "We could not find this flight" for an invalid id, without a call) |
| Stub `sold-out` on pricing | "This flight just sold out", back to results |

Code: `repo:ota/frontend/src/pages/offer.js`, `repo:ota/frontend/src/components/fare-families.js`. Tables:
`flight_offers`, `offer_upsells`, `priced_offers`.

### Price `/price.html?priced=prc_…`

The confirmed [[priced-offer]]: price per traveller type, "What the total includes" (fares, taxes, every fee line with
its label, extras), the API's total, "What you need to book" ([[booking-requirements]]), extras "Available in
checkout", fare rules under **Changes and refunds**, and the [[price-hold]] countdown.

| Try | What should happen |
|---|---|
| Compare the breakdown total with the total box | Identical text; fee lines named by the OTA's fee rule or "Ticketing fee", "Payment fee", … |
| Stub `price-changed` | "Expected price" vs "Confirmed price", "The airline changed the price", button "Continue at the new price, €…" |
| Wait for the countdown (or set `priced_offers.expires_at` in the past) | Live region announces 5 minutes left once; at zero "Price expired", Continue disabled, **Re-price** to the offer page |
| Continue with guest checkout off and no session | Sign-in first (`next` back to this page) |
| Continue when the OTA requires verification and the customer is unverified | "Verify your e-mail address to book" with "Send the link again" |

Code: `repo:ota/frontend/src/pages/price.js`, `repo:ota/frontend/src/components/price-breakdown.js`.

### Checkout `/checkout.html?id=chk_…&step=…`

The [[checkout]] in four [[checkout-step]]s on one page, each a history entry: **Travellers**, **Contact details**,
**Extras** (only with `features.ancillaries`) and **Payment**. Every save sends [[if-match]] with the version on the
screen.

```diagram
checkout-steps
```

| Try | What should happen |
|---|---|
| Press **Continue** with a required field empty | The browser's own "Please fill out this field" bubble on the first empty field; nothing is sent (the step forms have no `novalidate`) |
| The same with the browser checks off (remove `required` in DevTools) | Saved, but stays: "Travellers saved. Some details are still missing", fields marked |
| Open the same checkout in two tabs, save in both | Second tab: reload and re-apply once ("updated in another tab"); a second `412` offers Reload |
| Add a bag | The airline's new total is shown; **Confirm the new total** sends it (`409 PRICE_CHANGED` is the normal path) |
| Address `step=payment` before travellers are complete | The first incomplete step instead |
| Payment step without ticking the terms | Nothing sent |
| Wait past `checkout_ttl_minutes` (default 30) | "Your session expired", back to the price page |

Code: `repo:ota/frontend/src/pages/checkout.js`, `repo:ota/frontend/src/components/traveller-form.js`,
`repo:ota/frontend/src/components/contact-form.js`, `repo:ota/frontend/src/components/ancillary-picker.js`. Tables:
`checkouts`, `checkout_travelers` (documents in `documents_ciphertext`), `checkout_contacts`, `checkout_ancillaries`,
`checkout_remarks`, `payments`.

### Pay by card `/checkout/pay-card.html?id=chk_…&payment=pay_…`

The only page with Stripe.js. It mounts the [[payment-element]] with the payment's publishable key and client secret
(and the OTA's Stripe account in Connect mode), quotes the [[card-fee]] on **Review total**, then **Pay** confirms with
`redirect: "if_required"` and [[3-d-secure]] when the bank asks.

```diagram
pay-card-states
```

| Try | What should happen |
|---|---|
| Inspect the page | No `<input>`, `<select>` or `<form>` of the page's own; the header has no currency selector here |
| Change the card after reviewing | The review is dropped; Pay needs a new review |
| A brand the OTA does not accept | "We cannot take this card", accepted brands listed, no fee quoted |
| No Stripe keys / Stripe.js blocked | "Card payment is unavailable. Nothing was charged." with Retry and "Pay with the airline card instead" when offered |
| Reload after paying | Goes to the complete page (payment `processing`/`authorized`/`captured`), never pays twice |

Code: `repo:ota/frontend/src/pages/checkout-pay-card.js`, `repo:ota/frontend/checkout/pay-card.html`.

### Pay with your card (airline card) `/checkout/pay-airline.html?id=chk_…&payment=pay_…`

The [[isolated-payment-page]] for the [[airline-card]]: the page's own card form, no third-party script, no `boot()`,
its own bundle and stricter headers. The airline charges the card through Amadeus at the airline's price
([[pricing-mode]] `net`).

```diagram
airline-card-states
```

| Try | What should happen |
|---|---|
| Type six digits | Brand shown ("Visa card"), "Checking the airline's card fee…" (`PATCH /v1/payments/{id}` with brand + BIN only), then the review "Your final total" (brand, card fee, total); the button changes from **Review the total** to **Pay €…** |
| `4111 1111 1111 1112` (bad check digit), past expiry, 2-digit code, a holder name in another script (Мария) or with ß, Ø or Ł, then **Pay €…** | Focused summary "Check the card details" with links such as "Check the card number", "This card has expired", "Enter the security code: 3 digits, or 4 on an American Express card", "Type the name in Latin letters without accents (A to Z), as it is written on the card"; no completion request (only the earlier fee quote left the page), values kept |
| Year `2100` (or any year above 2099) with an otherwise valid card | Refused at the expiry field before anything is sent ("Enter the expiry month (MM) and year (YYYY) of the card"; the contract's last year is 2099); the values stay in the inputs |
| `4000 0000 0000 0002` three times | "The airline declined the card" twice (inputs emptied), then "Too many attempts" |
| Leave the page with a card typed, press Back | Inputs empty |
| Stub `server-error` on the completion | Confirmation in pending mode; the card is never sent again |
| Open it with the airline card switched off | "Paying with the airline card is not available" and "Choose another way to pay. Nothing was charged.", link **Choose another payment method** |

Code: `repo:ota/frontend/src/pages/checkout-pay-airline.js`, `repo:ota/frontend/src/lib/card-brand.js`. Tables:
`payments` (`card_brand`, `card_bin`, `card_last4` only), `payment_events`, `bookings`, `supplier_requests`
(redacted). Redis: `t:<tenantId>:test:ac:chk:<checkoutId>`, `t:<tenantId>:test:ac:declines`, `…:ac:suspended`.

### Completing your booking `/checkout/complete.html`

Stripe's return URL. It removes `payment_intent`, `payment_intent_client_secret` and `redirect_status` from the address
before anything else, reads the payment every 2 s while the bank confirms (60 s at most), then calls
`checkout.complete` with the [[idempotency-key]] `complete-<checkoutId>-<paymentId>`.

```diagram
complete-states
```

| Try | What should happen |
|---|---|
| Reload while it completes | Same key → the first request's outcome; one booking only |
| A payment that failed | "Payment did not go through" with a link back (never an automatic redirect) |
| Stub `timeout` on Flight Create Orders | Confirmation with `pending=1` ([[supplier-timeout]]) |

Code: `repo:ota/frontend/src/pages/checkout-complete.js`.

### Confirmation `/confirmation.html?booking=bkg_…`

Reads the booking (customer session or guest cookie) and polls the [[ticketing-status]] after each
`pollAfterSeconds`. Guests get "Save your reference" with the lookup link and "Create an account".

```diagram
confirmation-states
```

| Try | What should happen |
|---|---|
| A normal booking | "Your tickets are issued" with ticket numbers `000-…` and links to the booking page and documents |
| Stub `ticketing-failed` | "Booking confirmed" and "Your tickets are being issued. We will e-mail you when they are ready." (polled 10 minutes) |
| `pending=1` | "We are confirming your booking with the airline", polled every 10 s up to 30 minutes, then "Check again"; `pending=1` leaves the address once decided |
| Open the link in another browser | "Find your booking" link to `/lookup.html` (`401`) |

Code: `repo:ota/frontend/src/pages/confirmation.js`.

### My bookings `/bookings.html?tab=upcoming|past|cancelled`

Signed-in customers only (a visitor goes to sign-in with `next`, or to the lookup without customer accounts). Three
tab links with `aria-current`, 20 cards per page, **Load more**. Upcoming is sorted by departure, past and cancelled
newest first.

| Try | What should happen |
|---|---|
| New customer | "No upcoming trips" with the search and "Booked as a guest? Find your booking" |
| `?tab=nonsense` | Upcoming |
| A cancellation waiting for staff | Card shows the booking's status; the booking page says "Cancellation requested" |

Code: `repo:ota/frontend/src/pages/bookings.js`, `repo:ota/frontend/partials/templates/booking-row.html`. Index:
`bookings_customer_upcoming_idx` / `bookings_customer_past_idx`.

### Booking detail `/booking.html?id=bkg_…`

Trip with each flight's status, travellers and tickets, contact, payment, the cancellation block, documents, history
and fare rules. Buttons follow [[allowed-actions]] exactly: **Change contact details** (`canModifyContacts`),
**Cancel booking** (`canCancel`), **Refresh from airline** (`canRefresh`), **Download** per ready document
(`canDownloadDocuments`).

```diagram
cancel-dialog-states
```

| Try | What should happen |
|---|---|
| Change the e-mail and mobile | Dialog closes, says where the confirmation went; e-mails to the new and the old address |
| Change contacts while staff edit the booking | `409 VERSION_CONFLICT` reloads with `refresh: true`, typed values kept |
| Cancel | Refund preview by [[cancellation-mode]], reason required, then "This booking is cancelled" (or "Request sent" for `request_only`) |
| Double-click Confirm, reload, Retry | Same key `cancel-<bookingId>-<version>-<hash>` → one cancellation |
| Type `4111 1111 1111 1111` into **Message to us (optional)** and confirm | "Remove the card number: card details never go in this field" at that field; nothing is cancelled (`400 card_data`). A special request at checkout ("Request 1 (optional)") that holds one gets the same field error and is not saved |
| Download a document twice | A new signed URL each click (5-minute [[signed-url]]); "being prepared" for a pending document |
| Open **Changes and refunds** on a booking made < 60 s ago | "The fare rules will be available in about a minute" (`429`), Retry enabled after `Retry-After` |
| Refresh from airline twice in a minute | Second one keeps the saved booking (throttled) |

Code: `repo:ota/frontend/src/pages/booking.js`, `repo:ota/frontend/src/components/cancel-dialog.js`,
`repo:ota/frontend/src/components/booking-timeline.js`.

### Find your booking `/lookup.html`

The [[guest-lookup]]: [[booking-reference]] (or the airline's [[record-locator]]) and the last name of any traveller.
Success sets the [[guest-token]] cookie and opens the booking page.

```diagram
lookup-states
```

| Try | What should happen |
|---|---|
| Reference in lower case with spaces | Accepted (spaces removed, upper-cased) |
| Wrong name / wrong reference / both | The same "We could not find a booking with these details", no field marked |
| `ABC` or a 61-character name | Field error before any request |
| Five failed lookups from one IP (or for one reference) within 15 minutes, then a sixth | The sixth answers `429`: "Too many attempts, try again in N minutes" (in seconds under a minute; "try again later" without `Retry-After`), button disabled until the wait ends, then "You can try again now" |

Code: `repo:ota/frontend/src/pages/lookup.js`. Tables: `booking_access_tokens` (`issued_via = 'lookup'`),
`booking_events`. Redis: `rl:ota_lookup_ip:*`, `rl:ota_lookup_reference:*`.

### Account pages `/account/…`

| Page | Try | What should happen |
|---|---|---|
| Sign in `/account/sign-in.html?next=…` | Wrong password; 5 failures; `next=https://evil.example` | One generic message (attempts left when ≤ 3, reset link); `423 ACCOUNT_LOCKED` with the time in the OTA's zone; [[safe-next-path]] sends to `/` |
| Create an account `/account/sign-up.html` | Short password; common password (`qwertyuiop`); existing e-mail; OTA with `require_email_verification` | Rules shown up front ("Use at least 10 characters."); under 10 characters the browser stops the submit (`minlength`, no request); a common one → `422 PASSWORD_TOO_WEAK` "This password is too common or has appeared in a data breach. Choose another one."; `409 EMAIL_ALREADY_REGISTERED` with sign-in and reset links; with verification required the customer is still signed in at once (never "Check your e-mail") and checkout later answers `403 EMAIL_NOT_VERIFIED` |
| Confirm your e-mail `/account/verify.html?token=vt_…` | Open the Mailpit link; open it twice | Token removed from the address at once; second time "expired or used" with a resend form |
| Reset your password `/account/forgot-password.html` | Known and unknown address | The same "If an account exists, we sent a link" for both |
| Choose a new password `/account/reset-password.html?token=pr_…` | Weak password, then a good one | Token kept for another try; then signed in (or a sign-in link) |
| My account `/account/` | Change name/phone; change e-mail; change password; sign out everywhere; delete | Only changed fields sent; new e-mail is pending until its link is opened; delete asks the password, then the menu shows "Sign in" and the page goes to `/` |

On the OTA's sub-domain, sign-in and sign-up go to the same page on the [[primary-host]] when a verified custom domain
is primary, before any session is created. Code: `repo:ota/frontend/src/pages/account-sign-in.js`,
`repo:ota/frontend/src/pages/account-sign-up.js`, `repo:ota/frontend/src/pages/account-index.js`,
`repo:ota/frontend/src/lib/primary-host.js`.

### Content pages `/p/<slug>` and Not found `/404.html`

[[content-page]]s are the OTA's published `storefront_pages` (terms, privacy, FAQ…), built from blocks with
`createElement` only. The footer lists those with `show_in_footer`.

| Try | What should happen |
|---|---|
| `/p/terms`, `/p/Terms/` | The page; title as `h1` and document title, `lang` from its locale |
| An unpublished slug, `/p/a/b`, `/p/` | The 404 content in place with `noindex` (status 200: the HTML is static) |
| A block link `javascript:…` or `http:…` | Rendered as plain text; `https:` links get `rel="noopener noreferrer"` |
| `/nope.html` | `/404.html` with status 404, branded header and footer |

Code: `repo:ota/frontend/src/pages/p.js`, `repo:ota/frontend/src/lib/blocks.js`,
`repo:ota/frontend/src/components/footer.js`.

## How to …

### Search and price a flight

```diagram
flow-search-and-price
```

### Book as a guest with the airline card

The quickest full booking locally: no Stripe needed.

```diagram
flow-checkout-airline-card
```

### Book with Stripe

```diagram
flow-checkout-stripe
```

### Create an account and see My bookings

```diagram
flow-account
```

### Change contacts, cancel or download documents

```diagram
flow-manage-booking
```

### Find a guest booking

```diagram
flow-guest-lookup
```

### See a live OTA or a custom domain locally

1. Take an OTA live through the platform (see [[journey:custom-domain-and-go-live]]); `platform.tenants.storefront_environment` becomes `live`.
2. Point `STOREFRONT_DEV_HOST` at its sub-domain, restart Vite, reload.
3. Expected: no test banner, no `noindex`, searches on the live Amadeus connection; test bookings answer `404` there.
4. With a verified primary custom domain, `/account/sign-in.html` on the sub-domain must `location.replace` to the same path on the custom host (`tools/e2e/specs/storefront/live-and-domains.e2e.ts`).

## Roles and permissions

| Page | Visitor | Guest (`__Host-vx_bt`) | Customer (`__Host-vx_at` / `__Host-vx_rt`) |
|---|---|---|---|
| Shopping and checkout | ✓ (checkout only with `guest_checkout_enabled`) | ✓ | ✓ |
| `/bookings.html` | → sign-in with `next` (→ lookup without accounts) | → sign-in | ✓ own bookings |
| `/booking.html?id=…` | "Find your booking" | ✓ bookings in the cookie | ✓ own bookings |
| `/lookup.html` | ✓ | ✓ | ✓ (link to My bookings) |
| `/account/` | → sign-in with `next=/account/` | → sign-in | ✓ |
| Sign-in, sign-up | ✓ | ✓ | → `next` or `/account/` |

What a refusal should look like:

- A booking of another customer, another OTA or another environment answers `404`: "Booking not found" / "We could not
  find this booking", never "forbidden", so nothing leaks.
- A missing or stale CSRF header is `403 CSRF_TOKEN_INVALID`; the SDK reloads `storefront.get` once and retries.
- An action the booking does not allow has no button at all; a forced call answers `409 BOOKING_NOT_MODIFIABLE` or
  `403 FEATURE_DISABLED` and the dialog says "This booking can no longer be cancelled online" with the support address.
- OTA staff do not use the storefront to act; they change it from the [[app:ota-admin]].

## Bug-hunting checklist

```bug-hunt
**Tenancy and host.** Open the dev server with `STOREFRONT_DEV_HOST` set to two different OTAs in two browser
profiles: names, colours, currencies, content pages and bookings must never mix. `sessionStorage` is per origin, so a
cached configuration can leak only if two OTAs share a host. A booking id of OTA A opened on OTA B must answer `404`.
A test booking must be `404` on a live storefront (`bookings.environment`).
```

```bug-hunt
**Search and money.** Totals on the card, the offer page, the price page, the checkout and the confirmation must be
the API's strings. Check them against the database:
`SELECT selling_total, net_total, markup_amount FROM tenant_demo.flight_offers WHERE search_id = 'srch_…';` and
`SELECT selling_total, fee_amount, price_changed, expires_at FROM tenant_demo.priced_offers ORDER BY created_at DESC LIMIT 1;`.
No `net*` field may appear in any storefront answer (DevTools → Network). With the airline card the totals must drop
to the Amadeus price (`checkouts.pricing_mode = 'net'`, `bookings.markup_amount = 0`).
```

```bug-hunt
**Checkout versions and expiry.** `SELECT status, version, expires_at, pricing_mode FROM tenant_demo.checkouts ORDER BY created_at DESC LIMIT 3;`
Every step must raise `version` by one; a stale tab must get `412` and re-apply, never overwrite silently. An expired
checkout must show "Your session expired" and its Stripe authorisation must be voided by the `checkouts.expire` job
(`payments.status = 'canceled'`, provider spelling; the API says `cancelled`).
```

```bug-hunt
**Payments.** After a Stripe booking: `SELECT provider, method, status, amount, amount_authorized, amount_captured, card_fee_amount, card_fee_lines FROM tenant_demo.payments ORDER BY created_at DESC LIMIT 2;`
Capture must equal the booking total; a sold-out at completion must void (Stripe PaymentIntent `canceled`) and say
nothing was charged. Reloading `/checkout/complete.html` must never create a second booking
(`SELECT count(*) FROM tenant_demo.bookings WHERE checkout_id = 'chk_…';` is 1).
```

```bug-hunt
**Airline card (PCI).** After any airline-card path, search for the card: DevTools → Application (cookies, local and
session storage, IndexedDB) and the address bar must not hold the number, the last 12 digits, the CVC or the holder.
`payments` keeps only `card_brand`, `card_bin`, `card_last4`; `supplier_requests` holds the brand and last 4 only.
Attempts: `redis-cli -a dev_redis --scan --pattern 't:*:test:ac:*'`. The page must load only its own bundle
(`checkout-pay-airline-<hash>.js`) and, in preview, send `Cross-Origin-Opener-Policy: same-origin` and `Cache-Control: no-store`.
```

```bug-hunt
**Bookings, tickets and e-mails (Mailpit `http://localhost:8025`).** One booking should produce "Your booking <ref>
with <OTA> is confirmed" (with the itinerary PDF) and, once issued, the ticketed e-mail. A contact change sends
"… has been updated" to the new address and "The contact details of booking <ref> … were changed" to the old one; a
cancellation sends "Your booking <ref> is cancelled". Check the outbox:
`SELECT template_key, recipient, status, attempts, last_error FROM tenant_demo.notifications ORDER BY created_at DESC LIMIT 10;`
Stuck `pending` rows point at the `ota-notifications` queue or SMTP; check `redis-cli -a dev_redis keys 'vx:ota-notifications:*'`.
```

```bug-hunt
**Sessions, cookies and CSRF.** `document.cookie` must only ever show `__Host-vx_csrf` (plus Stripe's `__stripe_mid`
/ `__stripe_sid` on the card page). The CSRF value must change at sign-in, sign-out and password change. Delete
`__Host-vx_at` in DevTools and open My bookings: the SDK must refresh silently (`POST /v1/auth/refresh`), not sign you
out. `SELECT family_id, remember_me, family_expires_at, revoked_at, revoke_reason FROM tenant_demo.customer_sessions ORDER BY created_at DESC LIMIT 5;`
Sign out everywhere must revoke every family of the customer.

**Two tabs, one customer.** The SDK de-duplicates refreshes inside one page. Across the tabs of one origin it runs
every refresh under the Web Lock `velexis-sdk:cookie-refresh`. Sign in, open the same customer in two tabs, delete
`__Host-vx_at` in DevTools and reload both tabs at the same moment. Exactly one `POST /api/v1/auth/refresh` must go
out, the other tab sends its calls again with the new access cookie, and both tabs stay signed in (`revoke_reason`
stays empty). Two refreshes with the same `__Host-vx_rt` (possible only without Web Locks: an insecure context or an
old browser) would be a reuse that revokes the family.
```

```bug-hunt
**Guest access and lookup.** `SELECT issued_via, expires_at, use_count, revoked_at FROM tenant_demo.booking_access_tokens WHERE booking_id = 'bkg_…';`
A sixth guest booking in one browser must drop the oldest from `__Host-vx_bt` (at most 5). A wrong name and a wrong
reference must give byte-identical `404` bodies apart from `requestId`. After the fifth failure the lookup is refused
for the window (`rl:ota_lookup_ip:*`).
```

```bug-hunt
**Accounts.** Sign-up with an address that has guest bookings, then verify: those bookings must appear in My bookings
(`bookings.customer_id` set). Deleting an account must sign out, keep the bookings reachable by lookup and refuse while
a booking waits for payment, tickets or a refund (`409 ACCOUNT_DELETION_BLOCKED` with the booking links). Lockout:
5 wrong passwords → `423` for 15 minutes (`t:<tenantId>:test:authfail:*`).
```

```bug-hunt
**Dates, time zones and formats.** Flight times are airport-local wall-clock strings and must never shift with your
browser's time zone (change the OS zone and reload). "+1 day" must appear for overnight arrivals. Booking timestamps
(cancelled at, lockout until, history) use `storefront_settings.time_zone`. Durations `PT7H35M` → "7 h 35 min".
```

```bug-hunt
**Settings effects.** Change in `storefront_settings` (or the OTA admin): `brand_name`, colours (try a low-contrast
pair: the whole palette must fall back to neutral), `supported_currencies` (selector appears with two or more),
`guest_checkout_enabled = false` (price page sends to sign-in), `customer_accounts_enabled = false` (no Sign in, My
bookings → lookup), `features` `ancillaries` / `brandedFareUpsell` false (no extras step, no fare cards). Each must
show within about 5 minutes, or at once after dropping `t:<tenantId>:test:sf:*` and the tab's sessionStorage.
```

```bug-hunt
**Accessibility and layout.** Keyboard only from home to confirmation; focus visible and never under the sticky header
or the test banner; error summaries receive focus; dialogs trap focus and return it. At 360 px no sideways scroll; a
60-character first name must not wrap the header row from 1024 px. Colour is never the only status signal.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Vite exits at start: missing `OTA_API_URL` / `VELEXIS_EDGE_SECRET` / host | No root `.env.local` or `ota/frontend/.env.local` | `cp .env.example .env.local` (root); values in `repo:ota/frontend/.env.example` |
| Every write answers `403 CSRF_TOKEN_INVALID` | Safari, mixed `localhost`/`127.0.0.1`, or `VELEXIS_EDGE_SECRET` differs between proxy and API | Chromium/Firefox on `http://localhost:5173`; same secret in both `.env.local` files |
| "This storefront does not exist" | `STOREFRONT_DEV_HOST` names no tenant, or the OTA dev seed did not run | `pnpm --filter @velexis/ota-backend dev:seed`; check `platform.tenant_domains.hostname` |
| "This travel site is temporarily unavailable" | Tenant not `active` (provisioning or suspended) | Platform admin → resume; or wait for provisioning |
| "Flight search is not available yet" | `424 SUPPLIER_NOT_CONFIGURED`: no active Amadeus connection | Run the platform `dev:seed` (test offices) before the OTA one; start `pnpm stub:amadeus` |
| "Airlines are not answering right now" | Stub not running, or scenario `timeout`/`server-error` left on | Start the stub; clear the `X-Stub-Scenario` header |
| No airline-card option | `AIRLINE_CARD_ENABLED` false, `airline_card_enabled_test` off, or suspended after 20 declines | Turn the setting on, drop `t:*:test:sf:*`; wait an hour or delete `t:<tenantId>:test:ac:suspended` (development only) |
| "Card payment is unavailable" | No Stripe test keys, or Stripe.js blocked | Keys in `ota/backend/.env.local`, `tools/dev/stripe-listen.sh` |
| Settings change not visible | 5-minute caches (Redis and sessionStorage) | Drop `t:<tenantId>:<env>:sf:*`; clear the tab's sessionStorage |
| No e-mails | Mailpit or the OTA worker not running | `mailpit …`; the worker starts with `pnpm --filter @velexis/ota-backend dev` |
| Preview answers `403 Blocked request` | Host is neither loopback, `localhost` nor `<key>.ota.example.com` | Use `http://localhost:4173` |
