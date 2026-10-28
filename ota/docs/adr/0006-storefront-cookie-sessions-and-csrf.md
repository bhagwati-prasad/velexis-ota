# OADR-0006: Storefront cookie sessions and CSRF

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** OTA backend tech lead. Decided during planning; revisit when a custom domain becomes primary and sessions must follow the redirect (ADR-0018 follow-up), or when the storefront moves to a framework with server rendering.
**Revisions:** 2026-10-27 (lead decision (3), accepted as built): point 3 records that a visitor without a session gets `401` before the CSRF check on an operation that needs a customer (dated note).

## Context

[`decisions.md`](../../../docs/mvp/decisions.md) §5 and [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) require the hosted storefront to call the OTA API same-origin with httpOnly cookie sessions and a CSRF token, so no token is readable by JavaScript. ADR-0008 fixes the cookie names `__Host-vx_at` and `__Host-vx_rt`, a double-submit `__Host-vx_csrf` cookie issued by the first `storefront.get`, an `Origin` check, and the rule that token fields are left out of the JSON body. [ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md) adds the SDK's cookie mode. Open points: cookie lifetimes, guest booking tokens, the response schemas (the contract's `AuthSessionResult.session` requires the tokens), when CSRF is checked, and how refresh works.

## Decision

1. **Edge mode** is the mode of requests that the `CallerGuard` recognises as coming from Caddy (valid `X-Velexis-Edge`). Cookies are read and written **only** in edge mode; key and bearer callers never get `Set-Cookie`, and cookies sent to `api.ota.example.com` are ignored.
2. **Cookies** (all `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`):

   | Cookie | HttpOnly | Lifetime | Rotation |
   |---|---|---|---|
   | `__Host-vx_at` | yes | 15 min | Every refresh |
   | `__Host-vx_rt` | yes | Remaining family lifetime (12 h; 30 days with `rememberMe`) | Every refresh (reuse revokes the family) |
   | `__Host-vx_csrf` | no | 30 days | On sign-in, sign-up session, sign-out, password change |
   | `__Host-vx_bt` | yes | 30 days | Updated on guest booking and lookup |

   `SameSite=Lax` (not `Strict`) so that links from e-mails to the booking page carry the session.
3. **CSRF check** (`CsrfGuard`) on every edge `POST`, `PUT`, `PATCH`, `DELETE`, including anonymous ones (search, checkout, lookup): `X-CSRF-Token` must equal the `__Host-vx_csrf` cookie (constant-time) **and** `Origin` (or, when absent, `Sec-Fetch-Site: same-origin`) must match `https://<X-Velexis-Host>`. Failure: `403 CSRF_TOKEN_INVALID`. GET and HEAD never change state. The CSRF value is random, not tied to the session, and is not a credential. **2026-10-27 (lead decision (3), accepted as built):** the customer guard runs before `CsrfGuard`, so a visitor without a session on a state-changing operation that needs a customer (`account.update`, `account.delete`) gets `401 UNAUTHENTICATED` before the CSRF check; an anonymous write that needs no customer (search, checkout, sign-in, sign-up, lookup) is checked as above (`test/integration/m3/csrf-matrix.int.test.ts`).
4. **Response bodies in edge mode** never contain tokens:
   - `signIn`, `refreshSession`, `changePassword` return `AuthSessionInfo` (the schema of `auth.getSession`) instead of `AuthSessionResult`; the OpenAPI response becomes `oneOf` of the two. This is a type change that [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md) allows only with an ADR: **this ADR approves it**, because no external client exists before launch and token-mode callers keep receiving `AuthSessionResult` unchanged.
   - `signUp` and `resetPassword` return `session: null` (already nullable).
   - `checkout.complete`, the airline-card completion and `bookings.lookup` return `bookingToken: null` (`BookingLookupResult.bookingToken` becomes nullable, approved here as well).
5. **Refresh.** `auth.refresh` in edge mode reads `__Host-vx_rt`; a refresh token in the body is refused. The SDK in cookie mode calls it once on `401 TOKEN_EXPIRED` and retries the original call; concurrent requests share one refresh promise in the SDK.
6. **Guest tokens.** `__Host-vx_bt` holds up to five `bkg_<id>.<token>` entries separated by `~`, newest first; the backend picks the entry of the requested booking. One cookie keeps the number of cookies bounded and lets the backend replace the list atomically.
7. **Host-only sessions.** Sessions do not cross hosts (`acme.ota.example.com` vs `travel.acme.com`), which ADR-0018 accepts; the primary-domain redirect follow-up reduces it.
8. **Development.** Browsers treat `http://localhost` as a secure context, so `__Host-` cookies work with the Vite dev server, which adds the edge headers like Caddy ([`local-development.md`](../../../docs/mvp/local-development.md)).
9. **Tests** assert, for every auth and booking-access operation, that edge responses contain no token in the body, that cookies carry the attributes above, and that bearer mode is unchanged.

## Consequences

### Positive

- No access, refresh or guest token is ever readable by storefront JavaScript, including third-party code that might be injected.
- Anonymous POSTs (search, checkout) are CSRF-protected from the first call.
- Token-mode clients of the contract see no change.

### Negative

- Two response shapes for three operations; SDK and tests must cover both.
- `__Host-` requires `Path=/`, so the refresh cookie is sent with every storefront API request (it is httpOnly and same-site, but it travels more than strictly needed).
- A traveller who clears cookies loses guest access and must use the lookup.

### Follow-ups

- When a custom domain becomes primary (M5), redirect the sub-domain before sign-in so sessions are created on the primary host.

## Alternatives considered

- **Server-side sessions with an opaque session cookie.** One store read per request and a second session model next to the contract's tokens.
- **`SameSite=Strict`.** Breaks e-mail links into the booking pages.
- **Synchroniser-token CSRF stored in the session.** Needs server state for anonymous visitors; double-submit plus Origin is enough when tokens live in httpOnly cookies.
- **`Path=/api/v1/auth` on a `__Secure-` refresh cookie.** Narrower, but breaks the `__Host-` rule of the conventions.

## References

- [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0018](../../../docs/mvp/adr/0018-hosted-storefront-custom-domains.md), [ADR-0019](../../../docs/mvp/adr/0019-vanilla-js-sdk-jsdoc.md), [ADR-0006](../../../docs/mvp/adr/0006-contract-first-openapi.md)
- [`../api-changes.md`](../api-changes.md) §2, [`../flows/my-bookings-and-guest-lookup.md`](../flows/my-bookings-and-guest-lookup.md)
- [`conventions.md` §12](../../../docs/mvp/conventions.md#12-security-checklist-every-pr) (cookie and CSRF checklist)
