# Turning live airline-card payments on

This runbook is the gate in front of live airline-card payments (method (b) of [`decisions.md`](../../../docs/mvp/decisions.md) §2): the checklist that must be signed off, then the one switch that turns the method on for every OTA, and how to turn it off again. Task OBE-086 of [`plans/agent-tasks.md`](../plans/agent-tasks.md) wrote it.

- **The switch.** `AIRLINE_CARD_ENABLED` in `/etc/velexis/ota-backend.env` on the VM, the global kill switch of [OADR-0004](../adr/0004-airline-card-data-handling.md) point 1, read by the OTA API at start (template: [`deploy/env/ota-backend.env.example`](../../../deploy/env/ota-backend.env.example)). While it is `false`, no storefront offers the airline card in either environment, the completion answers `403 FEATURE_DISABLED`, and an OTA cannot turn `airlineCard.enabledLive` on (`403 FEATURE_DISABLED`, `details.feature = "airlineCard"`); Stripe payments are not affected.
- **Why a gate.** Live airline-card payments are enabled only after the M6 security review ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §B.1), and the switch stays `false` until every control row of [ADR-0027](../../../docs/mvp/adr/0027-pci-scope-and-vm-controls.md) item 2 is done and OBE-086 is fully checked; the penetration test, the script inventory review and the daily integrity check cover the whole storefront origin first ([OADR-0004](../adr/0004-airline-card-data-handling.md) and [OADR-0017](../adr/0017-airline-card-form-isolation.md), Follow-ups).
- **The evidence** is the [PCI evidence pack](../pci/README.md). This runbook links each precondition to its record there or in the plans; it holds no record of its own but the sign-off of §5.
- **Who.** The developer, on the VM and in the providers' consoles. It is a human procedure: AI agents never run it ([`AGENTS.md`](../../../AGENTS.md) §8, no production access). The product owner is told before the switch changes ([`incident-response.md`](../pci/incident-response.md) §1, the communication role).

## 1. Current state

**Off.** The production template has `AIRLINE_CARD_ENABLED=false`, and a unit test fails if it says anything else ([`config.test.ts`](../../backend/src/config.test.ts), "the airline card's kill switch … is off by default and in the deploy template"); the root `.env.example` has `false` too, while `ota/backend/.env.example` keeps `true` for local development and CI only. On 2026-11-10 (OBE-086) most preconditions of §2 are open; the column "On 2026-11-10" says which.

Check the VM's value (prints only that line of the root-only file):

```bash
sudo grep '^AIRLINE_CARD_ENABLED=' /etc/velexis/ota-backend.env     # AIRLINE_CARD_ENABLED=false
```

Signals that it is off: the OTA admin's **Settings → Storefront**, section **Airline card**, says "Live stays off until the platform turns the airline card on after its security review; the API refuses it until then."; `storefront.get` lists no `airline_card` in `payment.supportedMethods`.

## 2. Preconditions

Every row must be checked, with its evidence, before §3. A row that cannot be checked keeps the switch off; a fix becomes a task of the plans, never a change made on the VM by hand. The rows cover every control row of ADR-0027 item 2, the open items of [`data-flow.md`](../pci/data-flow.md) §5 and of the [responsibility matrix](../pci/responsibility-matrix.md), and the lead's decisions of 2026-11-10 (12e, 12f, 13g, 13h, 13j).

Commands run on the VM as the admin user (SSH with the second factor of X-037) unless a row says otherwise. None of them prints a secret; keep their output with the sign-off (§5).

### 2.1 Reviews and decisions

| # | Precondition | How to check it | Evidence | On 2026-11-10 |
|---|---|---|---|---|
| P1 | **The security reviews are closed**, of the OTA backend and of the platform (the CDE is the whole VM) | Each review's latest dated line says no finding is open; on the release's commit `pnpm audit --audit-level high` exits 0 | [`security-review.md`](../security-review.md) (OBE-084), [`platform/docs/security-review.md`](../../../platform/docs/security-review.md) (PBE-062) | Done: no finding open in either; on 2026-11-10 `pnpm audit --prod` finds no known vulnerability and `pnpm audit --audit-level high` exits 0 (1 moderate, development only) |
| P2 | **The PCI pack is reviewed** (OBE-085's second acceptance criterion): the whole pack read against the repository and the VM, the references check passes, the contacts of the incident plan reachable, the scope (12.5.2) and the malware evaluation (5.2.3) confirmed, and the script inventory reviewed for every page of the storefront origin, not only the payment pages (6.4.3; OADR-0017 Follow-ups) | The review row of [README §6](../pci/README.md#6-review-record) has a date, a commit and a result; the command of [README §5](../pci/README.md#5-checking-the-references) prints `0 problems`; the rows of [README §2](../pci/README.md#2-scope) and [§7](../pci/README.md#7-malware-evaluation-523) are dated | [`ota/docs/pci/README.md`](../pci/README.md) §2, §5, §6, §7; [`script-inventory.md`](../pci/script-inventory.md) §2 | Open: the review is OBE-085's human step |
| P3 | **The open questions of the pack are decided** (password length, covert channels, the six-monthly scope confirmation, the second person, the AIDE timer, the documents outside the repository) | Each item of [README §8](../pci/README.md#8-open-questions) carries its decision and, where it changes a decision, the ADR's dated revision | [README §8](../pci/README.md#8-open-questions) | The lead decided items 1 (13g), 2 (13h: X-041), 3 (13i), 4 (12e) and 5 (13j) on 2026-11-10, recorded in §8 by the wave-47 tasks; item 6 is P22 |
| P4 | **The residual risk of the shared storefront origin is decided**: accepted, or a dedicated card-entry origin built first | The decision and its date are in the review row of [README §6](../pci/README.md#6-review-record); a dedicated origin is a new task, done | [`script-inventory.md`](../pci/script-inventory.md) §5; [OADR-0017](../adr/0017-airline-card-form-isolation.md) (Follow-ups, Alternatives considered); [`data-flow.md`](../pci/data-flow.md) §5 item 6 | Open: decided at the review |

### 2.2 Scans and tests

| # | Precondition | How to check it | Evidence | On 2026-11-10 |
|---|---|---|---|---|
| P5 | **A passing external ASV scan** of every public host and address of the VM (11.3.2) | The scan's row in [README §9](../pci/README.md#9-before-live-the-penetration-test-and-the-asv-scan) says "passing", with the ASV, the date and the release | [README §9](../pci/README.md#9-before-live-the-penetration-test-and-the-asv-scan) | Open: OBE-086 step 1, a human step |
| P6 | **The penetration test passed** (11.4.1 to 11.4.4): outside and inside, network and application layer, the airline-card route and page, the whole storefront origin, the admin apps, and the separation between OTAs (A1.1.4; Appendix A1 applies, lead decision (12f)) | Every row of [README §9](../pci/README.md#9-before-live-the-penetration-test-and-the-asv-scan) has its date and result; no finding of high or critical risk is open, the retest confirms the fixes, every other finding has a task or an accepted risk | [README §9](../pci/README.md#9-before-live-the-penetration-test-and-the-asv-scan) | Open: OBE-086 step 1, a human step |
| P7 | **Every other "Before live" item of the calendar has its first record**: the authenticated internal scan (11.3.1), the review of the operations (12.4.2), the account review (7.2.4), inactive accounts (8.2.6), the providers' compliance (12.8.4), cipher suites and technologies (4.2.1.1, 12.3.3, 12.3.4), the incident response test (12.10.2) and the training (12.6.3, 6.2.2) | No row of [README §3](../pci/README.md#3-calendar) says "Before live" any more: each names its next due date, and its record is in [README §4](../pci/README.md#4-scan-test-and-incident-records) or the place the row names | [README §3, §4](../pci/README.md#3-calendar) | Open: nothing has run |
| P8 | **The launch checklists are walked through**, which carry the dependency audit of ADR-0027 row 6.3.3 | Their dated walk-through records | PBE-065 ([`platform/docs/plans/agent-tasks.md`](../../../platform/docs/plans/agent-tasks.md)), OBE-089 ([`plans/agent-tasks.md`](../plans/agent-tasks.md)) | Open: both are tasks of this wave |

### 2.3 Controls on the VM and the accounts

The task ids are those of [`foundation-tasks.md`](../../../docs/mvp/plans/foundation-tasks.md); a task is done when its heading ends with ` ✅` and its status says `done`.

| # | Precondition | How to check it | Evidence | On 2026-11-10 |
|---|---|---|---|---|
| P9 | **The VM check passes on the production VM** (X-020: system settings and daily updates, the units with `fail2ban`, `auditd` and `chrony`, the firewall, every service on loopback, Caddy's admin API on its unix socket only, SSH, users, files, env files, no swap or core dumps; ADR-0027 rows 1, 1.4, 2.2, 7, 8.6, 10.2) | `sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh; echo "exit $?"`: only `PASS` lines and `exit 0` | [`check-vm.sh`](../../../deploy/scripts/check-vm.sh); [`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md) §2; X-020 | Open: X-020's human steps 3 and 4 |
| P10 | **AIDE's daily run is on** (11.5.2; lead decision (13j)) | In the output of P9, `PASS dailyaidecheck.timer is active and enabled (AIDE's daily check)`; `systemctl list-timers dailyaidecheck.timer` shows a last run within 24 hours | [`check-vm.sh`](../../../deploy/scripts/check-vm.sh) (group `system`, FIX-W47-SHARED) | Open: the check comes with FIX-W47-SHARED (wave 47); its run on the production VM is P9's |
| P11 | **Administrative SSH needs a second factor** (8.4.2; X-037) | `sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only ssh` shows only `PASS`; from the workstation a plain key is refused and the FIDO2 key (or key and TOTP) logs in | [`ssh-access.md`](../../../docs/mvp/runbooks/ssh-access.md) §2, §3; X-037 | Open: X-037's VM check, a human step |
| P12 | **Every provider account has MFA** (8.4.2, 8.4.3): GitHub, the cloud console, DNS, the backup bucket, the SMTP provider, Stripe and npm | Each account's security page shows a second factor (a FIDO2 key where offered); for GitHub `gh api user --jq .two_factor_authentication` prints `true`. Record the date per account, never a recovery code | [`roadmap.md`](../../../docs/mvp/plans/roadmap.md) §4.1 ("MFA on every account"); [`responsibility-matrix.md`](../pci/responsibility-matrix.md) §2 row 8 | Open: a human step |
| P13 | **Security logs leave the VM, are kept 12 months and reviewed daily** (10.4.1, 10.5.1, 10.7; X-038), which the malware evaluation needs too | X-038 is done; its first daily summary and a test alert reached the operations mailbox | X-038; [README §7](../pci/README.md#7-malware-evaluation-523) (Conclusion) | Open: X-038 is `todo` |
| P14 | **A web application firewall protects the public hosts** (6.4.2; X-039), blocking on the storefront `/api/*`, the payment pages and `api.ota.example.com` | X-039 is done and its VM check is recorded | X-039; [`data-flow.md`](../pci/data-flow.md) §3, row "Web attacks" | Open: X-039 is `todo` |
| P15 | **Outbound connections are allow-listed and refusals logged** (11.5.1.1; lead decision (13h); X-041) | X-041 is done; `check-vm.sh --only firewall` shows only `PASS`; a connection to a host outside the list is refused, logged and counted in X-038's daily review (X-041's runbook `docs/mvp/runbooks/outbound-allow-list.md`) | X-041 | Open: X-041 is `todo` |
| P16 | **The health check's alerts reach the operations mailbox** (X-030's VM check) | X-030 is done: a real alert and its recovery received through `velexis-alert`; `sudo velexis-healthcheck --status` lists every check | [`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md) §13; X-030 | Open: X-030's VM check, a human step |
| P17 | **The payment page check has been green for 7 days on every page of the storefront origin** (6.4.3, 11.6.1; OADR-0017 point 8 and Follow-ups) | `sudo grep '^HEALTHCHECK_PAGES=' /etc/velexis/healthcheck.env` prints `HEALTHCHECK_PAGES=all`. `sudo velexis-healthcheck --status` has a `payment-page-*` line for every page of the release's inventory (`/srv/velexis/current/storefront/payment-page-inventory.json`), not only the two payment pages, and `payment-inventory` and every `payment-page-*` line say `ok` with a `since` time at least 7 days ago (a page's line exists only from its first check, so this also shows that `all` has been set for 7 days), and `payment pages last checked on:` is today or yesterday (UTC). `sudo journalctl -u velexis-healthcheck --since "7 days ago" \| grep 'FAIL payment-'` prints nothing, and the mailbox holds no `health check failed: payment page` or `storefront page` alert of those days | [`script-inventory.md`](../pci/script-inventory.md) §4; [`healthcheck.sh`](../../../deploy/scripts/healthcheck.sh) | Open: needs P16 and 7 days |
| P18 | **Change control of the CDE is in force** (6.5; X-023, X-019): the `production` environment with the developer as required reviewer, `main` protected | GitHub: Settings → Environments → `production` lists the developer as required reviewer and the branch policy `main` and `v*`; Settings → Branches protects `main` | [ADR-0023](../../../docs/mvp/adr/0023-release-artefact-and-deploy-user.md); [`data-flow.md`](../pci/data-flow.md) §3, row "Change control of the CDE"; X-023 step 5, X-019 | Open: human steps of X-023 and X-019 |
| P19 | **Backups run and the restore drill passed** (12.10.1; X-024, X-031) | `sudo velexis-healthcheck --status` shows `backup-age ok`; X-031's drill is recorded | [`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md) §10, §11; X-024, X-031 | Open: X-024's human steps, X-031 `todo` |
| P20 | **Old card copies are scrubbed** ([OADR-0004](../adr/0004-airline-card-data-handling.md) point 2, note of 2026-10-26) | After the first deploy that carries it: `sudo velexis-run ota node dist/cli.js tenants:scrub-card-copies --all`, then a second run scrubs `0` in every schema | [`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md) §9; [`data-flow.md`](../pci/data-flow.md) §3, row "Redaction in `supplier_requests`" | Open: no production deploy yet |
| P21 | **The 12-character password rule is in force** (8.3.6; lead decision (13g)): platform admins and owners and admins of OTAs need at least 12 characters with a letter and a digit at their next password change | `sudo velexis-deploy --status`: the `current:` release (named by its commit) contains FIX-W47-PLATFORM's commit (in a clone, `git merge-base --is-ancestor <that commit> <release commit>` exits 0). Then count, without any personal data, the privileged accounts whose password was not set under the rule (the query below) and record the number: decision 13g applies the rule at each account's next change, so a number above 0 is recorded, not a blocker | [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) (revision of 2026-11-10); [README §8](../pci/README.md#8-open-questions) item 1; [`password-policy.ts`](../../../platform/backend/src/auth/password-policy.ts) | Open: built in wave 47 (FIX-W47-PLATFORM), not deployed |

The count of P21: the privileged accounts (as [`accounts.repository.ts`](../../../platform/backend/src/auth/accounts.repository.ts) `passwordRuleOf` reads them) whose password was last set before the rule applied to them, that is before the first deploy that carried the rule (`<rule deployed at>`, its UTC time from `/var/lib/velexis/deploy-history`) or, for an owner or admin of an OTA, before that membership was created: a person who signs up sets a password under the 10-character rule, because the account holds no role yet, and becomes an owner by creating an OTA. It cannot see a role raised later on an existing membership, nor a platform admin granted after the account's last password (no grant time is stored). It prints one number:

```bash
sudo -u postgres psql -d velexis -XAt -c "
  SELECT count(*) FROM platform.accounts a
  WHERE a.status IN ('active', 'locked')
    AND (
      (a.is_platform_admin AND coalesce(a.password_changed_at, a.created_at) < timestamptz '<rule deployed at>')
      OR EXISTS (
        SELECT 1 FROM platform.tenant_memberships m JOIN platform.tenants t ON t.id = m.tenant_id
        WHERE m.account_id = a.id AND m.status = 'active' AND m.role IN ('owner', 'admin')
          AND t.status IN ('provisioning', 'active', 'suspended', 'failed') AND t.deleted_at IS NULL
          AND coalesce(a.password_changed_at, a.created_at) < greatest(timestamptz '<rule deployed at>', m.created_at)))"
```

### 2.4 Agreements and people

| # | Precondition | How to check it | Evidence | On 2026-11-10 |
|---|---|---|---|---|
| P22 | **The documents outside the repository exist and the self-assessment is signed**: the information security policy, acceptable use, the targeted risk analyses, the awareness programme, screening, the written agreements with the providers and their AOCs checked (12.8.2, 12.8.4); the SAQ D for Service Providers and its Attestation of Compliance completed from the pack and signed (ADR-0011 §C) | Their dates in the sign-off (§5); the documents stay outside the repository | [README §8](../pci/README.md#8-open-questions) item 6; [`responsibility-matrix.md`](../pci/responsibility-matrix.md) §2 row 12, §3 | Open: a human step |
| P23 | **Every OTA that can turn the method on has acknowledged Velexis's responsibility in writing** (12.9.1): the acknowledgement is in the terms every OTA accepts before the switch goes on, or each OTA signs it before it may tick the live box | The agreement's date and version in the sign-off | [`responsibility-matrix.md`](../pci/responsibility-matrix.md) §4 | Open: a human step |
| P24 | **Someone can turn the method off at any time** (12.10.3; lead decision (12e)): Velexis has one person with administrative access, so live airline-card payments stay off while that developer is away, until a second person who can at least turn it off joins | No absence of the developer is planned for the coming weeks, and before one §4 turns the switch off. When a second person joins: revisit the rule with the product owner and name that person in [`incident-response.md`](../pci/incident-response.md) §1 | [`incident-response.md`](../pci/incident-response.md) §1 ("Availability"); [README §8](../pci/README.md#8-open-questions) item 4 | Rule recorded; checked at the go-live and before every absence |

## 3. Turning it on

Only when every row of §2 is signed off in §5 through a reviewed pull request.

1. **Tell the product owner** the time of the change.
2. **Set the switch** (the file stays `root:root 0600`; `sudoedit` works as well):

   ```bash
   sudo sed -i 's/^AIRLINE_CARD_ENABLED=false$/AIRLINE_CARD_ENABLED=true/' /etc/velexis/ota-backend.env
   sudo grep '^AIRLINE_CARD_ENABLED=' /etc/velexis/ota-backend.env     # AIRLINE_CARD_ENABLED=true
   sudo stat -c '%U:%G %a' /etc/velexis/ota-backend.env                    # root:root 600
   sudo ausearch -k velexis-config -ts recent -i | tail -n 5               # auditd recorded the write
   ```

3. **Restart the API** (it reads the switch at start; the worker never reads it):

   ```bash
   sudo systemctl restart velexis-ota-api
   systemctl is-active velexis-ota-api                                      # active
   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/health/ready   # 200
   ```

4. **Check before anyone takes a card.**
   - `sudo velexis-healthcheck --payment-pages` shows only `ok` lines.
   - The demo OTA's admin, **Settings → Storefront → Airline card**, now says "The platform has turned the airline card on: tick to offer it in live too." (`airlineCard.liveAvailable: true`).
   - With the demo OTA's test flag on, its test storefront offers the airline card; one booking there with a test card of Amadeus's test environment (never a real card) completes. Every OTA whose test flag is on now offers the method in its test storefront too: test cards go to Amadeus's test system, but they still cross the VM, which the controls above cover.
5. **Then, and only then, may OTAs set `airlineCard.enabledLive`.** Tell the OTAs whose agreement holds the acknowledgement of P23. An owner or admin ticks **Offer the airline card in the live environment** (`PATCH /v1/console/settings/storefront`, `console.settings.storefront.update`; the change is a `settings.storefront.update` row of the OTA's `staff_actions`). The OTA admin warns when markup or fee rules are active: airline-card bookings are sold at the airline's price (OADR-0004 point 4).
6. **Record** the change in the switch history of §5.

## 4. Turning it off

Turn it off at once, without waiting for a review:

- in an incident: [`incident-response.md`](../pci/incident-response.md) §4.1 step 2 (and the severity of its §2);
- before every absence of the developer (P24, lead decision (12e)); on again after the return with §3 steps 1 to 4, once every row of §2 still holds;
- when a precondition stops holding: an ASV scan of the quarter that does not pass, a payment page alert not explained by a deploy ([`incident-response.md`](../pci/incident-response.md) §4.2), the WAF or the log shipping down, the yearly penetration test or the six-monthly separation test overdue ([README §3](../pci/README.md#3-calendar)).

```bash
sudo sed -i 's/^AIRLINE_CARD_ENABLED=true$/AIRLINE_CARD_ENABLED=false/' /etc/velexis/ota-backend.env
sudo grep '^AIRLINE_CARD_ENABLED=' /etc/velexis/ota-backend.env     # AIRLINE_CARD_ENABLED=false
sudo systemctl restart velexis-ota-api
```

From the restart on, no storefront offers the airline card and the completion answers `403 FEATURE_DISABLED`; Stripe payments go on. The OTAs' stored live flags stay as they are: an OTA can still untick its box, and cannot tick it again until the switch is on. Tell the product owner, and the OTAs when the off time is more than a short absence. Record it in §5.

## 5. Sign-off

The developer fills this in through a pull request that also links each record; nobody else signs for the developer. No secret, card number or personal data goes into it.

| # | Checked on (UTC) | By | Evidence (record, output or document date) |
|---|---|---|---|
| P1 | — | — | — |
| P2 | — | — | — |
| P3 | — | — | — |
| P4 | — | — | — |
| P5 | — | — | — |
| P6 | — | — | — |
| P7 | — | — | — |
| P8 | — | — | — |
| P9 | — | — | — |
| P10 | — | — | — |
| P11 | — | — | — |
| P12 | — | — | — |
| P13 | — | — | — |
| P14 | — | — | — |
| P15 | — | — | — |
| P16 | — | — | — |
| P17 | — | — | — |
| P18 | — | — | — |
| P19 | — | — | — |
| P20 | — | — | — |
| P21 | — | — | — |
| P22 | — | — | — |
| P23 | — | — | — |
| P24 | — | — | — |

Switch history (production):

| Date (UTC) | Value | Why | By | Release |
|---|---|---|---|---|
| — | `false` | Template value since the first deploy; live airline-card payments not yet allowed | — | — |

## 6. While it is on

**Signals.**

- The OTA's `staff.airline_card_alert` e-mails and their copy to `OPS_ALERT_EMAIL`: three declines on a checkout, or a tenant's method suspended for an hour after 20 declines ([OADR-0004](../adr/0004-airline-card-data-handling.md) point 6). On the VM: `sudo journalctl -u velexis-ota-api --since "1 day ago" | grep -E 'payments\.airline_card_(attempts_exceeded|suspended)'`.
- The health check's payment page alerts (`health check failed: payment page …`) and `sudo velexis-healthcheck --status`.
- X-038's daily summary and its immediate alerts; the WAF's blocks (X-039); refused outbound connections (X-041).
- The calendar of [README §3](../pci/README.md#3-calendar): a passing ASV scan every quarter, the separation test every six months, the penetration test yearly and after a significant change.

**Escalation.** A card-testing alert: [`incident-response.md`](../pci/incident-response.md) §4.4. A payment page alert: §4.2 of the same plan. Anything that may expose card data: its §4.1, which starts by turning the switch off (§4 above), then the notifications of its §5 (the product owner first, Amadeus, Stripe for the card page, the affected OTAs). A precondition that no longer holds: §4 above, then a task in the plans.
