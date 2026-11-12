# Restore drill

This runbook rebuilds the Velexis VM from last night's off-VM backup on a **scratch VM** that can reach neither Amadeus nor Stripe, measures the recovery time (RTO), proves the restore of one tenant, and then destroys the copy. [ADR-0007](../adr/0007-single-vm-without-docker.md) (Backups) asks for it in M6 and then every quarter; it is the restore test that the PCI pack counts for requirement 12.10.1 ([`ota/docs/pci/README.md`](../../../ota/docs/pci/README.md)). Task X-031 in [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) wrote it, fixed what its rehearsal found in [`restore.sh`](../../../deploy/scripts/restore.sh) and in [`deployment-single-vm.md`](../deployment-single-vm.md) §11, and rehearsed on a development machine what runs there ([§7](#7-local-rehearsal-x-031-2026-11-12)).

Related: [`deployment-single-vm.md`](../deployment-single-vm.md) §3 (provisioning), §10 (backups) and §11 (restore, and the rules for a scratch VM); [db README §7](../../velexis-sdk/db/README.md) (restoring one tenant); [`outbound-allow-list.md`](outbound-allow-list.md); the OTA launch checklist's item C4 and its §6, which record the drill ([`ota/docs/runbooks/launch-checklist.md`](../../../ota/docs/runbooks/launch-checklist.md)).

It is a human procedure. AI agents never run it ([`AGENTS.md`](../../../AGENTS.md) §8: no production access).

## 1. What the drill proves

- **RTO of 4 hours or less**: from creating the scratch VM (step 1) to the end of the checks (step 6). A real rebuild adds the DNS change ([§11](../deployment-single-vm.md#11-restore-and-the-restore-drill) of the guide, step 1); keep the records' TTL short.
- **The figures match the set**: the tenant count, the tenant schema count, the reference airports and the last audit time of the drill database and of the restored live database equal the set's `MANIFEST.txt` (they may differ by a write made while the backup ran).
- **One tenant can be restored alone** with the commands of [§4](#4-restore-one-tenant), which db README §7 describes.
- **No live call left the scratch VM**: the journal shows refused outbound connections only, and the restored `supplier_requests` hold no row newer than the backup.
- **A failed `db --replace-live` leaves the live database intact** (a corrupt file, step 7).

## 2. Before you start

| What | Where it comes from |
|---|---|
| The two age **private** keys `velexis-data.key` and `velexis-config.key` | The password manager ([§10](../deployment-single-vm.md#10-backups) of the guide, step 1) |
| A **read-only drill key** for the bucket: `GetObject` and `ListBucket` on the backup bucket only, in an rclone file `rclone-drill.conf` (`[offsite]`, `type = s3`, `provider`, `access_key_id`, `secret_access_key`, `endpoint`, `region`, `no_check_bucket = true`) | The bucket provider's console; keep it in the password manager for the next drill. Never the VM's key: it may put objects, and a scratch VM must not be able to write to the bucket |
| The **sha** to deploy | The release production runs: `sudo velexis-deploy --status` on the production VM. The set's `MANIFEST.txt` names the release of the night (`release=`, step 3); if a deploy came after the backup, provision with the current release and deploy the set's one in step 5 (take both tarballs) |
| The **release tarball** `release-<sha>.tar` | The artefact `release-<sha>` of that commit's **Deploy** run (kept 7 days), or the production VM's copy, which holds no secret: `ssh <admin>@<production-vm> "sudo tar -C /srv/velexis/releases -cf - <sha>" > release-<sha>.tar` |
| A **throwaway deploy key pair** | `ssh-keygen -t ed25519 -f scratch-deploy -N '' -C restore-drill`: the scratch VM never gets the production deploy key, and the GitHub `production` environment never points at it |
| The **key of one demo tenant** for [§4](#4-restore-one-tenant) | The platform admin's tenant list (`demo` for the demo OTA of the launch checklist) |
| A **scratch VM** | Ubuntu 24.04, the size of [§1](../deployment-single-vm.md#1-vm-sizing) of the guide (at least 4 vCPU and 8 GB), with your SSH key for `ubuntu`. **No DNS record** points at it, and the provider's backups and snapshots stay off: it will hold production's personal data until step 10 |
| A UTC clock and the table of [§6](#6-drill-log) | Note the start and the end of every step there |

The scratch VM holds production data and production keys from step 3 on. Work on it only over SSH from your machine, keep it to the drill's day, and destroy it in step 10 even when the drill fails.

## 3. The drill, step by step

| Step | What | Start (UTC) | End (UTC) | Minutes | Result |
|---|---|---|---|---|---|
| 1 | Provision the scratch VM without DNS records | | | | |
| 2 | Isolate it before anything is restored: outbound closed, its own timers off, both workers masked | | | | |
| 3 | Fetch last night's set; restore the configuration and point it at black holes | | | | |
| 4 | Restore the database and the document storage | | | | |
| 5 | Deploy the same sha | | | | |
| 6 | Run the checks and `velexis-restore drill` | | | | |
| — | **RTO = end of step 6 − start of step 1** (4 hours or less) | | | | |
| 7 | A deliberately failed `db --replace-live` (corrupt file) | | | | |
| 8 | Restore one demo tenant ([§4](#4-restore-one-tenant)) | | | | |
| 9 | Outbound evidence: the journal and `supplier_requests` | | | | |
| 10 | Destroy the VM, shred the keys, record the drill | | | | |

From step 2 on, the commands run on the scratch VM in a root shell (`sudo -i`); `<scratch-vm>` is its address.

### Step 1. Provision the scratch VM

On your machine, take the deploy folder and the Caddy build of the same release, then provision as [§3](../deployment-single-vm.md#3-provisioning-a-new-vm) of the guide does (steps 1, 4 and 5 only: no DNS records, no SMTP, no bucket, no GitHub settings):

```bash
tar -xf release-<sha>.tar <sha>/deploy <sha>/caddy/bin/caddy
scp -r <sha>/deploy <sha>/caddy/bin/caddy scratch-deploy.pub release-<sha>.tar ubuntu@<scratch-vm>:/tmp/
ssh ubuntu@<scratch-vm>
sudo DEPLOY_SSH_PUBKEY_FILE=/tmp/scratch-deploy.pub ADMIN_USER=ubuntu SSH_ALLOW_FROM=<your address> \
  CADDY_BINARY=/tmp/caddy bash /tmp/deploy/scripts/provision-vm.sh 2>&1 | tee ~/provision.txt
sudo bash /tmp/deploy/scripts/check-vm.sh | tee ~/check-vm.txt
```

`SSH_ALLOW_FROM` limits SSH to your address: the VM will hold personal data. `check-vm.sh` shows `PASS` except for the admin's SSH second factor and the `deploy` user's methods (no factor is enrolled on a scratch VM; [`ssh-access.md`](ssh-access.md)) and the SMTP and bucket lines of the outbound list, which stay without an address on a scratch VM.

### Step 2. Isolate the scratch VM

Do all of it **before** any restored file reaches the VM, and before any app unit starts. No release is deployed yet, so no app unit runs; PostgreSQL, Redis, Caddy and the timers of the provisioning do.

**Outbound traffic.** The outbound allow-list of X-041 is on, but it allows Stripe, Amadeus and the mail relays, and it has no address for the bucket: its `rclone:backup.env` line reads the scratch VM's own `backup.env`, which names no bucket. ufw now refuses everything but DNS, DHCP, the package mirrors and the bucket; a connection must pass both ufw and the allow-list's table, so Stripe and Amadeus are refused although the table allows them ([§2](../deployment-single-vm.md#2-os-hardening) of the guide). The bucket gets a time-limited opening in the table's emergency sets too ([`outbound-allow-list.md`](outbound-allow-list.md) §4; on a scratch VM it is part of the drill, not an incident), for both of its host names (the endpoint, and `<bucket>.<endpoint>` for providers that rclone reaches in virtual-hosted style):

```bash
sudo -i
install -d -m 0700 /root/restore
date -u '+%F %T' > /root/restore/drill-start.txt                # step 9 reads the journal from here on
ufw default deny outgoing
ufw allow out 53 comment 'drill: DNS'
ufw allow out 67/udp comment 'drill: DHCP'
ufw allow out 547/udp comment 'drill: DHCPv6'
for hp in $(velexis-egress apt-hosts | tr ' ' ':'); do          # the package mirrors, as the allow-list reads them
  h="${hp%:*}"; port="${hp##*:}"
  for ip in $(getent ahosts "$h" | awk '{print $1}' | sort -u); do
    ufw allow out to "$ip" port "$port" proto tcp comment "drill: $h"
  done
done
BUCKET_HOST=<the endpoint host of rclone-drill.conf>
BUCKET=<bucket>                                                 # the bucket name, as in RCLONE_REMOTE=offsite:<bucket> (step 3)
for h in "$BUCKET_HOST" "$BUCKET.$BUCKET_HOST"; do
  for ip in $(getent ahosts "$h" | awk '{print $1}' | sort -u); do
    ufw allow out to "$ip" port 443 proto tcp comment "drill: $h"
    case "$ip" in *:*) set=emergency6 ;; *) set=emergency4 ;; esac
    nft add element inet velexis_egress "$set" "{ $ip . tcp . 443 timeout 12h comment \"restore drill: $h\" }"
  done
done
ufw logging low
ufw status verbose
nft list set inet velexis_egress emergency4; nft list set inet velexis_egress emergency6
curl -sS -m 10 -o /dev/null https://api.stripe.com/ ; echo "stripe: exit $?"                         # not 0: refused
curl -sS -m 10 -o /dev/null https://test.travel.api.amadeus.com/ ; echo "amadeus: exit $?"           # not 0: refused
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' "https://$BUCKET_HOST/"                          # any HTTP status: reachable
```

DHCP keeps the VM's address; it carries no application data. With `ufw logging low`, packets that the default policy refuses are logged as `[UFW BLOCK]` in the kernel log, at most 3 a minute after a burst of 10 (ufw's rate limit; the allow-list's own `VELEXIS-EGRESS-DENY` lines, at most 10 a minute): step 9's counts are therefore lower bounds, and an outgoing packet's line has an empty `IN=` and the interface in `OUT=`. The addresses are those of the moment, and the emergency openings expire after 12 hours and with a reboot: if a fetch fails later because the bucket's addresses changed, or after a reboot, run the bucket's loop again.

**The scratch VM's own timers.** Provisioning enabled the nightly backup, the health check and the outbound allow-list's refresh. Turn off every Velexis timer but the refresh: a backup of the scratch VM must never reach the production bucket (a set taking the name `daily/<date>` would push that night's production set beside it, to `daily/<stamp>`, and a later `fetch daily/<date>` would get the scratch copy), the health check would alert about a VM nobody serves, and a later release's timers (such as the shipment of the security logs to the bucket) have no business on a scratch VM either. `velexis-deploy` does not enable timers again.

```bash
systemctl disable --now $(systemctl list-unit-files 'velexis-*.timer' --no-legend | awk '$1 != "velexis-egress-refresh.timer" { print $1 }')
systemctl list-timers 'velexis-*'                               # active: velexis-egress-refresh.timer only
```

**Both workers masked.** Their schedulers (`ticketing.scan`, `bookings.sync_scan`, `queues.poll`, `bookings.reconcile_scan`) would call live Amadeus at once with the restored credentials, and could issue tickets that production has since cancelled. `velexis-deploy` and the health check skip a masked unit. `systemctl mask` cannot do it on this VM: the unit files are regular files in `/etc/systemd/system` (installed by `provision-vm.sh` and `velexis-deploy`), so it refuses ("already exists"), a runtime mask (`--runtime`) in `/run/systemd/system` is shadowed by them, and `velexis-deploy` would put the unit file back over a `/dev/null` link there. A `/dev/null` link in `/etc/systemd/system.control`, which systemd reads before `/etc/systemd/system`, masks them and survives deploys and reboots (task X-043 makes `systemctl mask` itself work):

```bash
install -d -m 0755 /etc/systemd/system.control
ln -sfn /dev/null /etc/systemd/system.control/velexis-platform-worker.service
ln -sfn /dev/null /etc/systemd/system.control/velexis-ota-worker.service
systemctl daemon-reload
systemctl is-enabled velexis-platform-worker velexis-ota-worker      # masked, masked
```

### Step 3. Fetch the set and restore the configuration

Bring the two private keys and the drill's rclone file from your machine (`scp velexis-data.key velexis-config.key rclone-drill.conf ubuntu@<scratch-vm>:`), then:

```bash
install -m 0600 ~ubuntu/velexis-data.key ~ubuntu/velexis-config.key ~ubuntu/rclone-drill.conf /root/restore/
shred -u ~ubuntu/velexis-data.key ~ubuntu/velexis-config.key ~ubuntu/rclone-drill.conf
export RCLONE_CONFIG=/root/restore/rclone-drill.conf RCLONE_REMOTE=offsite:<bucket>
velexis-restore list
velexis-restore fetch daily/<date> /root/restore/set          # "checksums match its MANIFEST"
grep -E '^[a-z_]+=' /root/restore/set/MANIFEST.txt               # created_at, host, release, figures: note them
```

**The configuration.** Keep the scratch VM's own `backup.env` and `backup/` (no production bucket key, no recipients: its backup cannot run), and take everything else of the set's `/etc/velexis`: the master keys and the pepper (which must match the restored data), the JWT and document keys, the env files and `.provision-secrets`.

```bash
velexis-restore config /root/restore/set --identity /root/restore/velexis-config.key
cp -a /etc/velexis /root/restore/etc-velexis.scratch
rsync -a --exclude=/backup/ --exclude=/backup.env /root/velexis-config.restore/velexis/ /etc/velexis/
```

**Black holes, in the restored env files, before any unit starts.** The OTA backend sends every Amadeus request of a connection to `AMADEUS_BASE_URL_TEST` or `_LIVE`, so both point at a closed loopback port. The platform backend accepts only the official Amadeus hosts with `APP_ENV=production` (PBE-053), so its values stay; its only Amadeus caller is the masked worker, and ufw refuses the hosts. Mail goes to a loopback port where nothing listens (`SMTP_URL`, and `alert.env` for `velexis-alert`), so it stays in the outbox. Every Stripe key and webhook secret is emptied, and the platform's Stripe switches go off: with `APP_ENV=production` the platform refuses a test-mode `STRIPE_SECRET_KEY` and a switch that is on without its key, and the OTA backend's `_LIVE` variables take only live keys, so test-mode values cannot replace them. The Sentry DSNs are emptied, so no error of the drill reaches production's error tracking.

```bash
cd /etc/velexis
sed -i -E 's#^(AMADEUS_BASE_URL_(TEST|LIVE))=.*#\1=http://127.0.0.1:9#' ota-backend.env
sed -i -E 's#^SMTP_URL=.*#SMTP_URL=smtp://127.0.0.1:2525#; s#^(STRIPE_[A-Z_]+)=.*#\1=#' ota-backend.env platform-backend.env
sed -i -E 's#^(FEATURE_STRIPE_BILLING|FEATURE_OWN_STRIPE|FEATURE_SETTLEMENTS)=.*#\1=false#' platform-backend.env
sed -i -E 's#^SENTRY_DSN=.*#SENTRY_DSN=#' platform-backend.env ota-backend.env platform-frontend.env platform-admin.env ota-admin.env
sed -i -E 's#^ALERT_SMTP_URL=.*#ALERT_SMTP_URL=smtp://127.0.0.1:2525#; s#^ALERT_SMTP_(USER|PASSWORD)=.*#ALERT_SMTP_\1=#; s#^ALERT_SMTP_TLS=.*#ALERT_SMTP_TLS=none#' alert.env
grep -HE '^(AMADEUS_BASE_URL_(TEST|LIVE)|SMTP_URL|ALERT_SMTP_(URL|TLS)|FEATURE_(STRIPE_BILLING|OWN_STRIPE|SETTLEMENTS))=' ./*.env
grep -HE '^(STRIPE_[A-Z_]+|SENTRY_DSN|ALERT_SMTP_(USER|PASSWORD))=.' ./*.env | cut -d= -f1      # no output
cd /
```

The first `grep` shows `http://127.0.0.1:9` for the OTA backend's two Amadeus URLs, `smtp://127.0.0.1:2525` and `none` for mail, and `false` for the three switches; the second one prints nothing. `sed -i` keeps the files' owner and mode (`root:root 0600`).

**The restored passwords.** The env files hold production's database and Redis passwords, which `.provision-secrets` (restored with them) also holds. Set them on the roles and on Redis, then check the files, the keys, the database and Redis:

```bash
bash /tmp/deploy/scripts/provision-vm.sh --steps database,redis
bash /tmp/deploy/scripts/check-vm.sh --only files,envfiles,database,redis
```

### Step 4. Restore the database and the document storage

```bash
velexis-restore db /root/restore/set --identity /root/restore/velexis-data.key --replace-live        # type the hostname
velexis-restore storage /root/restore/set --identity /root/restore/velexis-data.key --replace-live   # type the hostname
```

Then record, before any unit starts, every tenant schema's `supplier_requests` (step 9 compares with it):

```bash
s=$(sed -n 's/^created_at=//p' /root/restore/set/MANIFEST.txt)
BACKUP_AT="${s:0:10} ${s:11:2}:${s:13:2}:${s:15:2}+00"
runuser -u postgres -- psql -X -d velexis -At -v backup_at="$BACKUP_AT" <<'SQL' | tee /root/restore/supplier-requests-1.txt
SELECT format('SELECT %L || '' rows='' || count(*) || '' newer='' || count(*) FILTER (WHERE created_at > %L::timestamptz) || '' newest='' || coalesce(max(created_at)::text, ''none'') FROM %I.supplier_requests',
              nspname, :'backup_at', nspname)
  FROM pg_namespace WHERE nspname ~ '^tenant_[a-z][a-z0-9]{2,29}$' ORDER BY nspname \gexec
SQL
```

One line per tenant schema: `tenant_<key> rows=<n> newer=0 newest=<time>`. A `newer` above 0 is a row written while the backup ran (between `created_at` and the dump), not a call of the scratch VM. The pattern is that of tenant keys (`tenants_key_dns_ck`: no underscore), so the `tenant_<key>_restore` and `tenant_<key>_old` schemas of step 8 never show in this list.

Redis is left out: it holds queues, schedules and sessions only, and the workers stay masked. A real rebuild may add `velexis-restore redis` ([§11](../deployment-single-vm.md#11-restore-and-the-restore-drill) of the guide).

### Step 5. Deploy the same sha

The **Deploy** workflow deploys to production only and is not used. Unpack the release where the deploy user would have uploaded it, and run `velexis-deploy` as the workflow does:

```bash
SHA=$(sed -n 's/^release=//p' /root/restore/set/MANIFEST.txt)
tar -C /srv/velexis/incoming -xf "/tmp/release-$SHA.tar"
(cd "/srv/velexis/incoming/$SHA" && sha256sum --quiet --strict -c SHA256SUMS) && echo "release intact"
velexis-deploy "$SHA"
velexis-deploy --status
```

The log shows `skip velexis-platform-worker (masked)` and `skip velexis-ota-worker (masked)`; the migrations find nothing to apply, and the five other units pass their health checks. Caddy gets no certificate for any host name: no DNS record points at the VM, and ufw refuses the ACME servers.

### Step 6. Run the checks and the drill

```bash
for p in 3100 4000 3000 3001 3002; do printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$p/health/ready"; done
systemctl is-active velexis-platform-api velexis-ota-api velexis-portal velexis-platform-admin velexis-ota-admin
velexis-healthcheck; velexis-healthcheck --status
velexis-restore drill /root/restore/set --identity /root/restore/velexis-data.key
```

Every port answers `200` and every unit is `active`. `velexis-healthcheck --status` shows the five units `ok` and the workers skipped; `backup-age`, the `tls-*` checks and the payment pages fail on a scratch VM (no backup, no certificate without DNS), and its alerts go to the black hole. `velexis-restore drill` restores the set again into `velexis_drill_<date>`, prints the figures, prints the live database's figures beside them (`live velexis: …`, the database restored in step 4), says whether they match the set's `MANIFEST.txt`, drops the drill database and appends all of it, with the set and the duration, to `/var/log/velexis/restore-drill-<date>.log`. Copy that log into [§6](#6-drill-log): the VM and its log go away in step 10.

The browser checks of a real rebuild (the portal, one storefront and the OTA admin, guide §11 step 7) need DNS and certificates; on the scratch VM the loopback answers above stand for them.

**Stop the RTO clock here.**

### Step 7. A deliberately failed `db --replace-live`

A copy of the set with one flipped bit in the dump, refused first by the MANIFEST check, then (with the MANIFEST "fixed" to match) by age, after the staging database was made. Each time the live database stays as it is, connectable, and no unit stops:

```bash
figures() { runuser -u postgres -- psql -X -d velexis -At <<'SQL'
SELECT 'tenants=' || count(*) FROM platform.tenants;
SELECT 'tenant_schemas=' || count(*) FROM pg_namespace WHERE nspname LIKE 'tenant\_%';
SELECT 'reference_airports=' || count(*) FROM reference.airports;
SELECT 'last_audit_at=' || coalesce(max(created_at)::text, 'none') FROM platform.platform_audit_log;
SQL
}
figures > /root/restore/live-before.txt
cp -a /root/restore/set /root/restore/corrupt
f=/root/restore/corrupt/velexis-db.dump.age; off=$(( $(stat -c %s "$f") / 2 ))
b=$(od -An -tu1 -j "$off" -N1 "$f" | tr -d ' ')
printf "$(printf '\\%03o' $(( b ^ 1 )))" | dd of="$f" bs=1 seek="$off" conv=notrunc status=none
cmp -l /root/restore/set/velexis-db.dump.age "$f" | wc -l                                 # 1
velexis-restore db /root/restore/corrupt --identity /root/restore/velexis-data.key --replace-live   # "checksums ... do not match"
sum=$(sha256sum "$f" | cut -d' ' -f1)
sed -i "s#^[0-9a-f]\{64\}  ./velexis-db.dump.age\$#$sum  ./velexis-db.dump.age#" /root/restore/corrupt/MANIFEST.txt
velexis-restore db /root/restore/corrupt --identity /root/restore/velexis-data.key --replace-live   # age: "failed to decrypt"
figures | diff /root/restore/live-before.txt - && echo "live database unchanged"
runuser -u postgres -- psql -X -d postgres -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'velexis\_restore\_%'"   # nothing
systemctl is-active velexis-platform-api velexis-ota-api velexis-portal velexis-platform-admin velexis-ota-admin   # all active
```

The second run prints `dropping velexis_restore_<stamp>, which this failed run created` and `restore db failed; the live database velexis is unchanged`.

### Step 8. Restore one demo tenant

Follow [§4](#4-restore-one-tenant) for the demo tenant, on this VM, and note how long each command took.

### Step 9. Outbound evidence

```bash
DRILL_START="$(cat /root/restore/drill-start.txt)"
journalctl -k --since "$DRILL_START" -g 'UFW BLOCK' -o cat | grep -E ' IN= OUT=[^ ]' \
  | sed -nE 's/.*DST=([^ ]+).*DPT=([0-9]+).*/\1:\2/p' | sort | uniq -c | sort -rn
getent ahosts travel.api.amadeus.com test.travel.api.amadeus.com api.stripe.com | awk '{print $1}' | sort -u
journalctl -k --since "$DRILL_START" -g VELEXIS-EGRESS-DENY -o cat | wc -l
ss -tnp state established
s=$(sed -n 's/^created_at=//p' /root/restore/set/MANIFEST.txt)
BACKUP_AT="${s:0:10} ${s:11:2}:${s:13:2}:${s:15:2}+00"
runuser -u postgres -- psql -X -d velexis -At -v backup_at="$BACKUP_AT" <<'SQL' | tee /root/restore/supplier-requests-2.txt
SELECT format('SELECT %L || '' rows='' || count(*) || '' newer='' || count(*) FILTER (WHERE created_at > %L::timestamptz) || '' newest='' || coalesce(max(created_at)::text, ''none'') FROM %I.supplier_requests',
              nspname, :'backup_at', nspname)
  FROM pg_namespace WHERE nspname ~ '^tenant_[a-z][a-z0-9]{2,29}$' ORDER BY nspname \gexec
SQL
diff /root/restore/supplier-requests-1.txt /root/restore/supplier-requests-2.txt && echo "no supplier request since the restore"
K=<the tenant key of step 8>       # the schema that step 8 swapped aside, still there until §4's command 8
runuser -u postgres -- psql -X -d velexis -At -v backup_at="$BACKUP_AT" -v k="$K" <<'SQL' \
  | diff <(grep "^tenant_$K " /root/restore/supplier-requests-1.txt) - && echo "tenant_${K}_old unchanged since the restore too"
SELECT format('SELECT %L || '' rows='' || count(*) || '' newer='' || count(*) FILTER (WHERE created_at > %L::timestamptz) || '' newest='' || coalesce(max(created_at)::text, ''none'') FROM %I.supplier_requests',
              'tenant_' || :'k', :'backup_at', 'tenant_' || :'k' || '_old') \gexec
SQL
```

- The refused outgoing packets (an empty `IN=`) are counted by address and port, at most 3 logged a minute (step 2); an address of Amadeus or Stripe there was a call that ufw refused, which is what the drill expects of anything that tried. Record the counts.
- `ss` shows SSH and loopback connections only.
- The two `supplier_requests` lists are identical (the tenant restored in step 8 is the same backup's), and every `newer` is 0 or explained in step 4. `tenant_<key>_old`, which held that tenant from step 4 to step 8, shows the same line as `tenant_<key>` in step 4's list. Only then run §4's command 8, which drops it.

### Step 10. Destroy, shred, record

1. Copy what you keep, which holds no personal data: the drill log (`/var/log/velexis/restore-drill-<date>.log`), the outputs of steps 6, 7 and 9, and your times.
2. On the VM: `shred -u /root/restore/velexis-data.key /root/restore/velexis-config.key /root/restore/rclone-drill.conf`.
3. Destroy the VM **and its disks** at the provider; check that no snapshot or backup of it is left.
4. On your machine: `shred -u` every copy of the private keys and of `rclone-drill.conf` outside the password manager, and delete `scratch-deploy` and `scratch-deploy.pub`.
5. Fill in [§6](#6-drill-log), the OTA launch checklist's §6 row and item C4, and, when every acceptance criterion of X-031 holds, its status in the plan.

## 4. Restore one tenant

The procedure of [db README §7](../../velexis-sdk/db/README.md) for this VM: the backup is restored into a scratch database, the tenant's schema is renamed there, copied beside the live schema without a file on disk, brought to the current migration version with the release's runner, and swapped in one transaction. The other tenants are never touched. `K` is the tenant's key; the commands run in a root shell on the VM, with the set fetched and the data key in `/root/restore` (step 3).

| # | Command | What it does |
|---|---|---|
| 1 | Suspend the OTA | On production: the platform admin's **Suspend** (reason `admin`), which writes the audit row and e-mails the owners. On the scratch VM (no DNS, no admin site): the SQL below. Wait 60 seconds: the OTA API's tenant cache then answers `TENANT_SUSPENDED` |
| 2 | `velexis-restore db …--target velexis_tenant_restore` | The whole set into a scratch database; the live one is untouched |
| 3 | `ALTER SCHEMA … RENAME` in the scratch database | `tenant_<key>_restore`, so it can stand beside the live schema |
| 4 | `pg_dump --schema … \| pg_restore` | Copies that schema, with its grants and default privileges, into the live database in one transaction, without a file on disk |
| 5 | The release's `migrate.js tenant` | Brings the restored schema to the release's migration version (nothing to apply when the set and the release are of the same version; it then prints nothing) |
| 6 | Compare, then swap in one transaction | `tenant_<key>` becomes `tenant_<key>_old`, the restored schema becomes `tenant_<key>` |
| 7 | Resume the OTA | On production the platform admin's **Resume**; on the scratch VM the SQL below |
| 8 | After the checks | Drop `tenant_<key>_old` and the scratch database |

```bash
K=<tenant key>
REL=$(readlink -f /srv/velexis/current)
# 1. suspend (scratch VM; on production use the platform admin)
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d velexis -c "UPDATE platform.tenants SET status = 'suspended', suspended_at = now(), suspension_reason = 'admin', version = version + 1 WHERE key = '$K' AND status = 'active'"
# 2. the set into a scratch database
velexis-restore db /root/restore/set --identity /root/restore/velexis-data.key --target velexis_tenant_restore
# 3. rename the tenant's schema there
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d velexis_tenant_restore -c "ALTER SCHEMA tenant_$K RENAME TO tenant_${K}_restore"
# 4. copy it beside the live schema, in one transaction, without a file on disk
runuser -u postgres -- pg_dump --format=custom --schema="tenant_${K}_restore" velexis_tenant_restore \
  | runuser -u postgres -- pg_restore --exit-on-error --single-transaction --dbname velexis
# 5. bring it to the release's migration version, as velexis-deploy runs the migrations
systemd-run --quiet --pipe --wait --collect -p DynamicUser=yes -p SupplementaryGroups=velexis \
  -p EnvironmentFile=/etc/velexis/migrator.env -p Environment=NODE_ENV=production -p WorkingDirectory="$REL/db" \
  -- node dist/cli/migrate.js tenant --schema "tenant_${K}_restore" --dir "$REL/migrations/tenant"
# 6. compare both schemas table by table (rows now live, rows restored), then swap
runuser -u postgres -- psql -X -d velexis -At -v k="$K" <<'SQL' | grep -v ' live=0 restored=0$'
SELECT format('SELECT %L || '' live='' || (SELECT count(*) FROM %I.%I) || '' restored='' || (SELECT count(*) FROM %I.%I)',
              c.relname, n.nspname, c.relname, n.nspname || '_restore', c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND n.nspname = 'tenant_' || :'k' ORDER BY c.relname \gexec
SQL
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d velexis <<SQL
BEGIN;
ALTER SCHEMA tenant_$K RENAME TO tenant_${K}_old;
ALTER SCHEMA tenant_${K}_restore RENAME TO tenant_$K;
COMMIT;
SQL
# 7. resume (scratch VM; on production use the platform admin)
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d velexis -c "UPDATE platform.tenants SET status = 'active', suspended_at = NULL, suspension_reason = NULL, version = version + 1 WHERE key = '$K' AND status = 'suspended'"
# 8. after the checks (the tenant's console and storefront on production; the figures and step 9 on the scratch VM)
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d velexis -c "DROP SCHEMA tenant_${K}_old CASCADE"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE velexis_tenant_restore"
```

Notes:

- Step 6 prints one line per table that has rows on either side (`bookings live=… restored=…`): the difference is what was written since the backup, which the swap moves to `tenant_<key>_old`. The rehearsal of [§7](#7-local-rehearsal-x-031-2026-11-12) also compared the schemas' definitions, grants and every row.
- Until step 6 nothing in the live tenant changed: to abandon, drop `tenant_<key>_restore` and the scratch database and resume. After the swap, the rollback is the same swap the other way round while the OTA is suspended.
- `tenant_<key>_old` keeps whatever was written after the backup; copy single rows back from it before step 8 when only some data was lost (db README §7, "or copy selected rows back").
- Keys are 3 to 30 characters (`tenants_key_dns_ck`), so `tenant_<key>_restore` stays inside the runner's schema pattern and PostgreSQL's 63-byte limit.
- On the production VM, step 2 needs room for a second copy of the database: check `df -h /var/lib/postgresql` first (the disk alert is at 80 %, [§13](../deployment-single-vm.md#13-monitoring-and-uptime) of the guide).

## 5. When something fails

| Failure | What to do |
|---|---|
| A fetch, `config` or `db` command fails | Its message says why; `db` and `drill` drop the database they were restoring into, never the live one. Fix and run it again |
| `velexis-deploy` rolls back | Read `journalctl -u <unit> -n 50`: a refused variable names itself (the configuration never prints a value). Fix the env file and run `velexis-deploy <sha>` again |
| A worker started | Stop at once (`systemctl stop velexis-platform-worker velexis-ota-worker`), check step 2's mask (`systemctl is-enabled`), and record it as a finding: the drill failed its isolation, whatever step 9 shows |
| The RTO is above 4 hours | Record it as a failed drill in §6 (a no-go of the launch checklist, item C4) with where the time went, and plan the fix as a task |

## 6. Drill log

Filled in by the developer after every drill (human step of X-031; the first one before the M6 go/no-go, then every quarter). The figures come from the set's `MANIFEST.txt`, the drill's output (`restored`) and its `live velexis:` line (`live`).

| Field | Drill of — (pending, human step) |
|---|---|
| Date, operator | — |
| Set (`daily/<date>`), its `created_at`, release sha | — |
| Steps 1 to 10: start and end (UTC) | — |
| **RTO** (start of step 1 to end of step 6) | — (4 hours or less) |
| Tenants: MANIFEST / restored / live | — |
| Tenant schemas: MANIFEST / restored / live | — |
| Reference airports: MANIFEST / restored / live | — |
| Last audit time: MANIFEST / restored / live | — |
| Step 7: both refusals, live database unchanged, units active | — |
| Step 8: tenant, commands as in §4, durations | — |
| Step 9: refused destinations (Amadeus, Stripe), `supplier_requests` unchanged | — |
| Step 10: VM and disks destroyed, keys shredded | — |
| Findings and the tasks they became | — |

## 7. Local rehearsal (X-031, 2026-11-12)

What can run without a VM was rehearsed on a development machine (4 CPUs shared with other work, load average 0.7 to 1.9, PostgreSQL 16.15), on scratch databases only (never the shared development database `velexis`), with the set and the two age keys that `backup-restore.test.sh` makes and keeps (`BACKUP_TEST_KEEP=1`). The scratch-VM drill, its RTO and the outbound evidence remain the human step of §3 and §6.

| What | Result |
|---|---|
| [`backup-restore.test.sh`](../../../deploy/scripts/test/backup-restore.test.sh), with X-031's new checks of the drill log (also a drill whose figures differ from the MANIFEST) | all 62 checks passed (27 runs of `backup.sh` and `restore.sh`, about 20 s) |
| `velexis-restore drill` of a set made by that test's harness (2 tenants, 3 airports) | `drill OK in 2s`; the log names the set and puts the live database's figures beside the restored ones |
| The failed `db --replace-live` of step 7, its commands as written | refused by the MANIFEST check (0.01 s), then, resealed, by age with the staging database dropped (0.3 s); the live database unchanged (figures, schema), no unit stopped |
| The `supplier_requests` check of steps 4 and 9 | `newer=0` for both restored schemas; a row written afterwards was found (`newer=1`). On a scratch database after a swap as in step 8, the `tenant_<key>_restore` and `tenant_<key>_old` schemas stay out of the list, and a row written into `tenant_<key>_old` after the backup is found by step 9's comparison |
| The emergency openings of step 2 (`nft add element … emergency4/emergency6 … timeout 12h comment …`) against the allow-list's set definitions, in a private network namespace (nftables 1.0.9) | both elements accepted, with their timeout and comment |
| The single-tenant restore of §4 (as `velexis_test_admin` instead of `postgres`, the migration CLI with the migrator's DSN instead of `systemd-run`) | every step under 2 s (restore into the scratch database 1.7 s, copy 0.6 s, migration 0.3 s); afterwards the live schema equals the set's (definitions, grants, every row), `tenant_<key>_old` keeps the row written after the backup, the other tenant is untouched, `velexis_ota_app` can use the restored schema |
| The env file edits of step 3, run on a fake `/etc/velexis` rendered from `deploy/env/*.env.example` with production-like values, checked with the backends' own configuration code (`APP_ENV=production`) | accepted by the platform API and worker and the OTA API and worker; `velexis-alert` accepts the black hole and then cannot connect. The edits the guide asked for before X-031 (the black hole in both backends' files, test-mode values in every Stripe variable) were refused: the platform's Amadeus URLs and test-mode key, the OTA's `_LIVE` keys |
| The copy of the restored configuration of step 3 (`rsync` with the two excludes) on a fake `/etc/velexis` | the restored keys and env files in place, the scratch VM's `backup.env` and `backup/` kept, modes kept |
| `systemctl mask` against a unit file in `/etc/systemd/system`, with systemd 255 (Ubuntu 24.04's) offline (`systemctl --root`) | refused ("already exists"); `--runtime` creates a link that `is-enabled` ignores (`disabled`); a `/dev/null` link in `/etc/systemd/system.control` gives `masked`, and `enable` is then refused. GNU `install`, which `velexis-deploy` uses, replaces a `/dev/null` link with the unit file |

## 8. What X-031 found and changed

| Finding | Change |
|---|---|
| `systemctl mask` of the workers, as §11 of the guide said, fails on the VM; a runtime mask is ignored; `velexis-deploy` would undo a link in `/etc/systemd/system` | Step 2 masks them with `/dev/null` links in `/etc/systemd/system.control`, which §11 now names; task X-043 makes `systemctl mask` work and has the test stand-in refuse what systemd refuses |
| The Amadeus black hole in the platform backend's env file, and test-mode Stripe values, stop the backends from starting with `APP_ENV=production` | §11 and step 3: the black hole in the OTA backend's file only, every Stripe value emptied and the platform's Stripe switches off, the Sentry DSNs emptied |
| The scratch VM's nightly backup would upload to the production bucket once the restored `backup.env` and `rclone.conf` are in place, and could take that night's `daily/<date>` | §11 and steps 2 and 3: every Velexis timer but the allow-list's refresh off, the scratch VM's own `backup.env` and `backup/` kept, a read-only drill key |
| `ufw default deny outgoing` also refuses DHCP | Step 2 allows DHCP |
| The outbound allow-list's table (X-041, policy drop) has no address for the bucket on a scratch VM, whose own `backup.env` names none, so ufw's allow rule alone would not let the fetch through; rclone may reach the bucket as `<bucket>.<endpoint>` | §11 and step 2: the bucket's addresses, of both names, go into ufw's rules and into the table's emergency sets for 12 hours |
| Step 9 counted the VM's incoming `[UFW BLOCK]` lines (scanners) as refused destinations, and its `supplier_requests` list would gain the `tenant_<key>_old` schema of step 8 | Step 9 counts outgoing refusals only (an empty `IN=`), steps 4 and 9 list the tenant schemas by the key pattern, and step 9 compares `tenant_<key>_old` with step 4's line before §4's command 8 drops it |
| `velexis-restore drill` replaced the day's log with each run and recorded neither the set nor the duration | It appends a header (UTC time, host, the set and its MANIFEST's `created_at`, `host`, `release` and `database`), the figures, the live database's figures, the duration and the result, and a `FAILED` line for a refused or failed drill |
| §11's full rebuild left open how the restored env files get their database and Redis passwords | §11: copy the restored folder, then `provision-vm.sh --steps database,redis` sets the passwords of the restored `.provision-secrets` |
