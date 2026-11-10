# PCI evidence: incident response plan

The plan for a suspected or confirmed security incident that touches card data or the cardholder data environment: the whole VM and the systems that can change it ([ADR-0027](../../../docs/mvp/adr/0027-pci-scope-and-vm-controls.md) item 1). It is PCI DSS v4.0.1 requirement **12.10.1** for Velexis as a service provider, and it is part of the [PCI evidence pack](README.md). The operational first checks of the VM are in [deployment-single-vm.md §16](../../../docs/mvp/deployment-single-vm.md#16-incident-quick-reference); this plan is what happens when one of them, or anything else, points at a compromise.

References follow the convention of [`data-flow.md`](data-flow.md): a link named `file:line` and, after it, a piece of that line in code style.

## 1. Roles and contacts

Personal contact details are never written into the repository. The table names each party and where its current contact is kept; the developer checks that every entry is reachable at each review of the pack ([README §6](README.md#6-review-record)).

| Role | Who | Where the contact is kept |
|---|---|---|
| **Incident lead**: decides containment, runs every technical step, keeps the incident record | The developer (the only person with administrative access to the VM) | — |
| **Communication**: approves every message to OTAs, providers and authorities | The product owner | The developer's password manager |
| **Velexis operations mailbox**: receives the health check's alerts, unit failures and the airline-card alerts | `ALERT_TO` of `velexis-alert` for the health check, units and backups ([`alert.env.example:12`](../../../deploy/env/alert.env.example#L12) `ALERT_TO=`) and `OPS_ALERT_EMAIL` of the OTA API for the airline-card alerts ([`ota-backend.env.example:35`](../../../deploy/env/ota-backend.env.example#L35) `OPS_ALERT_EMAIL=`); keep both on the same mailbox | `/etc/velexis/alert.env` and `/etc/velexis/ota-backend.env` on the VM |
| **The OTAs** (Velexis's customers): owners and admins of each affected OTA | The tenant's owner and admin accounts | The platform admin's tenant page, tab "members and invitations" (`/tenants/[tenantId]`) |
| **Amadeus**: receives the card in Flight Create Orders and passes it to the airline | Velexis's Amadeus Enterprise account manager and the support channel named in the contract | The contract; the developer's password manager |
| **Stripe**: method (a), the card page's Stripe.js, Velexis's Stripe account (and the OTAs' own accounts in Connect or API-key mode) | Stripe support from the Dashboard of Velexis's account; an OTA with its own account contacts Stripe itself | The Stripe Dashboard |
| **Infrastructure providers**: the cloud provider (VM, disk snapshots, console), the DNS provider, the SMTP provider, the off-site backup bucket's provider, GitHub | Their security or abuse contacts | Each provider's account page; the developer's password manager |
| **Forensic investigator** (a PCI Forensic Investigator if the card brands require one) | Chosen at the time, through Amadeus, the airlines or Stripe as their rules require | — |

**Availability (12.10.3).** Velexis has one person with administrative access. Alerts reach the operations mailbox at any time, and every containment step of §4.1 needs only SSH access to the VM. A second person who can at least turn the airline card off (§4.1 step 2) is not yet named; until one is, a time without the developer (holidays) is a time with `AIRLINE_CARD_ENABLED=false` in production. The developer records this choice at the review.

## 2. What counts as an incident, and how serious it is

| Severity | Examples | First response |
|---|---|---|
| **1: card data may be exposed** | A payment page alert nobody can explain by a deploy; card data found anywhere it must not be (12.10.7); a script, page or header on the storefront that is not in the inventory; signs of an intruder on the VM (an unknown SSH key or login, an AIDE change outside a deploy, a changed unit, Caddyfile or key file); a leaked deploy key, GitHub account or `production` environment; Amadeus, an airline, Stripe or an OTA reporting the storefront as a common point of purchase | Within the hour: §4.1, all steps |
| **2: an attack or a failed control, no sign of exposure** | A card-testing attack (the decline limits and the suspension firing); a burst of refused requests on the airline-card route; the health check, AIDE, auditd, fail2ban or the payment page check not running; a high or critical dependency advisory reaching the API or the storefront | The same day: §4.4, or fix the control; turn the airline card off if the cause is unclear |
| **3: a weakness without an attack** | A finding of a scan or the penetration test; a missing or wrong control found at a review | A task with a date in the plans; the [calendar](README.md#3-calendar) |

## 3. Detection (12.10.5)

| Source | What it sees | How it reaches the developer |
|---|---|---|
| The payment page check (X-030) | A script, the HTML or a header of a payment page that differs from the release's inventory ([`script-inventory.md`](script-inventory.md) §4) | E-mail `health check failed: payment page …` from `velexis-alert` |
| The on-VM health check (X-030) | A unit down, failed jobs, disk, Redis memory, the backup's age, certificate expiry | E-mail from `velexis-alert`, once per change |
| systemd | A unit that gives up restarting | E-mail from `velexis-alert@` |
| The airline-card limits | Three declines on a checkout, 20 declines of a tenant within an hour (the method is then suspended for an hour) | E-mail `staff.airline_card_alert` to the OTA's staff and to `OPS_ALERT_EMAIL`; log lines `payments.airline_card_attempts_exceeded` and `payments.airline_card_suspended` |
| AIDE (daily) and `auditd` | Changed files outside the release folders; writes to keys, env files, units, scripts, sudoers and sshd | **Today nobody is alerted automatically:** the developer runs `sudo aide --check` and `sudo ausearch -k velexis-keys` (and the other keys of [`provision-vm.sh:269`](../../../deploy/scripts/provision-vm.sh#L269) `velexis.rules`). X-038's daily review alerts on these at once; it must exist before live payments |
| `fail2ban` | SSH brute force | Bans; visible in X-038's daily summary |
| The web application firewall (X-039) | Attacks on the storefront `/api/*`, the payment pages and the API host | Its log in journald, then X-038's summary |
| The PAN-absence scan in CI ([`pan-absence.int.test.ts:982`](../../backend/test/integration/payments/pan-absence.int.test.ts#L982) `none of the values appears anywhere after any path`) | A change that would let card data reach a log, a table, Redis or a job | A red build: the change never ships. If a release already shipped it, that is §4.3 |
| Outside parties | Amadeus, an airline, Stripe, an OTA, a traveller, a card brand through an acquirer, GitHub's security alerts | E-mail or support tickets to Velexis |

## 4. Response

Keep an incident record from the first minute: a private document (never a public issue) with the time in UTC, who did what and what was seen. Never paste card data, tokens or personal data into it; the request id and the log line's position are enough.

### 4.1 The first hour: stop card intake and keep the evidence

1. **Decide the severity** with §2. For severity 1, do all the steps below in this order.
2. **Turn the airline card off for every OTA.** On the VM, set `AIRLINE_CARD_ENABLED=false` in `/etc/velexis/ota-backend.env` and run `sudo systemctl restart velexis-ota-api`. The API reads the switch at start ([`airline-card.gateway.ts:94`](../../backend/src/payments/airline-card/airline-card.gateway.ts#L94) `config.get("AIRLINE_CARD_ENABLED"`): from then on `storefront.get` no longer offers the method and the completion answers `403 FEATURE_DISABLED` ([`airline-card.gateway.ts:103`](../../backend/src/payments/airline-card/airline-card.gateway.ts#L103) `assertGloballyEnabled`). Stripe payments go on; they never touch the card.
3. **If a storefront page, the Caddyfile or a unit may have been changed,** go back to a release known to be good. `sudo velexis-deploy --rollback` switches to the previous release and re-installs its units and Caddyfile from its root-owned snapshot ([`deploy.sh:339`](../../../deploy/scripts/deploy.sh#L339) `rollback_to()`); when the previous release is not known to be good either, deploy a good commit again through the deploy workflow. Then run `sudo velexis-healthcheck --payment-pages`. If the check still fails, or the VM itself is in doubt, stop Caddy (`sudo systemctl stop caddy`): every public host goes down, which is better than taking cards through a page nobody trusts.
4. **Keep the evidence before changing anything else.** Take a disk snapshot through the cloud provider's console. Copy off the VM, encrypted: `journalctl -o export` of the incident's days (apps, Caddy, `ssh`, `sudo`), `/var/log/audit/`, the output of `sudo aide --check`, `sudo velexis-healthcheck --status`, `/var/lib/velexis/healthcheck/`, `/var/lib/velexis/deploy-history` and `/var/log/velexis/`. Do not reboot or rebuild the VM before the snapshot exists. Export GitHub's audit log and the deploy workflow's runs.
5. **Cut access that may be compromised.** Remove an unknown SSH key and the deploy key from the VM (`/home/deploy/.ssh/authorized_keys`), revoke GitHub tokens and sessions, and change the `production` environment's secrets. Rotate the secrets that may have been read: the edge secret, the OTA admin service key, the database and Redis passwords and the master key ([deployment-single-vm.md §7](../../../docs/mvp/deployment-single-vm.md#7-secrets-and-the-master-key), [master key runbook](../../../docs/mvp/runbooks/master-key-rotation.md)), Stripe keys (Dashboard), the Amadeus credentials (Velexis's accounts in the platform admin's `/amadeus/accounts` after Amadeus issues new ones; an OTA that brought its own credentials replaces them itself) and the SMTP credentials.
6. **If an intruder had root**, do not clean the VM: build a new one from the repository's scripts and the last backup taken before the intrusion ([deployment-single-vm.md §3 and §11](../../../docs/mvp/deployment-single-vm.md#3-provisioning-a-new-vm)), with every secret rotated, and keep the old VM's snapshot for the investigation.
7. **Tell the product owner** what is known, and agree on the first notifications (§5).

### 4.2 A payment page alert

1. Read the alert: the page, the path, and the script or header that differs.
2. Was there a deploy or a Caddy change at that time? Compare `/var/lib/velexis/deploy-history` and the deploy workflow's runs. A deploy whose inventory and pages disagree is a build or release fault, not an attack: fix it and run `sudo velexis-healthcheck --payment-pages`.
3. Otherwise treat it as severity 1: compare the named file's `sha256sum` under `/srv/velexis/current/storefront/` with `payment-page-inventory.json`, `diff` `/etc/caddy/Caddyfile` with the release's snapshot in `/var/lib/velexis/system/<sha>/`, and run `sudo aide --check`; then §4.1 from step 2.
4. For a change on the card page (`/checkout/pay-card.html`, Stripe.js), also tell Stripe (§5).

### 4.3 Card data found where it must not be (12.10.7)

Card data in a log line, a table, Redis, a job, a backup, an e-mail or a support ticket, or a release that the PAN-absence scan would have refused:

1. Turn the airline card off (§4.1 step 2); it stays off until the cause is fixed and released.
2. Find every place and every copy: the same log lines on the VM and, with X-038, off the VM; the same rows in every tenant schema; the backups taken since the faulty release; Redis and the queues; e-mails sent and documents rendered.
3. Remove what can be removed, without destroying the evidence the investigation needs (record first what was found, never the values): tables through a one-off command run with `velexis-run ota` (as `tenants:scrub-card-copies` did, [`card-copies-scrub.ts:278`](../../backend/src/payments/airline-card/card-copies-scrub.ts#L278) `export async function scrubCardCopies`); journald by rotating and vacuuming the journal past the faulty lines once a copy for the investigation is taken, encrypted. **Backups and shipped logs cannot be deleted before their object lock ends** (by design: the VM's key cannot delete): record which objects hold card data and let their lifecycle remove them, and keep the decryption keys off the VM as before.
4. Fix the code with a failing test first (the PAN-absence scan, the redaction list of `@velexis/logger` with its test), release, and check with the scan that nothing new is written.
5. Decide with the product owner whether the data was exposed to anyone (who could read those logs, tables or backups) and notify as §5 says.

### 4.4 A card-testing attack

The limits stop it per checkout, per IP and per tenant, and suspend the method for a tenant for an hour after 20 declines ([`data-flow.md`](data-flow.md) §3, the endpoint row). Check that the alerts came, tell the OTA, and look at the refused requests by address in Caddy's log. If the attack goes on across tenants, or the limits are not enough, turn the airline card off (§4.1 step 2) and, once the web application firewall exists (X-039), add a blocking rule.

### 4.5 The deploy pipeline, an account or a provider

A leaked deploy key, GitHub account, cloud, DNS, SMTP or bucket account can change the VM or redirect its hosts (they are in scope, ADR-0027 item 1): cut the access (§4.1 step 5), check the last deploys and the DNS records of every host and custom domain, and treat the VM as severity 1 until the logs show the account was not used against it.

## 5. Notification

The product owner approves each message; the developer sends it. Facts only, never card data.

| Who | When | What |
|---|---|---|
| **The affected OTAs** (owners and admins) | As soon as a compromise of their storefront, their travellers' card data or their tenant's data is suspected with reason, and no later than 24 hours after it is confirmed | What happened, which storefronts and dates, what Velexis did (the airline card off, the release rolled back), what the OTA should do (watch its bookings; tell its own acquirers, airlines or industry body as their rules require), and the next update. The OTA is responsible for its own travellers and its own notifications ([`responsibility-matrix.md`](responsibility-matrix.md)) |
| **Amadeus** | When card data that passed through Flight Create Orders may be exposed on Velexis's side, or when Amadeus or an airline reports Velexis as a common point of purchase | The dates, the bookings (references, never card data) and the measures; Amadeus and the validating airlines, which charged the cards, reach the card brands and acquirers of those charges |
| **Stripe** | When the card page or Stripe.js may have been tampered with, a Stripe key leaked, or Stripe reports something | Through the Dashboard's support; Stripe is the acquirer side of method (a) |
| **The card brands and acquirers** (12.10.1) | As Amadeus, the airlines and Stripe ask: Velexis has no acquirer of its own for the airline card | Through them |
| **Authorities** | Personal data breaches: through the OTAs, which decide and notify for their travellers' data; law enforcement when a crime is suspected | As the product owner decides with legal advice |
| **The PCI assessor** (if one is engaged) | At the next assessment, or at once if the incident changes the scope | The incident record |

## 6. Recovery and lessons

- Turn the airline card on again only when the cause is understood and fixed with its test, the health check and the payment page check are green, and the product owner agrees. A significant change after an incident needs the scans of 11.3.1.3 and 11.3.2.1 and, when the card path or the VM changed significantly, a penetration test (11.4).
- Within two weeks, write what happened and what changes (12.10.6): update this plan, the [data flow](data-flow.md), the [script inventory](script-inventory.md) and the ADRs it touches, open tasks for the fixes, and add a line to the incident log of the [README](README.md#4-scan-test-and-incident-records).

## 7. Testing and training (12.10.2, 12.10.4)

Once a year, and after every real incident, the developer and the product owner walk through two scenarios against this plan: a payment page alert outside a deploy (§4.2) and a card number found in a log line (§4.3). They check that every contact of §1 is current and every command of §4 still works on the VM, record the date in the [calendar](README.md#3-calendar), and change the plan where it did not hold. Reading this plan is part of the yearly review of the pack, which is the developer's incident response training.
