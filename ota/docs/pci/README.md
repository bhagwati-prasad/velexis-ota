# PCI evidence pack: the airline-card path

Velexis receives, processes and transmits card data on behalf of OTAs when a traveller pays with the airline card (method (b) of [`decisions.md`](../../../docs/mvp/decisions.md) §2): the card goes from the hosted storefront through the OTA API to Amadeus, and the airline charges it. That makes Velexis a **service provider under PCI DSS v4.0.1**, which completes the **SAQ D for Service Providers** while it stays under the level-1 threshold ([ADR-0011](../../../docs/mvp/adr/0011-payments-stripe-and-airline-card.md) §C). This folder is the evidence for that self-assessment: the "Documentation" row of ADR-0011 §C and the rows of [ADR-0027](../../../docs/mvp/adr/0027-pci-scope-and-vm-controls.md) that name OBE-085 (5.2.3, the calendar of 11.3 and 11.4, and 12). It does not replace the SAQ or the Attestation of Compliance; it is what they are filled in from.

**Live airline-card payments are off.** `AIRLINE_CARD_ENABLED` stays `false` in production ([`ota-backend.env.example:84`](../../../deploy/env/ota-backend.env.example#L84) `AIRLINE_CARD_ENABLED=false`) until every open item of [`data-flow.md`](data-flow.md) §5 is done and every precondition of OBE-086's go-live runbook [`airline-card-go-live.md`](../runbooks/airline-card-go-live.md#2-preconditions) is signed off (ADR-0027 item 2); the runbook also says how the switch is turned on and off.

## 1. The documents

| Document | What it holds | PCI DSS |
|---|---|---|
| This README | Scope, the calendar of scans, tests and reviews, the records of scans, tests and incidents, how the references are checked, the review record, the malware evaluation, open questions, the first penetration test and ASV scan before live (§9) | 5.2.3, 11.3, 11.4, 12.4.2, 12.5.2, A1.1.4 |
| [`data-flow.md`](data-flow.md) | The card from the page through Caddy, the OTA API and the Amadeus client to the airline (Mermaid diagram), what exists where, and every control of ADR-0011 §C mapped to code, tests and VM settings and checks | 1.2.4, 3, 4, 6.4, 10, 12.5.1 |
| [`script-inventory.md`](script-inventory.md) | Every storefront page and its scripts, Stripe.js with its justification, how each script is authorised and checked daily, and the residual risk of the shared origin | 6.4.3, 11.6.1 |
| [`incident-response.md`](incident-response.md) | Roles, detection, containment, the Stripe, Amadeus and OTA notifications, recovery and testing | 12.10 |
| [`responsibility-matrix.md`](responsibility-matrix.md) | Velexis versus the OTA for every requirement of the SAQ D, and the third-party service providers | 12.8, 12.9, A1 |
| [`../runbooks/airline-card-go-live.md`](../runbooks/airline-card-go-live.md) (OBE-086, outside this folder) | The go-live checklist: every precondition with its evidence and the developer's sign-off, then how `AIRLINE_CARD_ENABLED` is turned on and off | 11.3, 11.4, 12.10.3, A1.1.4 |

## 2. Scope

The cardholder data environment is **the whole VM**, because nothing on it is segmented: Caddy (with its admin endpoint), the OTA API and worker, the platform API and worker, the portal, the platform admin, the OTA admin, PostgreSQL, Redis and the storefront files. The systems that can change the VM or hold its data are in scope as connected or security-impacting systems: the GitHub repository and its Actions (the deploy job's key is root-equivalent), the developer's SSH path and workstation, the off-site backup bucket, and the accounts at the cloud, DNS and SMTP providers ([ADR-0027](../../../docs/mvp/adr/0027-pci-scope-and-vm-controls.md) item 1). Amadeus, the airlines, Stripe and the infrastructure providers are third-party service providers ([`responsibility-matrix.md`](responsibility-matrix.md) §3).

The card path itself is narrow: one page, one API route, one process, one request, memory only ([`data-flow.md`](data-flow.md)). The environment controls apply to everything above regardless.

**Scope confirmation** (12.5.2; for a service provider every six months and after a significant change, 12.5.2.1, 12.5.3): the developer checks this section, the [inventory of system components](../../../docs/mvp/deployment-single-vm.md#4-process-layout-ports-users-and-permissions) and the [data flow](data-flow.md) against the VM and the providers, and records it here.

| Date | By | Result |
|---|---|---|
| — | — | Not confirmed yet: the first confirmation is part of the review of §6 |

## 3. Calendar

The recurring work that keeps the controls true. "Before live" items must be done before `AIRLINE_CARD_ENABLED=true` in production. Frequencies are PCI DSS's minimums unless Velexis chose a stricter one; where PCI DSS lets the entity choose (5.2.3.1, 7.2.5.1, 12.10.4.1, …), the choice below needs its targeted risk analysis (12.3.1), which is outside this repository. Enter the date of each run in its record (§4, §2, §6) and the next due date here.

| Activity | PCI DSS | How often | Who and how | Next due |
|---|---|---|---|---|
| External vulnerability scan by an approved scanning vendor (ASV) of every public host and address of the VM (the storefronts with their custom domains, `api.ota.example.com`, the platform hosts) | 11.3.2, 11.3.2.1 | Quarterly, and after a significant change; a passing scan each quarter | The developer orders it; results in §4; first: OBE-086 step 1 | Before live |
| Internal vulnerability scan, authenticated, of the VM | 11.3.1, 11.3.1.1 to 11.3.1.3 | Quarterly, and after a significant change; high and critical findings fixed and re-scanned | The developer; results in §4 | Before live |
| Penetration test, network and application layer, inside and outside, including the airline-card route, the storefront origin and the admin apps | 11.4.1 to 11.4.5 | Before live airline-card payments, then yearly and after a significant change | An independent tester (OBE-086); results and fixes in §4 | Before live (OBE-086) |
| Penetration test of the separation between OTAs | A1.1.4 | Every six months | With the penetration test above, then on its own | Before live |
| Payment page change and tamper check | 6.4.3, 11.6.1 | Daily (automatic) | `velexis-healthcheck` (X-030, [`script-inventory.md`](script-inventory.md) §4) | Running once X-030's VM check is done |
| File integrity check (AIDE) | 11.5.2 | Daily (automatic) | The Ubuntu package's `dailyaidecheck.timer`, enabled by `provision-vm.sh` and checked by `check-vm.sh` (since 2026-11-10, §8); alerts with X-038 | Running on the VM (X-020) |
| Review of the security logs | 10.4.1, 10.4.1.1, 10.4.2 | Daily (automatic) | `velexis-log-review` (X-038) | Before live (X-038) |
| Refused outbound connections (covert channels) | 11.5.1.1 | Every refusal logged as it happens; reviewed daily (automatic) | The outbound allow-list of X-041 logs each with `VELEXIS-EGRESS-DENY` ([`outbound-allow-list.md`](../../../docs/mvp/runbooks/outbound-allow-list.md) §3); `velexis-log-review` (X-038) counts them by destination and user and alerts at once on a burst | Running once X-041's VM check is done; the review before live (X-038) |
| Security updates and the weekly review of `apt list --upgradable` | 6.3.3 | Daily (automatic) and weekly | `unattended-upgrades`; the developer | Weekly |
| Dependency updates and `pnpm audit` | 6.3.1, 6.3.3 | Weekly; critical fixes within a month at most | Dependabot pull requests, reviewed by the developer | Weekly |
| Review of the operations: daily log reviews done, firewall rules, configuration standards, alerts answered, changes managed | 12.4.2, 12.4.2.1 | Quarterly | Someone other than the developer where possible (the product owner, with the developer's records) | Before live, then quarterly |
| Review of every account with access to the CDE (VM users, GitHub, cloud, DNS, bucket, SMTP, platform admins) | 7.2.4, 7.2.5.1 | Every six months | The developer; the product owner signs | Before live |
| Inactive accounts: every account of the CDE (VM users, platform admins, GitHub, cloud, DNS, bucket, SMTP) unused for 60 days is disabled or removed, so none stays usable after 90 days without use | 8.2.6 | Monthly | The developer, from each system's last-login record | Before live |
| Scope confirmation (§2) | 12.5.2, 12.5.2.1 | Every six months, and after a significant change | The developer | With the review of §6 |
| Malware evaluation of the VM (§7) | 5.2.3, 5.2.3.1 | Yearly | The developer | With the review of §6 |
| Compliance status of every third-party service provider (AOC or equivalent) | 12.8.4 | Yearly | The developer ([`responsibility-matrix.md`](responsibility-matrix.md) §3) | Before live |
| Cipher suites and protocols in use, keys and certificates | 4.2.1.1, 12.3.3 | Yearly | The developer (Caddy's defaults, the Amadeus endpoint) | Before live |
| Hardware and software technologies still supported | 12.3.4 | Yearly | The developer ([tech stack](../../../docs/mvp/tech-stack.md)) | Before live |
| Incident response test | 12.10.2 | Yearly, and after every incident | The developer and the product owner ([`incident-response.md`](incident-response.md) §7) | Before live |
| Security awareness and secure-development training | 12.6.3, 6.2.2 | Yearly | The developer | Before live |
| Restore drill (backups hold no card data) | 12.10.1 | As X-031 sets it | The developer (X-031) | X-031 |
| Review of this pack | 12.1.2, 12.5.2 | Yearly, and after a significant change to the card path, the VM or the providers | The developer (§6) | Before live |

## 4. Scan, test and incident records

No scan or penetration test has run yet: the first external ASV scan and the penetration test are OBE-086's step 1 (a human step), commissioned and recorded as [§9](#9-before-live-the-penetration-test-and-the-asv-scan) says. Record every later run here, with its report kept outside the repository.

| Date | Kind | Scope | By | Result | Findings and their tasks |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

Incidents ([`incident-response.md`](incident-response.md) §6): none recorded.

| Date | Severity | Summary (no card or personal data) | Follow-ups |
|---|---|---|---|
| — | — | — | — |

## 5. Checking the references

Every reference of the pack to code, a test or a VM setting is a relative link, and a link to a line is followed by a piece of that line in code style:

```markdown
[`velexis-ota-api.service:40`](../../../deploy/systemd/velexis-ota-api.service#L40) `LimitCORE=0`
```

Line numbers move when the files change; the piece finds the line again. Choose a piece that occurs on that line alone in its file where the line allows it (`AllowUsers ${ADMIN_USER} ${DEPLOY_USER}`, not `AllowUsers`, which a comment can hold too). This command, run from the repository root, checks that every linked file exists, every linked heading of a Markdown file exists, every line exists, and every piece is on its line; for a piece that is not, it says where the piece is now, or on which lines when several hold it (then read them and choose). It prints each problem and exits 1 when there is one (when the pack was written on `6d8ab82`, all 394 references passed). Run it at each review and after changes to the files the pack points at, and correct the line numbers it reports.

```bash
node --input-type=module - <<'EOF'
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const dir = "ota/docs/pci";
const slug = (h) => h.replace(/^#+ /, "").trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
const link = /\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s]+)\)(?: `((?:[^`\\]|\\.)+)`)?/g;
let checked = 0, problems = 0;
const problem = (text) => { problems += 1; console.log(`PROBLEM ${text}`); };
for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(join(dir, file), "utf8").replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));
  for (const [, , target, piece] of text.matchAll(link)) {
    if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
    checked += 1;
    const [path, anchor] = target.split("#");
    const abs = resolve(dirname(join(dir, file)), path);
    if (!existsSync(abs)) { problem(`${file}: ${target}: no such file`); continue; }
    if (anchor === undefined) continue;
    const lines = /^L(\d+)$/.exec(anchor);
    if (lines === null) {
      const headings = readFileSync(abs, "utf8").split("\n").filter((l) => /^#{1,6} /.test(l)).map(slug);
      if (abs.endsWith(".md") && !headings.includes(anchor)) problem(`${file}: ${target}: no such heading`);
      continue;
    }
    const content = statSync(abs).isFile() ? readFileSync(abs, "utf8").split("\n") : [];
    const line = content[Number(lines[1]) - 1];
    if (piece === undefined) { problem(`${file}: ${target}: no piece of the line after the link`); continue; }
    const wanted = piece.replace(/\\\|/g, "|");
    if (line !== undefined && line.includes(wanted)) continue;
    const now = content.flatMap((l, i) => (l.includes(wanted) ? [i + 1] : []));
    const where = now.length === 0 ? "no line has it" : now.length === 1 ? `now on line ${now[0]}` : `on lines ${now.join(", ")}`;
    problem(`${file}: ${target}: \`${piece}\` is not on ${line === undefined ? "that line (no such line)" : "that line"}: ${where}`);
  }
}
console.log(`${checked} references checked, ${problems} problems`);
process.exitCode = problems === 0 ? 0 : 1;
EOF
```

## 6. Review record

The developer reads the whole pack against the repository and the VM, runs the command of §5, checks every contact of [`incident-response.md`](incident-response.md) §1, confirms the scope (§2) and the malware evaluation (§7), decides the open questions (§8) and the residual risk of the shared origin ([`script-inventory.md`](script-inventory.md) §5, at the M6 review of OBE-086), and records the review here. This is the second acceptance criterion of OBE-085, a human step.

| Date | Reviewer | Commit | Result | Follow-ups |
|---|---|---|---|---|
| — | The developer | — | Pending | — |

## 7. Malware evaluation (5.2.3)

PCI DSS 5.2.3 lets an entity run a system component without an anti-malware solution when a documented evaluation shows the component is not at risk from malware, reviewed periodically (5.2.3.1). [ADR-0027](../../../docs/mvp/adr/0027-pci-scope-and-vm-controls.md) chooses that evaluation for the VM, reviewed yearly, with AIDE and `auditd` as detective controls. This is the evaluation; the developer confirms or changes it at each review (§6).

**The system.** One Ubuntu 24.04 LTS server VM, no desktop, no browser and no mail client on it. Software comes from Ubuntu's archive, the signed NodeSource, PGDG, Redis and Caddy repositories ([`provision-vm.sh:217`](../../../deploy/scripts/provision-vm.sh#L217) `step_packages()`), and Velexis's own release tarballs built by the deploy workflow; nothing is installed by hand.

**The threats that do exist for such a server**, which the evaluation does not dismiss: cryptominers and botnets that enter through a weak SSH login or an exposed service; web shells and remote code execution through a flaw in a public application; malicious packages in the JavaScript supply chain; ransomware run by an intruder who already has root.

**Why the VM is not commonly at risk from malware, and what covers each threat:**

- **Few entry points.** Only SSH (keys only, two users, `fail2ban`), HTTP and HTTPS (Caddy) are reachable; every other service listens on loopback ([`check-vm.sh:228`](../../../deploy/scripts/check-vm.sh#L228) `ufw is active`, [`check-vm.sh:353`](../../../deploy/scripts/check-vm.sh#L353) `passwordauthentication:no`, [`check-vm.sh:408`](../../../deploy/scripts/check-vm.sh#L408) `loopback_only 5432 PostgreSQL`, [`check-vm.sh:446`](../../../deploy/scripts/check-vm.sh#L446) `loopback_only 6379 Redis`). The second factor for administrative SSH comes with X-037.
- **No user content runs.** Nobody uploads files that the VM executes: the one upload, an OTA's storefront image, must read as PNG, JPEG, WebP or ICO from its bytes (no SVG; [`assets.service.ts:225`](../../backend/src/settings/assets.service.ts#L225) `export function checkedImage`), is stored outside the web root and is served with `nosniff` and a CSP of `default-src 'none'`; e-mail attachments are only produced, never received.
- **Apps cannot change the system.** Every app runs as its own system user without a shell, in a systemd sandbox ([`velexis-ota-api.service:46`](../../../deploy/systemd/velexis-ota-api.service#L46) `NoNewPrivileges=yes`, [`:47`](../../../deploy/systemd/velexis-ota-api.service#L47) `ProtectSystem=strict`, [`:64`](../../../deploy/systemd/velexis-ota-api.service#L64) `CapabilityBoundingSet=`, [`:69`](../../../deploy/systemd/velexis-ota-api.service#L69) `SystemCallFilter=~@privileged`), and the releases are read-only for them.
- **The supply chain is controlled.** Dependencies are pinned to exact versions, updated by reviewed pull requests, audited with `pnpm audit`, and no dependency may run an install script ([`package.json:35`](../../../package.json#L35) `"onlyBuiltDependencies": []`); the build runs in GitHub Actions, not on the VM.
- **Changes are seen.** AIDE compares the system files daily, `auditd` records writes to keys, configuration, units, scripts, sudoers and sshd ([`provision-vm.sh:331`](../../../deploy/scripts/provision-vm.sh#L331) `cat > /etc/audit/rules.d/velexis.rules`), the payment page check compares the storefront daily, and security updates install daily.

**Conclusion.** The VM is not commonly at risk from malware while all of the above hold. **Two conditions are not met yet:** AIDE and `auditd` findings reach nobody automatically until X-038's daily review exists, and the SSH second factor is X-037. Until both are done the evaluation does not hold for live payments.

**Re-evaluate at once** when any of these changes: a new public service or port, user files that the VM parses or runs, software installed outside the package repositories and releases, an incident or a threat report about the components in use (Ubuntu, Node.js, Caddy, PostgreSQL, Redis), or an assessor who does not accept the evaluation (the alternative is an anti-malware solution on the VM, for example a scheduled scanner with daily updates, recorded as a change of ADR-0027).

| Date | By | Result |
|---|---|---|
| — | — | Written with the pack on 2026-11-10; to be confirmed at the first review (§6) |

## 8. Open questions

Questions for the lead and the developer found while writing the pack; each needs a decision before live payments and, where it changes a decision, an ADR revision.

1. **Password length (8.3.6).** **Met by the rule itself** (the owner's decision (15e) of 2026-11-11, FIX-W48-PLATFORM; [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) revisions of 2026-11-10 and 2026-11-11). PCI DSS 8.3.6 asks for 12 characters with letters and digits wherever a password is a factor of an account it covers. Every portal account's password needs at least 12 characters with at least one letter and one digit ([`password-policy.ts:34`](../../../platform/backend/src/auth/password-policy.ts#L34) `export const MIN_PASSWORD_LENGTH = 12;`, [`password-policy.ts:111`](../../../platform/backend/src/auth/password-policy.ts#L111) `!LETTER.test(password) || !DIGIT.test(password)`), checked wherever a password is chosen: the sign-up ([`sign-up.service.ts:86`](../../../platform/backend/src/auth/sign-up.service.ts#L86) `this.passwords.check(request.password);`), the reset and the change ([`password-reset.service.ts:137`](../../../platform/backend/src/auth/password-reset.service.ts#L137) `this.passwords.check(request.newPassword, "/newPassword");`). No other path sets a password (an invited person signs up first; `admin:grant` sets none), so the requirement holds for every account, platform admins and the owners and admins of OTAs included, and needs no account-by-account check. No live account existed when the rule was decided, so none holds a password set under an older rule; [go-live runbook](../runbooks/airline-card-go-live.md) P21 checks that on the VM. (The decision (13g) of 2026-11-10, FIX-W47-PLATFORM, had applied the rule to platform admins and the owners and admins of OTAs at their next password change only.)
2. **Covert malware channels (11.5.1.1).** PCI DSS asks service providers to detect, alert on and address covert malware communication channels (for example DNS tunnelling or unexpected outbound connections). ADR-0027 has no control for it: the firewall allows all outgoing traffic. A control (an egress allow-list, or outbound connection logging in X-038's review) needs a task. **Decided (2026-11-10, lead decision (13h)):** task X-041 ([`foundation-tasks.md`](../../../docs/mvp/plans/foundation-tasks.md#x-041--allow-only-the-outbound-connections-the-vm-needs-and-log-the-refused-ones)): `ufw default deny outgoing` (or nftables) with an allow-list of the hosts the VM needs (DNS, NTP, Stripe, Amadeus, the mail relay, the backup bucket, Let's Encrypt, the Ubuntu mirrors, GitHub where the deploy needs it), every refused attempt logged and reviewed in X-038's daily review. It is a control to have before live airline-card payments ([`responsibility-matrix.md`](responsibility-matrix.md) row 11). **In place in the scripts (2026-11-11, X-041; PCI DSS 11.5.1.1):** the VM denies outgoing connections by default with the nftables table `inet velexis_egress` ([`egress.sh:430`](../../../deploy/scripts/egress.sh#L430) `output { type filter hook output priority filter; policy drop; }`), which allows only the connections of [`allowed-hosts.conf`](../../../deploy/egress/allowed-hosts.conf), each with its reason and user (DNS to the VM's resolvers and the custom-domain resolvers, NTP, Stripe, Amadeus, the mail relays, the backup bucket, Let's Encrypt and ZeroSSL, the Ubuntu and vendor apt repositories, the provider's metadata service; no GitHub), and logs every other attempt into the kernel log with the user that made it ([`egress.sh:71`](../../../deploy/scripts/egress.sh#L71) `log prefix "VELEXIS-EGRESS-DENY "`). `provision-vm.sh` applies it in its step `egress`, also run by `harden` ([`provision-vm.sh:871`](../../../deploy/scripts/provision-vm.sh#L871) `step_egress() {`); `velexis-egress-refresh.timer` refreshes the addresses every 2 minutes and the service loads the table at boot; `check-vm.sh --only firewall` reports `FAIL` for outgoing connections allowed by default, a destination outside the list (named), refusals not logged and a stopped refresh timer ([`check-vm.sh:757`](../../../deploy/scripts/check-vm.sh#L757) `firewall_egress() {`), proven by `check-vm.test.sh`. Adding a host, reading a refusal and the emergency opening: [`outbound-allow-list.md`](../../../docs/mvp/runbooks/outbound-allow-list.md). **Still open:** the check on the throwaway and production VMs (X-041's human step), and the daily count of the refusals by destination and user with an alert on a burst, which X-038's review adds (its note of 2026-11-10). **Added in the scripts (2026-11-12, X-038):** `velexis-logreview` counts the refusals by destination and user in its daily summary and alerts at once when 30 or more were logged since its previous run ([`log-review.sh:91`](../../../deploy/scripts/log-review.sh#L91) `EGRESS_BURST=30`), proven by `log-review.test.sh`; on the VM it starts with X-038's human steps.
3. **Scope confirmation every six months (12.5.2.1).** ADR-0027 row 12 says "yearly scope confirmation"; for a service provider PCI DSS asks for every six months. The calendar above uses six months, which includes the yearly one; the ADR's wording should follow. **Decided (2026-11-10, lead decision (13i)):** a dated note of [ADR-0027](../../../docs/mvp/adr/0027-pci-scope-and-vm-controls.md) on row 12 says it: at least every six months and after a significant change, as §2 and the calendar of §3 already do.
4. **A second person for incident containment (12.10.3).** One person cannot be available at all times ([`incident-response.md`](incident-response.md) §1). **Decided (2026-11-10, lead decision (12e)):** live airline-card payments stay off while the only developer is away, and the rule is revisited when a second person joins, as [`incident-response.md`](incident-response.md) §1 says; the go-live runbook makes it precondition P24 and turns the switch off before every absence ([`airline-card-go-live.md`](../runbooks/airline-card-go-live.md#4-turning-it-off) §4).
5. **The daily AIDE run (11.5.2).** AIDE runs through the `dailyaidecheck.timer` that the Ubuntu package `aide-common` installs and enables. **Done (2026-11-10, lead decision (13j)):** `check-vm.sh` reports `PASS` or `FAIL` for the timer, active and enabled, beside the AIDE database ([`check-vm.sh:198`](../../../deploy/scripts/check-vm.sh#L198) `the AIDE database exists`, [`:200`](../../../deploy/scripts/check-vm.sh#L200) `unit_state dailyaidecheck.timer`), `provision-vm.sh` enables it on every run of `harden` ([`provision-vm.sh:363`](../../../deploy/scripts/provision-vm.sh#L363) `systemctl enable --now dailyaidecheck.timer`), and `check-vm.test.sh` covers the timer running, stopped, not enabled and missing. AIDE's findings still alert nobody until X-038's review exists (§7).
6. **Documents outside the repository.** The information security policy, acceptable use, targeted risk analyses, the awareness programme, screening, the agreements with the providers and the OTAs, and the AOCs are not in this repository ([`responsibility-matrix.md`](responsibility-matrix.md) §2, row 12); they must exist before the SAQ D is signed.
7. **Query values in the WAF's log (10.3, 10.5.1; recorded 2026-11-11, lead decision (17i), approved by the owner).** The web application firewall (X-039) logs one line per matched rule into the VM's journald (Caddy's logger `http.handlers.waf`) with the request's path and query in `[uri "…"]`, a field of coraza-caddy that the rule files cannot change ([`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md#the-velexis-caddy-build-and-the-web-application-firewall) §6). It holds no card data: the card reaches the API only in a JSON body, and the generated `logdata.conf` names the variable that matched, never its value. But a request that also carries an attack-shaped value puts its query values into the line: a signed URL's `sig`, a link's `token` or a Stripe client secret. **Control: X-038**, whose acceptance criterion of 2026-11-11 blanks every query value of these lines before any log leaves the VM (the hour's chunk shipped to the bucket, the daily files of `/var/log/velexis/security/`, the daily summary and the alerts), with a test ([`foundation-tasks.md`](../../../docs/mvp/plans/foundation-tasks.md#x-038--ship-security-logs-off-the-vm-with-12-month-retention-and-a-daily-review) X-038). **Residual, accepted:** the values stay in the VM's own journald for its 30 days, readable only by root and the administrators who may read the journal (journald's own permissions), inside the cardholder data environment that is the whole VM (§2). Open until X-038 is done. **In place in the scripts (2026-11-12, X-038):** `velexis-shiplogs` blanks every value of the query of a `[uri "…"]` (the names and the path kept) before it writes the hour's chunk or the daily file ([`ship-logs.sh:115`](../../../deploy/scripts/ship-logs.sh#L115) `def blankuri: gsub(`), and `velexis-logreview` reads only those entries and sends no line that holds a `[uri` ([`log-review.sh:147`](../../../deploy/scripts/log-review.sh#L147) `sed '/\[uri /d'`), proven by `ship-logs.test.sh` and `log-review.test.sh` ([`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md#security-logs-off-the-vm-and-their-review) §12). Of Caddy's other lines none leaves the VM: its error log carries a request's whole query and headers, and its start writes its environment, `VELEXIS_EDGE_SECRET` among it, into journald (a residual found in X-038's review, [`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md#12-logs) §12). Still open: X-038's steps on the VM (human).

## 9. Before live: the penetration test and the ASV scan

OBE-086's step 1, a human step: before `AIRLINE_CARD_ENABLED=true` in production, Velexis commissions an external vulnerability scan by an approved scanning vendor (ASV, 11.3.2) and a penetration test (11.4.1 to 11.4.4, and A1.1.4), fixes or plans every finding, and records here when they ran, what they covered and what they found. They are preconditions P5 and P6 of the [go-live runbook](../runbooks/airline-card-go-live.md#2-preconditions). The reports stay outside the repository, as they describe weaknesses; the rows below are the summary that an OTA may receive on request (12.9.2, 11.4.7). Later runs follow the [calendar](#3-calendar) and go into [§4](#4-scan-test-and-incident-records).

**Commissioning.**

- The ASV is one that the PCI Security Standards Council lists. The tester is qualified and organisationally independent of the developer (11.4.1): an outside firm, since the developer wrote and runs everything tested.
- When the test is booked, confirm with the assessor that Appendix A1 applies to Velexis as a multi-tenant service provider, so that the separation between OTAs is tested now and every six months (A1.1.4; lead decision (12f) of 2026-11-10). Record the answer in the separation row below.
- Agree the rules of engagement in writing: the hosts and addresses below, the time windows, the developer as the contact during the test, test OTAs and accounts of the tester's own for every role (never an OTA's or a traveller's data), no load that would take the shared VM down, and no real card number anywhere (Amadeus's test cards on the test environment only).
- While the switch is off in production, the airline-card completion answers `403 FEATURE_DISABLED` and the card page shows no form (`storefront.get` does not offer the method). The tester gets both working on a throwaway VM provisioned by the same scripts with the same release ([`deployment-single-vm.md`](../../../docs/mvp/deployment-single-vm.md#3-provisioning-a-new-vm) §3), `AIRLINE_CARD_ENABLED=true` and the Amadeus test endpoint; record the release (commit) tested on each VM.

**Scope.** The CDE is the whole VM and the systems that can change it (§2).

| Part | What is tested | PCI DSS |
|---|---|---|
| External ASV scan | Every public IPv4 and IPv6 address of the VM and every public host on it: `platform.example.com`, `admin.platform.example.com`, `api.platform.example.com`, `admin.ota.example.com`, `api.ota.example.com`, the storefronts `<key>.ota.example.com` (the demo storefront `demo.ota.example.com` of the production demo OTA, which the [platform launch checklist](../../../platform/docs/runbooks/launch-checklist.md#6-manual-trials-before-billing) §6 creates, and those of the OTAs that will take airline-card payments) and those OTAs' custom domains | 11.3.2 |
| External penetration test, network and application layer | The same hosts from the internet: Caddy, TLS and the WAF (X-039); the whole storefront origin, every page of the [script inventory](script-inventory.md) (a look-alike card form, the isolation of the card page: COOP, `frame-ancestors`, `worker-src`; OADR-0017 Follow-ups); the airline-card completion `POST /v1/checkouts/{checkoutId}/airline-card-completion` (edge only, its limits, no card value echoed or kept); the OTA API, the portal, the platform admin and the OTA admin with sign-in, MFA, sessions, the portal-to-admin hand-off and the API keys | 11.4.1, 11.4.3 |
| Internal penetration test | From inside the VM as an unprivileged app user (a compromise of one trust zone assumed): the loopback services (PostgreSQL, Redis, Caddy's admin socket), another zone's keys, env files and processes ([ADR-0026](../../../docs/mvp/adr/0026-system-users-per-trust-zone.md)), escalation to root, and the deploy path | 11.4.1, 11.4.2 |
| Separation between OTAs | With two OTAs of the tester: whether one OTA's staff, API keys, storefront, customers or custom domain reach another OTA's data, settings, documents, stored files or rate limits, and whether an OTA reaches Velexis's own systems (A1.1.1 to A1.1.3); the result also answers the OTAs' 11.4.7 requests | A1.1.4 |
| Retest | Every finding fixed, tested again by the tester | 11.4.4 |

**Passed** means: the ASV's report says the scan passes (any dispute accepted by the ASV); the penetration test leaves no exploitable vulnerability of high or critical risk open (ranked as 6.3.1 says), the retest confirms the fixes, and every other finding has a task in the plans with its date, or an accepted risk with its reason and the developer's date.

**Records** (the first runs; "Pending" until they ran):

| Date | Part | Scope | By (ASV or tester) | Release (commit) | Result | Report kept at | Findings and their tasks |
|---|---|---|---|---|---|---|---|
| — | External ASV scan | — | — | — | Pending (human step) | — | — |
| — | External penetration test | — | — | — | Pending (human step) | — | — |
| — | Internal penetration test | — | — | — | Pending (human step) | — | — |
| — | Separation between OTAs (Appendix A1 confirmed with the assessor: —) | — | — | — | Pending (human step) | — | — |
| — | Retest of the fixes | — | — | — | Pending (human step) | — | — |
