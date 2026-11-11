# Runbook: rotating the OTA API's JWT signing key

`/etc/velexis/keys/ota/ota-jwt-ed25519.pem` (`JWT_PRIVATE_KEY_FILE` of `/etc/velexis/ota-backend.env`, `0400 velexis-ota`) signs the OTA API's access tokens (EdDSA, 15 minutes): the customers' (the hosted storefront's `__Host-vx_at` cookie, and the bearer tokens of OTAs' own frontends and servers through the SDK) and the staff's (the OTA admin's console calls). A token's `kid` is the JWK thumbprint of the key's public half ([architecture §3.2](../architecture.md), [ADR-0008](../../../docs/mvp/adr/0008-identity-accounts-customers-sessions.md) "Access tokens"). Refresh tokens do not depend on the key: a customer's are opaque rows of the tenant's `customer_sessions`, a staff member's opaque members of the family `staffsess:<asn_…>` in Redis. Only the API reads the key; the worker signs and verifies no token. The platform's portal and admin tokens have their own key, which [`platform-operations.md`](../../../platform/docs/runbooks/platform-operations.md) §7 rotates (FIX-W48-PLATFORM, the same variable in `platform-backend.env`).

Like every runbook of this folder it is a human procedure: the developer runs the commands on the VM ([README](README.md)); AI agents never do.

## 1. The rule and what is built

**The rule** ([ADR-0010](../../../docs/mvp/adr/0010-secrets-envelope-encryption.md), "Rotation"): JWT keys rotate by `kid`, and the old public key stays valid for one token lifetime, so both keys are accepted for 15 minutes and nobody is signed out by the change.

**As built** (FIX-W48-OTA, lead decision (15f) of 2026-11-11): `TokenService` ([`token.service.ts`](../../backend/src/identity/token.service.ts)) and `StaffTokens` ([`staff-sessions.ts`](../../backend/src/identity/staff/staff-sessions.ts)) sign with `JWT_PRIVATE_KEY_FILE` only and verify a token with the key its `kid` names: the current key, or the previous one of `JWT_PREVIOUS_PUBLIC_KEY_FILE` when that optional variable names a file (the old key's **public** half, SPKI PEM, `0400 velexis-ota`; `PreviousSigningKey` reads it once at start-up). The API refuses to start when the file is missing, readable by others, holds a private key or a key that is not Ed25519, or holds the public half of the current key (the same `kid`); the error names the variable, never a byte of a key ([`config.ts`](../../backend/src/config.ts), `jwtPreviousKeyProblems`). A token of any other `kid`, or one whose signature is not its `kid`'s key, answers `401 UNAUTHENTICATED` (logged as `customer.token_refused` or `staff.token_refused` with the reason `signature`). Without the variable, a token of the old `kid` is such a token.

**What a rotation without the overlap costs.** For up to 15 minutes after the API's restart, every call that presents an access token of the old key answers `401 UNAUTHENTICATED`, also on operations a guest may call (flight searches included, [`customer.guard.ts`](../../backend/src/common/auth/customer.guard.ts)): a storefront customer until the access cookie's `Max-Age` of 900 s ends or the customer signs in again, an SDK caller until it signs in again, a staff member until "Open console" in the portal signs in again. Sessions themselves survive, since refresh tokens do not depend on the key.

## 2. When

| Situation | How |
|---|---|
| A suspected exposure of the key (the VM, the `velexis-ota` user, a copy of `/etc/velexis` or of its backup) | At once, **without the overlap**: skip steps 2 and 5 and leave `JWT_PREVIOUS_PUBLIC_KEY_FILE` unset, so tokens forged with a stolen key stop at the restart. Then read the [PCI incident response plan](../pci/incident-response.md) |
| Someone who had root leaves; planned hygiene | **With the overlap**, at any time; nobody notices |

## 3. Procedure

1. Note the fingerprint of the current public key, move the key out of the zone's folder into a folder only root reads, and let `provision-vm.sh` create a new one. It never overwrites a key file, so it writes only the missing JWT key, `0400 velexis-ota`.

   ```bash
   sudo openssl pkey -in /etc/velexis/keys/ota/ota-jwt-ed25519.pem -pubout | sha256sum      # the old fingerprint
   sudo install -d -m 0700 -o root -g root /root/jwt-rotation
   sudo mv /etc/velexis/keys/ota/ota-jwt-ed25519.pem /root/jwt-rotation/
   sudo bash /srv/velexis/current/deploy/scripts/provision-vm.sh --steps keys
   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only files                    # only PASS lines
   sudo openssl pkey -in /etc/velexis/keys/ota/ota-jwt-ed25519.pem -pubout | sha256sum      # a new fingerprint
   ```

2. **The overlap** (skip it after a suspected exposure): write the old key's public half into the zone's folder, `0400 velexis-ota` like every file there (`check-vm.sh`'s `key_folder`), and add it to the OTA backend's env file with `sudoedit /etc/velexis/ota-backend.env` (it stays `root:root 0600`), as the line of the second block, below `JWT_PRIVATE_KEY_FILE` ([`deploy/env/ota-backend.env.example`](../../../deploy/env/ota-backend.env.example) shows it as a comment):

   ```bash
   sudo openssl pkey -in /root/jwt-rotation/ota-jwt-ed25519.pem -pubout \
     -out /etc/velexis/keys/ota/ota-jwt-ed25519.previous.pub.pem
   sudo chown velexis-ota:velexis-ota /etc/velexis/keys/ota/ota-jwt-ed25519.previous.pub.pem
   sudo chmod 0400 /etc/velexis/keys/ota/ota-jwt-ed25519.previous.pub.pem
   sudo openssl pkey -pubin -in /etc/velexis/keys/ota/ota-jwt-ed25519.previous.pub.pem | sha256sum   # the old fingerprint
   sudoedit /etc/velexis/ota-backend.env                                                            # add the line below
   ```

   ```bash
   JWT_PREVIOUS_PUBLIC_KEY_FILE=/etc/velexis/keys/ota/ota-jwt-ed25519.previous.pub.pem
   ```

3. Restart the API (the worker reads neither file and keeps running) and note the time of the restart:

   ```bash
   sudo systemctl restart velexis-ota-api
   curl -fsS http://127.0.0.1:4000/health/ready; echo
   systemctl show -p ActiveEnterTimestamp velexis-ota-api                                   # the restart
   ```

   If the unit does not start, `sudo journalctl -u velexis-ota-api -n 20 -o cat` names the variable and the key file's problem (never its content). Put the old key back (`sudo mv /root/jwt-rotation/ota-jwt-ed25519.pem /etc/velexis/keys/ota/` after removing the new file, the `.previous.pub.pem` file and the line of step 2), restart, and find the cause before you try again.

4. **Check:** a staff member who was signed in to `https://admin.ota.example.com/` before step 3 keeps working there (with the overlap; without it, the console sends them back to the portal's "Open console"), and a new "Open console" from `https://platform.example.com/` signs in; a customer signed in on a storefront (`https://<key>.ota.example.com/`) stays signed in, and signing in there works. With the overlap, the API logs no `customer.token_refused` or `staff.token_refused` with the reason `signature` beyond the usual:

   ```bash
   journalctl -u velexis-ota-api --since -15min -o cat | jq -cR 'fromjson? | select((.msg == "customer.token_refused" or .msg == "staff.token_refused") and .reason == "signature")' | wc -l
   ```

   Then destroy the old private key at once, since only its public half is needed for the overlap: `sudo shred -u /root/jwt-rotation/ota-jwt-ed25519.pem && sudo rmdir /root/jwt-rotation`.

5. **End the overlap** at least 15 minutes after the API's restart of step 3 (one token lifetime: every token of the old key has expired by then): remove the line of step 2 with `sudoedit`, delete the public key file and restart the API as in step 3. From then on the API refuses every token of the old `kid`, so the old key's copies in older backups of `/etc/velexis` can sign nothing it accepts. An expired token of the old key is then refused as such a token (`401 UNAUTHENTICATED`), not as expired (`401 TOKEN_EXPIRED`), so a client that keeps an access token past its 15 minutes and refreshes only on `TOKEN_EXPIRED` (a browser-only app of an OTA's own frontend that holds the SDK's tokens in memory, [build-your-own-frontend.md](../../frontend/docs/build-your-own-frontend.md) §8.4) gets no automatic refresh and its visitor signs in again; the hosted storefront, the OTA admin and the guide's server sample drop an access token when it expires and refresh as usual.

   ```bash
   sudoedit /etc/velexis/ota-backend.env                                                    # remove the line of step 2
   sudo grep -c '^JWT_PREVIOUS_PUBLIC_KEY_FILE=' /etc/velexis/ota-backend.env              # 0
   sudo rm /etc/velexis/keys/ota/ota-jwt-ed25519.previous.pub.pem
   sudo systemctl restart velexis-ota-api
   curl -fsS http://127.0.0.1:4000/health/ready; echo
   sudo bash /srv/velexis/current/deploy/scripts/check-vm.sh --only files                    # only PASS lines
   ```

6. Back up `/etc/velexis` and replace the offline copy: `sudo systemctl start velexis-backup` ([deployment §3](../../../docs/mvp/deployment-single-vm.md#3-provisioning-a-new-vm) step 8).
7. Record the date, the reason, who did it, whether the overlap was used (and when it ended) and both fingerprints (hashes of public keys, not secrets).

## 4. Escalation

| Level | Who | Takes |
|---|---|---|
| 2 | Velexis ops: the developer | The whole procedure (only they reach the VM) |
| 3 | The product owner | The message to the OTAs when a rotation without the overlap followed a suspected exposure ([README §3](README.md#3-escalation)) |

## 5. Trying it locally

`pnpm dev:keys` writes `.local/keys/ota-jwt-ed25519.pem`. To try a rotation: move that file aside, run `pnpm dev:keys` again (it writes only what is missing), write the old file's public half with `openssl pkey -in <old file> -pubout -out .local/keys/ota-jwt-ed25519.previous.pub.pem` (mode `0600`), set `JWT_PREVIOUS_PUBLIC_KEY_FILE` to it in `ota/backend/.env.local` (the commented line of [`ota/backend/.env.example`](../../backend/.env.example)), and restart `pnpm --filter @velexis/ota-backend dev`. [`jwt-key-rotation.int.test.ts`](../../backend/test/integration/identity/jwt-key-rotation.int.test.ts) runs the same rotation through the API's pipeline.
