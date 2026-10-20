// Test support: the API-only variables of src/config.ts that tests cannot fill with a constant (OBE-011).
//
// - VELEXIS_EDGE_SECRET: 32 random bytes in hex, new in every test process.
// - API_KEY_PEPPER_FILE: a key file as `pnpm dev:keys` writes .local/keys/api-key-pepper (32 random bytes, base64,
//   mode 0600), kept in the package's node_modules/.cache/test-keys/ (ignored by git and ESLint) and reused by every
//   later run of this checkout. The first process that needs it creates it with an exclusive link, so concurrent test
//   processes never replace a pepper another one has already read. Child processes started by a test (the entry
//   points) read the same file.
// - MASTER_KEY_DIR and MASTER_KEY_CURRENT (OBE-017, OBE-014): the same folder, with a `master-v1.key` as
//   `pnpm dev:keys` writes it (32 random bytes, base64, mode 0600), created the same way, and `local:v1`. Tests that
//   store a ciphertext as the platform would (an Amadeus client secret), or encrypt or decrypt a ciphertext column as
//   the API does (an idempotent replay), use the KEKs of `testKeyProvider()`.
// - JWT_PRIVATE_KEY_FILE (OBE-031): an Ed25519 private key in PKCS#8 PEM as `pnpm dev:keys` writes
//   .local/keys/ota-jwt-ed25519.pem (mode 0600), in the same folder and created the same way, so tokens one test process
//   signs verify in the applications it starts.
// - STOREFRONT_BASE_DOMAIN and PUBLIC_OTA_API_URL: the development values of ota/backend/.env.example.
// - The worker's variables (`testWorkerVariables`, OBE-030): the same key folder and base domain, and the e-mail
//   settings of ota/backend/.env.example.
//
// Nothing here is a real secret, and nothing is committed.
import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readKeyFile } from "@velexis/config";
import { LocalFileKeyProvider } from "@velexis/crypto";
import { APP_DIR } from "../../src/config";

export interface TestApiCredentials {
  /** The value of VELEXIS_EDGE_SECRET. */
  readonly edgeSecret: string;
  /** The absolute path of the pepper file (API_KEY_PEPPER_FILE). */
  readonly pepperFile: string;
  /** The decoded pepper: what `hashApiKey` of @velexis/crypto takes to compute a key's `key_hash`. */
  readonly pepper: Buffer;
  /** The absolute path of the key folder (MASTER_KEY_DIR) that holds `master-v1.key`. */
  readonly masterKeyDir: string;
  /** The absolute path of the Ed25519 signing key (JWT_PRIVATE_KEY_FILE). */
  readonly jwtKeyFile: string;
}

/** The storefront base domain of the tests: `<key>.ota.example.com` are the tenants' sub-domains. */
export const TEST_STOREFRONT_BASE_DOMAIN = "ota.example.com";

const KEY_DIR = join(APP_DIR, "node_modules", ".cache", "test-keys");
const PEPPER_FILE = join(KEY_DIR, "api-key-pepper");
const PEPPER_BYTES = 32;
/** The KEK of the tests: `master-v1.key` in KEY_DIR, `local:v1`. */
const MASTER_KEY_FILE = join(KEY_DIR, "master-v1.key");
export const TEST_MASTER_KEY_CURRENT = "local:v1";
const MASTER_KEY_BYTES = 32;
/** The token signing key of the tests: `ota-jwt-ed25519.pem` in KEY_DIR. */
const JWT_KEY_FILE = join(KEY_DIR, "ota-jwt-ed25519.pem");

/** `bytes` random bytes in base64, as `pnpm dev:keys` writes a key file. */
const base64Key = (bytes: number) => (): string => `${randomBytes(bytes).toString("base64")}\n`;

/** A new Ed25519 private key as PKCS#8 PEM, as `pnpm dev:keys` writes the signing keys. */
function ed25519Pem(): string {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

/**
 * Creates a key file with the text of `contents` (mode 0600) unless it exists; never replaces one. The scratch file's
 * name starts with a dot, so neither LocalFileKeyProvider nor a reader of the final name ever sees it.
 */
function ensureKeyFile(file: string, contents: () => string): void {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const scratch = join(KEY_DIR, `.key-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(scratch, contents(), { mode: 0o600 });
  try {
    linkSync(scratch, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  } finally {
    rmSync(scratch, { force: true });
  }
}

let credentials: TestApiCredentials | undefined;

/** The credentials of this test process, created on first use. */
export function testApiCredentials(): TestApiCredentials {
  if (credentials === undefined) {
    ensureKeyFile(PEPPER_FILE, base64Key(PEPPER_BYTES));
    ensureKeyFile(MASTER_KEY_FILE, base64Key(MASTER_KEY_BYTES));
    ensureKeyFile(JWT_KEY_FILE, ed25519Pem);
    const pepper = readKeyFile(PEPPER_FILE, { minBytes: PEPPER_BYTES });
    if (!Buffer.isBuffer(pepper)) {
      throw new Error("the test pepper file is not a base64 key file");
    }
    credentials = Object.freeze({
      edgeSecret: randomBytes(32).toString("hex"),
      pepperFile: PEPPER_FILE,
      pepper,
      masterKeyDir: KEY_DIR,
      jwtKeyFile: JWT_KEY_FILE,
    });
  }
  return credentials;
}

/** The API-only variables of src/config.ts with test values, to merge into an API environment. */
export function testApiVariables(): Readonly<Record<string, string>> {
  const { edgeSecret, pepperFile, masterKeyDir, jwtKeyFile } = testApiCredentials();
  return Object.freeze({
    VELEXIS_EDGE_SECRET: edgeSecret,
    API_KEY_PEPPER_FILE: pepperFile,
    JWT_PRIVATE_KEY_FILE: jwtKeyFile,
    STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
    PUBLIC_OTA_API_URL: "http://localhost:4000",
    MASTER_KEY_DIR: masterKeyDir,
    MASTER_KEY_CURRENT: TEST_MASTER_KEY_CURRENT,
  });
}

/** The development sender of ota/backend/.env.example's shape: the notifications module replaces its display name. */
export const TEST_MAIL_FROM = '"Velexis OTA (test)" <no-reply@mail.ota.example.com>';

/**
 * The worker's variables besides the services and the provisioner DSN (OBE-030): the key folder and the storefront
 * base domain it shares with the API, and the e-mail settings with the development values of ota/backend/.env.example
 * (SMTP_URL is Mailpit's development port; a test that sends e-mail passes its own).
 */
export function testWorkerVariables(): Readonly<Record<string, string>> {
  return Object.freeze({
    MASTER_KEY_DIR: testApiCredentials().masterKeyDir,
    MASTER_KEY_CURRENT: TEST_MASTER_KEY_CURRENT,
    STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
    SMTP_URL: "smtp://127.0.0.1:1025",
    MAIL_FROM: TEST_MAIL_FROM,
    OPS_ALERT_EMAIL: "ops@example.com",
    PUBLIC_OTA_ADMIN_URL: "http://localhost:3002",
  });
}

/** The KEKs of MASTER_KEY_DIR as the API loads them: what a test encrypts a platform secret with. */
export function testKeyProvider(): Promise<LocalFileKeyProvider> {
  return LocalFileKeyProvider.fromDir(testApiCredentials().masterKeyDir, TEST_MASTER_KEY_CURRENT);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A fresh API key in the platform's format (PADR-0005 item 1): kind, environment and 40 random base62 characters.
 * Tests build keys at run time; none is ever written into a file.
 */
export function newApiKey(kind: "pk" | "sk" | "hk" = "sk", environment: "test" | "live" = "test"): string {
  let secret = "";
  for (let index = 0; index < 40; index += 1) {
    secret += BASE62[randomInt(BASE62.length)];
  }
  return `${kind}_${environment}_${secret}`;
}

/** `key` with the base62 character at `index` replaced by another one: a key that differs by one character. */
export function withCharacterChanged(key: string, index: number): string {
  const current = key[index] ?? "";
  const replacement = BASE62[(BASE62.indexOf(current) + 1) % BASE62.length] ?? "0";
  return `${key.slice(0, index)}${replacement}${key.slice(index + 1)}`;
}

/** The headers Caddy adds to a storefront's `/api/*` request for `host` (ADR-0018). */
export function edgeHeaders(host = `demo.${TEST_STOREFRONT_BASE_DOMAIN}`): Readonly<Record<string, string>> {
  return Object.freeze({ "X-Velexis-Edge": testApiCredentials().edgeSecret, "X-Velexis-Host": host });
}

/** A CSRF value of the shape `storefront.get` issues (OADR-0006): 256 random bits in base64url, 43 characters. */
export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The headers of a state-changing storefront request (`POST`, `PUT`, `PATCH`, `DELETE`) for `host`, which the CSRF
 * guard accepts (OADR-0006 point 3, OBE-013): Caddy's edge headers, the `__Host-vx_csrf` cookie the browser sends,
 * its copy in `X-CSRF-Token` that the SDK adds, and the browser's `Origin`, the storefront itself.
 */
export function edgeWriteHeaders(
  host = `demo.${TEST_STOREFRONT_BASE_DOMAIN}`,
  csrfToken = newCsrfToken(),
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...edgeHeaders(host),
    Origin: `https://${host}`,
    "X-CSRF-Token": csrfToken,
    Cookie: `__Host-vx_csrf=${csrfToken}`,
  });
}
