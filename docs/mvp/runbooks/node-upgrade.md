# Moving Velexis to a new Node.js major

This runbook moves the whole repository, CI, the release build and the VM from one Node.js major to the next, as [ADR-0029](../adr/0029-nodejs-24-runtime.md) decided for Node.js 22 → 24. The move has two parts: a **trial** that runs everything on the new major without changing what pins the old one (§2, task X-046), and one **switch** commit that changes every pin at once (§3, task X-048), followed by the developer's machine (§4), the VM (§5) and, if needed, the way back (§6). Task X-046 in [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) wrote §1 and §2; X-048 wrote §3 to §6 and brought §1 to Node 24 (2026-11-17).

Related: [ADR-0029](../adr/0029-nodejs-24-runtime.md) (the decision, items 1 to 11, and the approved decisions D1–D18); [ADR-0002](../adr/0002-monorepo-pnpm-turborepo.md) item 1; [`tech-stack.md`](../tech-stack.md) §1; [`local-development.md`](../local-development.md) §1 and §2; [`deployment-single-vm.md`](../deployment-single-vm.md) §2, §3 and §12; [`tools/e2e/README.md`](../../../tools/e2e/README.md) (running the journeys); [`ota/sdk/README.md`](../../../ota/sdk/README.md) §8.1 (the SDK's smoke tests).

## 1. What decides the Node version

Only the **major** is compared anywhere; the patch versions of CI, the release build, the VM and a developer's machine may differ. [ADR-0029](../adr/0029-nodejs-24-runtime.md) item 2 names `.nvmrc` the source and lists the places that must name the same major. Since X-048 (2026-11-17, §3) they all say 24; until then they said 22, as the trial of §2 found them:

| Place | Today | What reads it |
|---|---|---|
| `.nvmrc` | `24` | `nvm install` and `nvm use` in the repository root ([`local-development.md`](../local-development.md) §2); every `actions/setup-node` step of `.github/workflows/ci.yml`, `e2e.yml` and `deploy.yml` (`node-version-file: .nvmrc`), which takes the runner image's cached newest 24.x, so the release build of `deploy.yml` too. |
| Root `package.json`, `engines.node` | `>=24 <25` | pnpm, which only warns (`WARN  Unsupported engine`, no `engine-strict`) when the running Node is outside the range. |
| `deploy/scripts/provision-vm.sh`, `NODE_MAJOR` default | `24` | Step `packages` writes NodeSource's source line `node_${NODE_MAJOR}.x`; step `node` writes that line and the `nodejs` pin (`/etc/apt/preferences.d/velexis-nodejs`, priority 1001), installs `nodejs` with `--allow-downgrades`, refuses another major and enables pnpm through corepack (X-047; `NODE_MAJOR=<n> --steps node` moves a provisioned VM either way, §5 and §6). |
| `deploy/scripts/check-vm.sh`, its Node item (`${NODE_MAJOR:-24}`), and the fixture of `deploy/scripts/test/check-vm.test.sh` | `v24.*`, the pin and `node_24.x`; the fixture `v24.22.3` and `node_24.x` | The VM check after provisioning ([`deployment-single-vm.md`](../deployment-single-vm.md) §3): the version, the pin and the source line against the `NODE_MAJOR` it is given (X-047). |
| `@types/node` in the 15 `package.json` files that declare it, and in `pnpm-lock.yaml` | `24.19.2` (`typeScriptVersion` 5.6) | `pnpm typecheck`; `.github/dependabot.yml` ignores its major updates, so later 24.x types come as patches and minors, each taken only with `typeScriptVersion` 5.6 or lower ([`tools/ci/README.md`](../../../tools/ci/README.md), Dependabot). |
| `deploy/demo-deployment.html` | `nvm install 24`, `nvm alias default 24`, `nvm use 24` (Part B1); its `start.sh` checks the major of `.nvmrc` (`ensure_node_major`) | The owner's demo guide. |
| The release | `RELEASE.json` `node` = `process.version` of the build ([`pack-release.sh`](../../../deploy/scripts/pack-release.sh)) | `velexis-deploy` refuses a release whose build major differs from the VM's `node` on its first activation ([`deploy.sh`](../../../deploy/scripts/deploy.sh) step 1); `--rollback` does not check ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 10, D12). |
| The agents' machine | Since the integrator's switch after X-048's wave ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 3), `/opt/node24` holds the official v24.22.3, checked against nodejs.org's `SHASUMS256.txt` (the image's v24.22.1 is kept in `/opt/node24-v24.22.1`), and `/etc/profile.d/nodejs.sh` puts `/opt/node24/bin` first on `PATH`, before `/opt/node22/bin`; `/opt/node22` (v22.23.4) stays for the comparisons of §2, OBE-103 and PBE-076. The agents' tool shells take `PATH` from the container, whose first `node` is `/opt/node22/bin`'s whatever `/etc/profile.d` says, so agents run every command as `PATH=/opt/node24/bin:$PATH <command>` (lead decision (28a) of 2026-11-18). The owner's personal cloud environment installs the same Node 24 in its setup script. *(Brought up to date 2026-11-18, FIX-W60-SHARED.)* | pnpm (`/opt/node-tools`, 10.28.0, which runs the `packageManager` pnpm 9.15.9) and every script run with `#!/usr/bin/env node` take the first `node` on `PATH`, so in an agent's tool shell a command without that prefix runs on v22.23.4. |
| `tools/ci/node-major.test.mjs` (X-047) | the guard | `node --test tools/ci/*.test.mjs` (ci.yml's `build-test`): fails, naming the file, the line and both majors, when any place above names another major than `.nvmrc` (every `@types/node@` entry of the lockfile included), or when a workflow's `actions/setup-node` step stops reading `node-version-file: .nvmrc`; only the jobs of its `EXEMPT_JOBS` (since SDK-019 only ci.yml's `sdk-node22`, the SDK's tests on Node.js 22.12.0, [ADR-0029](../adr/0029-nodejs-24-runtime.md) item 9) may set their own `node-version`. |
| `turbo.json`, `globalDependencies` | `.nvmrc` (X-047) | Turborepo, which hashes no runtime version: a change of the major misses every cached task, and a revert finds the old entries again ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 4). |
| The seven app units' `NODE_OPTIONS` (X-050) | `--max-old-space-size` and `--max-semi-space-size` in one quoted `Environment="NODE_OPTIONS=…"` assignment | Not a copy of the major, but what keeps each unit's heap the same on either one ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 5): `tools/perf/unit-node-options.test.mjs` checks the unit files (CI's `build-test`), and `deploy/systemd/test/units-smoke.sh` step 5 checks each real unit under systemd (CI's `systemd-units`): V8's heap limit is old + 3 × semi of its flags and Node's constrained memory is its `MemoryMax`. |

Nothing else pins the major. No native addon is rebuilt on install (`pnpm.onlyBuiltDependencies` is empty), and every addon the build and the tests load is N-API (§2.6), so one `node_modules` serves both majors. X-047 added the guards of ADR-0029 items 2, 4 and 6 (`tools/ci/node-major.test.mjs`, `.nvmrc` as a Turborepo global dependency, `NODE_MAJOR` both ways) and X-050 the units' young generation of item 5; the last three rows of the table name them.

## 2. The trial: the whole repository on the new major, nothing switched

The trial runs every command of CI, the end-to-end journeys and the deploy tests on the new major, from a worktree whose pins still say the old one. It changes no code, test or timeout, and never one of the 30 assertions of an empty child stderr (`git grep -n 'stderr)\.toBe("")' -- ':!docs/mvp/plans'`; the dot is escaped so that this line does not match itself). Every failure and every warning from the repository's own code that no task already covers becomes a task that the switch waits for (§2.7).

### 2.1 How to run it

1. Download the newest `node-v<major>.*-linux-x64.tar.xz` from `https://nodejs.org/dist/latest-v<major>.x/` and that folder's `SHASUMS256.txt` into a scratch folder outside the repository, check it (`grep ' node-v24.22.3-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -`), unpack it and call its `bin` folder `NODE24`. Run every command below as `PATH="$NODE24:$PATH" <command>`; pnpm then runs on the new major too.
2. Change nothing that pins the major (§1).
3. Run the commands of §2.3 in their order with Turborepo's cache bypassed (`TURBO_FORCE=true`), under the machine's end-to-end lock where they start fixed ports or system users (one run at a time per machine, [`tools/e2e/README.md`](../../../tools/e2e/README.md)), and with a Redis of their own on a shared machine. Record each command's result and duration. Turborepo stops at the first failed task, so repeat a failed `pnpm test` as `pnpm run test --continue` (pnpm refuses `pnpm test --continue`) and a failed `pnpm test:int` as `pnpm test:int --continue`, and run a timed-out test alone on both majors before calling it a finding.
4. Run `pnpm test` and `pnpm test:int` once more with `NODE_OPTIONS="--trace-deprecation --trace-warnings"`, keep the end-to-end servers' logs, and list every warning with its source (§2.4).
5. Typecheck against the new major's `@types/node` without committing it (§2.5), and record the runtime's versions and the native addons (§2.6).

### 2.2 This run (X-046, 2026-11-16)

Recorded while the trial ran. The commands ran one after the other on the agents' machine, in the worktree of branch `task/X-046-node24-trial`.

| | |
|---|---|
| Date | 2026-11-16 (UTC) |
| Commit | `b7f87fd817a8d2a75989fd7b9b764f9336e468d8` (the integration branch `claude/intelligent-bardeen-90hhu7` at the start of wave 57; PBE-077 not merged) |
| Machine | The agents' cloud container: Ubuntu 24.04.5 LTS, kernel 6.18.44, 4 CPUs (`nproc`), 15 GiB of memory, root, no systemd as PID 1; shared with the other agents of the wave |
| Load average | 0.24 0.42 0.24 (1, 5 and 15 minutes) at the start of the install; between about 1 and 18 during the run, from the other agents' builds and tests (the trial's record keeps each command's figures) |
| Duration | 14:59 to 16:38 UTC for steps 2 to 5, one command after the other; the commands that start fixed ports or system users held the machine's end-to-end lock, and a private Redis with a password served the tests |
| Node | v24.22.3 (2026-11-10, the security release), the official `node-v24.22.3-linux-x64.tar.xz`: SHA-256 `4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb`, checked with `sha256sum -c` against `https://nodejs.org/dist/v24.22.3/SHASUMS256.txt`; `latest-v24.x` still listed v24.22.3 on 2026-11-16, and the unpacked `bin/node` equals the tarball's (SHA-256 `a7ec1b37…ca1ac01`) |
| pnpm | 9.15.9 (`packageManager`), run on v24.22.3 (`npm_config_user_agent`: `pnpm/9.15.9 npm/? node/v24.22.3 linux x64`) by the machine's pnpm 10.28.0 |
| Services | PostgreSQL 16.15, Redis 7.0.15 (a private server with a password; CI uses 7.4), Mailpit 1.29.7; Chromium 153.0.8010.12 of `/opt/pw-browsers` with Playwright 1.65.0 |
| Turborepo | 2.11.10, `TURBO_FORCE=true` |

### 2.3 Step 2: every command on Node 24

| Command | Result | Duration |
|---|---|---|
| `pnpm install --frozen-lockfile` | Passed. One ` WARN  Unsupported engine: wanted: {"node":">=22 <23"} (current: {"node":"v24.22.3","pnpm":"9.15.9"})`, as expected; nothing rebuilt | 21 s |
| `pnpm dev:keys` (CI's set-up step before the tests) | Passed: 5 key files created | 1 s |
| `pnpm format:check` | Passed | 48 s |
| `pnpm lint` | Passed: 29 tasks, none cached | 174 s |
| `pnpm typecheck` | Passed: 19 `tsc` runs in 15 packages (28 tasks with the builds they need), none cached | 72 s |
| `pnpm test` | **Failed**, as expected: `platform/backend` `src/domains/hostname-rules.test.ts` › "refuses the malformed host \"xn--zz.example.com\"" (1 of 1,644 tests of the package; **PBE-077**). Turborepo stops at the first failed task, so the OTA packages' tests were cut short; see the next row | 120 s |
| `pnpm run test --continue` (every package, past the first failure; `pnpm test --continue` is refused by pnpm itself; run after the deploy tests) | 28 of 29 tasks passed; 9,128 of 9,129 tests in 17 packages passed. The one failure is PBE-077's case above; every OTA package passed (`ota/backend` 2,341, `ota/admin` 714, `ota/sdk` 1,080, `ota/frontend` 666 tests) | 274 s |
| `pnpm build` | Passed: 19 tasks, none cached | 95 s |
| `pnpm test:int` (with the PAN-absence proof of ci.yml's integration job after it) | **Failed** (`ota/backend`: 2 of 1,516 tests): "applies 0001 and 0002 to an empty schema…" and "upgrades a schema at N-1…" of `test/integration/migrations/tenant-0002.int.test.ts` each hit Vitest's 5 s budget while the machine's load average was 8 to 16 (the other agents' builds and tests; the file's other tests took 1 to 3 s where Node 22 runs of earlier waves took 0.3 to 1 s). Turborepo stopped there, so `platform/backend` did not run; the next row and §2.7 (load, not Node 24). `packages/db` (78), `tools/reference-data` (7) and `packages/testing` (31) passed. The PAN-absence proof passed: every path scanned, nothing found | 884 s |
| `pnpm test:int --continue` (every package, past the first failure; run right after the deploy tests) | Passed: all 17 tasks; `ota/backend` 1,516 of 1,516 tests (`tenant-0002.int.test.ts` included), `platform/backend` 1,256 of 1,256 | 1,078 s |
| `pnpm --filter @velexis/platform-backend test:xb` | Passed: 14 tests | 38 s |
| `pnpm --filter @velexis/ota-backend test:xb` | Passed: 9 tests | 20 s |
| `pnpm test:e2e -- --project=portal --project=platform-admin --project=storefront --project=ota-admin` (`E2E_WITH_OTA=1`, the built apps started on Node 24, `E2E_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`) | Passed: 387 tests in 16.6 min (the storefront guards' test that must fail did); no process warning in any of the 15 stack logs | 1,003 s |
| `E2E_STRIPE=1 pnpm test:e2e -- --project=storefront-stripe --project=portal-stripe --list` | Listed: 16 `storefront-stripe` and 4 `portal-stripe` tests in 3 files. They drive Stripe's test mode over the network with the repository's Stripe test secrets, which the agents' machine does not have: the nightly E2E run on the switch's commit is their proof (§2.8) | 3 s |
| `pnpm --filter @velexis/ota-sdk test:smoke`, against the built OTA API, the Amadeus stub and both `dev:seed` commands started on Node 24 as e2e.yml's step does (a scratch database, never the shared one) | Passed: 24 tests in 2 files; both seeds wrote nothing on stderr | 13 s |
| `node --test tools/ci/*.test.mjs` | Passed: 72 tests | 7 s |
| `node --test tools/perf/*.test.mjs` | Passed: 17 tests | < 1 s |
| `node --test tools/dev/dev-keys.test.mjs` | Passed: 6 tests | < 1 s |
| `node --test tools/plan-lint/test/` | Passed: 13 tests | 1 s |
| `bash deploy/scripts/test/deploy.test.sh` | Passed: 133 checks, 51 runs of `deploy.sh` | 85 s |
| `bash deploy/scripts/test/healthcheck.test.sh` | Passed: 62 checks | 50 s |
| `bash deploy/scripts/test/log-review.test.sh` | Passed: 161 checks | 14 s |
| `bash deploy/scripts/test/ship-logs.test.sh` | Passed: 80 checks | 1 s |
| `bash deploy/scripts/test/backup-restore.test.sh` | Passed: 72 checks, 30 runs of `backup.sh` and `restore.sh` | 25 s |
| `sudo env PATH="$PATH" bash deploy/scripts/test/check-vm.test.sh` (as root, the real `sshd -t`/`sshd -T` through `CHECKVM_SSHD` and the real `nft` in a private network namespace) | Passed: 394 checks | 52 s |
| Release dry run (`RELEASE_SHA=<commit> bash deploy/scripts/pack-release.sh <folder>`, then `sha256sum --quiet -c SHA256SUMS`) | Passed: the six apps of `RELEASE.json` (`platform-backend`, `ota-backend`, `platform-frontend`, `platform-admin`, `ota-admin`, `storefront`), `db`, `reference-data` and the Velexis Caddy built from its pinned sources, 462 MB; `RELEASE.json` records `"node":"v24.22.3"`, so `velexis-deploy` would refuse this release on a VM that runs Node 22 (§1) | 60 s |
| `SMOKE_TMPDIR=/tmp CADDY=<the Velexis Caddy> bash deploy/caddy/test/caddy-smoke.sh` (its echo upstreams on Node 24) | Passed: 792 checks. It needs no root and no systemd, so it ran here | 19 s |
| `SMOKE_NODE="$NODE24/node" bash deploy/systemd/test/units-smoke.sh` (as root) | Steps 1 to 3 passed (56 checks: the units' offline security ratings, `provision-vm.sh --steps users,keys,envfiles` twice under a prefix, the OS user boundary with a Node 24 process of `velexis-ota`); then the expected `FAIL systemd is not the init system here: steps 1 to 3 ran, steps 4 to 11 need systemd as PID 1`. Steps 4 to 11 are CI's `systemd-units` job on X-048 (§2.8) | 5 s |

The other Node steps of ci.yml's jobs, replayed on Node 24 after the commands above:

| Command (ci.yml step) | Result | Duration |
|---|---|---|
| `node tools/plan-lint/plan-lint.mjs` (plan-lint) | Passed: `ERRORS: 0`, 352 tasks | < 1 s |
| `node tools/ci/check-package-json.mjs` (build-test: the package.json files and the action pins) | Passed: 18 package.json files, 3 workflows, 0 problems | < 1 s |
| `pnpm exec eslint tools/ci && pnpm exec eslint tools/perf` (build-test) | Passed | 3 s |
| `node tools/ci/check-no-hardcoded-hosts.mjs` (alt-hosts) | Passed: 1,145 files, 0 problems | 3 s |
| `pnpm contracts:generate`, `pnpm db:migrate` (a scratch database) and `pnpm db:codegen`, `pnpm --filter @velexis/ota-backend amadeus:types`, `pnpm --filter @velexis/ota-sdk generate` (build-test: generated files and the SDK route table up to date) | Passed: every generated file unchanged (`git diff --exit-code`, `git status --porcelain`) | 15 s |
| `pnpm dev:keys`, a second time (dev-setup, X-016 AC3) | Passed: 0 created, 0 replaced, 5 kept | 1 s |
| `env -u TURBO_FORCE pnpm exec turbo run typecheck test --dry=json`, on Node 24 and then on Node 22 (`/opt/node22`) | All 60 task hashes are the same on both majors, and both see the same 44 cache hits: Turborepo hashes no runtime version (ADR-0029 item 4, D8). The machine's worktrees share one Turborepo cache, so those entries may also come from other runs at the same commit; with a cache folder of its own (`--cache-dir`), `turbo run test --filter=@velexis/logger` on Node 24 wrote one entry, and the same command on Node 22 found it (`HIT`, `LOCAL`), so an entry written on one major replays on the other. Its global inputs hold the root `engines` field, so X-048's change of `engines.node` changes every hash once; a run on another major with the same `engines` (this trial, or a developer's machine on the wrong Node) replays until X-047 makes `.nvmrc` a global dependency. Every command of this trial bypassed the cache (`TURBO_FORCE=true`) | 3 s each |

### 2.4 Step 3: warnings and their sources

The warnings run repeated `pnpm test` and `pnpm test:int` on Node 24 with `NODE_OPTIONS="--trace-deprecation --trace-warnings"` (`pnpm run test --continue` and `pnpm test:int --continue`, so that every package ran; Turborepo passes `NODE_OPTIONS` to the tasks and Vitest to its workers, which a `--require` probe showed):

| Command | Result | Duration |
|---|---|---|
| `NODE_OPTIONS="--trace-deprecation --trace-warnings" pnpm run test --continue` | 28 of 29 tasks passed; the one failure is PBE-077's case (§2.3) | 197 s |
| `NODE_OPTIONS="--trace-deprecation --trace-warnings" pnpm test:int --continue` | Passed: all 17 tasks (`ota/backend` 1,516 and `platform/backend` 1,256 tests) | 1,092 s |

Every log of §2.3 and of this run (55 command logs), the 15 end-to-end servers' logs (`test-results/<subdir>/stack/`, kept from the run of §2.3) and the SDK smoke test's API, stub and seed logs were searched for `(node:<pid>) … Warning:` lines, the form in which Node prints a `DeprecationWarning`, `TimeoutNegativeWarning`, `TimeoutNaNWarning`, `ExperimentalWarning` or `SecurityWarning`. A control test that calls `url.parse()` and `setTimeout(…, -1)` inside a Vitest worker showed that such warnings reach the log with their source. The 30 assertions of an empty child stderr passed on Node 24 wherever they ran, and all of them in the `--continue` runs.

| Warning | Source | Verdict |
|---|---|---|
| None from the repository's own code, from its dependencies inside the build, the tests, the end-to-end servers or the smoke test's API | – | No task |
| `[DEP0169] DeprecationWarning: url.parse() …` | pnpm 9.15.9 itself: `toNerfDart` in `dist/pnpm.cjs` (line 75882), from `getAuthHeadersFromConfig` when a command builds a registry resolver (`pnpm outdated`, `pnpm dlx`, …). Node prints it only for code outside `node_modules`: here for the pnpm that corepack 0.36.0 of Node 24 downloaded (`corepack pnpm@9.15.9 outdated`), never for the machine's pnpm, whose 9.15.9 lives in a `node_modules` folder | Expected, as ADR-0029 says (corepack's shim, a global pnpm, `/usr/bin/pnpm` on the VM); not a finding |

Messages that look like warnings but are not Node's, and print the same on Node 22: pnpm's ` WARN  Unsupported engine` (the root `engines.node`, until X-048); Vitest's `Testing types with tsc and vue-tsc is an experimental feature.` (the type tests of `packages/config`); Turborepo's `no output files found for task …#test`; pnpm's `deprecated eslint@9.39.5` and `9 deprecated subdependencies found` during step 4's `pnpm install --no-frozen-lockfile`, which reads the registry's metadata; and the scripts' own `WARNING:` lines that their tests expect.

### 2.5 Step 4: the Node 24 types

`npm view @types/node@24 version` listed 24.19.2 as the newest 24.x on 2026-11-16, and `npm view @types/node@24.19.2 typeScriptVersion` printed `5.6`. On Node 24:

| Command | Result | Duration |
|---|---|---|
| `@types/node` `22.20.5` → `24.19.2` in the 15 `package.json` files that declare it (`sed`), then `pnpm install --no-frozen-lockfile` | Passed. The lockfile then holds `@types/node@24.19.2` and `undici-types@7.24.6` (from 6.21.0) and no `@types/node@22`; with the `(@types/node@…)` peer suffixes removed, its 931 other package keys are the same as before | 5 s |
| `pnpm typecheck` | Passed: the 19 `tsc` runs, none cached | 70 s |
| `git checkout -- <the 15 package.json files> pnpm-lock.yaml`, then `pnpm install --frozen-lockfile` | Restored: `git status` shows only this runbook, and the 15 files declare `22.20.5` again | 2 s |

X-048 committed the bump (§3).

### 2.6 Step 5: the runtime and the native addons

`node -p process.versions` on both majors of the agents' machine (`/opt/node22/bin/node` and `NODE24`; 2 s on Node 24 with the `corepack`, `npm` and root-certificate lines):

| | Node 22 (`/opt/node22`) | Node 24 (`NODE24`) |
|---|---|---|
| node | 22.23.4 | 24.22.3 |
| modules (`NODE_MODULE_VERSION`) | 127 | 137 |
| napi | 10 | 10 |
| v8 | 12.4.254.21-node.57 | 13.6.233.17-node.63 |
| openssl | 3.5.9 | 3.5.9 |
| ada | 2.9.2 | 4.0.0 (the punycode change of PBE-077) |
| undici | 6.29.1 | 7.30.2 |
| icu | 78.3 | 78.3 |
| tz | 2026e | 2026e |
| uv | 1.51.0 | 1.52.1 |
| llhttp | 9.4.3 | 9.4.4 |
| Bundled root certificates | 116 (`tls.rootCertificates`) | 118 (`tls.getCACertificates("bundled")`) |
| corepack, npm | 0.36.0, 10.9.9 | 0.36.0, 11.19.1 |

The native addons the build and the tests load, and `@napi-rs/lzma`, each loaded by one Node 24 process from the install of §2.3 (`require` of the package, then the `.node` files the process mapped, from `/proc/self/maps`, and `nm -D <file>`; under 1 s on each major):

| Addon | File loaded (under `node_modules/.pnpm/`) | `napi_register_module_v1` |
|---|---|---|
| argon2 0.45.2 | `argon2@0.45.2/node_modules/argon2/prebuilds/linux-x64/argon2.glibc.node` | 1 |
| sharp 0.35.5 | `@img+sharp-linux-x64@0.35.5/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node` | 1 |
| msgpackr-extract 3.0.4 | `@msgpackr-extract+msgpackr-extract-linux-x64@3.0.4/…/node.napi.glibc.node` (the package also ships `node.abi115.*` builds for Node 20, which neither major loads) | 1 |
| `@next/swc` 15.5.29 | `@next+swc-linux-x64-gnu@15.5.29/…/next-swc.linux-x64-gnu.node` | 1 |
| rollup 4.65.0 | `@rollup+rollup-linux-x64-gnu@4.65.0/…/rollup.linux-x64-gnu.node` | 1 |
| lightningcss 1.30.2 | `lightningcss-linux-x64-gnu@1.30.2/…/lightningcss.linux-x64-gnu.node` | 1 |
| `@tailwindcss/oxide` 4.1.18 | `@tailwindcss+oxide-linux-x64-gnu@4.1.18/…/tailwindcss-oxide.linux-x64-gnu.node` | 1 |
| `@napi-rs/lzma` 1.5.1 (an optional dependency of rollup that rollup's code never loads; loaded here directly) | `@napi-rs+lzma-linux-x64-gnu@1.5.1/…/lzma.linux-x64-gnu.node` | 1 |

All eight load on v24.22.3 and on v22.23.4 from the same install, and none exports a `node_register_module_v*` symbol (no ABI-bound module). pnpm built nothing: the install printed `The following dependencies have build scripts that were ignored: argon2, esbuild, msgpackr-extract`, because `pnpm.onlyBuiltDependencies` is empty, and every package above ships its prebuilt binary. `@napi-rs/lzma-linux-x64-gnu` declares `engines.node` `^22.20 || ^24.12 || >=25`: on Node 22.12 (SDK-019's job) pnpm 9.15.9 warns and skips it, as it skips every optional dependency whose `engines` the running Node does not meet (`packageIsInstallable`), which leaves rollup working.

### 2.7 Findings and their tasks

| Finding | Where | Task |
|---|---|---|
| ada 4.0.0 accepts the invalid punycode label `xn--zz`: `checkCustomHostname` no longer refuses `xn--zz.example.com` | `platform/backend/src/domains/hostname-rules.test.ts`, "refuses the malformed host \"xn--zz.example.com\"" (the only failing test of `pnpm test`, §2.3) | **PBE-077** (known before the trial; ADR-0029 item 7) |

Nothing else failed on Node 24, and no warning came from the repository's own code (§2.4), so the trial adds no task block: X-048 waits for PBE-077, X-047 and X-050, and for nothing new.

Not a Node 24 finding: in the first `pnpm test:int`, two tests of `ota/backend/test/integration/migrations/tenant-0002.int.test.ts` ("applies 0001 and 0002 to an empty schema…" and "upgrades a schema at N-1…", which provision tenant schemas inside the test) went past Vitest's 5 s budget while the machine's load average was between 8 and 16 from the other agents' work. They passed in both later full runs on Node 24 (§2.3 and §2.4), and alone, three times on each major under the end-to-end lock, they took:

| Run (load average) | Node 24: file, first test, second test | Node 22: file, first test, second test |
|---|---|---|
| 1 (about 16 to 18) | 11.6 s, 837 ms, 1,861 ms | 12.6 s, 959 ms, 1,401 ms |
| 2 (about 4) | 4.5 s, 312 ms, 761 ms | 5.8 s, 499 ms, 751 ms |
| 3 (about 3.5) | 4.3 s, 367 ms, 601 ms | 7.0 s, 540 ms, 1,178 ms |

Node 24 is as fast as Node 22 here, and the times follow the machine's load. In the two full runs on Node 24 that passed, the two tests took 371 and 752 ms (§2.3) and 543 and 1,090 ms (§2.4), within what the integrator's full runs on Node 22 of waves 54 to 56 recorded (344 to 582 ms and 731 to 1,085 ms). The lead decides whether the file's load sensitivity on a shared machine needs a task of its own (outside the move to Node 24).

Follow-up (2026-11-18, lead decision (27a), FIX-W59-TESTS, a fix under OBE-008): the two tests' schema provisioning (and the second's baseline rows) moved into `beforeAll` hooks of their own describe blocks, with every assertion kept: the first test checks what its hook's provisioning returned, and the second's deploy fan-out still runs in the test; on Node 24 under the end-to-end lock, their bodies took 329 to 360 ms and 565 to 634 ms before and 115 to 137 ms and 145 to 160 ms after (three interleaved runs each, load average 1.4 to 1.8; hooks 235 to 351 ms and 500 to 567 ms), and beside four busy-looping processes (load average 2.9 to 4.2) 1,240 and 2,326 ms before and 96 and 161 ms after. Beside the same load the file's own teardown, outside (27a), still went past Vitest's default hook budget of 10 s while every test passed: its file-level `afterAll` (the drop of the file's database clone) failed the file in both runs before and in 3 of 5 after (the other two took 9.9 and 6.1 s); unloaded it takes 0.3 to 0.4 s. The lead decides whether it needs a task.

Follow-up (2026-11-18, lead decision (29g), FIX-W60-TESTS, a fix under X-015 and OBE-008): the teardown failure came from PostgreSQL 16, not from Node. `DROP DATABASE` waits for a forced checkpoint (for the run's first drop, one that flushes the template's files) and then removes the database's files, which beside the four busy loops took more than Vitest's 10 s hook budget; the timed-out hook's drop kept running and had marked the clone invalid (`datconnlimit` -2), so the global teardown's `ALTER DATABASE` failed with "cannot alter invalid database" and the run's template was left behind. `@velexis/testing` now drops such a database with `DROP DATABASE IF EXISTS … WITH (FORCE)` alone (a connection per attempt, SQLSTATE 55000 retried), flushes the template's files during the untimed global setup (a throwaway `CREATE DATABASE … TEMPLATE template0` and its `DROP`), and exports `TEST_DATABASE_DROP_BUDGET_MS` (60 s), the explicit, commented budget of `tenant-0002.int.test.ts`'s file-level `afterAll`. Beside four busy loops on Node 24 (three runs each): before, 3 of 3 runs failed the hook and left the template; after, 3 of 3 passed and left no `velexis_test%` database, the clone's drop taking 9.9 to 10.2 s (13.7 to 15.0 s without the flush in the global setup). Details in OBE-008's block of [ota/docs/plans/agent-tasks.md](../../../ota/docs/plans/agent-tasks.md) and in [packages/testing/README.md](../../../packages/testing/README.md).

### 2.8 What only CI and the VM can prove

The agents' machine has no systemd as PID 1, no Stripe test secrets, no second host name for PostgreSQL and Redis, and no NodeSource package. These parts of the move are proven elsewhere:

- **CI on X-048's commit** (`actions/setup-node` then reads `.nvmrc` `24`): every job's setup step logs a v24.x; Turborepo's first run shows no cache hit (the commit changes `engines.node`, a global input, §2.3, and X-047 makes `.nvmrc` a global dependency, ADR-0029 item 4);
  - `systemd-units`: steps 4 to 11 of `units-smoke.sh` with the real units under systemd, on Node 24, including X-050's check that V8's heap limit is old + 3 × semi of each unit's flags;
  - `deploy-files`: the Velexis Caddy build, `caddy validate`, `systemd-analyze verify` and the units' sandboxing (the deploy tests and `caddy-smoke.sh` of that job also ran here, §2.3);
  - `dev-setup`: `corepack enable` with Node 24's corepack, then `dev-setup.sh` twice on a fresh runner (here pnpm came from the machine's pnpm 10.28.0; corepack 0.36.0 ran pnpm 9.15.9 in §2.4's check);
  - `alt-hosts`: the integration tests with PostgreSQL over TLS only (`sslmode=verify-full`) and Redis on other host names and ports. Its throwaway CA and server key are RSA-2048, which OpenSSL's security level 2 accepts: a Node 24 TLS client verified such a chain here (TLSv1.3), as Node 22 did;
  - `build-test` and `integration` as a whole, on a runner instead of a shared machine (§2.7's timeouts).
- **The E2E run on X-048's commit and the next nightly run** on the default branch: the four projects and the SDK's smoke tests on the runner, and the `storefront-stripe` and `portal-stripe` projects, which need the Stripe test secrets (§2.3 only lists them).
- **The throwaway VM** (§5, X-048; ADR-0029 items 6 and 8): NodeSource's `node_24.x` package for Ubuntu Noble and its corepack (D11), the TLS handshakes from Node 24 to the configured SMTP relays, `api.stripe.com`, `connect.stripe.com`, `test.travel.api.amadeus.com` and `travel.api.amadeus.com` (D13; the agents' proxy re-signs TLS, so no external peer can be judged here), each app unit's peak memory against its `MemoryMax`, the `NODE_MAJOR` round trip with `check-vm.sh`, and what the next daily AIDE check makes of a Node package: the files that the round trip through `provision-vm.sh --steps node` replaces show up as `(expected)` in `log-review.sh`'s daily summary, because a `provision-vm.sh started` line falls between the two AIDE checks (§5 step 8), and only a manual package update (`apt-get install --only-upgrade nodejs`) raises `aide-change`, which the operator explains (reworded 2026-11-18, lead decision (28c)).

## 3. The switch

Task X-048 made the switch on 2026-11-17, in wave 58, alone, as [ADR-0029](../adr/0029-nodejs-24-runtime.md) item 3 and decision D17 require: one commit (`Task: X-048`), which the integrator squash-merges by itself, so that reverting it is the whole rollback in git (§6.1). It was made and proven on Node.js 24, from the worktree of branch `task/X-048-switch-to-node24` (base `f6a0a3c6`, the integration branch after wave 57).

### 3.1 What the commit changes

- **The pins** (§1): `.nvmrc` `24`; the root `engines.node` `>=24 <25` on the same line, the `pnpm` range unchanged (so `package.json`'s line 35, which the PCI pack cites, does not move); `@types/node` 22.20.5 → 24.19.2 in the 15 `package.json` files that declare it. `npm view @types/node@24 version` listed 24.19.2 as the newest 24.x on 2026-11-17, and `npm view @types/node@24.19.2 typeScriptVersion` printed `5.6` (D7). `pnpm install` on Node 24 then regenerated the lockfile: 94 lines changed, `@types/node@24.19.2` and `undici-types@7.24.6` (from 6.21.0) replace the old entries, and the rest are the `(@types/node@…)` peer suffixes; `grep -c '@types/node@22' pnpm-lock.yaml` prints `0` (it printed 40 before).
- **The VM** (one commit with the pins, because `velexis-deploy` refuses a release whose build major differs from the VM's): `provision-vm.sh`'s `NODE_MAJOR` default `24` (step `node`'s header names no major since X-047, lead decision (27c)), `check-vm.sh`'s `${NODE_MAJOR:-24}`, `check-vm.test.sh`'s healthy fixture `v24.22.3` and `node_24.x`, and the reason of `deb.nodesource.com` in `deploy/egress/allowed-hosts.conf`. Each of these is a one-line change in place, so no file:line reference of the PCI pack moved (the pack's 474 references were checked, 0 problems).
- **One test**: `platform/backend/src/domains/hostname-rules.test.ts` `[X-048 AC3] refuses ١٢٣.com (Arabic-Indic digits), which Node 22 stored as xn--9hbcd.com, as syntax` (ADR-0029 item 7, D14), and the same host typed as punycode, `xn--9hbcd.com`, which ada 4.0.0 no longer decodes (`punycodeLabelsRoundTrip` refuses it). It passes on v24.22.3 and fails on v22.23.4, where `url.domainToASCII("١٢٣.com")` answers `xn--9hbcd.com` and `xn--9hbcd.com` decodes back to `١٢٣.com`.
- **Text** that names the major: `.github/dependabot.yml`'s comment of the `@types/node` rule and the title of the `[X-019 AC4]` test of `tools/ci/ci-workflow.test.mjs` (its assertions unchanged); `tools/ci/README.md`; the demo page's Part B1 (`nvm install 24`, `v24.`) and its `start.sh`, whose `ensure_node_major` reads the major from `.nvmrc`; `deploy/README.md`, `README.md`, `AGENTS.md` §10, `architecture.md`, `local-development.md` §1, §2 and §8, `deployment-single-vm.md` §2, §3, §8 and §14, `tech-stack.md` §1, §3 and §4 (the SDK's row is SDK-019's); dated revisions of ADR-0002 item 1, ADR-0007 (Host) and ADR-0023 (Release folder); ADR-0029's Results and a dated note under item 10 (lead decision (27d)); this runbook.
- **No workflow file**: every `actions/setup-node` step already reads `node-version-file: .nvmrc` (X-047's test checks it), so CI, the E2E runs and `deploy.yml`'s release build take 24 from the commit itself.

The lockfile's other package keys are the same before and after (step 1 of X-048): with the `(@types/node@…)` peer suffixes removed and the keys of `@types/node` and `undici-types` left out, the lockfile of the base commit and the new one list the same 1,284 keys (importers, packages and snapshots), and this prints nothing:

```bash
keys() { grep -E '^  [^ #].*:( \{\})?$' | sed -E 's/\(@types\/node@[^)]*\)//g' | grep -v -E "^  '?(@types/node|undici-types)@" | sort -u; }
diff <(git show f6a0a3c6:pnpm-lock.yaml | keys) <(keys < pnpm-lock.yaml)
```

With every version of the two packages replaced by one placeholder, the whole files differ only in the two `integrity` lines of `@types/node` and `undici-types`.

### 3.2 Its proof on Node 24

| | |
|---|---|
| Date | 2026-11-17 (UTC), 02:00 to 02:52 |
| Machine | The agents' cloud container: Ubuntu 24.04.5 LTS, kernel 6.18.44, 4 CPUs, 15 GiB of memory, root, no systemd as PID 1; X-048 ran alone in its wave, so no other agent's work shared it (load average 0.4 at the start, up to 16 during `pnpm test`) |
| Node | v24.22.3, the official `node-v24.22.3-linux-x64.tar.xz` of §2.2 put first on `PATH`, checked again with `sha256sum -c` against `SHASUMS256.txt` (`OK`); `https://nodejs.org/dist/latest-v24.x/` still listed v24.22.3 on 2026-11-17 |
| pnpm, Turborepo | pnpm 9.15.9 on v24.22.3 (`npm_config_user_agent`: `pnpm/9.15.9 npm/? node/v24.22.3 linux x64`); Turborepo 2.11.10, with `TURBO_FORCE=true` for lint, typecheck, test and test:int |
| Services | PostgreSQL 16, a private Redis 7.0.15 with a password of its own (CI uses 7.4), Mailpit 1.29.7, Chromium of `/opt/pw-browsers` with Playwright 1.65.0 |

| Command | Result | Duration |
|---|---|---|
| `pnpm install --frozen-lockfile` (the base commit's lockfile) | Passed, with the expected ` WARN  Unsupported engine` of the old `engines.node` | 26 s |
| The bump of §3.1, then `pnpm install` | The lockfile of §3.1; no ` WARN  Unsupported engine` any more | 5 s |
| `pnpm build` | Passed: 19 tasks, none cached (the new `.nvmrc` changed every hash) | 113 s |
| `pnpm format:check` | Passed | 47 s |
| `pnpm lint` | Passed: 29 tasks, none cached | 86 s |
| `pnpm typecheck` | Passed: 19 `tsc` runs with `@types/node` 24.19.2 (28 tasks), none cached | 53 s |
| `pnpm test` | Passed: 29 tasks, 9,174 tests in 17 packages, the `[X-048 AC3]` case among them | 189 s |
| `pnpm --filter @velexis/platform-backend exec vitest run src/domains/hostname-rules.test.ts`, on v24.22.3 and on v22.23.4 (`/opt/node22`) | 80 of 80 on 24; on 22 the `[X-048 AC3]` case fails (79 of 80), as the plan expects, so the case lands with the switch | 1 s each |
| `node --test tools/ci/*.test.mjs tools/perf/*.test.mjs` (the Verify's first part; X-047's `node-major.test.mjs` with `.nvmrc` 24 among them) | Passed: 113 tests | 6 s |
| `node tools/plan-lint/plan-lint.mjs` | Passed: `ERRORS: 0`, 352 tasks, 1,606 h | < 1 s |
| `pnpm test:int` (under the machine's end-to-end lock), then the PAN-absence proof of ci.yml's integration job | Passed: all 17 tasks; `packages/db` 78, `tools/reference-data` 7, `packages/testing` 31, `platform/backend` 1,256 and `ota/backend` 1,516 tests (`tenant-0002.int.test.ts` among them, 4.7 s for its 11 tests); the proof: every place scanned, nothing found | 954 s |
| `pnpm --filter @velexis/platform-backend test:xb`, `pnpm --filter @velexis/ota-backend test:xb` | Passed: 14 and 9 tests | 26 s, 15 s |
| `bash deploy/scripts/test/deploy.test.sh` | Passed: 133 checks, 51 runs of `deploy.sh` | 82 s |
| `bash deploy/scripts/test/healthcheck.test.sh` | Passed: 62 checks | 48 s |
| `bash deploy/scripts/test/log-review.test.sh` | Passed: 161 checks | 11 s |
| `bash deploy/scripts/test/ship-logs.test.sh` | Passed: 80 checks | 4 s |
| `bash deploy/scripts/test/backup-restore.test.sh` | Passed: 72 checks, 30 runs of `backup.sh` and `restore.sh` | 20 s |
| `SMOKE_TMPDIR=/tmp CADDY=<the Velexis Caddy> bash deploy/caddy/test/caddy-smoke.sh` (after `test:int`) | Passed: 792 checks | 19 s |
| `env PATH="$PATH" bash deploy/scripts/test/check-vm.test.sh` as root (the Verify's `sudo env PATH="$PATH" …`), under the machine's lock for tests that create system users, with the real `sshd -t`/`sshd -T` through `CHECKVM_SSHD` and the real `nft` in a private network namespace | Passed: 419 checks, among them `PASS Node.js v24.22.3` and X-047's cases for `NODE_MAJOR` unset and 24, another major (26) and the step `node` moving a VM up and back | 47 s |
| `shellcheck -S style` (0.9.0 and 0.11.0) on `deploy/scripts`, `deploy/scripts/test`, `deploy/systemd/test` and `deploy/caddy/test`; `actionlint` | Clean | < 10 s |
| `pnpm test:e2e -- --project=portal --project=platform-admin --project=storefront --project=ota-admin` (`E2E_WITH_OTA=1`, the built apps started on Node 24, `E2E_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`, under the end-to-end lock) | Passed: 387 tests in 13.4 min (`portal` 87, `platform-admin` 91, `storefront` 163 with the guards' test that must fail, which did, `ota-admin` 46); no process warning in any of the 15 stack logs | 809 s |
| `E2E_STRIPE=1 pnpm test:e2e -- --project=storefront-stripe --project=portal-stripe --list` | Listed: 16 `storefront-stripe` and 4 `portal-stripe` tests in 3 files; they need the Stripe test secrets, so the nightly run is their proof (§3.3) | 3 s |
| `pnpm --filter @velexis/ota-sdk test:smoke`, as e2e.yml's step runs it (the Amadeus stub, both `dev:seed` commands and the built OTA API started on Node 24, with a scratch database, never the shared one) | Passed: 24 tests in 2 files; both seeds wrote nothing on stderr, and no log held a Node warning | 12 s |

The release dry run of §2.3 (`pack-release.sh`) was not repeated: its only Node-dependent field, `RELEASE.json`'s `node`, is `process.version` of the build, which §2.3 showed records `v24.22.3`; CI's `deploy-files` job and the first Deploy run (§5 step 4) cover it.

### 3.3 What CI and the E2E run on the integration branch must show

The integrator's ([ADR-0028](../adr/0028-how-work-reaches-main.md); agents never dispatch `deploy.yml`): once the commit is on the integration branch, a CI run and an E2E run dispatched on it are green, and

- every `actions/setup-node` step logs a `v24.` version;
- the Turborepo runs of that first CI run show no cache hit (`.nvmrc` is a global dependency, and `engines.node` a global input, so every task hash changes once; X-047 counted 85 of 85);
- the `systemd-units` job's heap check of X-050 passes under systemd on Node 24, for the seven units: 688 MiB (platform API), 736 MiB (OTA API), 403 MiB (each worker) and 387 MiB (each Next.js server), each with its `MemoryMax` as constrained memory;
- E2E runs the four projects and the SDK's smoke tests.

Otherwise the integrator reverts the commit on the integration branch (§6.1) and dispatches CI again. ADR-0029's Results record the run ids.

**Result (2026-11-17, wave 58's integrator).** CI run [44016005952](https://github.com/bhagwati-prasad/velexis-ota/actions/runs/44016005952) and E2E run [44016009706](https://github.com/bhagwati-prasad/velexis-ota/actions/runs/44016009706), dispatched on the squash commit `68c0412`, were green: every `actions/setup-node` step logged `node: v24.22.2` (the runner image's cached 24.x); no Turborepo cache hit came from the restored Node 22 cache (Lint 0 of 29 cached, each integration job 0 of 17, and the 12 hits of `build-test`'s later steps are tasks its own Lint step had just run); the `systemd-units` job's heap check passed at 688, 736, 403, 403, 387, 387 and 387 MiB with each unit's `MemoryMax` as constrained memory; E2E passed 387 tests in the four projects and the SDK's 24 smoke tests. Job times: `build-test` 11.9 min, `integration` 12.3 min, `alt-hosts` 16.9 min, E2E 15.6 min. The nightly E2E run on the default branch then proves the `storefront-stripe` and `portal-stripe` projects, which need the Stripe test secrets (§2.8).

## 4. The developer's machine

Once the switch is on the branch you work on (the integration branch, or `main` once its wave reached it), in the repository root:

```bash
nvm install                 # reads .nvmrc (24): the newest Node.js 24
nvm alias default 24        # new terminals start on 24
corepack enable             # Node 24's corepack (0.36.0) runs the pnpm of package.json's packageManager
node --version              # v24.<minor>.<patch>
pnpm --version              # 9.15.9
pnpm install                # nothing is rebuilt
pnpm build && pnpm test
```

- Nothing to rebuild or delete: `pnpm.onlyBuiltDependencies` is empty and every native addon is an N-API prebuild (§2.6), so the same `node_modules` serves both majors.
- On the wrong major, `pnpm install` warns ` WARN  Unsupported engine: wanted: {"node":">=24 <25"}`: run `nvm use` in the repository root.
- Turborepo misses every cached task once, because `.nvmrc` is one of its global dependencies ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 4); later runs replay as before.
- pnpm 9 prints one `[DEP0169] DeprecationWarning: url.parse()` line when it builds a registry resolver (`pnpm outdated`, `pnpm dlx`) from outside a `node_modules` folder, as corepack's shim does (§2.4). It is pnpm's own and harmless.
- After a revert of the switch (§6.1): `nvm use` in the repository root reads `.nvmrc` 22 again (`nvm install` first if Node 22 is gone, `nvm alias default 22`); nothing else changes.

## 5. The VM

The throwaway-VM steps of X-020 and X-021 run this checklist after the switch, on Node.js 24 (the dated notes of X-020, X-021, X-023, X-024, X-030, X-037, X-038, X-039 and X-041; [ADR-0029](../adr/0029-nodejs-24-runtime.md) items 3, 6, 8 and 10). It adds about 1.5 to 3 hours to the rehearsal. `<deploy>` is the deploy folder the steps run from: the repository's `deploy/` before the first release, `/srv/velexis/current/deploy` after it. Record each result, with no secret, in the rehearsal's notes; a `FAIL` or a missing line stops the rehearsal for a report.

1. **NodeSource's package.** Provision as [`deployment-single-vm.md`](../deployment-single-vm.md) §3 says, with the default `NODE_MAJOR` (24). Then:
   - `apt-cache policy nodejs`: the installed version and the candidate are a `24.*` from `https://deb.nodesource.com/node_24.x nodistro/main`, and the pin shows priority 1001;
   - the step `node` completed: `sudo cat /var/lib/velexis/provision/steps/node` holds its time, and `/var/log/velexis/provision.log` has no `ERROR` line for it;
   - `node --version` prints `v24.*`, `corepack --version` a version (0.36.0 or later), and `/usr/bin/pnpm --version` prints `9.15.9`. pnpm 9 on Node 24 prints one `[DEP0169]` line when it builds a registry resolver from outside a `node_modules` folder (§2.4): expected. `--version` printed none with corepack 0.36.0 on v24.22.3 here (2026-11-17), so any other warning is a finding.
2. **check-vm.sh, on both runs of the rehearsal** (X-020 provisions twice): `sudo bash <deploy>/scripts/check-vm.sh` prints only `PASS` lines, among them `PASS Node.js v24.<minor>.<patch>`, `PASS nodejs is pinned to Node.js 24 (/etc/apt/preferences.d/velexis-nodejs: Pin: version 24.*, Pin-Priority: 1001)` and `PASS apt takes nodejs from NodeSource's node_24.x (/etc/apt/sources.list.d/nodesource.list)`.
3. **The units under systemd** (a throwaway VM only, never the production VM): `sudo env SMOKE_NODE=/usr/bin/node bash <deploy>/systemd/test/units-smoke.sh` passes, step 5's heap check of X-050 included (each unit's V8 heap limit is old + 3 × semi of its flags, and its constrained memory is its `MemoryMax`).
4. **A deploy and a rollback.** A Deploy run of the switch's commit (or a later one) passes `velexis-deploy`'s Node-major check: the release's `RELEASE.json` names `node` `v24.*` and the VM runs `v24.*` (a mismatch stops with `release built with Node v<n>, VM runs v<m>`). After a second deploy, `sudo /usr/local/sbin/velexis-deploy --rollback` switches back and every unit becomes healthy; deploy again afterwards.
5. **Memory.** After 200 requests to each public host (the portal, the platform admin, the platform API, the OTA admin, the OTA API and a storefront host; the sign-in pages are enough for the admins), each of the seven app units' peak memory is at least 64 MiB under its `MemoryMax`, the portal, the platform admin and the OTA admin included:

   ```bash
   for u in platform-api platform-worker ota-api ota-worker portal platform-admin ota-admin; do
     peak="$(systemctl show -p MemoryPeak --value "velexis-$u.service")"
     max="$(systemctl show -p MemoryMax --value "velexis-$u.service")"
     echo "velexis-$u: MemoryPeak $((peak / 1048576)) MiB, MemoryMax $((max / 1048576)) MiB, headroom $(((max - peak) / 1048576)) MiB"
   done
   ```

   A headroom under 64 MiB stops the rehearsal for a report to the lead (OBE-103 and PBE-076 measure the same units).
6. **Warnings.** `sudo journalctl -u 'velexis-*' | grep -E 'DEP0|DeprecationWarning'` is reviewed: the trial found none from the repository's code or its dependencies (§2.4), so each line is noted with its source and gets a task if it is ours.
7. **TLS from Node 24** ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 8). Node 24 uses OpenSSL's default security level 2 (RSA and DH keys of at least 2048 bits) and its own bundled root certificates, as the apps do. From the VM, as root (the env files are root's), save this script in a scratch folder and run `sudo node tls-check.mjs`: it completes a handshake with the SMTP relays of `SMTP_URL` (`platform-backend.env`, `ota-backend.env`) and `ALERT_SMTP_URL` (`alert.env`) as configured, and with the four API hosts of [`deploy/egress/allowed-hosts.conf`](../../../deploy/egress/allowed-hosts.conf); it prints no credential.

   ```js
   // tls-check.mjs: TLS handshakes from this Node.js to the peers of deploy/egress/allowed-hosts.conf (ADR-0029 item 8).
   // Usage: sudo node tls-check.mjs [host:port ...]   (without one: the SMTP relays of the env files and the four APIs)
   import { readFileSync } from "node:fs";
   import tls from "node:tls";

   /** host:port of the URL in `name` of an env file, or null when the file or the variable is missing. */
   function fromEnv(file, name) {
     let text;
     let url;
     try {
       text = readFileSync(file, "utf8");
     } catch {
       return null;
     }
     const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
     if (!line) return null;
     try {
       url = new URL(line.slice(name.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2"));
     } catch {
       throw new Error(`${name} of ${file} is not a URL`); // never the value: it holds the relay's password
     }
     return `${url.hostname}:${url.port || 465}`; // smtps:// (implicit TLS on 465), as the env templates require
   }

   const peers = process.argv.length > 2 ? process.argv.slice(2) : [
     ...new Set([
       fromEnv("/etc/velexis/platform-backend.env", "SMTP_URL"),
       fromEnv("/etc/velexis/ota-backend.env", "SMTP_URL"),
       fromEnv("/etc/velexis/alert.env", "ALERT_SMTP_URL"),
     ].filter(Boolean)),
     "api.stripe.com:443",
     "connect.stripe.com:443",
     "test.travel.api.amadeus.com:443",
     "travel.api.amadeus.com:443",
   ];

   console.log(`${process.version}, OpenSSL ${process.versions.openssl}`);
   let failed = 0;
   for (const peer of peers) {
     const [host, port] = peer.split(":");
     // One line per peer: the promise settles once, so an error or timeout after the handshake (an SMTP relay that
     // keeps the connection open after its banner) cannot add a FAIL line to a PASS.
     const result = await new Promise((done) => {
       const socket = tls.connect({ host, port: Number(port), servername: host, timeout: 10_000 }, () => {
         const cert = socket.getPeerCertificate();
         // An EC certificate has `bits` too (256 for P-256), so the curve decides, not `bits`.
         const key = cert.asn1Curve ? `EC ${cert.asn1Curve}` : `RSA ${cert.bits}`;
         done(`PASS ${peer}: ${socket.getProtocol()} ${socket.getCipher().name}, ${key}, issuer ${cert.issuer?.O ?? cert.issuer?.CN}`);
         socket.destroy();
       });
       socket.on("timeout", () => {
         done(`FAIL ${peer}: no answer within 10 s`);
         socket.destroy();
       });
       socket.on("error", (error) => done(`FAIL ${peer}: ${error.code ?? "error"}: ${error.message}`));
     });
     console.log(result);
     if (result.startsWith("FAIL")) failed += 1;
   }
   process.exitCode = failed === 0 ? 0 : 1;
   ```

   Every line must be `PASS`. A `FAIL` such as `EE certificate key too weak` (an RSA key under 2048 bits) or a certificate error (a root removed from Node 24's store) means a change of provider, or a dated `@SECLEVEL=1` note in ADR-0029 before anything is lowered. The script was checked on the agents' machine (2026-11-17, `NODE_EXTRA_CA_CERTS` naming throwaway certificates): v24.22.3 passed an EC P-256 server (`EC prime256v1`), an RSA-2048 server (`TLSv1.3 TLS_AES_256_GCM_SHA384, RSA 2048`) and one that sends an SMTP banner after the handshake and keeps the connection open (one `PASS` line, no late `FAIL`), and refused an RSA-1024 one (`EE certificate key too weak`), which v22.23.4 accepted; an env value that is not a URL stops the script with the variable's name, never its value. External peers cannot be judged there (the agents' proxy re-signs TLS), so this step is their proof.
8. **The `NODE_MAJOR` round trip** ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 6), on the throwaway VM after the steps above, with no deploy in between:

   ```bash
   sudo NODE_MAJOR=22 bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps node
   sudo NODE_MAJOR=22 bash /srv/velexis/current/deploy/scripts/check-vm.sh      # only PASS: Node.js v22.*, the pin 22.*, node_22.x
   sudo bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps node   # the default, 24
   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh                    # only PASS: Node.js v24.*, the pin 24.*, node_24.x
   sudo systemctl restart velexis-platform-worker velexis-ota-worker velexis-platform-api velexis-ota-api \
     velexis-portal velexis-platform-admin velexis-ota-admin                   # the order of a deploy: workers, APIs, front ends
   ```

   Each `provision-vm.sh` run writes NodeSource's line and the pin, runs `apt-get update` and installs `nodejs` with `--allow-downgrades`; a second run with the same `NODE_MAJOR` changes nothing. corepack finds pnpm 9.15.9 in root's cache from the first provisioning; if `corepack prepare` is refused a connection to `registry.npmjs.org`, open it for the run as [`outbound-allow-list.md`](outbound-allow-list.md) §4 says. The next daily AIDE check lists `nodejs`'s files (`/usr/bin/node`, `/usr/lib/node_modules/`, `/usr/include/node/`, `/usr/share/doc/nodejs/`): because both runs are in `/var/log/velexis/provision.log` (`provision-vm.sh started by …: steps node`), `velexis-logreview`'s daily summary counts them as expected (`after the <time> provision-vm.sh (expected)`) instead of raising `aide-change`; `/var/log/dpkg.log` names the two versions. Record which of the two the review showed, and explain an `aide-change` alert, if one comes, from those two logs.

## 6. Rollback

Until Node 22's end of life on 2027-04-30; after it, fix forward on 24. PBE-077, X-047 and X-050 stay in every case: they work on both majors.

### 6.1 In git

The switch is one commit: X-048's squash commit on the integration branch (`Task: X-048`), and the same change once its wave reached `main`. `git revert <that commit>` puts `.nvmrc` 22, `engines.node` `>=22 <23`, `@types/node` 22.20.5 with its lockfile entries, `NODE_MAJOR` 22, check-vm.sh's default and fixture, the demo page and the documents back; it also removes `hostname-rules.test.ts`'s `[X-048 AC3]` case (`١٢٣.com`), which fails on Node 22. On the integration branch the integrator reverts it and dispatches CI again; on `main` it goes through a branch and a pull request ([ADR-0028](../adr/0028-how-work-reaches-main.md)). CI then runs on 22 with no other change, and Turborepo finds its Node 22 entries again where they are still cached (`.nvmrc` is a global dependency). Check the revert on Node 22: `node --test tools/ci/node-major.test.mjs`, `grep -c '@types/node@24' pnpm-lock.yaml` (`0`) and `pnpm install --frozen-lockfile`.

### 6.2 Machines

- A developer's machine: `nvm use` in the repository root (§4).
- The agents' machine: the integrator puts `/opt/node22/bin` first on `PATH` again in `/etc/profile.d/nodejs.sh`; `/opt/node22` is never removed.

### 6.3 A provisioned VM

In this order, with `<deploy>` the running release's deploy folder (`/srv/velexis/current/deploy`):

1. `sudo NODE_MAJOR=22 bash <deploy>/scripts/provision-vm.sh --steps node`: the pin, the source line and `nodejs` move to 22 (X-047's priority 1001 and `--allow-downgrades`). corepack needs pnpm 9.15.9 in its cache; if it must download it, open `registry.npmjs.org` for the run as [`outbound-allow-list.md`](outbound-allow-list.md) §4 says.
2. `sudo NODE_MAJOR=22 bash <deploy>/scripts/check-vm.sh`: only `PASS`, with `Node.js v22.*`, the pin `22.*` and `node_22.x`.
3. Restart the seven app units (the command of §5 step 8): they run on Node 22 from then on.
4. Deploy the reverted commit. Its release is built on 22, so `velexis-deploy`'s major check passes; a release built on 24 is refused on this VM (`release built with Node v24, VM runs v22.<minor>.<patch>`). Until that deploy, give every run of `provision-vm.sh` and `check-vm.sh` `NODE_MAJOR=22` (the running release's scripts default to 24); after it, their default is 22 again.
5. Explain the AIDE review of the next daily check from `/var/log/velexis/provision.log` and `/var/log/dpkg.log` (§5 step 8).

`velexis-deploy --rollback` alone, to a release built on another major, is not checked and works, because every native module is N-API ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 10, decision D12; [ADR-0023](../adr/0023-release-artefact-and-deploy-user.md)). It changes the release, not Node.

### 6.4 Partial levers that keep Node 24

- **Lost request or tenant context** ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 10, lead decision (27d) of 2026-11-17). Node 24 runs AsyncLocalStorage (nestjs-cls) on AsyncContextFrame; `--no-async-context-frame` restores the previous implementation. The lever is a drop-in of the affected unit whose one quoted `NODE_OPTIONS` assignment repeats the unit's own two heap flags and adds the new one: systemd keeps the last assignment of a variable, so a drop-in with `NODE_OPTIONS=--no-async-context-frame` alone would drop the unit's heap flags ([`deployment-single-vm.md`](../deployment-single-vm.md) §14). For the platform API:

  ```bash
  sudo install -d -m 0755 /etc/systemd/system/velexis-platform-api.service.d
  printf '%s\n' '[Service]' \
    'Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16 --no-async-context-frame"' \
    | sudo tee /etc/systemd/system/velexis-platform-api.service.d/90-async-context-frame.conf >/dev/null
  sudo systemctl daemon-reload && sudo systemctl restart velexis-platform-api
  sudo cat "/proc/$(systemctl show -p MainPID --value velexis-platform-api)/environ" | tr '\0' '\n' | grep '^NODE_OPTIONS='
  ```

  The line for each unit, the unit's own `Environment=` line plus the flag:

  | Unit | Drop-in line |
  |---|---|
  | `velexis-platform-api` | `Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16 --no-async-context-frame"` |
  | `velexis-ota-api` | `Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=32 --no-async-context-frame"` |
  | `velexis-platform-worker`, `velexis-ota-worker` | `Environment="NODE_OPTIONS=--max-old-space-size=400 --max-semi-space-size=1 --no-async-context-frame"` |
  | `velexis-portal`, `velexis-platform-admin`, `velexis-ota-admin` | `Environment="NODE_OPTIONS=--max-old-space-size=384 --max-semi-space-size=1 --no-async-context-frame"` |

  Checked on the agents' machine (2026-11-17): on v24.22.3 these three flags give a heap limit of 688 MiB for the platform API's values and AsyncContextFrame off, while `--no-async-context-frame` alone gives Node's default heap (2,240 MiB outside a memory limit); X-050's [`tools/perf/unit-node-options.mjs`](../../../tools/perf/unit-node-options.mjs) reads the platform API's unit with the drop-in's line after it as the three flags, and with `NODE_OPTIONS=--no-async-context-frame` after it as that flag alone. `velexis-deploy` installs only the caddy drop-in, so a deploy keeps this one; the change is an incident with its record, and the auditd and AIDE watches on the systemd units show it. Remove the drop-in (`daemon-reload`, restart) once the cause is fixed.
- **A TLS peer refused at security level 2**: a change of provider, or a dated `@SECLEVEL=1` note in ADR-0029 before anything is lowered (item 8).
- **Garbage collection after the pinned young generations**: X-050's values change only with a measurement and a lead decision, on either major (item 5).
