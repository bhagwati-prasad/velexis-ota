# Storefront pages, part 2: bookings, account and content

This page specifies the remaining pages of the hosted storefront: my bookings, the booking detail page with documents, contact changes and cancellation, guest lookup, sign-in, sign-up, e-mail verification, password reset, the account page, content pages from the storefront settings, and the not-found and error pages. For each page it gives the URL, purpose, the SDK calls in order and the states to render. Part 1, [`pages.md`](pages.md), covers shopping and checkout and lists the states every page shares (suspended tenant, unknown host, service unavailable, rate limit, test mode).

Related: flows [my bookings and guest lookup](../../docs/flows/my-bookings-and-guest-lookup.md), [change and cancel](../../docs/flows/change-and-cancel.md), [ticketing and documents](../../docs/flows/ticketing-and-documents.md); SDK guides [B1](../../../docs/velexis-sdk/sdk/docs/B1.md) §3–§4 and [B3](../../../docs/velexis-sdk/sdk/docs/B3.md) §3–§4; [OADR-0006](../../docs/adr/0006-storefront-cookie-sessions-and-csrf.md) (cookies), [OADR-0012](../../docs/adr/0012-storefront-settings-assets-and-pages.md) (content pages); reference pages of the [Next.js example](../../../docs/velexis-sdk/examples/next-storefront/app/) (`bookings/`, `account/`); [storefront README](../README.md).

## 1. Who can open what

| Page | Visitor | Guest (booking cookie) | Customer (session cookies) |
|---|---|---|---|
| `/bookings.html` | → sign-in with `next` | → lookup | ✓ |
| `/booking.html?id=…` | → lookup | ✓ for bookings in `__Host-vx_bt` | ✓ own bookings |
| `/lookup.html` | ✓ | ✓ | ✓ |
| `/account/` | → sign-in with `next` | → sign-in | ✓ |
| `/account/sign-in.html`, `sign-up.html` | ✓ | ✓ | → `/account/` |

Sessions and guest tokens are cookies set by the API; the page only learns the outcome (`auth.getSession` → `401` means signed out). Access to a booking of another customer or tenant answers `404`, shown as "Booking not found".

## 2. My bookings: `/bookings.html?tab=upcoming|past|cancelled` (M3)

**Purpose.** The signed-in customer's trips in three tabs.

**SDK calls**

1. `boot()` with `auth.getSession`; no session → `/account/sign-in.html?next=/bookings.html`.
2. `bookings.list({ timeframe: tab, limit: 20 })`; "Load more" uses `page.next()`. Default sort per tab (upcoming by departure, past and cancelled newest first).

| State | Shows |
|---|---|
| Empty upcoming | "No upcoming trips", search link, "Booked as a guest? Find your booking" (lookup) |
| Empty past or cancelled | Short empty message |
| Card per booking | Reference, route, dates, travellers count, status badge (confirmed, ticketed, pending, cancelled; "cancellation requested" on the booking page, see below) |
| `401 TOKEN_EXPIRED` | Handled by the SDK (one refresh, retry); refresh failure → sign-in with `next` |

How the page decides (OFE-015, `bookings.html`, `src/pages/bookings.js`, `partials/templates/booking-row.html`):

- **Who.** A signed-in customer only. Anybody else is sent on with `location.replace`: to sign-in with `next` back to the tab, or to `/lookup.html` when the OTA has no customer accounts. The guest cookie `__Host-vx_bt` is httpOnly, so the page cannot tell a guest from a visitor; sign-in and the header both offer the lookup.
- **Tabs.** Three links (`?tab=upcoming|past|cancelled`, anything else is `upcoming`), the current one with `aria-current="page"`, so each tab has its own address, history entry and reload. `bookings.list({ timeframe, limit: 20, sort })` spells out the API's default order of each tab (`departure` for upcoming, `-departure` for past and cancelled). "Load more" appends `page.next()` and moves the focus to the first new card; a `401` of either call (the session ended after the SDK's one refresh) goes to sign-in.
- **Cards.** Route (`CDG → New York (JFK)`, the code alone without a city name), dates (`returnAt` for a return), "N travellers: <lead traveller>", reference, total, and the status as a word and a colour (`bookingStatus.*` of `lib/i18n.js`): "Being confirmed", "Confirmed", "Ticketed", "Partly ticketed", "Cancelled"; a schedule change or tickets still being issued add a line. `BookingSummary` has no field for a cancellation that waits for the staff, so the list shows such a booking by its status and the booking page says "Cancellation requested".

## 3. Booking detail: `/booking.html?id=bkg_…` (M3)

**Purpose.** Everything about one booking, and the self-service actions its `allowedActions` permit.

**SDK calls**

1. `bookings.get({ bookingId })`: itinerary, travellers (documents masked), contacts, totals, payments summary, tickets, `allowedActions`, `version`. A "Refresh from airline" link calls `bookings.get({ bookingId, refresh: true })` (the API throttles it to once a minute).
2. `bookings.getTicketingStatus({ bookingId })` while tickets are not final, polled as on the confirmation page.
3. **Documents**: `bookings.listDocuments({ bookingId })`; "Download" calls `bookings.getDocumentDownloadUrl({ bookingId, documentId })` and navigates to the returned short-lived URL.
4. **Change contacts** (if allowed): a dialog with the contact form, `bookings.update({ bookingId, ifMatch: version, contacts })`.
5. **Cancel** (if allowed and `features.selfServiceCancellation`): `bookings.quoteCancellation({ bookingId })` shows the **refund preview** (mode `release`, `void`, `request_only` or `not_allowed`; refund amount, fees, deadline of the quote); confirming calls `bookings.cancel({ bookingId, ifMatch: version, reasonCode, comment, expectedRefund })`.
6. **Fare rules**: `bookings.getFareRules({ bookingId })` in a disclosure.
7. **Timeline**: `bookings.listEvents({ bookingId })` (customer-visible events only).

| State | Shows |
|---|---|
| `401 UNAUTHENTICATED` without session or guest token | "Find your booking" with the lookup form |
| `404 NOT_FOUND` | "Booking not found" |
| Ticketing pending or delayed | Banner "Tickets are being issued; we will e-mail you" |
| Quote mode `request_only` | "We will send your request to the airline; refunds follow the fare rules" before confirming |
| Quote mode `not_allowed` | Cancel button replaced by "This booking can no longer be cancelled online", support contact |
| `409 REFUND_AMOUNT_CHANGED` | New refund shown; confirm again |
| `409 BOOKING_NOT_MODIFIABLE` / `BOOKING_ALREADY_CANCELLED` | Reload, actions hidden |
| `412 PRECONDITION_FAILED` | "The booking changed", reload and retry |
| `422 CONTACT_DATA_INVALID` | Field errors in the dialog |
| `403 FEATURE_DISABLED` (traveller documents, loyalty) | Those edits are not offered in the MVP ([scope §3.3](../../docs/scope.md#33-b3-checkout-payments-bookings-24-21-mvp-3-deferred)) |
| `409 DOCUMENT_NOT_READY` | "The document is being prepared, try again in a minute" |

Not offered in the MVP: changing traveller documents, buying extras after booking (`bookings.getAncillaries`, `addAncillaries`, `createPayment` are deferred).

How the page decides (OFE-015, `booking.html`, `src/pages/booking.js`, `src/components/cancel-dialog.js`, `src/components/booking-timeline.js`, `partials/templates/document-row.html`):

- **Controls follow `allowedActions` exactly** (`ACTION_CONTROLS`): "Change contact details" for `canModifyContacts`, "Cancel booking" for `canCancel`, "Refresh from airline" for `canRefresh`, a "Download" button per ready document for `canDownloadDocuments`. The actions the MVP does not offer here (`canModifyTravelerDocuments`, `canModifyLoyaltyPrograms`, `canAddAncillaries`, and `canAddRemarks`: special requests are made at checkout) have no control, whatever they say. `storefront.get` carries no `selfServiceCancellation` switch: the API applies it to `canCancel` (reason `disabled_by_ota`). A live booking that cannot be cancelled for a reason the traveller cannot change (`flown`, `too_close_to_departure`, `disabled_by_ota`, …) says "This booking can no longer be cancelled online" with the support address; reason `pending` (a cancellation already waiting, or no Amadeus order yet) says nothing more, because the cancellation block or the status explains it.
- **The cancellation block** shows `booking.cancellation` as bookings.get answers it since FIX-W28-CANCEL: a cancelled booking ("This booking is cancelled", the date in the OTA's time zone, and what happens to the money by `refundStatus`: released authorisation, refund on its way or done with its amount, staff checking it), or, on a live booking, a cancellation that waits for the staff or the airline ("Cancellation requested", the request's date, the estimated refund), which also makes the status badge "Cancellation requested".
- **Banner.** "We are confirming your booking with the airline" for a pending booking, "did not go through, you have not been charged" for a failed one, "Tickets are being issued; we will e-mail you" while the tickets are not issued (pending, in progress, failed and retried, waiting for the staff). While the booking or its tickets are pending or in progress, `bookings.getTicketingStatus({ bookingId })` is polled after each answer's `pollAfterSeconds` (10 s for a pending booking without one; at most 30 minutes for a pending booking and 10 for tickets); once decided the booking, its documents and its history are read once more, and polling does not start again from that read.
- **Documents.** `bookings.listDocuments({ bookingId, limit: 20 })` when `canDownloadDocuments`; ready documents get a "Download" button (an `aria-label` with the kind and file name), documents being generated say "Being prepared", superseded and failed ones are not shown. A click asks `bookings.getDocumentDownloadUrl` every time (never before a click, never kept: the signed URL expires after 5 minutes) and navigates to it only when it is a path of this storefront (`/api/v1/files/…?exp=…&sig=…`) or an absolute URL of this origin. `409 DOCUMENT_NOT_READY` and the other failures are said next to the document. Without `canDownloadDocuments`, the section says why (`not_ticketed`, `pending`). The confirmation page's "Your documents" link (`#documents`) focuses the section.
- **Change contact details.** A native `<dialog>` with the primary contact (first and last name, e-mail, calling code, mobile). `bookings.update({ bookingId, ifMatch: version, contacts })` sends the whole list because Amadeus replaces it: the primary contact first with the typed values (its other fields kept, a cleared phone dropped), then the other contacts (an invoice contact) as they are, without ids or empty fields. Success closes the dialog and says where the confirmation went; `422 CONTACT_DATA_INVALID` marks the fields (`/contacts/0/…`) and focuses the summary; `409 VERSION_CONFLICT` reloads the booking with `refresh: true` and `412 PRECONDITION_FAILED` without, keeping what was typed for another save with the new version; `409 BOOKING_NOT_MODIFIABLE` / `BOOKING_ALREADY_CANCELLED` close the dialog and reload (the button goes); `504 SUPPLIER_TIMEOUT` reloads the booking as recorded and says the airline has not confirmed yet.
- **Cancel.** The dialog quotes (`bookings.quoteCancellation`) and shows the mode's sentence (`release`, `void` with its deadline, `refund`, `request_only`), the refund of what was paid, what is kept (airline penalty, fees), one line per traveller when there are several, and the quote's validity; `not_allowed` replaces the form with its reason and the support address (reason `cancelled`: "This booking is cancelled"). A reason is required, the message optional (500 characters). `bookings.cancel({ bookingId, ifMatch: version, reasonCode, comment, expectedRefund })` uses 90 s and the idempotency key `cancel-<bookingId>-<version>-<hash>`, the hash (FNV-1a, 8 hex digits) of the reason, message and refund sent: a double click, a Retry or a reload of the same request replays the first outcome, while a request with another amount gets a new key, because the API keeps a final `409` for 24 hours and would answer the same key with another body `409 IDEMPOTENCY_KEY_REUSED` (a refinement of the `cancel-<bookingId>-<version>` of SDK guide B3 §4.5). `409 REFUND_AMOUNT_CHANGED` says "The refund changed from X to Y", quotes again (or takes `details.newRefund` when the quote fails) and asks again; `412` / `409 VERSION_CONFLICT` reload the booking and quote again for its version; `409 BOOKING_NOT_MODIFIABLE` (with the sentence of its `details.reason`) and `403 FEATURE_DISABLED` replace the form with "This booking can no longer be cancelled online" and the support address, `409 BOOKING_ALREADY_CANCELLED` with "This booking is cancelled", and all of them reload the booking (its actions go); `504 SUPPLIER_TIMEOUT` says the airline has not confirmed the cancellation yet and reloads the booking (its pending cancellation), never sending again; `503` and other passing failures keep the form with Retry of the same request. While the request is on its way the dialog cannot be closed.
- **Fare rules** load once, when "Changes and refunds" is first opened (`bookings.getFareRules`, cached by the API), with the price page's wording. **History**: `bookings.listEvents({ bookingId, limit: 20 })`, newest first, each with its time in the OTA's time zone and the API's `summary`; "Show earlier events" appends `page.next()`.
- **Refresh from airline** asks `bookings.get({ bookingId, refresh: true })`; an airline that does not answer keeps the saved booking and says so.

## 4. Guest lookup: `/lookup.html` (M3)

**Purpose.** Find a booking made as a guest, or on another device.

**SDK calls.** `bookings.lookup({ bookingReference, lastName })`. In cookie mode the API adds the token to `__Host-vx_bt` and returns `bookingToken: null`; the page then goes to `/booking.html?id=bkg_…`.

| State | Shows |
|---|---|
| `404 NOT_FOUND` | One message for a wrong reference and a wrong name: "We could not find a booking with these details" |
| `429 RATE_LIMITED` | "Too many attempts, try again in N minutes" |
| `400 VALIDATION_FAILED` | Field errors |

## 5. Authentication pages (M3)

All forms keep paste and password managers working (`autocomplete="email"`, `current-password`, `new-password`). A `next` parameter is accepted only as a relative path starting with a single `/`.

| Page | SDK calls | States |
|---|---|---|
| **Sign in** `/account/sign-in.html?next=…` | `auth.signIn({ email, password, rememberMe })`; success → `next` or `/account/` | `401 INVALID_CREDENTIALS` (generic message), `423 ACCOUNT_LOCKED` (wait 15 min), `403 EMAIL_NOT_VERIFIED` (resend link) |
| **Sign up** `/account/sign-up.html` | `auth.signUp({ email, password, firstName, lastName, termsVersion, marketingConsent, returnPath })` with the terms version of `config.legal`; when a session opens (verification not required) → `next`; otherwise "Check your e-mail" | `409 EMAIL_ALREADY_REGISTERED` (sign-in and reset links), `422 PASSWORD_TOO_WEAK` (rules shown up front: at least 10 characters, not a common password) |
| **Verify** `/account/verify.html?token=…` | Reads the token, removes it from the URL (`history.replaceState`), `auth.verifyEmail({ token })`; shows `claimedGuestBookings` when guest bookings were attached | `400 VERIFICATION_TOKEN_INVALID` (expired or used): resend form with `auth.resendVerification({ email })` |
| **Forgot password** `/account/forgot-password.html` | `auth.requestPasswordReset({ email })` | Always the same "If an account exists, we sent a link" message (no account probing) |
| **Reset password** `/account/reset-password.html?token=…` | Token read and removed from the URL, `auth.resetPassword({ token, newPassword, signIn: true })`; success → sign-in (or signed in when the API opens a session) | `400 PASSWORD_RESET_TOKEN_INVALID` (request a new link), `422 PASSWORD_TOO_WEAK` |

Rate limits (`429`) show the shared message. The exact request field names are those of the generated types (`SignUpRequest`, `SignInRequest`, `PasswordResetConfirmRequest`); the lists above are reading aids.

How the pages decide (OFE-009, `src/pages/account-*.js`, `src/lib/session.js`):

- **Where success leads.** `next` when it is a path on this storefront, `/` for anything else (`next=https://evil.example`), `/account/` without `next`. A signed-in customer who opens sign-in or sign-up goes there at once. The links between sign-in, sign-up and the password reset keep `next`, and sign-up and the e-mail requests send it as `returnPath` only when it fits the contract's pattern (a comma list such as `stops=0,1` does not, and is left out).
- **Cookie mode.** `auth.signUp` and `auth.resetPassword` resolve with `session: null` whatever happened, so sign-up goes on unless `emailVerification.policy` is `required_before_sign_in` ("Check your e-mail" with the masked `sentTo`), and the reset page asks `auth.getSession` afterwards: signed in, on to `next`; otherwise "Your new password is saved" with a sign-in link.
- **Tokens.** The page module takes `token` out of the address bar before `boot()` runs, so no request of the page carries it in its `Referer`. The requests the browser makes before the module runs (the module itself, its preloads, the stylesheet) still see the address with the token, so `verify.html` and `reset-password.html` set `<meta name="referrer" content="strict-origin">` first in their head: those requests send the origin alone, and the token never reaches an access log. Not `no-referrer`, which would make the SDK's `mode: "same-origin"` writes send `Origin: null` and fail the CSRF check. A missing token, or one that does not match the contract's `vt_…` / `pr_…` pattern, is not sent: the page offers a new link at once. `422 PASSWORD_TOO_WEAK` keeps the reset token for another try.
- **Messages.** `INVALID_CREDENTIALS` is one message for a wrong address and a wrong password, with the attempts left when three or fewer remain and a password-reset link; `ACCOUNT_LOCKED` shows `details.lockedUntil` in the OTA's time zone; `PASSWORD_TOO_WEAK` names the first rule of `details.violations` on the password field and never quotes the password; a `/termsVersion` error also forgets the cached configuration so that a reload shows the current terms. Without customer accounts (`features.customerAccounts = false`) the forms are not offered; the verification link still works.
- **Account menu** (the header, every page): signed out, "Sign in" with `next` back to the page; signed in, "Hi, <first name>", "My account" and "Sign out" (`auth.signOut()`, then `/`; a `401` counts as already signed out, any other failure keeps the menu and says so).

## 6. Account: `/account/` (`account/index.html`, M3)

**Purpose.** The customer's profile and session controls.

**SDK calls**

1. `account.get()`: name, e-mail, phone, verification state, `version`.
2. **Profile**: `account.update({ ifMatch: version, firstName, lastName, phone, … })`.
3. **Password**: `auth.changePassword({ currentPassword, newPassword })`; the API rotates the session cookies.
4. **Sign out**: `auth.signOut()`; **sign out everywhere**: `auth.signOut({ scope: "all" })`. Both clear the cookies and return to `/`.
5. **Delete account**: a confirmation dialog that asks for the password, then `account.delete({ currentPassword, reason })` (immediate soft delete); bookings stay retrievable through lookup.

| State | Shows |
|---|---|
| `412 PRECONDITION_FAILED` | "Your profile changed elsewhere", reload |
| `400 CURRENT_PASSWORD_INCORRECT` | Field error on the current password |
| `409 ACCOUNT_DELETION_BLOCKED` | The reason from `details` (for example an upcoming trip in progress) and the support contact |
| Unverified e-mail | Banner with "Resend verification" |

**Saved travellers** (`/account/travellers.html`) and **preferences** are **later**: their operations are deferred (`features.savedTravelers = false`) and the account page shows no link to them in the MVP.

## 7. Content pages: `/p/<slug>` (`p.html`, M4)

**Purpose.** The OTA's own pages: about, terms, privacy, cookies, refund policy, imprint, FAQ ([OADR-0012](../../docs/adr/0012-storefront-settings-assets-and-pages.md)).

**SDK calls**

1. `storefront.getPage({ slug })` with the slug from `location.pathname`.
2. `lib/blocks.js` renders `blocks` (`heading`, `paragraph`, `list`, `image`, inline `text`, `strong`, `em`, `link`) with `createElement` and `textContent`; images use the same-origin asset URL; links are re-checked (`https:`, `mailto:`, `tel:`, `/p/…`).
3. The footer of every page lists `storefront.listPages` entries with `showInFooter`, plus `config.legal.links` (external URL or page slug).

| State | Shows |
|---|---|
| `404 NOT_FOUND` | The 404 page content in place (status stays 200 because the HTML is static; the page sets `noindex`) |
| Before M4 | No `/p/` links; legal links point to the OTA's external URLs from the configuration |

## 8. Not found and error pages (M2)

| Page | When | Content |
|---|---|---|
| `/404.html` | Caddy `handle_errors 404` for unknown paths (`/p/<slug>` is rewritten to `p.html` first) | Branded header and footer (boot runs), "Page not found", search form and home link |
| Full-page states (no separate file) | Boot errors: suspended tenant, unknown host, service unavailable | Rendered into `main` by `boot()` ([part 1 §2](pages.md#2-states-every-page-shares)) |
| Inline error | Any unexpected `VelexisError` | "Something went wrong" with the `requestId` for support, Retry; never a stack trace or raw supplier text |
