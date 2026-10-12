# ADR-0007: Single VM without Docker

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (single VM, no Docker, systemd, Caddy, nightly off-VM backups), lead architect (layout, deploy and backup details)

## Context

[`decisions.md`](../decisions.md) §2 and §5 put everything on one VM without Docker: Ubuntu LTS with Node.js, PostgreSQL 16, Redis and Caddy installed natively, apps as systemd services, and nightly backups copied off the VM. Managed services come later, and moving to them must be a configuration change only (DSNs, URLs, storage adapters). One developer operates it.

## Decision

### Host

- **Ubuntu 24.04 LTS**, starting size 4 vCPU, 8 GB RAM and 160 GB SSD. Resize when memory use stays above 70 %.
- Native packages from the vendors' apt repositories: **Node.js 22 LTS** (NodeSource), **PostgreSQL 16** (PGDG), **Redis 7** (packages.redis.io), **Caddy 2.8** (Caddy's repository). Versions in [`../tech-stack.md`](../tech-stack.md).
- PostgreSQL and Redis listen on `127.0.0.1` only. Redis requires a password and runs with `maxmemory-policy noeviction` and AOF `appendfsync everysec` ([ADR-0009](0009-background-jobs-bullmq.md)).
- Firewall (`ufw`): allow 22 (SSH, keys only, from the developer's addresses where possible), 80 and 443. Everything else is closed. `unattended-upgrades` for security patches, `fail2ban` for SSH.

### Users and directories

| Path | Owner and mode | Content |
|---|---|---|
| `/srv/velexis/releases/<git-sha>/` | `velexis`, read-only after deploy | One self-contained folder per app built in CI (`pnpm deploy --prod` for backends, Next.js `standalone` output, static storefront files) |
| `/srv/velexis/current` | symlink | Points at the active release |
| `/etc/velexis/<app>.env` | `root:velexis` `0640` | Environment files loaded by systemd `EnvironmentFile=` |
| `/etc/velexis/keys/` | `velexis` `0400` per file | Master key, JWT signing keys, API key pepper ([ADR-0010](0010-secrets-envelope-encryption.md)) |
| `/var/lib/velexis/storage/` | `velexis` `0700` | Local file storage: documents, exports ([ADR-0017](0017-email-documents-storage.md)) |
| `/var/backups/velexis/` | `root` `0700` | Encrypted backups before upload |

All apps run as **one system user, `velexis`**, with no login shell. Decided during planning; revisit when an app needs stronger isolation from the others (for example, the airline-card path after the M6 security review).

### systemd units

| Unit | Runs | Port (127.0.0.1) |
|---|---|---|
| `velexis-platform-api.service` | `platform/backend` `dist/main.js` | 3100 |
| `velexis-platform-worker.service` | `platform/backend` `dist/worker.js` | 3101 (health only) |
| `velexis-portal.service` | `platform/frontend` standalone server | 3000 |
| `velexis-platform-admin.service` | `platform/admin` standalone server | 3001 |
| `velexis-ota-api.service` | `ota/backend` `dist/main.js` | 4000 |
| `velexis-ota-worker.service` | `ota/backend` `dist/worker.js` | 4001 (health only) |
| `velexis-ota-admin.service` | `ota/admin` standalone server | 3002 |

Every unit uses `Restart=always`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `ReadWritePaths=` limited to what it needs, and a `MemoryMax=`. Logs go to journald ([ADR-0016](0016-observability.md)). The storefront has no process: Caddy serves its files. Unit files and the `Caddyfile` live in `deploy/`.

### Deploy

1. GitHub Actions builds, tests and packs every app on the commit (`deploy.yml`, manual `workflow_dispatch` in the MVP).
2. It uploads the release folder over SSH (`rsync`) to `/srv/velexis/releases/<sha>/`.
3. `deploy/scripts/deploy.sh` on the VM:
   - runs platform and reference migrations, then the tenant fan-out (expand-phase files only);
   - switches `current` to the new release;
   - restarts units one at a time (workers first, then APIs, then front ends);
   - polls each `/health/ready` and switches `current` back and restarts if one fails.
4. The last five releases are kept for rollback.

There is a short interruption while each process restarts. That is accepted in the MVP.

### Backups

- **Nightly** (`velexis-backup.timer`, 02:30 UTC):
  - `pg_dump --format=custom` of the whole `velexis` database;
  - a tar of `/var/lib/velexis/storage`;
  - each encrypted with `age` to a public key whose private key is kept off the VM;
  - uploaded with `rclone` to an S3-compatible bucket at another provider.
- Retention: 14 daily and 6 monthly copies.
- `/etc/velexis` (including the master key) is backed up **separately**, encrypted to a different `age` key, so one stolen backup never holds both the data and its key.
- A restore drill on a scratch VM is part of M6 and is repeated quarterly.

### Local development and CI

- Developers install PostgreSQL 16, Redis 7 and Mailpit natively. `deploy/scripts/dev-setup.sh` creates the roles and databases.
- CI (GitHub Actions) may use the runners' service containers for PostgreSQL and Redis. "No Docker" applies to the hosting VM, not to CI infrastructure.

### Moving to managed services later

- Database, Redis, SMTP and object storage are reached only through DSNs and URLs in the environment files, plus the `StorageAdapter` interface. No code assumes `localhost`.

## Consequences

### Positive

- Cheap, simple and fully understood by one person. No container layer to debug.
- Same software versions on the VM, in development and in CI.

### Negative

- **Single point of failure.** VM, disk or provider outages take everything down. RTO is hours: rebuild the VM from the scripts and restore the backup.
- **RPO is up to 24 hours** with nightly dumps. Bookings created after the last dump can only be rebuilt from Amadeus and Stripe records.
- Restarts cause brief errors. There is no zero-downtime deploy.
- All apps share one OS user, so a compromise of one process can read the others' keys.

### Follow-ups

- Decided during planning; revisit before significant live booking volume: add continuous WAL archiving (pgBackRest) for point-in-time recovery (target RPO 5 minutes), and consider a managed PostgreSQL first, as `decisions.md` §2 anticipates.
- `deploy/scripts/provision-vm.sh` must recreate the VM from a blank Ubuntu image (M0), so rebuilds are scripted, not remembered.

## Alternatives considered

- **Docker Compose on the VM.** Rejected by the product owner.
- **PaaS (Render, Fly, Railway).** Less control over on-demand TLS for custom domains, and higher cost per component for seven processes.
- **Kubernetes.** Far beyond what a solo MVP needs.
- **PM2 instead of systemd.** systemd is already on the host, integrates with journald and offers sandboxing.

## References

- [`../decisions.md`](../decisions.md) §2, §5
- [`../architecture.md`](../architecture.md) (deployment view, failure domains)
- [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0016](0016-observability.md), [ADR-0018](0018-hosted-storefront-custom-domains.md)
- [`../../velexis-sdk/db/README.md`](../../velexis-sdk/db/README.md) §7 (backup design this simplifies)
