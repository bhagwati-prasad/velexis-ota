# OTA performance

This page records measured figures of the OTA backend and the decisions taken from them. Each run names its date, the code it ran, the machine and how busy that machine was.

- OBE-028 started the page with the M2 search load test and the decision on the Amadeus buckets.
- OBE-088 adds the M6 measurements against the VM's memory budget ([architecture §3](../../docs/mvp/architecture.md#3-hosts-ports-and-the-vm)).

Related:

- [`../backend/test/load/README.md`](../backend/test/load/README.md): how to run the load test and read its report.
- [OADR-0001](adr/0001-amadeus-client-design.md): the Amadeus client and its buckets.
- [OADR-0002](adr/0002-offer-and-priced-offer-caching.md): offers in PostgreSQL.
- [ADR-0012](../../docs/mvp/adr/0012-amadeus-account-model.md): the shared Amadeus account.

## 1. How a run is recorded

- Run the load test as its README says, with `--json` to keep the figures.
- Add a row to the run table of its section. The row has:
  - the start time (UTC);
  - the code that ran;
  - the options;
  - the machine's 1-minute load average at the start and at the end. The test prints both; `uptime` and `nproc` before the run show the same.
- The runs below were made on a shared development machine while other test suites ran on it. A run is only comparable with runs on the same machine. When a bound is missed while the load average is high, run again later and record both runs.
- Times are in milliseconds unless a column says otherwise. Percentiles are nearest-rank, over the 2xx answers of the measured phase.

## 2. M2 search load test (OBE-028, 28 October 2026)

### Set-up

| Item | Value |
|---|---|
| Code | The API built from `526cf091709e`, the integration branch head this task started from, with `search-load.mjs` of this task. The script prints `526cf091709e+changes` for the later runs: that marks this task's documentation and comment edits, which were not committed yet. The API that ran is the same build. A3 ran the same API code with the committed task; its script differs only in how it cleans up after a signal. |
| Machine | 4 vCPUs (Intel Xeon @ 2.80 GHz), 15.7 GiB RAM, Linux 6.18 x64. Node 22.22.0, PostgreSQL 16.15, Redis 7.0.15 (a private instance for the runs). Run A3, the review's re-run of the Verify command at 08:08 UTC, ran after the machine had restarted on a slower host: 4 vCPUs (Intel Xeon @ 2.10 GHz), the same memory and versions. |
| API | The built API, started as systemd starts it on the VM: `NODE_ENV=production`, `--enable-source-maps`, `--max-old-space-size=640`. It has the pool of 20 connections and writes `LOG_LEVEL=info` to a file. |
| Amadeus | The stub behind the load test's proxy. Every answer is held 300 ms. A search answer has the stub's 5 offers, or `--offers` offers. |
| Tenants | `alpha` (net + 10 %) and `beta` (net + 5.00 EUR per booking), one office each, on the shared Velexis test account. `--tenants 8` adds six more tenants on the same account. |
| Visitors | Storefront visitors through the edge. Each journey has its own address and makes three calls: a search, its first results page (20 offers) and the price of its first offer. A `429` is retried after its `Retry-After`, at most twice, as the SDK does. There is no pause between calls unless the run says otherwise. |

### Runs

Each search answer has 5 offers unless the row says otherwise. Every run had 0 unexpected answers.

**Runs and latency.** "−delay" subtracts the 300 ms stub delay. "−Amadeus" subtracts the search row's `duration_ms`, which leaves the API's own time.

| Run | Started (UTC) | Options | Load avg start → end | Journeys completed / refused | search p50 / p95 | **search p95 −delay** | search p95 −Amadeus | listResults p95 | price p95 −delay |
|---|---|---|---|---|---|---|---|---|---|
| A1 | 04:12:08 | `--visitors 10 --searches 200` (the Verify command) | 0.25 → 0.79 | 189 / 11 | 352 / 512 | **212** | 203 | 91 | 164 |
| A2 | 04:25:24 | the same, final script | 0.76 → 1.09 | 184 / 16 | 359 / 505 | **205** | 199 | 72 | 160 |
| A3 | 08:08:53 | the same, the review's re-run on the 2.10 GHz host | 2.27 → 2.92 | 187 / 13 | 369 / 533 | **233** | 225 | 73 | 235 |
| B | 04:13:12 | `--offers 50` | 0.62 → 0.33 | 185 / 15 | 387 / 760 | **460** | 448 | 108 | 200 |
| C | 04:13:59 | `--offers 250` | 0.33 → 1.38 | 200 / 0 | 895 / 1 272 | **972** | 935 | 146 | 400 |
| D | 04:24:08 | `--visitors 1 --searches 50 --offers 250` | 2.39 → 1.16 | 50 / 0 | 466 / 514 | **214** | 204 | 39 | 70 |
| E | 04:14:57 | `--tenants 8` | 1.24 → 0.93 | 200 / 0 | 426 / 510 | **210** | 195 | 74 | 186 |
| F | 04:15:30 | `--think-ms 1000` | 0.93 → 0.36 | 200 / 0 | 358 / 413 | **113** | 108 | 35 | 87 |
| G | 04:16:59 | `--searches 1000` | 0.36 → 1.79 | 964 / 36 | 350 / 387 | **87** | 83 | 27 | 79 |
| H | 04:20:24 | `--searches 1000 --offers 250` | 1.79 → 2.89 | 995 / 5 | 801 / 1 245 | **945** | 884 | 138 | 584 |

The options of each run are added to `--visitors 10 --searches 200` unless they name `--visitors` or `--searches` themselves.

**Buckets and resources.** The 429 share is the share of attempts answered `429`. Calls per second are the search and price calls the buckets let through to Amadeus. In flight is the mean number of requests the visitors had open, with the most in brackets.

| Run | 429 share search / price | Amadeus calls/s mean / busiest second | Journeys/s | In flight mean (max) | Offer insert p50 / p95 (rows) | API RSS after start → peak (MiB) | Event-loop delay p99 / max | Pool wait max |
|---|---|---|---|---|---|---|---|---|
| A1 | 37.8 % / 36.1 % | 10.2 / 20 | 5.0 | 4.0 (10) | 1.7 / 5.7 (5) | 262 → 280 | 13 / 32 | 15 |
| A2 | 37.2 % / 37.0 % | 10.3 / 20 | 5.1 | 4.1 (10) | 1.8 / 5.8 (5) | 253 → 272 | 14 / 47 | 30 |
| A3 | 35.0 % / 37.5 % | 10.2 / 20 | 5.0 | 4.3 (10) | 1.8 / 7.1 (5) | 262 → 281 | 14 / 43 | 110 |
| B | 38.0 % / 33.2 % | 10.4 / 20 | 5.1 | 4.5 (10) | 8.3 / 22.8 (50) | 259 → 282 | 18 / 52 | 39 |
| C | 20.9 % / 13.8 % | 10.2 / 20 | 5.1 | 7.7 (10) | 45.3 / 113.1 (250) | 260 → 297 | 73 / 163 | 64 |
| D | 0 % / 0 % | 2.3 / 3 | 1.2 | 1.0 (1) | 29.0 / 45.5 (250) | 256 → 281 | 46 / 89 | 1 |
| E | 2.9 % / 7.0 % | 19.9 / 25 | 9.9 | 8.6 (10) | 2.5 / 6.8 (5) | 261 → 281 | 14 / 46 | 2 |
| F | 0 % / 0 % | 5.3 / 10 | 2.7 | 2.0 (10) | 2.0 / 4.4 (5) | 255 → 272 | 12 / 92 | 24 |
| G | 37.2 % / 40.3 % | 10.0 / 20 | 5.0 | 3.8 (10) | 1.5 / 4.0 (5) | 258 → 281 | 13 / 56 | 20 |
| H | 23.2 % / 13.6 % | 10.0 / 20 | 5.0 | 7.7 (10) | 47.2 / 110.4 (250) | 261 → 299 | 75 / 222 | 231 |

**Rows and table sizes after 1 000 searches.** These are runs G and H, with the warm-up's searches, over both tenants. "Per search" is the total size divided by the completed searches. A refused search attempt also stores a `failed` search (item 6 below).

| Table | G: rows | G: total MiB | G: KiB per search | H: rows | H: table / index / total MiB | H: KiB per search |
|---|---|---|---|---|---|---|
| `flight_searches` | 1 565 (987 completed) | 3.3 | 3.4 | 1 309 (1 007 completed) | 2.8 / 0.4 / 3.2 | 3.2 |
| `flight_offers` | 4 935 | 11.5 | 11.9 | 251 750 | 491.9 / 115.1 / 607.1 | 617.3 |
| `priced_offers` | 974 | 5.0 | 5.2 | 1 005 | 5.0 / 0.3 / 5.3 | 5.4 |
| `supplier_requests` | 1 961 | 7.8 | 8.1 | 2 012 | 12.0 / 1.0 / 13.0 | 13.2 |
| `idempotency_keys` | 1 961 | 9.5 | 9.8 | 2 012 | 9.0 / 0.7 / 9.7 | 9.9 |

### What the runs show

1. **The bound of OBE-028 holds for the planned set-up.** With the stub's answers and 10 concurrent visitors, the `flights.search` p95 without the stub delay was 212 ms and 205 ms (A1, A2), and 233 ms on the slower, busier host of A3. The budget is 500 ms. It was 210 ms with eight tenants (E), where the buckets let more through and the API had 8.6 requests in flight on average. The bursts set the p95: after a `429`, the visitors wait 1 s and come back together, and ten searches then share the event loop. The 1 000-search run (G) spreads them more and gives 87 ms.

2. **The size of the Amadeus answer decides the API's time.** At 10 visitors, the p95 without the stub delay is:
   - 205–212 ms with 5 offers per answer;
   - 460 ms with 50 offers (B);
   - 945–972 ms with 250 offers (C, H).

   A single visitor with 250 offers stays at 214 ms (D). So the time is CPU, not waiting: a 250-offer search costs the API about 150 ms of CPU, and ten of them queue on the one event loop (event-loop delay p99 73–75 ms in C and H). Amadeus answers up to 250 offers, and the API asks for 250 unless a storefront sets a lower `maxResults`. With real answers of that size, 10 simultaneous searches therefore miss the budget. **Follow-up task OBE-092** in the plan (§4) covers it.

   This is where the CPU goes. The API was profiled with the inspector during 60 journeys of 2 visitors with 250 offers, 10.1 s of busy CPU in all. The shares overlap, because `decimal.js` runs inside the pricing engine and the facets.

   | Share | Where |
   |---|---|
   | 23 % | The `supplier_requests` copy of the search answer. The redactor and the contact masking walk the whole answer (about 300 KB with the stub's offers) before the row is cut to 64 KB ([OADR-0001](adr/0001-amadeus-client-design.md) point 9). |
   | 18 % | The database driver: Kysely compiling, `pg` serialising the 250-row insert, the protocol. |
   | 14 % | Facets and highlights. |
   | 13 % | `decimal.js`, in pricing and facets. |
   | 8 % | Garbage collection. |
   | 5 % | Offer parsing and summary columns. |
   | 4 % | The pricing engine itself. |
   | 3 % | Request validation and idempotency. |
   | 2.5 % | New ids. |
   | 2 % | Parsing the Amadeus answer. |

3. **The search insert is not the bottleneck.** The multi-row insert of a search's offers took these times:

   | Offers | Alone | 10 visitors |
   |---|---|---|
   | 5 | — | 1.5–2.5 ms (p50) |
   | 50 | — | 8.3 ms p50, 23 ms p95 |
   | 250 | 29 ms p50, 46 ms p95 (D) | 45–47 ms p50, 110–113 ms p95 (C, H) |

   Most of the 250-row figure under load is waiting for the event loop that also prices and maps the other searches. Partitioning `flight_offers` by day ([db README §9](../../docs/velexis-sdk/db/README.md), the OADR-0002 follow-up) is not needed for insert time.

4. **The tables stay small enough while the purge runs.** Offers are kept for the offer lifetime (30 minutes by default), and `offers.purge` runs every 15 minutes. So `flight_offers` holds at most about the last 45 minutes of searches. At 617 KiB per search with 250 offers (H), 1 000 searches an hour leave about 450 MiB of live offers; at 5 offers it is 12 KiB per search. The longer-lived rows per journey are:
   - `supplier_requests`: about 13 KiB, kept 90 days. That is about 1.1 GiB per 1 000 journeys a day.
   - `idempotency_keys`: about 10 KiB, kept 24 hours.

   OBE-088 checks these against the VM's disk and the PostgreSQL memory budget. Nothing here needs partitioning at MVP volumes. Revisit it if sustained traffic goes above about 2 000 searches an hour with large answers, which is about 1 GiB of live offers.

5. **Memory and connections are far from their limits.**
   - Memory: the API's RSS was 253–262 MiB after start and at most 299 MiB in every run. Its `MemoryMax` is 768 MiB, and the V8 heap limit 640 MB.
   - Connections: a wait for one of the 20 pooled connections was below 1 ms at p95 in every run. The longest wait, 231 ms in H, came at a burst when new connections were opened while the event loop was busy.

6. **A refused search still writes.** The pending `flight_searches` row is inserted before the Amadeus call, so a search the buckets refuse leaves a `failed` row with `RATE_LIMITED`, and a retry leaves another one. A2 stored 314 searches for 201 completed. The rows are small (a few KiB) and are purged with the other searches. This is noted, not a task: revisit it if the buckets refuse often in production.

## 3. The Amadeus buckets: kept

**Decision (OBE-028, 28 October 2026):** the bucket constants of [`ota/backend/src/amadeus/limits.ts`](../backend/src/amadeus/limits.ts) stay as they are:

- the credential set: 20 per second, burst 20;
- each tenant: 5 per second, burst 10.

The data did not show a reason to change them.

- **The tenant bucket refuses only what is above its rate.** With no pause between calls, the ten visitors of A, B and G asked for about 16 search and price calls a second, about 8 per tenant. The buckets let through 10 a second (5 per tenant), and 20 in the busiest second (both tenants' bursts). They answered `429` to 33–40 % of the attempts. With the SDK's two retries, 4–8 % of the journeys were still refused. That is the bucket's job: no OTA goes above 5 calls a second on the shared account.
- **The credential bucket paces the account when many tenants are busy.** With eight tenants (E), no tenant reached its own rate. The account's bucket let through 19.9 calls a second, and 25 in the busiest second (its burst of 20 plus the refill). It refused 3–7 % of the attempts, and no journey was refused in the end.
- **Real visitors stay well below the limits.** With a 1 s pause between calls (F), the same ten visitors made 5.3 calls a second and got no `429`. A storefront visitor makes about two Amadeus calls per search and price (three with an upsell), spread over tens of seconds. 5 calls a second per tenant is 300 a minute, about 150 search-and-price journeys a minute for one OTA. That is far above what an OTA of the MVP expects. The burst of 10 lets five visitors search and price in the same second.
- **A larger tenant bucket would weaken what it protects.** It would let one OTA take a larger share of the shared account's quota, which the tenant bucket exists to protect ([ADR-0012](../../docs/mvp/adr/0012-amadeus-account-model.md)). Where the API itself was the limit (250 offers: C, H), it slowed the visitors before the buckets did. The 429 share then fell to 14–23 %.
- **The credential set's 20 per second is a planning figure.** The stub cannot tell the real quota of the Velexis account. When Amadeus answers `429` before our buckets do, the client logs `amadeus.quota_exceeded`, and that is the signal to lower it. The comment at the constants in `limits.ts` says so.
- **The timeouts cannot be measured against the stub.** They stay as planned until the Amadeus test environment shows its latencies.

A refused visitor waits the full second of `Retry-After`, even though the tenant bucket has a token again within 200 ms. `Retry-After` is in whole seconds, at least 1 (`retryAfterSeconds` of the rate limiter), so this is not a bucket constant. It stays as it is.

## 4. Follow-ups

| Task | What |
|---|---|
| OBE-092 (M6) | Added by OBE-028. Cut the API's CPU per search so that answers of 250 offers meet the 500 ms p95 at 10 concurrent visitors. The largest shares are the `supplier_requests` copy of the whole answer, facets, `decimal.js` and the driver (§2 item 2). If it cannot be met, this page records the decision needed: a lower default `maxResults`, a worker thread or a second API process. |
| OBE-088 (M6) | Mixed traffic on five tenants for 30 minutes with the worker running; the API's and the worker's RSS against `MemoryMax`, PostgreSQL connections, Redis memory, queue latency; the table growth of §2 item 4 against the VM's disk. |
