# OADR-0018: The OTA admin consumes the SDK on the server

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA frontend and SDK tech lead. Decided during planning; revisit when the OTA admin runs as more than one process, when the post-MVP `@velexis/ota-sdk/next` helpers ship, or when an OTA asks for a tenant-wide audit view or staff-assisted bookings.

## Context

[`decisions.md`](../../../docs/mvp/decisions.md) §1 says the OTA admin (Next.js 15) does its booking and console work through the JS SDK. [ADR-0014](../../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md) makes it a backend-for-frontend:

- server components read;
- server actions mutate;
- tokens live in httpOnly cookies set by the server;
- the SDK runs on the server with the first-party service credential, re-implementing what the post-MVP `@velexis/ota-sdk/next` helper would do.

[ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md) and [OADR-0011](0011-console-access-staff-sessions-and-environments.md) define the session:

- SSO by portal token;
- 15-minute staff access tokens and rotating refresh tokens in 12-hour Redis families, where **reusing a rotated refresh token revokes the family**;
- the service key accepted only from `127.0.0.1`, only on console operations, only with a staff token of the tenant;
- `X-Velexis-Environment` chosen per request.

Next.js adds constraints. Server components cannot set cookies. One browser can trigger several server requests at the same moment (navigation, prefetches, parallel server actions). Middleware runs on every request.

Open points:

- where tokens are refreshed;
- how parallel requests avoid reusing a rotated refresh token;
- how permissions reach the UI;
- how staff shop for a caller, given the service key cannot call customer-scope operations;
- what the admin does with airline-card bookings left without tickets;
- the staff-actions audit page, which has no list operation in the API.

## Decision

1. **One way to the API.** All OTA API access goes through `@velexis/ota-sdk` (`console` namespace) in `server-only` modules (`lib/velexis.ts`, `lib/session.ts`). No `fetch` to the OTA API anywhere else, no SDK import in client components. A client is created per request (React `cache`) in server mode: `secretKey` = `OTA_ADMIN_SERVICE_KEY`, `baseUrl` = `OTA_API_URL` (loopback), the staff `accessToken`, `sessionKind: "staff"`, and `environment` from the session.
2. **Cookies.** `__Host-vx_staff_at` (access, 15 min), `__Host-vx_staff_rt` (refresh, remaining family lifetime), `__Host-vx_env` (`test` or `live`) and `__Host-vx_tenant` (tenant id for the redirect back to the portal). All are `HttpOnly; Secure; SameSite=Lax; Path=/`. `Lax` because the session starts with a cross-site POST from the portal. `POST /sso` and `POST /auth/sign-out` check `Origin` (`PUBLIC_PORTAL_URL` for `/sso`); server actions rely on Next.js's Origin check.
3. **Refresh only where cookies can be written, and once per token.**
   - Middleware (Node.js runtime) refreshes when the access token expires within 60 s.
   - Route handlers (`/auth/refresh?next=…`) and server actions may refresh too, with `onStaffSessionRefreshed` writing the cookies.
   - Server components never pass a refresh token to the SDK: on `TOKEN_EXPIRED` they redirect to `/auth/refresh`.
   - Every refresh goes through one function that **de-duplicates per refresh token**: an in-process map from `sha256(refreshToken)` to the refresh promise and its result, kept 30 s, so parallel requests carrying the same old token all receive the same new tokens and the backend never sees the token twice.
   - This relies on the admin running as **one Node.js process** on the single VM ([ADR-0007](../../../docs/mvp/adr/0007-single-vm-without-docker.md)).
4. **Permissions in the UI.**
   - `console.auth.me` is called once per request (React `cache`), and its `permissions` drive navigation and buttons.
   - Every server action begins with `requireStaff(permission)` for a clear early error.
   - The API remains the authority (`403 FORBIDDEN`) and writes `staff_actions` for every call.
5. **Writes carry concurrency and idempotency data from the page.**
   - Updates send `ifMatch` = the `version` the page displayed.
   - Every state-changing dialog renders a fresh idempotency key in a hidden input, so a double click or a resubmitted form replays the same action instead of issuing or refunding twice.
6. **Environment switch.** A server action sets `__Host-vx_env` only to a value in `session.environments`; live mode changes the shell colour and the confirmation texts.
7. **Shopping on behalf uses read-only raw calls.** `/shopping` uses `console.amadeus.searchFlightOffers`, `searchFlightAvailabilities`, `upsellAirOffers` and `quoteAirOffers` (`amadeus:read`, net prices). The admin never calls customer-scope operations (`flights.*`), which the service key cannot use. Booking on behalf waits for `console.bookings.create` (deferred in [scope §3.4](../scope.md#34-b4-console-32-27-mvp-5-deferred)).
8. **No card numbers in the admin.** The admin never renders a credit-card form of payment. It offers no `creditCard` entry in `console.bookings.issue` or `patch`. An airline-card booking that came back without tickets (the card cannot be charged again, [OADR-0004](0004-airline-card-data-handling.md)) is issued with an `other` form of payment (`CASH` or `ACCOUNT`: the OTA's own settlement with the airline) or cancelled. This keeps card data on the single storefront route that ADR-0011's controls cover.
9. **Audit.** M4 shows each booking's `recentStaffActions` in its detail page. A tenant-wide `/audit` page is later: it needs a new console list operation.
10. **Tests through the SDK's `fetch` option.** Server-action and session tests inject a fake `fetch` into the real SDK, so they check the exact requests (method, path, `If-Match`, idempotency key reuse, environment header) without a running backend.

## Consequences

### Positive

- The admin cannot leak a token or a service key to the browser by construction, and it exercises the same SDK that third-party consoles use.
- Parallel requests no longer risk the "refresh token reused" family revocation that would sign staff out at random.
- Double submissions of issue, cancel, capture and refund are harmless.
- PCI scope does not grow into the back office.

### Negative

- Refresh de-duplication is in process memory; a second admin process (or a restart during a refresh) can still cause an occasional sign-out. Staff then re-enter through the portal.
- `console.auth.me` adds one loopback call per page render.
- Staff cannot take bookings for callers in the MVP, and cannot pay an airline-card booking by another card from the admin.
- No tenant-wide audit screen in the MVP.

### Follow-ups

- **OTA API task:** refuse `creditCard` in `formOfPayments` of `console.bookings.issue` and `console.bookings.patch` in the MVP (`403 FEATURE_DISABLED`, `details.feature = "consoleCardPayment"`), so no custom console can route card numbers through the console either. This is consistent with ADR-0011's single card path.
- **When an OTA owner asks for a tenant-wide audit view:** add `console.staffActions.list` spec-first (`GET /v1/console/staff-actions`, filters actor, action, target, outcome, time; permission owner and admin) and the `/audit` route.
- **When the admin runs more than one process:** move refresh de-duplication to Redis (short lock per token hash) or ask the backend for a short reuse grace window.

## Alternatives considered

- **Refresh inside server components through the SDK's automatic refresh.** The rotated tokens could not be written back (server components cannot set cookies), so the next request would reuse the old token and revoke the family.
- **A client-side SPA with a token in memory.** Tokens in browser JavaScript, rejected by ADR-0008 and ADR-0014.
- **Calling the OTA API with `fetch` or `openapi-fetch` in the admin.** Two clients for one API, and the SDK would lose its first and most demanding consumer.
- **Using `flights.*` with the staff token for shopping, as the contract's guides suggest.** The OTA admin's service key is console-only ([OADR-0011](0011-console-access-staff-sessions-and-environments.md)); a second key with customer scope for the admin would widen what a leaked admin credential can do.
- **Typing a replacement card into the admin for airline-card bookings.** It would create a second cardholder-data path (staff browsers, the admin server) outside the controls of ADR-0011.

## References

- [`decisions.md`](../../../docs/mvp/decisions.md) §1, §5; [ADR-0007](../../../docs/mvp/adr/0007-single-vm-without-docker.md), [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md), [ADR-0014](../../../docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md), [ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md)
- [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md), [OADR-0004](0004-airline-card-data-handling.md), [OADR-0011](0011-console-access-staff-sessions-and-environments.md), [OADR-0016](0016-sdk-packaging-and-type-contract.md)
- [`../../admin/README.md`](../../admin/README.md), [`../../admin/docs/routes.md`](../../admin/docs/routes.md), [`../flows/console-operations.md`](../flows/console-operations.md), [SDK guide B4](../../../docs/velexis-sdk/sdk/docs/B4.md)
