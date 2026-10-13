// LocalDiskStorage: the MVP StorageAdapter under STORAGE_DIR (ADR-0017). Atomic writes, files mode 0600.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isTenantSchema } from "../tenant-schema.js";
import type { StorageAdapter, UrlSigner } from "./index.js";

/** Longest accepted storage key. */
export const STORAGE_KEY_MAX_LENGTH = 512;

/** One path segment: letters, digits, `.`, `_`, `-`, never starting with a dot (no hidden or temp names). */
const KEY_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** A media type such as `application/pdf` or `text/csv; charset=utf-8`. */
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\s*;.*)?$/;

/** Thrown for a storage key that breaks the rules of `assertStorageKey`. */
export class StorageKeyError extends Error {
  override readonly name = "StorageKeyError";

  constructor(key: unknown, problem: string) {
    const shown =
      typeof key === "string" ? JSON.stringify(key.length > 80 ? `${key.slice(0, 80)}…` : key) : typeof key;
    super(`Invalid storage key ${shown}: ${problem}`);
  }
}

/**
 * Checks a storage key (db README §5, ADR-0017): `tenant_<key>/…` (a valid tenant schema name) or
 * `platform/…`, then at least one more segment. Segments use letters, digits, `.`, `_` and `-`, never start
 * with a dot, and are never empty, so `..`, absolute paths, backslashes and `//` are all rejected.
 */
export function assertStorageKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key === "") {
    throw new StorageKeyError(key, "it must be a non-empty string");
  }
  if (key.length > STORAGE_KEY_MAX_LENGTH) {
    throw new StorageKeyError(key, `it is longer than ${STORAGE_KEY_MAX_LENGTH} characters`);
  }
  if (key.includes("..")) {
    throw new StorageKeyError(key, 'it must not contain ".."');
  }
  const segments = key.split("/");
  const [prefix] = segments;
  if (prefix !== "platform" && !isTenantSchema(prefix)) {
    throw new StorageKeyError(key, 'it must start with "tenant_<key>/" or "platform/"');
  }
  if (segments.length < 2) {
    throw new StorageKeyError(key, "it needs a name after the prefix");
  }
  if (!segments.every((segment) => KEY_SEGMENT.test(segment))) {
    throw new StorageKeyError(key, "each segment must be [A-Za-z0-9_][A-Za-z0-9._-]*");
  }
}

export interface LocalDiskStorageOptions {
  /**
   * Builds the download URL of a key that expires at `expiresAt`. The OTA backend passes its HMAC-signed
   * `/v1/files/<key>?exp=…&sig=…` link (ADR-0017). Without it `signedUrl` throws.
   */
  readonly signUrl?: UrlSigner | undefined;
  /** The clock of `signedUrl`. Default: the system clock. */
  readonly now?: (() => Date) | undefined;
}

/**
 * Stores objects as files under one directory (`STORAGE_DIR`, `/var/lib/velexis/storage` on the VM). A
 * key's segments become sub-directories (mode 0700). `put` writes a temporary file in the target directory,
 * flushes it and renames it over the target, so readers see the old or the new content, never a part. Every
 * file has mode 0600.
 */
export class LocalDiskStorage implements StorageAdapter {
  readonly #root: string;
  readonly #signUrl: UrlSigner | undefined;
  readonly #now: () => Date;

  constructor(dir: string, options: LocalDiskStorageOptions = {}) {
    if (typeof dir !== "string" || dir.trim() === "") {
      throw new TypeError("LocalDiskStorage: dir must be a non-empty directory path");
    }
    this.#root = resolve(dir);
    this.#signUrl = options.signUrl;
    this.#now = options.now ?? (() => new Date());
  }

  /** The absolute storage directory. */
  get root(): string {
    return this.#root;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const file = this.#fileOf(key);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("LocalDiskStorage.put: bytes must be a Uint8Array or a Buffer");
    }
    if (typeof contentType !== "string" || !CONTENT_TYPE.test(contentType)) {
      throw new TypeError("LocalDiskStorage.put: contentType must be a media type such as application/pdf");
    }
    const directory = dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.chmod(0o600); // also when a umask narrowed the owner bits
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, file);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true });
      throw error;
    }
    await syncDirectory(directory);
  }

  async get(key: string): Promise<Buffer | null> {
    const file = this.#fileOf(key);
    try {
      return await readFile(file);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.#fileOf(key);
    try {
      await rm(file);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return new Promise((resolveUrl) => {
      resolveUrl(this.#urlFor(key, ttlSeconds));
    });
  }

  #urlFor(key: string, ttlSeconds: number): string {
    assertStorageKey(key);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new TypeError("LocalDiskStorage.signedUrl: ttlSeconds must be a positive integer");
    }
    if (this.#signUrl === undefined) {
      throw new Error(
        "LocalDiskStorage.signedUrl needs the signUrl option (signed /v1/files URLs, ADR-0017)",
      );
    }
    return this.#signUrl(key, new Date(this.#now().getTime() + ttlSeconds * 1000));
  }

  /** The file of a valid key, checked once more to lie inside the storage directory. */
  #fileOf(key: string): string {
    assertStorageKey(key);
    const file = join(this.#root, ...key.split("/"));
    const inside = relative(this.#root, file);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new StorageKeyError(key, "it resolves outside the storage directory");
    }
    return file;
  }
}

/** Flushes a directory entry change (the rename) to disk. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A missing file, or a path through a missing directory or a file (`tenant_a/x.pdf/y`). */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
