---
id: usage
title: OTA admin — usage guide
summary: How to open an OTA's back office from the portal, every screen and action (bookings, PNR import, queues, shopping, payments, customers, markups, storefront settings, pages, templates, supplier log), what each one should change in the tenant schema, Redis and Mailpit, and what to test when hunting bugs.
---

## What it is

The [[ota-admin]] (`repo:ota/admin`, package `@velexis/ota-admin`) is the back office of **one OTA** at
`admin.ota.example.com` (locally `http://localhost:3002`). The OTA's staff use it to work bookings (issue, cancel,
patch, notes), import PNRs from Amadeus, read office queues, quote fares for callers, capture and refund Stripe
payments, look up customers, and change markups, fees, storefront settings, images, content pages and e-mail
templates.

It has **no sign-in page**: staff arrive by [[sso]] from the portal ("Open console" on the OTA's page), which hands a
one-time [[portal-token]] to `POST /sso`. It is a [[bff]]: the browser only talks to the Next.js server on
`127.0.0.1:3002`, which calls the OTA API's [[console-namespace]] through the JS SDK with the first-party
[[service-key]] and the staff member's token, both kept server side ([[host-cookie]]s, never readable by browser
JavaScript). The admin stores nothing: every change is one OTA API call, which writes the tenant's rows (through
[[tenant-tx]]) and one [[staff-action]] row.

```diagram
neighbours
```

Four rules shape every screen:

| Rule | What you see | Where it comes from |
|---|---|---|
| [[staff-permission]] | Navigation entries and buttons hidden or disabled ("Needs the permission settings:write") | `can()` of `repo:ota/admin/src/lib/permissions.ts` (role matrix **and** the API's `permissions`); the API decides again (`403 FORBIDDEN`) |
| [[storefront-environment]] | A TEST / LIVE switch (or a badge); in LIVE the shell turns amber and dialogs say "… in LIVE" | `__Host-vx_env` cookie, sent as `X-Velexis-Environment` on every call ([[environment-switch]]) |
| [[confirm-dialog]] | Destructive actions ask for a reason (3-500 characters) and show what will happen | `repo:ota/admin/src/components/confirm-dialog.tsx` |
| [[action-key]] + [[if-match]] | A double click replays the same action; "This record changed; reload to see the latest version" on a stale page | hidden `actionKey` (an [[idempotency-key]]) and `version` in each dialog |

## Before you start

You need the whole OTA stack: PostgreSQL 16, Redis 7, Mailpit, the [[amadeus-stub]], the platform API + worker, the
portal, the OTA API + OTA worker, and this app. The demo OTA that `dev:seed` creates has **no owner**, so nobody can
open its console: sign up in the portal and create an OTA of your own.

```diagram
flow-local-setup
```

```try
command: pnpm stub:amadeus
command: pnpm --filter @velexis/platform-backend dev:seed
command: pnpm --filter @velexis/ota-backend dev:seed
command: pnpm dev
url: http://localhost:3000/sign-up
expect: Sign up, verify the e-mail in Mailpit, create an OTA at /otas/new, wait until it is Active, then "Open console" lands on http://localhost:3002/bookings with your OTA's name in the shell and a TEST badge
```

| What | Where | Notes (development only) |
|---|---|---|
| Your portal account | `http://localhost:3000/sign-up`, then Mailpit `http://localhost:8025` | You become the OTA's `owner` staff member |
| More staff (agent, finance, viewer, admin) | Portal → OTA → **Team** (`/otas/<tenantId>/team`), accept the invitation from Mailpit in another browser profile | Each opens the console from the portal; the role decides what the admin shows |
| Bookings to work on | Book on the storefront of **your** OTA: set `STOREFRONT_DEV_HOST=<key>.ota.example.com` in `ota/frontend/.env.local`; or import a PNR | The storefront dev server serves the demo OTA unless told otherwise |
| Service key | `OTA_ADMIN_SERVICE_KEY` in the root `.env.example` | Must equal the OTA backend's; `sk_dev_…` locally |
| Database | `psql postgres://velexis_ota_app:dev_ota@127.0.0.1:5432/velexis` | Tables live in schema `tenant_<key>` (read only when you inspect) |
| Redis | `redis-cli -a dev_redis` | `staffsess:*`, `staffdeny:*`, `t:<tenantId>:*` caches |

```warning
Browse **http://localhost:3002** (the origin of `PUBLIC_OTA_ADMIN_URL`) and the portal on **http://localhost:3000**
(`PUBLIC_PORTAL_URL`). `POST /sso` refuses any other `Origin` with `403`, and **Sign out** refuses a request whose
`Origin` is not the admin's. `__Host-` cookies work on `http://localhost` in Chromium and Firefox.
```

```note
Every new console session starts in **TEST**. LIVE exists only for a live OTA (after go-live) and never for a
viewer. Most local testing happens in TEST against the Amadeus stub and Stripe test mode.
```

## Tour

Every route, in the order of the navigation (`repo:ota/admin/src/components/console-nav.tsx`). The navigation
labels, by group: **Operations** (Dashboard, Bookings, PNR lookup, Queues, Shopping), **Payments and customers**
(Payments, Customers), **Settings** (Markups, Fees, Storefront, Assets, Pages, E-mail templates), **Support** (Supplier
log, Portal links). An entry the role cannot read is left out, and so is a group left empty. List pages keep filters,
sort and the cursor in the URL, so every view is a shareable link; a link with a value the API would refuse is never
sent: the page says "Not valid: Status, Page size. Change them above, or clear the filters." with **Clear filters**.

### Sign-in, session and the shell

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `POST /sso` | No page: sets four cookies, `303` to `/bookings` | Post the same hand-off form twice (browser back + resubmit) | Second time: `401` page "This console link expired or was already used", no cookie set |
| Any page without a session | — | Delete the `__Host-vx_staff_*` cookies, open `/payments` | `303` to `PUBLIC_PORTAL_URL/console?tenant=<tenantId>` (the tenant cookie stays) |
| Shell (every page) | OTA name, navigation in four groups (Operations, Payments and customers, Settings, Support), TEST/LIVE switch or badge, your name and role, **Back to the portal**, **Sign out**, the [[billing-notice]] | A suspended OTA; an OTA in `past_due` | "This OTA is suspended" full page while the access token lives (the next refresh is refused with `TENANT_SUSPENDED` and sends you to the portal); billing alert "Payment problem: update billing in the portal" for every role, **Go to billing in the portal** for owner and finance only |
| `/auth/refresh?next=…` | No page: refreshes, `303` back to `next` | `?next=https://evil.example.com` | Goes to `/` instead ([[safe-next-path]]); a refresh that may pass (`429`, `503`) answers a "Your session could not be renewed" page with **Try again** |
| `POST /auth/sign-out` → `/signed-out` | "Signed out" with a link to the portal | Sign out; then post the same form from another origin | Access, refresh and env cookies cleared whatever the API answers; tenant cookie kept. Another `Origin`: `403` page "You are still signed in" |

```diagram
flow-open-console
```

### Dashboard `/`

Each tile renders only with its permission (`repo:ota/admin/src/app/(console)/dashboard-tiles.tsx`).

| Tile | Shows | Links to |
|---|---|---|
| Ticketing failed or in manual review | `totalCount` of `ticketingStatus=failed,manual_review` (amber when not 0; "10,000+" for a `null` count) | `/bookings?ticketingStatus=failed&ticketingStatus=manual_review` |
| Ticketing deadline within 24 h | `status=confirmed,partially_ticketed`, deadline before now + 24 h | `/bookings?…&deadlineWithin=24h` |
| Outcome unknown (reconciling) | `status=pending` | `/bookings?status=pending` |
| Authorised, not captured (`payments:read`) | Up to 5 `authorized` payments | `/payments?status=authorized` |
| Last queue read (`queues:read`) | Newest stored snapshot | `/queues/<n>?officeId=…&category=…` |
| Latest bookings | Newest 10 | `/bookings` |

A failed read shows its message and request id **in its own tile**; the other tiles stay. A finance user or viewer
sees no queue tile and the API gets no `listSnapshots` call.

### Bookings list `/bookings`

| Area | What to try | Should happen |
|---|---|---|
| Saved views: **Needs attention** (Ticketing problems, Reconciliation review, Deadline within 24 h, Cancellation requested, Schedule changed) and **Lists** (All bookings, To issue, Reconciling, Cancelled, Imported) | Click each; compare its count with the dashboard tile | Same number on the tile and the list (the tile uses the view's filters with `limit: 1`) |
| Filters: Search, Status, Ticketing, Payment, Channel, Sort, then "more" (record locator, reference, customer e-mail, last name, validating airline, tag, departure/created days, deadline window, reconciliation, cancellation requested, schedule changed) | Choose a status, then type a record locator | A choice applies at once; text and days on submit; the cursor resets, the page size stays |
| Chips for `customerId`, `createdByStaffId`, `ticketingDeadlineBefore` | Open `/bookings?customerId=cus_bad` | The chip shows the API's refusal; nothing else breaks |
| Paging | Next page of "Deadline within 24 h" | The link carries `asOf` (the window start); **First page** drops it |
| Columns | Reference ("Guest booking"), record locator ("None yet"), lead traveller (+N), route, departure (local), status, ticketing + deadline, payment, total with net and markup, channel, created (OTA time zone) | No customer e-mail in the HTML |

### Booking detail `/bookings/[bookingId]`

Tabs are links (`?tab=`): Overview, Travellers and contacts, Amadeus order, Tickets and documents, Payments, Timeline
and notes, Staff actions. Above the tabs: the alerts that need staff (most urgent first, e.g. "Reconciliation needs
staff review", "Ticketing needs staff review", "Cancellation requested, not completed", "Schedule changed by the
airline") and the **Booking actions** bar (Issue tickets, Cancel the booking, Resync from Amadeus, Close the review),
each shown only with the permission and when `consoleActions` allow it.

| Area | What to try | Should happen |
|---|---|---|
| Overview | Read pricing | Net base, taxes, supplier fees, net cost, markup with its rule, service and card fees, selling total, margin %, pricing mode; `cancellation` block; "What you can do now" with the API's reasons |
| **Sync from Amadeus** (`?refresh=1`, a GET link: a reload syncs again) | Click twice within 10 s | First: "Synchronised with Amadeus just now."; second: "Synchronised with Amadeus moments ago: this is the data of that sync." (the API's 10 s); a supplier error shows "The sync with Amadeus failed, so this is the stored booking." with the request id |
| Travellers and contacts | Edit a traveller's phone; add a remark; change the ticketing agreement | `console.bookings.patch` with `If-Match`; `version + 1`; `booking.patched` event; documents shown with last 4 only |
| Amadeus order | Open the tab | One audited `order.retrieve` (Flight Order Management GET); verbatim order open in a JSON view; **Read again** reads anew; no other tab calls it |
| Tickets and documents | — | Ticket numbers per traveller and segment |
| Payments | As finance, then as viewer | Each payment from `console.payments.get` (card brand + last 4 only, never holder or expiry); Capture/Refund buttons per permission |
| Timeline and notes | **Add a note** (1-2,000 characters): an internal one, then one with "Visible to the customer in their booking's timeline" ticked; press **Add note** | "Note added."; `staff.note` booking event (`visible_to_customer` false by default), `booking.note` staff action holding the note id, never its text. The text itself is stored in `booking_events.summary` and `data` |
| Staff actions | — | Last 20 `staff_actions` of this booking |
| `bkg_garbage`, a live booking while in TEST | Open by URL | "Booking not found" inside the shell, naming the environment; no API call for a malformed id |

Booking actions (`repo:ota/admin/src/app/(console)/bookings/[bookingId]/actions.ts`):

| Action | Rules | Effect to check |
|---|---|---|
| **Issue tickets** | `bookings:issue`; reason; "E-mail the e-ticket receipts to the traveller" (on); an authorised Stripe payment is captured first; unpaid only with **Issue although the payment is not captured** ([[allow-unpaid]], owner/admin); [[airline-card]] bookings only with **Settlement with the airline** `CASH` or `ACCOUNT` | "Tickets issued."; `bookings.ticketing_status = issued`, `status = ticketed`, `booking_tickets` rows, `payments.status = captured`, staff actions `payment.capture` + `booking.issue`, e-mail `booking.ticketed` |
| **Cancel the booking** | `bookings:cancel`; **Reason category** (The customer asked, Duplicate booking, Fraud, Schedule change, Not paid, Ticketing deadline passed, The airline asked, Other) + reason; the dialog names the Amadeus step ([[cancellation-mode]]: release, void, request to the airline) and the refund modes of the payment; "E-mail the cancellation to the traveller" (on) | "Booking cancelled."; `status = cancelled`, `cancelled_by = staff`, `cancel_reason = '<code>: <reason>'`, `refunds` row (`pending` → `succeeded` by webhook), e-mail `booking.cancelled`; in `request_only` the booking stays and `booking.cancellation_requested` is sent |
| **Resync from Amadeus** | `bookings:write`; no reason; the API allows one per 10 s per booking (`429 RATE_LIMITED` otherwise) | "Synchronised with Amadeus: N changes." with the `changes` listed (or "nothing changed"); `booking.synced`, `booking.resync` staff action |
| **Close the review** | `bookings:cancel`; only `pending` + [[reconciliation-review]]; Order found (record locator) or Not booked (note required) | See the how-to below |

### PNR lookup and import `/pnr`

| Step | What to try | Should happen |
|---|---|---|
| Lookup (`?recordLocator=`) | Type a locator in lower case with spaces | Sent as capitals; `^[A-Z0-9]{5,8}$` checked before any call; audited `pnr.lookup` |
| A match of your office | — | Locators, travellers `LAST/FIRST`, flights, tickets, last ticketing date, queuing office, net total; **Import as a booking** (`bookings:write`) |
| Already imported | Look it up again | "Already a booking of this OTA" with a link |
| Another OTA's office | The demo OTA's order | "This order belongs to an office outside this OTA" with your offices; nothing of the order; `denied` staff action ([[office-isolation]]) |
| No match | A made-up locator | "Amadeus has no order with this record locator" (`error.supplier`) or "No order with this record locator in your offices" |
| **Advanced** panel (`amadeus:read`) | **Read the orders of …**, **Read order …** | Raw `getFlightOrderByReference` / `getFlightOrder`, only on click; audited `amadeus.<operation>` |
| **Import as a booking** | Pricing (markup rules / net / override with a selling total), customer search or **No customer: a guest booking**, contact e-mail, "Send the booking confirmation to the contact" (off), tags, internal note, reason, **Import** | The new booking opens. Status from the order: `confirmed` + ticketing `manual_review` without tickets, `ticketed` / `partially_ticketed` + `issued` / `partially_issued` with tickets, `cancelled` when the airline cancelled every segment; channel `import`, payment `not_applicable` |

### Queues `/queues`, `/queues/[queueId]`

| Route | What it shows | Try | Should happen |
|---|---|---|---|
| `/queues` | Only the newest 100 [[queue-snapshot]]s, grouped by office, queue and category (columns Queue, Office, Category, Last read, Read by, PNRs, Monitored "Yes, by the scheduled poller") | **Open a queue** with queue 100 or category 255 | Refused at the field ("Enter a queue number from 0 to 99.", "Enter a category from 0 to 254."); no call |
| `/queues/[queueId]` | The last stored read with its PNRs (no Amadeus call); **Read now from Amadeus** (a GET form to `?read=1`) stores a new snapshot; **Next page** pages the snapshot; **Earlier reads** (the newest 10) | An orphan PNR (no booking); reload the `?read=1` URL | "No booking" + **Import** → `/pnr?recordLocator=…`. A reload of `?read=1` reads Amadeus and stores a snapshot again |

### Shopping on behalf `/shopping`

[[shopping-on-behalf]] for staff on the phone (page title "Shopping on behalf"): four read-only raw Amadeus calls,
**net** prices only, nothing stored or booked (booking on behalf comes later). Tabs: **Flight offers** (From, To,
Departure, Return, Adults, Children (2 to 11), Infants on a lap (at most one per adult), Cabin, Non-stop flights only,
Airlines, Currency, Reason (optional); **Search offers**) and **Seat availability** (**Search availability**). Each offer
has **Branded fares** and **Confirm price** (optionally "Confirm prices with the detailed fare rules"). The default
markup rule is named for orientation ("Default markup rule, for orientation"); no selling price is computed. Every call
is sent **once** (`maxRetries: 0`): a `504 SUPPLIER_TIMEOUT` says "Search again".

### Payments `/payments`, `/payments/[paymentId]`

| Route | What to try | Should happen |
|---|---|---|
| `/payments` | Filter by status `authorized`, provider, method, booking id, created days | Rows: payment, created (OTA zone), booking or "No booking yet", provider/method with brand + last 4, status, amount with captured and refunded |
| `/payments/[paymentId]` | **Refresh from Stripe** (`?refresh=1`) | Reads with `refresh: true`; a Stripe failure re-reads stored data and says so |
| Capture | An `authorized` Stripe payment, empty amount | "Captured €…"; the whole authorisation; a smaller amount releases the rest |
| Refund | More than "Still refundable"; then a valid amount with a **Reason category** (The customer asked, Booking cancelled, Schedule change, Duplicate payment, Fraud, Goodwill, Other) | "The amount is above what can still be refunded: at most €…" (the API's `details.refundable`) on the amount field; then "Refund of €… requested: Stripe completes it." |
| Typed amounts | `10.125`, `0`, `abc` | Refused at the field before any call ("Enter an amount like 120.50.", "Enter an amount above zero."): at most two decimals, so a 3-decimal currency cannot be refunded to the last unit here |
| Airline-card payment | — | "Refunded by the airline", no buttons |

### Customers `/customers`, `/customers/[customerId]`

Read-only. The list searches e-mail or name prefixes (2-100 characters), filters by status (deleted only when asked),
verified e-mail and has-bookings, never shows phone numbers, and is not audited. A customer's page is an audited
`customer.view` (the page says so): account, consents, saved travellers, active sessions, statistics of the current
environment and the customer's bookings with paging. A deleted account shows the `…@deleted.invalid` address and
"Deleted account", nothing more. Guests are not customers.

### Settings: markups and fees

`/settings/markups`, `/settings/fees` (+ `/new`, `/[id]`), 50 rules a page in evaluation order, filter All rules /
Active / Inactive. Owners and admins edit (**New markup rule** / **New fee rule**, **Create markup rule** /
**Create fee rule**, **Save changes**, **Delete rule**); the others read ("Read only: changing markup rules needs the
permission settings:write.", the New button disabled). **How rules apply** explains [[markup-rule]] first-match and
stacking and [[fee-rule]] per-type. The [[default-markup-rule]] (named "Default", priority 1000, seeded at 0 %) has no
scope, priority, active or window inputs and no **Delete rule**. A markup percentage is -100 to 999.9999, a fee
percentage 0 to 100; fixed amounts at most two decimals. Deletes ask no reason (the contract takes none). Rules are
shared by TEST and LIVE and apply from the next search (no cache to clear).

### Settings: storefront and images

`/settings/storefront` has eight tabs (`?tab=`): Brand and theme, Locales and markets, Features and search, Policies,
Payments, Legal and support, SEO and consent, Operations. Each section is its own form with its own button
(**Save branding and theme**, **Save search**, **Save policies** …) and its own `PATCH` with `If-Match`: "Saved. The
storefront shows the change within 5 minutes." Notable fields: the theme editor with live preview and WCAG contrast
check ([[theme-editor]]), [[offers-per-search]] (1-250, empty = API default 150, **Use the default**; saved with "Saved.
The storefront's next search asks Amadeus for this number of offers.", the same value again "Nothing to save: the
offers per search are as shown."), [[ticketing-policy]] (Manual review and the others), the airline card per
environment ("Offer the airline card in the test environment"; live only while the platform switch is on).
Agents, finance and viewers see every field disabled and no Save button.

`/settings/assets` (navigation **Assets**, page title "Storefront images") lists [[storefront-asset]]s (PNG, JPEG,
WebP; ICO for a favicon; at most 1 MB; logos at most 2000 × 2000 pixels; never SVG), with **Upload an image** and
**Delete** for owners and admins. Images open on the API host (**Open**); they are never shown inline (the admin's
CSP only allows its own images). Images are stored as uploaded: their metadata (camera, location, author) stays in the
file and is public.

### Settings: content pages and e-mail templates

`/settings/pages` (+ `/new`, `/[pageId]`): [[content-page]]s in a Markdown subset. The form: **Address** (the slug,
fixed after creation, served at `/p/<slug>`), **Language** (fixed too), Kind, Title, Body, "Published on the
storefront", "Listed in the storefront footer", Footer order; **Create page** / **Save**, **Delete page** (no reason).
**View on storefront** for published pages. A refused body is shown next to the line it names with **Go to line N**.
Without `settings:write` the **New page** button is disabled.

`/settings/templates` lists every [[notification-template]] key by audience (Customer accounts, Bookings (to the
traveller), Staff alerts (to the OTA)) with where it comes from (Customised, Default (own copy), Inherited from …,
Default) and whether it is sent. `/settings/templates/[key]/email/[locale]` edits Subject, HTML body, Text body and
"Send this template" (off: the language's template or the default is used), **Preview** (every role, in a sandboxed
iframe), **Save** and **Reset to default** (owner/admin).

### Supplier log `/supplier-log`

The [[supplier-log]] (`supplier_requests:read`; not viewers): every Amadeus call of the environment with API,
operation, method/path, office, outcome, HTTP status, Amadeus error codes, duration, booking link, Velexis
[[request-id]] and Amadeus `correlationId`. Filter by `requestId` to go from a failed console action to its Amadeus
call. **Show the redacted bodies** adds request and response bodies (20 calls a page then).

### Portal links `/portal`

Links to the portal's pages of this OTA: overview, API keys, domains, Amadeus, payments, team, billing, go-live,
settings. Staff management, API keys and connections live in the portal, not here. No API call besides
`console.auth.me`.

### Route handlers and probes (no UI)

| Route | Answers |
|---|---|
| `GET /health/live` | `200 {status:"ok"}` |
| `GET /health/ready` | `200` when `OTA_API_URL/health/live` answers within 2 s, else `503` with `checks.otaApi` = `timeout` or `down`; `500` on a bad configuration |

### Not here (by design)

No sign-in page, no staff/team management (portal **Team**), no tenant-wide audit page (`/audit` is later), no
booking on behalf (`console.bookings.create` deferred), no customer edits or GDPR export, no queue item actions, no
card input anywhere.

## How to …

### Open the console and switch environment

1. In the portal, open your OTA and press **Open console**. Expect `/bookings` with your OTA's name and **TEST**.
2. On a live OTA, as owner/admin/agent/finance, use the switch → **LIVE**: you land on the dashboard; the shell turns
   amber with "LIVE environment"; test bookings answer "Booking not found".
3. Switch back to **TEST**. A viewer never sees the switch.

```diagram
flow-live-switch
```

### Work the needs-attention list

1. Dashboard → a highlighted count → the matching saved view.
2. Open a booking: **What needs staff** says why (ticketing failed, deadline, reconciliation, cancellation request,
   schedule change, sync failure).
3. Act (issue, cancel, resync) and check that the booking leaves the view.

```diagram
flow-work-bookings
```

### Issue a booking held in manual review

1. Open a booking with ticketing `manual_review` (ticketing policy "Manual review", or an airline-card booking).
2. **Issue tickets**: read what the dialog says it takes; type a reason; for an airline card choose `CASH` or
   `ACCOUNT` and, as owner/admin, tick **Issue although the payment is not captured**.
3. Expect status Ticketed, the `booking.issue` staff action with your reason, and `booking.ticketed` in Mailpit.

```diagram
flow-issue-booking
```

### Cancel a booking

1. **Cancel the booking** on the booking page. Read the Amadeus step the dialog names: release (nothing ticketed), void (every ticket
   issued today in the OTA's time zone) or a request to the airline.
2. Choose the reason category, type a reason, choose what happens to the money (none / full / amount; a request to
   the airline offers no refund choice), keep or untick the e-mail.
3. Expect Cancelled (release/void) or "Cancellation requested from the airline: the booking is not cancelled yet."

```diagram
flow-cancel-booking
```

### Capture and refund a Stripe payment

1. Set **Policies → Ticketing policy** to "Manual review" and book on the storefront with Stripe's test card.
2. Open the payment (`/payments?status=authorized`), **Capture** with a reason. Expect `captured`.
3. **Refund** part of it (category Goodwill). Expect a `refunds` row `pending`, then `succeeded` and the payment
   `partially_refunded` once the Stripe webhook arrives (`tools/dev/stripe-listen.sh`).

```diagram
flow-capture-refund
```

### Import a PNR

1. `/pnr`, type the record locator of an order in your office, **Look up**.
2. **Import as a booking**: pricing mode (markup rules / net / override with a selling total), customer or contact
   e-mail, confirmation e-mail, tags, note, reason.
3. Expect the new booking's page: for an order without tickets confirmed + ticketing `manual_review` (an order with
   all its tickets is ticketed + issued), channel `import`, payment `not_applicable`; staff action `booking.import`;
   `booking.confirmed` e-mail only when "Send the booking confirmation to the contact" was ticked.

```diagram
flow-pnr-import
```

### Close a reconciliation review

1. Bookings → **Reconciliation review** view; open a booking ("Reconciliation needs staff review").
2. Look in the queuing office for an order with the remark `VELEXIS <reference>`.
3. **Close the review** → **Order found** + record locator, or **Not booked** + a note of what you looked for.
4. Expect Confirmed (order found) or Failed (not booked) and the booking gone from the view.

```diagram
flow-close-review
```

### Read a queue

1. `/queues` → **Open a queue** (Queue number, Category, Office), **Open queue**.
2. The stored read shows; **Read now from Amadeus** stores a fresh snapshot.
3. An orphan PNR's **Import** opens `/pnr` with its record locator.

```diagram
flow-queues
```

### Quote a fare for a caller

1. `/shopping`, fill From/To/Departure/travellers, **Search offers**.
2. On an offer: **Branded fares**, then **Confirm price**.
3. Tell the caller the selling price comes from the storefront (markup and fees are added there); send them to book on
   the storefront.

```diagram
flow-shopping
```

### Change markups and fees

1. `/settings/markups` → the rule "Default" → set **Percentage** to 10, **Save changes**.
2. Search on the storefront (another date: identical searches are shared for 30 s): every offer is net + 10 %,
   rounded half-up to the currency's minor unit.
3. `/settings/fees/new`: Fee type "Booking service fee", Label "Service fee", Fixed amount 7.50, Computed "Per
   booking", **Create fee rule**. The next priced offer shows "Service fee".

```diagram
flow-pricing-rules
```

### Change the storefront

1. `/settings/storefront?tab=brand`: change the primary colour; check the contrast verdict; **Save branding and
   theme**.
2. `?tab=features`: **Offers per search** 40, **Save search**; the storefront's next search asks Amadeus for `max=40`
   at once (searches read the setting, no cache).
3. Within 5 minutes (or after clearing the storefront tab's session copy) the storefront shows the colour.

```diagram
flow-storefront-settings
```

### Images, pages and templates

1. `/settings/assets` → **Upload an image** (logo). Pick it in Brand and theme.
2. `/settings/pages/new`: Address (slug), Language, Title, Body, "Published on the storefront", "Listed in the
   storefront footer" → **Create page**; open `/p/<slug>` on the storefront.
3. `/settings/templates` → `booking.confirmed` → edit, **Preview**, **Save**; break a `{{` and save: "The template
   does not compile" with the part and line.

```diagram
flow-content-and-templates
```

### Trace a failed action

1. Copy the request id from the error message.
2. `/supplier-log?requestId=<id>` → the Amadeus call behind it, its status and error codes.
3. **Show the redacted bodies** to read what was sent and answered.

```diagram
flow-supplier-log
```

## Roles and permissions

The matrix of `repo:ota/admin/src/lib/permissions.ts` ([[staff-role]]); `can()` needs the role **and** the API's
granted permission.

| Permission | owner | admin | agent | finance | viewer |
|---|---|---|---|---|---|
| `bookings:read` (dashboard, bookings, PNR lookup) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `bookings:write` (patch, notes, resync, import) | ✓ | ✓ | ✓ | | |
| `bookings:issue`, `bookings:cancel` (incl. Close the review) | ✓ | ✓ | ✓ | | |
| `allowUnpaid` on issue | ✓ | ✓ | | | |
| `customers:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `queues:read` | ✓ | ✓ | ✓ | | |
| `supplier_requests:read` | ✓ | ✓ | ✓ | ✓ | |
| `amadeus:read` (shopping, Advanced panel) | ✓ | ✓ | ✓ | | |
| `settings:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `settings:write` | ✓ | ✓ | | | |
| `payments:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `payments:capture` | ✓ | ✓ | ✓ | ✓ | |
| `payments:refund` | ✓ | ✓ | | ✓ | |
| LIVE switch (live OTA only) | ✓ | ✓ | ✓ | ✓ | |

```diagram
flow-roles
```

What a refusal should look like:

- **Hidden**: the navigation entry and the action are absent (no "Booking actions" for a viewer).
- **Disabled**: settings buttons disabled with "Needs the permission settings:write"; `/settings/*/new` shows a state
  naming the permission, without a form.
- **Forged POST**: every server action starts with `requireStaff(permission)`: "You do not have permission to do this
  (<permission>)" before any API call.
- **API**: `403 FORBIDDEN` with `details.requiredPermission` and a `denied` row in `staff_actions`.
- Role changes apply at the next refresh (≤ 15 min); a removed member is sent to the portal within 60 s.

## Bug-hunting checklist

```bug-hunt
**Session and SSO**
- Replay the portal's hand-off form: `401` page, no `__Host-vx_*` cookie. A form from another origin: `403`.
- `document.cookie` in the console is empty on every page (all four cookies are HttpOnly).
- Delete `__Host-vx_staff_at` and open two tabs at once: one refresh only. Check `redis-cli -a dev_redis KEYS 'staffsess:*'`: the family still exists (a double rotation would revoke it).
- Remove a member in the portal's Team page: their next page goes to the portal within 60 s (`staffdeny:*` keys).
- "Sign out everywhere" in the portal ends every console session; neither can refresh again.
```

```bug-hunt
**Environment**
- A viewer of a live OTA: TEST badge only. Force `__Host-vx_env=live` in devtools: the shell shows "Live is not available for this OTA or role" and the cookie returns to `test`.
- In LIVE, every destructive dialog says LIVE ("… in LIVE" on the button). Test bookings answer "Booking not found".
- A server action after a role downgrade must not silently run in another environment than the page showed.
```

```bug-hunt
**Booking actions** (schema `tenant_<key>`)
- Double-click **Issue tickets** / **Cancel** / **Refund**: one call executes; `SELECT key, status, response_status FROM tenant_<key>.idempotency_keys ORDER BY created_at DESC LIMIT 5;` shows one key.
- A corrected form after a `422` succeeds without reload (new key). After `409 IDEMPOTENCY_KEY_REUSED` the dialog asks for a reload instead.
- Edit the same booking in two tabs: the second save says "This record changed; reload…" (`412`), nothing changes.
- After issue: `SELECT status, ticketing_status, version FROM tenant_<key>.bookings WHERE reference='…';` is `ticketed / issued`; `booking_tickets` rows exist; Mailpit has `booking.ticketed` when the box was ticked.
- Cancel of tickets issued yesterday (OTA time zone, `storefront_settings.time_zone`): the dialog must say "request to the airline", offer no refund, and the booking must stay not cancelled.
- Airline-card booking: Issue offers only CASH/ACCOUNT; Refund is never offered; no card field exists anywhere.
- Patch a traveller: hidden fields (other phones, address lines 3+, middle name) must survive (`order_snapshot` before/after).
- `SELECT action, outcome, reason, staff_role FROM tenant_<key>.staff_actions ORDER BY created_at DESC LIMIT 10;` one row per change or refusal; no row for list reads; reads `customer.view`, `pnr.lookup`, `order.retrieve`, `amadeus.*` audited.
```

```note
**Card numbers in free text are refused.** A note, a cancel, issue, capture or refund reason, a remark, the PNR
import's note, reason or tags, a markup rule's notes for staff and the shopping reason that hold a card number show
"A note never holds a card number: remove it." (or "A reason …" / "A remark …" / "A tag …") at the field; nothing is sent to the API, which refuses the same text
with `card_data`. Add a note `4111 1111 1111 1111` and check that
`SELECT summary, data FROM tenant_<key>.booking_events WHERE type = 'staff.note' ORDER BY created_at DESC LIMIT 1;`
finds no such row.
```

```bug-hunt
**Money and time**
- Amounts are decimal strings: check 3-decimal or 0-decimal currencies display exactly (no float rounding). Typed capture and refund amounts accept at most two decimals (the API's rule for card currencies).
- Refund more than captured − refunded − pending refunds: the message names "at most …".
- Partial capture: the rest of the authorisation is released (`payments.amount_captured < amount_authorized`).
- Times: created/updated in the OTA's time zone; departures local to the airport; `createdTo` includes its whole day.
- Deadline window links carry `asOf`; reopening an old link must not shift the window.
- Spelling: the console and the API say `cancelled`, while `payments.status` and `refunds.status` store Stripe's `canceled` (one l). Filter `/payments?status=cancelled`, query the DB with `'canceled'`.
```

```bug-hunt
**PNR, queues, shopping**
- Lookup of another OTA's order: no traveller or office leaks, a `denied` staff action, no `bookings` row.
- Import twice in parallel: one booking, the other answer `409 ORDER_ALREADY_IMPORTED` with a link.
- `queue_snapshots` grows by one per **Read now from Amadeus** (and per reload of a `?read=1` URL), none for opening the stored view or paging.
- `/queues` is built from the newest 100 snapshots only. With many monitored queues (the poller reads each every 15 minutes, up to 20 per connection) a queue staff read an hour or two ago drops off the list although its snapshots exist; open it again with **Open a queue**.
- A shopping search that times out reaches Amadeus once: `supplier_requests` has one row per click.
- `/shopping` looks for the default markup rule in at most 5 pages of 100 rules in priority order: with more than 500 rules before it, the tile says "This OTA has no default markup rule." (prices are not affected).
```

```bug-hunt
**Settings**
- Save one storefront section in two tabs: the second gets `412`, and the first tab's other sections keep what was typed.
- After a settings save: `redis-cli -a dev_redis KEYS 't:<tenantId>:*:sf:*'` are gone (the API deletes them); the storefront shows the change within 5 minutes.
- Offers per search 0, 251, "abc", "1.5": refused at the field before any call; the same value again says "Nothing to save" and `storefront_settings.version` does not move.
- Default markup rule: no inputs for priority, active or window; a forged POST cannot change them (`409 default_rule`).
- Upload an SVG renamed `.png`, a 1.1 MB PNG: refused in the browser and again in the action; `storefront_assets` unchanged.
- Delete an image used as the logo: `409 asset_in_use` naming the setting.
- Template with `{{#if}}` never closed: refused per part and line; `notification_templates` unchanged; `settings.templates.put` `failed` staff action.
- Preview HTML with `<script>`: never runs (iframe `sandbox=""`).
- Page body with raw HTML or a `javascript:` link: refused at its line.
```

```bug-hunt
**Accessibility and headers**
- Every page title is `<page> · Velexis OTA admin`; tables scroll with the keyboard; dialogs taller than 720 px scroll.
- Each HTML answer has a CSP with its own nonce, `frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`; no `NEXT_PUBLIC_` value, token or key in any HTML/JS answer.
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Open console" lands on a portal error, or `/sso` answers `403` | `Origin` is not `PUBLIC_PORTAL_URL` (e.g. 127.0.0.1 vs localhost) | Use `http://localhost:3000` and `http://localhost:3002` as in `.env.example` |
| `/sso` answers `401` "expired or already used" | The portal token lives 60 s and is single use (`ptk:<sha256>` in Redis) | Press **Open console** again |
| `/sso` answers `403` "This OTA is live: turn on two-factor authentication…" with **Turn on two-factor authentication** | Live OTA and the portal account has no MFA (normally the portal refuses first; this shows when the OTA went live within the token's 60 s) | Turn on MFA at the portal's `/account/security` |
| Every page goes back to the portal | No refresh cookie, refresh refused, or member removed | Open the console again from the portal |
| "The console is unavailable" | `console.auth.me` failed (OTA API down) | Start the OTA API; `/health/ready` should be `200` |
| `/health/ready` answers `500` | Invalid configuration (`OTA_API_URL` not loopback, bad `OTA_ADMIN_SERVICE_KEY`) | Read the `ConfigError` in the log; fix `ota/admin/.env.local` |
| Every call `401`/`403` from the API | `OTA_ADMIN_SERVICE_KEY` differs from the backend's, or the call went through a proxy (`X-Forwarded-For`) | Same key in both env files; `OTA_API_URL=http://127.0.0.1:4000` |
| Shopping or PNR: "No Amadeus connection is active for this environment" | The OTA's connection is not `active` (no office assigned) | Check the portal's Amadeus page; the platform admin's office pool |
| A settings change is not on the storefront | Storefront tab keeps a 5-minute session copy | Wait or clear the tab's `sessionStorage` |
| Images do not show in the theme preview | By design: CSP `img-src 'self' data:` | Logos are chosen by name; open them on the API host |
