# SSH access to the VM

This runbook covers how people and the deploy job log in to the Velexis VM over SSH: the admin user's second factor (PCI DSS 8.4.2) and the `deploy` user as a system account (PCI DSS 8.6), as [ADR-0027](../adr/0027-pci-scope-and-vm-controls.md) decides. Task X-037 in [`../plans/foundation-tasks.md`](../plans/foundation-tasks.md) wrote it, with the step `ssh` of [`provision-vm.sh`](../../../deploy/scripts/provision-vm.sh) and the `ssh` group of [`check-vm.sh`](../../../deploy/scripts/check-vm.sh).

Related: [`deployment-single-vm.md`](../deployment-single-vm.md) §2 (hardening) and §3 (provisioning); [ADR-0023](../adr/0023-release-artefact-and-deploy-user.md) (the deploy user); [`plans/roadmap.md`](../plans/roadmap.md) §4.1 (MFA on every account).

It is a human procedure on the VM. AI agents never run it ([`AGENTS.md`](../../../AGENTS.md) §8: no production access).

## 1. What is enforced

| User | How it logs in | Set by |
|---|---|---|
| The admin user (`ADMIN_USER`, `ubuntu` on most cloud images) | `ADMIN_MFA=fido2` (the default): only FIDO2 keys (`sk-ssh-ed25519@openssh.com`), each signature with a touch and user verification (`verify-required`: the key's PIN). `ADMIN_MFA=totp`: an SSH key, then a TOTP code from an authenticator app. Never a password. | `/etc/ssh/sshd_config.d/01-velexis-mfa.conf`; for TOTP also `/etc/pam.d/sshd` |
| `deploy` | Public key only (the GitHub Actions deploy key, with `restrict`), no TTY, no forwarding; `sudo` for `velexis-deploy` only. Nobody logs in as `deploy` by hand. | `01-velexis-mfa.conf`, `provision-vm.sh --steps users` |
| Everyone else, `root` included | Refused (`AllowUsers <admin> deploy`, `PermitRootLogin no`, keys only). | `/etc/ssh/sshd_config.d/00-velexis.conf` (X-020) |

Both users' keys are read only from `~/.ssh/authorized_keys` (`AuthorizedKeysFile`), the file `check-vm.sh` checks.

**Which factor.** Prefer FIDO2: it cannot be phished or copied, and the same security keys protect GitHub, the cloud console and the other accounts of roadmap §4.1. Your computer's OpenSSH must support security keys (OpenSSH 8.2 or later with FIDO support; Linux distributions have it; Apple's own `ssh` on macOS has no built-in security key support, so use OpenSSH from Homebrew there). Choose TOTP when your computer cannot use a security key with SSH.

**How `provision-vm.sh` avoids a lockout.** The step `ssh` (also part of `harden`):

1. refuses to apply the second factor while the admin has none enrolled: it prints why and the enrolment steps, leaves every sshd and PAM file as it is, and `check-vm.sh` reports `FAIL` until the factor is applied;
2. checks a copy of the whole sshd configuration with the new files before it writes anything: `sshd -t`, then `sshd -T -C user=<admin>` and `sshd -T -C user=deploy` must show the second factor and the deploy limits (another file in `sshd_config.d` that would win is caught here);
3. writes the files, runs `sshd -t` on the real configuration (and puts the previous files back if it fails), then reloads `ssh`. A reload never closes an open session.

**It never locks out the person who runs it** (lead decision (13k) of 2026-11-10). Run through `sudo`, `provision-vm.sh` takes you from `SUDO_USER`:

- **Before any step**, a run with `harden` or `ssh` (a full run included) refuses, changes nothing and exits 1 when you are not one of the two users the new `AllowUsers` lets in, `ADMIN_USER` and `DEPLOY_USER`: `refused, nothing changed: you run this through sudo as <you>, but the new SSH settings let only ubuntu and deploy log in (AllowUsers), so <you> would lose SSH access`. Run it as the admin, pass `ADMIN_USER=<you>` if you are to be the admin from now on, or run it from the provider's console (§5).
- **Before it writes anything**, the step `ssh` also refuses, the same way, when the second factor it applies would ask you for a factor you have not enrolled: it reads `sshd -T -C user=<you>` of the copy of point 2, and a TOTP code needs your own `~/.google_authenticator` (and the PAM module), only FIDO2 keys need one with `verify-required` in your `~/.ssh/authorized_keys`. The message names the factor and what is missing: enrol it (§2 or §3) and run the step again.
- A root session without `sudo`, such as the provider's console, has no `SUDO_USER` and is not checked (nor is root's own `sudo`): nobody logs in over SSH as root, and the console stays reachable whatever sshd allows.
- So run it with `sudo` itself: a shell from `sudo -i` keeps `SUDO_USER`, but one from `sudo su -` loses it and is not checked, like the console.
- **Before any step**, the same run also refuses, changes nothing and exits 1 when `SSH_ALLOW_FROM` is a range and the SSH login behind the run comes from outside it (lead decision (15d) of 2026-11-11). `SSH_ALLOW_FROM` is `any` by default (the GitHub-hosted deploy runners have changing addresses); set to an IPv4 or IPv6 address or range (CIDR such as `198.51.100.0/24` or `2001:db8::/48`), the step `harden` lets SSH in only from it (`ufw allow from <range> to any port 22`), which would cut you off at your next login, or at once, from anywhere else: `refused, nothing changed: you are logged in over SSH from 203.0.113.7, which SSH_ALLOW_FROM=198.51.100.0/24 does not include, so its firewall rule (the step harden) would lock you out`. Pass a range that includes your address, run it from inside the range, or from the provider's console.
  - Where it reads your address: `SSH_CONNECTION` of the session (a root session over SSH has it; `sudo` drops it unless you run `sudo --preserve-env=SSH_CONNECTION …`), else the remote host that `who -m` names for your terminal (an SSH login through `sudo` in a terminal). An IPv4-mapped IPv6 address (`::ffff:198.51.100.7`) counts as its IPv4 address; an IPv6 login never matches an IPv4 range, nor the reverse, because the firewall keeps the two families apart.
  - A session without an SSH login is let through: the provider's console, a local console terminal (`who -m` names no remote host), a root session without a terminal or SSH.
  - It refuses when it cannot tell: through `sudo` without a terminal and without `SSH_CONNECTION` (`ssh vm 'sudo …'`; use `ssh -t` or `sudo --preserve-env=SSH_CONNECTION`), or when `who -m` names a remote host that is no address (a `tmux` or `mosh` session; keep `SSH_CONNECTION` the same way). A malformed `SSH_ALLOW_FROM` is refused too.
  - It checks only your own login, when you run the script. A narrowed `SSH_ALLOW_FROM` also shuts out the deploy job's GitHub-hosted runners, whose addresses change, unless the range holds them: `any` (with `ufw limit`) is the default for that reason.

Pass the same `ADMIN_MFA` on every later run of `harden` or `ssh`. A run with the other value switches only when that factor is enrolled too; otherwise the factor in force stays.

## 2. Enrol a FIDO2 key (`ADMIN_MFA=fido2`)

You need two FIDO2 security keys, a primary and a backup, each with a FIDO2 PIN set (with the vendor's tool, for example `ykman fido access change-pin` for a YubiKey). Keep one SSH session as the admin open on the VM until step 7.

1. On your computer, create one SSH key per security key (the backup key plugged in for the second command):

   ```bash
   ssh-keygen -t ed25519-sk -O verify-required -O resident -O application=ssh:velexis -C "you velexis primary" -f ~/.ssh/id_velexis_sk
   ssh-keygen -t ed25519-sk -O verify-required -O resident -O application=ssh:velexis -C "you velexis backup" -f ~/.ssh/id_velexis_sk_backup
   ```

   `verify-required` makes the key ask for its PIN at every login; `resident` keeps the key handle on the security key, so `ssh-keygen -K` restores it on another computer. Never add `-O no-touch-required`.

2. Put both public keys into the admin's `~/.ssh/authorized_keys` on the VM, each line starting with the option `verify-required`. Keep your current key for now:

   ```bash
   sed 's/^/verify-required /' ~/.ssh/id_velexis_sk.pub ~/.ssh/id_velexis_sk_backup.pub   # on your computer: the two lines to append
   ```

3. From a second terminal, log in with each security key (PIN, then a touch). sshd already enforces `verify-required` on those lines:

   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_velexis_sk ubuntu@<vm>
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_velexis_sk_backup ubuntu@<vm>
   ```

4. Apply the second factor (on a new VM before the first release, use the copy in `/tmp/deploy/` instead):

   ```bash
   sudo ADMIN_USER=ubuntu ADMIN_MFA=fido2 bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps ssh
   ```

   It prints `SSH settings changed: 01-velexis-mfa.conf` and `The second factor of ubuntu is on`.

5. Keep the first session open. From a second terminal, check both directions: the plain key is refused (`Permission denied (publickey)`), each security key logs in.

   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 ubuntu@<vm>        # refused
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_velexis_sk ubuntu@<vm>     # logs in
   ```

   If the security key is refused too, undo the change from the open session ([§5](#5-break-glass)) before you do anything else.

6. Remove the plain key's line from `~/.ssh/authorized_keys`. sshd refuses it already, and `check-vm.sh` reports it as `FAIL` while it is there.
7. Check: `sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only ssh` shows only `PASS` lines. Then close the first session.
8. Keep the backup security key apart from the primary one, with the offline password manager's recovery material.

## 3. Enrol a TOTP secret (`ADMIN_MFA=totp`)

The package `libpam-google-authenticator` comes with the step `packages` (on a VM provisioned before X-037: `sudo apt-get install libpam-google-authenticator`). Keep one SSH session as the admin open on the VM until step 4.

1. Logged in as the admin on the VM:

   ```bash
   google-authenticator -t -d -f -r 3 -R 30 -w 3 -i Velexis -l "ubuntu@velexis"
   ls -l ~/.google_authenticator    # -r-------- and the admin as owner
   ```

   `-t` time-based codes, `-d` each code works once, `-r 3 -R 30` at most three logins per 30 seconds, `-w 3` one code either side for clock drift, `-f` write the file without asking. Scan the QR code into an authenticator app, type one code to confirm it, and keep the five emergency scratch codes in the offline password manager (each one works once instead of a code). The secret never leaves `~/.google_authenticator`; `provision-vm.sh` and `check-vm.sh` never print it.

2. Apply the second factor:

   ```bash
   sudo ADMIN_USER=ubuntu ADMIN_MFA=totp bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps ssh
   ```

   Besides `01-velexis-mfa.conf` it changes `/etc/pam.d/sshd`: the line `@include common-auth` (the password) becomes a comment, preceded by `auth required pam_google_authenticator.so` (without `nullok`, so a login without a code fails).

3. From a second terminal: `ssh ubuntu@<vm>` takes your key, then asks `Verification code:`. A wrong code is refused.
4. Check: `sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only ssh` shows only `PASS` lines. Then close the first session.

## 4. A second key, a lost key, a new computer

- **Add a key** (a replacement, or a third one): steps 1 to 3 of [§2](#2-enrol-a-fido2-key-admin_mfafido2) with a session open. No run of `provision-vm.sh` is needed: the drop-in already requires FIDO2 for every key of the admin.
- **A lost or stolen security key**: log in with the backup key, list the keys with `ssh-keygen -lf ~/.ssh/authorized_keys` (fingerprint and comment per line), delete the lost key's line, and run `check-vm.sh --only ssh`. Then enrol a replacement, so two keys exist again. Record the date and the removed fingerprint in the operations log.
- **A lost phone (TOTP)**: log in with an emergency scratch code instead of a code, run `google-authenticator` again as in [§3](#3-enrol-a-totp-secret-admin_mfatotp) (a new secret: codes of the lost phone stop working at once), scan it into the new phone and replace the stored scratch codes.
- **A new computer**: with the security key plugged in, `ssh-keygen -K` writes its resident key (`id_ed25519_sk_rk_*`) into the current folder; move it to `~/.ssh/`.

## 5. Break-glass

**Right after applying, from the session still open.** If the new login fails in [§2](#2-enrol-a-fido2-key-admin_mfafido2) step 5 or [§3](#3-enrol-a-totp-secret-admin_mfatotp) step 3, take the drop-in out and reload, find the cause, then apply it again the same day:

```bash
sudo mv /etc/ssh/sshd_config.d/01-velexis-mfa.conf /root/ && sudo systemctl reload ssh
journalctl -u ssh -n 50 --no-pager                       # why the login was refused
sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only ssh
```

**When no admin login works** (both security keys lost, the PIN locked, the phone and the scratch codes lost, sshd not starting): use the provider's console.

Prepare it once, when the VM is new:

- MFA on the cloud provider's account ([`plans/roadmap.md`](../plans/roadmap.md) §4.1): the console is reachable only through it.
- A local password for the admin user, long and random, kept only in the offline password manager (`sudo passwd ubuntu`). SSH never accepts it (`PasswordAuthentication no`, and the drop-in's `AuthenticationMethods`); it works only on the provider's console. If the provider offers no console login, learn its rescue system (boot a rescue image and mount the disk) instead.

Then, in an emergency:

1. Sign in to the provider's account (with its MFA), open the VM's console and log in as the admin with that password.
2. Restore a second factor rather than removing it: append a new security key's line to `~/.ssh/authorized_keys` ([§2](#2-enrol-a-fido2-key-admin_mfafido2) steps 1 and 2), or run `google-authenticator` again ([§3](#3-enrol-a-totp-secret-admin_mfatotp) step 1). A damaged drop-in or `/etc/pam.d/sshd` is rewritten by `provision-vm.sh --steps ssh` with the same `ADMIN_MFA`.
3. Only if sshd does not start at all: move `01-velexis-mfa.conf` to `/root/`, run `sudo sshd -t && sudo systemctl restart ssh`, and put the second factor back the same day with `--steps ssh`. Until then the admin logs in with a key alone, which `check-vm.sh` reports as `FAIL`.
4. Log in over SSH from your computer, run `check-vm.sh --only ssh`, close the console, and change the console password (store the new one).
5. Record the event: date, cause, what changed.

## 6. The deploy user

`deploy` is a system account (PCI DSS 8.6): its password is locked, its single key carries `restrict`, it logs in by public key only, without a TTY or any forwarding, and `sudo` lets it run only `/usr/local/sbin/velexis-deploy`. Only the Deploy workflow uses it, with the private key in the GitHub `production` environment secret `DEPLOY_SSH_KEY` ([ADR-0023](../adr/0023-release-artefact-and-deploy-user.md)).

To rotate the deploy key: create a new pair (`ssh-keygen -t ed25519 -f velexis-deploy -C github-actions`), copy the `.pub` file to the VM, run `sudo DEPLOY_SSH_PUBKEY_FILE=/tmp/velexis-deploy.pub bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps users` (it replaces the one key), replace `DEPLOY_SSH_KEY` in GitHub, and run the Deploy workflow once.

## 7. Checking

`check-vm.sh --only ssh` (on the VM, as root) prints, among the global settings:

- `PASS sshd -T: AllowUsers ubuntu deploy`
- `PASS sshd -T -C user=ubuntu: second factor FIDO2 (…)` or `… second factor TOTP (…)`, then `keys only from .ssh/authorized_keys`, and either `every key of ubuntu is a FIDO2 key (sk-ssh-ed25519) with verify-required (2)` or the TOTP secret file and `/etc/pam.d/sshd asks for the TOTP code`
- `PASS sshd -T -C user=deploy: public key only (authenticationmethods publickey)`, `… no TTY and no forwarding (…)` and `… keys only from .ssh/authorized_keys`

Every user of `AllowUsers` other than `deploy` counts as an admin and needs the second factor. [`deploy/scripts/test/check-vm.test.sh`](../../../deploy/scripts/test/check-vm.test.sh) tests the step `ssh`, its lockout guard (§1) and these checks (with a real `sshd` when one works on the machine); CI's `check-vm` job runs it as root with the real `sshd` of `openssh-server` (lead decision (13l) of 2026-11-10).

**The acceptance check of X-037 on the throwaway VM** (a human step): enrol as in §2 (or §3), then show that an admin login with a plain ed25519 key alone is refused and one with the FIDO2 key (or the key and a TOTP code) succeeds, that `check-vm.sh --only ssh` shows only `PASS` lines, and that the Deploy workflow still deploys. Keep the terminal outputs with the rehearsal outputs of [`deployment-single-vm.md`](../deployment-single-vm.md) §3.
