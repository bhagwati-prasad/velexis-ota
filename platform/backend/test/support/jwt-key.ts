// Key files for tests that build the platform backend's configuration (JWT_PRIVATE_KEY_FILE, PBE-012). Each call
// writes a fresh key into its own temporary folder with mode 0600, as `pnpm dev:keys` writes the development key, so
// tests never depend on `.local/keys/` or share a file. The keys are generated on the spot and are no secret.
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A key file in its own temporary folder. */
export interface TestKeyFile {
  /** The absolute path, for JWT_PRIVATE_KEY_FILE. */
  readonly path: string;
  /** The PEM text written to it. */
  readonly pem: string;
  /** Deletes the folder. */
  remove(): void;
}

/** A new Ed25519 private key as PKCS#8 PEM, like `openssl genpkey -algorithm ed25519` and `pnpm dev:keys`. */
export function ed25519PrivateKeyPem(): string {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

/** Writes `pem` to a new temporary file with `mode` (default 0600, what readKeyFile accepts). */
export function writeTestKeyFile(pem: string, mode = 0o600): TestKeyFile {
  const dir = mkdtempSync(join(tmpdir(), "velexis-platform-jwt-"));
  const path = join(dir, "platform-jwt-ed25519.pem");
  writeFileSync(path, pem, { mode });
  // The umask may have removed bits from `mode`; set exactly what the test asked for.
  chmodSync(path, mode);
  return {
    path,
    pem,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A new Ed25519 JWT signing key in a temporary file of mode 0600. */
export function createTestJwtKeyFile(): TestKeyFile {
  return writeTestKeyFile(ed25519PrivateKeyPem());
}
