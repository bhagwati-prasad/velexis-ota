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
| Card per booking | Reference, route, dates, travellers count, status badge (confirmed, ticketed, pending, cancelled, cancellation requested) |
| `401 TOKEN_EXPIRED` | Handled by the SDK (one refresh, retry); refresh failure → sign-in with `next` |

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
