// Test support: the API-only variables of src/config.ts that tests cannot fill with a constant (OBE-011).
//
// - VELEXIS_EDGE_SECRET: 32 random bytes in hex, new in every test process.
// - API_KEY_PEPPER_FILE: a key file as `pnpm dev:keys` writes .local/keys/api-key-pepper (32 random bytes, base64,
//   mode 0600), kept in the package's node_modules/.cache/test-keys/ (ignored by git and ESLint) and reused by every
//   later run of this checkout. The first process that needs it creates it with an exclusive link, so concurrent test
//   processes never replace a pepper another one has already read. Child processes started by a test (the entry
//   points) read the same file.
// - MASTER_KEY_DIR and MASTER_KEY_CURRENT (OBE-017): the same folder, with a `master-v1.key` as `pnpm dev:keys` writes
//   it (32 random bytes, base64, mode 0600), created the same way, and `local:v1`. Tests that store a ciphertext as the
//   platform would (an Amadeus client secret) encrypt it with `testKeyProvider()`.
// - STOREFRONT_BASE_DOMAIN and PUBLIC_OTA_API_URL: the development values of ota/backend/.env.example.
//
// Nothing here is a real secret, and nothing is committed.
import { randomBytes, randomInt } from "node:crypto";
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

/**
 * Creates a key file of `bytes` random bytes (base64, mode 0600) unless it exists; never replaces one. The scratch
 * file's name starts with a dot, so neither LocalFileKeyProvider nor a reader of the final name ever sees it.
 */
function ensureKeyFile(file: string, bytes: number): void {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const scratch = join(KEY_DIR, `.key-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(scratch, `${randomBytes(bytes).toString("base64")}\n`, { mode: 0o600 });
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
    ensureKeyFile(PEPPER_FILE, PEPPER_BYTES);
    ensureKeyFile(MASTER_KEY_FILE, MASTER_KEY_BYTES);
    const pepper = readKeyFile(PEPPER_FILE, { minBytes: PEPPER_BYTES });
    if (!Buffer.isBuffer(pepper)) {
      throw new Error("the test pepper file is not a base64 key file");
    }
    credentials = Object.freeze({
      edgeSecret: randomBytes(32).toString("hex"),
      pepperFile: PEPPER_FILE,
      pepper,
      masterKeyDir: KEY_DIR,
    });
  }
  return credentials;
}

/** The API-only variables of src/config.ts with test values, to merge into an API environment. */
export function testApiVariables(): Readonly<Record<string, string>> {
  const { edgeSecret, pepperFile, masterKeyDir } = testApiCredentials();
  return Object.freeze({
    VELEXIS_EDGE_SECRET: edgeSecret,
    API_KEY_PEPPER_FILE: pepperFile,
    STOREFRONT_BASE_DOMAIN: TEST_STOREFRONT_BASE_DOMAIN,
    PUBLIC_OTA_API_URL: "http://localhost:4000",
    MASTER_KEY_DIR: masterKeyDir,
    MASTER_KEY_CURRENT: TEST_MASTER_KEY_CURRENT,
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
