# ADR-0023: Release artefact and deploy user

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform/DevOps engineer (foundation plan). Decided during planning; revisit when a second app VM, zero-downtime deploys or a container platform are needed.
**Revisions:** 2026-10-12 (planning review): build and deploy are separate jobs and the deploy job never runs build code; releases are root-owned; rollback re-installs the target release's units and Caddyfile; env drift is refused; one OS user per trust zone ([ADR-0026](0026-system-users-per-trust-zone.md)) replaces the shared user, and the text says what `InaccessiblePaths=` does and does not protect.

## Context

[ADR-0007](0007-single-vm-without-docker.md) fixes the shape of a deploy: GitHub Actions builds and packs on a manual dispatch and uploads the release with `rsync` over SSH; `deploy.sh` migrates, switches the `current` symlink, restarts the units with health checks, and rolls back. (Its first version uploaded straight to `releases/<sha>/` and ran every app as one `velexis` user; the decision below and [ADR-0026](0026-system-users-per-trust-zone.md) replaced both.)

It leaves open what exactly is in a release, which SSH user uploads it and where, how that user gets just enough root to restart units, how the build is kept away from the deploy key, and how one app is kept from reading every other app's secrets.

## Decision

### Release folder

- Built on `ubuntu-24.04` with Node 22 (the VM's OS and Node major, so native modules match) by [`deploy/scripts/pack-release.sh`](../../../deploy/scripts/pack-release.sh). It has one folder per part, and **parts that do not exist yet are skipped**, so the same pipeline ships the M0 hello world and the full system.
- **Backends and tools:** `pnpm deploy --prod`.
- **Next.js apps:** the `standalone` output with `outputFileTracingRoot` set to the repository root. The entry is `<app path>/server.js`, and `.next/cache` is a symlink to the unit's systemd `CacheDirectory`, so the release stays read-only.
- **Storefront:** its static `dist/`.
- **Also included:** the migrations, the migration and reference-data CLIs, and a copy of `deploy/`.
- `RELEASE.json` (sha, ref, build time, Node version, apps) and `SHA256SUMS` describe the folder. `velexis-deploy` verifies both and refuses a Node major that differs from the VM's.
- `velexis-deploy` also refuses a release whose `deploy/env/*.env.example` templates name a variable that the matching `/etc/velexis/<app>.env` lacks (an empty value is fine), before it changes anything. A task that adds a variable therefore comes with a human step: add it on the VM before deploying ([`plans/roadmap.md`](../plans/roadmap.md) §2).

### Build and deploy jobs

- `deploy.yml` has two jobs. **build** has no secrets and no environment: install, lint, typecheck, unit tests (always; there is no "skip tests" input), build, `pack-release.sh`, then it uploads the release as one tarball artefact and publishes the tarball's SHA-256 as a job output. **deploy** runs in the GitHub `production` environment (the developer's approval, the SSH secrets): it only downloads the tarball, re-checks its SHA-256 and `SHA256SUMS`, and runs `rsync` and `ssh`. No dependency or build code ever runs in the job that holds the deploy key.
- Only `main` and release tags (`v*`) deploy: the workflow refuses other refs, and the `production` environment has a deployment branch policy for `main` and `v*` tags (human step of X-023).
- Every third-party action is pinned to a full commit SHA, with the tag in a comment; Dependabot proposes updates (X-019).
- Dependency install scripts run only for the packages in `pnpm.onlyBuiltDependencies` of the root `package.json` (empty at M0; a task that adds a dependency whose install script is needed adds it there with a reason).

### Users and privilege

- A separate **`deploy`** user receives the upload. It logs in with a key only, with the `restrict` option, and writes only to `/srv/velexis/incoming/<sha>/`.
- Its only root right is one sudo rule: `deploy ALL=(root) NOPASSWD: /usr/local/sbin/velexis-deploy`. The script validates its single argument (a hex sha, `--rollback` or `--status`).
- **Root runs only root-owned code.**
  - `velexis-deploy`, `velexis-backup`, `velexis-restore` and `velexis-alert` are copies in `/usr/local/sbin`. `provision-vm.sh` installs them first.
  - Each deploy re-installs them from the uploaded folder **before** that folder is moved to `releases/`. The systemd units, the maintenance page and the Caddyfile are first copied to a root-owned snapshot, `/var/lib/velexis/system/<sha>/`, and installed from there.
  - **Rollback** (automatic or `--rollback`) re-installs the target release's units, drop-in, maintenance page and Caddyfile from its snapshot (validated, `daemon-reload`, Caddy reloaded once the units are healthy) before restarting, so an old release never runs under newer unit files or a newer payment-page CSP. Re-deploying a release that is already on the VM does the same. The root-owned scripts stay at their newest version, which is kept backward compatible.
  - Neither the `deploy` user nor an app user can change a script, unit, snapshot or Caddyfile that root will use.
- Releases are owned by `root:velexis` and read-only (`u=rX,g=rX,o=`; no secrets inside). Every app user is a member of the `velexis` group, which grants nothing else, so the apps can read but never change a release.
- **Migrations** run with the `velexis_migrator` DSN, which comes from `/etc/velexis/migrator.env`, root-only and read by `velexis-deploy`; no unit can read it.

### Secrets per process

- Each app has its own env file, `/etc/velexis/<app>.env` (`root:root 0600`, read by systemd before it starts the unit). Worker-only overlays exist: `ota-worker.env` holds the provisioner DSN ([ADR-0004](0004-postgresql-schema-per-tenant.md)).
- **The real boundary is the OS user.** Every trust zone runs as its own system user ([ADR-0026](0026-system-users-per-trust-zone.md), task X-033): a process cannot read another user's `/proc/<pid>/environ`, cannot reach another process's files through `/proc/<pid>/root`, and with `ProtectProc=invisible` cannot even see the other zones' processes. Key files sit in per-zone folders owned by the zone's user.
- `InaccessiblePaths=` is **defence in depth only**. It hides the other apps' env files and key folders from a unit's own mount namespace, but it does not stop a process from reading what another process of the **same user** holds in memory or in its environment (through `/proc`), and it does nothing against root. Before ADR-0026, when every app ran as `velexis`, it therefore did not keep the internet-facing Next.js apps away from the OTA API's secrets.

### Caddy and static content

- The Caddyfile takes its base domains from `/etc/velexis/caddy.env`, with the placeholder hosts of [`decisions.md`](../decisions.md) §4 as defaults. The repository never holds real host names.
- A static maintenance page lives **outside** the releases, in `/srv/velexis/maintenance/`. Caddy serves it on 502, 503 and 504 for the Next.js hosts, and it is the M0 hello-world page. The API hosts answer a JSON `SERVICE_UNAVAILABLE` envelope instead.
- Storefront files are world-readable so that Caddy (user `caddy`) can serve them. The rest of a release is readable by the `velexis` group only.

## Consequences

### Positive

- A deploy is reproducible and verifiable: the same bytes that CI built and checksummed run on the VM.
- Day to day, the GitHub deploy key can only upload releases and trigger the one deploy command (see the negative consequence on what a malicious release could do), and no build or dependency code runs where that key is.
- Rollback switches to a folder that is already on disk and restores the unit files and Caddyfile that release was tested with.
- A missing variable on the VM stops a deploy before anything changes, instead of failing config validation and rolling back.

### Negative

- Changes to `deploy.sh` take effect from the **next** deploy, because the running copy installs the new one. Urgent fixes use `provision-vm.sh --steps scripts`.
- A release is self-contained, with its own `node_modules` per app. That is about 300–600 MB per release, five releases kept.
- **The deploy key is root-equivalent by design.** A release can update `velexis-deploy` itself and the systemd units, so whoever can upload a release can get root on the next deploy. The controls are the separate deploy job (no build code next to the key), the GitHub `production` environment (required reviewer: the developer, branch policy, secrets only there), actions pinned by SHA, the `restrict` key option, and `auditd` on `/usr/local/sbin` and `/etc/systemd/system`. The single sudo rule limits accidents and stray commands, not a stolen deploy key. The deploy pipeline is therefore in PCI scope ([ADR-0027](0027-pci-scope-and-vm-controls.md)).
- Snapshots of five releases' units and Caddyfiles live in `/var/lib/velexis/system/`; they are pruned with the releases.

### Follow-ups

- X-023 finalises the packer, `velexis-deploy` and the workflow, with a local test harness that runs `deploy.sh` against a temporary root and a fake `systemctl` (including rollback with snapshots and the env drift refusal).
- X-033 (M0) creates the per-zone users, folders and ownership.

## Alternatives considered

- **Build on the VM** (`git pull && pnpm build`). Needs build tools, the source and network access on the production host, and uses the VM's memory during builds.
- **Upload as an app user, or give `deploy` broad sudo.** Either gives the CI key, or an app user, a path to root.
- **One job that builds and deploys.** Simpler, but every dependency's install and build script would run next to the root-equivalent key and could change the release before upload.
- **One tarball instead of a folder.** Slightly simpler upload, but `rsync` of a folder resumes and shows exactly what changed.
- **One shared OS user with `InaccessiblePaths=` only** (this ADR's first version). Rejected in the planning review: same-user processes can read each other's environment and files through `/proc`, so it protected nothing against a compromised Next.js app. See [ADR-0026](0026-system-users-per-trust-zone.md).

## References

- [ADR-0007](0007-single-vm-without-docker.md), [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0018](0018-hosted-storefront-custom-domains.md), [ADR-0020](0020-ai-agent-development-workflow.md)
- [`../deployment-single-vm.md`](../deployment-single-vm.md) §4, §8; [`../../../deploy/README.md`](../../../deploy/README.md)
