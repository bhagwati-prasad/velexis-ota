# OTA backend load tests

Two load tests of the OTA backend. The figures of each recorded run and what was decided from them are in [`ota/docs/performance.md`](../../../docs/performance.md).

- `search-load.mjs` is the M2 search load test of the OTA API (OBE-028). It answers the follow-ups of [OADR-0001](../../../docs/adr/0001-amadeus-client-design.md) ("load-test the buckets") and [OADR-0002](../../../docs/adr/0002-offer-and-priced-offer-caching.md) ("measure search insert time and table sizes").
- `booking-load.mjs` is the M6 mixed-traffic test of the API **and the worker** against the VM's memory budget (OBE-088; [architecture §3](../../../../docs/mvp/architecture.md#3-hosts-ports-and-the-vm), the follow-up of [OADR-0014](../../../docs/adr/0014-per-tenant-workers-and-schedulers.md)). It reuses the helpers of `search-load.mjs` and is described in [its own section](#booking-loadmjs-mixed-traffic-with-the-worker-obe-088).

Both:

- **Plain Node, no dependency of their own.** They use `fetch` and the workspace packages the OTA backend already has (`@velexis/config`, `@velexis/db`, `@velexis/crypto`, `@velexis/testing`, `ioredis`), and the built API, worker and Amadeus stub.
- **Not part of `pnpm test`, `pnpm test:int` or CI.** A load test measures the machine it runs on, so it runs by hand. Every run is recorded in `performance.md` with the machine, its `nproc` and its load.
- **Local and test only.** They start their own processes against their own scratch database and the Amadeus stub. They never talk to a deployed API, a real Amadeus, a real Stripe, a real mail server or a database they did not create.

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
| `--offers <n>` | 0 | Offers in each search answer, 1 to 250, but never more than the search asked for (see step 2 below). With 0 the answer keeps the 5 offers of the stub's fixture. Amadeus answers up to 250. The API asks for the storefront's `maxResults`, 150 by default since lead decision (15i) of 2026-11-11 (175 since OBE-096 before it; [`performance.md`](../../../docs/performance.md) §5), so `--offers 250` gives answers of 150 offers at the run's tenants, which set no `maxResults` of their own. |
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
   - **Never more offers than asked for.** As Amadeus does, the proxy answers a search with at most the offers it asked for: `max` of a GET search (SIMPLE mode), `searchCriteria.maxFlightOffers` of a POST search (ADVANCED mode), and 250 when the search names neither. So a run measures what the API stores at its storefront limit, not `--offers` itself: with `--offers 250` and the default limit of 150 (175 until lead decision (15i) of 2026-11-11), each answer has 150 offers. This holds for `--offers 0` too: the stub's 5 offers are cut to a smaller `max`.
   - **The report shows it.** The Amadeus section gives the offers the searches asked for and the offers the proxy answered (p50 and maximum), and the answers with more offers than asked for. Such an answer is an unexpected answer: the run exits 1.
3. **The API.** It starts the built API (`ota/backend/dist/main.js`) as systemd starts it on the VM (`NODE_ENV=production`, `--enable-source-maps`, and the unit's `NODE_OPTIONS` `--max-old-space-size=640 --max-semi-space-size=32`, the young generation of 32 MiB per semi-space since 2026-11-06: [`performance.md`](../../../docs/performance.md) §4), on a free port. The API gets random key files, an edge secret and a service key of its own. A preload, written into the run's temporary folder, times the `INSERT` and `UPDATE` statements of the shopping tables and the waits for a pooled connection. It also samples the RSS and the event-loop delay, and reads the API process's CPU time over the measured phase. It measures and changes nothing.
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
| Amadeus calls | Calls that reached the stub (the buckets let them through), the stub's own time before the delay, and calls per second (mean and busiest second, searches and prices). The offers the searches asked for (`max`, `maxFlightOffers`) and the offers the proxy answered, p50 and maximum, and the answers with more offers than asked for (always 0, or the run exits 1). |
| Statements of the API | Time of each `INSERT` / `UPDATE` at the API's `pg` client, from sending to answer, with the mean rows. `insert into flight_offers` is the search's multi-row offer insert ([OADR-0002](../../../docs/adr/0002-offer-and-priced-offer-caching.md) point 1). |
| API process | CPU time over the measured phase (user and system, `process.cpuUsage()`) and per completed journey (the refused journeys' attempts are in the total too), RSS after start, at its peak and at the end, the wait for a pooled connection (`ota-api` pool, 20 connections), and the event-loop delay. |
| Tables after the run | Rows and sizes (table with TOAST, indexes, total) of the shopping tables over all tenants, and the total per completed search. The warm-up's searches are included. |

## booking-load.mjs: mixed traffic with the worker (OBE-088)

### Run it

The same set-up as `search-load.mjs` above. Its Redis figures are those of the whole Redis server, so run it on a Redis of its own, started as the VM's (`maxmemory 512mb`, `noeviction`), and on a database server no integration suite is using at the time. On a shared development machine, take the machine-wide end-to-end lock so no end-to-end run shares the CPUs, and write down `nproc` and the load:

```bash
pnpm build --filter=@velexis/ota-backend...
redis-server --port 6390 --bind 127.0.0.1 --requirepass dev_redis --save '' --appendonly no \
  --maxmemory 512mb --maxmemory-policy noeviction --daemonize yes      # a Redis of the run's own (a free port)
export REDIS_URL=redis://:dev_redis@127.0.0.1:6390/0
nproc; uptime
node ota/backend/test/load/booking-load.mjs --tenants 5 --minutes 30                  # the run of the plan (Verify)
node ota/backend/test/load/booking-load.mjs --minutes 5 --window-minutes 1            # a short run while developing
redis-cli -p 6390 -a dev_redis shutdown nosave
```

| Option | Default | What it does |
|---|---|---|
| `--tenants <n>` | 5 | Tenants, 2 to 8, served in turn. |
| `--minutes <n>` | 30 | Minutes of measured traffic, after a warm-up of one journey of each kind per tenant. |
| `--shoppers-per-minute <n>` | 120 | Shopper journeys started per minute: `flights.search`, its first results page (20 offers), `flights.price` of the first offer. |
| `--bookings-per-minute <n>` | 4 | Booker journeys started per minute: the shopper's three calls, then the checkout paid by airline card (below). At most one per tenant: the airline card allows 60 completions an hour per tenant (`airlineCardPerTenant`, [architecture §8](../../../docs/architecture.md#8-rate-limits)). |
| `--staff-per-minute <n>` | 30 | Staff journeys started per minute: `console.bookings.list`, `console.bookings.get` of the first, `console.payments.list`, `console.supplierRequests.list`. |
| `--think-ms <n>` | 1000 | A pause between two calls of a journey. |
| `--offers <n>` | 250 | Offers in each search answer, never more than the search asked for, as in `search-load.mjs`. With the default, each answer has the storefront limit's offers (`DEFAULT_OFFERS_PER_SEARCH`). |
| `--stub-delay-ms <n>` | 300 | How long the stub holds every answer. |
| `--deferred-ticketing-every <n>` | 4 | Every n-th booking's Flight Create Orders comes back without tickets (the stub's `ticketing-failed`), and the run makes it a card-paid issuance retry for the worker (below). 0: never. |
| `--timeout-every <n>` | 25 | Every n-th booking's Create Orders answer is lost (the stub's `timeout`: the order is written, the answer is a 504 after 30 s), so the worker reconciles it. 0: never. |
| `--max-retries <n>` | 2 | Retries of a `429 RATE_LIMITED`, as the SDK. |
| `--max-in-flight <n>` | 400 | Journeys at once. A journey due while that many run is skipped, and the run fails: the load was not delivered. |
| `--queue-budget-s <n>` | 60 | The longest wait allowed for an `ota-ticketing` or `ota-bookings` job (OBE-088's acceptance). |
| `--sample-s <n>` | 5 | Seconds between two samples of the processes, PostgreSQL, Redis and the worker's queues. |
| `--window-minutes <n>` | 5 | Minutes per row of the timeline. |
| `--redis-db <n>` | 13 | The Redis database of the run, emptied before and after. Not 14 (`search-load.mjs`) or 15 (the end-to-end stack). |
| `--app-env <env>` | `production` | `APP_ENV` of the API and the worker. |
| `--json <file>` | — | Also writes the figures, the samples and every attempt of the measured phase as JSON. |

Exit codes: **0** when every answer was expected, no journey was skipped or still running 120 s after the last one started, the API's and the worker's RSS stayed within their `MemoryMax`, and no `ota-ticketing` or `ota-bookings` job waited longer than `--queue-budget-s`, with jobs of both queues measured once a fixture had made their work due long enough before the end (6 minutes for `ota-ticketing`, 11 for `ota-bookings`: a run shorter than about 15 minutes may measure none, and then says so without failing); **1** otherwise, or when the run could not be set up; **2** a usage error; **130** interrupted.

### What a run does

The header of `booking-load.mjs` describes each step. In short:

1. **The tenants** of `search-load.mjs`, and what a booking needs: the shared Amadeus account's `base_url` is the run's proxy (the worker has no `AMADEUS_BASE_URL_*` override), and each tenant has the Velexis Stripe test connection, two staff members (`agent`, MFA on) and, in its storefront settings, the airline card on for the test environment, an alert address and a booking queue (50, category 0).
2. **The Amadeus side.** The stub behind `search-load.mjs`'s proxy. The proxy picks the stub scenario of each Flight Create Orders from the first traveller's last name, which the booking journey chose: `DEFERRED` (`ticketing-failed`), `LATECOMER` (`timeout`), anything else the normal answer, an issued order.
3. **An SMTP sink** in a child process takes the worker's e-mails and keeps only their number and size.
4. **The API and the worker**, built, each started as its systemd unit starts it: `APP_ENV` and `NODE_ENV` `production`, `--enable-source-maps`, the API with `--max-old-space-size=640 --max-semi-space-size=32` and the worker with `--max-old-space-size=400`. Both run with `search-load.mjs`'s preload. The worker's copy also wraps BullMQ's `Worker#emit`: for every job a worker takes, how long it waited from the moment it was due (added, or its delay over) to its first attempt, and how long each attempt ran. A retry is counted but not timed, since its backoff is not in the job.
5. **The traffic.** Each kind of journey starts at its own fixed rate, evenly spread, the tenants in turn (an open model: a slow answer does not slow the arrivals). A booker goes through the edge as the hosted storefront does: the shopper's three calls, `checkout.create`, the traveller and the contact, `checkout.createPayment {method: "airline_card"}`, the card hint (`checkout.updatePayment`, which quotes the card fee), `checkout.get`, `checkout.completeWithAirlineCard` with Visa's documented test card, and `bookings.get` with the guest cookie the completion set. Staff sign in once through the OTA admin's service key with a portal token, as `console-access.int.test.ts` does, and refresh their session every 10 minutes.
6. **Two fixtures, once a minute.** The run cannot reach Stripe, and a fresh booking is not due for the booking sync for 6 hours, so it writes what the API cannot:
   - **The sync.** Every booking with an order is made to look last synchronised 7 hours ago (`last_synced_at`), and its last sync claim, if it has one, as old (`sync_claimed_at`: the scan skips a booking claimed in the last 30 minutes, `BOOKING_SYNC_RETRY_MS`; a claim of the last 2 minutes, a sync that may still run, is left alone). So each `bookings.sync_scan` (every 10 minutes) enqueues its most: every such booking, up to 20 `booking.sync` jobs per tenant.
   - **Ticketing.** An airline-card booking without tickets goes to the staff (`manual_review`) and never to the ticketing job ([`ticketing.service.ts`](../../src/bookings/ticketing.service.ts)). So the run rewrites each such booking as the card path leaves a booking whose Flight Order Issue failed after the capture: the payment `stripe`/`card`, captured, the booking paid, ticketing `failed` and due now. The next `ticketing.scan` (every 5 minutes) enqueues its `ticketing.issue`, which issues the stub's order.

   Both write as `velexis_ota_app`, through `tenantTx`, as the API does. The report counts the rows they changed.
7. **Samples** every `--sample-s` seconds: the API's and the worker's RSS, the client connections of the run's database by application (`pg_stat_activity`, read as `velexis_ota_app`, so it sees the state of the API's and the worker's sessions; the sampling connection itself and PostgreSQL's own processes, such as autovacuum, are not counted), Redis's memory, clients and keys, the worker's `/health/ready` queues (waiting jobs, the oldest wait, the failures of the last hour: the on-VM check's signal) and the 1-minute load average.
8. **The report and the clean-up**, as in `search-load.mjs`. The documents the worker rendered are in the run's temporary folder and go with it.

### Reading the report

| Section | What the figures are |
|---|---|
| Header | The run, the machine with `nproc`, the 1-minute load average at the start and the end and its mean and maximum over the measured phase, the load, and the journeys per kind (completed / started, refused, failed), the journeys skipped and still running at the end, how late at most a journey started after its time (the run's own delay), the bookings by kind, the journeys and requests in flight and the rows the fixtures changed. |
| Latency | Client-side time of each operation's expected answers: 2xx, and the `504 SUPPLIER_TIMEOUT` of a lost Create Orders answer (its own row). `flights.search without the stub delay` subtracts `--stub-delay-ms` once, as in `search-load.mjs`. |
| Answers per operation | Every attempt with its status. |
| Amadeus calls | Every call through the proxy by operation and status, with the stub scenarios the proxy sent. |
| E-mails | The SMTP sink's messages, recipients and size. |
| API, Worker | CPU over the phase (and as a share of one core), RSS at the start of the phase (after the warm-up), at its peak and at the end against the unit's `MemoryMax` (768 and 512 MiB), the heap used, the pool waits and the event-loop delay. |
| PostgreSQL, Redis | The most connections to the run's database, by application, against the pools (API 20, worker 10) and `max_connections` (100 on the VM); Redis's used memory at the start, at the peak and at the end against the VM's `maxmemory` of 512 MiB, its clients and the run's keys. Then `MEMORY USAGE` of every key of the run at the end, by kind (BullMQ jobs, the queues' events streams, their other keys, the application's keys), the bytes of one job, and what a day of completed jobs at the run's rate holds: completed jobs stay in Redis for a day (ADR-0009 item 7). Last, the jobs kept by queue and name, with the bytes of one of each. |
| Queue latency | Per queue and per job name: the jobs started, the retries, the failed attempts, the wait from due to the first attempt (p50, p95, max) and the run time of an attempt (p95, max). The health columns are the most waiting jobs and the oldest wait the worker's `/health/ready` reported. The verdict compares `ota-ticketing` and `ota-bookings` with `--queue-budget-s`. |
| Database | The database's size after the warm-up and at the end, the largest tenant tables (all tenants together: rows, size and growth), the bookings by status, ticketing status and reconciliation outcome, the notifications by status and the documents by kind, and the document storage. |
| Timeline | One row per `--window-minutes`: completed journeys and bookings started in the window, the p95 of `flights.search`, `flights.price`, the completion and `console.bookings.list`, the most RSS of the API and the worker, connections and Redis memory, the longest wait of the main queues, and the 1-minute load average (mean/max). |

## Extending them

Keep a new measurement in the preload, the proxy or the sink: the API and the worker themselves must run unchanged. Keep everything a run creates removable by the clean-up. Keep the output free of keys, tokens, card data, DSNs and request bodies.
