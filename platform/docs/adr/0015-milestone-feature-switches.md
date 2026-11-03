# PADR-0015: Milestone feature switches

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform tech lead. Decided during planning; revisit after M5, when the switches have all been on in production for one release (then remove them).
**Revisions:** 2026-10-31 (lead decisions (2e) and (2i) of 2026-10-31, second batch, recorded with FIX-W38-PLATFORM): item 2 says that a switched-off operation answers `FEATURE_DISABLED` before any step-up, and that `makeDomainPrimary` is behind `custom_domains` and the plan's `limits.customDomains` like `addDomain` (dated note under item 2). 2026-11-02 (lead decisions (2a), (2b) and (2h) of 2026-11-02, recorded with FIX-W39-PLATFORM): making the sub-domain primary again is always allowed, `checkDomain` is behind `custom_domains` and the plan, and the worker applies own credentials only while their switch is on (dated note under item 2). 2026-11-03 (lead decision (2g) of 2026-11-03, recorded with FIX-W40-PLATFORM): own credentials and own Stripe keys for the live environment also need the live switch (dated note under item 2).

## Context

The solo developer merges small tasks to `main` continuously ([ADR-0020](../../../docs/mvp/adr/0020-ai-agent-development-workflow.md)), and every merge can be deployed. M5 features (Stripe Billing, the OTA's own Stripe, settlements, own Amadeus credentials, custom domains, the live switch) take several weeks and many tasks, and some depend on outside steps (legal review of Velexis-collected payments, Amadeus contracts, Stripe Connect approval). Half-finished M5 screens and endpoints must not be reachable in production, and the pre-M5 manual billing path must keep working until the switch-over. [`conventions.md` §8](../../../docs/mvp/conventions.md#8-configuration) requires switches that widen access to default to `false`.

## Decision

1. **Six boolean environment variables** in the platform backend, read through `@velexis/config`, all default `false`:

   | Variable | Enables | Turned on |
   |---|---|---|
   | `FEATURE_STRIPE_BILLING` | Checkout on create OTA, Billing page actions, billing webhooks processing, manual-trial jobs | M5 |
   | `FEATURE_OWN_STRIPE` | Connect Standard and API-key payment connections | M5 |
   | `FEATURE_SETTLEMENTS` | Payout account, settlement generation and pages | M5 |
   | `FEATURE_OWN_AMADEUS` | Own Amadeus credential submissions | M5 |
   | `FEATURE_CUSTOM_DOMAINS` | Adding custom domains, their `ask` rule, DNS jobs | M5 |
   | `FEATURE_LIVE_SWITCH` | Live Amadeus requests, live keys, go-live; own credentials and own Stripe keys for the live environment (2026-11-03) | M5 |

2. **Enforcement in the backend only.** A `@Feature('…')` decorator on controllers and a check in the schedulers; disabled endpoints answer `403 FEATURE_DISABLED` with `details.feature`. The same guard combines the plan's `limits` and `features` (for example `customDomains > 0`).
   - *Note (2026-10-31, lead decisions (2e) and (2i) of the second batch, FIX-W38-PLATFORM).* **The switch answers before the step-up**: every operation with `x-feature` answers `403 FEATURE_DISABLED` before any recent-MFA check, so the API's global guards run `FeatureGuard` before `RecentMfaGuard` (after the auth guards and `TenantRoleGuard`, so an unauthenticated caller or a non-member still learns nothing about the switches; [`../architecture.md`](../architecture.md) §3 steps 7 and 8). **`makeDomainPrimary` is behind `custom_domains` like `addDomain`**: `x-feature: custom_domains`, and a plan with `limits.customDomains` 0 answers `403 FEATURE_DISABLED` too (checked by the domain service, which knows the tenant), with nothing written.
   - *Note (2026-11-02, lead decisions (2a), (2b) and (2h), FIX-W39-PLATFORM).* **The sub-domain may always become primary again**: `makeDomainPrimary` loses its `x-feature`, and the domain service refuses only a custom domain while `FEATURE_CUSTOM_DOMAINS` is off or the plan has `limits.customDomains` 0 (`403 FEATURE_DISABLED`, `details.feature = custom_domains`, nothing written), once it has read the domain; so an OTA whose switch or plan lost custom domains can always go back to its `<key>.<STOREFRONT_BASE_DOMAIN>`. **`checkDomain` is behind `custom_domains` and the plan like `addDomain`** (`x-feature: custom_domains`; the plan rule in the service). **The worker honours the switches of own credentials**: a `credentials.verify` attempt of a kind whose switch is off (`amadeus`: `FEATURE_OWN_AMADEUS`, `stripe_api_keys`: `FEATURE_OWN_STRIPE`) fails the submission with `FEATURE_DISABLED` instead of applying it, and the sweep fails a `pending` one of that kind the same way ([PADR-0010](0010-credential-submission-and-verification.md) item 4 note of 2026-11-02).
   - *Note (2026-11-03, lead decision (2g), FIX-W40-PLATFORM).* **Own credentials for the live environment need the live switch too**: `submitAmadeusCredentials` and `submitStripeApiKeys` keep their `x-feature` (`own_amadeus`, `own_stripe`), and with `environment = live` the service also answers `403 FEATURE_DISABLED` with `details.feature = live_switch` while `FEATURE_LIVE_SWITCH` is off, after the guards (the step-up included) and before any other rule of the request, as live API keys do; the `test` environment does not need it. The portal shows the live own-credentials and own-keys sections only with `features.liveSwitch`.
3. **The portal and admin read the switches** from `GET /v1/me` (`features` object in the response) and hide disabled navigation; they hold no switch of their own, so the backend stays the single source.
4. **Webhooks are always received and stored**, even with a switch off; processing of a disabled feature marks the event `ignored`, so nothing is lost if Stripe is configured early.
5. **Removal.** One release after a switch has been on in production, a task removes it from code and configuration.
6. **No feature-flag service** and no per-tenant flags beyond plan limits.

## Consequences

### Positive

- M5 work merges early and is tested in CI and staging-like local runs with switches on, while production stays on the M1–M4 behaviour.
- The outside dependencies (legal, Amadeus, Stripe) decide the switch-on date, not the code.

### Negative

- Both paths (manual and Stripe billing) exist in code until removal, and tests must cover both.
- A forgotten switch removal leaves dead branches; the follow-up task prevents it.

### Follow-ups

- Add the six variables to the root `.env.example`, [`deploy/env/platform-backend.env.example`](../../../deploy/env/platform-backend.env.example) (the template of `/etc/velexis/platform-backend.env`, read by the API and the worker) and the [configuration matrix](../../../docs/mvp/architecture.md#6-configuration-matrix) (PBE-012).
- Remove the switches once all six have been on in production for one release (PBE-064). That happens after the launch, so PBE-064 is a named exception to the M6 go criterion "every task done" ([ADR-0025](../../../docs/mvp/adr/0025-roadmap-scheduling-and-tracking.md) item 4).

## Alternatives considered

- **Long-lived M5 branch.** Merge pain for a solo developer and agents working in parallel.
- **Per-tenant flags in the database.** More flexible than needed; plans already gate per-tenant features.
- **Hosted feature-flag service.** Another dependency for six booleans.

## References

- [ADR-0020](../../../docs/mvp/adr/0020-ai-agent-development-workflow.md), [`conventions.md` §8](../../../docs/mvp/conventions.md#8-configuration)
- [`../../backend/README.md`](../../backend/README.md) (environment variables), [`../scope.md`](../scope.md)
