# OTA admin routes

This page details every route of the OTA admin: what it shows, the SDK `console` calls it makes (server side), the actions it offers with their permissions, and the states and error codes it must handle. It is the checklist for the OTA admin tasks of M4 and for the Playwright journeys. The summary table, sessions, data-fetching pattern and permission rules are in the [OTA admin README](../README.md); the API behaviour behind each call is in the [console operations flow](../../docs/flows/console-operations.md), [SDK guide B4](../../../docs/velexis-sdk/sdk/docs/B4.md) and [API changes part 2](../../docs/api-changes-console-and-internal.md).

Related: [scope §1.3 and §2.3](../../docs/scope.md#13-staff-roles-and-permissions), [OADR-0011](../../docs/adr/0011-console-access-staff-sessions-and-environments.md), [OADR-0018](../../docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md), [OADR-0005](../../docs/adr/0005-markup-and-fee-engine.md), [OADR-0008](../../docs/adr/0008-ticketing-policy.md), [OADR-0012](../../docs/adr/0012-storefront-settings-assets-and-pages.md), [OADR-0013](../../docs/adr/0013-notifications-and-booking-documents.md), reference pages of the [Next.js example](../../../docs/velexis-sdk/examples/next-storefront/app/console/).

## 1. Errors every route handles

| Code | Shown as |
|---|---|
| `401 TOKEN_EXPIRED` | Redirect to `/auth/refresh?next=…` (server components) or an automatic refresh (server actions) |
| `401 UNAUTHENTICATED`, refresh refused | Cookies cleared, redirect to the portal's console page |
| `403 FORBIDDEN` | "You do not have permission (`details.requiredPermission`)" |
| `403 ENVIRONMENT_NOT_ALLOWED` | Environment reset to test, banner "Live is not available for this OTA or role" |
| `403 TENANT_SUSPENDED` | Full page "This OTA is suspended", link to the portal |
| `412 PRECONDITION_FAILED`, `409 VERSION_CONFLICT` | "This record changed; reload to see the latest version" |
| `429 RATE_LIMITED` | "Too many requests, retry in N s" |
| `504 SUPPLIER_TIMEOUT` on an Amadeus action | "Amadeus did not answer. Resync before retrying." with a Resync button ([`architecture-booking.md`](../../docs/architecture-booking.md) §4) |
| Other `VelexisError` | Message from `lib/errors.ts` and the `requestId` |

## 2. Dashboard: `/`

Tiles link to pre-filtered lists. Each tile renders only with its permission.

| Tile | SDK call |
|---|---|
| Ticketing failed or in manual review | `console.bookings.list({ ticketingStatus: ["failed", "manual_review"], limit: 1 })` → `totalCount` |
| Ticketing deadline within 24 h | `console.bookings.list({ status: ["confirmed", "partially_ticketed"], ticketingDeadlineBefore: now + 24 h, limit: 1 })` |
| Outcome unknown (reconciling) | `console.bookings.list({ status: ["pending"], limit: 1 })` |
| Authorised, not captured | `console.payments.list({ status: "authorized", limit: 5 })` (`payments:read`) |
| Last queue snapshot | `console.queues.listSnapshots({ limit: 1 })` (`queues:read`) |
| Latest bookings | `console.bookings.list({ sort: "-created", limit: 10 })` |

## 3. Bookings

### 3.1 List: `/bookings`

- **SDK:** `console.bookings.list(params)` with filters from `searchParams`: `q`, `status[]`, `ticketingStatus[]`, `paymentStatus[]`, `source[]`, `departureFrom/To`, `createdFrom/To`, `ticketingDeadlineBefore`, `recordLocator`, `reference`, `customerEmail`, `travelerLastName`, `validatingCarrier`, `tag`, `sort`, `cursor`, `limit` (25).
- **Saved views** (links with preset filters): Needs attention, To issue (deadline order), Reconciling, Cancelled, Imported.
- **Columns:** reference, record locator, lead traveller, route and first departure, status, ticketing status, payment status, total (selling) and margin, created, source.
- **States:** empty list per view; `totalCount` "10 000+" when the API returns `null`.

### 3.2 Detail: `/bookings/[bookingId]`

**Reads:** `console.bookings.get({ bookingId })` (and `refresh: true` from a "Sync from Amadeus" button, throttled by the API to one per 10 s); tabs load their own data:

| Tab | Content | SDK |
|---|---|---|
| Overview | Status, ticketing (policy, deadline, attempts), pricing (net, markup, fees, selling, pricing mode), payment summary, supplier sync state, `consoleActions` | `console.bookings.get` |
| Travellers and contacts | Travellers (documents decrypted for display, never logged), contacts, remarks, ticketing agreement | `console.bookings.get` |
| Amadeus order | The verbatim, redacted Flight Order as Amadeus returns it, with net prices | `console.bookings.retrieve({ bookingId })` (`bookings:read`) |
| Tickets and documents | Ticket numbers per traveller and segment, itinerary and e-ticket receipts | from `get` |
| Payments | Payments with events and refunds | `console.payments.get({ paymentId })` per payment (`payments:read`) |
| Timeline and notes | All booking events (customer-visible and internal), notes | from `get` (`events`, `notes`) |
| Staff actions | The last 20 staff actions on this booking | from `get` (`recentStaffActions`) |

**Actions** (each a dialog with a required reason, the environment badge, an idempotency key rendered with the dialog, and `ifMatch` = the displayed `version`):

| Action | SDK | Permission | Notes |
|---|---|---|---|
| Edit travellers, contacts, remarks, ticketing agreement | `console.bookings.patch({ bookingId, ifMatch, travelers?, contacts?, remarks?, ticketingAgreement?, … })` | `bookings:write` | Amadeus Flight Order Management PATCH; `409 VERSION_CONFLICT` on Amadeus 2552 |
| Issue tickets | `console.bookings.issue({ bookingId, ifMatch, reason, capturePayment: true, allowUnpaid?, notifyCustomer })` | `bookings:issue` | Captures an authorised Stripe payment first; `allowUnpaid` only for owner and admin ([OADR-0008](../../docs/adr/0008-ticketing-policy.md)) |
| Issue an airline-card booking left without tickets | `console.bookings.issue({ …, formOfPayments: [{ other: { method: "CASH" \| "ACCOUNT", flightOfferIds } }] })` or Cancel | `bookings:issue` | The card cannot be used again and the admin never takes card numbers ([OADR-0018](../../docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md)) |
| Cancel | `console.bookings.cancel({ bookingId, ifMatch, reasonCode, reason, refund: { mode: "none" \| "full" \| "amount", amount? }, notifyCustomer })` | `bookings:cancel` | The dialog shows release / void / request-only and the refund that will follow |
| Resync | `console.bookings.resync({ bookingId, include?, fareRules? })` | `bookings:write` | Shows the returned `changes` |
| Add note | `console.bookings.addNote({ bookingId, text, visibleToCustomer })` | `bookings:write` | Internal by default |
| Capture payment | `console.payments.capture({ paymentId, ifMatch, amount?, reason })` | `payments:capture` | Stripe, `authorized` only; partial capture releases the rest |
| Refund payment | `console.payments.refund({ paymentId, amount, reason, reasonNote? })` | `payments:refund` | Stripe only; `422 refund_via_airline` for airline-card payments |

| State | Shown as |
|---|---|
| `bookingStatus = pending` | Banner "Outcome unknown, reconciling until <time>"; Issue and Cancel hidden |
| Ticketing `manual_review` / `failed` | Banner with the reason and the deadline; Issue highlighted |
| Airline-card booking without tickets | Banner "The airline card cannot be charged again: issue with another form of payment or cancel" |
| `402 PAYMENT_DECLINED` on capture | "The authorisation has expired; contact the traveller" |
| `409 ALREADY_ISSUED`, `BOOKING_ALREADY_CANCELLED` | Reload with the current state |

## 4. PNR lookup and import: `/pnr`

1. A form with the record locator calls `console.bookings.findByRecordLocator({ reference })` (`bookings:read`): matches with owner office, travellers, segments, and whether it is already a booking (link).
2. "Import" opens a dialog: customer (search via `console.customers.list`) or contact e-mail, pricing mode (`markup_rules`, `net`, `override`), send confirmation, tags, note, reason → `console.bookings.import({ reference, customerId?, contactEmail?, pricing, sendConfirmation, tags, note, reason })` (`bookings:write`), then the new booking's page.

| State | Shown as |
|---|---|
| No match | "No order with this record locator in your offices" |
| `403 OFFICE_NOT_ALLOWED` | "This order belongs to an office outside this OTA" |
| `409 ORDER_ALREADY_IMPORTED` | Link to the existing booking |

An **Advanced** panel (`amadeus:read`) offers the raw `console.amadeus.getFlightOrderByReference` and `getFlightOrder` answers for support.

## 5. Queues: `/queues`, `/queues/[queueId]`

- `/queues`: monitored queues of the tenant's office with the last snapshot of each (`console.queues.listSnapshots`).
- `/queues/[queueId]`: "Read now" calls `console.queues.list({ queueId })` (Amadeus Queue List, stores a snapshot); paging the stored snapshot uses `cursor`. Items link to bookings when the record locator is known, otherwise to `/pnr?reference=…`.
- No queue item actions (remove, move) in the MVP ([scope §2.3](../../docs/scope.md#23-ota-admin-otaadmin)).

## 6. Shopping on behalf: `/shopping`

For staff answering a caller: search, compare and quote, with **net** Amadeus prices. All calls are raw, read-only console operations (`amadeus:read`):

| Step | SDK |
|---|---|
| Search offers | `console.amadeus.searchFlightOffers({ amadeus: <Flight Offers Search body> })` (origin, destination, dates, travellers, cabin, non-stop, carriers) |
| Seat availability by class | `console.amadeus.searchFlightAvailabilities({ … })` |
| Branded fares | `console.amadeus.upsellAirOffers({ … })` |
| Confirm price | `console.amadeus.quoteAirOffers({ … })` |

The page shows the net total and, for orientation, the OTA's default markup rule; it says plainly that booking on behalf comes later (`console.bookings.create` is deferred). Staff send the customer to the storefront to book, or import a booking made in the Amadeus terminal through `/pnr`.

## 7. Payments: `/payments`, `/payments/[paymentId]`

- List: `console.payments.list({ status, provider, method, bookingId, createdFrom, createdTo, cursor })` (`payments:read`), environment of the switch.
- Detail: `console.payments.get({ paymentId, refresh? })` with events (redacted), refunds, booking link, provider account mode; Capture and Refund dialogs as in §3.2.

## 8. Customers: `/customers`, `/customers/[customerId]`

- List: `console.customers.list({ q, emailVerified?, hasBookings?, sort, cursor })` (e-mail or name prefix), `customers:read`.
- Detail: `console.customers.get({ customerId })` (profile, verification, statistics) and `console.bookings.list({ customerId })`. Read-only in the MVP (no edits, no GDPR export).

## 9. Settings (`settings:read`; writes `settings:write`, owner and admin)

| Route | SDK | Notes |
|---|---|---|
| `/settings/markups`, `/new`, `/[markupRuleId]` | `console.settings.markupRules.list`, `.create`, `.get`, `.update`, `.delete` | Scope builder (origins, destinations, countries, carriers, cabins, traveller types, trip types, channels, net range), calculation, applies per, min/max, priority, stackable, active window. The default rule cannot be deleted or narrowed (`409 CONFLICT`, `default_rule`). "Changes apply to the next search." |
| `/settings/fees`, `/new`, `/[feeRuleId]` | `console.settings.feeRules.*` | Fee types; `change` fees stored but unused in the MVP |
| `/settings/storefront` | `console.settings.storefront.get`, `.update({ ifMatch, … })`, `console.settings.assets.list` | Tabs: **Brand and theme** (logos from assets, colours with contrast warning, fonts from the bundled list, corner radius); **Features**; **Policies** (ticketing policy `issue_after_payment` / `issue_at_booking` / `manual_review`, 3-D Secure, accepted card brands, offer and checkout TTLs, e-mail verification); **Payments** (airline card for test; live disabled until the M6 review, `403 FEATURE_DISABLED`); **Legal and support**; **SEO and consent**; **Operations** (alert e-mail, booking queue). Shows `warnings[]` (airline card with active markups). "Visible on the storefront within 5 minutes." |
| `/settings/assets` | `console.settings.assets.list`, `.upload({ file, kind })`, `.delete({ assetId })` | PNG, JPEG, WebP, ICO for favicons; ≤ 1 MB; no SVG; `422 ASSET_INVALID` (`type`, `size`, `dimensions`); `409 CONFLICT` when in use; metadata warning |
| `/settings/pages`, `/settings/pages/[pageId]` | `console.settings.pages.*` | Markdown-subset editor with a help panel; `422 UNPROCESSABLE` with `details.line` highlighted; publish switch, footer switch, sort order; "View on storefront" link for published pages; linked legal pages cannot be deleted |
| `/settings/templates`, `/settings/templates/[key]/[channel]/[locale]` | `console.settings.templates.list`, `.get`, `.put`, `.preview`, `.reset` | Effective template per key (customised or code default); editor for subject, HTML and text with the variable allow-list; Preview renders in a sandboxed iframe; `422 TEMPLATE_INVALID` errors by part and line; Reset restores the code default |

## 10. Supplier log: `/supplier-log`

`console.supplierRequests.list({ bookingId?, amadeusApi?, outcome?, httpStatus?, createdFrom?, createdTo?, includeBodies?, cursor })` (`supplier_requests:read`): time, API and operation, HTTP status, duration, booking link, Amadeus error codes; bodies (redacted, card numbers masked) only on demand.

## 11. Portal links: `/portal`

Links to `${PUBLIC_PORTAL_URL}/otas/<tenantId>/…`: `api-keys`, `domains`, `amadeus`, `payments`, `team`, `billing`, `go-live`, `settings`. These areas are owned by the platform; the admin only links to them.

## 12. Later

| Route or feature | Why later | Trigger |
|---|---|---|
| Book on behalf (`/shopping` → book) | `console.bookings.create` deferred | Staff-assisted sales requested |
| `/audit` tenant-wide staff actions | No list operation in the API; per-booking actions are shown | An OTA owner asks for a tenant-wide audit view: add `console.staffActions.list` spec-first ([OADR-0018](../../docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md)) |
| Raw Amadeus writes | Deferred in the API ([OADR-0011](../../docs/adr/0011-console-access-staff-sessions-and-environments.md)) | Support needs them |
| Customer edits, GDPR export, reports | Out of the MVP ([scope §2.3](../../docs/scope.md#23-ota-admin-otaadmin)) | After launch |
