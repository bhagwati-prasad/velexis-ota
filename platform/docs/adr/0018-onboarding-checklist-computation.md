# PADR-0018: Onboarding checklist computation

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform delivery lead. Decided during planning; revisit when the OTA backend can report storefront traffic or console use to the platform (for example through `platform-tenant-events`).

## Context

[`../scope.md`](../scope.md) PF-12 defines an onboarding checklist that is "computed, never stored", with the items: account verified, MFA on, OTA active, first API key created or revealed, storefront opened, Amadeus test office active, team member invited, and in M5 plan chosen, custom domain verified, own Stripe or payout account set, live requested. `getOnboarding` reads only platform tables ([`../api-inventory.md`](../api-inventory.md) §7).

Two items had no exact rule. "Storefront opened" cannot be observed: the platform never sees storefront traffic and the OTA backend never writes platform tables. "Team member invited" could mean an invitation sent or a member who joined.

## Decision

`GET /v1/tenants/{tenantId}/onboarding` returns the items below, in this order. Account items are computed for the caller. M5 items appear only when their milestone switch is on ([PADR-0015](0015-milestone-feature-switches.md)).

| Id | Label | Done when | Link (`href`) | Milestone |
|---|---|---|---|---|
| `email_verified` | Verify your e-mail | `accounts.email_verified_at` is set | `/verify-pending` | M1 |
| `mfa_enabled` | Turn on two-factor sign-in | `accounts.mfa_enabled` is true | `/account/security` | M1 |
| `ota_active` | OTA set up | `tenants.status = 'active'` | `/otas/{id}/setup` | M1 |
| `api_key` | Get your API keys | the initial keys were revealed (`provisioning_jobs.revealed_at`) or any key of the tenant was created by an account (`api_keys.created_by_account_id` is set) | `/otas/{id}/api-keys` | M1 |
| `storefront_open` | Open your storefront | the tenant is `active`, so the storefront answers on its primary host | `https://<primary host>/` | M1 |
| `amadeus_test` | Amadeus test office active | the `test` supplier connection is `active` | `/otas/{id}/amadeus` | M1 |
| `team_invited` | Invite your team | the tenant has an invitation that is not `revoked`, or more than one active member | `/otas/{id}/team` | M1 |
| `plan_chosen` | Choose a plan | the current subscription has `billing_provider = 'stripe'` and status `trialing` or `active` | `/otas/{id}/billing` | M5, `FEATURE_STRIPE_BILLING` |
| `custom_domain` | Connect your domain | a custom storefront domain is `verified` | `/otas/{id}/domains` | M5, `FEATURE_CUSTOM_DOMAINS` |
| `payments_ready` | Set up payouts or your own Stripe | the test payment connection is `connect_standard` or `api_keys` and `active`, or it is `velexis` and the payout account is `verified` | `/otas/{id}/payments` | M5, `FEATURE_OWN_STRIPE` or `FEATURE_SETTLEMENTS` |
| `live_requested` | Go live | a `live` supplier connection exists (any status) or `tenants.storefront_environment = 'live'` | `/otas/{id}/go-live` | M5, `FEATURE_LIVE_SWITCH` |

- "Storefront opened" is reduced to a link item that is done as soon as the storefront can be opened. The platform does not try to detect visits.
- Nothing is written when the checklist is read. The portal may hide a done item; it never stores state about it.

## Consequences

### Positive

- Every item has a testable rule over tables the platform owns (PBE-024).
- No new table, column or cross-backend message.

### Negative

- `storefront_open` says "you can open it", not "you opened it". The label is chosen to match.

### Follow-ups

- If the OTA backend later reports first storefront traffic through `platform-tenant-events`, change the rule of `storefront_open` in a new PADR.

## Alternatives considered

- **Store a "storefront opened" flag when the owner clicks the link in the portal.** It contradicts "computed, never stored" and is wrong for owners who open the storefront directly.
- **Let the OTA backend write a flag to a platform table.** Forbidden: the OTA backend never writes platform tables ([ADR-0003](../../../docs/mvp/adr/0003-six-components-two-nestjs-backends.md)).

## References

- [`../scope.md`](../scope.md) PF-12, [`../api-inventory.md`](../api-inventory.md) §7, [PADR-0015](0015-milestone-feature-switches.md)
