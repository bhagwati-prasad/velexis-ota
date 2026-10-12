# ADR-0014: Frontend stack: Next.js and Tailwind

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (Next.js 15 App Router + TypeScript + Tailwind for portal, platform admin and OTA admin; vanilla HTML + Tailwind + vanilla JS for the storefront), lead architect (libraries and patterns)

## Context

[`decisions.md`](../decisions.md) §1–§2 fix the front-end technologies:

- **Next.js 15 App Router, TypeScript and Tailwind** for the platform frontend (portal), the platform admin and the OTA admin. The OTA admin uses the JS SDK for booking and console functions.
- **Vanilla HTML + Tailwind CSS + vanilla JS** for the hosted storefront, with all booking functions through the SDK.
- No token readable by browser JavaScript ([ADR-0008](0008-identity-accounts-customers-sessions.md)).

The Next.js example in [`docs/velexis-sdk/examples/next-storefront/`](../../velexis-sdk/examples/next-storefront/) shows the server-side SDK patterns (server components, server actions, proxy and auth routes). The `@velexis/ota-sdk/next` and `/react` helpers are post-MVP references.

## Decision

### Next.js apps (portal, platform admin, OTA admin)

- **Next.js 15 App Router, React 19, TypeScript strict.** `output: "standalone"` for deployment ([ADR-0007](0007-single-vm-without-docker.md)).
- **Tailwind CSS 4** (CSS-first configuration with `@theme`, `@tailwindcss/postcss`) and **shadcn/ui** components (Radix primitives), copied into each app by the shadcn CLI under `src/components/ui/`.
  - There is no shared UI package in the MVP. The three apps share design tokens only, as a CSS file copied by the shadcn setup.
  - Revisit when the copies diverge painfully.
- Icons: `lucide-react`. Tables: shadcn data table on TanStack Table. Charts: none in the MVP.
- **Server-first:**
  - pages are **React Server Components** that fetch on the server;
  - mutations are **Server Actions** that return a serialisable state for `useActionState`;
  - client components are leaves for interactivity only.
- **Backend-for-frontend:**
  - API calls happen only in server code (`import "server-only"` in the API client modules);
  - tokens live in httpOnly cookies set by the app's server ([ADR-0008](0008-identity-accounts-customers-sessions.md));
  - no `NEXT_PUBLIC_` variable ever holds a secret, key or token.
- **API clients:**
  - Portal and platform admin: `openapi-fetch` typed by `@velexis/api-types/platform`.
  - OTA admin: `@velexis/ota-sdk` on the server, with the first-party service credential and the staff token from cookies. This follows the server patterns of the Next.js example, re-implemented without the post-MVP `@velexis/ota-sdk/next` helper.
- **Forms:**
  - native `<form action={serverAction}>`;
  - validation with **Zod** on the server (the same schema may run on the client for instant feedback);
  - errors mapped from the API's `fieldErrors`.
  - This is the only place Zod is used ([ADR-0006](0006-contract-first-openapi.md)).
- **Middleware** refreshes expired access tokens and redirects unauthenticated users. Platform admin routes also require `is_platform_admin` and a completed MFA step.
- Security headers through `next.config` `headers()`: CSP with nonces for Next's scripts, `frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`.
- English only in the MVP. Strings are kept in one module per app, so translation can come later.

### Hosted storefront (`ota/frontend`)

- **No framework.** Static HTML pages plus ES modules, built by **Vite 6** as a multi-page app, styled with **Tailwind CSS 4** (`@tailwindcss/vite`).
- Every booking function goes through `@velexis/ota-sdk` in **cookie mode** against the same-origin `/api` ([ADR-0019](0019-vanilla-js-sdk-jsdoc.md)).
- **Progressive enhancement:**
  - real `<form method="get">` search forms and links work without JavaScript;
  - JavaScript renders results, handles checkout steps and shows errors;
  - pages that cannot work without the API show a `<noscript>` message.
- Branding (logo, colours, fonts) comes from `storefront.get` at runtime and is applied as CSS custom properties. The same build serves every OTA.
- No inline scripts or styles (CSP), and no third-party scripts except Stripe.js on payment pages ([ADR-0011](0011-payments-stripe-and-airline-card.md), [ADR-0018](0018-hosted-storefront-custom-domains.md)).
- Accessibility target: WCAG 2.2 AA for the booking flow (labels, focus order, error summaries, keyboard-only checkout), checked with Playwright and axe ([ADR-0015](0015-testing-strategy.md)).

## Consequences

### Positive

- One pattern (server components + server actions + BFF cookies) across three apps. Agents learn it once.
- No secrets in client bundles by construction.
- The storefront is a set of static files, cacheable and cheap to serve for every OTA.

### Negative

- shadcn/ui copies per app mean fixes are applied three times. This is accepted to avoid a shared UI package in the MVP.
- Server-only API calls add one hop (browser → Next.js → API), which is acceptable at MVP scale.
- The vanilla storefront needs more hand-written DOM code than a framework would. Small shared modules (`dom.js`, `format.js`, `forms.js`) keep it manageable ([`../conventions.md`](../conventions.md)).

### Follow-ups

- Decided during planning; revisit a shared `packages/ui` when the three admin apps share more than about ten customised components.

## Alternatives considered

- **SPA (React + Vite) for the admin apps.** Tokens would have to be handled in browser JS, or a separate BFF would be needed.
- **A component framework (Alpine, Lit) for the storefront.** Rejected by the product owner: vanilla JS.
- **CSS modules or styled-components.** Tailwind was chosen by the product owner.

## References

- [`../decisions.md`](../decisions.md) §1, §2, §5
- [`../../velexis-sdk/examples/next-storefront/`](../../velexis-sdk/examples/next-storefront/), [`../../velexis-sdk/sdk/docs/nextjs.md`](../../velexis-sdk/sdk/docs/nextjs.md)
- [ADR-0008](0008-identity-accounts-customers-sessions.md), [ADR-0018](0018-hosted-storefront-custom-domains.md), [ADR-0019](0019-vanilla-js-sdk-jsdoc.md)
- [`../tech-stack.md`](../tech-stack.md), [`../conventions.md`](../conventions.md)
