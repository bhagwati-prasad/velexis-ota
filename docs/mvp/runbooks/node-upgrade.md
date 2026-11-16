# Moving Velexis to a new Node.js major

This runbook moves the whole repository, CI, the release build and the VM from one Node.js major to the next, as [ADR-0029](../adr/0029-nodejs-24-runtime.md) decided for Node.js 22 → 24. The move has two parts: a **trial** that runs everything on the new major without changing what pins the old one (§2, task X-046), and one **switch** commit that changes every pin at once (§3, task X-048), followed by the developer's machine (§4), the VM (§5) and, if needed, the way back (§6). Task X-046 in [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) wrote §1 and §2; X-048 fills §3 to §6.

Related: [ADR-0029](../adr/0029-nodejs-24-runtime.md) (the decision, items 1 to 11, and the approved decisions D1–D18); [ADR-0002](../adr/0002-monorepo-pnpm-turborepo.md) item 1; [`tech-stack.md`](../tech-stack.md) §1; [`local-development.md`](../local-development.md) §1 and §2; [`deployment-single-vm.md`](../deployment-single-vm.md) §2, §3 and §12; [`tools/e2e/README.md`](../../../tools/e2e/README.md) (running the journeys); [`ota/sdk/README.md`](../../../ota/sdk/README.md) §8.1 (the SDK's smoke tests).

## 1. What decides the Node version

Only the **major** is compared anywhere; the patch versions of CI, the release build, the VM and a developer's machine may differ. [ADR-0029](../adr/0029-nodejs-24-runtime.md) item 2 names `.nvmrc` the source and lists the places that must name the same major. Until X-048 they all say 22:

| Place | Today | What reads it |
|---|---|---|
| `.nvmrc` | `22` | `nvm install` and `nvm use` in the repository root ([`local-development.md`](../local-development.md) §2); every `actions/setup-node` step of `.github/workflows/ci.yml`, `e2e.yml` and `deploy.yml` (`node-version-file: .nvmrc`), which takes the runner image's cached newest 22.x, so the release build of `deploy.yml` too. |
| Root `package.json`, `engines.node` | `>=22 <23` | pnpm, which only warns (`WARN  Unsupported engine`, no `engine-strict`) when the running Node is outside the range. |
| `deploy/scripts/provision-vm.sh`, `NODE_MAJOR` default | `22` | Step `packages` writes NodeSource's source line `node_${NODE_MAJOR}.x`; step `node` installs `nodejs`, refuses another major and enables pnpm through corepack. |
| `deploy/scripts/check-vm.sh`, its Node item, and the fixture of `deploy/scripts/test/check-vm.test.sh` | `v22.*`; the fixture `v22.12.0` and `node_22.x` | The VM check after provisioning ([`deployment-single-vm.md`](../deployment-single-vm.md) §3). |
| `@types/node` in the 15 `package.json` files that declare it, and in `pnpm-lock.yaml` | `22.20.5` | `pnpm typecheck`; `.github/dependabot.yml` ignores its major updates ("Node.js 22"). |
| `deploy/demo-deployment.html` | `ensure_node22` (Part B1) | The owner's demo guide. |
| The release | `RELEASE.json` `node` = `process.version` of the build ([`pack-release.sh`](../../../deploy/scripts/pack-release.sh)) | `velexis-deploy` refuses a release whose build major differs from the VM's `node` on its first activation ([`deploy.sh`](../../../deploy/scripts/deploy.sh) step 1); `--rollback` does not check ([ADR-0029](../adr/0029-nodejs-24-runtime.md) item 10, D12). |
| The agents' machine | `/etc/profile.d/nodejs.sh` puts `/opt/node22/bin` (v22.23.4) first on `PATH` | pnpm (`/opt/node-tools`, 10.28.0, which runs the `packageManager` pnpm 9.15.9) and every script run with `#!/usr/bin/env node` take the first `node` on `PATH`. `/opt/node24` holds v24.22.1, older than the security release v24.22.3, so the trial does not use it. |

Nothing else pins the major. No native addon is rebuilt on install (`pnpm.onlyBuiltDependencies` is empty), and every addon the build and the tests load is N-API (§2.6), so one `node_modules` serves both majors. X-047 adds the guards of ADR-0029 items 2, 4 and 6 (`tools/ci/node-major.test.mjs`, `.nvmrc` as a Turborepo global dependency, `NODE_MAJOR` both ways), and X-048 adds them to this table when it switches.

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

X-048 commits the bump.

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

### 2.8 What only CI and the VM can prove

The agents' machine has no systemd as PID 1, no Stripe test secrets, no second host name for PostgreSQL and Redis, and no NodeSource package. These parts of the move are proven elsewhere:

- **CI on X-048's commit** (`actions/setup-node` then reads `.nvmrc` `24`): every job's setup step logs a v24.x; Turborepo's first run shows no cache hit (the commit changes `engines.node`, a global input, §2.3, and X-047 makes `.nvmrc` a global dependency, ADR-0029 item 4);
  - `systemd-units`: steps 4 to 11 of `units-smoke.sh` with the real units under systemd, on Node 24, including X-050's check that V8's heap limit is old + 3 × semi of each unit's flags;
  - `deploy-files`: the Velexis Caddy build, `caddy validate`, `systemd-analyze verify` and the units' sandboxing (the deploy tests and `caddy-smoke.sh` of that job also ran here, §2.3);
  - `dev-setup`: `corepack enable` with Node 24's corepack, then `dev-setup.sh` twice on a fresh runner (here pnpm came from the machine's pnpm 10.28.0; corepack 0.36.0 ran pnpm 9.15.9 in §2.4's check);
  - `alt-hosts`: the integration tests with PostgreSQL over TLS only (`sslmode=verify-full`) and Redis on other host names and ports. Its throwaway CA and server key are RSA-2048, which OpenSSL's security level 2 accepts: a Node 24 TLS client verified such a chain here (TLSv1.3), as Node 22 did;
  - `build-test` and `integration` as a whole, on a runner instead of a shared machine (§2.7's timeouts).
- **The E2E run on X-048's commit and the next nightly run** on the default branch: the four projects and the SDK's smoke tests on the runner, and the `storefront-stripe` and `portal-stripe` projects, which need the Stripe test secrets (§2.3 only lists them).
- **The throwaway VM** (§5, X-048; ADR-0029 items 6 and 8): NodeSource's `node_24.x` package for Ubuntu Noble and its corepack (D11), the TLS handshakes from Node 24 to the configured SMTP relays, `api.stripe.com`, `connect.stripe.com`, `test.travel.api.amadeus.com` and `travel.api.amadeus.com` (D13; the agents' proxy re-signs TLS, so no external peer can be judged here), each app unit's peak memory against its `MemoryMax`, the `NODE_MAJOR` round trip with `check-vm.sh`, and the AIDE alert a Node package raises.

## 3. The switch

Written by X-048.

## 4. The developer's machine

Written by X-048.

## 5. The VM

Written by X-048.

## 6. Rollback

Written by X-048.
