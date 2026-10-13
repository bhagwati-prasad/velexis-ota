# ADR-0027: PCI DSS scope and controls on the single VM

**Status:** Accepted
**Date:** 2026-10-12
**Deciders:** Product owner (airline card through Amadeus, single VM), security reviewer and Platform/DevOps engineer (planning review). Decided during planning; revisit when the card path moves to a vault or forwarding service ([ADR-0011](0011-payments-stripe-and-airline-card.md) follow-up), when the card path gets its own segmented host, or when Velexis passes the level-1 service-provider threshold.

## Context

The airline-card method of [`decisions.md`](../decisions.md) §2 puts card numbers in transit through the OTA backend, so Velexis is a PCI DSS v4.0.1 service provider and completes SAQ D for Service Providers ([ADR-0011](0011-payments-stripe-and-airline-card.md) §C). The first version of ADR-0011 called the VM the cardholder data environment (CDE) but described the controls as if they applied to "one endpoint and one page". A planning review found:

- There is no segmentation on the VM, so **every component on it** is in scope, and so are the systems that can change it: the GitHub deploy job (its key is root-equivalent, [ADR-0023](0023-release-artefact-and-deploy-user.md)), the developer's SSH path and the backup bucket.
- Several applicable requirements had no control and no task: MFA for non-console administrative access (8.4.2), 12-month audit-log retention with three months online and daily review (10.4.1, 10.5.1), automated protection of public-facing web applications (6.4.2), and recurring scans and penetration tests (11.3, 11.4).
- Caddy's admin API listened on `localhost:2019`, so any app process could rewrite the live configuration, including the payment-page CSP, without touching a file that AIDE watches.

## Decision

1. **Scope.** The CDE is the whole VM: Caddy (with its admin endpoint), the OTA API and worker, the platform API and worker, the portal, the platform admin, the OTA admin, PostgreSQL, Redis and the storefront files. Connected and security-impacting systems are in scope as well: the GitHub repository and Actions (build and deploy jobs, the `production` environment), the developer's workstation and SSH path, the off-site backup bucket, and the cloud, DNS and SMTP provider accounts. Third parties (Amadeus, Stripe, the cloud provider) are managed as service providers in the responsibility matrix (OBE-085).
2. **Controls.** Each applicable requirement has a control and an owning task. Live airline-card payments stay off (`AIRLINE_CARD_ENABLED=false`) until every row is done and OBE-086 is fully checked.

   | PCI DSS v4.0.1 | Control | Owner |
   |---|---|---|
   | 1, 2.2 | `ufw` allows only 22, 80, 443; every service on loopback; hardening checklist; `check-vm.sh` | X-020 |
   | 1.4, 2.2 | Caddy's admin API only on the unix socket `/run/caddy/admin.sock` in a `0700` directory of the `caddy` user, never on TCP; `systemctl reload caddy` uses it | `deploy/caddy/Caddyfile` (done in planning), verified by X-022 |
   | 3 | Card data never stored, queued, cached or logged; redaction before persistence; database CHECK; PAN-absence scan in CI | OBE-050 … OBE-052, X-003 |
   | 4 | TLS 1.2+ and HSTS on every public host; HTTPS to Amadeus | X-022 |
   | 5.2.3 | Documented evaluation that the VM is not commonly targeted by malware, reviewed yearly; AIDE and auditd as detective controls | OBE-085, X-020 |
   | 6.3.3 | `unattended-upgrades`; weekly Dependabot; `pnpm audit` in the launch checklists | X-019, PBE-065, OBE-089 |
   | 6.4.2 | Web application firewall: Caddy built with Coraza and the OWASP Core Rule Set, in front of every public host; detection first, then blocking on the storefront `/api/*`, the payment pages and `api.ota.example.com` | X-039 |
   | 6.4.3, 11.6.1 | Payment-page inventory with the SHA-256 of every first-party script and the expected headers; daily check of both payment pages, script contents and per-path CSP | OFE-023, X-030 |
   | 6.5 | Change control of the CDE: build job without secrets, deploy job behind the `production` environment (developer approval, `main` and `v*` tags only), actions pinned by commit SHA, dependency install scripts only on an allow-list; rollback restores the release's own units and CSP | X-023 ([ADR-0023](0023-release-artefact-and-deploy-user.md)) |
   | 7 | One system user per trust zone; per-zone key folders; env files readable by root only ([ADR-0026](0026-system-users-per-trust-zone.md)). Database roles per responsibility, the OTA role without secret columns, the provisioner without platform rights ([ADR-0004](0004-postgresql-schema-per-tenant.md)) | X-033, X-012, X-013 |
   | 8.4.2, 8.4.3 | MFA for every person who administers the CDE: SSH with a FIDO2 key (`sk-ssh-ed25519` with `verify-required`) or key plus TOTP for the admin user; MFA on GitHub, the cloud console, DNS, the backup bucket and the SMTP account | X-037; account settings in [`plans/roadmap.md`](../plans/roadmap.md) §4.1 |
   | 8.6 | The `deploy` user is a system account: restricted key, no shell features, one sudo command, used only by the deploy job | X-020, X-023 |
   | 10.2, 10.3, 10.6 | `auditd` rules on keys, env files, units, sudoers, sshd and `/usr/local/sbin`; `chrony` time sync | X-020 |
   | 10.4.1, 10.4.1.1, 10.5.1, 10.7 | Security logs (auditd, sshd, sudo, Caddy access and WAF logs, app security events) kept 3 months on the VM and shipped hourly off the VM to an object-locked bucket with 12-month retention; a daily automated review e-mails a summary and alerts at once on critical events and on a failed shipment | X-038 |
   | 11.3.1, 11.3.2 | Quarterly internal vulnerability scans and quarterly external ASV scans, plus after significant changes | Calendar in `ota/docs/pci/README.md` (OBE-085) |
   | 11.4.1 … 11.4.3 | Penetration test before live airline-card payments, then yearly and after significant changes | OBE-086; calendar in OBE-085 |
   | 11.5 | File-integrity monitoring (AIDE, daily); intrusion detection through auditd, fail2ban, the WAF and the daily log review | X-020, X-038, X-039 |
   | 12 | Policies, incident response plan, responsibility matrix with OTAs and service providers, yearly scope confirmation; the matrix references the rows above | OBE-085 |
   | 12.10.1 (recovery; backups hold no card data) | Backups encrypted to off-VM keys; the bucket has object lock and lifecycle rules, and the VM's key cannot delete; a restore drill that cannot reach live Amadeus or Stripe | X-024, X-031 |

3. **The card path stays as narrow as ADR-0011 describes**, so that the data-handling controls (rows 3, 6.4.3) stay small. The environment controls above apply to the whole VM regardless.

## Consequences

### Positive

- Every applicable requirement has a named control and a task, so the evidence pack (OBE-085) can point at code and records instead of intentions.
- Hardening such as SSH MFA, off-VM logs and the WAF protects the platform and the OTA data as well, not only cards.
- The launch rule of [ADR-0025](0025-roadmap-scheduling-and-tracking.md) holds: until the controls are done, the airline card stays off and Stripe keeps working.

### Negative

- More recurring work for one developer: quarterly scans, yearly tests, daily review alerts to act on, WAF tuning.
- A custom Caddy build (Coraza module) replaces the plain apt binary, and its rules need exceptions for legitimate traffic.
- Three months of security logs on the VM need disk space (estimated well below 5 GB; X-038 measures it).

### Follow-ups

- X-037, X-038, X-039 (M6) and X-033 (M0) are new foundation tasks; OBE-085 records the calendar and references this ADR.
- If the card path moves to a vault or forwarding service, most of this scope goes away; record that in a new ADR that supersedes this one.

## Alternatives considered

- **Segment the card path onto its own host now.** Smaller scope, but a second host doubles operations for one developer before any live card volume exists. Revisit with the vault follow-up.
- **A documented compensating control instead of a WAF.** Possible under PCI DSS, but it needs a formal analysis and yearly re-validation, and the WAF is a contained change in Caddy.
- **Keep logs only in journald for 30 days.** Fails 10.5.1 and loses evidence if the VM is lost or compromised.
- **Caddy admin API off (`admin off`) with restart-based reloads.** Also safe, but restarts drop connections; the unix socket keeps graceful reloads.

## References

- [`../decisions.md`](../decisions.md) §2, §5
- [ADR-0011](0011-payments-stripe-and-airline-card.md) §C, [ADR-0016](0016-observability.md), [ADR-0018](0018-hosted-storefront-custom-domains.md), [ADR-0023](0023-release-artefact-and-deploy-user.md), [ADR-0026](0026-system-users-per-trust-zone.md)
- [`../deployment-single-vm.md`](../deployment-single-vm.md) §2, §6, §10, §12; [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md)
- [OADR-0004](../../../ota/docs/adr/0004-airline-card-data-handling.md), [OADR-0017](../../../ota/docs/adr/0017-airline-card-form-isolation.md)
- PCI DSS v4.0.1 and the SAQ D for Service Providers
