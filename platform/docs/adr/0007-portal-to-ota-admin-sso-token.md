# PADR-0007: Portal to OTA admin SSO token

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit when the OTA admin needs sign-in without the portal (third-party identity providers), or when the portal and OTA admin move to separate machines.
**Revisions:** 2026-10-23 (lead decision, recorded with PBE-039): point 4's hand-off page sends `Referrer-Policy: strict-origin` instead of `no-referrer`. With `no-referrer` browsers send `Origin: null` on the page's cross-origin form POST, which the OTA admin's `POST /sso` refuses under [OADR-0018](../../../ota/docs/adr/0018-ota-admin-consumes-the-sdk-server-side.md) point 2 (it accepts only `Origin` = `PUBLIC_PORTAL_URL`), so the hand-off could never succeed; `strict-origin` sends the portal's origin (no path, no query, and nothing over a downgrade to `http`), which keeps the token out of every `Referer` because it is never in a URL. The Consequences and the Alternatives follow.

## Context

[ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) fixes the SSO mechanism: the portal asks the platform API for a one-time token `ptk_…` (256-bit), stored as `SET ptk:<sha256> {accountId, tenantId, membershipId} EX 60 NX`; the portal auto-submits a POST form to `https://admin.ota.example.com/sso`; the OTA backend redeems it with `GETDEL` in `console.auth.signIn` (`grantType = portal_token`, pattern `^ptk_[A-Za-z0-9]{24,64}$` in the OTA contract) and issues a tenant-bound staff session kept in Redis. "Sign out everywhere" must reach those staff sessions, but the OTA backend never writes platform tables and the platform cannot list OTA session families. Open points: the token's exact content, preconditions, how the portal page is built, and how revocation crosses the boundary.

## Decision

1. **Token.** `ptk_` + 43 base62 characters from the CSPRNG (≥ 256 bits), within the contract's pattern. Only `sha256(token)` (hex) is used as the Redis key. The value is JSON `{v: 1, accountId, tenantId, membershipId, role, mfa, issuedAt, requestId}`; `mfa` tells the OTA backend whether the account has MFA enabled, `role` is informative (the OTA backend re-reads the membership anyway). TTL 60 s, `NX`.
2. **Preconditions** checked by `createConsoleToken`: account `active` with a verified e-mail; membership `active` in that tenant; tenant `active` (`TENANT_NOT_ACTIVE` otherwise, with the status so the portal can explain); MFA policy of [PADR-0008](0008-email-verification-and-mfa-policy.md) (live tenants require MFA). Rate limit 30 per account per minute.
3. **Issue is audited** (`console.token_issued`, target the membership); the token itself never appears in logs, audit rows, URLs or the database.
4. **Hand-off page.** "Open console" is a POST form to the portal route handler `/otas/{tenantId}/console/launch` (Origin checked), never a link, so prefetch or crawlers cannot mint tokens. The handler returns a minimal HTML page with a form posting `portalToken` to `https://admin.ota.example.com/sso`, auto-submitted by a nonce script, with a visible button as fallback. Headers: `Cache-Control: no-store`, `Referrer-Policy: strict-origin`, `Content-Security-Policy` with `form-action https://admin.ota.example.com` and the script nonce.
   - *Note (2026-10-23, lead decision).* `strict-origin`, not `no-referrer`: the referrer policy also decides the `Origin` header of a cross-origin form POST, and under `no-referrer` browsers send `Origin: null`, which the OTA admin's `/sso` refuses (OADR-0018 point 2, its login-CSRF defence). `strict-origin` sends only the portal's origin, `https://platform.example.com`, as `Origin` and `Referer`; the launch URL's path (`/otas/{tenantId}/console/launch`) and any query stay behind, and the token, which travels only in the form body, is in neither header. The portal's other token pages (e-mail verification, password reset, invitations) keep `no-referrer`: they post no form at all (under `no-referrer` a form POST carries `Origin: null` even to the page's own origin), and the pages they lead to, which carry no token, keep the portal's default policy.
5. **Return path.** The OTA admin sends users without a session to `https://platform.example.com/console?tenant=<tenantId>`, a portal page listing the user's OTAs with "Open console" buttons.
6. **Cross-boundary revocation.** The platform writes `staffdeny:acct:<accountId> = <epoch ms>` with a 30-day TTL (the OTA plan must keep the absolute lifetime of staff refresh families at or below 30 days) on: sign out everywhere, password change, password reset, MFA reset by support, account disabled. The OTA staff guard and refresh refuse any staff family of that account created before the value. This refines the `staffdeny:<familyId>` key of [`docs/mvp/architecture.md`](../../../docs/mvp/architecture.md#redis-keys-shared-between-the-backends), which the platform cannot write because it does not know the family ids. Membership changes are covered by the `membership` invalidation and the OTA guard's membership check.
7. **No platform table** for portal tokens: a table could not record consumption (the OTA backend cannot write it), and Redis already gives single use and expiry.

## Consequences

### Positive

- SSO needs no shared cookie domain and no write from the OTA backend to the platform.
- A token is useful for 60 seconds, once, and only through a POST body; prefetching and referrers cannot leak it (the hand-off page's `strict-origin` sends the portal's origin only, never a path, a query or the body).
- "Sign out everywhere" really signs the person out of every OTA admin session, using one key per account.

### Negative

- Redis loss drops pending tokens (users click again) and deny markers (a revoked staff session could survive until its next refresh against a freshly reset Redis; acceptable given staff refresh families also live in the same Redis and would be lost too).
- The hand-off page needs a small inline script with a nonce; the portal's CSP must allow it there.
- The OTA admin learns that a sign-in came from the portal's origin (point 4, `strict-origin`), which it needs for its Origin check anyway; it never learns which OTA page or which portal page the person came from.
- The OTA backend must implement the `staffdeny:acct:*` check; this is a new item for the OTA plan.

### Follow-ups

- OTA plan: check `staffdeny:acct:<accountId>` in the staff guard and on refresh (M4).
- Consider showing "signed in to console" sessions in the portal when the OTA backend can report them through `platform-tenant-events`.

## Alternatives considered

- **Token in a URL query** (`/sso?token=…`). Leaks through history, logs and `Referer`; rejected in ADR-0008.
- **OIDC with the platform as identity provider.** Standard, but a full authorisation server for one relying party is heavy for the MVP.
- **Shared parent-domain cookie.** Would expose portal sessions to every storefront sub-domain (ADR-0008).
- **`Referrer-Policy: no-referrer` on the hand-off page** (point 4 until 2026-10-23). Browsers then send `Origin: null` on the form POST, and the OTA admin's `/sso` must refuse a null origin to keep its login-CSRF defence (OADR-0018 point 2), so no hand-off would succeed. Accepting `null` instead would let any sandboxed or `data:` page post a token of the attacker's into a victim's browser.

## References

- [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md)
- OTA contract `consoleSignIn`, `ConsolePortalTokenSignIn` in [`velexis-ota-booking-api.openapi.yaml`](../../../docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml)
- [`../flows/team-and-ota-admin-sso.md`](../flows/team-and-ota-admin-sso.md), [`../architecture.md`](../architecture.md) §6.4
