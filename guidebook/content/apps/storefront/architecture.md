---
id: architecture
title: Storefront — architecture guide
summary: How the static multi-tenant storefront is built and served (one Vite build, host → tenant, same-origin /api through Caddy or the dev proxy), its modules, the tables and Redis keys behind its calls, its key flows and client-side lifecycles, security (cookie sessions, CSRF, CSP, the isolated airline-card page), configuration, tests and where to change things.
---

## At a glance

| Item | Value |
|---|---|
| Package | `@velexis/ota-frontend` (`repo:ota/frontend/package.json`), private |
| Runtime | Evergreen browsers (ES2022); **no server process**: Caddy serves `dist/` from `/srv/velexis/current/storefront` |
| Technology | HTML pages + partials, Tailwind CSS 4 (`@tailwindcss/vite`), vanilla ES modules, `@velexis/ota-sdk`; Vite 6 multi-page build |
| Entry points | One HTML file per page (`repo:ota/frontend/index.html` …) with one module each in `repo:ota/frontend/src/pages`; shared start-up `repo:ota/frontend/src/boot.js` |
| API access | `createVelexisClient({ baseUrl: "/api", session: "cookie" })` in `repo:ota/frontend/src/lib/client.js`; pages never `fetch` the API |
| Ports (local) | Dev 5173 (`STOREFRONT_DEV_PORT`), preview 4173 (`STOREFRONT_PREVIEW_PORT`) |
| Build | `pnpm --filter @velexis/ota-frontend build` → `dist/` (+ `payment-page-inventory.json`, budget check) |
| Test | `pnpm --filter @velexis/ota-frontend test` (Vitest + happy-dom), `pnpm --filter @velexis/ota-frontend lint`; e2e in `repo:tools/e2e/specs/storefront` |
| Budgets | JS ≤ 60 KB gzip per page (airline-card page ≤ 30 KB), CSS ≤ 20 KB, HTML ≤ 20 KB, fonts ≤ 2 families / 120 KB |

**One build serves every OTA.** Nothing tenant-specific is known at build time (no `VITE_` variables). The host name is
the tenant: Caddy forwards `X-Velexis-Host` and the edge secret, the OTA API resolves the host (`tenantkey:<key>` for
`<key>.ota.example.com`, `host:<hostname>` for a [[custom-domain]]) and the tenant's [[storefront-environment]], and
every page reads its branding, features and payment configuration at run time from `storefront.get`
([[runtime-configuration]]).

## Components

```diagram
components
```

| Folder / file | Job |
|---|---|
| `repo:ota/frontend/src/pages` | One entry module per page; most export `start(context, env)` so tests can inject a fake SDK, clock and navigation |
| `repo:ota/frontend/src/boot.js` | [[storefront-boot]]: configuration, [[primary-host]] redirect, theme, header, footer, [[test-mode-banner]], session, currency client; `renderState` for shared [[page-state]]s |
| `repo:ota/frontend/src/lib/client.js` | The single SDK client; drops the cached configuration on any `403 TENANT_SUSPENDED` |
| `repo:ota/frontend/src/lib/config.js`, `repo:ota/frontend/src/lib/config-cache.js` | `storefront.get` with the 5-minute `sessionStorage` cache (`vx.storefront.config`), every access in `try/catch` |
| `repo:ota/frontend/src/lib/session.js` | `auth.getSession`, the [[account-menu]], `nextTarget` / `withNext` ([[safe-next-path]]), password rules |
| `repo:ota/frontend/src/lib/errors.js`, `repo:ota/frontend/src/lib/i18n.js` | Error code → page state; every English UI string, `Intl.PluralRules` |
| `repo:ota/frontend/src/lib/dom.js` | `clone(templateId)` and `fill(el, data)`: `textContent` and an attribute allowlist (no `innerHTML`) |
| `repo:ota/frontend/src/lib/forms.js` | API `fieldErrors` → fields (`aria-invalid`), the focused [[error-summary]], `withSubmitState` (no double submit) |
| `repo:ota/frontend/src/lib/format.js` | Money as exact decimals, airport-local times without zone conversion, durations, OTA-zone timestamps |
| `repo:ota/frontend/src/lib/theme.js` | Branding → CSS custom properties; [[contrast-fallback]]; fonts; favicon |
| `repo:ota/frontend/src/lib/url.js` | Query helpers, `safeNext`, one-time token parameters, content-page slugs |
| `repo:ota/frontend/src/lib/blocks.js` | Content-page blocks → DOM with `createElement`; links and images re-checked |
| `repo:ota/frontend/src/lib/card-brand.js` | Airline-card page: brand from the BIN, Luhn, expiry, security-code length |
| `repo:ota/frontend/src/components` | `mount(root, props)` components: search form, combobox, passenger picker, date range, filters, sort, offer card, itinerary, fare families, price breakdown, stepper, traveller and contact forms, ancillary picker, dialog, cancel dialog, booking timeline, [[live-region]], header, footer, test banner |
| `repo:ota/frontend/partials` | Header, footer, test banner, states, noscript, search form and `templates/*.html`, included at build time |
| `repo:ota/frontend/src/styles/main.css` | Tailwind import, `@theme` tokens bound to the `--vx-*` runtime variables |
| `repo:ota/frontend/vite.config.js`, `repo:ota/frontend/scripts/vite-plugins.js` | Page inputs, partials, Caddy-like routing, `/api` [[dev-proxy]], preview headers, the isolated airline-card build |
| `repo:ota/frontend/scripts/payment-page-inventory.mjs` | [[payment-page-inventory]]: every page's scripts, hashes and headers; fails the build on an unreviewed page or third-party script |
| `repo:ota/frontend/scripts/check-budgets.mjs` | [[performance-budget]] check after every build |

## Data

The storefront owns **no tables**. Everything it shows or changes goes through OTA API operations, which read and
write the OTA's `tenant_<key>` schema through [[tenant-tx]] and read the platform's tenant and domain rows (cached in
Redis). The diagrams list what its calls touch.

```diagram
er-shop-and-book
```

```diagram
er-customers-and-access
```

| Page action | Operation | Writes (tenant schema) |
|---|---|---|
| Search | `POST /v1/flight-searches` | `flight_searches`, `flight_offers`, `supplier_requests` |
| Fare families | `POST /v1/flight-offers/{id}/upsells` | `offer_upsells`, `flight_offers` (`origin = upsell`) |
| Price | `POST /v1/priced-offers` | `priced_offers` |
| Continue to checkout | `POST /v1/checkouts` | `checkouts` |
| Checkout steps | `PUT /v1/checkouts/{id}/travelers` (and `/contacts`, `/ancillaries`, `/remarks`) | `checkout_travelers`, `checkout_contacts`, `checkout_ancillaries`, `checkout_remarks`, `checkouts.version`, child `priced_offers` |
| Payment step | `POST /v1/checkouts/{id}/payments` | `payments`, `checkouts.status = payment_pending`, `pricing_mode` |
| Card fee | `PATCH /v1/payments/{id}` | `payments.card_fee_amount`, `card_fee_lines`, checkout totals |
| Complete (Stripe) | `POST /v1/checkouts/{id}/complete` | `bookings` and children, `payments`, `payment_events`, `booking_access_tokens`, `booking_events`, `notifications`, `idempotency_keys` |
| Complete (airline card) | `POST /v1/checkouts/{id}/airline-card-completion` | the same, `payments` with brand/BIN/last 4 only |
| Lookup | `POST /v1/bookings/lookup` | `booking_access_tokens`, `booking_events`, `idempotency_keys` |
| Change contacts | `PATCH /v1/bookings/{id}` | `booking_contacts`, `bookings.contact_email`, `version`, `booking_events`, `notifications` |
| Cancel | `POST /v1/bookings/{id}/cancellation` | `bookings`, `booking_segments`, `booking_tickets`, `refunds`, `payments`, `booking_events`, `notifications` |
| Sign up / in / out, verify, reset | `/v1/auth/*` | `customers`, `customer_identities`, `customer_sessions`, `customer_consents`, `customer_password_resets`, `notifications` |
| Account | `/v1/account*` | `customers` (`pending_email`, profile), sessions revoked on delete |

**In the browser** (never a credential, never card data):

| Store | Key / name | Content | Lifetime |
|---|---|---|---|
| `sessionStorage` | `vx.storefront.config` | `{ storedAt, config }` of `storefront.get` | 5 minutes, per origin |
| `sessionStorage` | `vx.storefront.pages` | Footer content pages of `storefront.listPages` | 5 minutes |
| `localStorage` | `vx.currency` | The traveller's currency choice | Until changed |
| Cookie (JS-readable) | `__Host-vx_csrf` | 256-bit CSRF value ([[csrf-token]]) | 30 days, rotated at sign-in/out |
| Cookie (httpOnly) | `__Host-vx_at` / `__Host-vx_rt` | Access JWT / refresh token ([[customer-session]]) | 900 s / the refresh family (12 h, 30 days with remember me) |
| Cookie (httpOnly) | `__Host-vx_bt` | Up to 5 `bkg_<id>.<token>` [[guest-token]] entries | 30 days |

**Redis keys the storefront's calls depend on:** `t:<tenantId>:<env>:sf:<locale>` (the caller-independent part of
`storefront.get`), `host:<hostname>` / `tenantkey:<key>` / `tenant:<id>` (host resolution, 60 s), `rl:ota_shopping:*`,
`rl:ota_sign_in:*`, `rl:ota_account_mail_ip:*`, `rl:ota_account_mail_email:*`, `rl:ota_lookup_ip:*`,
`rl:ota_lookup_reference:*`, `rl:ota_checkout_payment:*`,
`rl:ota_airline_card_ip:*`, `rl:ota_airline_card_tenant:*` (throttlers, digests only), `t:<tenantId>:<env>:authfail:*`
(sign-in lockout), `t:<tenantId>:<env>:cxq:<bookingId>` (cancellation quote, 10 min),
`t:<tenantId>:<env>:ac:chk:<checkoutId>` / `ac:declines` / `ac:suspended` (airline card), `t:<tenantId>:<env>:cust:<customerId>`.
**Queues** fed by its calls (OTA worker): `ota-notifications` (e-mails), `ota-ticketing`, `ota-documents` (PDFs),
`ota-payments` (void, capture retry, refunds), `ota-bookings` (reconcile, sync).

## Key flows

### Page start-up and host → tenant

```diagram
seq-boot
```

### Search and price

```diagram
seq-search-price
```

### Checkout with Stripe

```diagram
seq-checkout-stripe
```

### Checkout with the airline card

```diagram
seq-checkout-airline-card
```

### Sign-in, My bookings and the silent refresh

```diagram
seq-sign-in-refresh
```

### Guest lookup

```diagram
seq-guest-lookup
```

### Cancellation

```diagram
seq-cancel
```

## Lifecycles

The storefront manages client-side lifecycles only; the server-side ones (checkout, payment, booking, ticketing) are
the OTA API's and are linked at the end.

```diagram
boot-states
```

```diagram
session-states
```

```diagram
price-hold-states
```

```diagram
checkout-steps
```

```diagram
pay-card-states
```

```diagram
airline-card-states
```

```diagram
complete-states
```

```diagram
confirmation-states
```

```diagram
cancel-dialog-states
```

```diagram
lookup-states
```

Server-side lifecycles the pages display:

```diagram
ota-api/checkout-states
```

```diagram
ota-api/payment-states
```

```diagram
ota-api/booking-states
```

## Integrations

| With | How | Contract |
|---|---|---|
| [[app:ota-api]] | Same-origin `/api/v1/*`, edge caller, cookie sessions | `repo:ota/backend/openapi/velexis-ota-booking-api.openapi.yaml` (working contract; generated route table `repo:ota/sdk/src/internal/operations.js`) |
| [[app:sdk]] | `@velexis/ota-sdk` (workspace), cookie mode, automatic refresh, `ifMatch`, idempotency keys, retries (off for the airline-card completion) | `repo:ota/sdk/src/index.js` |
| Caddy ([[app:deploy]]) | Serves `dist/`, `rewrite /p/* /p.html`, `try_files`, `handle_errors 404`, `/api/*` proxy with `X-Velexis-Edge` / `X-Velexis-Host`, the CSP and the `@pay_airline` headers | `repo:deploy/caddy/Caddyfile` |
| Stripe | Stripe.js v3 on `/checkout/pay-card.html` only: Payment Element, confirmation token, `confirmPayment`, 3-D Secure; PaymentIntents are created and captured by the OTA API | `repo:ota/docs/flows/checkout-stripe.md` |
| Amadeus | Never directly: the OTA API calls it (stub `repo:tools/amadeus-stub` locally) | `repo:ota/docs/flows/search-and-price.md` |
| Mailpit / SMTP | Never directly: e-mail links point at storefront paths (`/account/verify.html?token=…`, `/account/reset-password.html?token=…`, `/booking.html?id=…`) on the OTA's primary host | `repo:ota/backend/src/notifications/storefront-host.ts` |
| [[app:ota-admin]] | Indirect: settings, pages, assets and the airline-card switch change `storefront.get` | `repo:ota/docs/adr/0012-storefront-settings-assets-and-pages.md` |

## Security

- **No tokens in JavaScript** ([[cookie-mode]], OADR-0006). Sessions and guest tokens are httpOnly [[host-cookie]]s
  (`Secure; SameSite=Lax; Path=/`, no `Domain`) written only for the storefront edge; key callers never get cookies.
  Only `__Host-vx_csrf` is readable, copied by the SDK into `X-CSRF-Token`.
- **CSRF**: on every edge `POST`, `PUT`, `PATCH`, `DELETE` the API checks `X-CSRF-Token` = cookie (constant time) and
  `Origin = https://<X-Velexis-Host>` (`repo:ota/backend/src/common/auth/csrf.guard.ts`). The dev proxy sets `Origin` for
  the same reason. Verify and reset pages use `<meta name="referrer" content="strict-origin">`, not `no-referrer`,
  which would send `Origin: null`.
- **Edge credential**: Caddy drops any browser copy of `X-Velexis-Edge` / `X-Velexis-Host` and sets its own; the API
  trusts the host only with the secret ([[edge-caller]]).
- **CSP and headers** ([[content-security-policy]]): `default-src 'self'`, scripts from self and Stripe, `style-src 'self'`,
  `img-src 'self' data:`, `connect-src 'self' https://api.stripe.com`, `frame-ancestors 'none'`, `worker-src 'none'`.
  The build has no inline script or style; `test/csp.test.js` compares the preview copy with the Caddyfile.
- **No `innerHTML` with data**: ESLint `no-unsanitized` on every file (`test/lint.test.js`); templates are filled by
  `fill()`; content blocks built with `createElement`.
- **Redirects**: `next` must be a single-slash path, also after dot segments are resolved (`safeNext`).
- **Tokens in URLs**: verification, reset and Stripe return parameters are removed with `history.replaceState` before
  `boot()` runs.
- **Airline card** ([[isolated-payment-page]], OADR-0017): built on its own (`ISOLATED_PAGES` of `vite.config.js`),
  no third-party script, inputs without `name`, emptied after every answer, on `pagehide` and on back-forward restore;
  never stored, logged or put in a URL; COOP `same-origin` and `no-store` on that page only; the server wraps the card
  in a [[sensitive-card]]. The whole origin is in the PCI script inventory.
- **Rate limits** (server side, `repo:ota/backend/src/common/http/rate-limits.ts`): sign-in 10 a minute per IP; search,
  upsell and price 30 a minute per IP; sign-up, password reset and resend-verification e-mails 5 an hour per IP and 3 an
  hour per address; failed lookups 5 per 15 minutes per IP and per reference (the sixth answers `429`); payment
  creation and `checkout.complete` 10 a minute per IP; airline-card completions 5 a minute per IP and 60 an hour per
  tenant.

## Configuration

The storefront has **no runtime environment** in production; everything tenant-specific comes from `storefront.get`.
These variables are read only by `vite.config.js` (Node) for the dev server and `vite preview`
(`repo:ota/frontend/.env.example`; root `.env.local`, then `ota/frontend/.env.local`, then the real environment):

| Variable | Purpose |
|---|---|
| `OTA_API_URL` | Where the proxy forwards `/api/*` (`http://127.0.0.1:4000`), `/api` stripped |
| `VELEXIS_EDGE_SECRET` | Sent as `X-Velexis-Edge`; must equal the OTA backend's (development value only) |
| `STOREFRONT_BASE_DOMAIN` | Builds the default host `demo.<base>`; preview allows `.<base>` host names |
| `STOREFRONT_DEV_HOST` | The OTA the proxy names (`X-Velexis-Host` and `Origin`), default `demo.ota.example.com` |
| `STOREFRONT_DEV_PORT`, `STOREFRONT_PREVIEW_PORT` | 5173 and 4173 |

Server-side switches that change the storefront (OTA backend and tenant settings): `AIRLINE_CARD_ENABLED` (global
kill switch), `storefront_settings.airline_card_enabled_test` / `_live`, `guest_checkout_enabled`,
`customer_accounts_enabled`, `require_email_verification`, `features` (`ancillaries`, `brandedFareUpsell`,
`selfServiceCancellation`), `supported_currencies`, `offer_ttl_minutes`, `checkout_ttl_minutes`, `time_zone`, `theme`.

## Testing

| Level | Where | Run one |
|---|---|---|
| Unit (modules and pages with a fake SDK) | `repo:ota/frontend/test` | `pnpm --filter @velexis/ota-frontend exec vitest run test/lookup-page.test.js` |
| Boot and pages with partials | `repo:ota/frontend/test/boot.test.js`, `repo:ota/frontend/test/primary-host.test.js` | `pnpm --filter @velexis/ota-frontend exec vitest run test/boot.test.js` |
| Headers, lint, inventory, budgets | `test/csp.test.js`, `test/lint.test.js`, `test/payment-page-inventory.test.js`, `test/budgets.test.js` | `pnpm --filter @velexis/ota-frontend test` |
| End to end (Playwright + axe, production build in preview) | `repo:tools/e2e/specs/storefront` | `pnpm build && E2E_WITH_OTA=1 pnpm test:e2e -- --project=storefront specs/storefront/search.e2e.ts` |
| Stripe journeys (nightly) | `repo:tools/e2e/specs/storefront/checkout-stripe.e2e.ts` | project `storefront-stripe` (Stripe test keys and CLI) |
| Accessibility and performance | `repo:tools/e2e/specs/storefront/a11y-pages.e2e.ts`, `repo:tools/e2e/specs/storefront/a11y-phone.e2e.ts`, `repo:ota/frontend/scripts/lighthouse.mjs` | `pnpm --filter @velexis/ota-frontend lighthouse -- --page results --runs 3` against a running preview |

Every e2e journey fails on a CSP violation, a third-party request (except Stripe on the card page), a JS-readable
cookie other than `__Host-vx_csrf` (and Stripe's two on the card page) or a serious/critical axe finding
(`repo:tools/e2e/support/storefront-guards.ts`).

## Where to change things

| To change … | Look at |
|---|---|
| A UI text, a state message, plural forms | `repo:ota/frontend/src/lib/i18n.js` |
| What an API error code shows (state, Retry) | `repo:ota/frontend/src/lib/errors.js` and the page's `FINAL_STATES` |
| Start-up, test banner, full-page states, currency client | `repo:ota/frontend/src/boot.js`, `repo:ota/frontend/partials/states.html`, `repo:ota/frontend/partials/test-banner.html` |
| Configuration caching (5 minutes) | `repo:ota/frontend/src/lib/config.js`, `repo:ota/frontend/src/lib/config-cache.js` |
| Header, account menu, currency selector | `repo:ota/frontend/partials/header.html`, `repo:ota/frontend/src/components/header.js`, `repo:ota/frontend/src/lib/session.js` |
| Footer, legal links, content pages in the footer | `repo:ota/frontend/partials/footer.html`, `repo:ota/frontend/src/components/footer.js` |
| Search form, autocomplete, passenger and date checks | `repo:ota/frontend/partials/search-form.html`, `repo:ota/frontend/src/components/search-form.js`, `repo:ota/frontend/src/components/location-combobox.js`, `repo:ota/frontend/src/components/passenger-picker.js`, `repo:ota/frontend/src/components/date-range.js` |
| Results, filters, sort, offer cards | `repo:ota/frontend/src/pages/search.js`, `repo:ota/frontend/src/components/filters.js`, `repo:ota/frontend/src/components/sort.js`, `repo:ota/frontend/src/components/offer-card.js`, `repo:ota/frontend/partials/templates/offer-card.html` |
| Offer page and fare families | `repo:ota/frontend/src/pages/offer.js`, `repo:ota/frontend/src/components/fare-families.js` |
| Price page, breakdown, countdown | `repo:ota/frontend/src/pages/price.js`, `repo:ota/frontend/src/components/price-breakdown.js` |
| Checkout steps, traveller and contact forms, extras | `repo:ota/frontend/src/pages/checkout.js`, `repo:ota/frontend/src/components/stepper.js`, `repo:ota/frontend/src/components/traveller-form.js`, `repo:ota/frontend/src/components/contact-form.js`, `repo:ota/frontend/src/components/ancillary-picker.js` |
| Stripe card page | `repo:ota/frontend/src/pages/checkout-pay-card.js`, `repo:ota/frontend/checkout/pay-card.html` |
| Airline-card page, card checks | `repo:ota/frontend/src/pages/checkout-pay-airline.js`, `repo:ota/frontend/src/lib/card-brand.js`, `repo:ota/frontend/checkout/pay-airline.html` |
| Completion after Stripe | `repo:ota/frontend/src/pages/checkout-complete.js` |
| Confirmation and ticketing polling | `repo:ota/frontend/src/pages/confirmation.js` |
| My bookings tabs and cards | `repo:ota/frontend/src/pages/bookings.js`, `repo:ota/frontend/partials/templates/booking-row.html` |
| Booking page, contact change, cancel dialog, documents, history | `repo:ota/frontend/src/pages/booking.js`, `repo:ota/frontend/src/components/cancel-dialog.js`, `repo:ota/frontend/src/components/booking-timeline.js`, `repo:ota/frontend/partials/templates/document-row.html` |
| Guest lookup | `repo:ota/frontend/src/pages/lookup.js`, `repo:ota/frontend/lookup.html` |
| Sign-in, sign-up, verify, reset, account | `repo:ota/frontend/src/pages/account-sign-in.js`, `repo:ota/frontend/src/pages/account-sign-up.js`, `repo:ota/frontend/src/pages/account-verify.js`, `repo:ota/frontend/src/pages/account-reset-password.js`, `repo:ota/frontend/src/pages/account-index.js` |
| Primary-host redirect | `repo:ota/frontend/src/lib/primary-host.js` |
| Content pages and their blocks | `repo:ota/frontend/src/pages/p.js`, `repo:ota/frontend/src/lib/blocks.js`; server: `repo:ota/backend/src/storefront/markdown-subset.parser.ts` |
| Theme, colours, fonts, contrast | `repo:ota/frontend/src/lib/theme.js`, `repo:ota/frontend/src/styles/main.css`, `repo:ota/frontend/src/styles/fonts.css` |
| Money, dates, durations | `repo:ota/frontend/src/lib/format.js` |
| Dev/preview proxy, routing, headers | `repo:ota/frontend/scripts/vite-plugins.js`, `repo:ota/frontend/vite.config.js` (and `repo:deploy/caddy/Caddyfile` for production) |
| A new page | its HTML file, `src/pages/<name>.js`, a line in `PAGE_PURPOSES` of `repo:ota/frontend/scripts/payment-page-inventory.mjs` and the README §10 table |
| What `storefront.get` returns (features, payment config) | `repo:ota/backend/src/storefront/storefront.mapper.ts`, `repo:ota/backend/src/storefront/storefront.service.ts` |
| Host → tenant, environment | `repo:ota/backend/src/tenancy/tenant-resolver.ts` |
| Cookies and CSRF | `repo:ota/backend/src/common/http/cookie-writer.ts`, `repo:ota/backend/src/common/auth/csrf.guard.ts` |
| SDK call shapes, retries, refresh | `repo:ota/sdk/src/namespaces`, `repo:ota/sdk/src/internal/http.js`, `repo:ota/sdk/src/internal/session.js` |

## Further reading

- `repo:ota/frontend/README.md` — the component specification (hosting, page inventory, theming, a11y, budgets, security, tests).
- `repo:ota/frontend/docs/pages.md` and `repo:ota/frontend/docs/pages-account.md` — every page's SDK calls and states.
- `repo:ota/frontend/docs/build-your-own-frontend.md` — what differs for an OTA's own frontend (token mode).
- `repo:ota/docs/storefront-accessibility.md` — axe pass, Lighthouse figures, the pending screen-reader pass.
- Flows: `repo:ota/docs/flows/search-and-price.md`, `repo:ota/docs/flows/checkout-stripe.md`, `repo:ota/docs/flows/checkout-airline-card.md`, `repo:ota/docs/flows/my-bookings-and-guest-lookup.md`, `repo:ota/docs/flows/change-and-cancel.md`.
- ADRs: `repo:docs/mvp/adr/0018-hosted-storefront-custom-domains.md`, `repo:docs/mvp/adr/0011-payments-stripe-and-airline-card.md`, `repo:ota/docs/adr/0006-storefront-cookie-sessions-and-csrf.md`, `repo:ota/docs/adr/0009-caller-and-tenant-resolution.md`, `repo:ota/docs/adr/0012-storefront-settings-assets-and-pages.md`, `repo:ota/docs/adr/0015-storefront-build-urls-and-hosting.md`, `repo:ota/docs/adr/0017-airline-card-form-isolation.md`.
- Journeys: [[journey:book-with-stripe]], [[journey:book-with-airline-card]], [[journey:my-bookings-change-and-cancel]], [[journey:custom-domain-and-go-live]].
