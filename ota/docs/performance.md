# OTA performance

This page records measured figures of the OTA backend and the decisions taken from them. Each run names its date, the code it ran, the machine and how busy that machine was.

- OBE-028 started the page with the M2 search load test and the decision on the Amadeus buckets.
- OBE-092 cut the API's CPU per search of 250 offers (§4).
- FIX-W46-SHARED gave the API a larger young generation, decision (a) of §4, and measured it (§4, Step 4).
- OBE-096 took decision (b) of §4: a storefront without its own `maxResults` asks Amadeus for 175 offers per search, the largest number measured within the search budget (§5).
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

   A single visitor with 250 offers stays at 214 ms (D). So the time is CPU, not waiting: a 250-offer search costs the API about 150 ms of CPU, and ten of them queue on the one event loop (event-loop delay p99 73–75 ms in C and H). Amadeus answers up to 250 offers, and the API asked for 250 unless a storefront set a lower `maxResults` (175 by default since OBE-096, §5). With real answers of that size, 10 simultaneous searches therefore miss the budget. **Follow-up task OBE-092** in the plan (§6) covers it; §4 has its runs.

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

## 4. Search CPU with answers of 250 offers (OBE-092, 6 November 2026)

OBE-092 cut the API's CPU per search without changing what any operation answers or what it stores in the offer tables. Offers stay in PostgreSQL only ([OADR-0002](adr/0002-offer-and-priced-offer-caching.md)), and every stored `supplier_requests` body still goes through the redactor and is cut to 64 KB ([OADR-0001](adr/0001-amadeus-client-design.md) point 9).

### Set-up

| Item | Value |
|---|---|
| Code | **Before:** the API built from `37d2b533aa63`, the integration branch head this task started from. **After:** the same build with this task's three source files (`supplier-requests.repository.ts`, `facets.ts`, `searches.service.ts`). The two builds were swapped between runs of the same `search-load.mjs`, so the script prints `37d2b533aa63+changes` for both; the tables name the build that ran. |
| Machine | 4 vCPUs (Intel Xeon @ 2.10 GHz), 15.7 GiB RAM, Linux 6.18 x64, Node 22.22.0, PostgreSQL 16.15, Redis 7.0.15 (a private instance). The machine is shared with other agents' builds and end-to-end runs: the paired runs below held the machine-wide end-to-end lock and started only once the 1-minute load average was below 1.0. |
| API, Amadeus, tenants, visitors | As in §2. |
| CPU time | For the paired runs, a copy of the script (not committed) also recorded the API process's CPU time (`process.cpuUsage()`, user and system) from the start to the end of the measured phase. The API itself ran unchanged. |

### Step 1: where the CPU went before

The API of `37d2b533aa63` was profiled with the inspector (sampling every 0.25 ms) during the measured phase of `--visitors 10 --searches 200 --offers 250`: 21.9 s of busy CPU over 192 searches, 192 results pages and 190 prices. The shares overlap: `decimal.js` runs inside the facets and the pricing engine.

| Share | Where | §2 (OBE-028) |
|---|---|---|
| 20.7 % | The `supplier_requests` copy of the search answer: the redactor 10.4 %, the contact masking 8.0 %, the JSON text and the cut the rest. | 23 % |
| 11.0 % | The database driver: Kysely 6.6 %, `pg` 4.4 %, over the 30 or so queries of a journey and the 250-row insert (compiling and serialising that insert alone takes about 2 ms). | 18 % |
| 13.0 % | Facets 6.8 % (at insert and on every results page), highlights 4.4 %, the best score 1.8 %. | 14 % |
| 11.6 % | `decimal.js`, 80 % of it called from `facets.ts` (a new `Money` per row, per filter group and per comparison of a sort), the rest from the pricing engine. | 13 % |
| 8.9 % | Garbage collection. | 8 % |
| 3.4 % | The pricing engine. | 4 % |
| 2.7 % | Logging. | – |
| 2.3 % | Offer parsing. | 5 % |
| 2.2 % | New ids. | 2.5 % |
| 1.7 % | Parsing the Amadeus answer. | 2 % |

This confirms the shares of §2. A micro-benchmark of the same functions on one 250-offer answer (315 KB of JSON, the load test's), one core, gave:

| Function, per search | Before | After |
|---|---|---|
| `supplierRequestBody` of the answer | 18.6 ms | 4.7 ms |
| `computeFacets` at insert (no filter) | 2.7 ms | 0.5 ms |
| `computeFacets` of a results page with filters | 3.7 ms | 0.5 ms |
| `highlightsOf` | 3.4 ms | 0.2 ms |
| `bestScores` | 2.1 ms | 0.7 ms |

Each function answers exactly what it answered before: the benchmark compared the stored body (but for the `bytes` of a truncated one, Step 2), the scores, both facets and the highlights of the two builds, and the unit tests compare them with the whole-body redaction, `matchesFilters` and the formulas.

### Step 2: what changed

- **The stored copy of a large body is built from its first part.** `supplierRequestBody` copies, in the order of the body's JSON text, a little more than the row keeps (72 KB: `firstPartOf`), runs the redactor and the contact masking on that copy only, and stores the first part of its JSON text as the preview. Both steps decide each value by the keys above it alone, so that text is the start of what the whole body would give: the preview is the same, and everything stored went through the redactor. When the redaction leaves the first part at 64 KB or less, the copy is taken again twice as long, up to the whole body. A body of at most 72 KB, or one JSON cannot write as it is (a cycle), is redacted whole as before.
  - The redactor now walks about 74 KB of a 315 KB answer instead of all of it.
  - The masking writes into the redactor's fresh copy instead of copying it again, skips the address expression in texts without an `@`, and caches normalised keys (those of up to 64 characters, 4096 at most). It writes the same text as the copying masking, a `Date` of the body included.
  - `bytes` of a truncated body is now the size of the body's JSON text as the client hands it over, not of its redacted copy, which is no longer built whole. It was always informative only; the preview, `truncated` and the 64 KB bound are unchanged.
- **Facets, highlights and the best score read each selling total once.** `computeFacets` parses each row's selling total once and checks its filters once, then counts each group from the checks the row failed, instead of a `matchesFilters` call (with its own `Money`) per row and group and a new `Money` per row and bucket. `highlightsOf` picks the first row by one scan over keys read once, instead of three sorts that built two `Money` values per comparison. `bestScores` computes each weighted part once per price and per duration, with the same operations.
- **A results page parses each offer once** for its codes and its upsell offers, instead of twice.

What is left is outside these files: the driver and Kysely for the 250-row insert, garbage collection, the pricing engine, new ids and logging.

### Step 3: the runs

Every run has `--visitors 10 --searches 200 --offers 250` (the Verify command) unless the row says otherwise, and 0 unexpected answers. K1 to K8, Y1, Y2, D1 and D2 held the end-to-end lock and started at a 1-minute load average below 1.0. K0 is the first run of this task. U1 and U2 ran without the lock while another agent's builds were starting. R1 is the second-agent review's run of the Verify command (the after build with the review's changes, which leave the answers and the work per search as they were): it held the lock and started at a 1-minute load average of 1.37, after a busier quarter of an hour (5-minute average 5.0). Y1 and Y2 ran the after build with `--max-semi-space-size=32` added to the API's start command (copy of the script only). D1 and D2 are one visitor, `--visitors 1 --searches 50 --offers 250`, as run D of §2.

| Run | Build | Started (UTC) | Load avg start → end | Journeys completed / refused | search p50 / p95 | **search p95 −delay** | search p95 −Amadeus | listResults p95 | price p95 −delay | API CPU (s) | CPU per journey (ms) | Event-loop delay p99 / max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| K0 | before | 07:02:50 | 0.24 → 0.74 | 177 / 23 | 504 / 1 006 | **706** | 678 | 120 | 227 | – | – | 42 / 93 |
| K1 | before | 07:57:42 | 1.24 → 0.88 | 182 / 18 | 547 / 1 159 | **859** | 814 | 136 | 233 | 26.5 | 146 | 46 / 157 |
| K2 | after | 07:58:30 | 0.88 → 1.15 | 176 / 24 | 424 / 804 | **504** | 464 | 98 | 209 | 21.4 | 122 | 26 / 50 |
| K3 | before | 07:59:25 | 0.97 → 1.19 | 180 / 20 | 649 / 1 069 | **769** | 722 | 133 | 222 | 25.4 | 141 | 47 / 130 |
| K4 | after | 08:00:26 | 0.93 → 1.51 | 178 / 22 | 435 / 819 | **519** | 486 | 104 | 266 | 21.5 | 121 | 26 / 49 |
| K5 | before | 08:01:41 | 0.92 → 1.08 | 189 / 11 | 669 / 1 170 | **870** | 758 | 134 | 230 | 25.2 | 133 | 49 / 111 |
| K6 | after | 08:02:40 | 0.92 → 1.19 | 181 / 19 | 428 / 733 | **433** | 404 | 92 | 175 | 21.1 | 117 | 25 / 81 |
| K7 | after | 08:05:46 | 0.30 → 1.08 | 179 / 21 | 435 / 919 | **619** | 613 | 95 | 291 | 21.8 | 122 | 27 / 62 |
| K8 | after | 08:07:22 | 0.83 → 1.26 | 185 / 15 | 423 / 826 | **526** | 505 | 89 | 196 | 22.3 | 121 | 26 / 83 |
| U1 | after | 07:29:11 | 3.05 → 1.77 | 179 / 21 | 423 / 831 | **531** | 493 | 92 | 199 | – | – | 26 / 51 |
| U2 | after | 07:29:57 | 1.77 → 1.30 | 182 / 18 | 420 / 756 | **456** | 428 | 92 | 169 | – | – | 25 / 46 |
| Y1 | after, `--max-semi-space-size=32` | 08:06:37 | 0.99 → 0.83 | 179 / 21 | 431 / 809 | **509** | 471 | 90 | 174 | 20.3 | 113 | 25 / 70 |
| Y2 | after, `--max-semi-space-size=32` | 08:08:23 | 0.98 → 0.87 | 186 / 14 | 408 / 736 | **436** | 403 | 80 | 175 | 19.3 | 104 | 23 / 48 |
| D1 | before, one visitor | 08:10:16 | 0.47 → 0.60 | 50 / 0 | 421 / 454 | **154** | 147 | 27 | 58 | 8.9 | 178 | 31 / 55 |
| D2 | after, one visitor | 08:11:05 | 0.60 → 0.64 | 50 / 0 | 391 / 417 | **117** | 111 | 23 | 50 | 7.0 | 140 | 18 / 41 |
| R1 | after, with the review's changes | 11:23:00 | 1.37 → 1.41 | 180 / 20 | 431 / 811 | **511** | 458 | 87 | 196 | – | – | 26 / 60 |

The API's RSS was 252–258 MiB after start and at most 296 MiB in every run but Y1 and Y2, which started at 293–300 MiB and peaked at 330–337 MiB. The offer insert kept its time (p50 21–22 ms alone, D1 and D2). The profile of the after build (inspector, the same options, 17.3 s of busy CPU) is the second column below:

| Where | Before: busy CPU, share | After: busy CPU, share |
|---|---|---|
| The `supplier_requests` copy | 4.54 s, 20.7 % | 1.29 s, 7.5 % (the redactor 0.73 s; the JSON text of the whole body for `bytes` 0.45 s) |
| Facets, highlights, best score | 2.84 s, 13.0 % | 0.60 s, 3.5 % |
| `decimal.js` | 2.53 s, 11.6 % | 0.83 s, 4.8 % (now mostly the pricing engine) |
| The driver: Kysely and `pg` (every query and the 250-row insert) | 2.42 s, 11.0 % | 2.69 s, 15.6 % |
| Garbage collection | 1.95 s, 8.9 % | 1.63 s, 9.4 % |
| The pricing engine | 0.75 s, 3.4 % | 0.83 s, 4.8 % |
| Logging | 0.60 s, 2.7 % | 0.65 s, 3.8 % |
| Offer parsing | 0.50 s, 2.3 % | 0.46 s, 2.7 % |
| New ids | 0.47 s, 2.2 % | 0.48 s, 2.8 % |
| Parsing the Amadeus answer | 0.37 s, 1.7 % | 0.33 s, 1.9 % |

### What the runs show

1. **A search costs the API about 30 ms less.** Alone (D1 → D2), the `flights.search` time without the Amadeus call fell from 114 to 84 ms at p50 (147 to 111 ms at p95), and the API's CPU per journey from 178 to 140 ms. At 10 visitors the API's CPU per completed journey fell from 133–146 ms to 117–122 ms (means 140 and 120 ms, −14 %; the API's CPU per run −16 %), and the event-loop delay p99 from 42–49 ms to 25–27 ms.
2. **The p95 at 10 visitors fell by about 300 ms but is not reliably below the budget.** Without the stub delay it was 706–870 ms before (K0, K1, K3, K5) and 433–619 ms after (K2, K4, K6–K8, U1, U2; median 519 ms). Two of these seven runs were within the 500 ms budget, so the Verify command exits 1 in most runs. The review's run R1 gave 511 ms. As in §2 item 1, the bursts after a `429` set the p95: ten searches then share the event loop.
3. **Why not below 500 ms.** What is left of a search's CPU is spread over code these three files do not hold, with no share above 16 % (the table above): the driver for the 30 or so queries of a journey and the 250-row insert, garbage collection, the pricing engine, logging, new ids and the parsing of the answer. Removing the last part of the stored copy (the JSON text of the whole body that gives `bytes`, 2.6 %) would not change that.
4. **A larger young generation helps.** With `--max-semi-space-size=32` (Y1, Y2) the API spent 7–14 % less CPU per journey than K7 and K8 next to them (113 against 122 ms and 104 against 121 ms; garbage collection is 9 % of the CPU), and the p95 was 509 and 436 ms. The RSS grew by about 40 MiB, to a peak of 337 MiB of the unit's `MemoryMax` of 768 MiB.

**Decision needed (OBE-092 records it; the owner decides).** To meet the 500 ms p95 at 10 visitors with 250-offer answers reliably, in this order:

- **(a)** Start the OTA API with `--max-semi-space-size=32` (`deploy/systemd/velexis-ota-api.service`, and `search-load.mjs`, which starts the API as the VM does), then run the Verify command again. It changes no behaviour and costs about 40 MiB; OBE-088 checks it against the VM's memory budget.
- **(b)** If (a) is not enough: a lower default `maxResults` (for example 150). The API's time grows with the offers of an answer (§2 item 2), but a storefront then shows fewer offers.
- **(c)** Otherwise a second API process behind Caddy (twice the API's memory) or a worker thread for pricing, facets and the insert of a search.

*2026-11-06 (lead decision (11h)).* The owner took (a): the OTA API starts with `--max-semi-space-size=32` since FIX-W46-SHARED (Step 4). It is not enough on its own, so (b) is next: OBE-096.

*2026-11-10 (lead decision (13d)).* (b): the default number of offers per search is the largest measured number that meets the 500 ms p95 in three runs of three, and a storefront can still set up to 250. OBE-096 measured it: 175 (§5). (c) is not needed for the budget on a quiet machine; §5 item 3 says when to come back to it.

### Step 4: a larger young generation (FIX-W46-SHARED, 10 November 2026)

Lead decision (11h) of 2026-11-06 carried out (a): `deploy/systemd/velexis-ota-api.service` starts the API with `NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=32` (32 MiB per semi-space instead of V8's default of 16 MiB for this heap; the old generation keeps its 640 MiB, and V8's heap limit grows from 688 to 736 MiB, under the unit's `MemoryMax` of 768 MiB), and `search-load.mjs` starts it the same way. The runs below compare the two start commands on the same build.

| Item | Value |
|---|---|
| Code | The API built from `6d8ab821b324` (the integration branch head this fix started from); no source file of the API changed. **Before:** `--max-old-space-size=640` (the unit and `search-load.mjs` of `6d8ab821b324`). **After:** `--max-old-space-size=640 --max-semi-space-size=32` (this fix). The script prints `6d8ab821b324+changes` for both. As in Step 3, a copy of the script (not committed) also recorded the API process's CPU time over the measured phase (`process.cpuUsage()`, user and system); the API ran unchanged. |
| Machine | 4 vCPUs (`nproc` 4; Intel Xeon @ 2.10 GHz), 15.7 GiB RAM, Linux 6.18.44 x64, Node 22.23.4, PostgreSQL 16.15, Redis 7.0.15 (a private instance on its own port). The machine was replaced on 2026-11-06, so these runs compare only with each other. The six runs held the machine-wide end-to-end lock, ran back to back and alternated the two start commands; the machine was idle at the first (1-minute load average 0.02) and other agents' builds started during the fourth. |
| API, Amadeus, tenants, visitors | As in §2, with `--visitors 10 --searches 200 --offers 250` (the Verify command of OBE-092). |

| Run | Start command | Started (UTC) | Load avg start → end | Journeys completed / refused | search p50 / p95 | **search p95 −delay** | search p95 −Amadeus | listResults p95 | price p95 −delay | API CPU (s) | CPU per journey (ms) | RSS after start / peak (MiB) | Event-loop delay p99 / max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | before | 10:04:48 | 0.02 → 0.39 | 174 / 26 | 438 / 817 | **517** | 486 | 107 | 202 | 21.1 | 121 | 260 / 294 | 26 / 61 |
| S2 | after | 10:05:33 | 0.39 → 0.60 | 179 / 21 | 424 / 775 | **475** | 443 | 80 | 165 | 20.1 | 112 | 306 / 343 | 25 / 71 |
| S3 | before | 10:06:19 | 0.60 → 0.70 | 174 / 26 | 436 / 807 | **507** | 479 | 107 | 179 | 20.6 | 118 | 259 / 299 | 28 / 46 |
| S4 | after | 10:07:03 | 0.70 → 1.47 | 180 / 20 | 433 / 807 | **507** | 473 | 71 | 143 | 19.5 | 108 | 309 / 343 | 26 / 99 |
| S5 | before | 10:07:48 | 1.47 → 2.08 | 173 / 27 | 449 / 799 | **499** | 466 | 75 | 194 | 20.4 | 118 | 259 / 293 | 31 / 78 |
| S6 | after | 10:08:33 | 2.08 → 1.45 | 189 / 11 | 424 / 835 | **535** | 457 | 92 | 182 | 20.1 | 106 | 299 / 336 | 25 / 45 |

Every run had 0 unexpected answers. The offer insert kept its time (p50 25–29 ms in every run).

**What the runs show.**

1. **CPU: about 9 % less per journey.** 106–112 ms after against 118–121 ms before (means 109 and 119 ms), with fewer refused journeys in the same phase; the event-loop delay p99 fell from 26–31 ms to 25–26 ms. This confirms Y1 and Y2 of Step 3.
2. **RSS: about 45 MiB more.** 299–309 MiB after start and a peak of 336–343 MiB, against 259–260 and 293–299 MiB before: less than half of the unit's `MemoryMax` of 768 MiB, and inside the API's line of the VM's memory budget ([architecture §3](../../docs/mvp/architecture.md#3-hosts-ports-and-the-vm)). OBE-088 checks it under mixed traffic.
3. **The 500 ms p95 is still not met reliably.** Without the stub delay the p95 was 475, 507 and 535 ms after (one run of three within the budget) and 517, 507 and 499 ms before (also one of three); the medians are equal (507 ms). The p95 comes from the bursts after a `429` (§2 item 1, Step 3 item 2): ten searches then share the event loop, and a run that refuses fewer journeys (S6: 11) has more of them. A young generation of 32 MiB per semi-space takes about 10 ms of CPU off a journey, which the bursts do not show.
4. **Kept.** The flag changes no behaviour and costs 45 MiB, and the CPU it saves is real, so the unit keeps it. The next step of the decision above, (b) a lower default `maxResults`, is task **OBE-096**; (c) stays the fallback.

## 5. Fewer offers per search by default (OBE-096, 10 November 2026)

Lead decision (13d) of 2026-11-10, which the owner approved, took the place of the owner's pick in OBE-096's step 3: a storefront without a `maxResults` of its own asks Amadeus for the largest number of offers per search that the runs below measured within the 500 ms p95 of `flights.search` without the stub delay, at 10 visitors, in three runs of three. A storefront can still set up to 250 in its search defaults, and 250 stays the bound of what a search stores ([OADR-0002](adr/0002-offer-and-priced-offer-caching.md) point 1).

### Set-up

| Item | Value |
|---|---|
| Code | **Step 2:** the API built from `f8c3c8bb45ef`, the integration branch head this task started from. That API asks Amadeus for 250 offers per search. The runs used this task's `search-load.mjs`, so the script prints `f8c3c8bb45ef+changes`. **Step 4:** the same build with this task's `offers.mapper.ts`, which asks for 175. |
| Machine | 4 vCPUs (`nproc` 4; Intel Xeon @ 2.10 GHz), 15.7 GiB RAM, Linux 6.18.44 x64, Node 22.23.4, PostgreSQL 16.15, Redis 7.0.15 (a private instance on its own port). The machine is shared with other agents' builds and test suites. |
| The lock and the load | Every run held the machine-wide end-to-end lock. The Q and V runs started only once the 1-minute load average was below 1.0, as OBE-092's paired runs did; they waited for that without holding the lock. The R runs ran back to back while another agent's integration suite ran on the same machine (1-minute load average 1.3 to 2.7). |
| API, Amadeus, tenants, visitors | As in §2, with `--visitors 10 --searches 200` and `--offers` 250, 200, 175, 150, 125 or 100. The proxy answers no more offers than a search asks for (Step 1). In Step 2 the API asked for 250, so every answer had the `--offers` offers. |
| CPU time | The script's preload now reads the API process's CPU time over the measured phase (`process.cpuUsage()`, user and system). Steps 3 and 4 of §4 took it from a copy of the script that was not committed. "CPU per journey" divides it by the completed journeys, as there. |

### Step 1: the proxy answers no more offers than asked for

Before this task, `search-load.mjs` already cut a stretched answer to the search's `max` or `maxFlightOffers`. It did not cut the stub's own 5 offers (`--offers 0`), and it read a missing or malformed value as no limit.

- **The bound.** The proxy now answers a search with at most the offers it asked for, as Amadeus does: `max` of a GET search, `searchCriteria.maxFlightOffers` of a POST search. When the search names neither, or a value Amadeus would refuse, the bound is 250, Amadeus's most and its default.
- **The report.** It gives the offers the searches asked for and the offers the proxy answered (p50 and maximum). An answer with more offers than asked for counts as an unexpected answer, so the run exits 1.
- **The runs.** In every run below that count was 0. Every answer had the smaller of `--offers` and what the search asked for.

### Step 2: the runs

Every run has `--visitors 10 --searches 200` and 0 unexpected answers. A run's name is its round and its offers per answer. "−delay" subtracts the 300 ms stub delay; "−Amadeus" subtracts the search row's `duration_ms`.

| Run | Offers per answer | Started (UTC) | Load avg start → end | Journeys completed / refused | search p50 / p95 | **search p95 −delay** | search p95 −Amadeus | listResults p95 | price p95 −delay | API CPU (s) | CPU per journey (ms) | RSS after start / peak (MiB) | Event-loop delay p99 / max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Q1-250 | 250 | 20:18:30 | 0.99 → 1.43 | 180 / 20 | 430 / 805 | **505** | 440 | 81 | 165 | 20.8 | 115 | 296 / 333 | 25 / 63 |
| Q2-250 | 250 | 20:27:51 | 0.93 → 1.49 | 185 / 15 | 435 / 818 | **518** | 483 | 90 | 177 | 21.1 | 114 | 305 / 342 | 26 / 94 |
| Q3-250 | 250 | 20:34:32 | 0.98 → 0.86 | 179 / 21 | 431 / 788 | **488** | 456 | 88 | 179 | 20.0 | 112 | 295 / 335 | 26 / 46 |
| Q1-200 | 200 | 20:19:47 | 0.93 → 1.00 | 186 / 14 | 403 / 814 | **514** | 463 | 75 | 162 | 19.0 | 102 | 308 / 342 | 21 / 63 |
| Q2-200 | 200 | 20:26:59 | 0.85 → 1.01 | 187 / 13 | 418 / 808 | **508** | 471 | 81 | 176 | 19.9 | 106 | 308 / 342 | 24 / 53 |
| Q3-200 | 200 | 20:36:04 | 0.88 → 0.67 | 179 / 21 | 403 / 777 | **477** | 441 | 85 | 186 | 19.0 | 106 | 307 / 344 | 22 / 44 |
| Q1-175 | 175 | 20:20:38 | 0.92 → 0.72 | 185 / 15 | 409 / 764 | **464** | 451 | 89 | 180 | 19.1 | 103 | 297 / 329 | 20 / 59 |
| Q2-175 | 175 | 20:26:13 | 0.97 → 0.85 | 184 / 16 | 394 / 753 | **453** | 423 | 81 | 211 | 18.8 | 102 | 296 / 329 | 20 / 71 |
| Q3-175 | 175 | 20:29:04 | 0.98 → 1.32 | 187 / 13 | 399 / 757 | **457** | 411 | 76 | 174 | 18.2 | 97 | 306 / 339 | 20 / 56 |
| Q1-150 | 150 | 20:21:25 | 0.72 → 0.52 | 183 / 17 | 393 / 748 | **448** | 425 | 84 | 196 | 17.2 | 94 | 307 / 340 | 19 / 40 |
| Q2-150 | 150 | 20:25:26 | 0.95 → 0.97 | 188 / 12 | 392 / 713 | **413** | 394 | 79 | 166 | 18.4 | 98 | 299 / 331 | 18 / 60 |
| Q3-150 | 150 | 20:36:51 | 0.67 → 1.05 | 183 / 17 | 401 / 765 | **465** | 443 | 93 | 183 | 18.2 | 99 | 305 / 339 | 19 / 52 |
| Q1-125 | 125 | 20:22:11 | 0.52 → 0.85 | 186 / 14 | 387 / 655 | **355** | 347 | 75 | 149 | 16.0 | 86 | 309 / 336 | 16 / 43 |
| Q2-125 | 125 | 20:24:30 | 0.65 → 1.13 | 178 / 22 | 394 / 669 | **369** | 356 | 84 | 182 | 16.3 | 92 | 309 / 336 | 17 / 34 |
| Q3-125 | 125 | 20:33:46 | 0.98 → 0.98 | 183 / 17 | 393 / 698 | **398** | 369 | 90 | 231 | 16.9 | 93 | 298 / 329 | 18 / 35 |
| Q1-100 | 100 | 20:22:58 | 0.86 → 0.85 | 179 / 21 | 385 / 629 | **329** | 309 | 82 | 180 | 15.2 | 85 | 297 / 324 | 15 / 32 |
| Q2-100 | 100 | 20:23:44 | 0.85 → 0.65 | 186 / 14 | 381 / 684 | **384** | 366 | 83 | 165 | 15.9 | 86 | 295 / 322 | 16 / 37 |
| Q3-100 | 100 | 20:35:18 | 0.86 → 0.87 | 181 / 19 | 388 / 737 | **437** | 411 | 91 | 206 | 16.6 | 92 | 297 / 323 | 17 / 45 |
| R1-250 | 250 | 20:01:14 | 1.30 → 1.76 | 180 / 20 | 427 / 904 | **604** | 535 | 90 | 162 | 19.3 | 107 | 301 / 337 | 27 / 58 |
| R2-250 | 250 | 20:06:43 | 2.37 → 2.60 | 181 / 19 | 428 / 821 | **521** | 487 | 101 | 181 | 18.8 | 104 | 298 / 336 | 26 / 68 |
| R3-250 | 250 | 20:09:03 | 1.67 → 2.27 | 177 / 23 | 442 / 968 | **668** | 635 | 100 | 218 | 22.0 | 124 | 300 / 346 | 28 / 93 |
| R1-200 | 200 | 20:02:00 | 1.76 → 2.41 | 180 / 20 | 423 / 880 | **580** | 564 | 85 | 183 | 19.3 | 107 | 303 / 340 | 24 / 59 |
| R2-200 | 200 | 20:05:55 | 2.31 → 2.32 | 180 / 20 | 430 / 904 | **604** | 561 | 96 | 188 | 18.4 | 102 | 301 / 332 | 24 / 86 |
| R3-200 | 200 | 20:07:29 | 2.60 → 2.27 | 177 / 23 | 428 / 878 | **578** | 552 | 91 | 185 | 19.2 | 108 | 302 / 335 | 24 / 81 |
| R1-150 | 150 | 20:02:47 | 2.41 → 2.67 | 182 / 18 | 410 / 730 | **430** | 409 | 73 | 193 | 17.8 | 98 | 300 / 332 | 19 / 54 |
| R2-150 | 150 | 20:05:10 | 1.96 → 2.31 | 174 / 26 | 409 / 827 | **527** | 474 | 77 | 202 | 17.2 | 99 | 300 / 329 | 20 / 91 |
| R3-150 | 150 | 20:09:51 | 2.27 → 2.45 | 175 / 25 | 409 / 733 | **433** | 409 | 77 | 182 | 17.8 | 102 | 298 / 331 | 20 / 36 |
| R1-100 | 100 | 20:03:35 | 2.67 → 2.45 | 186 / 14 | 396 / 723 | **423** | 400 | 84 | 196 | 15.6 | 84 | 298 / 326 | 18 / 46 |
| R2-100 | 100 | 20:04:23 | 2.58 → 1.96 | 184 / 16 | 384 / 668 | **368** | 355 | 79 | 165 | 15.2 | 82 | 301 / 330 | 17 / 31 |
| R3-100 | 100 | 20:08:16 | 2.27 → 1.73 | 185 / 15 | 388 / 650 | **350** | 325 | 73 | 168 | 16.7 | 90 | 300 / 333 | 17 / 36 |

**Per number of offers.** The Q runs, with the R runs in brackets:

| Offers per answer | search p95 −delay | Runs within 500 ms | CPU per journey (ms) | RSS peak (MiB) | Offer insert p50 (ms) |
|---|---|---|---|---|---|
| 250 | 488–518 (521–668) | 1 of 3 (0 of 3) | 112–115 | 333–342 | 26–28 |
| 200 | 477–514 (578–604) | 1 of 3 (0 of 3) | 102–106 | 342–344 | 20–21 |
| **175** | **453–464** | **3 of 3** | 97–103 | 329–339 | 17–19 |
| 150 | 413–465 (430–527) | 3 of 3 (2 of 3) | 94–99 | 331–340 | 15–17 |
| 125 | 355–398 | 3 of 3 | 86–93 | 329–336 | 13–14 |
| 100 | 329–437 (350–423) | 3 of 3 (3 of 3) | 85–92 | 322–324 | 11–12 |

The RSS after start was 295–309 MiB in every run.

### What the runs show

1. **175 offers is the largest number within the budget in three runs of three.** On the quiet machine (Q runs):
   - 175 offers per answer gave 453–464 ms;
   - 200 gave 477–514 ms, one run of three within the budget;
   - 250 gave 488–518 ms, one run of three within, as in Step 4 of §4.

   Every number from 175 down met the budget in its three runs.
2. **The API's CPU per journey falls with the offers.** It falls by about 0.17 ms per offer: from 112–115 ms at 250 offers to 85–92 ms at 100. The offer insert falls from 26–28 ms to 11–12 ms at p50. What is left at 100 offers is the results page, the price and the parts of the search that do not grow with the answer. The RSS hardly changes: its peak was 322–344 MiB, against the unit's `MemoryMax` of 768 MiB.
3. **A busy machine takes the margin away.** The R runs shared the 4 vCPUs with another agent's integration suite (load average 1.3–2.7):
   - only 100 offers met the budget in three runs of three;
   - 150 missed it once (527 ms);
   - 200 and 250 missed it in every run.

   As in §2 item 1, the bursts after a `429` set the p95: ten searches then share the event loop, and a busy machine gives that event loop less CPU. On the VM the API shares its vCPUs with the worker, PostgreSQL, Redis and Caddy. OBE-088 measures that mixed traffic. If it shows the same, the owner can lower the default (`DEFAULT_OFFERS_PER_SEARCH`, one constant), or take decision (c) of §4: a worker thread for the pricing, facets and insert of a search, or a second API process behind Caddy.

### Step 4: the default of 175 offers

**What changed.** `parseSearchDefaults` ([`offers.mapper.ts`](../backend/src/shopping/offers.mapper.ts)) answers `DEFAULT_OFFERS_PER_SEARCH`, 175, when `storefront_settings.search_defaults` has no valid `maxResults`. A valid one, a whole number from 1 to 250, is kept.

- **The cap.** A search's `max` (SIMPLE) and `maxFlightOffers` (ADVANCED) are capped by that limit as before, and `MAX_OFFERS_PER_SEARCH` (250) stays the bound of what a search stores.
- **The hosted storefront.** It sends no `max`, so it now gets up to 175 offers per search, nine results pages of 20.
- **The console.** Its searches read the same settings row, so a console-scope search of an OTA without its own `maxResults` asks for at most 175 offers too, also when it sends a larger `max` or `maxFlightOffers`. The OTA admin's shopping page asks for 50.
- **More offers.** An OTA that wants more sets `maxResults`, up to 250, in `storefront_settings.search_defaults`. No console screen or operation writes that column yet.
- **The contract.** The OpenAPI document did not change: it says that the storefront limit caps `max` and `maxFlightOffers`. It still names 250 as their default when a search omits them, the value the storefront limit then caps to 175.

**The Verify command.** The task's Verify command ran three times with the default of 175 (V runs), each under the lock and started at a load average below 1.0. The Verify command is the unit tests of `offers.mapper` and `search-load.mjs --visitors 10 --searches 200 --offers 250`. The API asked for 175 offers and the proxy answered 175.

| Run | Offers per answer | Started (UTC) | Load avg start → end | Journeys completed / refused | search p50 / p95 | **search p95 −delay** | search p95 −Amadeus | listResults p95 | price p95 −delay | API CPU (s) | CPU per journey (ms) | RSS after start / peak (MiB) | Event-loop delay p99 / max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| V1 | 175 | 20:38:23 | 0.84 → 0.98 | 186 / 14 | 405 / 770 | **470** | 433 | 69 | 178 | 18.6 | 100 | 299 / 332 | 21 / 50 |
| V2 | 175 | 20:39:13 | 0.98 → 0.88 | 186 / 14 | 406 / 740 | **440** | 413 | 83 | 163 | 18.4 | 99 | 297 / 328 | 20 / 42 |
| V3 | 175 | 20:40:08 | 0.89 → 0.81 | 177 / 23 | 409 / 744 | **444** | 418 | 83 | 188 | 18.9 | 107 | 299 / 331 | 21 / 44 |

The p95 without the stub delay was 470, 440 and 444 ms: within the budget in three runs of three. The Verify command exited 0 each time, with the 51 unit tests its filter `offers.mapper` selects (`offers.mapper.test.ts` and `priced-offers.mapper.test.ts`) passing. Every search asked for 175 offers and got 175, and no answer had more than asked for. The CPU per journey (99–107 ms), the RSS and the offer insert (p50 18–19 ms) are those of the Q runs of 175.

**The review's re-runs.** The second-agent review ran the Verify command six more times on the committed task (`aa0ca4c387ad`; the script prints `+changes` for the review's test edit, which leaves the API as it was), each under the lock:

- RV1 to RV3 started at a 1-minute load average below 1.0, as the V runs, but after a busy quarter of an hour (5-minute load average 2.3–2.8);
- RW1 to RW3 started once the 1-minute load average was below 1.0 and the 5-minute below 1.5.

| Run | Offers per answer | Started (UTC) | Load avg start → end | Journeys completed / refused | search p50 / p95 | **search p95 −delay** | search p95 −Amadeus | listResults p95 | price p95 −delay | API CPU (s) | CPU per journey (ms) | RSS after start / peak (MiB) | Event-loop delay p99 / max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RV1 | 175 | 22:35:16 | 0.95 → 0.96 | 183 / 17 | 391 / 826 | **526** | 482 | 87 | 168 | 17.4 | 95 | 307 / 339 | 19 / 52 |
| RV2 | 175 | 22:36:04 | 0.96 → 1.14 | 183 / 17 | 392 / 765 | **465** | 410 | 76 | 155 | 17.3 | 95 | 305 / 337 | 19 / 43 |
| RV3 | 175 | 22:37:03 | 0.97 → 1.12 | 187 / 13 | 405 / 799 | **499** | 473 | 74 | 158 | 17.1 | 92 | 297 / 328 | 18 / 61 |
| RW1 | 175 | 22:39:37 | 0.18 → 0.77 | 192 / 8 | 397 / 765 | **465** | 450 | 88 | 145 | 18.2 | 95 | 299 / 333 | 19 / 51 |
| RW2 | 175 | 22:40:26 | 0.79 → 1.16 | 185 / 15 | 406 / 756 | **456** | 410 | 81 | 185 | 17.7 | 96 | 297 / 330 | 20 / 52 |
| RW3 | 175 | 22:41:30 | 1.05 → 0.88 | 188 / 12 | 394 / 713 | **413** | 374 | 76 | 180 | 17.7 | 94 | 308 / 339 | 20 / 55 |

RV1 missed the budget at 526 ms, and RV3 met it by 1 ms. The other runs were within it, RW1 to RW3 in three runs of three. So 175 offers met the budget in 8 of the 9 Verify runs, with a margin from 87 ms (RW3) down to 1 ms (RV3). RV1 spent no more CPU per journey than the others (95 ms) and its p90 was 269 ms: as in item 3 above, its p95 came from the bursts after a `429`, which a machine that has just been busy serves more slowly.

## 6. Follow-ups

| Task | What |
|---|---|
| OBE-092 (M6) | Added by OBE-028. Cut the API's CPU per search so that answers of 250 offers meet the 500 ms p95 at 10 concurrent visitors. The largest shares are the `supplier_requests` copy of the whole answer, facets, `decimal.js` and the driver (§2 item 2). If it cannot be met, this page records the decision needed: a lower default `maxResults`, a worker thread or a second API process. **Done (§4):** about 30 ms of CPU less per search; the p95 is 433–619 ms, so §4 records the decision needed (a larger young generation first). |
| OBE-096 (M6) | Added by FIX-W46-SHARED (Step 4): `--max-semi-space-size=32` takes about 9 % of the API's CPU per journey off but leaves the p95 at 475–535 ms. Measure the search budget with fewer offers per answer and, once the owner picks the default number of offers a storefront asks for, set it; if no default the owner accepts meets the budget, record the decision for a worker thread or a second API process. **Done (§5):** lead decision (13d) of 2026-11-10 set the rule, and the runs set the default: a storefront without its own `maxResults` asks for 175 offers per search, and the Verify command met the budget in three runs of three (440–470 ms). The review's six re-runs met it five times (413–499 ms) and missed it once at 526 ms, after a busy quarter of an hour. A storefront can still set up to 250. On a busy machine the margin is gone (§5 item 3); OBE-088 measures the VM's mixed traffic. |
| OBE-088 (M6) | Mixed traffic on five tenants for 30 minutes with the worker running; the API's and the worker's RSS against `MemoryMax`, PostgreSQL connections, Redis memory, queue latency; the table growth of §2 item 4 against the VM's disk. |
