# Platform performance

This page records measured figures of the platform backend (the API and its worker) and the decisions taken from them. Each run names its date, the code it ran, the machine with its `nproc`, and how busy that machine was.

- PBE-063 started the page with the M6 performance smoke test (§3): the busiest operations against their p95 targets, and the RSS of the API and the worker against the memory budget of [architecture §3](../../docs/mvp/architecture.md#3-hosts-ports-and-the-vm).

Related:

- [`tools/perf/README.md`](../../tools/perf/README.md): how to run the smoke test and read its report.
- [`docs/mvp/deployment-single-vm.md`](../../docs/mvp/deployment-single-vm.md) §1 and §14: the VM's size, the resize rule and the capacity limits.
- [`architecture.md`](architecture.md) §1, §3 and §5: the processes, the request pipeline and the worker.
- [`ota/docs/performance.md`](../../ota/docs/performance.md): the OTA backend's figures (OBE-028, OBE-092, OBE-088).

## 1. How a run is recorded

- Run `tools/perf/platform-smoke.mjs` as its README says, against a fresh scratch stack, with `--json` to keep the figures.
- Add the run to the tables of its section, with:
  - the start time (UTC);
  - the code that ran;
  - the options;
  - `nproc` and the 1-minute load average at the start and the end of each phase. The test prints them; `uptime` and `nproc` before the run show the same.
- The runs below were made on a shared development machine. They ran under the machine's end-to-end lock, so no end-to-end suite ran at the same time; other work may have. A run is only comparable with runs on the same machine. When a target is missed while the load average is high, run again later and record both runs.
- Times are in milliseconds unless a column says otherwise. They are client-side, from sending the request to the last byte of the answer. Percentiles are nearest-rank, over the expected answers of the measured seconds.

## 2. Targets

| What | Target | Why |
|---|---|---|
| `signIn` p95 | below 800 ms | One Argon2id verification (m = 19 MiB, t = 2, p = 1; `PasswordPolicy`) per sign-in, slow by design. |
| `getTenant`, `listApiKeys` p95 | below 300 ms | Reads behind the portal's pages. |
| `tlsAsk` p95, uncached | below 300 ms | A read: one indexed PostgreSQL lookup of a host that no cache holds. |
| `tlsAsk` p95, cached | below 20 ms | Caddy asks before it obtains a certificate for a host it has none for, and a flood of random SNI names must stay cheap ([PADR-0004](adr/0004-custom-domain-verification.md) item 6). |
| `createTenant` | none | The plan gives none; the figure is recorded. |
| API RSS | at most 768 MiB | `MemoryMax=768M` of `velexis-platform-api.service`, which runs with `--max-old-space-size=640` |
| Worker RSS | at most 512 MiB | `MemoryMax=512M` of `velexis-platform-worker.service`, which runs with `--max-old-space-size=400` |

A missed target becomes a task in [`plans/agent-tasks.md`](plans/agent-tasks.md) (PBE-063 step 3).

## 3. M6 smoke test (PBE-063, 10 November 2026)

### Set-up

| Item | Value |
|---|---|
| Code | The API and the worker built from `6d8ab821b324`, the integration branch head this task started from, with `platform-smoke.mjs` of this task. The script prints `6d8ab821b324+changes` because it was not committed yet. The backend that ran is the same build in every run. V3 and S8 ran the script as first committed. The earlier runs ran it before its last changes, which added `--rate-scale` (V2 and later) and changed only the report's wording. The review then changed how a run is judged, not what it measures: a phase that starts more than 1 % of its requests late, or a process whose RSS was not measured, now fails the run; an account signs in again before a phase its token would not outlive; and `--duration` is at most 600. None of the recorded verdicts changes: no run at the plan's rates or at four times them had a late start, and S8 failed already. R1 ran the final script; it printed `b2435521e32f+changes`, the task's first commit with the review's changes not yet folded in. |
| Machine | 4 vCPUs (Intel Xeon @ 2.10 GHz), `nproc` 4, 15.7 GiB RAM, Linux 6.18 x64. Node 22.23.4. PostgreSQL 16.15 with the development defaults (`shared_buffers` 128 MB, `max_connections` 100; the VM has 1.5 GB of shared buffers). Redis 7.0.15, a private instance for the runs. The test itself ran on the same machine, so its CPU is in the load average. |
| Stack | A scratch database (migrations and reference data), the private Redis and Mailpit, built and removed as [`tools/perf/README.md`](../../tools/perf/README.md) "Run it" says. Each run had a fresh stack. |
| API and worker | Started as their systemd units start them: `NODE_ENV=production`, `--enable-source-maps`, `--max-old-space-size=640` (API) and `400` (worker), and a clean environment from the VM's template `deploy/env/platform-backend.env.example`: `APP_ENV=production`, `LOG_LEVEL=info` to a file, every feature switch off, `MAX_TENANTS_PER_ACCOUNT=3`. Pools of 10 (API) and 5 (worker) connections. |
| What is not there | Caddy: the test calls the API on `127.0.0.1:3100` as the portal's server does, and `ask` as Caddy does. The OTA backend: the OTAs stay `provisioning` (their jobs wait in `ota-tenant-ops`), so they have no API keys, and `listApiKeys` answers an empty list. The VM's other units, which share its four vCPUs. |
| Data | The set-up's accounts, each with one OTA: 33 for the 60-second runs, 8 for `--duration 10`, 130 for `--rate-scale 4`, 100 for `--rate-scale 8`. `createTenant` adds one OTA per request. |

### Runs

Every run had 0 unexpected answers. The runs at the plan's rates (V1 to V3, F1, F2, R1) and at four times them (S4) met every target, with no late start. S8, at eight times the rates, is a probe of where the API saturates: its cached `ask` missed the 20 ms target there (see "What the runs show" and §4). `nproc` was 4 in every run.

| Run | Started (UTC) | Options | Accounts (set-up s) | Requests | Load avg 1 min, run start → end | Result |
|---|---|---|---|---|---|---|
| V1 | 12:22:12 | `--duration 10` (the Verify command) | 8 (1.0) | 3 110 | 0.36 → 0.86 | every target met |
| V2 | 12:31:49 | `--duration 10`, the README's "Run it" steps run as written | 8 (1.0) | 3 110 | 1.08 → 0.52 | every target met |
| V3 | 12:49:55 | `--duration 10`, the final script | 8 (1.0) | 3 110 | 1.31 → 0.51 | every target met |
| F1 | 12:23:52 | the defaults: 60 s per phase after 5 s of warm-up | 33 (3.6) | 18 660 | 0.89 → 0.98 | every target met |
| F2 | 12:34:42 | the defaults, again | 33 (3.7) | 18 660 | 1.53 → 0.09 | every target met |
| S4 | 12:41:45 | `--rate-scale 4`: every phase at four times its rate | 130 (11.9) | 74 640 | 0.78 → 0.45 | every target met |
| S8 | 12:52:54 | `--rate-scale 8 --duration 30 --phases getTenant,tlsAskCached,tlsAskUncached` | 100 (8.8) | 60 000 | 2.08 → 3.57 | the probe saturated the API: cached `ask` p95 46 ms; 23 823 late starts of the uncached `ask` |
| R1 | 14:36:37 | `--duration 10`, the reviewed script, on a fresh stack built by the README's steps 2 to 6; other work on the machine (not an end-to-end run) raised the load | 8 (1.1) | 3 110 | 3.58 → 14.89 | every target met |

**Latency at the plan's rates.** p50 / p95 per phase, with the 1-minute load average at the start and the end of the phase's measured seconds in brackets (V1 to V3) or in the load columns (F1, F2). The p99 and the slowest answer are those of F1.

| Phase | Rate/s | p95 target | V1 | V2 | V3 | F1 | F1 p99 / max | F1 load | F2 | F2 load |
|---|---|---|---|---|---|---|---|---|---|---|
| `signIn` | 10 | 800 | 42.7 / 55.7 (0.33 → 0.35) | 40.8 / 52.1 (0.99 → 1.15) | 41.2 / 48.2 (1.20 → 1.02) | 42.7 / **55.5** | 63.3 / 113.3 | 0.90 → 0.43 | 40.9 / **52.0** | 1.37 → 0.99 |
| `getTenant` | 50 | 300 | 7.1 / 9.6 (0.41 → 0.42) | 6.5 / 8.5 (1.14 → 0.96) | 6.1 / 7.9 (0.94 → 0.79) | 6.5 / **9.4** | 13.0 / 49.3 | 0.48 → 1.00 | 6.1 / **8.3** | 0.91 → 0.53 |
| `listApiKeys` | 50 | 300 | 6.3 / 8.4 (0.46 → 0.47) | 6.0 / 7.7 (0.88 → 0.75) | 5.8 / 7.7 (0.73 → 0.62) | 5.8 / **7.9** | 11.4 / 20.8 | 0.92 → 0.48 | 6.0 / **7.9** | 0.57 → 0.51 |
| `tlsAsk` cached | 100 | 20 | 2.3 / 3.4 (0.52 → 0.66) | 2.2 / 3.4 (0.77 → 0.65) | 2.2 / 3.5 (0.89 → 0.75) | 2.0 / **3.2** | 5.3 / 16.8 | 0.53 → 0.55 | 2.1 / **3.1** | 0.47 → 0.27 |
| `tlsAsk` uncached | 100 | 300 | 2.8 / 5.1 (0.60 → 0.75) | 2.6 / 3.6 (0.60 → 0.58) | 2.5 / 3.5 (0.77 → 0.65) | 2.5 / **3.6** | 5.4 / 36.1 | 0.51 → 0.47 | 2.7 / **3.6** | 0.32 → 0.27 |
| `createTenant` | 1 | — | 21.1 / 48.5 (0.75 → 0.86) | 23.9 / 30.8 (0.61 → 0.52) | 21.7 / 25.4 (0.60 → 0.51) | 24.5 / **29.7** | 40.8 / 40.8 | 0.52 → 0.98 | 25.7 / **31.3** | 0.25 → 0.09 |

**R1, the review's run under load.** p50 / p95 with the 1-minute load average of each phase; the load came from other work on the machine. `signIn` 47.9 / 60.0 (3.30 → 3.17), `getTenant` 5.7 / 9.3 (3.48 → 5.77), `listApiKeys` 6.5 / 12.0 (6.10 → 7.94), cached `ask` 2.0 / 5.2 (8.11 → 9.28), uncached `ask` 2.1 / 4.8 (9.98 → 11.83), `createTenant` 24.3 / 98.2 (13.05 → 14.89). With the load average rising to nearly four times `nproc`, every target was still met; the p95s rose by up to 4 ms and `createTenant`'s slowest answer by 50 ms.

**Headroom.** The same phases at four and eight times the plan's rates: p50 / p95, p99 / max, and the load average of each phase.

| Phase | S4 rate/s | S4 p50 / p95 | S4 p99 / max | S4 load | S8 rate/s | S8 p50 / p95 | S8 p99 / max | S8 load |
|---|---|---|---|---|---|---|---|---|
| `signIn` | 40 | 39.0 / **49.0** | 57.3 / 74.3 | 1.00 → 1.48 | — | — | — | — |
| `getTenant` | 200 | 5.7 / **9.2** | 16.1 / 88.2 | 1.52 → 1.10 | 400 | 7.2 / **46.7** | 114.3 / 155.0 | 1.84 → 2.11 |
| `listApiKeys` | 200 | 5.3 / **9.2** | 19.6 / 149.2 | 1.09 → 1.48 | — | — | — | — |
| `tlsAsk` cached | 400 | 1.6 / **3.2** | 6.6 / 56.4 | 1.36 → 1.00 | 800 | 4.1 / **46.1** | 80.3 / 231.1 | 2.02 → 2.69 |
| `tlsAsk` uncached | 400 | 2.1 / **4.4** | 8.9 / 31.5 | 1.00 → 1.33 | 800 (754 reached) | 62.2 / **95.0** | 116.3 / 163.4 | 3.75 → 3.57 |
| `createTenant` | 4 | 20.3 / **24.6** | 26.8 / 30.2 | 1.22 → 0.45 | — | — | — | — |

**CPU per request.** The API's CPU seconds during the measured seconds (user and system, from `/proc/<pid>/stat`), divided by the requests, and the share of one CPU that makes. Argon2id runs on libuv's thread pool (four threads), everything else on the API's one event loop. The worker used at most 0.3 s of CPU in any phase.

| Phase | F1 CPU s | F1 per request (ms) | F1 share of one CPU | F1 load | S4 CPU s | S4 per request (ms) | S4 share of one CPU | S4 load |
|---|---|---|---|---|---|---|---|---|
| `signIn` | 22.8 | 38 | 38 % | 0.90 → 0.43 | 83.5 | 35 | 139 % | 1.00 → 1.48 |
| `getTenant` | 14.9 | 5.0 | 25 % | 0.48 → 1.00 | 42.5 | 3.5 | 71 % | 1.52 → 1.10 |
| `listApiKeys` | 12.9 | 4.3 | 21 % | 0.92 → 0.48 | 40.4 | 3.4 | 67 % | 1.09 → 1.48 |
| `tlsAsk` cached | 12.0 | 2.0 | 20 % | 0.53 → 0.55 | 38.0 | 1.6 | 63 % | 1.36 → 1.00 |
| `tlsAsk` uncached | 13.0 | 2.2 | 22 % | 0.51 → 0.47 | 42.9 | 1.8 | 72 % | 1.00 → 1.33 |
| `createTenant` | 1.3 | 22 | 2 % | 0.52 → 0.98 | 2.5 | 10 | 4 % | 1.22 → 0.45 |

**Memory.** `VmRSS` in MiB after start-up (before the set-up), at its sampled peak and at the end, and `VmHWM`, the kernel's peak since the process started.

| Run | API start → peak → end | API `VmHWM` | of 768 MiB | Worker start → peak → end | Worker `VmHWM` | of 512 MiB | Load avg 1 min, run start → end |
|---|---|---|---|---|---|---|---|
| V1 | 192 → 281 → 280 | 281 | 37 % | 145 → 146 → 116 | 147 | 29 % | 0.36 → 0.86 |
| V2 | 194 → 282 → 223 | 281 | 37 % | 146 → 148 → 117 | 148 | 29 % | 1.08 → 0.52 |
| V3 | 192 → 282 → 224 | 281 | 37 % | 147 → 149 → 119 | 149 | 29 % | 1.31 → 0.51 |
| F1 | 194 → 284 → 227 | 283 | 37 % | 146 → 148 → 119 | 149 | 29 % | 0.89 → 0.98 |
| F2 | 188 → 280 → 228 | 282 | 37 % | 146 → 149 → 120 | 150 | 29 % | 1.53 → 0.09 |
| S4 | 196 → 286 → 286 | 286 | 37 % | 147 → 154 → 120 | 154 | 30 % | 0.78 → 0.45 |
| S8 | 194 → 296 → 296 | 296 | 39 % | 146 → 152 → 117 | 152 | 30 % | 2.08 → 3.57 |
| R1 | 192 → 280 → 280 | 280 | 36 % | 145 → 146 → 117 | 147 | 29 % | 3.58 → 14.89 |

### What the runs show

- **Every target is met by a wide margin, in every run at the plan's rates.** On the quiet machine (V1 to V3, F1, F2) the p95 of `signIn` was 48–56 ms (target 800), of the two reads 7.7–9.6 ms (300), of a cached `ask` 3.1–3.5 ms (20) and of an uncached one 3.5–5.1 ms (300). The two 60-second runs agree within a few milliseconds; the 10-second runs vary a little more, with fewer answers. With the load average near four times `nproc` (R1) the p95s were at most 60 ms, 12 ms, 5.2 ms and 4.8 ms.
- **At the plan's rates the API is mostly idle.** It used 20–38 % of one CPU per phase, and the worker almost none. Requests rarely overlap, so a request's latency is its own work: about 40 ms for a sign-in, 5–7 ms for a read with its guards, 2–3 ms for an `ask`.
- **A sign-in costs about 35–38 ms of CPU, by design.** Nearly all of it is the Argon2id verification on libuv's thread pool, so four sign-ins run at once next to the event loop. At 40 sign-ins a second (S4) the API used 1.4 CPUs and the p95 stayed at 49 ms. The limit of 10 sign-ins per IP per minute keeps any one client far from that. A sign-in flood from many addresses is what the four vCPUs would feel first.
- **A read costs 3.5–5 ms of the event loop.** That is the per-account rate limit (Redis), `PortalAuthGuard` (the token's signature and the account's status read), `MfaEnrolmentGuard` (one memberships query for an account without MFA), `TenantRoleGuard` (the membership read), the OpenAPI validation, the handler's query and pino-http's request line. At 200 reads a second (S4) the event loop was about 70 % busy. The p95 stayed at 9 ms; the p99 rose to 16–20 ms and the slowest answers to 88–149 ms, which are requests queued behind others and garbage collection. At 400 reads a second (S8) the event loop was saturated: 32.6 CPU seconds in 30 seconds, more than one CPU with the garbage collector's threads. The p95 rose to 47 ms and the p99 to 114 ms. So one API process serves between 200 and 400 such reads a second on this CPU before answers queue. The portal's traffic is far below that.
- **`ask` is cheap whether its caches answer or not.** A cached `ask` took 2.0 ms of CPU and an uncached one 2.2 ms: the indexed lookup adds about 0.2 ms of CPU and 0.5 ms of latency. The rest is the request pipeline and its log line. The in-process cache of refusals makes a repeated unknown host as cheap as a known one, and a flood of new names costs one lookup each. At 400 new names a second (S4) the p95 was 4.4 ms. At 800 a second (S8) the API saturated: the cached `ask` p95 rose to 46 ms, above its target, and with new names the test's 50 slots filled up (it reached 754 a second, p95 95 ms). The test's own client took part of the four vCPUs too (load average up to 3.75).
- **`createTenant` takes about 25 ms (p50).** That is one transaction with the tenant, its owner, subscription, sub-domain, job and audit rows, then the job's dispatch to Redis.
- **Memory is flat and well within the budget.** The API starts at about 190 MiB. It grows to about 280 MiB during the set-up and the first phase, while the code compiles and the pool and caches fill, and then stays flat. It did not grow over six minutes and 18 660 requests, nor over 74 640 requests at four times the rate (286 MiB). That is 37 % of its 768 MiB `MemoryMax`, far from the 640 MiB V8 old-space limit. The worker stays at 120–154 MiB (29–30 % of 512 MiB); it only sent the set-up's verification e-mails. Together the two processes use about 430 MiB of the 1 280 MiB the budget gives them.
- **What these figures leave out.** They leave out Caddy's TLS and proxy hop and the VM's other units on the same four vCPUs: the OTA API and worker, three Next.js servers, PostgreSQL and Redis. They also leave out the VM's PostgreSQL settings, OTAs with keys and members, and a busy worker (provisioning, e-mails, Stripe events). The test's own client ran on the same machine. The margins are large enough that none of these is likely to move a target past its bound. A run on the VM itself is the real figure (deployment §14), on a scratch stack and never against production data.

## 4. Decisions

- **No change to the platform API or worker.** No target was missed, and nothing in the figures calls for a code change.
- **The memory budgets stay as they are:** `MemoryMax` 768 MiB and 512 MiB, `--max-old-space-size` 640 and 400. The measured peaks leave about 480 MiB and 360 MiB of room. Lowering them would give PostgreSQL's page cache about 0.5 GB more. Only the VM's figures in production should decide that: more tenants, real traffic, and the resize rule of [ADR-0007](../../docs/mvp/adr/0007-single-vm-without-docker.md) (memory above 70 % for most of the day). The platform's two processes are not what would trigger that rule.
- **No new task.** PBE-063 step 3 turns each missed target into a task, and no target was missed. The targets hold at the plan's rates, in every run, and at four times them (S4). The cached `ask` above 20 ms in S8 is a probe at eight times the plan's rate. It shows where one API process saturates: between 400 and 800 asks a second, and between 200 and 400 reads. Caddy asks only for hosts it has no certificate for, and nothing in the MVP's traffic comes near those rates.

## 5. Follow-ups

None from these runs. When a change to the request pipeline, the guards or `ask` could cost more time, run the test again (README "Run it") and add the run here.
