# OTA backend load tests

`search-load.mjs` is the M2 search load test of the OTA API (OBE-028). It answers the follow-ups of [OADR-0001](../../../docs/adr/0001-amadeus-client-design.md) ("load-test the buckets") and [OADR-0002](../../../docs/adr/0002-offer-and-priced-offer-caching.md) ("measure search insert time and table sizes"). The figures of each recorded run and what was decided from them are in [`ota/docs/performance.md`](../../../docs/performance.md).

- **Plain Node, no dependency of its own.** It uses `fetch` and the workspace packages the OTA backend already has (`@velexis/config`, `@velexis/db`, `@velexis/crypto`, `@velexis/testing`, `ioredis`), and the built API and Amadeus stub.
- **Not part of `pnpm test`, `pnpm test:int` or CI.** A load test measures the machine it runs on, so it runs by hand. Every run is recorded in `performance.md` with the machine and its load.
- **Local and test only.** It starts its own API against its own scratch database and the Amadeus stub. It never talks to a deployed API, a real Amadeus or a database it did not create.

## Run it

You need the local setup of [`docs/mvp/local-development.md`](../../../../docs/mvp/local-development.md) §2: PostgreSQL 16 with the roles of `dev-setup.sh` (`velexis_test_admin` among them) and Redis. `TEST_DATABASE_ADMIN_URL` and `REDIS_URL` come from the environment or from the `.env.local` files, as for `pnpm test:int`. Build the API, the stub and the packages they use, then run the test from the repository root:

```bash
pnpm build --filter=@velexis/ota-backend...                       # the API, @velexis/testing, the stub and the packages
node ota/backend/test/load/search-load.mjs --visitors 10 --searches 200                 # the run of the plan (Verify)
node ota/backend/test/load/search-load.mjs --visitors 10 --searches 1000 --offers 250   # Amadeus-sized answers
node ota/backend/test/load/search-load.mjs --visitors 10 --searches 200 --tenants 8     # the credential set's bucket
node ota/backend/test/load/search-load.mjs --help
```

Before a run you record, write down the machine's load (`uptime`, `nproc`). The test prints the load average at its start and end too. A run on a busy machine measures that machine: if a bound is missed while other work runs, run again later and record both runs.

| Option | Default | What it does |
|---|---|---|
| `--visitors <n>` | 10 | Concurrent visitors. Visitor i shops at tenant i mod `--tenants`. |
| `--searches <n>` | 200 | Journeys in all. Each journey is one search, its first results page and the price of its first offer. |
| `--tenants <n>` | 2 | Tenants, 2 to 8. They all share the Velexis test Amadeus account, so they share one credential bucket. |
| `--stub-delay-ms <n>` | 300 | How long the stub holds every answer (the token request too). |
| `--offers <n>` | 0 | Offers in each search answer, 1 to 250. With 0 the answer keeps the 5 offers of the stub's fixture. Amadeus answers up to 250, and the API asks for 250 unless a storefront sets a lower `maxResults`. |
| `--think-ms <n>` | 0 | A visitor's pause between two calls. 0 means each visitor calls as fast as the API answers. |
| `--max-retries <n>` | 2 | Retries of a `429 RATE_LIMITED`, each after its `Retry-After`, with the same `Idempotency-Key`. This is what the SDK does by default. |
| `--warmup <n>` | 1 | Warm-up journeys per visitor, run at the measured concurrency and not counted. |
| `--p95-budget-ms <n>` | 500 | The budget of the `flights.search` p95 without the stub delay. This is the bound of OBE-028. |
| `--redis-db <n>` | 14 | The Redis database of the run. It is emptied before and after the run. Never 0 (`pnpm dev`) and not 15 (the end-to-end stack). Use another number or a Redis of your own when an integration run could be using 14. |
| `--app-env <env>` | `production` | `APP_ENV` of the API. `production` is how the VM runs it. `test` adds the development checks, such as the `search_path` leak guard's query in every tenant transaction. |
| `--json <file>` | — | Also writes the figures as JSON, with every attempt of the measured phase (operation, tenant, status, code, start, duration). |

Exit codes:

- **0:** every answer was expected and the p95 is within the budget. An expected answer is a 2xx, or a `429` of the Amadeus buckets.
- **1:** an unexpected answer, the budget missed, or a run that could not be set up.
- **2:** a usage error.
- **130:** interrupted by Ctrl-C or SIGTERM. The run stops after the step it is in and cleans up; a second signal cleans up at once.

## What a run does

The header of `search-load.mjs` describes each step. In short:

1. **A database for the run.** It builds `velexis_test_tpl_load_<runId>` like the integration tests' template, with the `@velexis/testing` helper. Then it writes each tenant's rows as the platform and provisioning write them: the tenant on its storefront sub-domain (`alpha.ota.example.com`, …), the shared Velexis test Amadeus account, the tenant's own connection with one office, its storefront settings and default markup rule, and one markup rule of its own.
2. **The Amadeus side.** A child process runs the stub (`@velexis/testing/amadeus`) behind a small proxy. The proxy holds every answer for `--stub-delay-ms`, answers each search with `--offers` offers, moves the last ticketing day 60 days ahead, and counts the calls the buckets let through.
3. **The API.** It starts the built API (`ota/backend/dist/main.js`) as systemd starts it on the VM (`NODE_ENV=production`, `--enable-source-maps`, `--max-old-space-size=640`), on a free port. The API gets random key files, an edge secret and a service key of its own. A preload, written into the run's temporary folder, times the `INSERT` and `UPDATE` statements of the shopping tables and the waits for a pooled connection. It also samples the RSS and the event-loop delay. It measures and changes nothing.
4. **The visitors.** Each journey is one storefront visitor with an address of their own (`X-Forwarded-For` in `198.18.0.0/15`, the benchmarking range). That is why the per-address shopping limit of [architecture §8](../../../docs/architecture.md#8-rate-limits) never answers. Each visitor goes through the edge as the hosted storefront does (Caddy's headers, the CSRF cookie and header, an `Idempotency-Key` per call) and makes three calls:
   - `flights.search`: SIMPLE, one adult, `resultOptions.limit: 0`.
   - `flights.listResults`: the first page, 20 offers.
   - `flights.price`: the first offer, with the storefront's `include`.

   Each search has its own route and day, so single flight never joins two searches.
5. **The report and the clean-up.** The test prints the report. Then it stops both processes, drops the database, empties the Redis database and removes the temporary folder, also after Ctrl-C or a SIGTERM sent to the test alone (`kill`, `timeout`).

## Reading the report

| Section | What the figures are |
|---|---|
| Latency of the 2xx answers | Client-side duration of every successful answer, per operation (an attempt answered `429` is not in it). **Without the stub delay** subtracts `--stub-delay-ms` once: what the API and the stub spent. **Without the Amadeus call** subtracts the search row's `duration_ms`, the client's measured Amadeus request: the API's own time, rate limiter, token, database, pricing and storage included. |
| Answers per operation | Every attempt with its status. `429 RATE_LIMITED` is the Amadeus buckets ([`src/amadeus/rate-limiter.ts`](../../src/amadeus/rate-limiter.ts)). A refused search still writes a `failed` row in `flight_searches`: the pending row is inserted before the Amadeus call. |
| Phase | Journeys completed, refused (still `429` after the retries) and failed, throughput, and the requests in flight. The mean is the summed request time over the phase's wall time. |
| Amadeus calls | Calls that reached the stub (the buckets let them through), the stub's own time before the delay, and calls per second (mean and busiest second, searches and prices). |
| Statements of the API | Time of each `INSERT` / `UPDATE` at the API's `pg` client, from sending to answer, with the mean rows. `insert into flight_offers` is the search's multi-row offer insert ([OADR-0002](../../../docs/adr/0002-offer-and-priced-offer-caching.md) point 1). |
| API process | RSS after start, at its peak and at the end, the wait for a pooled connection (`ota-api` pool, 20 connections), and the event-loop delay. |
| Tables after the run | Rows and sizes (table with TOAST, indexes, total) of the shopping tables over all tenants, and the total per completed search. The warm-up's searches are included. |

## Extending it

OBE-088 (M6) extends this script and adds `booking-load.mjs` for mixed traffic on five tenants. Keep a new measurement in the preload or the proxy: the API itself must run unchanged. Keep everything a run creates removable by the clean-up. Keep the output free of keys, tokens, DSNs and request bodies.
