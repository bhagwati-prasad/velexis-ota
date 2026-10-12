# ADR-0023: Release artefact and deploy user

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform/DevOps engineer (foundation plan). Decided during planning; revisit when a second app VM, zero-downtime deploys or a container platform are needed.

## Context

[ADR-0007](0007-single-vm-without-docker.md) fixes the shape of a deploy:

- GitHub Actions builds and packs on a manual dispatch, then uploads with `rsync` over SSH to `/srv/velexis/releases/<sha>/`;
- `deploy.sh` migrates, switches the `current` symlink, restarts the units with health checks, and rolls back;
- releases are owned by `velexis` and read-only, and every app runs as the one `velexis` user.

It leaves open what exactly is in a release, which SSH user uploads it, how that user gets just enough root to restart units, and how the shared OS user is kept from reading every other app's secrets.

## Decision

### Release folder

- Built on `ubuntu-24.04` with Node 22 (the VM's OS and Node major, so native modules match) by [`deploy/scripts/pack-release.sh`](../../../deploy/scripts/pack-release.sh). It has one folder per part, and **parts that do not exist yet are skipped**, so the same pipeline ships the M0 hello world and the full system.
- **Backends and tools:** `pnpm deploy --prod`.
- **Next.js apps:** the `standalone` output with `outputFileTracingRoot` set to the repository root. The entry is `<app path>/server.js`, and `.next/cache` is a symlink to the unit's systemd `CacheDirectory`, so the release stays read-only.
- **Storefront:** its static `dist/`.
- **Also included:** the migrations, the migration and reference-data CLIs, and a copy of `deploy/`.
- `RELEASE.json` (sha, ref, build time, Node version, apps) and `SHA256SUMS` describe the folder. `velexis-deploy` verifies both and refuses a Node major that differs from the VM's.

### Users and privilege

- A separate **`deploy`** user receives the upload. It logs in with a key only, with the `restrict` option, and writes only to `/srv/velexis/incoming/<sha>/`.
- Its only root right is one sudo rule: `deploy ALL=(root) NOPASSWD: /usr/local/sbin/velexis-deploy`. The script validates its single argument (a hex sha, `--rollback` or `--status`).
- **Root runs only root-owned code.**
  - `velexis-deploy`, `velexis-backup`, `velexis-restore` and `velexis-alert` are copies in `/usr/local/sbin`. `provision-vm.sh` installs them first.
  - Each deploy re-installs them, together with the systemd units, the maintenance page and the Caddyfile, from the uploaded folder **before** that folder is moved to `releases/` and handed to `velexis`. Re-deploying a release already on the VM re-installs none of them.
  - The app user can therefore never change a script, unit or Caddyfile that root will use.
- **Migrations** run as `velexis` with the `velexis_migrator` DSN. The DSN comes from `/etc/velexis/migrator.env`, which is root-only and read by `velexis-deploy`; no unit can read it.

### Secrets per process, although one OS user

- Each app has its own env file, `/etc/velexis/<app>.env`. Worker-only overlays exist: `ota-worker.env` holds the migrator DSN that provisioning needs.
- Every unit hides the other apps' env files and keys with `InaccessiblePaths=`. The Next.js units cannot see `/etc/velexis/keys` at all.
- This narrows what a compromised process can read, without the cost of seven OS users. ADR-0007's follow-up on separate users still stands.

### Caddy and static content

- The Caddyfile takes its base domains from `/etc/velexis/caddy.env`, with the placeholder hosts of [`decisions.md`](../decisions.md) §4 as defaults. The repository never holds real host names.
- A static maintenance page lives **outside** the releases, in `/srv/velexis/maintenance/`. Caddy serves it on 502, 503 and 504 for the Next.js hosts, and it is the M0 hello-world page. The API hosts answer a JSON `SERVICE_UNAVAILABLE` envelope instead.
- Storefront files are world-readable so that Caddy (user `caddy`) can serve them. The rest of a release is not.

## Consequences

### Positive

- A deploy is reproducible and verifiable: the same bytes that CI built and checksummed run on the VM.
- Day to day, the GitHub deploy key can only upload releases and trigger the one deploy command (see the negative consequence on what a malicious release could do).
- Rollback is a symlink switch to a folder that is already on disk.

### Negative

- Changes to `deploy.sh` take effect from the **next** deploy, because the running copy installs the new one. Urgent fixes use `provision-vm.sh --steps scripts`.
- A release is self-contained, with its own `node_modules` per app. That is about 300–600 MB per release, five releases kept.
- **The deploy key is root-equivalent by design.** A release can update `velexis-deploy` itself and the systemd units, so whoever can upload a release can get root on the next deploy. The controls are the GitHub `production` environment (required reviewer: the developer, secrets only there), the `restrict` key option, and `auditd` on `/usr/local/sbin` and `/etc/systemd/system`. The single sudo rule limits accidents and stray commands, not a stolen deploy key.

### Follow-ups

- X-023 finalises the packer, `velexis-deploy` and the workflow, with a local test harness that runs `deploy.sh` against a temporary root and a fake `systemctl`.

## Alternatives considered

- **Build on the VM** (`git pull && pnpm build`). Needs build tools, the source and network access on the production host, and uses the VM's memory during builds.
- **Upload as `velexis`, or give `deploy` broad sudo.** Either gives the CI key, or the app user, a path to root.
- **One tarball instead of a folder.** Slightly simpler upload, but `rsync` of a folder resumes and shows exactly what changed.
- **Per-app OS users now.** Stronger isolation, but seven users, group-shared key files and more complex permissions for one developer. It is deferred to the M6 security review (ADR-0007).

## References

- [ADR-0007](0007-single-vm-without-docker.md), [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0018](0018-hosted-storefront-custom-domains.md), [ADR-0020](0020-ai-agent-development-workflow.md)
- [`../deployment-single-vm.md`](../deployment-single-vm.md) §4, §8; [`../../../deploy/README.md`](../../../deploy/README.md)
