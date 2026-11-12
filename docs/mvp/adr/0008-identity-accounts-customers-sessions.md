# ADR-0008: Identity: accounts, customers and sessions

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (httpOnly cookies + CSRF on the storefront, no tokens in browser JS), lead architect (realms, token formats, SSO handoff). Decided during planning where not in `decisions.md`; revisit when a third-party identity provider (Google, Microsoft, SAML) is required.
**Revisions:** 2026-10-12 (planning review): cross-boundary revocation is the account-level cut-off `staffdeny:acct:<accountId>` of [PADR-0007](../../../platform/docs/adr/0007-portal-to-ota-admin-sso-token.md); a later third-party password grant is verified by the platform. 2026-10-21 (lead decision): the staff access token's claims are aligned with [OADR-0011](../../../ota/docs/adr/0011-console-access-staff-sessions-and-environments.md) point 2 and the OTA backend (OBE-059): `typ` (`staff`), `sub` (the staff id, the membership `stf_…`), `tid`, `roles` and `sid`; the separate `stf` claim is dropped, because `sub` already names the staff member (Common mechanics, SSO step 4). 2026-10-21 (lead decision, second batch): the access-token `typ` list gains `admin`, the platform admin's token (audience `platform_admin`), as [platform architecture §3.1](../../../platform/docs/architecture.md#31-tokens) and the platform backend's token service (`TOKEN_TYPES` in `platform/backend/src/auth/token.service.ts`, PBE-012) use it (Common mechanics). 2026-10-24 (lead decision (1), FIX-W29-SECURITY; dated refining note of Common mechanics, "Access tokens"): a customer access token stays stateless for its 15 minutes except for its customer's state: every customer-scope operation of the OTA backend, not only `account.*`, refuses the token of a deleted or disabled customer, through a cached check in Redis (`t:<tenantId>:<env>:cust:<customerId>`) that account.delete revokes. 2026-10-26 (lead decision (1), FIX-W30-OTA; dated refining note of the same): a console-scope checkout.create refuses a priced offer whose customer was deleted or disabled, as customer scope refuses that customer's token. 2026-11-10 (the owner's decision, lead decision (13g) of 2026-11-10, FIX-W47-PLATFORM; PCI DSS v4.0.1 requirement 8.3.6; dated note under Common mechanics, "Passwords"): platform admins and the owners and admins of OTAs need passwords of at least 12 characters with at least one letter and one digit, applied when such an account next sets a password; every other portal account keeps the 10-character rule. 2026-11-11 (the owner's decision, lead decision (15e) of 2026-11-11, FIX-W48-PLATFORM; PCI DSS v4.0.1 requirement 8.3.6; dated note under Common mechanics, "Passwords"): the 12-character rule with at least one letter and one digit is **every** portal account's, at sign-up, a password change and a reset; the 10-character rule and the account-dependent rule of 2026-11-10 are gone, so every account meets 8.3.6 from launch (no live account existed). 2026-11-11 (lead decision (17b) of 2026-11-11, approved by the owner, FIX-W49-SHARED; dated note under Common mechanics, "Passwords"): portal passwords are checked against the entries of a public list of about a million breached passwords that meet the 12-character letter-and-digit rule, instead of the top-10 000 list, none of whose entries meets the rule; task PBE-073 builds it. 2026-11-12 (lead decision (18a) of 2026-11-12, approved by the owner, PBE-073; dated completion of that note): the list as built from the pinned source (28 897 entries, its SHA-256 and the source's recorded there, about 340 KiB more in the repository and each release, 1.91 MiB of heap instead of 0.62 MiB) replaces the portal's top-10 000 list, so a short common password is answered `password_rule` instead of `breached`; OTA customer passwords keep the OTA backend's own top-10 000 list byte for byte at launch, and checking them against the entries of 10 or more characters of the million-password list is a later follow-up.

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
  - *Note (2026-11-10, the owner's decision, lead decision (13g); FIX-W47-PLATFORM).* PCI DSS v4.0.1 requirement 8.3.6 asks for passwords of at least 12 characters with numeric and alphabetic characters where a password is a factor of an account it covers ([`ota/docs/pci/README.md`](../../../ota/docs/pci/README.md) §8 item 1). The portal's accounts that reach the cardholder data environment's apps or an OTA's payments therefore have a **privileged rule**: a platform admin, and an account with an active `owner` or `admin` membership of an OTA that members may see (test or live, in any OTA), needs at least **12 characters with at least one letter and one digit** (any script's letters, decimal digits; counted in code points), still checked against the breached-password list. Every other portal account (agents, finance members, viewers, an account without a membership) keeps at least 10 characters and no composition rule, and so does the sign-up, where an account holds no role yet. The rule is read when the account **sets** a password: a password change and a password reset (`422 PASSWORD_TOO_WEAK` with a message that names the rule and the field code `privileged_rule`, [`password-policy.ts`](../../../platform/backend/src/auth/password-policy.ts)). A password in use is never checked again, so an existing password keeps working until the account's next change or reset; accepting an invitation and `admin:grant` set no password, so a role or an admin flag granted later applies from the next one. The portal shows the rule where these accounts choose a password, and the platform admin's sign-in says where a platform admin changes it. OTA customers keep their OTA's own password policy (`storefront.auth.passwordPolicy`); the OTA staff password grant stays disabled.
  - *Note (2026-11-11, the owner's decision, lead decision (15e); FIX-W48-PLATFORM).* This replaces the account-dependent rule of the note above: **every portal account's password needs at least 12 characters with at least one letter and one digit** (any script's letters, decimal digits; counted in code points), still checked against the breached-password list, wherever a password is chosen: the sign-up (an invited person signs up before accepting), a password change and a reset. The rule no longer reads an account's roles, and the 10-character rule is gone. No live account existed on that day, so no password set under an older rule reaches production and every account meets PCI DSS 8.3.6 from launch; P21 of the go-live runbook ([`airline-card-go-live.md`](../../../ota/docs/runbooks/airline-card-go-live.md)) checks it. A refusal answers `422 PASSWORD_TOO_WEAK` with one field code for the length, the letter and the digit, `password_rule` (the note above's `privileged_rule`, renamed because it is no longer a rule of privileged accounts; `too_short` is gone too), and `breached` for the list, which is checked first. A password in use is still never checked again, so a password set before the rule (in development or a test) keeps working until the account sets a new one. Accepting an invitation and `admin:grant` still set no password; `dev:seed` gives its platform admin a password that meets the rule.
  - *Note (2026-11-11, lead decision (17b), approved by the owner; FIX-W49-SHARED).* The 12-character rule with a letter and a digit makes the top-10 000 list useless: none of its entries meets the rule, so it refuses no password the rule lets through. Portal passwords are therefore checked against the entries of a larger public breached-password list, about a million entries (SecLists `xato-net-10-million-passwords-1000000.txt`, MIT licence, at a pinned commit), that meet the rule: on 2026-11-11 28 897 of its 999 999 lines, about 411 KiB lower-cased and without duplicates (today's file is 71 KiB), and about 1.7 MiB of the platform API's heap instead of 0.6 MiB. The file is generated reproducibly by a script from the pinned source, whose SHA-256 and the file's are recorded, and checked offline in CI; nothing downloads it at build or deploy time. The list is still checked first (decision (16b)), still in any letter case, and its field code stays `breached`; a short common password that the old list named `breached` is now refused as `password_rule` by the rule itself. OTA customers keep the top-10 000 list: their passwords need only 10 characters, with no letter or digit rule, so it still refuses passwords their rule lets through, and the OTA backend keeps its own copy of it unchanged. Task [PBE-073](../../../platform/docs/plans/agent-tasks.md#pbe-073--check-portal-passwords-against-the-rule-meeting-entries-of-a-public-list-of-a-million-breached-passwords) builds it and completes this note with the list as built; until it is merged the top-10 000 list stays in place. *The list as built (2026-11-12, PBE-073; lead decision (18a) of 2026-11-12, approved by the owner).* The source is SecLists `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` (MIT licence) at commit `c23b603128ed21e46164a0afd357f0c242135f41`: 999 999 lines, SHA-256 `424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51`. [`platform/backend/scripts/breached-passwords.mjs`](../../../platform/backend/scripts/breached-passwords.mjs) keeps its lines that meet the rule exactly as `PasswordPolicy` counts it (28 968), lower-cased and trimmed, without duplicates and sorted by code point: 28 897 entries, 421 156 bytes, SHA-256 `df67d6b895d1c029308223dd82298bbde1b2f776fd9ae5d5b9ac3bbe17e31faf` ([`breached-passwords.txt`](../../../platform/backend/src/auth/breached-passwords.txt)); regenerating it from the pinned source gives the same bytes, and the script's offline `--check` runs in CI through the unit test. Against the top-10 000 list (73 026 bytes) the file adds 348 130 bytes (about 340 KiB) to the repository, the build and each release, and the set 1.91 MiB of the platform API's heap instead of 0.62 MiB (measured with `node --expose-gc`; the 1.7 MiB above was the estimate of 2026-11-11). The portal's top-10 000 list is replaced by these rule-meeting entries: a short common password such as `QwertyUiop`, which the old list named `breached`, is now answered `password_rule`, so it is refused either way. OTA customer passwords keep the OTA backend's own copy of the top-10 000 list byte for byte at launch (SHA-256 `68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce`); checking them against the entries of 10 or more characters of the million-password list is a later follow-up.
- **MFA:** TOTP (`otplib`, 30 s steps, ±1 step). The secret is envelope-encrypted in `accounts.mfa_secret_ciphertext` ([ADR-0010](0010-secrets-envelope-encryption.md)). Ten one-time recovery codes are stored hashed. Optional for portal users, mandatory for platform admins.
- **Access tokens** are JWTs signed with **EdDSA (Ed25519)** through `jose`, 15-minute lifetime, with `kid` headers so keys can rotate. The platform and the OTA backend have separate key pairs. Claims: `sub`, `typ` (`portal`, `admin`, `staff` or `customer`; `admin` is the platform admin's token, whose audience is `platform_admin`, [platform architecture §3.1](../../../platform/docs/architecture.md#31-tokens)), `tid` for tenant-bound tokens, `roles` for staff, `sid` (session family). In a staff token `sub` is the staff id (the membership, `stf_…`), so a staff token carries `typ`, `sub`, `tid`, `roles` and `sid`, and no separate `stf` claim ([OADR-0011](../../../ota/docs/adr/0011-console-access-staff-sessions-and-environments.md) point 2).
  - *Note (2026-10-24, lead decision (1), FIX-W29-SECURITY).* A customer access token is not wholly stateless: the OTA backend's customer guard refuses, on every customer-scope operation and with the `401 UNAUTHENTICATED` that `account.*` gives, the still valid token of a customer that may no longer hold a session (deleted or disabled); only account.delete lets it through, so that the idempotent replay of a deletion still answers the stored deletion, while a new one is refused there. The check is cheap: one Redis `GET` of `t:<tenantId>:<env>:cust:<customerId>` per request ([ota/docs/architecture.md §7](../../../ota/docs/architecture.md#7-redis-keys)). `1` means the database said, at most a minute ago, that the customer may act; a missing key, the revocation `0` or a Redis error read the customer from PostgreSQL, and only a missing key is then filled with `1` (`SET … NX`). account.delete writes `0` for both environments (one minute) after its commit, so no cached `1` outlives the deletion; a path that disables a customer does the same, and a customer disabled without one (by hand) is refused within the minute. A checkout.create that read the customer before a deletion committed reads it again after its insert and is refused, so no open checkout of a deleted customer remains. Session revocation (sign-out, a password change) still takes effect at the end of the access token's 15 minutes outside `account.*` and `auth.getSession`.
  - *Note (2026-10-26, lead decision (1), FIX-W30-OTA).* Staff acting for a customer get the same answer about that customer: a console-scope checkout.create opens the checkout for the priced offer's customer only while the customer may act, and refuses one that was deleted or disabled with `409 CONFLICT` (`details.reason` `customer_deleted` or `customer_disabled`, the OTA document's `createCheckout`), read before and after the checkout's insert as the customer path reads it, so no checkout of a deleted customer is opened from the console either. Staff stay signed in: the answer is about the customer, never a `401` to the staff member.
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
