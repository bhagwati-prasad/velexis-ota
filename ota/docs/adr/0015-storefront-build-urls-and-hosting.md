# OADR-0015: Storefront build, URLs and hosting

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA frontend and SDK tech lead. Decided during planning; revisit when search engines must index results or content pages without running JavaScript (prerendering or server rendering), when a second UI language is added, or when the hosted storefront needs a framework.

## Context

[`decisions.md`](../../../docs/mvp/decisions.md) §2 and [ADR-0014](../../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md) fix the storefront technology: plain HTML pages, Tailwind CSS 4 and vanilla ES modules, built by Vite 6 as a multi-page app, every booking function through the SDK in cookie mode. [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md) fixes the hosting: one static build for every OTA, served by Caddy on `<key>.ota.example.com` and verified custom domains, same-origin `/api/*`, a strict CSP (`script-src 'self'` plus Stripe, `style-src 'self'`, `img-src 'self' data:`, `font-src 'self'`). The [Caddyfile](../../../deploy/caddy/Caddyfile) serves files with `try_files {path} {path}.html {path}/index.html` and `/404.html` for unknown paths. [OADR-0012](0012-storefront-settings-assets-and-pages.md) adds content pages linked as `/p/<slug>`, same-origin image assets and "fonts from the bundled list".

Still open: the URL scheme and how dynamic values (search, offer, checkout, booking ids) travel; how shared markup is reused without a framework or a template engine; how runtime configuration is cached; how fonts and airline logos fit the CSP; how the dev server and tests reproduce Caddy; and how the payment pages are split.

## Decision

1. **One build for every tenant.** `vite build` with `appType: "mpa"` and every HTML file as an input produces `dist/`. There are no build-time variables (nothing prefixed `VITE_`), no per-tenant builds and no runtime environment; everything tenant-specific comes from `storefront.get`.
2. **CSP-clean output.** No inline scripts or styles: `build.modulePreload.polyfill = false` (evergreen browsers support module preload) and `build.assetsInlineLimit = 0` (no `data:` fonts or scripts). Branding is applied with `style.setProperty` on CSS custom properties, which `style-src 'self'` allows ([OADR-0012](0012-storefront-settings-assets-and-pages.md)). Tailwind 4 maps its theme tokens to those properties with `@theme inline`.
3. **URLs are file paths.** Pages are addressed by their `.html` path (`/search.html`, `/booking.html`, `/account/sign-in.html`, `/` for `index.html`), and dynamic values travel in the query string (`?search=srch_…`, `?offer=off_…`, `?priced=prc_…`, `?id=chk_…`, `?id=bkg_…`). This works unchanged with Caddy's existing `try_files`, the Vite dev server, `vite preview` and any static host, with no client-side router. Pages that run a search write the resulting id into the URL with `history.replaceState`, so reload and Back never repeat an Amadeus call.
4. **One rewrite: content pages.** `/p/<slug>` is served by `p.html`, which reads the slug from `location.pathname`. Caddy gets one line in the storefront `handle` block (`rewrite /p/* /p.html`, see Follow-ups); the dev server and `vite preview` get the same rewrite from a small local Vite plugin, which also sends unknown paths to `404.html` like Caddy.
5. **Fixed e-mail link targets.** The backend's templates link to `/account/verify.html?token=…`, `/account/reset-password.html?token=…` and `/booking.html?id=bkg_…` on the tenant's primary storefront host. Changing one of these paths needs a backend change in the same PR.
6. **Shared markup at build time.** Header, footer, banners and repeated items (offer card, segment, traveller form) are HTML partials and `<template>` elements in `partials/`, included by a 20-line local Vite plugin (`<!-- @include partials/… -->` in `transformIndexHtml`). Pages clone templates and fill them with `textContent`. No template engine or component library is added.
7. **Runtime configuration cache.** Each page calls `storefront.get` once and keeps the answer in `sessionStorage` for 5 minutes (per origin, so tenants never mix), wrapped in `try/catch` so the page works without storage. Settings changes reach travellers within about 5 minutes, matching the backend cache ([OADR-0012](0012-storefront-settings-assets-and-pages.md) §7).
8. **Fonts and images under the CSP.** The selectable fonts are woff2 files with open licences in `public/fonts/`, declared in `styles/fonts.css`; the list of names is an enum in the OpenAPI `StorefrontSettings` schema, so the admin, the backend validation and the storefront share one list (a unit test checks that `fonts.css` declares every enum value). Airline logos are **not** shown in the MVP: external images would break `img-src 'self'`, so results show the airline name and IATA code.
9. **Payment pages are separate entries.** `/checkout.html` (data steps) loads no third-party script; `/checkout/pay-card.html` is the only page with Stripe.js (a static tag in its HTML); `/checkout/pay-airline.html` has no third-party script at all ([OADR-0017](0017-airline-card-form-isolation.md)); `/checkout/complete.html` finishes the Stripe path without Stripe.js. Each has its own entry bundle, so the payment-page script inventory of [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §C is short and stable.
10. **The dev server behaves like Caddy for one tenant.** Vite proxies `/api` to the OTA API, strips `/api`, and sets `X-Velexis-Edge` (development secret), `X-Velexis-Host` (`demo.ota.example.com` by default) and `Origin: https://<that host>`, because the CSRF guard compares `Origin` with the verified host ([OADR-0006](0006-storefront-cookie-sessions-and-csrf.md)). The variables are listed in [`ota/frontend/.env.example`](../../frontend/.env.example).
11. **Tests run the production build with production headers.** Playwright journeys run against `vite preview` (same proxy), which sends the CSP copied from the Caddyfile; a unit test fails when the two CSP strings differ. Every journey fails on a CSP violation.
12. **Budgets in CI.** `scripts/check-budgets.mjs` checks gzip sizes of `dist/`: at most 60 KB of JavaScript per page (30 KB on the airline-card page), 20 KB of CSS, 20 KB of HTML per page.

## Consequences

### Positive

- One artefact serves every OTA and every custom domain; deploys are a file copy.
- URLs need no router and no server logic; Caddy's existing rules serve all pages except content pages.
- The CSP stays strict without exceptions, and the payment pages have small, known script sets.
- Developers and tests see the same headers and rewrites as production.

### Negative

- `.html` URLs and query-string ids are less pretty than clean paths; they are acceptable for a booking flow and keep the hosting trivial.
- Content is rendered by JavaScript after `storefront.get`, so crawlers that do not run JavaScript see only the static shell (search engines that render JavaScript index it).
- The `Origin` rewrite in the dev proxy means local development does not exercise a real cross-origin CSRF attempt; integration tests in the backend cover that.
- No airline logos until a same-origin logo set is bundled.

### Follow-ups

- **Deploy (Caddyfile):** add `rewrite /p/* /p.html` inside the storefront `handle` block, before `try_files`.
- **OTA API task:** make the font names an enum in `StorefrontSettings.branding.fonts` and use the same paths for e-mail links (point 5).
- Bundle a same-origin sprite of airline logos (open data) after launch if OTAs ask for logos.

## Alternatives considered

- **Clean URLs (`/search`, `/booking/bkg_…`) with a client router.** Needs a catch-all rewrite to one HTML file, a router module and per-path 404 handling; more code for no booking benefit.
- **Per-tenant builds with baked-in branding.** Rejected by ADR-0018: slower deploys, more disk, no gain.
- **A template engine (Handlebars, EJS) or web components for shared markup.** A dependency or a framework-like layer for what static partials and `<template>` do.
- **Airline logos from a CDN.** Breaks `img-src 'self'` and adds a third party to every results page.
- **Running E2E against the dev server.** The dev server injects HMR code and sends no CSP, so CSP regressions would only appear in production.

## References

- [`decisions.md`](../../../docs/mvp/decisions.md) §2, §4, §5; [ADR-0014](../../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md), [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md)
- [OADR-0006](0006-storefront-cookie-sessions-and-csrf.md), [OADR-0012](0012-storefront-settings-assets-and-pages.md), [OADR-0017](0017-airline-card-form-isolation.md)
- [`../../frontend/README.md`](../../frontend/README.md), [`../../frontend/docs/pages.md`](../../frontend/docs/pages.md), [`deploy/caddy/Caddyfile`](../../../deploy/caddy/Caddyfile)
