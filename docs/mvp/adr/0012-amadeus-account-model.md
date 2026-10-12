# ADR-0012: Amadeus account model

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (both models: Velexis shared account by default, OTA-owned credentials later), lead architect (data model, isolation, rate limits)

## Context

[`decisions.md`](../decisions.md) §2: by default an OTA books through **Velexis's Amadeus Enterprise account** with an office assigned to the OTA, for a quick start. An OTA can switch to **its own Amadeus credentials** (client id and secret, office ids).

The reference schema has one `platform.supplier_connections` row per tenant and environment, holding `client_id`, an encrypted `client_secret_ciphertext` (both `NOT NULL`), `office_ids`, default, queuing and owner offices, ticketing defaults and monitored queues. The platform admin manages "the shared Amadeus account and offices" (`decisions.md` §1). The OTA backend uses 12 Amadeus operations from 9 specifications ([`docs/amadeus-api/`](../../amadeus-api/)).

## Decision

### Data model (platform deltas, exact DDL in the platform plan)

- **`platform.amadeus_accounts`**: Velexis-owned credentials, one row per environment (`test`, `live`), with `client_id`, envelope-encrypted secret, `base_url` and status. Managed in the platform admin.
- **`platform.amadeus_offices`**: the pool of Velexis office ids per account (`office_id`, `environment`, `assigned_tenant_id` nullable, `assigned_at`). One office is assigned to at most one tenant.
- **`platform.supplier_connections`** gains `credential_source` (`velexis` or `tenant`) and `amadeus_account_id`.
  - `client_id` and `client_secret_ciphertext` become nullable.
  - A CHECK requires them when `credential_source = 'tenant'` and requires `amadeus_account_id` when it is `velexis`.
  - Office fields keep their meaning in both modes.

### Lifecycle

1. **Provisioning (M1):** the platform worker assigns a free **test** office from the pool and creates the tenant's `supplier_connections` row (`environment = test`, `credential_source = velexis`, `status = active`). With no free office, provisioning still succeeds, the connection is `pending_verification`, and the platform admin is alerted.
2. **Live (M5):** a platform admin assigns a live office after the OTA's commercial onboarding. The OTA's live keys and the storefront's live switch depend on an `active` live connection (db README §3, step 5).
3. **Own credentials (M5):**
   - The OTA enters client id, secret and office ids in the portal.
   - The platform backend encrypts the secret and verifies the credentials with an OAuth token request through a platform worker job.
   - It flips `credential_source` to `tenant` and publishes a cache invalidation.
   - The shared office goes back to the pool after a grace period, once no open booking still depends on it.

### Runtime in the OTA backend

- An **`AmadeusClient`** module is the only code that calls Amadeus. It covers the 12 operations, typed from `docs/amadeus-api/*.json`, and uses Node's built-in `fetch`.
- It resolves the connection from the cached `supplier_connections` row and, for shared connections, the cached `amadeus_accounts` row.
- **OAuth tokens** are cached in Redis per credential set and environment (`amadeus:token:<accountOrConnectionId>:<env>`), envelope-encrypted, with a TTL a little shorter than `expires_in`. Shared-account tokens are shared by all OTAs on that account.
- **Office isolation on the shared account.** The client always sets the tenant's own office ids (`queuingOfficeId`, `ownerOfficeId`, queue office, PNR retrieval office). Requests for an office outside the tenant's `office_ids` fail with `403 OFFICE_NOT_ALLOWED` (already in the error catalogue). Imports by record locator are accepted only for orders owned by one of the tenant's offices.
- **Rate limiting:**
  - a Redis token bucket per credential set protects the shared account's quota;
  - a second bucket per tenant keeps one OTA from using it all;
  - an exhausted bucket answers `429 RATE_LIMITED` with `Retry-After`.
- **Resilience:**
  - timeouts per operation (search 30 s, create order 60 s);
  - automatic retries only for idempotent reads and token requests;
  - Amadeus `5xx` and timeouts map to `SUPPLIER_UNAVAILABLE` and `SUPPLIER_TIMEOUT`.
  Order creation is never retried blindly. On a timeout, the booking is reconciled by retrieving it by reference before any second attempt.
- **Logging:** every call writes a `supplier_requests` row with the redacted request and response, latency and error codes (db README §8), plus a log line without bodies.
- **Test double:** the Amadeus stub server in `tools/amadeus-stub` serves recorded, scrubbed fixtures for all 12 operations, with scenario switches for sold out, price changed, ticketing failure and timeouts ([ADR-0015](0015-testing-strategy.md)). `AMADEUS_BASE_URL_TEST` points at it in development and CI.

## Consequences

### Positive

- An OTA is bookable in the test environment minutes after sign-up, with no Amadeus paperwork.
- The switch to own credentials changes data only. Code paths stay the same, because both sources end in the same resolved connection.
- Office-level isolation keeps OTAs on the shared account from seeing each other's PNRs and queues.

### Negative

- **Velexis is the contracting and, for live ticketing, the accredited party on the shared account.** Commercial and IATA/ARC terms with Amadeus and with each OTA must be settled before live sales (follow-up).
- One OTA's abuse can still hurt the shared quota before limits react. The per-tenant bucket is conservative by default.
- The office pool must be topped up manually through Amadeus. The platform admin shows pool levels.

### Follow-ups

- Decided during planning; revisit the per-tenant bucket sizes after M2 load tests, and the pool process when more than 20 OTAs are live.
- Contract terms for the shared account must be agreed before M5 live switches.

## Alternatives considered

- **Only OTA-owned credentials.** Slow onboarding. Every OTA would need its own Amadeus Enterprise contract first.
- **Shared account without per-OTA offices.** No isolation of PNRs and queues between OTAs. Rejected.
- **Copying the shared secret into each tenant's connection row.** Rotation would touch every row, and the secret would be duplicated. A referenced account row is simpler.

## References

- [`../decisions.md`](../decisions.md) §1, §2
- [`../../velexis-sdk/db/platform.sql`](../../velexis-sdk/db/platform.sql) (`supplier_connections`)
- [`../../velexis-sdk/README.md`](../../velexis-sdk/README.md) (Amadeus fidelity, 12 operations)
- [`../../amadeus-api/`](../../amadeus-api/)
- [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0015](0015-testing-strategy.md)
