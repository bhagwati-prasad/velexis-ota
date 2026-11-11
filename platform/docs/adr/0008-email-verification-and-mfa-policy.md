# PADR-0008: E-mail verification and MFA policy

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit at the M6 security review, when the first OTA goes live, or if account-takeover attempts are seen.
**Revisions:** 2026-11-05 (lead decision (5b) of 2026-11-05, recorded with FIX-W43-PLATFORM; the follow-up of the M6 security review, [`../security-review.md`](../security-review.md) §9): MFA is mandatory for the owners and admins of a **live** OTA, enforced when the OTA goes live and at the first portal sign-in of each such owner or admin after that, with the enrolment then and there before any other portal page (dated note under the MFA table; tasks PBE-071 and PFE-030). Test-only OTAs keep MFA optional, and so do agents, finance members and viewers. 2026-11-11 ([ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) revision of 2026-11-11, the owner's decision, lead decision (15e), recorded with FIX-W48-PLATFORM; PCI DSS 8.3.6): the passwords the Context names as "10+ characters" need at least 12 characters with at least one letter and one digit, for every portal account, at sign-up, a password change and a reset; the breached-list check stays.

## Context

[ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) fixes the mechanics: Argon2id passwords (10+ characters, breached-list check), TOTP with ten hashed recovery codes, MFA optional for portal users and mandatory for platform admins, single-use hashed verification (24 h) and reset (1 h) tokens, lockout after 5 failures. It does not say what an unverified account may do, when MFA becomes required for portal users, how sensitive actions are protected, or how MFA reaches the OTA admin. Portal users can hold the keys to an OTA's live payments and supplier credentials, so a stolen password is costly.

## Decision

### E-mail verification

1. Sign-up answers `202` whether or not the e-mail exists. An existing address receives an "account exists" e-mail; nothing reveals registration to the caller.
2. An unverified account (`pending_verification`) **may sign in**, but its access token carries `ev = false` and every endpoint answers `403 EMAIL_NOT_VERIFIED` except: `getMe`, `updateMe`, MFA set-up, sessions, sign-out and resend. The portal shows only the "check your e-mail" page.
3. Verification tokens: 256-bit, SHA-256 hashed in `account_tokens`, 24 h, single use; a new token does not invalidate older unexpired ones (users often click the first e-mail). Resend: 3 per hour per e-mail.
4. Verification links are consumed by a server-side page that redirects to a clean URL with `Referrer-Policy: no-referrer`.
5. **Changing the e-mail address** is not self-service in the MVP (support handles it), so the verified address used for invitations and staff identity cannot be swapped silently.

### MFA

| Who or what | Rule |
|---|---|
| Platform admins | MFA mandatory to sign in to the admin; cannot be disabled ([PADR-0006](0006-platform-admin-access-and-audit.md)). |
| Portal users | Optional; strongly suggested by the onboarding checklist and a banner for owners and admins. |
| Sensitive actions | Need MFA **and** a recent TOTP (step-up within 15 minutes, claim `mfa_at`): entering Amadeus or Stripe credentials, Connect start, live secret keys, payout account, go-live, granting `owner`, disabling MFA, regenerating recovery codes. Without MFA: `403 MFA_REQUIRED`; with MFA but no recent code: `401 REAUTH_REQUIRED`. |
| OTA admin access of a **live** OTA (`storefront_environment = 'live'`) | Every member needs MFA enabled; the console token is refused otherwise (`MFA_REQUIRED`). Test-only OTAs do not require it. |
| OTA admin access of a test-only OTA | MFA optional; the token tells the OTA backend whether the account has MFA (`mfa` field), so the OTA admin can show a reminder. |

*Note (2026-11-05, lead decision (5b), FIX-W43-PLATFORM).* **MFA is mandatory for the owners and admins of a live OTA** (`storefront_environment = 'live'`); the "Portal users" row above stays true for everyone else.

- **Why** ([`../security-review.md`](../security-review.md) §9). Every sensitive action of the table already needs MFA and a recent step-up, but a stolen owner or admin password alone still opens the Stripe Customer Portal (change the card, or cancel the subscription, which suspends the OTA), invites a member who stays after a password reset, revokes or rolls API keys and removes members (an outage of the storefront), adds custom domains, edits the OTA profile, and reads everything of the OTA, its team and its masked connections. A live OTA takes real money from real travellers, so its owners and admins get the same second factor that its back office (the console row above) already demands. Agents, finance members and viewers cannot change money, credentials or the team, so their rule does not change. Test-only OTAs keep MFA optional, so the "OTA in minutes" promise of [`decisions.md`](../../../docs/mvp/decisions.md) §2 is not slowed down (Alternatives, "MFA mandatory for everyone").
- **When the OTA goes live.** `goLive` keeps needing the acting owner's MFA and a recent step-up (`x-mfa-step-up` and the `mfa` precondition of `LIVE_PRECONDITIONS_UNMET`), so a live OTA always starts with an owner who has MFA.
- **At the first portal sign-in after that.** An account that is an active `owner` or `admin` of a live OTA and has no MFA enrols at its first portal page after the OTA went live (or after it was granted the role on a live OTA, or after a support MFA reset), then and there, before any other portal page: the API answers its `portal` operations `403 MFA_REQUIRED`, reads included, and keeps open only the operations that an unverified account may call too (`portal_unverified`: `getMe`, which says so, the profile, the MFA set-up and enable, sessions, sign-out and the list of its OTAs), which is all an enrolment needs; the portal shows the enrolment page alone until MFA is on, then continues where the account was going. The API reads the rule from PostgreSQL on each request, as `TenantRoleGuard` reads memberships, so a session opened before the go-live meets it at its next request too.
- **It stays on.** While the account is an owner or admin of a live OTA it cannot disable MFA itself; losing the device still goes through a recovery code or a support reset (Additional rules, item 5), after which the account enrols again at its next portal page.
- **Tasks.** PBE-071 (the API rule, its contract and tests, the auth matrix column) and PFE-030 (the portal's enrolment gate and its tests).

Additional rules:

1. **TOTP**: `otplib`, SHA-1, 6 digits, 30 s, ±1 step window; a code is accepted once per account (the last used time step is kept in Redis for 90 s to stop replay).
2. **Set-up**: the pending secret lives envelope-encrypted in Redis for 10 minutes and moves to `accounts.mfa_secret_ciphertext` only when a valid code confirms it. Enabling returns ten recovery codes once.
3. **Recovery codes**: 16 characters of Crockford base32 (80 bits) shown as four groups, stored as SHA-256 in `account_recovery_codes`, single use; regenerating replaces all of them.
4. **Challenges**: sign-in with MFA returns a challenge token (Redis, 5 minutes, 5 attempts). Too many wrong codes end the challenge; the account's sign-in throttle also applies.
5. **Losing the device**: a recovery code, or a support reset by a platform admin after an identity check (reason recorded, user e-mailed, sessions revoked, `staffdeny` written).
6. **Notifications**: enabling or disabling MFA, regenerating codes, a password change and a reset each e-mail the account.

## Consequences

### Positive

- New users reach the product quickly; MFA friction appears where the risk is (credentials, money, live operations).
- A stolen password alone cannot change payment or supplier credentials, reveal bank details, or open a live OTA's back office.
- Unverified accounts cannot create OTAs or accept invitations, so invitations bind to a real mailbox.

### Negative

- Members of live OTAs must set up MFA before their next console access; the portal must guide them.
- Owners and admins of live OTAs must set up MFA at their first portal sign-in after the go-live, before any other portal page (revision of 2026-11-05); the API reads their memberships on each portal request for it.
- Step-up prompts interrupt sensitive flows; the 15-minute window keeps them rare.
- E-mail changes need support until a self-service flow exists.

### Follow-ups

- WebAuthn passkeys as a second factor after the MVP.
- Revisit making MFA mandatory for all owners at the M6 security review: decided on 2026-11-05 (revision above), mandatory for the owners and admins of live OTAs and optional for test-only OTAs; PBE-071 and PFE-030 implement it.
- Self-service e-mail change (verify the new address, notify the old one).

## Alternatives considered

- **Block sign-in until verified.** Clean, but users who lose the e-mail are stuck at sign-in without a place to resend; allowing a limited session is friendlier and equally safe.
- **MFA mandatory for everyone.** Safer, but slows the "OTA in minutes" promise of [`decisions.md`](../../../docs/mvp/decisions.md) §2 in test mode.
- **SMS codes.** Weaker (SIM swap) and costs money per message.

## References

- [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md), [ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md)
- [`../flows/signup-and-create-ota.md`](../flows/signup-and-create-ota.md), [`../flows/team-and-ota-admin-sso.md`](../flows/team-and-ota-admin-sso.md)
- OWASP Authentication and MFA cheat sheets
