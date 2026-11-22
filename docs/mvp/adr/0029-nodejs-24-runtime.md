# ADR-0029: Node.js 24 LTS as the runtime of Velexis

**Status:** Accepted
**Date:** 2026-11-16
**Deciders:** Product owner (Node.js 24, the request of 2026-11-15; on 2026-11-16 the owner approved the plan's decisions D1–D18 as recommended, with "yes to all", recorded as lead decision (25n) by FIX-W56-PLAN), lead architect (how the move is made and proven: the upgrade plan of 2026-11-16, its decisions D1–D18 and its nine tasks)
**Revisions:** 2026-11-16 (lead decision (26d) of 2026-11-16, approved by the owner; FIX-W57-DOCS): the upgrade plan's five open questions are settled ([below](#open-questions-settled-on-2026-11-16)), and items 3, 5 and 9 say what holds now: the lead checks the personal cloud environment's network before proposing it, OBE-103 and PBE-076 measure Node 22 on the installed 22.23.4 and name the exact versions, X-050 AC2 proves the cgroup v2 path in CI, and the SDK's floor stays 22.12 with the `require(esm)` `ExperimentalWarning` before 22.13 documented. 2026-11-17 (X-048): the Results below, and a dated note under item 10 on the context-loss lever's drop-in (lead decision (27d) of 2026-11-17, approved by the owner); the same day wave 58's integrator recorded the CI and E2E runs of the switch in the Results. 2026-11-18 (lead decisions (29a), (29b) and (29d) of 2026-11-18, approved by the owner; FIX-W60-SHARED): the Results record the lead's reading of the open points of OBE-103 and PBE-076 and close them: the p95 threshold is judged on each runtime's mean over at least two quiet runs, the 5 % bound on garbage collection is main-thread pause time over elapsed time, and OBE-103's runs are accepted as recorded. 2026-11-19 (wave 60's integrator): the Results record OBE-104's three-hour run on Node 24 (lead decision (29c) of 2026-11-18): by its rule neither the OTA API's nor the worker's memory settles, the heap snapshots show no growing object but V8's compiled code, and the follow-up is the lead's. 2026-11-19 (lead decisions (30a) to (30d) of 2026-11-19, approved by the owner; FIX-W61-MEMORY): the Results record the lead's decisions on OBE-104: the memory is accepted as measured, the throwaway VM's checks gain a run of 8 to 24 hours of the OTA worker and API (runbook §5 step 9), a later memory re-check judges the JS heap by its floor after the collections, and the offers every checkout keeps get a bound in OBE-105; "Still to come" names that run instead of the lead's choice. 2026-11-19 (lead decision (31a) of 2026-11-19, approved by the owner; FIX-W62-DOCS): the Results record the OTA API's verdict by the heap-floor rule as inconclusive by measurement noise. 2026-11-22 (lead decision (38e) of 2026-11-22, approved by the owner; FIX-W69-DOCS): a dated note under item 10 and row D12 record that D12 was reviewed against known issue KI-041 and stands: `--rollback` and the automatic rollback across Node majors are not refused, only noted in `deploy.log`, because every native module is N-API and the automatic rollback right after a Node-major switch must keep working; since FIX-W68-DEPLOYSCRIPT a rollback checks its target's env templates.

## Context

[ADR-0002](0002-monorepo-pnpm-turborepo.md) item 1 and [ADR-0007](0007-single-vm-without-docker.md) fixed **Node.js 22 LTS**. [`tech-stack.md`](../tech-stack.md) §1 planned the move to Node 24 "after the MVP". [`decisions.md`](../decisions.md) names Node.js without a major.

- **Node 22 ("Jod")** has been in maintenance since 2025-10-21 and reaches end of life on **2027-04-30** (nodejs/Release `schedule.json`). That is before M6 "Hardening & launch" of the agent calendar (10 May – 11 Jun 2027 since the re-baseline of 2026-11-16, 10 May – 4 Jun 2027 before it; [roadmap](../plans/roadmap.md) §1.2). A launch on 22 would leave production without security fixes within weeks.
- **Node 24 ("Krypton")** was Active LTS from 2025-10-28, has been in maintenance since 2026-10-20 (security and critical fixes only), and reaches end of life on **2028-04-30**. v24.22.3 (2026-11-10, a security release) ships V8 13.6, `NODE_MODULE_VERSION` 137, OpenSSL 3.5.9, ada 4.0.0, undici 7.30.2, npm 11.19.1 and corepack 0.36.0.
- **Node 26 ("Lithium")** has been Active LTS since 2026-10-28 and reaches end of life on 2029-04-30. It ships no corepack (CHANGELOG_V25, 25.0.0: "build: stop distributing Corepack").
- **The VM is not provisioned yet** (X-020's human steps 3 and 4 are pending). The first production VM can therefore start on the new major, and there is no live switch.

A study on 2026-11-15 covered six dimensions. A second agent verified each one, and a critic reviewed the plan. They found:

- **Dependencies.** All 93 exact-pinned external packages accept Node 24. Every `engines.node` range in the lockfile accepts 24.22.3, except the Windows-only `@img/sharp-win32-ia32`, which is never installed.
  - Every native addon is N-API and loads on 24 from a Node 22 install: argon2, sharp, msgpackr-extract, `@next/swc`, rollup, lightningcss, `@tailwindcss/oxide` and `@napi-rs/lzma`.
  - Only `@types/node` changes: 22.20.5 → 24.19.2, which declares TypeScript 5.6. It brings `undici-types` 6.21.0 → 7.24.x.
  - The repository's code typechecks against it in all 19 `tsc` runs of `pnpm typecheck`.
- **One code break.**
  - ada 4.0.0 in Node 24 makes `url.domainToASCII` return an invalid punycode label unchanged, where Node 22 returned `""`. `new URL()` accepts such a host, where Node 22 threw.
  - The platform's custom-domain rules and API-key origin rules then accept `xn--zz.example.com` and `https://xn--zz.example`, and `hostname-rules.test.ts` fails on 24.
  - ada 4 is also stricter elsewhere. `١٢٣.com` (Arabic-Indic digits), which Node 22 stored as `xn--9hbcd.com`, is refused.
- **TLS.**
  - Node 22 pinned OpenSSL's security level at 1 (22.20.0, "deps: fix OpenSSL security level at 1"). Node 24 uses OpenSSL's default, level 2.
  - Level 2 refuses RSA keys under 2048 bits (`ERR_SSL_EE_KEY_TOO_SMALL` for an RSA-1024 server key on 24.22.3, accepted on 22.23.4) and DH parameters under 2048 bits.
  - Node's built-in root store grows from 116 to 118 certificates. Added: SECOM TLS RSA and ECC Root CA 2024, and Telia RSA and EC TLS Root CA v3. Removed: Chunghwa Telecom's ePKI Root Certification Authority and Atos TrustedRoot 2011.
  - All key material the repository generates passes. External peers were not checked: the agents' proxy re-signs TLS.
- **Young generation.** Node sizes V8's semi-space from the memory limit it sees: on the VM, each unit's `MemoryMax`; in a load test, the whole machine.
  - Under the units' limits, Node 24 changes only the platform API's semi-space, from 4 to 16 MiB (heap limit 652 → 688 MiB, still under 768M). The 512M units get 1 MiB on both majors.
  - Outside a limit, Node 24 uses 64 MiB semi-spaces (heap limits 832, 592 and 576 MiB, against Node 22's 688, 448 and 432), so load tests would overstate what the VM uses.
  - With both `--max-old-space-size` and `--max-semi-space-size` set, V8's heap limit is old + 3 × semi on 22.23.4, 24.22.3 and 26.13.1 alike: 688, 736, 403 and 387 MiB for the seven units.
- **Build cache.** Turborepo hashes no runtime version, and CI restores its cache by prefix. Node 22 results could therefore replay under 24.
- **Copies of the major.** The Node major is written in many places: `.nvmrc`, `engines`, `NODE_MAJOR`, `check-vm.sh`'s literal `v22.*`, its test fixture, the demo page and every `@types/node`.
  - `velexis-deploy` refuses a release whose build major differs from the VM's, but only at deploy time.
  - A provisioned VM cannot go back to an older major today: apt does not downgrade without a pin of priority 1001 and `--allow-downgrades`.
- **No effect.** Changes checked and found harmless:
  - AsyncLocalStorage on AsyncContextFrame (nestjs-cls 5.4.3, Express 5.3.0)
  - fetch on undici 7 (error shapes)
  - HTTP, net and TLS protocol defaults
  - the APIs removed in 23 and 24
  - `node --test` (only the reporter changes, to spec)
  - ICU 78.3 and tz 2026e (identical)
  - gzip output
  - `require(esm)`
- **Node 26 needs more:**
  - Vitest 5 (with Vitest 4.1.12, `localStorage` is undefined in happy-dom tests)
  - a corepack replacement
  - verified NodeSource packages for Ubuntu 24.04 (the support table stops at 24.x)
  - Tailwind 4.3 (DEP0205 warnings)

## Decision

1. **Runtime.** Node.js 24 LTS everywhere Velexis is built, tested or run.
   - `.nvmrc` holds `24` (major only), and the root `engines.node` is `>=24 <25`.
   - `@types/node` is one exact 24.x whose `typeScriptVersion` is 5.6 or lower (24.19.2 at the switch).
   - CI and the release build take the `.nvmrc` major through `actions/setup-node`, which uses the runner image's cached 24.x.
   - The VM takes NodeSource's newest `node_24.x` (`NODE_MAJOR=24`).
   - Developers use `nvm install` in the repository root.
   - The agents' machine puts a Node 24 build first on `PATH` from the switch on.
   - The patch versions of these can differ; only the major is compared.
   - pnpm stays 9.15.9, through the corepack 0.36.0 that Node 24 bundles. No other dependency changes.
2. **One major, kept in step.** `.nvmrc` is the source. `tools/ci/node-major.test.mjs` (X-047) fails CI when any of these names another major:
   - `engines.node`
   - `provision-vm.sh`'s `NODE_MAJOR` default
   - `check-vm.sh`'s Node item and its test fixture
   - any `@types/node` in a `package.json` or in `pnpm-lock.yaml`
   - the demo page

   It also fails when a workflow's `actions/setup-node` step stops reading `.nvmrc`. The only exemption is by name: SDK-019's `sdk-node22`.
3. **Order.** Each step starts once the one before it has merged:
   - in one wave, side by side: the punycode fix (PBE-077), a trial of the whole repository on Node 24 that changes no code (X-046), the guards of items 2, 4 and 6 (X-047), and the pinned young generation of item 5 (X-050). Each works on 22 and 24;
   - alone in the next wave: one squash-merged switch (X-048);
   - then re-measurement on both majors (OBE-103, PBE-076) and wording (SDK-019, X-049).

   There is no CI matrix of both majors. The switch's CI and E2E runs on the integration branch are the A/B run against the commit before it.

   The agents' machine changes to Node 24 between the switch's wave and the next one, and no wave spans the switch. The plan runs the first wave as wave 57 (PBE-077, X-046, X-047, X-050), the switch alone as wave 58 (X-048) and the rest as wave 59 (X-049, SDK-019, OBE-103, PBE-076). After X-048 the integrator puts a verified newest Node 24 first on the agents' machine's `PATH` and keeps `/opt/node22` for the measurements of OBE-103 and PBE-076; for future sessions, a personal cloud environment for the repository, whose setup script does the same, is proposed to the owner (D17). Since 2026-11-16 ((26d), [below](#open-questions-settled-on-2026-11-16)): the lead checks that environment's network before proposing it, and OBE-103 and PBE-076 measure Node 22 on the installed `/opt/node22` (v22.23.4, not updated first) and name the exact versions of both runtimes.

   Every task with a pending step on a VM carries a dated note: that step runs after X-048, on Node 24, with the runbook's VM checklist. The tasks are X-020, X-021, X-023, X-024, X-030, X-037, X-038, X-039 and X-041. The note is not a dependency, so plan-lint's remaining critical path stays at 32 agent-hours (X-021 → X-020 → X-023 → X-024 → X-030 → X-038), while the effective path to the first VM rehearsal is about 48 h: X-046, X-047 or X-050 (8 h), X-048 (8 h), then that chain (D2).
4. **Build cache.** `.nvmrc` is a Turborepo global dependency. A change of the major misses every cached task, and a revert finds the old entries again. Patch updates within 24.x replay, as they did within 22.x.
5. **Young generation, explicit.** Every app unit sets `--max-semi-space-size` beside `--max-old-space-size`, in one quoted `Environment="NODE_OPTIONS=…"` assignment. Unquoted, systemd drops the second flag. The value is what Node 24 picks under the unit's `MemoryMax`:
   - platform API: 16
   - the two workers and the three Next.js servers: 1
   - OTA API: 32, kept (lead decision (11h))

   On Node 22 this changes two things: the platform API under its limit goes from 4 to 16 MiB, and, outside a limit, the workers and Next.js servers go from 16 to 1 MiB. No VM ran 22.

   The load scripts read each unit's `NODE_OPTIONS` instead of copying them. Inside each real unit under systemd, the units smoke test asserts that V8's heap limit equals old + 3 × semi of that unit's flags, and that Node's constrained memory equals `MemoryMax`. That run, CI's `systemd-units` job (X-050 AC2), is also the proof of the cgroup v2 path inside real units, which the study could not check (2026-11-16, (26d)). A value changes only with a measurement and a lead decision.
6. **`NODE_MAJOR` moves both ways.** Step `node`:
   - writes the NodeSource line for `node_${NODE_MAJOR}.x`
   - pins `nodejs` to `${NODE_MAJOR}.*` at priority 1001
   - installs with `--allow-downgrades`

   So `NODE_MAJOR=<n> provision-vm.sh --steps node` changes the major either way, without the full upgrade of step `packages`. `check-vm.sh` checks the Node version, the pin and the source line against the `NODE_MAJOR` it is given.
7. **Host names do not depend on Node's URL parser accepting invalid punycode.**
   - The platform's custom-domain rules and API-key origin rules refuse every `xn--` label that does not decode and encode back to itself.
   - The OTA backend's CORS check and the OTA admin's URL fields stay as they are: no invalid origin can be stored.
   - ada 4's stricter refusals are accepted.
8. **TLS security level 2 and Node 24's root store are accepted.**
   - Before production, Node 24 on the throwaway VM completes a TLS handshake with the configured SMTP relays, `api.stripe.com`, `connect.stripe.com`, `test.travel.api.amadeus.com` and `travel.api.amadeus.com`.
   - A peer that fails means a change of provider. Lowering the level (`@SECLEVEL=1`) needs a dated note in this ADR.
   - The root-store change affects only peers chained to the two removed roots. The custom-domain TLS probe judges certificates from Caddy's ACME issuers, which are not among them.
9. **The SDK.** The SDK supports Node.js 22.12 and later and 24, evergreen browsers and edge runtimes, and says so in its `engines` field.
   - The floor stays 22.12, not 22.13 (2026-11-16, (26d)): `require()` of the SDK's ES module build is on by default from 22.12.0, and 22.12.x still prints an `ExperimentalWarning` when the requiring file is outside `node_modules`, which 22.13.0 drops. SDK-019 documents that warning where it states the range.
   - A non-required CI job, `sdk-node22`, runs its tests on Node 22.12.0 until Node 22's end of life on 2027-04-30. The owner approved its exact lines on 2026-11-16 (D5, [below](#approved-workflow-lines-d5)); SDK-019 adds them. Without that approval the SDK would have supported Node.js 24 and later.
10. **Operations and rollback.**
    - **Patches.** NodeSource is not an origin of unattended-upgrades. The weekly `apt list --upgradable` review installs Node patches (`apt-get install --only-upgrade nodejs`) and restarts the app units. The files a patch replaces raise one `aide-change` alert at the next daily check. `/var/log/dpkg.log` explains it, and it is handled as [`deployment-single-vm.md`](../deployment-single-vm.md) §12 says for package updates.
    - **Rollback in git** is a revert of the switch commit. The trial's fixes and the guards work on both majors.
    - **Rollback on a provisioned VM**, until Node 22's end of life on 2027-04-30:
      1. `NODE_MAJOR=22` through item 6;
      2. `check-vm.sh` with the same `NODE_MAJOR`;
      3. a restart of the app units;
      4. a deploy of the reverted commit.
    - **`velexis-deploy --rollback`** to a release built on another major is not checked. It works because every native module is N-API.
      - *Note (2026-11-22, lead decision (38e), approved by the owner; FIX-W69-DOCS):* decision D12 was reviewed against known issue KI-041 ("Rollback does not refuse a target built on another Node major") on 2026-11-22 and stands. `velexis-deploy --rollback` and the automatic rollback of a deploy whose units fail their health checks are not refused when their target was built on another Node major: `rollback_to` in [`deploy.sh`](../../../deploy/scripts/deploy.sh) only writes a note naming both majors to `deploy.log`, and a release already on the VM is not checked for its major again when it is activated again (`check_node_major` runs on a release's first activation only). Every native module is N-API, so the target runs on the VM's major, and the automatic rollback right after a Node-major switch (a release built on the new major that fails its health checks, rolled back to the release before it, built on the old one) must keep working: refusing it would leave the unhealthy release current. Since FIX-W68-DEPLOYSCRIPT a rollback does check its target's env files against the target's env templates (every variable present in `/etc/velexis`, none still at `CHANGE_ME`) and refuses a target that fails before anything is staged or switched, naming each `file:VARIABLE` (the env half of KI-041; [`deployment-single-vm.md`](../deployment-single-vm.md) §8). The guidebook retires KI-041 as decided behaviour, and `deploy.test.sh` keeps its D12 check (case 20).
    - **Context-loss lever.** If request or tenant context is lost, `NODE_OPTIONS=--no-async-context-frame` in a unit drop-in restores the previous AsyncLocalStorage.
      - *Note (2026-11-17, lead decision (27d) of 2026-11-17, approved by the owner; X-048):* the drop-in's one quoted `NODE_OPTIONS` assignment repeats the unit's own two heap flags (item 5) and adds `--no-async-context-frame`, for example `Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16 --no-async-context-frame"` for the platform API, because systemd keeps the last assignment of a variable: a drop-in with `--no-async-context-frame` alone would drop the unit's heap flags. On v24.22.3 the three flags gave a heap limit of 688 MiB with AsyncContextFrame off, and the flag alone Node's default heap. [`node-upgrade.md`](../runbooks/node-upgrade.md) §6.4 has each unit's line and the commands.
11. **The next major.** Node 26 is not adopted now. Move to it once these are in place:
    - Vitest 5
    - a corepack replacement
    - NodeSource packages for Noble
    - Tailwind 4.3
    - a pnpm that supports Node 26

    Move by 2028-04-30 at the latest, and before the launch if the calendar without agents becomes the plan.

## Decisions approved on 2026-11-16

The owner approved the upgrade plan's decisions as recommended. Where each one lands:

| Decision | Approved | Where |
|---|---|---|
| D1 | Node.js 24 LTS now; Node 26 later, as its own trial and switch | Items 1 and 11 |
| D2 | PBE-077, X-046, X-047, X-050 and X-048 in M0; X-049, OBE-103, PBE-076 and SDK-019 in M6; a dated note in each of the nine in-progress tasks that item 3 names gates its pending VM steps; the effective path to the first VM rehearsal is reported as about 48 h, plan-lint's as 32 h | Item 3; the [roadmap](../plans/roadmap.md) §4.5 |
| D3 | Every app unit pins its young generation (16 for the platform API, 1 for the workers and the Next.js servers, 32 kept for the OTA API) in one quoted `NODE_OPTIONS` assignment, with the exact heap check under systemd | Item 5 (X-050; measured by OBE-103 and PBE-076) |
| D4 | One exported punycode round-trip check for custom domains and API-key origins, working on Node 22 and 24 | Item 7 (PBE-077) |
| D5 | The SDK supports Node.js 22.12 and later and 24, proven by the non-required job `sdk-node22` pinned to 22.12.0, whose exact lines are below | Item 9 (SDK-019) |
| D6 | Root `engines.node` is `>=24 <25` | Item 1 (X-048) |
| D7 | `@types/node` 24.19.2, checked again when X-048 starts; the lockfile changes only `@types/node`, `undici-types` and the peer suffixes | Item 1 (X-048) |
| D8 | `.nvmrc` is a Turborepo global dependency | Item 4 (X-047) |
| D9 | `NODE_MAJOR` moves a provisioned VM both ways through `--steps node`, and `check-vm.sh` checks the version, the pin and the source line against it | Item 6 (X-047) |
| D10 | Node patches on the VM are installed by hand in the weekly `apt list --upgradable` review; the `aide-change` alert they raise is explained by `/var/log/dpkg.log` | Item 10 (X-048) |
| D11 | No CI job installs nodejs from NodeSource for Node 24; the throwaway VM proves NodeSource's package and its corepack. Such a job becomes required for a move to Node 26 | Items 8 and 11 (X-048, the runbook's VM checklist) |
| D12 | `velexis-deploy --rollback` across majors is documented, not checked | Item 10 (X-048); reviewed against KI-041 and confirmed on 2026-11-22 (item 10's dated note, lead decision (38e)) |
| D13 | TLS security level 2 and Node 24's root store are accepted; the peers are checked on the throwaway VM | Item 8 (X-048) |
| D14 | ada 4's stricter IDN rule is accepted, with the `١٢٣.com` case in the switch commit | Item 7 (X-048) |
| D15 | No CI matrix; the only Node 22 lane is D5's job | Item 3, Alternatives considered |
| D16 | The SDK declares its range in `engines` | Item 9 (SDK-019) |
| D17 | X-048 runs alone in its wave; the agents' machine changes to Node 24 after it, and a personal cloud environment is proposed for future sessions | Item 3 |
| D18 | Each task re-points the PCI evidence pack's file:line references its own diff moves; the integrator's post-merge pass handles shifts from the merge order | Item 3 (the task blocks) |

## Open questions settled on 2026-11-16

*Note (2026-11-16, lead decision (26d) of 2026-11-16, approved by the owner with "yes to all"; FIX-W57-DOCS).* The upgrade plan left five questions open beside D1–D18. They are settled as follows. None of them changes an approved decision, a task's size or the calendars.

| Question | Settled | Where |
|---|---|---|
| The SDK's floor: Node.js 22.12 or 22.13 | **22.12 stays**, as approved (D5). `require()` of the SDK's ES module build is on by default from 22.12.0; 22.12.x still prints an `ExperimentalWarning` when the requiring file is outside `node_modules`, which 22.13.0 drops (`CHANGELOG_V22.md`). SDK-019 documents that warning where it states the range, and `sdk-node22` stays on 22.12.0. | Item 9 (SDK-019) |
| NodeSource's corepack and the external TLS peers: a NodeSource CI job now, or first on the throwaway VM | **First on the throwaway VM**, as approved (D11, the upgrade plan's option (a); D13): no CI job installs nodejs from NodeSource for Node 24. After the switch, the runbook's VM checklist (`docs/mvp/runbooks/node-upgrade.md` §5) proves NodeSource's corepack and pnpm 9.15.9, and the TLS handshakes of item 8, before production. | Items 8 and 11 (X-048, the runbook's VM checklist) |
| The personal cloud environment's network: does it reach nodejs.org by default | **The lead checks it before proposing the environment** (D17): the proposal is made only once the lead knows whether the environment's network reaches the host its setup script downloads Node 24 from, and it lists that host when the network does not allow it by default. | Item 3 (after X-048) |
| Node 22 for OBE-103 and PBE-076: the installed 22.23.4, or 22.23.5 first | **The installed `/opt/node22` (v22.23.4)**, not updated first. Each measurement names the exact versions of both runtimes it ran (`node --version`). | Item 3 (OBE-103, PBE-076) |
| The cgroup v2 path inside real systemd units, which the study could not check | **Proven by X-050 AC2 in CI**: CI's `systemd-units` job asserts, inside each real unit, that V8's heap limit equals old + 3 × semi of the unit's flags and that Node's constrained memory equals its `MemoryMax`. X-050 is not done before that job passes; a constrained memory other than `MemoryMax` stops X-050 for a report (its step 5). | Item 5 (X-050) |

## Results

*Recorded by X-048 on 2026-11-17 (wave 58); the details are in [`node-upgrade.md`](../runbooks/node-upgrade.md) §2 and §3.*

- **The trial** (X-046, 2026-11-16, runbook §2). Every command of CI, the four end-to-end projects, the SDK's smoke tests and the deploy tests ran on v24.22.3 from a worktree still pinned to 22. The one failure was PBE-077's case (`xn--zz.example.com`, item 7), which PBE-077 fixed on both majors before the switch. No warning came from the repository's own code or its dependencies; the eight native addons are N-API and load on both majors; the `@types/node` 24.19.2 bump typechecked and changed only `@types/node`, `undici-types` and the peer suffixes of the lockfile.
- **The switch** (X-048, runbook §3.1). One commit, which the integrator squash-merges alone in wave 58 (`Task: X-048`): `.nvmrc` `24`; `engines.node` `>=24 <25`; `@types/node` 24.19.2 (`typeScriptVersion` 5.6, still the newest 24.x on 2026-11-17) in the 15 `package.json` files, with a lockfile in which only `@types/node`, `undici-types` (6.21.0 → 7.24.6) and the peer suffixes changed and no `@types/node@22` is left; `NODE_MAJOR` `24`, `check-vm.sh`'s default and its test's fixture; the reason of `deb.nodesource.com`; the documents that named the major; and the `[X-048 AC3]` case of `hostname-rules.test.ts` (`١٢٣.com` refused, D14), which passes on 24 and fails on 22.23.4. No workflow file changed: every `actions/setup-node` step already reads `.nvmrc`.
- **Its proof on Node 24 on the agents' machine** (v24.22.3, runbook §3.2): format, lint, typecheck, `pnpm test` (9,174 tests), `pnpm build`, `pnpm test:int` (2,888 tests, with the PAN-absence proof), both `test:xb`, the four end-to-end projects (387 tests), the SDK's smoke tests, the deploy scripts' tests, `caddy-smoke.sh`, `check-vm.test.sh` as root with the real `sshd` and `nft`, and X-047's `node-major.test.mjs` all passed.
- **CI and E2E on the integration branch** (runbook §3.3; recorded by wave 58's integrator on 2026-11-17, as [ADR-0028](0028-how-work-reaches-main.md) has waves reach `main`): CI run [44016005952](https://github.com/bhagwati-prasad/velexis-ota/actions/runs/44016005952) and E2E run [44016009706](https://github.com/bhagwati-prasad/velexis-ota/actions/runs/44016009706), both dispatched on the switch's squash commit `68c0412`, were green, all eight CI jobs among them. Every `actions/setup-node` step (seven CI jobs and E2E) resolved `.nvmrc` as 24 and logged `node: v24.22.2`, the runner image's cached 24.x (no `check-latest`). The first CI run had no Turborepo cache hit from the Node 22 entries it restored (the cache of `f6a0a3c`): its first Turborepo step, Lint, ran 0 of 29 tasks from the cache, both integration jobs 0 of 17, and each of the 12 hits of `build-test`'s later steps is a task its own Lint step had just run. The `systemd-units` job's heap check of item 5 passed under systemd for the seven units: 688 MiB (platform API), 736 MiB (OTA API), 403 MiB (each worker) and 387 MiB (each Next.js server), each with its `MemoryMax` as constrained memory. E2E ran the four projects (387 passed) and the SDK's smoke tests (24 passed). The only Node warnings in the logs are the actions' own `DEP0040` and `DEP0169` lines, which the last run on Node 22 had too, and one `DEP0169` line of pnpm 9 in the `dev-setup` job's `pnpm install` through corepack (runbook §2).
- **Wave C** (wave 59, 2026-11-18; recorded by wave 59's integrator). OBE-103 ([`ota/docs/performance.md`](../../../ota/docs/performance.md) §10) and PBE-076 ([`platform/docs/performance.md`](../../../platform/docs/performance.md) §6) measured both APIs and both workers on Node 22.23.4 and 24.22.3, each from one build made on Node 24, with the units' flags of item 5. On Node 24 every peak RSS stayed at least 297 MiB under its `MemoryMax` (64 MiB required), garbage collection took at most 2.1 % of a process's time (5 % allowed), and the p95s were lower or within 10 % of Node 22's: for the OTA side in every run, for the platform side on each runtime's mean p95, while some of its single interleaved pairs cross 10 %: R1 → R2 in `signIn` (+25 %) and `getTenant` (+26 %), at a load average of about 7, and R1 → R2b and R3 → R4 in the `ask` phases (up to +25 %, 0.5 ms; PBE-076's §6 names the re-measurement on the throwaway VM that reading would bring, which the lead's reading below does not ask for). No unit's flags changed. X-049 replaced the remaining text that named Node 22 as the runtime; what is left compares the two majors' URL parsers (PBE-077, item 7) or names the SDK's floor. SDK-019 states the SDK's range (Node.js 22.12 and later, and 24; `engines.node` `>=22.12`) and adds the non-required job `sdk-node22` with the lines approved below (D5); its first green run is CI run [44246120851](https://github.com/bhagwati-prasad/velexis-ota/actions/runs/44246120851) (`node: v22.12.0`, the SDK's 1,087 tests; SDK-019's block).
- **The lead's reading of the open points of OBE-103 and PBE-076** (2026-11-18, lead decisions (29a), (29b) and (29d) of 2026-11-18, approved by the owner with "yes to all"; recorded by FIX-W60-SHARED). Both points are closed, and no unit's flags change:
  - *The p95 threshold* ("no p95 more than 10 % worse than on Node 22") is judged on each runtime's mean p95 over at least two quiet runs (runs under the repeat rule's load limit of 6), and on that reading PBE-076 meets it (quiet runs −23.5 % to 0.0 % per phase); OBE-103 meets it on every reading. The single-run and pair crossings of the two `ask` phases are below what the measurement resolves: their p95s are 2 to 3 ms, recorded to 0.1 ms, one runtime's own spread between quiet runs reaches 0.9 ms against a difference of 0.0 to 0.1 ms between the runtimes' means, and both runtimes are about 8 times under the cached `ask`'s 20 ms target, so there is no re-measurement. R1 → R2's `signIn` and `getTenant` crossings fell in R2's load of about 7, which its quiet repeat R2b did not show.
  - *"5 % of its time in garbage collection"* means the main-thread garbage-collection pause time over the process's elapsed (wall-clock) time, which is what both observers measure (`tools/perf/gc-observer.cjs` and the measuring preload of `search-load.mjs`). The share of CPU time is recorded for information and is no bound: the OTA worker's pauses are 9.2 % of its CPU time on Node 22 and 8.8 % on Node 24 with its pinned 1 MiB semi-space, while it is idle most of the time, and one OTA API search run (S24-2) reached 5.8 %.
  - *OBE-103's runs are accepted as recorded*: B24, which started at a 1-minute load average of 5.80 (under the repeat rule's 6) after another agent's locked run; the report-only change of `booking-load.mjs` between B22 and B24; and the two small single-process checks another agent ran beside B24 (a typecheck of `ota/backend` and an ESLint run on one file, about 02:47 and 02:48 UTC, when B24's 1-minute load average stayed below 1.0).
- **Three hours on Node 24** (OBE-104, lead decision (29c) of 2026-11-18, approved by the owner; run on 2026-11-19, recorded by wave 60's integrator; [`ota/docs/performance.md`](../../../ota/docs/performance.md) §11). One 180-minute `booking-load.mjs --tenants 5` run (R180) of one build on v24.22.3 with the units' flags of item 5 sampled RSS, heap used, heap total, external and array buffers of the OTA API and the worker every 5 s. By the task's rule (an RSS slope below 0.02 MiB a minute over minutes 90–180, and the heap used's slope not above it) neither process settles: the API's RSS rose +0.0166 MiB a minute (r² 0.83) but its heap used's slope was +0.0250 (r² 0.00, the collections' saw-tooth; its least heap used stayed within 88 to 94 MiB); the worker's RSS rose +0.0241 MiB a minute (r² 0.94), down from +0.1112 over minutes 30–90, with its heap used at +0.0100. Heap snapshots at minutes 30 and 60 of a second run (D65b) show no growing object but V8's compiled code (the worker +1.06 of +1.36 MiB, the API +0.43 of +0.61 MiB); the rest of the worker's growth is anonymous memory outside the JS heap. Both stayed far under their `MemoryMax` (peaks 357.3 and 222.1 MiB, 410.7 and 289.9 MiB of headroom), external memory and array buffers were flat, and garbage collection took 0.64 % and 0.29 % of the phase. No unit's flags changed. The follow-up (accept, a longer run of the worker, or a diagnosis of the allocator) and the run's finding that every checkout keeps its search's offers in `flight_offers` for good were for the lead (decided on 2026-11-19, the next item).
- **The lead's decisions on OBE-104** (2026-11-19, lead decisions (30a) to (30d) of 2026-11-19, approved by the owner with "yes to all"; recorded by FIX-W61-MEMORY; [`ota/docs/performance.md`](../../../ota/docs/performance.md) §11). No unit's flags change.
  - *(30a) Accepted as measured, no new task now.* By step 4's rule neither process settles, but the API's RSS meets it (+0.017 MiB a minute), the worker's RSS rises +0.024 MiB a minute (about 1.4 MiB an hour), the heap snapshots show only V8's compiled code growing, and both stay far under their `MemoryMax`. Three hours cannot show whether the worker levels off, so the throwaway VM's checks of runbook §5 (the owner's rehearsal of X-020 and X-021) gain step 9: the OTA worker and the API beside it run for at least 8 hours, up to 24, under traffic, with their memory sampled every minute and judged by (30b)'s rule; a process still rising by it after 8 hours becomes a follow-up task then. On the VM the step reads the units' RSS only, because a unit's JS heap cannot be read without changing the unit (runbook §5 step 9 says why).
  - *(30b) The JS heap is judged by its floor after the collections*: the least-squares slope of the least heap used of each 5 minutes over minutes 90–180 must not be above 0.02 MiB a minute; RSS keeps step 4's rule (a slope below 0.02 MiB a minute over the same minutes), and the heap used's own slope stays in the report for information. `booking-load.mjs` computes it since FIX-W61-MEMORY. Re-judged so from R180's raw samples, neither process settles either: the API on its heap floor (+0.0351 MiB a minute, r² 0.08, against an RSS slope of +0.0166), the worker on its RSS (+0.0241, with a heap floor of +0.0112, r² 0.61). *2026-11-19 (lead decision (31a), approved by the owner; FIX-W62-DOCS):* the API's verdict is recorded as inconclusive by measurement noise (a standard error of 0.029 on its floor slope, larger than the bound, and +0.009 to +0.068 MiB a minute for floor windows of 1 to 15 minutes), the rule and its 5-minute window stay, and runbook §5 step 9's run on the throwaway VM, judged on RSS, decides.
  - *(30c)* OBE-104's second acceptance criterion is met by its alternative; OBE-104 stays done. *(30d)* The offers a checkout keeps for good in `flight_offers` get a bound in OBE-105 (after the launch), which applies a dated revision of OADR-0002 point 6.
- **Still to come**: the throwaway-VM checklist of runbook §5 in X-020's and X-021's rehearsals (NodeSource's package and its corepack, the TLS peers of item 8, each unit's peak memory, the `NODE_MAJOR` round trip), and the run of 8 to 24 hours of the OTA worker and API under traffic that runbook §5 step 9 adds for lead decision (30a) of 2026-11-19 (their RSS sampled every minute; a process still rising after 8 hours becomes a follow-up task). Until 2026-11-18 this item also listed the lead's reading of the open points of OBE-103 and PBE-076 (the p95 threshold pair by pair, garbage collection as a share of CPU time), and until 2026-11-19 the lead's choice of OBE-104's follow-up; the items above record them.

## Approved workflow lines (D5)

SDK-019 makes this change to `.github/workflows/ci.yml`, and no other workflow change. In line 17, `# names and ports, PostgreSQL over TLS only).` becomes `# names and ports, PostgreSQL over TLS only), sdk-node22 (SDK-019: the SDK's tests on Node.js 22.12.0; not required).`, so the line count stays and the PCI pack's reference to `ci.yml#L670` does not move. After the last line (`        run: pnpm test:int` of the `alt-hosts` job, line 845 on 2026-11-16) come one empty line and these lines:

```yaml
  sdk-node22:
    # SDK-019 (ADR-0029 item 9, approved by the owner on 2026-11-16): the SDK's unit and contract tests on the oldest
    # Node.js its README promises, 22.12.0, while every other job runs the .nvmrc major. Not a required check; no
    # Turborepo cache is restored or saved. A task removes it after Node 22's end of life on 2027-04-30.
    name: SDK on Node.js 22.12
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      # The pnpm version comes from package.json "packageManager".
      - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v5.0.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22.12.0
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: "[SDK-019 AC2] The SDK's unit and contract tests on Node.js 22.12.0"
        run: |
          node --version | grep -qx v22.12.0
          pnpm exec turbo run test --filter=@velexis/ota-sdk
```

Not changed: the six required checks and their names, `deploy.yml` and `e2e.yml`, every cache key (D8), and no `check-latest` (CI uses the runner image's cached 24.x; only the major is compared). The action pins reuse the commits already in `ci.yml`. Removing the job after 2027-04-30 is a later task that needs its own approval.

## Consequences

### Positive

- The launch runs on a supported LTS, with security fixes until 2028-04-30.
- No library upgrade and no native rebuild. The release artefact keeps its shape.
- The major cannot drift unnoticed between CI, releases and the VM. The build cache cannot replay results from another major, and a provisioned VM can move between majors with one variable.
- The VM's heap no longer depends on V8's heuristics. A dropped flag fails the units smoke test, and load tests run with the VM's own flags.
- A rollback is one revert, plus one variable on a provisioned VM.

### Negative

- **Maintenance line.** Node 24 is already in maintenance: security and critical fixes only.
- **End of life vs the slow calendar.** Node 24's end of life (2028-04-30) falls inside M6 of the calendar without agents (3 Apr – 21 Jul 2028 since the re-baseline of 2026-11-16), before that calendar's Node.js 24 block (C81–C83, 12–30 June 2028; [roadmap](../plans/roadmap.md) §1.3). If that calendar applies, the move to 26 becomes a launch prerequisite.
- **Two waves before the first VM.** The VM rehearsal of X-020 and X-021 waits for the switch. The remaining path to the launch's VM work grows from 32 to 48 agent-hours. plan-lint still shows 32, because the gate is a dated note, not a dependency.
- **Pins need care.** Changing a pinned semi-space needs a deliberate decision. Workers and Next.js servers run with 1 MiB, as they would by default under their `MemoryMax`. OBE-103 and PBE-076 measure the cost of garbage collection.
- **Stricter TLS.** A legacy SMTP relay could be refused.
- **Log noise.** pnpm 9 prints DEP0169 on Node 24 whenever it runs from outside `node_modules`: corepack's shim, or `/usr/bin/pnpm` on the VM.
- **Cost.** About 46 agent-hours, extra checks in the throwaway-VM rehearsal, and a change of the agents' machine.

### Follow-ups

- The findings of OBE-103 and PBE-076, if any.
- Removing the SDK's Node 22 job after 2027-04-30.
- The Node 26 move (item 11).
- Moving `actions/setup-node` from v4 to v5, as a separate change. The action itself runs on node20, and v5 turns on dependency caching by default, which `deploy.yml` must not get.

## Alternatives considered

- **Stay on 22 until after the MVP** (tech-stack.md's plan). Rejected: Node 22 reaches end of life before the launch.
- **Node 26 now.** Rejected for now, for the reasons in the context above. It remains the next step (item 11).
- **A CI matrix of 22 and 24.** Rejected: it renames the six required checks and breaks the workflow tests. No consumer of the platform needs 22.
- **`--max-semi-space-size=16` in every unit.** Rejected: without a measurement it would change production compared with Node's defaults (workers and Next.js from 1 to 16 MiB).
- **Node's default young generation.** Rejected: the VM would depend on V8's heuristics, and load tests would measure 64 MiB semi-spaces the VM never uses.
- **A dependency of X-020 and X-021 on X-048.** Rejected: both are in progress with their code done, and the repository changes an in-progress task only by a dated note.

## Revisions to other records

Dated revisions point here:

- ADR-0002 item 1: `engines.node`, `.nvmrc`; "Node 24 can require() ES modules".
- ADR-0007, Host: Node.js 24 LTS from NodeSource.
- ADR-0023, Release folder: built with the `.nvmrc` major; native modules are N-API prebuilds, so the major check is a policy check.
- ADR-0019 and OADR-0016: item 9.

## References

- [`decisions.md`](../decisions.md); [`tech-stack.md`](../tech-stack.md) §1; [`deployment-single-vm.md`](../deployment-single-vm.md) §2, §3, §8, §12 and §14
- `docs/mvp/runbooks/node-upgrade.md` (written by X-046 and X-048)
- [ADR-0002](0002-monorepo-pnpm-turborepo.md), [ADR-0007](0007-single-vm-without-docker.md), [ADR-0019](0019-vanilla-js-sdk-jsdoc.md), [ADR-0023](0023-release-artefact-and-deploy-user.md), [ADR-0027](0027-pci-scope-and-vm-controls.md), [ADR-0028](0028-how-work-reaches-main.md)
- Node.js `doc/changelogs/CHANGELOG_V22.md` (22.12.0, 22.13.0, 22.20.0) and `CHANGELOG_V23.md` to `CHANGELOG_V26.md` (semver-major sections); `doc/api/deprecations.md`; `doc/api/cli.md` (`--max-semi-space-size`); nodejs/Release `schedule.json`; systemd.exec(5) (`Environment=`); apt_preferences(5)
- Tasks PBE-077, X-046, X-047, X-050, X-048, X-049, OBE-103, PBE-076 and SDK-019

