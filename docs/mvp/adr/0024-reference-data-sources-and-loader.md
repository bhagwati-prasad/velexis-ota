# ADR-0024: Reference data sources and loader

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform/DevOps engineer (foundation plan). Decided during planning; revisit when a paid IATA data feed is bought, when an OTA reports missing or wrong codes more than occasionally, or before refreshing more often than quarterly.

## Context

The `reference` schema has seven tables, all keyed by natural codes ([`reference.sql`](../../velexis-sdk/db/reference.sql)):

| Table | Key | What it holds |
|---|---|---|
| `currencies` | ISO 4217 | currency codes |
| `countries` | ISO 3166-1 | country codes |
| `time_zones` | IANA | time zone names |
| `cities` | IATA | metropolitan area codes |
| `airports` | IATA | airport codes |
| `airlines` | IATA | airline designators |
| `aircraft` | IATA | equipment codes |

The storefront's airport autocomplete, the conversion of Amadeus local times to UTC, and the display of airline and aircraft names need them from M2. The DDL comment says the data is "loaded and refreshed by platform jobs from IATA / ISO / IANA sources". IATA's own code files are licensed and paid, and the platform backend owns the schema ([`decisions.md`](../decisions.md) §5). We need free, redistributable sources and a loader that runs the same way locally, in CI and on the VM.

## Decision

### Sources

| Table | Source | Licence |
|---|---|---|
| `airports`, `cities`, time zone per location, coordinates, `search_rank` | OpenTravelData `optd_por_public.csv` (points of reference with IATA, ICAO, city codes, IANA zone, page rank) | CC BY 4.0 |
| `airlines` | OpenTravelData `optd_airlines.csv` (IATA, ICAO, names, alliance) | CC BY 4.0 |
| `aircraft` | OpenTravelData `optd_aircraft.csv` | CC BY 4.0 |
| `countries` | Unicode CLDR JSON: territory names, alpha-3 and numeric mappings, main currency, telephone codes. Continent from OpenTravelData. `is_eu` from a short list in code. | Unicode License v3 |
| `currencies` | Unicode CLDR JSON: names, symbols, minor units; numeric codes from the CLDR code mappings | Unicode License v3 |
| `time_zones` | IANA tz names from CLDR. Standard and daylight offsets computed with `Intl` at snapshot time. | public domain / Unicode |

The licences are re-checked when each snapshot is taken and recorded in `SOURCES.md`. **OurAirports** (public domain) is the fallback for airports if OpenTravelData becomes unavailable. CC BY requires attribution: the storefront's legal page and the OTA admin's "About" page carry the line "Contains data from OpenTravelData (CC BY 4.0)".

### Vendored snapshots, never fetched at runtime

- A small workspace tool, **`tools/reference-data`** (`@velexis/reference-data`), holds:
  - a `fetch` script that the developer runs by hand. It downloads, filters (only rows with an IATA code, plus closed airports marked inactive) and normalises the sources into compact CSV files under `tools/reference-data/data/`;
  - `SOURCES.md` with the URL, retrieval date, licence and SHA-256 of every raw file;
  - the loader CLI.
- The snapshots are committed and reviewed like code. CI, deploys and tests **never download** them. Refresh: quarterly, as a normal pull request.

### Loader

- `dist/cli/load.js --data <dir>` connects with `DATABASE_URL` as **`velexis_platform_app`**, which has DML on `reference` ([ADR-0004](0004-postgresql-schema-per-tenant.md)). It loads everything in **one transaction**, in foreign-key order: currencies, countries, time zones, cities, airports, airlines, aircraft.
- It upserts with `INSERT … ON CONFLICT (<code>) DO UPDATE … WHERE <row changed>`, setting `updated_at`.
- Codes that disappear from a snapshot are **never deleted**, because tenant rows reference them by value. They are set `is_active = false` where the table has that column.
- It prints counts per table (inserted, updated, deactivated) and is idempotent: a second run reports zero changes.
- Entry points:
  - `pnpm db:seed:reference` locally;
  - `velexis-deploy` when the checksum of `data/` differs from the last load ([`deployment-single-vm.md`](../deployment-single-vm.md) §8);
  - the `@velexis/testing` template database, with a small fixture subset.
- A scheduled refresh job in the platform worker is **not** in the MVP. Reference data changes slowly, and a reviewed pull request is safer than an unattended download.

## Consequences

### Positive

- Free, redistributable data with a clear audit trail of where every row came from.
- Deterministic: the same commit always loads the same reference data, locally and on the VM.
- The platform backend's ownership of `reference` holds; the loader uses the platform role.

### Negative

- Community data can lag behind new or changed IATA codes by weeks. An OTA may meet an airport the autocomplete does not know, though Amadeus still accepts the code. Quarterly refreshes and a manual patch file (`data/overrides.csv`) cover urgent fixes.
- About 1–2 MB of CSV in the repository per snapshot; history grows with every refresh.
- The attribution line is a small product requirement for the OTA storefront and admin.

### Follow-ups

- X-017 builds the fetch script and the first snapshot; X-018 builds the loader and `pnpm db:seed:reference`. The OTA plan adds the attribution line to the storefront legal page.

## Alternatives considered

- **IATA code files (paid).** Authoritative, but a licence cost and redistribution limits before there is revenue.
- **Amadeus reference APIs at runtime.** The 12 operations in scope ([`docs/amadeus-api/`](../../amadeus-api/)) do not include location or airline lookup. Calling extra APIs for autocomplete would also use quota on every keystroke.
- **Seed data as SQL migrations.** Megabytes of `INSERT` statements in the migration ledger. Every refresh would be a new multi-megabyte migration, and checksums would freeze typos.
- **Downloading at deploy time.** Non-deterministic, and it depends on third-party uptime during a deploy.

## References

- [`../../velexis-sdk/db/reference.sql`](../../velexis-sdk/db/reference.sql), [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §2
- [ADR-0004](0004-postgresql-schema-per-tenant.md), [ADR-0023](0023-release-artefact-and-deploy-user.md)
- OpenTravelData: <https://github.com/opentraveldata/opentraveldata>; Unicode CLDR: <https://cldr.unicode.org>; OurAirports: <https://ourairports.com/data/>
