# Platform performance

This page records measured figures of the platform backend (the API and its worker) and the decisions taken from them. Each run names its date, the code it ran, the machine with its `nproc`, and how busy that machine was.

- PBE-063 started the page with the M6 performance smoke test (§3): the busiest operations against their p95 targets, and the RSS of the API and the worker against the memory budget of [architecture §3](../../docs/mvp/architecture.md#3-hosts-ports-and-the-vm).
- PBE-076 measured the same on Node.js 22 and Node.js 24, from one build and with the units' flags, and added each process's share of time in garbage collection (§6; [ADR-0029](../../docs/mvp/adr/0029-nodejs-24-runtime.md) items 3 and 5).

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

*Note (2026-11-18, PBE-076):* this run gave the processes only `--max-old-space-size` (640 and 400), as the units had then. With no `--max-semi-space-size` and no memory limit around them, V8 sized their young generation for the whole machine (15.7 GiB), not for the units' `MemoryMax`: Node 22.23.4 then takes 16 MiB per semi-space for both processes (heap limits 688 and 448 MiB). Since X-050 the units pin their young generation (16 MiB for the API, 1 MiB for the worker; heap limits 688 and 403 MiB, [deployment §14](../../docs/mvp/deployment-single-vm.md#14-capacity-limits-of-one-vm)), so this run's worker had a young generation 16 times the VM's. §3 stays as recorded; §6 measured Node 22 and Node 24 again with the units' flags, rather than comparing with these figures.

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

None from the Node.js 24 runs of §6 either (PBE-076, 18 November 2026): every threshold of ADR-0029 held, the p95 one on each runtime's mean, so no unit's flags change. Read pair by pair, the `ask` phases cross the 10 % threshold, and §6 ("Single runs against the mean") names the task that reading would bring; on 2026-11-18 the lead kept the reading on the means (lead decision (29a)), so that task is not made. The smoke test keeps the platform worker almost idle (it sends the set-up's verification e-mails); its garbage collection under real work, and each unit's memory under its `MemoryMax`, are checked again on the throwaway VM ([`node-upgrade.md`](../../docs/mvp/runbooks/node-upgrade.md) §5), as planned.

## 6. Node.js 24 (PBE-076, 18 November 2026)

[ADR-0029](../../docs/mvp/adr/0029-nodejs-24-runtime.md) moved Velexis to Node.js 24 (X-048), and since X-050 every app unit pins its young generation. This run measures the platform API and worker on both majors from one build, with the units' flags, against §2's targets and the thresholds of ADR-0029 items 3 and 5 (PBE-076 step 4): no p95 more than 10 % worse than on Node 22, every peak RSS at least 64 MiB under its `MemoryMax`, and at most 5 % of each process's time in garbage collection.

### Set-up

| Item | Value |
|---|---|
| Code | One build of `581f39702061`, the integration branch head this task started from (X-048's switch and X-050's pins merged), made once with Node v24.22.3 (`TURBO_FORCE=true pnpm exec turbo run build --filter=@velexis/platform-backend... --filter=@velexis/reference-data...`, 03:15 UTC). Every run started that build's `dist/main.js` and `dist/worker.js`. `platform-smoke.mjs` and `gc-observer.cjs` are this task's (the later changes, the wording of a "not measured" reason and the review's move of the `NODE_OPTIONS` reading into a helper of its own, change nothing these runs printed); the report prints `581f39702061+changes` because they were not committed yet. |
| Runtimes | **Node 22**: `/opt/node22/bin`, v22.23.4 (V8 12.4.254.21, the installed one, not updated first: ADR-0029's settled question). **Node 24**: `/opt/node24/bin`, v24.22.3 (V8 13.6.233.17), the official build checked against nodejs.org's `SHASUMS256.txt`. Each run put its runtime first on `PATH` for the API, the worker and the test; the report's runtime table shows each process's executable. |
| Flags | The units' `NODE_OPTIONS`, read from the unit files with `unit-node-options.mjs`: API `--max-old-space-size=640 --max-semi-space-size=16`, worker `--max-old-space-size=400 --max-semi-space-size=1`. The observer reported V8's heap limit as 688 and 403 MiB on both runtimes (old + 3 × semi). Both processes also had `--enable-source-maps`, as the units have, and `--require tools/perf/gc-observer.cjs`, which the units do not have. |
| Machine | The agents' machine: 4 vCPUs (Intel Xeon @ 2.10 GHz), `nproc` 4, 15.7 GiB RAM, Linux 6.18.44 x64, shared with the other agents of the wave. PostgreSQL 16.15 with the development defaults (`shared_buffers` 128 MB, `max_connections` 100), Redis 7.0.15 (a private instance per run, on a port and with a password of its own), Mailpit 1.29.7. The test ran on the same machine. |
| Stack | A fresh stack per run, as README "Run it" steps 2 to 6 build it: a scratch database (migrations and reference data; dropped after the run), the private Redis (shut down after the run) and the VM's environment template. The defaults: 33 accounts, six phases of 60 seconds after 5 seconds of warm-up, 18 660 requests. |
| Order and load | Four runs interleaved, Node 22, 24, 22, 24 (R1 to R4), each under the machine's end-to-end lock, so no integration or end-to-end run shared the CPUs. Other agents' builds and unit tests still ran outside the lock. R2, R3 and R4 saw a 1-minute load average above 6 (R3 from the lock holder before it, decaying through its first phase), so each was repeated once (R3b, R2b, R4b, in that order). For the repeats the driver took the lock, then waited until the 1-minute load was below 2.5 (at most two minutes). Every run's raw output, report, JSON, process logs with the observer's lines, and a load sample every 5 seconds are kept with the task's records. |

### Runs

Every run had 0 unexpected answers, kept every phase's rate (at most 2 late starts, in R4's uncached `ask`) and met every §2 target. `nproc` was 4 at the start, the middle and the end of every run. The **quiet runs** are those whose 1-minute load average stayed at most 6 during the phases: R1 and R3b on Node 22, R2b and R4b on Node 24. The comparison uses them, because the loaded runs' load came from other agents' work, not from the runs; the means over all seven runs are given too and lead to the same verdicts.

| Run | Runtime | Started (UTC) | Set-up (s) | Load avg 1 min: start → middle → end | Highest during the phases | Result |
|---|---|---|---|---|---|---|
| R1 | 22 | 03:41:43 | 3.3 | 1.20 → 0.48 → 0.87 | 1.20 | every target met (quiet) |
| R2 | 24 | 03:48:23 | 3.1 | 1.19 → 2.85 → 0.71 | **7.77** (`signIn`, `getTenant`) | every target met; repeated as R2b |
| R3 | 22 | 03:58:06 | 3.3 | **11.11** → 1.29 → 0.65 | **10.22** (`signIn`) | every target met; repeated as R3b |
| R4 | 24 | 04:04:45 | 3.1 | 0.71 → 0.77 → **7.66** | **13.99** (uncached `ask`, `createTenant`) | every target met; repeated as R4b |
| R3b | 22 | 04:13:29 | 3.3 | 2.16 → 0.37 → 0.08 | 2.16 | every target met (quiet) |
| R2b | 24 | 04:23:56 | 3.2 | 2.34 → 0.34 → 0.69 | 2.88 | every target met (quiet) |
| R4b | 24 | 04:30:37 | 3.1 | 0.66 → 0.18 → 0.12 | 0.79 | every target met (quiet) |

The Verify command (`--duration 10`, 8 accounts, 3 110 requests) ran on Node 24 on fresh stacks before the measured runs (03:23:22) and after them (04:38:25, 04:46:15 with the task's script, and 05:03:44 with the script after the review): every target met, the API's peak 290, 287, 288 and 285 MiB, the worker's 124, 123, 123 and 123 MiB. Its report gives no garbage-collection share, as [`tools/perf/README.md`](../../tools/perf/README.md#garbage-collection) says: its phases last 90 seconds, so fewer than two of the observer's lines fall in them.

**Latency of the quiet runs.** p50 / p95 per phase, and the change of the mean p95 from Node 22 to Node 24 (negative is faster on 24). The last column is the same change over all seven runs.

| Phase | Rate/s | p95 target | R1 (22) | R3b (22) | R2b (24) | R4b (24) | p95 22 → 24, quiet | All runs |
|---|---|---|---|---|---|---|---|---|
| `signIn` | 10 | 800 | 35.5 / 43.1 | 36.0 / 43.9 | 34.5 / 41.8 | 33.7 / 40.8 | 43.5 → 41.3, **−5.1 %** | 44.7 → 46.2, +3.4 % |
| `getTenant` | 50 | 300 | 4.5 / 6.2 | 4.6 / 6.2 | 3.7 / 4.9 | 3.7 / 4.8 | 6.2 → 4.9, **−21.8 %** | 6.1 → 5.9, −3.8 % |
| `listApiKeys` | 50 | 300 | 4.1 / 5.5 | 4.4 / 6.1 | 3.8 / 5.0 | 3.6 / 4.7 | 5.8 → 4.9, **−16.4 %** | 6.1 → 5.3, −12.6 % |
| `tlsAsk` cached | 100 | 20 | 1.4 / 2.0 | 1.6 / 2.3 | 1.2 / 2.5 | 1.3 / 1.8 | 2.15 → 2.15, **0.0 %** | 2.17 → 2.17, +0.4 % |
| `tlsAsk` uncached | 100 | 300 | 1.9 / 2.8 | 2.0 / 2.7 | 1.5 / 3.1 | 1.7 / 2.2 | 2.75 → 2.65, **−3.6 %** | 2.83 → 2.35, −17.1 % |
| `createTenant` | 1 | — | 19.4 / 26.6 | 19.7 / 22.8 | 13.9 / 17.8 | 15.9 / 20.0 | 24.7 → 18.9, **−23.5 %** | 28.8 → 20.3, −29.6 % |

**The loaded runs.** p50 / p95, with the 1-minute load average at the start and the end of each phase: R3 (22) `signIn` 36.9 / 47.1 (9.88 → 4.15), `getTenant` 4.3 / 6.0, `listApiKeys` 4.4 / 6.6, cached `ask` 1.5 / 2.2, uncached `ask` 1.8 / 3.0, `createTenant` 19.6 / 37.0; R2 (24) `signIn` 39.7 / 53.9 (1.33 → 6.91), `getTenant` 3.7 / 7.8 (6.83 → 7.33), `listApiKeys` 3.8 / 5.2, cached `ask` 1.3 / 1.8, uncached `ask` 1.6 / 2.1, `createTenant` 15.4 / 18.6; R4 (24) `signIn` 37.6 / 48.4, `getTenant` 4.4 / 6.1, `listApiKeys` 4.2 / 6.3, cached `ask` 1.2 / 2.6, uncached `ask` 1.3 / 2.0 (1.48 → 13.82), `createTenant` 16.6 / 24.7 (13.99 → 7.66; p99 124 ms). R2's `signIn` and `getTenant` p95s, 25 % above R1's, fell in R2's load of about 7; its repeat R2b, on a quiet machine, was 3 % and 21 % below R1.

**Single runs against the mean.** Against Node 22's mean p95 of the quiet runs, six single Node 24 figures were more than 10 % higher: R2's `signIn` (+24 %) and `getTenant` (+26 %) at a load of about 7, R4's `signIn` (+11 %, 48.4 against 43.5 ms) and cached `ask` (+21 %, 2.6 against 2.15 ms), and R2b's cached (+16 %, 2.5 ms) and uncached `ask` (+13 %, 3.1 against 2.75 ms). Each runtime's own runs spread as widely: Node 24's cached `ask` p95 ranged from 1.8 to 2.6 ms over its four runs and Node 22's `createTenant` from 22.8 to 37.0 ms, and at 2 to 3 ms, 10 % is 0.2 to 0.3 ms, about one scheduling delay. So the threshold is judged on each runtime's mean over its runs (the quiet ones, and all of them as a check), not on one run against another. Read pair by pair instead, in the order the runs were made, the interleaved pairs cross 10 % in R1 → R2's `signIn` (+25 %) and `getTenant` (+26 %), in R2's load of about 7, and in R3 → R4's cached `ask` (+18 %, 2.2 → 2.6 ms); of the quiet pairs, R1 → R2b crosses it in the cached (+25 %, 2.0 → 2.5 ms) and the uncached `ask` (+11 %, 2.8 → 3.1 ms), and R3b → R4b in no phase (each 7 to 23 % faster on Node 24). PBE-076's report leaves that reading to the lead; under it, the proposed task is a re-measurement of the two `ask` phases with more runs per runtime on the throwaway VM ([`node-upgrade.md`](../../docs/mvp/runbooks/node-upgrade.md) §5), and no unit's flags change before it. *2026-11-18 (lead decision (29a) of 2026-11-18, approved by the owner; FIX-W60-SHARED):* the lead kept the reading on the means: the threshold is judged on each runtime's mean p95 over at least two quiet runs (runs under the repeat rule's load limit of 6), and on it the threshold is met (quiet runs −23.5 % to 0.0 % per phase). The single-run and pair crossings of the two `ask` phases are below what the measurement resolves, since their p95s are 2 to 3 ms recorded to 0.1 ms, one runtime's own spread between quiet runs reaches 0.9 ms against a difference of 0.0 to 0.1 ms between the runtimes' means, and both runtimes are about 8 times under the cached `ask`'s 20 ms target; so there is no re-measurement, and the proposed task above is not made.

**CPU per request of the API** (its CPU seconds in the measured seconds over the requests, quiet runs; the share of one CPU in brackets).

| Phase | Node 22 (R1, R3b) | Node 24 (R2b, R4b) | Change |
|---|---|---|---|
| `signIn` | 33.8, 32.9 ms (33 %) | 31.5, 31.0 ms (31 %) | −6 % |
| `getTenant` | 3.9, 3.6 ms (19 %) | 2.6, 2.7 ms (13 %) | −29 % |
| `listApiKeys` | 3.4, 3.4 ms (17 %) | 2.6, 2.5 ms (13 %) | −25 % |
| `tlsAsk` cached | 1.6, 1.7 ms (16 %) | 1.2, 1.3 ms (13 %) | −22 % |
| `tlsAsk` uncached | 1.8, 1.8 ms (18 %) | 1.3, 1.4 ms (14 %) | −24 % |
| `createTenant` | 18.7, 18.2 ms (2 %) | 8.8, 8.2 ms (1 %) | −54 % |

**Memory.** `VmRSS` in MiB after start-up, at its sampled peak and at the end, `VmHWM`, and the headroom under `MemoryMax` (the budget less the larger of the peak and `VmHWM`).

| Run | Runtime | API start → peak → end | API `VmHWM` | API headroom of 768 | Worker start → peak → end | Worker `VmHWM` | Worker headroom of 512 |
|---|---|---|---|---|---|---|---|
| R1 | 22 | 192 → 277 → 233 | 277 | 491 | 119 → 122 → 117 | 123 | 389 |
| R3 | 22 | 196 → 279 → 224 | 280 | 488 | 119 → 122 → 116 | 122 | 390 |
| R3b | 22 | 194 → 280 → 226 | 279 | 489 | 121 → 125 → 119 | 125 | 387 |
| R2 | 24 | 203 → 294 → 294 | 294 | **474** | 121 → 125 → 120 | 126 | 386 |
| R4 | 24 | 197 → 292 → 292 | 292 | 476 | 122 → 126 → 120 | 127 | **385** |
| R2b | 24 | 200 → 289 → 289 | 289 | 479 | 122 → 126 → 120 | 126 | 386 |
| R4b | 24 | 201 → 290 → 290 | 290 | 478 | 122 → 125 → 120 | 125 | 387 |

**Garbage collection.** From the observer's lines in the measured seconds (about 300 s of the API's and the worker's uptime per run, warm-ups included): the milliseconds and pauses in garbage collection, their share of that time, the highest share of any one minute and the longest pause; and the share over the process's whole life, from its exit line (start-up, set-up and shutdown included).

| Run | Runtime | API GC ms (pauses) | API share | API highest minute | API longest pause | API whole life | Worker GC ms (pauses) | Worker share | Worker longest pause | Worker whole life |
|---|---|---|---|---|---|---|---|---|---|---|
| R1 | 22 | 1 433 (933) | 0.48 % | 0.59 % | 18.1 ms | 0.43 % | 10 (14) | 0.00 % | 0.9 ms | 0.04 % |
| R3 | 22 | 1 332 (826) | 0.44 % | 0.55 % | 19.0 ms | 0.39 % | 16 (13) | 0.01 % | 5.4 ms | 0.04 % |
| R3b | 22 | 1 318 (832) | 0.44 % | 0.57 % | 21.0 ms | 0.38 % | 10 (14) | 0.00 % | 1.1 ms | 0.04 % |
| R2 | 24 | 1 141 (718) | 0.38 % | 0.49 % | 14.9 ms | 0.35 % | 31 (18) | 0.01 % | 8.8 ms | 0.05 % |
| R4 | 24 | 1 224 (709) | 0.41 % | 0.58 % | 13.8 ms | 0.37 % | 42 (18) | 0.01 % | 14.9 ms | 0.05 % |
| R2b | 24 | 1 084 (709) | 0.36 % | 0.61 % | 11.5 ms | 0.32 % | 27 (19) | 0.01 % | 7.3 ms | 0.03 % |
| R4b | 24 | 988 (725) | 0.33 % | 0.42 % | 8.8 ms | 0.30 % | 27 (19) | 0.01 % | 8.4 ms | 0.04 % |

Over a whole run the API's collections were mostly scavenges of its 16 MiB young generation: on Node 22 811 to 913 scavenges and 62 to 77 full collections (R1: 1 331 ms and 308 ms), on Node 24 724 to 733 scavenges and 31 to 45 full collections (R4b: 954 ms and 178 ms). The worker made 168 to 197 scavenges of its 1 MiB young generation and 6 or 7 full collections in its whole life, nearly all of them while it started.

### The thresholds

| Threshold (PBE-076 step 4) | Figures on Node 24 | Met |
|---|---|---|
| §2's targets | Highest p95 of all four Node 24 runs, loaded ones included: `signIn` 53.9 ms (< 800), `getTenant` 7.8 and `listApiKeys` 6.3 ms (< 300), cached `ask` 2.6 ms (< 20), uncached `ask` 3.1 ms (< 300); every RSS within its budget | yes |
| No p95 more than 10 % worse than on Node 22 | Mean p95 per runtime, quiet runs: −23.5 % to 0.0 % per phase; all runs: −29.6 % to +3.4 % (`signIn`). Single Node 24 runs were up to 26 % above Node 22's mean (R2 at a load of about 7) and, in a phase with a load below 2, up to 21 % (R4's cached `ask`, 0.45 ms), within each runtime's own spread between runs ("Single runs against the mean" above). Pair by pair, R1 → R2 crosses it in `signIn` (+25 %) and `getTenant` (+26 %), at a load average of about 7, and R1 → R2b and R3 → R4 in the `ask` phases (up to +25 %, 0.5 ms, below what the measurement resolves); lead decision (29a) of 2026-11-18: judged on the means, no re-measurement ("Single runs against the mean" above) | yes, on the means |
| Every peak RSS at least 64 MiB under its `MemoryMax` | API at most 294 MiB, 474 MiB under 768 MiB; worker at most 127 MiB, 385 MiB under 512 MiB | yes |
| At most 5 % of each process's time in garbage collection (the main-thread pause time over the process's elapsed time, which the observer measures; lead decision (29b) of 2026-11-18) | API 0.33 to 0.41 % (highest minute 0.61 %, longest pause 14.9 ms); worker 0.01 % (whole life at most 0.05 %) | yes |

### What the runs show

- **Node 24 meets every target and threshold, by wide margins.** The figures are of the same order as §3's on Node 22: about 41 ms p95 for a sign-in, 5 ms for a read, 2 to 3 ms for an `ask`.
- **Node 24 is not slower; it is cheaper.** On the quiet runs the reads' p95 fell by 16 to 22 %, `createTenant`'s by 24 %, and the API used 22 to 29 % less CPU per read and per `ask` (V8 13.6 against 12.4, and Node 24's own changes; the code and the flags were the same). A sign-in's cost, which is Argon2id on libuv's thread pool, moved by 6 %. The `ask` p95s, around 2 to 3 ms, moved by less than their spread between runs of the same runtime (cached 1.8 to 2.6 ms on Node 24, 2.0 to 2.3 ms on Node 22).
- **The API holds about 12 MiB more on Node 24, and keeps it.** Its peak was 289 to 294 MiB against 277 to 280 MiB, and on Node 24 the RSS stayed at its peak to the end of the run, where Node 22 gave about 50 MiB back after the last phase. Either way 474 MiB or more is left under `MemoryMax`. The worker is the same on both (122 to 127 MiB).
- **Garbage collection costs the API less than half a per cent of its time** with the 16 MiB semi-space of its unit, a little less on Node 24 (0.33 to 0.41 %) than on Node 22 (0.44 to 0.48 %), with fewer full collections and shorter pauses (at most 15 ms against 21 ms). The worker's 1 MiB semi-space costs it nothing measurable here, because the test leaves it nearly idle; its whole-life share, start-up included, is 0.05 % at most.
- **The worker's 1 MiB young generation shows in its memory.** It started at 119 to 122 MiB, about 25 MiB below §3's 145 to 147 MiB, when the run's 16 MiB semi-spaces were V8's choice for the whole machine (§3's dated note; a build of other code, so the figure is indicative).
- **What these figures leave out** is what §3 says it leaves out: Caddy, the VM's other units, its PostgreSQL settings and a busy worker. The throwaway VM's checklist ([`node-upgrade.md`](../../docs/mvp/runbooks/node-upgrade.md) §5) checks each unit's peak memory on Node 24 under systemd.
