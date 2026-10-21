# ADR-0008: Identity: accounts, customers and sessions

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (httpOnly cookies + CSRF on the storefront, no tokens in browser JS), lead architect (realms, token formats, SSO handoff). Decided during planning where not in `decisions.md`; revisit when a third-party identity provider (Google, Microsoft, SAML) is required.
**Revisions:** 2026-10-12 (planning review): cross-boundary revocation is the account-level cut-off `staffdeny:acct:<accountId>` of [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md); a later third-party password grant is verified by the platform. 2026-10-21 (lead decision): the staff access token's claims are aligned with [OADR-0011](../../../ota/docs/adr/0011-console-access-staff-sessions-and-environments.md) point 2 and the OTA backend (OBE-059): `typ` (`staff`), `sub` (the staff id, the membership `stf_…`), `tid`, `roles` and `sid`; the separate `stf` claim is dropped, because `sub` already names the staff member (Common mechanics, SSO step 4).

## Context

Velexis has several kinds of people and callers:

- portal users, who own or run OTAs;
- Velexis staff;
- OTA staff using the OTA admin;
- each OTA's travellers (customers and guests);
- programs calling the OTA API with keys.

The reference design puts portal accounts, memberships and API keys in `platform` and customers in each tenant schema ([db README §2](../../velexis-sdk/db/README.md)). The OTA API contract defines customer sessions (bearer access token + rotating refresh token), staff sessions (`console.auth.signIn` with a password or a one-time `portalToken`) and guest booking tokens.

[`decisions.md`](../decisions.md) §5 adds two constraints:

- the hosted storefront uses httpOnly cookies + a CSRF token, so no token is readable by JavaScript;
- the OTA backend only **reads** platform tables.

## Decision

### Identity realms

| Realm | Store | Issued and verified by | Credential in the browser |
|---|---|---|---|
| **Portal account** (OTA owner or staff) | `platform.accounts`, `platform.account_sessions` | Platform backend | httpOnly cookies on `platform.example.com`, set by the portal's Next.js server |
| **Platform admin** (Velexis staff) | Same accounts with `is_platform_admin = true` | Platform backend | httpOnly cookies on `admin.platform.example.com`. **TOTP MFA is mandatory.** |
| **OTA staff** | Portal account + `platform.tenant_memberships` (`stf_…`, role) | OTA backend issues staff tokens | httpOnly cookies on `admin.ota.example.com`, set by the OTA admin's Next.js server |
| **Customer** (traveller with an account) | `tenant_<key>.customers`, `customer_identities`, `customer_sessions` | OTA backend | Hosted storefront: httpOnly cookies + CSRF. Third-party frontends: bearer tokens per the contract. |
| **Guest** (booking without an account) | `tenant_<key>.booking_access_tokens` | OTA backend | Hosted storefront: httpOnly cookie. Third-party: `X-Booking-Token`. |
| **API key** (`pk_`, `sk_`, `hk_`) | `platform.api_keys` (HMAC hash only) | Created by the platform backend, verified by the OTA backend | Only `pk_` may be in a browser |
| **First-party service** (storefront edge, OTA admin server) | Secrets in `/etc/velexis/*.env` | OTA backend | Never in a browser |

### Common mechanics

- **Passwords:** Argon2id (`argon2` package, OWASP parameters: m=19 MiB, t=2, p=1), at least 10 characters, checked against a top-10k breached-password list. No other complexity rules.
- **MFA:** TOTP (`otplib`, 30 s steps, ±1 step). The secret is envelope-encrypted in `accounts.mfa_secret_ciphertext` ([ADR-0010](0010-secrets-envelope-encryption.md)). Ten one-time recovery codes are stored hashed. Optional for portal users, mandatory for platform admins.
- **Access tokens** are JWTs signed with **EdDSA (Ed25519)** through `jose`, 15-minute lifetime, with `kid` headers so keys can rotate. The platform and the OTA backend have separate key pairs. Claims: `sub`, `typ` (`portal`, `staff` or `customer`), `tid` for tenant-bound tokens, `roles` for staff, `sid` (session family). In a staff token `sub` is the staff id (the membership, `stf_…`), so a staff token carries `typ`, `sub`, `tid`, `roles` and `sid`, and no separate `stf` claim ([OADR-0011](../../../ota/docs/adr/0011-console-access-staff-sessions-and-environments.md) point 2).
- **Refresh tokens** are opaque 256-bit random values, stored only as SHA-256 hashes, rotated on every use. Reuse of a rotated token revokes the whole family, as the contract specifies.
- **Lockout:** 5 failed sign-ins lock an identity for 15 minutes, plus IP-based rate limits in Redis.
- **E-mail verification and password reset** use single-use hashed tokens, valid for 24 h and 1 h respectively.

### Portal and platform admin sessions

The Next.js app is a backend-for-frontend:

1. A server action calls the platform API to sign in.
2. It stores the access and refresh tokens in `__Host-` prefixed cookies (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`).
3. It calls the API with `Authorization: Bearer` from server code only.
4. Next.js middleware refreshes an expired access token before rendering.

Server actions get Next.js's built-in Origin check. Route handlers that change state check `Origin` explicitly.

### OTA staff: SSO from the portal

1. The portal user clicks **Open console** for an OTA. The portal server calls the platform API, which:
   - checks that the account has an active membership in that tenant;
   - generates a one-time token `ptk_…` (256-bit);
   - stores `SET ptk:<sha256> {accountId, tenantId, membershipId} EX 60 NX` in Redis.
2. The portal returns a page that **auto-submits a POST form** with the token to `https://admin.ota.example.com/sso`. The token never appears in a URL, a log or a `Referer`.
3. The OTA admin server calls `console.auth.signIn({ grantType: "portal_token", portalToken })` through the SDK, using its first-party service credential.
4. The OTA backend redeems the token with `GETDEL`, so it works only once. It re-reads the membership and account status (read-only), then issues a staff access token (`typ: staff`, `sub` = the membership's `stf_…`, `tid`, `roles`, `sid` = the refresh family) and a refresh token.
5. **Staff refresh-token families live in Redis**, not in `platform.account_sessions`, because the OTA backend cannot write platform tables. The OTA backend revokes single families with `staffdeny:<familyId>`. The platform cannot know OTA family ids, so it writes an **account-level cut-off** instead: `staffdeny:acct:<accountId> = <epoch ms>` with a 30-day TTL, on sign out everywhere, password change or reset, MFA reset and account disable. The staff guard and the refresh endpoint refuse every family of that account created before the cut-off ([PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md) item 6, [OADR-0011](../../../ota/docs/adr/0011-console-access-staff-sessions-and-environments.md)).

The OTA admin is multi-tenant, and the OTA is chosen after sign-in ([`decisions.md`](../decisions.md) §4):

- Visiting `admin.ota.example.com` without a session redirects to the portal. There the user signs in (with MFA if enabled), picks one of their OTAs, and the SSO handoff above runs.
- The OTA admin's tenant switcher links back to the portal's **Open console** for another OTA. A staff session is always bound to one tenant.

The OTA admin offers only the portal-token grant. The password grant of `console.auth.signIn` stays in the contract for third-party consoles but is disabled in the MVP ([OADR-0011](../../../ota/docs/adr/0011-console-access-staff-sessions-and-environments.md)). If it is built later, the **platform** verifies the password and the TOTP code and hands the OTA backend a one-time token, as for SSO; the OTA backend never reads password hashes or MFA secrets ([ADR-0004](0004-postgresql-schema-per-tenant.md)).

### Customers on the hosted storefront (cookie mode)

- Requests arrive same-origin on `/api/*` through Caddy, which adds the edge credential and the host ([ADR-0018](0018-hosted-storefront-custom-domains.md)).
- On sign-in, sign-up, refresh and guest booking creation, the OTA backend sets the session in cookies (`__Host-vx_at`, `__Host-vx_rt`, `HttpOnly`, `Secure`, `SameSite=Lax`) and leaves the token fields out of the JSON body.
- **CSRF: double-submit token.**
  - A non-httpOnly `__Host-vx_csrf` cookie holds a random value. It is issued by the first `storefront.get` (so anonymous search POSTs are covered from M2) and rotated at sign-in and sign-out.
  - The SDK in cookie mode copies it into `X-CSRF-Token` on every state-changing request.
  - The backend requires the header to match the cookie and checks `Origin` against the request host.
  - The CSRF value is not a credential, so the "no token readable by JavaScript" rule holds.
- Third-party frontends keep the contract's bearer mode: publishable key plus customer tokens, or their own server with a secret key.

### First-party service credentials

These are additions to the OTA contract, specified spec-first ([ADR-0006](0006-contract-first-openapi.md)).

- **Storefront edge.** Caddy sends a shared secret header and `X-Velexis-Host: {host}` on `/api/*`, after deleting any client-supplied copies.
  - The OTA backend resolves the tenant from the verified host, with the hosted storefront's environment (test until the OTA switches to live in M5).
  - It grants customer scope only.
- **OTA admin.** The OTA admin server sends its service key as the SDK's `secretKey`.
  - The backend accepts it only from `127.0.0.1`, only on console operations, and only with a staff token whose `tid` names the tenant. The one exception is the portal-token sign-in, where the tenant comes from the redeemed token.
  - The environment (test or live) is chosen per request by the staff member's selection in the OTA admin, and live requires a role that allows it.

## Consequences

### Positive

- No access or refresh token is ever readable by browser JavaScript in any first-party app.
- One mechanism (JWT + rotating refresh) across realms. It is easy to test and to reason about.
- SSO from the portal needs no shared cookie domain and no platform write by the OTA backend.

### Negative

- Staff sessions in Redis are lost if Redis loses data. Staff then sign in again through the portal. This is acceptable.
- Cookie mode and bearer mode are two code paths in the OTA backend and the SDK, and both need tests.
- The first-party service credentials are powerful. They are kept server-side, scoped narrowly and rotated with the other secrets.

### Follow-ups

- Social sign-in for customers, and SAML or OIDC for portal accounts, are post-MVP.
- `platform.account_sessions` stays the store for portal sessions only. Its `active_tenant_id` column is unused in the MVP.

## Alternatives considered

- **One shared cookie across `*.example.com`.** It would leak portal sessions to every OTA storefront sub-domain.
- **Storing staff sessions in `platform.account_sessions`.** It needs OTA writes to platform tables, which `decisions.md` §5 rules out.
- **Session ids in cookies with server-side session state instead of JWTs.** Simpler revocation, but a Redis or database read on every request in both backends, and the contract already defines tokens.
- **An identity provider (Keycloak, Auth0).** Another service to run or pay for, and customers must stay per tenant anyway.

## References

- [`../decisions.md`](../decisions.md) §4, §5
- [`../../velexis-sdk/sdk/src/console.d.ts`](../../velexis-sdk/sdk/src/console.d.ts) (`console.auth.signIn`), [`identity.d.ts`](../../velexis-sdk/sdk/src/identity.d.ts)
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §5, §8
- [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0018](0018-hosted-storefront-custom-domains.md), [ADR-0019](0019-vanilla-js-sdk-jsdoc.md)
- [`../architecture.md`](../architecture.md), flow (c)
