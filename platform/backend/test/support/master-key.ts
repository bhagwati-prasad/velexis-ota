// Key folders and e-mail settings for tests that build the platform backend's configuration (MASTER_KEY_DIR and
// MASTER_KEY_CURRENT, SMTP_URL, MAIL_FROM, OPS_ALERT_EMAIL, PUBLIC_PORTAL_URL, PUBLIC_PLATFORM_ADMIN_URL; PBE-011;
// API_KEY_PEPPER_FILE, PBE-021; and PUBLIC_OTA_ADMIN_URL, PBE-039). Each call of `createTestMasterKeyDir` writes a
// fresh KEK `master-v1.key` and a fresh API key pepper `api-key-pepper` (32 random bytes in base64 each, mode 0600) into
// its own temporary folder (mode 0700), as `pnpm dev:keys` writes the development keys and provision-vm.sh the platform
// zone's folder, so tests never depend on `.local/keys/` or share a key. The keys are generated on the spot and are no
// secret.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The KEK id of the key in a test key folder. */
export const TEST_MASTER_KEY_CURRENT = "local:v1";

/** A key folder in a temporary directory. */
export interface TestMasterKeyDir {
  /** The absolute path, for MASTER_KEY_DIR. */
  readonly path: string;
  /** `local:v1`, for MASTER_KEY_CURRENT. */
  readonly current: string;
  /** The absolute path of the folder's `api-key-pepper`, for API_KEY_PEPPER_FILE. */
  readonly pepperFile: string;
  /** Deletes the folder. */
  remove(): void;
}

/** Writes 32 random bytes in base64 into `file`, mode 0600. */
function writeRandomKey(file: string): void {
  writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  // The umask may have removed bits; set exactly what LocalFileKeyProvider and readKeyFile accept.
  chmodSync(file, 0o600);
}

/** A new folder with a fresh `master-v1.key` and a fresh `api-key-pepper`, both of mode 0600. */
export function createTestMasterKeyDir(): TestMasterKeyDir {
  const dir = mkdtempSync(join(tmpdir(), "velexis-platform-keys-"));
  chmodSync(dir, 0o700);
  writeRandomKey(join(dir, "master-v1.key"));
  const pepperFile = join(dir, "api-key-pepper");
  writeRandomKey(pepperFile);
  return {
    path: dir,
    current: TEST_MASTER_KEY_CURRENT,
    pepperFile,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * The e-mail settings and public URLs of `platform/backend/.env.example` (development values, dummies): Mailpit's SMTP
 * port, a sender and an ops address on the example domains, and the local portal, platform admin and OTA admin.
 */
export const TEST_MAIL_ENV = Object.freeze({
  SMTP_URL: "smtp://127.0.0.1:1025",
  MAIL_FROM: '"Velexis" <no-reply@mail.platform.example.com>',
  OPS_ALERT_EMAIL: "ops@example.com",
  PUBLIC_PORTAL_URL: "http://localhost:3000",
  PUBLIC_PLATFORM_ADMIN_URL: "http://localhost:3001",
  PUBLIC_OTA_ADMIN_URL: "http://localhost:3002",
});

/** TEST_MAIL_ENV and the key folder's MASTER_KEY_DIR, MASTER_KEY_CURRENT and API_KEY_PEPPER_FILE. */
export function testCryptoAndMailEnv(keys: TestMasterKeyDir): Record<string, string> {
  return {
    ...TEST_MAIL_ENV,
    MASTER_KEY_DIR: keys.path,
    MASTER_KEY_CURRENT: keys.current,
    API_KEY_PEPPER_FILE: keys.pepperFile,
  };
}
