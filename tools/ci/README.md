# `tools/ci`: CI checks and the rules CI enforces

This folder holds the plain-Node checks that [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs besides lint, typecheck and tests, and their tests. Like `tools/plan-lint`, it has no `package.json`: it is not a workspace package and Turborepo does not run it. `check-package-json.mjs` needs no install; `check-no-hardcoded-hosts.mjs` parses with the repository's own TypeScript (the root devDependency), so it runs after `pnpm install`. Task [X-019](../../docs/mvp/plans/foundation-tasks.md) created it.

| File | What it does |
|---|---|
| `check-package-json.mjs` | Fails on version ranges, misplaced test packages, packages that depend on apps, and actions not pinned to a commit SHA (below) |
| `check-package-json.test.mjs` | Tests of the script, on small repositories built in a temporary folder |
| `check-no-hardcoded-hosts.mjs` | Fails on `localhost`, `127.0.0.1`, `:5432` or `:6379` in the code of the apps and packages, so that the move to managed services stays a change of configuration (below; task X-032) |
| `check-no-hardcoded-hosts.test.mjs` | Tests of that script: this repository passes, and small trees in a temporary folder fail or pass |
| `ci-workflow.test.mjs` | Tests of `ci.yml` itself: the job layout (the `integration` job set up as `build-test` is, in parallel with it; the `check-vm` job; the `alt-hosts` job, set up as `integration` is but on other host names and ports; the lint and tests of `tools/perf` in `build-test`; the `deploy-files` job's health check test, its unit sandboxing loop, its unit check run with a stand-in `systemd-analyze` (helper names with hyphens pass, anything else fails; lead decision (20p) of 2026-11-13) and its tests of the security logs), the "Repository guards" step run on scratch git repositories, and the `.only` lint rule |
| `deploy-e2e-workflow.test.mjs` | Tests of how `deploy.yml` and `e2e.yml` fit together (lead decision (15c) of 2026-11-11, approved by the owner; FIX-W48-SHARED): Deploy's `e2e` job calls `e2e.yml` for the commit being deployed with only the three Stripe test secrets, its `deploy` job needs `build` and `e2e` and refuses a release of another commit than the one tested (its "Check the release id" script run in `bash`), and its environment, SSH secrets and push are unchanged; `e2e.yml`'s `workflow_call` trigger, its concurrency group per event or caller (evaluated for a nightly, an on-demand, a deploy-called and two pull-request runs), the conditions of its Stripe steps (evaluated after a failed Playwright step, a failed set-up and a cancellation, for each event), each Playwright step's own results folder, the upload on failure or cancellation and the 45-minute limit. A small evaluator of the GitHub expressions these files use reads the conditions as GitHub would |
| `workflow-reader.mjs` | The reader of the workflows' shape both test files use (jobs, steps and their fields, a job's or a step's own keys, top-level keys), by indentation and without a YAML package |

## Run it locally

```bash
node tools/ci/check-package-json.mjs   # the task's Verify command, with node tools/plan-lint/plan-lint.mjs
node tools/ci/check-no-hardcoded-hosts.mjs   # X-032's Verify command, after pnpm install (it needs TypeScript)
pnpm exec eslint tools/ci              # Turborepo lints only workspace packages, so CI lints this folder itself
node --test tools/ci/*.test.mjs        # after pnpm install: the lint test loads ESLint and eslint.config.mjs
pnpm exec eslint tools/perf            # the same step lints and tests tools/perf (lead decision (13c) of 2026-11-10)
node --test tools/perf/*.test.mjs      # the pure helpers of platform-smoke.mjs (tools/perf/README.md)
```

The tests need `git`, `bash`, `grep` and `cmp`, and write only to the system temporary folder.

## `check-package-json.mjs`

It reads the root `package.json` and every workspace package that `pnpm-workspace.yaml` matches (`node_modules`, build output and dot folders are skipped), then every workflow in `.github/workflows/` and every composite action in `.github/actions/`. It prints one line per problem (a GitHub annotation inside Actions, escaped so that file content cannot start a workflow command) and exits 1 if there is any. It also fails when it cannot read what it checks, so it never passes by checking nothing: a missing `pnpm-workspace.yaml` or one without a block list under `packages:` (a flow list `packages: [...]` included), a `package.json` that is not JSON, or a `uses:` inside a flow mapping (`- { uses: ... }`).

| Rule | Source | Fails on |
|---|---|---|
| Exact versions | [ADR-0002](../../docs/mvp/adr/0002-monorepo-pnpm-turborepo.md) item 7 | Any `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` or `pnpm.overrides` entry that is not an exact `x.y.z` (a prerelease is fine), `workspace:*` or an exact `npm:` alias. `^1.0.0`, `~1.0.0`, `>=1`, `1.x`, `*`, `latest`, `workspace:^`, git, file and URL specs all fail. The root `packageManager` must be an exact `pnpm@x.y.z` (item 1). |
| Test packages are dev-only | [ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md) item 2 | `@velexis/testing` or `@velexis/amadeus-stub` in any field but `devDependencies`. `pnpm deploy --prod` would leave them out of a release anyway. |
| Packages never depend on apps | ADR-0002 item 5 | A package under `packages/` that lists, in any field, a workspace package under `platform/` or `ota/` (the SDK included), or any `@velexis/platform-*` or `@velexis/ota-*` name, even before that app exists. |
| Actions pinned to a commit | [ADR-0023](../../docs/mvp/adr/0023-release-artefact-and-deploy-user.md) | A `uses:` that is not `owner/repo[/path]@<40 hex characters>`, or that has no tag comment (`# v4.4.0`). Local actions (`./…`) are fine; `docker://` images need an `@sha256:` digest. Text after the tag in the comment is a **warning**: Dependabot updates the comment only when it ends with the tag. |

To pin a new action, take the commit of the release tag and keep the tag as the last thing in the comment:

```bash
git ls-remote --tags https://github.com/actions/checkout.git 'refs/tags/v4.4.0*'
# For an annotated tag, use the commit of the line ending in ^{} (the peeled tag).
```

```yaml
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

## `check-no-hardcoded-hosts.mjs`

Task X-032 ([`deployment-single-vm.md`](../../docs/mvp/deployment-single-vm.md) §15, [`decisions.md`](../../docs/mvp/decisions.md) §2): the apps reach PostgreSQL, Redis and every other service through DSNs and URLs of the configuration, never through a host or port in the code. The script reads every file under `platform/*/src`, `ota/*/src`, `packages/*/src` and `tools/reference-data/src` (the reference data loader, which ships in the release and runs on the VM at every deploy; the other tools never run there) and prints file, line and column of each `localhost`, `127.0.0.1`, `:5432` or `:6379` in their code (any case; `port: 5432` counts too), then exits 1.

| Not a finding | Why |
|---|---|
| Comments and JSDoc | TypeScript's parser separates them from the code (`.ts`, `.tsx`, `.js`, `.mjs` and the other script extensions). Strings, template literals, regular expressions and JSX text are code. |
| Tests | `*.test.*` and `*.spec.*` files, the folders `test`, `tests`, `__tests__` and `__mocks__`, and the whole of `packages/testing`, a devDependency that never ships ([ADR-0022](../../docs/mvp/adr/0022-shared-test-support-package.md) item 2) |
| Documentation, word lists, binaries | `.md`, `.txt`, fonts and images are not read. Templates, styles and data (`.hbs`, `.html`, `.css`, `.json`, `.sql`, `.yaml`) are read line by line, comments included. |
| A reviewed exception | `ALLOWED` in the script: a code fragment of one file and the reason it is no service location. Today: each app's listen address on the VM's loopback behind Caddy, rules and help texts that recognise the loopback as a value (test-key origins, the Amadeus stub, the OTA admin's API on the same VM), the end-user IP of a request without `X-Forwarded-For`, the TLS probe of the VM's own Caddy, and the development-only `dev:seed`. An exception that matches nothing any more fails, so the list cannot outlive the code. |

`@velexis/config` has no development-only defaults to exempt: no URL has a default ([`conventions.md`](../../docs/mvp/conventions.md) §8), and the only defaults that hold `127.0.0.1` are the Next.js listen addresses, which are exceptions above. The script also fails when it finds no source file at all. `--root <dir>` checks another tree; `--allow <file.json>` replaces `ALLOWED` and is for the tests only.

## The E2E and Deploy workflows

`ci.yml` does not run them. [`e2e.yml`](../../.github/workflows/e2e.yml) runs nightly, on demand, on pull requests labelled `e2e` and, since lead decision (15c) of 2026-11-11 (approved by the owner), when [`deploy.yml`](../../.github/workflows/deploy.yml) calls it: Deploy's `deploy` job needs that run, so nothing is deployed before a green end-to-end run of the same commit ([`tools/e2e/README.md`](../e2e/README.md), CI; [`deployment-single-vm.md`](../../docs/mvp/deployment-single-vm.md) §8). `deploy-e2e-workflow.test.mjs` tests both files; `actionlint` validates them.

## The CI workflow

`ci.yml` runs on every pull request, on every push to `main` and on demand (`workflow_dispatch`). Agents never change it to get their own change through ([AGENTS.md](../../AGENTS.md) §7).

| Job (check name) | Needs install | Steps |
|---|---|---|
| `plan-lint` (Plan lint) | No | `node tools/plan-lint/plan-lint.mjs` |
| `deploy-files` (Deploy files) | No | `shellcheck -S style deploy/scripts/*.sh deploy/scripts/test/*.sh deploy/systemd/test/*.sh deploy/caddy/test/*.sh`; Caddy 2.8.4 (SHA-512 checked) validates and `fmt`-checks the Caddyfile; `deploy/caddy/test/caddy-smoke.sh` runs the real Caddyfile with a local CA, test ports and an echo upstream on Node 22 ([`deploy/caddy/test/README.md`](../../deploy/caddy/test/README.md), X-022); `deploy/scripts/test/deploy.test.sh` runs `velexis-deploy` against fake releases with a fake `systemctl` and fake apps, without root (X-023); `deploy/scripts/test/healthcheck.test.sh` runs `velexis-healthcheck` against a temporary VM root, fake endpoints and stand-ins for `systemctl`, `velexis-alert`, `df` and `redis-cli`, without root (X-030; it needs `curl`, `jq` and `openssl`, which the step installs if the runner image lacks one; lead decision (11i) of 2026-11-06, approved by the owner); since lead decision (20p) of 2026-11-13 (approved by the owner) `deploy/scripts/test/ship-logs.test.sh` and `log-review.test.sh` run `velexis-shiplogs` and `velexis-logreview` against a fake journal export and a local rclone remote, without root (X-038; the step installs `rclone` and `zstd` from the runner's apt, and `jq` and `age` when the image lacks them); `systemd-analyze verify` of the units, which may report only the paths that exist on the VM alone (`/usr/bin/node`, the `/usr/local/sbin/velexis-<name>` helpers, whose names may hold hyphens since lead decision (20p): `velexis-[a-z-]+`); `systemd-analyze security` keeps every app unit, `velexis-alert@`, `velexis-healthcheck`, `velexis-egress-refresh` and, since lead decision (20p), `velexis-ship-logs` and `velexis-log-review` at exposure 2.0 or lower (X-021, X-030, X-038) |
| `systemd-units` (systemd units smoke test) | No | `deploy/systemd/test/units-smoke.sh` runs the real units with a stand-in app under systemd, with PostgreSQL, Redis and Mailpit service containers, and checks that a unit killed into `failed` mails one alert (X-021). Since lead decision (17a) of 2026-11-11 (approved by the owner) the job installs `nftables` when the image lacks it, and the test also rates `velexis-egress-refresh.service` and starts a test copy of it with the real `velexis-egress` in a network namespace of its own; `deploy-files`' sandbox loop rates it too (`ci-workflow.test.mjs`) |
| `check-vm` (VM check test) | No | Lead decision (13l) of 2026-11-10, approved by the owner: installs `openssh-server` when the `ubuntu-24.04` image lacks it and creates `/run/sshd` (`sshd -t` needs it while `ssh.service` is not running), then runs `sudo bash deploy/scripts/test/check-vm.test.sh` ([`deploy/README.md`](../../deploy/README.md), Tests): `check-vm.sh` against fake system tools, and the steps `users`, `keys`, `envfiles` and `ssh` of `provision-vm.sh` under a temporary `VELEXIS_ROOT` (X-020, X-037, X-040, the AIDE timer check and the SSH lockout guard), with the real `sshd -t` and `sshd -T` validating the SSH drop-ins. The step fails unless the test's last line is `check-vm.test: all checks passed`, which it prints only when the real-sshd checks ran too. Since lead decision (17a) of 2026-11-11 (approved by the owner) the job also installs `nftables` when the image lacks it, and the test fails, with a last line that names it, when its real-`nft` part (the allow-list's table in a private network namespace) cannot run. 10-minute limit; no condition and no `continue-on-error` (`ci-workflow.test.mjs`, which also asserts the `nftables` install and the test's failure without a real `nft`) |
| `dev-setup` (Local development setup) | Yes | [`docs/mvp/local-development.md`](../../docs/mvp/local-development.md) §2 on a clean runner: PostgreSQL 16 and Redis 7.4 from apt, `deploy/scripts/dev-setup.sh` and `tools/dev/dev-keys.mjs` twice, then the roles, every login of `.env.local`, the Redis password and the key files (X-016) |
| `build-test` (Build and test) | Yes | Repository guards; `check-package-json.mjs`; install; Turborepo cache; database bootstrap; `pnpm dev:keys`; ESLint and tests of `tools/ci` and, since lead decision (13c) of 2026-11-10, of `tools/perf` ([`tools/perf/README.md`](../perf/README.md)); `pnpm format:check`, `lint`, `typecheck`, `test`; generated files up to date; the SDK route table up to date (SDK-002); `pnpm build`; the cross-backend tests of both backends (`test:xb`, PBE-035 and OBE-083); a dry run of `deploy/scripts/pack-release.sh` |
| `integration` (Integration tests) | Yes | In parallel with `build-test` (lead decision (5o) of 2026-11-05, approved by the owner), with the same runner, PostgreSQL 16, Redis 7.4 and Mailpit service containers, environment and 45-minute limit: checkout, pnpm, Node, install, the Turborepo cache (restored only), database bootstrap, `pnpm dev:keys`; then `pnpm test:int` (its files make their own databases as `TEST_DATABASE_ADMIN_URL` with `@velexis/testing`, so this job leaves `velexis` unmigrated, as the bootstrap made it) and the PAN-absence report check, which fails when `ota/backend/node_modules/.cache/pan-absence/report.json` is missing, lacks one of the airline card's paths or holds a finding (OBE-052, [`ota/backend/README.md`](../../ota/backend/README.md) §8) |
| `alt-hosts` (Integration tests on other hosts and ports) | Yes | Task X-032: `pnpm test:int` with PostgreSQL and Redis reached through other host names and ports, as after a move to managed services ([`deployment-single-vm.md`](../../docs/mvp/deployment-single-vm.md) §15). `/etc/hosts` aliases `pg.internal.test` and `redis.internal.test` point at the runner, the service containers listen on 6543 and 6380, and the step fails if anything answers on 5432 or 6379. PostgreSQL gets a certificate for `pg.internal.test` from a throwaway CA (`docker cp`, `docker exec`, `ALTER SYSTEM`, a reload: a service container takes no server options) and refuses every TCP connection without TLS (`hostnossl ... reject`); the DSNs carry `?sslmode=verify-full&sslrootcert=/tmp/pg-tls/ca.crt`. Not `sslmode=prefer`: node-postgres 8 treats it as `verify-full` (no fall-back to plain text) and prints a security warning on stderr, which fails the clean-stderr assertion of `packages/db`'s codegen test. Then the setup of the integration job with `check-no-hardcoded-hosts.mjs` after the install, and the tests (no PAN-absence proof: the integration job has it). Same runner, Redis, Mailpit and 45-minute limit as `integration` |

The guards and `check-package-json.mjs` run before `pnpm install`, so a broken rule fails in seconds. The integration tests have their own job since 2026-11-05: on run 41847581727 they took 16.4 of `build-test`'s 31.5 minutes, so the two jobs together now finish in about the time of the longer one.

### Repository guards

| Guard | Source | Fails when |
|---|---|---|
| Session-level `search_path` | [ADR-0004](../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md) | A TypeScript, JavaScript or SQL file under `platform/`, `ota/`, `packages/` or `tools/` (outside `node_modules` and build output) contains `SET search_path`, `SET SESSION search_path` (also with a quoted `"search_path"`) or the function form `set_config('search_path', …, false)` on one line, in any case, except under `packages/db/`. Tenant code uses `tenantTx`, which calls `set_config('search_path', …, true)`; that and `SET LOCAL` are transaction-level and allowed. |
| Baselines | [ADR-0005](../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) | A `0001_baseline.sql` that exists differs by a byte from its reference file in `docs/velexis-sdk/db/`. |
| Reference material | [`decisions.md`](../../docs/mvp/decisions.md) §3 | A pull request changes anything under `docs/velexis-sdk/` or `docs/amadeus-api/` (compared with the base branch: `HEAD^1` of the merge commit). |
| Focused tests | [ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md) | `it.only`, `test.only` or `describe.only` in a test file: ESLint `no-restricted-properties` (`eslint.config.mjs`) fails `pnpm lint`. Vitest also refuses `.only` when `CI` is set. |

To see a guard fail on GitHub, open a throwaway pull request with one of: a test file with `it.only` in any package, an edit under `docs/velexis-sdk/`, a `SET search_path` statement in a file under `platform/`, or a `^1.0.0` range in a `package.json`. Close it unmerged.

### Turborepo cache

`build-test` restores `.turbo/cache` with the key `turbo-<os>-<commit>` and falls back to the newest cache of any commit (`restore-keys`), so unchanged packages replay their lint, typecheck, test and build results. The cache is saved when the job succeeds, so a re-run of the same commit restores the exact key: its log shows `cache hit, replaying logs` for every cached task. `test:int` is never cached. The `integration` job and `e2e.yml` only restore it (`actions/cache/restore`, the same key and fallback): `build-test` alone saves it, so two jobs never race to save one key and the saved cache always holds the whole build. The cache only grows (Turborepo 2 does not prune it); if restoring it becomes slow, delete the `turbo-` caches under Actions → Caches.

## Dependabot

[`.github/dependabot.yml`](../../.github/dependabot.yml) asks for one weekly run (Monday) per ecosystem:

- **npm** at the workspace root, which covers every workspace package. Minor and patch updates only, grouped as `nestjs` (`@nestjs/*`, `nestjs-*`), `next-react` (Next.js, `@next/*`, React and their types), `tooling` (ESLint and its plugins, `typescript-eslint`, Prettier, Turborepo, TypeScript, Vitest) and `types` (`@types/*`); other dependencies get one pull request each. A dependency belongs to the first group it matches. `versioning-strategy: increase` keeps the versions exact.
- **github-actions**: one grouped pull request that moves the SHA pins of every workflow and the tag in their comments.

The `ignore` rules never propose a major update, and keep the lines that [`docs/mvp/tech-stack.md`](../../docs/mvp/tech-stack.md) pins: TypeScript 5.6 (patches only), `@types/node` 22, Next.js 15 with `@next/*`, NestJS 11, and the v4 line of every action. The other minor lines of its §2 get patches only too: `kysely` 0.28, `kysely-codegen` 0.20 (0.18 until lead decision (11e) of 2026-11-06), `openapi-fetch` 0.13, `esbuild` 0.25, `pdfmake` 0.2, `handlebars` 4.7, `cookie-parser` 1.4 and Tailwind CSS 4.1 (`tailwindcss`, `@tailwindcss/*`). For a 0.x package Dependabot counts 0.28 → 0.29 as a minor update, although it may break the API. Open ranges (Playwright 1.5x, `argon2` 0.41+) have no rule. **When `tech-stack.md` moves a pinned line, change the matching `ignore` rule in the same pull request.** A new major or a new pinned minor is a tech-stack change made by hand, with its release notes read, never a Dependabot pull request.

Reviewing a Dependabot pull request: CI must be green; read the changelog of each grouped update; for actions, the comment must still end with the new tag. Dependabot security updates are a separate repository setting (human steps below).

Known gap: in `deploy.yml` the `pnpm/action-setup` comment has text after the tag (`# v4.3.0; pnpm version from package.json`), so `check-package-json.mjs` warns and Dependabot will move that SHA without updating the tag. Agents do not change `deploy.yml`; the developer moves the note to its own comment line above the step.

## Human steps (the developer)

- **Protect `main`** (Settings → Branches, or Rules → Rulesets): require a pull request with one approval, require the status checks **Plan lint**, **Deploy files**, **Build and test**, **Integration tests** (since lead decision (5o) of 2026-11-05), **VM check test** (the `check-vm` job, lead decision (13l) of 2026-11-10) and **Integration tests on other hosts and ports** (the `alt-hosts` job of X-032, lead decision (19k) of 2026-11-12) to pass, allow squash merging only, require linear history, and block force pushes. Record it in the X-019 pull request ([ADR-0020](../../docs/mvp/adr/0020-ai-agent-development-workflow.md); [roadmap](../../docs/mvp/plans/roadmap.md) M0 human steps).
- Turn on Dependabot alerts and security updates, and secret scanning with push protection, in the repository's security settings.
- After the first merge, re-run the CI of a commit on `main` and check its log for Turborepo cache hits.
