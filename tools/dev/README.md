# Local development tools

Plain Node and Bash scripts for a developer machine, with no dependencies and no workspace package. The key script is part of the one-time setup in [`docs/mvp/local-development.md`](../../docs/mvp/local-development.md) §2; `stripe-listen.sh` belongs to §6. The PostgreSQL and Redis half of that setup is [`deploy/scripts/dev-setup.sh`](../../deploy/scripts/dev-setup.sh). Both were written in task X-016 of [`docs/mvp/plans/foundation-tasks.md`](../../docs/mvp/plans/foundation-tasks.md).

| File | What it does |
|---|---|
| `dev-keys.mjs` | Creates the local key files and the storage folder in the ignored `.local/` folder (`pnpm dev:keys`) |
| `dev-keys.test.mjs` | Its tests, for the Node test runner (`node --test tools/dev/dev-keys.test.mjs`) |
| `stripe-listen.sh` | Forwards Stripe test-mode webhooks to the local OTA and platform APIs with the Stripe CLI and prints the `whsec_` lines for `.env.local` (task X-028, from M3; documented in [`local-development.md`](../../docs/mvp/local-development.md) §6). Bash, checked with `shellcheck -S style` |

## `dev-keys.mjs`

```bash
pnpm dev:keys                                  # from the repository root; same as: node tools/dev/dev-keys.mjs
node tools/dev/dev-keys.mjs --force            # replace every key file
node tools/dev/dev-keys.mjs --root /tmp/x      # write /tmp/x/.local/ instead of the repository's (used by the tests)
```

It creates `.local/keys/` with mode `0700` and these five files, each with mode `0600`. They are the local stand-ins for the key files that [`provision-vm.sh`](../../deploy/scripts/provision-vm.sh) (`step_keys`) creates on the VM ([ADR-0010](../../docs/mvp/adr/0010-secrets-envelope-encryption.md), "Key material on the VM"):

| File | Content | Used through (`.env.example`) |
|---|---|---|
| `master-v1.key` | 32 random bytes, base64: the envelope-encryption KEK with the id `local:v1` | `MASTER_KEY_DIR`, `MASTER_KEY_CURRENT=local:v1` |
| `api-key-pepper` | 32 random bytes, base64: the HMAC pepper of API key hashes | `API_KEY_PEPPER_FILE` |
| `document-url.key` | 32 random bytes, base64: the HMAC key of signed document URLs (OTA backend only) | `DOCUMENT_URL_KEY_FILE` |
| `platform-jwt-ed25519.pem` | Ed25519 private key, PKCS#8 PEM: portal and platform admin tokens | `JWT_PRIVATE_KEY_FILE` (root `.env.local`) |
| `ota-jwt-ed25519.pem` | Ed25519 private key, PKCS#8 PEM: staff and customer tokens | `JWT_PRIVATE_KEY_FILE` in `ota/backend/.env.local` |

It also creates `.local/storage/` (`STORAGE_DIR`, mode `0700`) for the local storage driver ([ADR-0017](../../docs/mvp/adr/0017-email-documents-storage.md)).

Rules:

- **It never overwrites an existing file without `--force`.** A second run changes nothing and reports every file as `kept`. Missing files are created next to existing ones.
- An existing key file that group or others can read is tightened to `0600`, because `@velexis/config` refuses such files. Its content is kept.
- `--force` writes each new key to a fresh `0600` temporary file and renames it over the old one, so a key is never readable by others, not even for a moment. Replacing keys makes local data protected by the old ones unreadable: encrypted columns, API key hashes, issued tokens and signed URLs. Reset the local database afterwards (`docs/mvp/local-development.md` §3, "To start over").
- It never prints key material, and `.local/` is in `.gitignore`. Never commit or share these files, and never copy them to a server: the VM generates its own keys.
- The paths in `.env.example` are relative to the repository root, where `.local/` is.

Exit codes: `0` success, `1` failure (for example a file system error), `2` unknown argument.

## Tests

```bash
node --test tools/dev/dev-keys.test.mjs
```

The tests run the script as a child process against temporary folders. They check the five files, the modes, the key formats, that a second run keeps every file unchanged, `--force`, the tightening of loose modes, and that no key material is printed. The `dev-setup` job of [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs them, and then runs `docs/mvp/local-development.md` §2 on a clean `ubuntu-24.04` runner: `dev-setup.sh` twice and `dev-keys.mjs` twice.
