# `tools/ci`: CI checks and the rules CI enforces

This folder holds the plain-Node checks that [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs besides lint, typecheck and tests, and their tests. Like `tools/plan-lint`, it has no `package.json`: it is not a workspace package, needs no install, and Turborepo does not run it. Task [X-019](../../docs/mvp/plans/foundation-tasks.md) created it.

| File | What it does |
|---|---|
| `check-package-json.mjs` | Fails on version ranges, misplaced test packages, packages that depend on apps, and actions not pinned to a commit SHA (below) |
| `check-package-json.test.mjs` | Tests of the script, on small repositories built in a temporary folder |
| `ci-workflow.test.mjs` | Tests of `ci.yml` itself: the job layout, the "Repository guards" step run on scratch git repositories, and the `.only` lint rule |

## Run it locally

```bash
node tools/ci/check-package-json.mjs   # the task's Verify command, with node tools/plan-lint/plan-lint.mjs
pnpm exec eslint tools/ci              # Turborepo lints only workspace packages, so CI lints this folder itself
node --test tools/ci/*.test.mjs        # after pnpm install: the lint test loads ESLint and eslint.config.mjs
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

## The CI workflow

`ci.yml` runs on every pull request, on every push to `main` and on demand (`workflow_dispatch`). Agents never change it to get their own change through ([AGENTS.md](../../AGENTS.md) §7).

| Job (check name) | Needs install | Steps |
|---|---|---|
| `plan-lint` (Plan lint) | No | `node tools/plan-lint/plan-lint.mjs` |
| `deploy-files` (Deploy files) | No | `shellcheck -S style deploy/scripts/*.sh deploy/scripts/test/*.sh deploy/systemd/test/*.sh deploy/caddy/test/*.sh`; Caddy 2.8.4 (SHA-512 checked) validates and `fmt`-checks the Caddyfile; `deploy/caddy/test/caddy-smoke.sh` runs the real Caddyfile with a local CA, test ports and an echo upstream on Node 22 ([`deploy/caddy/test/README.md`](../../deploy/caddy/test/README.md), X-022); `deploy/scripts/test/deploy.test.sh` runs `velexis-deploy` against fake releases with a fake `systemctl` and fake apps, without root (X-023); `systemd-analyze verify` of the units, which may report only the paths that exist on the VM alone (`/usr/bin/node`, the `/usr/local/sbin/velexis-*` helpers); `systemd-analyze security` keeps every app unit and `velexis-alert@` at exposure 2.0 or lower (X-021) |
| `systemd-units` (systemd units smoke test) | No | `deploy/systemd/test/units-smoke.sh` runs the real units with a stand-in app under systemd, with PostgreSQL, Redis and Mailpit service containers, and checks that a unit killed into `failed` mails one alert (X-021) |
| `dev-setup` (Local development setup) | Yes | [`docs/mvp/local-development.md`](../../docs/mvp/local-development.md) §2 on a clean runner: PostgreSQL 16 and Redis 7.4 from apt, `deploy/scripts/dev-setup.sh` and `tools/dev/dev-keys.mjs` twice, then the roles, every login of `.env.local`, the Redis password and the key files (X-016) |
| `build-test` (Build and test) | Yes | Repository guards; `check-package-json.mjs`; install; Turborepo cache; database bootstrap; `pnpm dev:keys`; ESLint and tests of `tools/ci`; `pnpm format:check`, `lint`, `typecheck`, `test`; generated files up to date; the SDK route table up to date (SDK-002); `pnpm test:int` with PostgreSQL 16, Redis 7.4 and Mailpit; `pnpm build`; a dry run of `deploy/scripts/pack-release.sh` |

The guards and `check-package-json.mjs` run before `pnpm install`, so a broken rule fails in seconds.

### Repository guards

| Guard | Source | Fails when |
|---|---|---|
| Session-level `search_path` | [ADR-0004](../../docs/mvp/adr/0004-postgresql-schema-per-tenant.md) | A TypeScript, JavaScript or SQL file under `platform/`, `ota/`, `packages/` or `tools/` (outside `node_modules` and build output) contains `SET search_path`, `SET SESSION search_path` (also with a quoted `"search_path"`) or the function form `set_config('search_path', …, false)` on one line, in any case, except under `packages/db/`. Tenant code uses `tenantTx`, which calls `set_config('search_path', …, true)`; that and `SET LOCAL` are transaction-level and allowed. |
| Baselines | [ADR-0005](../../docs/mvp/adr/0005-data-access-kysely-sql-migrations.md) | A `0001_baseline.sql` that exists differs by a byte from its reference file in `docs/velexis-sdk/db/`. |
| Reference material | [`decisions.md`](../../docs/mvp/decisions.md) §3 | A pull request changes anything under `docs/velexis-sdk/` or `docs/amadeus-api/` (compared with the base branch: `HEAD^1` of the merge commit). |
| Focused tests | [ADR-0015](../../docs/mvp/adr/0015-testing-strategy.md) | `it.only`, `test.only` or `describe.only` in a test file: ESLint `no-restricted-properties` (`eslint.config.mjs`) fails `pnpm lint`. Vitest also refuses `.only` when `CI` is set. |

To see a guard fail on GitHub, open a throwaway pull request with one of: a test file with `it.only` in any package, an edit under `docs/velexis-sdk/`, a `SET search_path` statement in a file under `platform/`, or a `^1.0.0` range in a `package.json`. Close it unmerged.

### Turborepo cache

`build-test` restores `.turbo/cache` with the key `turbo-<os>-<commit>` and falls back to the newest cache of any commit (`restore-keys`), so unchanged packages replay their lint, typecheck, test and build results. The cache is saved when the job succeeds, so a re-run of the same commit restores the exact key: its log shows `cache hit, replaying logs` for every cached task. `test:int` is never cached. The cache only grows (Turborepo 2 does not prune it); if restoring it becomes slow, delete the `turbo-` caches under Actions → Caches.

## Dependabot

[`.github/dependabot.yml`](../../.github/dependabot.yml) asks for one weekly run (Monday) per ecosystem:

- **npm** at the workspace root, which covers every workspace package. Minor and patch updates only, grouped as `nestjs` (`@nestjs/*`, `nestjs-*`), `next-react` (Next.js, `@next/*`, React and their types), `tooling` (ESLint and its plugins, `typescript-eslint`, Prettier, Turborepo, TypeScript, Vitest) and `types` (`@types/*`); other dependencies get one pull request each. A dependency belongs to the first group it matches. `versioning-strategy: increase` keeps the versions exact.
- **github-actions**: one grouped pull request that moves the SHA pins of every workflow and the tag in their comments.

The `ignore` rules never propose a major update, and keep the lines that [`docs/mvp/tech-stack.md`](../../docs/mvp/tech-stack.md) pins: TypeScript 5.6 (patches only), `@types/node` 22, Next.js 15 with `@next/*`, NestJS 11, and the v4 line of every action. The other minor lines of its §2 get patches only too: `kysely` 0.28, `kysely-codegen` 0.18, `openapi-fetch` 0.13, `esbuild` 0.25, `pdfmake` 0.2, `handlebars` 4.7, `cookie-parser` 1.4 and Tailwind CSS 4.1 (`tailwindcss`, `@tailwindcss/*`). For a 0.x package Dependabot counts 0.28 → 0.29 as a minor update, although it may break the API. Open ranges (Playwright 1.5x, `argon2` 0.41+) have no rule. **When `tech-stack.md` moves a pinned line, change the matching `ignore` rule in the same pull request.** A new major or a new pinned minor is a tech-stack change made by hand, with its release notes read, never a Dependabot pull request.

Reviewing a Dependabot pull request: CI must be green; read the changelog of each grouped update; for actions, the comment must still end with the new tag. Dependabot security updates are a separate repository setting (human steps below).

Known gap: in `deploy.yml` the `pnpm/action-setup` comment has text after the tag (`# v4.3.0; pnpm version from package.json`), so `check-package-json.mjs` warns and Dependabot will move that SHA without updating the tag. Agents do not change `deploy.yml`; the developer moves the note to its own comment line above the step.

## Human steps (the developer)

- **Protect `main`** (Settings → Branches, or Rules → Rulesets): require a pull request with one approval, require the status checks **Plan lint**, **Deploy files** and **Build and test** to pass, allow squash merging only, require linear history, and block force pushes. Record it in the X-019 pull request ([ADR-0020](../../docs/mvp/adr/0020-ai-agent-development-workflow.md); [roadmap](../../docs/mvp/plans/roadmap.md) M0 human steps).
- Turn on Dependabot alerts and security updates, and secret scanning with push protection, in the repository's security settings.
- After the first merge, re-run the CI of a commit on `main` and check its log for Turborepo cache hits.
