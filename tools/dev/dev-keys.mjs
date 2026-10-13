#!/usr/bin/env node
// dev-keys.mjs: create the local key files of ADR-0010 ("Key material") in the ignored .local/ folder (X-016).
//
// Usage (plain Node 22, no dependencies; it writes the repository's .local/ whatever the current folder):
//   pnpm dev:keys                                 # from the repository root; = node tools/dev/dev-keys.mjs
//   node tools/dev/dev-keys.mjs --force           # replace existing key files (old local ciphertext is lost)
//   node tools/dev/dev-keys.mjs --root <dir>      # write <dir>/.local/ instead of the repository's (tests)
//
// Creates .local/keys/ (0700) with five files (0600) and .local/storage/ (0700). An existing file is never
// overwritten without --force; a second run changes nothing. Key material is never printed.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 32 random bytes, base64, with a trailing newline (like `head -c 32 /dev/urandom | base64` on the VM). */
const randomKey = () => `${randomBytes(32).toString("base64")}\n`;

/** Ed25519 private key as PKCS#8 PEM (like `openssl genpkey -algorithm ed25519` on the VM). */
const ed25519Pem = () =>
  generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;

/** The key files, the variables of .env.example that point at them, and how to make each one. */
const KEY_FILES = [
  { name: "master-v1.key", env: "MASTER_KEY_DIR + MASTER_KEY_CURRENT=local:v1", create: randomKey },
  { name: "api-key-pepper", env: "API_KEY_PEPPER_FILE", create: randomKey },
  { name: "document-url.key", env: "DOCUMENT_URL_KEY_FILE", create: randomKey },
  { name: "platform-jwt-ed25519.pem", env: "JWT_PRIVATE_KEY_FILE (platform backend)", create: ed25519Pem },
  { name: "ota-jwt-ed25519.pem", env: "JWT_PRIVATE_KEY_FILE (ota/backend/.env.local)", create: ed25519Pem },
];

const USAGE = "usage: node tools/dev/dev-keys.mjs [--force] [--root <dir>]";

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { force: false, root: REPO_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      options.force = true;
    } else if (arg === "--root" && i + 1 < argv.length) {
      i += 1;
      options.root = path.resolve(argv[i]);
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new UsageError(`unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
}

/** Creates the key folder (and a missing .local/) with mode 0700, or tightens the mode of an existing one. */
function ensureKeysDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700);
  }
}

/**
 * Writes a new file with mode 0600. Without `replace` it fails if the path exists (O_EXCL). With `replace` the
 * content goes to a fresh 0600 temporary file that is renamed over the old one, so the key is never readable
 * by others, not even for a moment.
 */
function writeSecret(file, content, replace) {
  if (!replace) {
    writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600); // a restrictive umask may have removed the owner's write bit
    return;
  }
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const localDir = path.join(options.root, ".local");
  const keysDir = path.join(localDir, "keys");
  const storageDir = path.join(localDir, "storage");
  const shown = (p) => path.relative(options.root, p) || ".";

  ensureKeysDir(keysDir);
  const counts = { created: 0, replaced: 0, kept: 0 };

  for (const key of KEY_FILES) {
    const file = path.join(keysDir, key.name);
    const exists = existsSync(file);
    if (exists && !options.force) {
      const mode = statSync(file).mode & 0o777;
      if (mode & 0o077) {
        chmodSync(file, 0o600);
        console.log(`kept     ${shown(file)} (mode ${mode.toString(8)} tightened to 600)`);
      } else {
        console.log(`kept     ${shown(file)}`);
      }
      counts.kept += 1;
      continue;
    }
    writeSecret(file, key.create(), exists);
    console.log(`${exists ? "replaced" : "created "} ${shown(file)}  for ${key.env}`);
    counts[exists ? "replaced" : "created"] += 1;
  }

  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  console.log(`ready    ${shown(storageDir)}/  for STORAGE_DIR`);
  console.log(
    `\n${KEY_FILES.length} key files in ${shown(keysDir)}/: ${counts.created} created, ${counts.replaced} replaced, ` +
      `${counts.kept} kept${counts.kept > 0 ? " (--force replaces existing files)" : ""}.`,
  );
  if (counts.replaced > 0) {
    console.log(
      "Replaced keys invalidate local data protected by the old ones (encrypted columns, API keys, tokens, " +
        "signed URLs): reset the local database if the apps fail to decrypt.",
    );
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`dev-keys: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  console.error(`dev-keys: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
