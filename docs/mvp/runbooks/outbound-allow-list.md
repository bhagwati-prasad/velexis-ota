# Outbound allow-list

The Velexis VM may open connections only to the hosts it needs; every other outbound attempt is refused and logged. This is the control for PCI DSS 11.5.1.1 (a service provider detects, alerts on and addresses covert malware communication channels), as the note of 2026-11-10 on row 11.5 of [ADR-0027](../adr/0027-pci-scope-and-vm-controls.md) decides. Task X-041 in [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) wrote it, with the list [`deploy/egress/allowed-hosts.conf`](../../../deploy/egress/allowed-hosts.conf), the step `egress` of [`provision-vm.sh`](../../../deploy/scripts/provision-vm.sh), the script [`egress.sh`](../../../deploy/scripts/egress.sh) (`velexis-egress` on the VM), the units `velexis-egress-refresh.service` and `.timer` and the items of the `firewall` group of [`check-vm.sh`](../../../deploy/scripts/check-vm.sh).

Related: [`deployment-single-vm.md`](../deployment-single-vm.md) §2 (hardening), §3 (provisioning) and §12 (logs); [`ota/docs/pci/README.md`](../../../ota/docs/pci/README.md) §8 item 2 and the [responsibility matrix](../../../ota/docs/pci/responsibility-matrix.md) row 11; [`ota/docs/pci/incident-response.md`](../../../ota/docs/pci/incident-response.md); X-038's daily review of the security logs, which counts the refusals.

It is a human procedure on the VM. AI agents never run it ([`AGENTS.md`](../../../AGENTS.md) §8: no production access).

## 1. What is enforced

**The table.** `velexis-egress` keeps one nftables table, `inet velexis_egress` (IPv4 and IPv6 alike), whose chain `output` (hook `output`, policy `drop`) accepts, in this order:

| Rule | Why |
|---|---|
| `oifname "lo" accept` | Loopback: the apps reach PostgreSQL, Redis and each other, Caddy asks the platform API before on-demand TLS, and the health check makes its TLS and payment page checks against `127.0.0.1:443` with the host as SNI |
| `ct state established,related accept` | Replies to connections the VM accepted (SSH, HTTP, HTTPS: the inbound rules of X-020 and an open SSH session never change) and the rest of every allowed connection |
| `ct state invalid drop` | Stray packets of closed connections, dropped without a log line |
| `… @allow4 accept`, `… @allow6 accept` | The destinations of the list: address, protocol and port, each address commented with the host of its line |
| `… @emergency4 accept`, `… @emergency6 accept` | Time-limited openings ([§4](#4-the-emergency-opening)); empty normally |
| `udp sport 68 udp dport 67 accept`, `udp sport 546 udp dport 547 accept` | DHCP lease renewals (IPv4, IPv6) |
| `icmpv6 type { … } accept` | IPv6 neighbour discovery and multicast listener reports, without which IPv6 does not work |
| `limit rate 10/minute burst 5 packets log prefix "VELEXIS-EGRESS-DENY " flags skuid` | Every refused attempt into the kernel log, which journald keeps, at most 10 a minute (5 more in a burst), with the user that owns the socket; then the policy drops it |

ufw keeps the inbound rules of X-020 and its default `allow outgoing`. A packet must be accepted by every base chain on its hook, so the table's `drop` is final; ufw's own `deny outgoing` would refuse what the table allows as well, so it stays off (`deployment-single-vm.md` §2).

**The list.** [`allowed-hosts.conf`](../../../deploy/egress/allowed-hosts.conf) holds one connection per line: host, port, protocol, the env variable or unit that uses it, and the reason. It covers DNS (the VM's resolvers, and the public resolvers of the platform's custom domain verification), NTP, Stripe's API and Connect, Amadeus test and production, the mail relays, the backup bucket, Let's Encrypt and ZeroSSL, the Ubuntu archive and security mirrors, the vendor repositories of the step `packages` and the cloud provider's metadata service (cloud-init). Hosts that are the VM's own configuration stay out of the repository ([`decisions.md`](../decisions.md) §4) and are named by where the VM keeps them, read at every refresh:

| Host field | Read from |
|---|---|
| `@system-resolvers` | The upstream DNS servers of systemd-resolved (`/run/systemd/resolve/resolv.conf`) |
| `@chrony-sources` | The NTP servers chrony uses now (`chronyc -n -c sources`), picked from its pools or given by DHCP |
| `env:<file>:<VARIABLE>` | The host of the URL in `/etc/velexis/<file>`: `SMTP_URL` of both backends, `ALERT_SMTP_URL` of `alert.env`. The line's port must be the URL's (465 in the templates) |
| `rclone:backup.env` | The `endpoint` of the rclone remote that `RCLONE_REMOTE` and `RCLONE_CONFIG` name, as `<endpoint>` and `<bucket>.<endpoint>` (virtual-hosted buckets) |

**Not on the list.** GitHub: the Deploy workflow connects in over SSH and the VM fetches nothing from GitHub (`check-vm.test.sh` checks that no script or unit of `deploy/` names `github.com`). npm: releases are built in GitHub Actions; the step `node` runs before `harden` applies the list, and a new `PNPM_VERSION` later needs an emergency opening. Sentry: `SENTRY_DSN` has no client in the code yet; when one is added, its ingest host joins the list.

**The refresh.** `velexis-egress-refresh.service` runs `velexis-egress refresh --alert-once` at boot, before `network-online.target` (nftables rules do not survive a reboot; the table is back before the Velexis units, Caddy and the timers that reach out start), and `velexis-egress-refresh.timer` runs it every 2 minutes. Each run resolves every host through the VM's own resolvers, all lookups at once (10 seconds at most), and allows, per line, every address a lookup returned in the last 24 hours: the APIs and mirrors sit behind CDNs whose answers change, and an address an app got a minute ago must still be allowed. When a lookup fails, the line keeps its last good addresses however old they are. The run changes the table only when it differs from the list and the addresses (a changed policy, rule or set is put back and logged as `repaired`), in one nft transaction, and logs each address that comes (`allowed: …`) or goes (`no longer allowed: …`); otherwise it logs `unchanged`. State: `/var/lib/velexis/egress/addresses` (root `0600`). A failed run (a malformed list, nft refusing the table) leaves the table as it was; the first failure of a run of them mails through `velexis-alert@` (`OnFailure=`), and `/var/lib/velexis/egress/failing` marks it until a run succeeds (`recovered`).

**What it does not stop.** The allowed resolvers answer any name, so DNS tunnelling through them is not refused; X-038's review watches for it. An allowed API can carry data to an account an attacker controls there; the list only narrows the hosts. An address a CDN starts to answer between two refreshes is refused until the next one (at most 2 minutes), logged; the 24-hour memory makes it rare.

## 2. Adding or removing a host

Every change of the list is a pull request, never an edit on the VM (`check-vm.sh` reports `FAIL` for an installed list that differs from the release's):

1. Change [`deploy/egress/allowed-hosts.conf`](../../../deploy/egress/allowed-hosts.conf): one line per host, port and protocol, with the env variable or unit that uses it and the reason. A host that is the VM's own configuration (a mail relay, a bucket) goes through a token of §1 instead. `bash deploy/scripts/egress.sh validate deploy/egress/allowed-hosts.conf` checks the format; CI's `VM check test` job runs `check-vm.test.sh`, which validates it too. The reviewer checks that the connection is needed and that the reason names its user.
2. Merge, and deploy the release with the **Deploy** workflow.
3. On the VM: `sudo bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps egress`. It refuses, changing nothing, a malformed list and an apt source that the list leaves out; otherwise it installs the list, `velexis-egress` and the units where they changed and loads the table at once.
4. `sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only firewall`: only `PASS`.
5. The refusal log stays quiet for the new host: `sudo journalctl -k -g VELEXIS-EGRESS-DENY --since -1h`.

Removing a host is the same change; its addresses leave the table on the step's run.

Cases that need no pull request: a new mail relay or bucket endpoint is a change of the env file or `rclone.conf` (the next refresh, within 2 minutes, follows it; the old addresses stay allowed for 24 hours). Cases that need one: a cloud image whose apt sources name the provider's mirror (`grep -h '^URIs:' /etc/apt/sources.list.d/*.sources`; the step refuses until the mirror has a line, or point the sources at `archive.ubuntu.com`), a changed `DNS_RESOLVERS` of `platform-backend.env` (its resolvers are literal lines of the list: change them with it), an `AMADEUS_BASE_URL_TEST` or `_LIVE` other than the official hosts (the platform accepts only those with `APP_ENV=production`; the OTA backend accepts any `https` host), and an SMTP URL on another port than 465 (a URL without a port connects to its scheme's: 465 for `smtps://`, 587 for the backends' `smtp://`, 25 for `smtp://` in `alert.env`). `check-vm.sh --only firewall` reports `FAIL` for each of these until the list has the line, naming the apt mirror by its host and the others by their variable, never a value. A Velexis Amadeus account's base URL needs no line: with `APP_ENV=production` the platform takes only the official Amadeus host of the account's environment, so the list keeps only the two official Amadeus hosts. *Note (2026-11-11, lead decision (17k), approved by the owner):* this section listed a Velexis Amadeus account whose base URL in the platform admin is another `https` host than the two official ones as a case that needs a line (the platform accepted any `https` host there, also in production, and stored it in `platform.amadeus_accounts.base_url`, which the OTA backend and the platform worker then call), until task [PBE-074](../../../platform/docs/plans/agent-tasks.md#pbe-074--refuse-a-velexis-amadeus-account-whose-base-url-is-not-the-official-amadeus-host-in-production) makes the platform refuse such a base URL with `APP_ENV=production`. *Note (2026-11-12, task PBE-074):* that case is removed. With `APP_ENV=production`, `adminCreateAmadeusAccount` and `adminUpdateAmadeusAccount` answer `400 VALIDATION_FAILED` (field error `/baseUrl`, code `official_host`) for any base URL but the official host of the account's environment (`https://test.travel.api.amadeus.com` for `test`, `https://travel.api.amadeus.com` for `live`, with or without a trailing slash), and store, audit and queue nothing, as the platform already refuses `AMADEUS_BASE_URL_TEST` and `_LIVE` other than those hosts; the platform admin shows the refusal at the host field. `check-vm.sh` does not read the database: after deploying PBE-074 on a VM that held an Amadeus account before, `SELECT DISTINCT environment, base_url FROM platform.amadeus_accounts` must show only the official host of each environment; give any other account its official host in the platform admin (**Edit details**, step-up).

## 3. Reading a refusal

Each refusal is one kernel log line:

```text
sudo journalctl -k -g VELEXIS-EGRESS-DENY --since today -o short-iso
… kernel: VELEXIS-EGRESS-DENY IN= OUT=eth0 SRC=203.0.113.5 DST=198.51.100.7 LEN=60 … PROTO=TCP SPT=41312 DPT=443 … UID=998 GID=998
```

`DST`, `PROTO` and `DPT` are the destination; `UID` and `GID` the user that owns the socket (`getent passwd 998`: `velexis-ota` is the OTA API or worker, `velexis-platform` the platform's, `0` root, `systemd-resolve` the resolver; a line without `UID` came from the kernel itself). The log keeps at most 10 lines a minute, so counts are lower bounds. X-038's daily review counts the refusals by destination and user, and alerts at once on a burst.

| What the line shows | What it is | What to do |
|---|---|---|
| An address of a listed host (`getent hosts <DST>`, or the next `allowed: <DST> …` line of `journalctl -u velexis-egress-refresh`) | A CDN answered a new address between two refreshes | Nothing for a few lines; many, or for long, mean the lookups fail: `journalctl -u velexis-egress-refresh` shows the `WARNING` |
| Ubuntu's own background fetchers as root or their users: `motd.ubuntu.com` (motd-news), `contracts.canonical.com` (apt news of Ubuntu Pro), `api.snapcraft.io` (snapd), `changelogs.ubuntu.com` (the release check), `cdn.fwupd.org` (fwupd's firmware metadata) | Services of the cloud image that the VM does not need | Switch them off rather than allow them: `sudo systemctl disable --now motd-news.timer`, `sudo pro config set apt_news=false`, `sudo snap refresh --hold` (or remove snapd if no snap is installed), `Prompt=never` in `/etc/update-manager/release-upgrades`, `sudo systemctl disable --now fwupd-refresh.timer` |
| A host a Velexis app needs but the list lacks (a new provider endpoint after a release) | A missing line | §2; meanwhile, if production is affected, §4 |
| Anything else, above all from an app user (`velexis-ota`, `velexis-platform`, `velexis-portal`, the admin users) | Possibly malware or a compromised dependency calling home | Never open it. Follow the [incident response plan](../../../ota/docs/pci/incident-response.md): keep the logs, check `aide --check`, `ausearch -k velexis-keys`, the process of that user (`ps -u <user> -o pid,lstart,args`) |

## 4. The emergency opening

Only when a refused connection stops production and §2 would take too long. It is time-limited, recorded and reviewed as an incident:

1. Record it first: date, who, the destination, the reason and the expiry, in the incident record of [`ota/docs/pci/README.md`](../../../ota/docs/pci/README.md) §4.
2. Open it for at most 24 hours, naming the incident in the comment (`emergency6` for an IPv6 address):

   ```bash
   sudo nft add element inet velexis_egress emergency4 '{ 198.51.100.7 . tcp . 443 timeout 4h comment "INC-2026-001 <reason>, <your name>" }'
   ```

   The refresh never touches the emergency sets, a reboot empties them, and the kernel's audit records the change (`ausearch -m NETFILTER_CFG`). `check-vm.sh --only firewall` reports `FAIL` (`an emergency opening is in place`) until it expires.
3. Close it early once it is not needed: `sudo nft delete element inet velexis_egress emergency4 '{ 198.51.100.7 . tcp . 443 }'`. A connection that stays needed goes through §2.
4. Review it as an incident within a working day (`incident-response.md`), with the record of step 1.

Last resort, everything open (the same record and review): `sudo systemctl disable --now velexis-egress-refresh.timer velexis-egress-refresh.service && sudo nft delete table inet velexis_egress`; `provision-vm.sh --steps egress` puts it back. Never use `ufw default deny outgoing` (it refuses what the table allows too) or `systemctl restart nftables` (its `/etc/nftables.conf` starts with `flush ruleset`, which removes this table and ufw's rules).

## 5. Checks, tests and the VM check

`check-vm.sh --only firewall` reports, besides ufw's inbound items: outgoing connections denied by default (the table, its policy `drop`), the chain's rules exactly those of §1, refusals logged, every address of the allow sets on a line of the installed list and among the addresses the last refresh kept for that line's host (an extra destination fails, named, with its comment, also one added by hand under a listed host's comment) and every line with an address, the URL of every `env:` line on its line's port, every resolver of `DNS_RESOLVERS` on its `udp` and `tcp` lines, both backends' Amadeus base URLs on a line when they are set, no emergency opening, the installed list and `velexis-egress` the release's, every apt source of the VM on the list, the last refresh not failing, the timer active and enabled and the service enabled for boot. [`check-vm.test.sh`](../../../deploy/scripts/test/check-vm.test.sh) proves the step and each item with fake tools (CI's `VM check test` job), and loads the table with the real nft in a private network namespace; without a working `nft` it fails, naming the real-nft checks in its last line (lead decision (17a) of 2026-11-11, so CI's job installs `nftables` when the runner lacks it). The units smoke test (`deploy/systemd/test/units-smoke.sh`, CI's `systemd-units` job) starts a test copy of `velexis-egress-refresh.service` with the real `velexis-egress` under the unit's sandbox, in a network namespace of its own, and CI's sandbox loop rates the unit at exposure 2.0 or lower.

**On a throwaway VM (the human step of X-041),** provisioned by the same scripts with the allow-list on, check that each of these works, and keep the outputs (they hold no secret):

1. a deploy (the **Deploy** workflow), a backup (`sudo systemctl start velexis-backup`), an alert e-mail (`sudo velexis-alert message "egress test" /etc/hostname`), a Stripe test call and an Amadeus test search (a test OTA's checkout), a certificate renewal (`sudo systemctl reload caddy` with a new test host, or Caddy's log of a renewal) and `sudo unattended-upgrade --dry-run -d`;
2. `curl -sS --max-time 5 https://example.org` from the VM fails at once (`Operation not permitted`), and `journalctl -k -g VELEXIS-EGRESS-DENY` shows the attempt with `DST` and `UID=` once per rate window, however often it is repeated;
3. `check-vm.sh` shows only `PASS`; after a reboot too, before anything else is started by hand;
4. X-038's daily summary counts the refusal (once X-038 is done).

Then run the same `check-vm.sh` on the production VM after `provision-vm.sh --steps egress`.
