# Master-key rotation

This runbook replaces the master key (the key-encryption key, KEK) that wraps the data keys of every secret at rest, as decided in [ADR-0010](../adr/0010-secrets-envelope-encryption.md) (Rotation). Task X-040 in [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) wrote it, with the shared batch helper `rewrapBatch` of [`@velexis/crypto`](../../../packages/crypto/README.md#kek-rotation) and the `NEW_MASTER_KEY` switch of `provision-vm.sh`.

Related: [`deployment-single-vm.md`](../deployment-single-vm.md) §7 (secrets and the master key), §10 and §11 (backups and restore), §16 (incident quick reference); [ADR-0026](../adr/0026-system-users-per-trust-zone.md) item 2 (one key folder per backend zone).

It is a human procedure on the VM. AI agents never run it ([`AGENTS.md`](../../../AGENTS.md) §8: no production access).

## 1. What changes and what does not

- The KEK files are `master-v<N>.key` (KEK id `local:v<N>`). Each exists as two identical copies, one per backend zone: `/etc/velexis/keys/platform/` (user `velexis-platform`) and `/etc/velexis/keys/ota/` (user `velexis-ota`), each file `0400`.
- `MASTER_KEY_CURRENT` in `/etc/velexis/platform-backend.env` and `/etc/velexis/ota-backend.env` names the KEK that wraps **new** data keys. Every `master-v<N>.key` in the folder can still **unwrap**, so values under the old KEK keep working during the whole procedure.
- Only the data keys are re-wrapped. The encrypted data is not re-encrypted, and nothing is decrypted outside the backends.
- Each backend re-wraps only the data it owns (ADR-0010, ADR-0003):

  | Command | Run as | Covers |
  |---|---|---|
  | platform backend `secrets:rewrap` | `sudo velexis-run platform node dist/cli.js secrets:rewrap` | The platform ciphertext columns (Amadeus and Stripe credentials, credential submissions, MFA secrets, payout details, the e-mail outbox and the provisioning reveal) |
  | OTA backend `secrets:rewrap` | `sudo velexis-run ota node dist/cli.js secrets:rewrap` | The ciphertext columns of every tenant schema |
  | (none) | | The Redis cache of Amadeus access tokens `amadeus:token:*` is flushed instead (step 6) |

  Both commands call `rewrapBatch` and print, per table, how many rows they re-wrapped, skipped (changed meanwhile) and failed (did not authenticate), and how many rows remain under each old KEK id (`remainingByKekId`). Both commands are tasks of the platform and OTA plans. Check that the active release has them (`node dist/cli.js help` in each backend) before you start.

**When to rotate.** After a suspected compromise of the VM, of a backend zone's user or of a copy of `/etc/velexis` (follow [section 4](#4-after-a-suspected-compromise)); when someone who had root on the VM or access to the `/etc/velexis` backups leaves; and as planned key hygiene when the developer decides. A KEK does not wear out: a random 96-bit IV per wrap keeps it safe for far more data keys than the MVP creates ([`packages/crypto` README](../../../packages/crypto/README.md#kek-rotation)).

**Time needed.** About 30 minutes, plus the re-wrap itself (seconds for the MVP's row counts). The two APIs are unavailable for a few seconds at each of the three restarts (steps 3, 4 and 8); the Next.js apps and the storefront stay up.

## 2. Before you start

1. Read this runbook to the end. Pick the new version: one above the highest version ever used on this VM, from the records of earlier rotations (step 10) and the `master-v<N>.key` files present. A version is never used twice: after a restore of an older `/etc/velexis` the folder can show a lower version than one that already wraps values in later backups. The examples rotate from `v1` to `v2`; use your numbers.

   ```bash
   sudo ls /etc/velexis/keys/platform /etc/velexis/keys/ota    # the master-v<N>.key files present
   sudo grep -H '^MASTER_KEY_CURRENT=' /etc/velexis/platform-backend.env /etc/velexis/ota-backend.env
   ```

2. Make sure last night's backup succeeded (`journalctl -u velexis-backup -n 30`), and that you can open the offline password manager that holds the copy of `/etc/velexis`.
3. Use the `deploy/` folder of the active release (or a newer one) for `provision-vm.sh` and `check-vm.sh`: `/srv/velexis/current/deploy/scripts/`. Never run an older copy.

## 3. Procedure

Do the steps in this order. Each one is safe to repeat.

1. **Add the new key to both folders.** `provision-vm.sh` creates `master-v2.key` once (32 random bytes, base64) and installs identical `0400` copies in both zone folders. It never replaces a key file and refuses a version below the highest one present. It only sees the files present, so after a restore of an older `/etc/velexis` it cannot tell that a higher version was used before: pick the version as section 2 says.

   ```bash
   sudo NEW_MASTER_KEY=v2 bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps keys
   sudo sha256sum /etc/velexis/keys/platform/master-v2.key /etc/velexis/keys/ota/master-v2.key   # the same SHA-256 twice
   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only files                        # only PASS lines
   ```

2. **Back up the new key now**, before anything is encrypted with it: losing it after step 4 loses every secret it wraps. Run the backup (the config set holds `/etc/velexis`) and put an encrypted copy of `/etc/velexis` in the offline password manager ([`deployment-single-vm.md`](../deployment-single-vm.md) §3 step 8).

   ```bash
   sudo systemctl start velexis-backup && journalctl -u velexis-backup -n 5
   ```

3. **Restart the four backend units once, still on the old key.** The backends load the key files only at start. After this restart every backend process can unwrap both `v1` and `v2`, so no process meets a value it cannot open during step 4. The Next.js apps have no keys and stay up.

   ```bash
   sudo systemctl restart velexis-platform-worker velexis-ota-worker velexis-platform-api velexis-ota-api
   curl -fsS http://127.0.0.1:3100/health/ready && curl -fsS http://127.0.0.1:4000/health/ready
   ```

4. **Switch both backends to the new key.** Set `MASTER_KEY_CURRENT=local:v2` in **both** backend env files (the workers read the same files), restart, and check that all four units run. A backend whose `MASTER_KEY_CURRENT` names a missing file refuses to start with a `KeyProviderError` naming the file.

   ```bash
   sudo sed -i 's/^MASTER_KEY_CURRENT=.*/MASTER_KEY_CURRENT=local:v2/' /etc/velexis/platform-backend.env /etc/velexis/ota-backend.env
   sudo grep -H '^MASTER_KEY_CURRENT=' /etc/velexis/platform-backend.env /etc/velexis/ota-backend.env
   sudo systemctl restart velexis-platform-worker velexis-ota-worker velexis-platform-api velexis-ota-api
   systemctl is-active velexis-platform-worker velexis-ota-worker velexis-platform-api velexis-ota-api
   curl -fsS http://127.0.0.1:3100/health/ready && curl -fsS http://127.0.0.1:4000/health/ready
   ```

   From now on new values are wrapped with `v2`; old values still decrypt with `v1`.

5. **Re-wrap the existing values: both commands.** The platform command first, then the OTA command (it walks every tenant schema). Keep both outputs: they hold counts and KEK ids only, never a value.

   ```bash
   sudo velexis-run platform node dist/cli.js secrets:rewrap | tee ~/rewrap-platform-$(date -u +%F).txt
   sudo velexis-run ota node dist/cli.js secrets:rewrap | tee ~/rewrap-ota-$(date -u +%F).txt
   ```

   - **Skipped** rows were changed by a user or a job between the read and the write. They were not overwritten; the other writer's value is already under `v2`, or step 7 picks it up.
   - **Failed** rows hold a value that does not authenticate at its own place (a corrupted or copied ciphertext). They are left unchanged and stay under `local:v1`. Do not go on to step 8: find the rows (`encryption_key_id = 'local:v1'` and a ciphertext column that is not NULL, in the table the command names), and ask their owner to enter the secret again (for example a credential in the portal), which writes it under `v2`.
   - An error that stops a command (database or Redis down) leaves the rows written so far in place. Fix the cause and run the command again: it continues with what is left.

6. **Flush the Amadeus token cache.** The cached access tokens are encrypted under the old KEK, and they are cheaper to fetch again than to re-wrap. The password is read from `.provision-secrets` inside the root shell and passed to `redis-cli` in its environment, never on a command line.

   ```bash
   sudo bash -c '
     REDISCLI_AUTH="$(sed -n "s/^REDIS_PASSWORD=//p" /etc/velexis/.provision-secrets)"; export REDISCLI_AUTH
     redis-cli -h 127.0.0.1 -p 6379 --no-auth-warning --scan --pattern "amadeus:token:*" |
       xargs -r -n 100 redis-cli -h 127.0.0.1 -p 6379 --no-auth-warning UNLINK >/dev/null
     redis-cli -h 127.0.0.1 -p 6379 --no-auth-warning --scan --pattern "amadeus:token:*" | wc -l'   # 0
   ```

   The OTA backend fetches a new token on the next Amadeus call. The 60-second caches of platform rows (`conn:*`, `amadeus:acct:*`) need no flush: they expire within a minute of the platform command, and step 8 waits for that.

7. **Check that nothing is left under the old key.** Run both commands again. Each must report `rewrapped 0` and an empty `remainingByKekId` (no entry for `local:v1`) for every table. If one still lists `local:v1`, repeat steps 5 to 7; never remove a key that still wraps a value.

   ```bash
   sudo velexis-run platform node dist/cli.js secrets:rewrap
   sudo velexis-run ota node dist/cli.js secrets:rewrap
   ```

8. **Remove the old key from both folders, in one command**, then restart once more: the running processes forget `v1`, and the restart proves that nothing needs it any more. Start this step at least one minute after the platform command of step 5 finished, so that no 60-second cache in Redis still holds a platform row under `v1`.

   ```bash
   sudo rm /etc/velexis/keys/platform/master-v1.key /etc/velexis/keys/ota/master-v1.key
   sudo systemctl restart velexis-platform-worker velexis-ota-worker velexis-platform-api velexis-ota-api
   curl -fsS http://127.0.0.1:3100/health/ready && curl -fsS http://127.0.0.1:4000/health/ready
   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only files,envfiles    # only PASS lines
   ```

   `check-vm.sh` requires in each zone folder the master key that the zone's `MASTER_KEY_CURRENT` names, and identical copies of every master key present. A later run of `provision-vm.sh --steps keys` does not create `master-v1.key` again. Remove a key from both folders at once: the script restores a copy that is missing from one folder only.

9. **Back up `/etc/velexis`.** Run the backup again and replace the copy in the offline password manager with the new `/etc/velexis` (it holds `master-v2.key`, no longer `master-v1.key`).

   ```bash
   sudo systemctl start velexis-backup && journalctl -u velexis-backup -n 5
   ```

10. **Record the rotation**: the date, the old and new KEK ids, both command outputs of steps 5 and 7, and who did it.

**Backups taken before the rotation.** The nightly database dumps of the last 14 days (and the monthly ones of 6 months) hold values under `local:v1`. The config set of the same night holds `master-v1.key`, so a restore of a whole set (data and config of the same date, [`deployment-single-vm.md`](../deployment-single-vm.md) §11) still decrypts. After restoring such a set into the live system, run this runbook again from step 1, because the restored values are under the old key, with a new version above every one used before (`v3` after a rotation to `v2`).

## 4. After a suspected compromise

Anyone who read a backend zone's key folder and a database dump can decrypt every secret encrypted before the rotation. A new KEK only protects what is encrypted after it, so the secrets themselves must change too. Follow this order ([`deployment-single-vm.md`](../deployment-single-vm.md) §7 and §16):

1. **Contain first.** Follow the incident response plan. If root or a backend zone's user may be compromised, rebuild the VM from the scripts and the backups (§11, §16) before you rotate anything; on a VM the attacker still controls, they read the new key too. Keep the evidence (`aide --check`, `ausearch -k velexis-keys`, the off-VM security logs).
2. **Rotate the KEK** with [section 3](#3-procedure), steps 1 to 9.
3. **Rotate every credential an attacker could have read**, each at its source, so that the stolen copies are worthless. Values entered again are now encrypted under the new KEK only.
   - Encrypted in the database: the Amadeus client secrets of the Velexis account (platform admin) and of each OTA's own connection (the owner rolls them at Amadeus and enters them in the portal), the Stripe secret keys and webhook signing secrets of the payment connections (rolled in the Stripe dashboard, entered again), and the MFA secrets of portal and platform admin accounts (every account enrols again). Short-lived values (e-mail outbox tokens, provisioning reveals) expire by themselves; revoke the sessions and tokens they grant if they are still valid.
   - On the VM ([`deployment-single-vm.md`](../deployment-single-vm.md) §7): the database and Redis passwords, the edge secret, the OTA admin service key and the platform BFF key (through `.provision-secrets` first, as §7 describes); the JWT signing keys (new `kid`); the document URL key; the Stripe keys of the Velexis account and the SMTP credentials in the env files (at the provider first); the deploy SSH key (GitHub `production` environment and `~deploy/.ssh/authorized_keys`).
   - The API key pepper is not rotated in the MVP (ADR-0010): roll every API key instead, which issues new keys hashed with the same pepper.
   - The age private keys of the backups are never on the VM. Rotate them only if the machine that holds them is the compromised one.
4. **Tenant personal data** in the tenant ciphertext columns (identity documents, discount eligibility) cannot be changed by a rotation. Treat its exposure as a personal data breach under the incident response plan.
5. **Back up `/etc/velexis`** again (section 3, step 9) and record what was rotated, when and by whom.

Backup sets taken before the compromise still hold the stolen key and the old secrets until the bucket's retention expires them (14 days, monthly sets 6 months). Their credentials are worthless once step 3 is done; never restore their `/etc/velexis` over the new one.

## 5. Development

Locally the keys are in `.local/keys/` (`pnpm dev:keys`, mode `0600`). To try a rotation: write a new key with `(umask 077; openssl rand -base64 32 > .local/keys/master-v2.key)`, set `MASTER_KEY_CURRENT=local:v2` in `.env`, restart the backends and run `node dist/cli.js secrets:rewrap` in `platform/backend` and in `ota/backend` after `pnpm build`. The helper's behaviour (mixed KEK ids, a concurrent update, a second run) is proven by `pnpm --filter @velexis/crypto test`, and the key step of `provision-vm.sh` by `sudo bash deploy/scripts/test/check-vm.test.sh` (step 5).
