# ADR-0026: System users per trust zone

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Platform/DevOps engineer and security reviewer (planning review). Decided during planning; revisit when the M6 security reviews (PBE-062, OBE-084) ask for one user per unit, or when the apps move to separate hosts.

## Context

[ADR-0007](0007-single-vm-without-docker.md) and the first version of [ADR-0023](0023-release-artefact-and-deploy-user.md) ran all seven app units as one system user, `velexis`, and hid each app's env file and keys from the others with `InaccessiblePaths=`. A planning review showed that this protects much less than the documents claimed:

- Processes of the same user can read each other's `/proc/<pid>/environ`. `ProtectProc=invisible` hides only **other users'** processes. The internet-facing portal, platform admin or OTA admin could read the OTA API's environment: live Stripe keys, webhook secrets, the edge secret, the service key, the database and Redis passwords.
- The same process could open `/proc/<pid>/root/etc/velexis/keys/master-v1.key` of a backend process, which sees the key in its own mount namespace, and the OTA worker's privileged database DSN.
- Every Next.js app was therefore inside the PCI cardholder data environment with full access to card-path secrets ([ADR-0011](0011-payments-stripe-and-airline-card.md) §C).

[`decisions.md`](../decisions.md) §5 asks for a master key "readable only by the service user". The fix must stay simple for one developer on one VM and must keep the rule of [X-002](../plans/foundation-tasks.md) that a key file readable by group or others is refused.

## Decision

1. **One system user per trust zone**, each with no login shell:

   | User | Units | Reads |
   |---|---|---|
   | `velexis-platform` | `velexis-platform-api`, `velexis-platform-worker` | `/etc/velexis/keys/platform/` |
   | `velexis-ota` | `velexis-ota-api`, `velexis-ota-worker` | `/etc/velexis/keys/ota/`; writes `/var/lib/velexis/storage/` |
   | `velexis-portal` | `velexis-portal` | no keys |
   | `velexis-platform-admin` | `velexis-platform-admin` | no keys |
   | `velexis-ota-admin` | `velexis-ota-admin` | no keys |

   An API and its worker share a user because they are one codebase with one trust level, the same keys and one storage folder. The OTA worker's extra privilege (the provisioner DSN) stays inside the OTA zone, and the provisioner role can touch only tenant schemas ([ADR-0004](0004-postgresql-schema-per-tenant.md)).
2. **Keys per zone.** Each backend zone has its own key folder, `0500` owned by the zone's user, files `0400`. Keys both backends need (`master-v<N>.key`, `api-key-pepper`) are generated once by `provision-vm.sh` and installed as identical copies in both folders ([ADR-0010](0010-secrets-envelope-encryption.md)). `MASTER_KEY_DIR` and the `*_FILE` variables point at the zone's folder.
3. **Env files are read by systemd only.** `/etc/velexis/<app>.env` become `root:root 0600`. systemd reads `EnvironmentFile=` as root before it starts the unit as the zone's user, so no app user can open any env file.
4. **Releases** are `root:velexis`, read-only. `velexis` becomes a group whose only purpose is reading releases; every app user is a member. The storefront folder stays world-readable for Caddy.
5. **`ProtectProc=invisible`** stays on every unit, so a process does not even see the other zones' processes. **`InaccessiblePaths=`** stays as defence in depth for the other zones' folders, not as the boundary.
6. **One-off commands** that need a zone's environment (for example `admin:grant`) run through a root-owned wrapper, `velexis-run <zone> <command>`, which starts them with `systemd-run` as the zone's user with the zone's env files and sandbox.
7. **Built in M0** by task X-033, before the VM is provisioned (X-020) and the first release is deployed (X-023), so the VM never runs the shared-user layout.

## Consequences

### Positive

- A compromised Next.js app cannot read any key, env file or backend memory. A compromised platform process cannot read the OTA zone's secrets, and the reverse.
- The PCI story becomes honest: the Next.js apps and the platform are still on the CDE host, but they no longer hold card-path secrets ([ADR-0027](0027-pci-scope-and-vm-controls.md)).
- The X-002 rule "key files are `0400` and owned by the reader" still holds, with no group-readable key.

### Negative

- Five users instead of one, and two copies of the shared keys that rotation must keep identical (the runbook of X-040 installs both).
- A root or kernel compromise still exposes everything; this is the limit of one VM.
- Within a zone, the API can still read its worker's environment, including the provisioner DSN. That is accepted because both belong to the same zone and the provisioner role is limited to tenant schemas.

### Follow-ups

- X-033 changes `provision-vm.sh`, the unit files, `deploy.sh` (release ownership), the env file modes and adds `velexis-run`. X-020, X-021 and X-023 test the result.
- The M6 security reviews decide whether to go further (one user per unit, or `DynamicUser=` with `LoadCredential=`).

## Alternatives considered

- **Keep one user, rely on `InaccessiblePaths=`.** Rejected: same-user processes read each other through `/proc`.
- **One user per unit (seven users).** Stronger, but the API and worker of a backend would need group-shared keys and storage, which conflicts with the `0400` key rule and doubles the permission work. Revisit after the M6 reviews.
- **`DynamicUser=` with `LoadCredential=`.** Clean for keys, but dynamic users complicate the storage folder and the CLI wrapper, and every key path changes. Kept as the next step.
- **Group-readable shared key files.** Fewer copies, but it breaks the "readable only by the service user" rule of `decisions.md` §5 and the X-002 check.

## References

- [`../decisions.md`](../decisions.md) §2, §5
- [ADR-0004](0004-postgresql-schema-per-tenant.md), [ADR-0007](0007-single-vm-without-docker.md), [ADR-0010](0010-secrets-envelope-encryption.md), [ADR-0011](0011-payments-stripe-and-airline-card.md), [ADR-0023](0023-release-artefact-and-deploy-user.md), [ADR-0027](0027-pci-scope-and-vm-controls.md)
- [`../deployment-single-vm.md`](../deployment-single-vm.md) §4 and §7; [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) (X-033)
- `proc(5)` (`/proc/<pid>/environ` and `/proc/<pid>/root` access checks), `systemd.exec(5)` (`ProtectProc=`, `InaccessiblePaths=`, `EnvironmentFile=`)
