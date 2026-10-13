import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DATA_KEY_BYTES,
  DecryptionError,
  KeyProviderError,
  WRAPPED_DATA_KEY_BYTES,
  type KeyProvider,
  type WrappedDataKey,
} from "./key-provider.js";

/** `MASTER_KEY_CURRENT` and every KEK id of this provider: `local:v<N>`, N >= 1 without leading zeros. */
const KEK_ID = /^local:v([1-9][0-9]{0,8})$/;
/** The file of KEK `local:v<N>`. */
const KEY_FILE = /^master-v([1-9][0-9]{0,8})\.key$/;
const KEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// O_NONBLOCK keeps a FIFO named by mistake from blocking start-up; it changes nothing for regular files.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
}

/** Decodes strict base64 (surrounding whitespace and line breaks allowed); `undefined` when it is not base64. */
function decodeBase64(text: string): Buffer | undefined {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64.test(compact)) {
    return undefined;
  }
  return Buffer.from(compact, "base64");
}

/** Reads one `master-v<N>.key` file: a regular file, no access for group or others, 32 bytes in base64. */
async function readKek(path: string): Promise<KeyObject> {
  let handle: FileHandle;
  try {
    handle = await open(path, OPEN_FLAGS);
  } catch (error) {
    throw new KeyProviderError(`Key file ${path} cannot be opened by this process (${errorCode(error)})`);
  }

  let content: Buffer;
  try {
    // The checks and the read use the same descriptor, so the file cannot be swapped in between.
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new KeyProviderError(`Key file ${path} is not a regular file`);
    }
    if ((stats.mode & 0o077) !== 0) {
      const mode = (stats.mode & 0o777).toString(8).padStart(4, "0");
      throw new KeyProviderError(
        `Key file ${path} grants access to group or others (mode ${mode}); restrict it to mode 0400 or 0600`,
      );
    }
    content = await handle.readFile();
  } finally {
    await handle.close();
  }

  const key = decodeBase64(content.toString("utf8"));
  content.fill(0);
  if (key === undefined) {
    throw new KeyProviderError(`Key file ${path} is not valid base64`);
  }
  if (key.length !== KEK_BYTES) {
    key.fill(0);
    throw new KeyProviderError(`Key file ${path} must hold exactly ${KEK_BYTES} bytes after base64 decoding`);
  }
  const kek = createSecretKey(key);
  key.fill(0);
  return kek;
}

function kekVersion(kekId: string): number {
  return Number(KEK_ID.exec(kekId)?.[1] ?? 0);
}

/**
 * Key-encryption keys from a folder of `master-v<N>.key` files (ADR-0010, ADR-0026): KEK `local:v<N>` is
 * the file `master-v<N>.key`, 32 random bytes in base64, mode 0400 or 0600.
 *
 * Every version in the folder can unwrap; only `current` wraps new data keys. Data keys are wrapped with
 * AES-256-GCM (12-byte IV, 16-byte tag) and the KEK id as associated data. The KEKs are held as
 * `KeyObject`s, so neither `util.inspect` nor `JSON.stringify` can print them.
 */
export class LocalFileKeyProvider implements KeyProvider {
  readonly #keys: ReadonlyMap<string, KeyObject>;
  readonly #currentKekId: string;
  readonly #currentKey: KeyObject;

  private constructor(keys: ReadonlyMap<string, KeyObject>, currentKekId: string, currentKey: KeyObject) {
    this.#keys = keys;
    this.#currentKekId = currentKekId;
    this.#currentKey = currentKey;
  }

  /**
   * Loads every `master-v<N>.key` in `dir` as KEK `local:v<N>`; other files (the API key pepper, JWT
   * keys) are ignored. `current` is `MASTER_KEY_CURRENT`, for example `local:v1`.
   *
   * It throws a `KeyProviderError` when `current` is not `local:v<N>` or has no file, when a file named
   * `master-v….key` is not exactly `master-v<N>.key`, or when a key file is not a regular file, grants any
   * access to group or others, is not base64 or does not decode to exactly 32 bytes.
   */
  static async fromDir(dir: string, current: string): Promise<LocalFileKeyProvider> {
    const currentMatch = typeof current === "string" ? KEK_ID.exec(current) : null;
    if (currentMatch === null) {
      throw new KeyProviderError("The current KEK id must be local:v<N> with N >= 1 (for example local:v1)");
    }

    const root = resolve(dir);
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      throw new KeyProviderError(`Key directory ${root} cannot be read (${errorCode(error)})`);
    }

    const keys = new Map<string, KeyObject>();
    for (const name of names.sort()) {
      if (!name.startsWith("master-v") || !name.endsWith(".key")) {
        continue;
      }
      const version = KEY_FILE.exec(name)?.[1];
      if (version === undefined) {
        throw new KeyProviderError(
          `Key file ${join(root, name)} has an invalid name: KEK files are named master-v<N>.key with N >= 1 and no leading zeros`,
        );
      }
      keys.set(`local:v${version}`, await readKek(join(root, name)));
    }

    const currentKey = keys.get(current);
    if (currentKey === undefined) {
      throw new KeyProviderError(
        `Key directory ${root} has no master-v${currentMatch[1] ?? ""}.key for the current KEK ${current}`,
      );
    }
    return new LocalFileKeyProvider(keys, current, currentKey);
  }

  currentKekId(): string {
    return this.#currentKekId;
  }

  /** Every KEK id this provider can unwrap with, oldest version first. */
  kekIds(): string[] {
    return [...this.#keys.keys()].sort((a, b) => kekVersion(a) - kekVersion(b));
  }

  wrap(dek: Buffer): Promise<WrappedDataKey> {
    // A throw inside the executor rejects the promise, so callers always get a rejection, never a throw.
    return new Promise((resolvePromise) => {
      if (!(dek instanceof Uint8Array) || dek.length !== DATA_KEY_BYTES) {
        throw new TypeError(`LocalFileKeyProvider.wrap(): the data key must be ${DATA_KEY_BYTES} bytes`);
      }
      const kekId = this.#currentKekId;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.#currentKey, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(kekId, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      resolvePromise({ kekId, wrapped: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) });
    });
  }

  unwrap(wrapped: Buffer, kekId: string): Promise<Buffer> {
    return new Promise((resolvePromise) => {
      const kek = typeof kekId === "string" ? this.#keys.get(kekId) : undefined;
      if (
        kek === undefined ||
        !(wrapped instanceof Uint8Array) ||
        wrapped.length !== WRAPPED_DATA_KEY_BYTES
      ) {
        throw new DecryptionError();
      }
      const iv = wrapped.subarray(0, IV_BYTES);
      const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = wrapped.subarray(IV_BYTES + TAG_BYTES);
      let head: Buffer | undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", kek, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(kekId, "utf8"));
        decipher.setAuthTag(tag);
        head = decipher.update(ciphertext);
        resolvePromise(Buffer.concat([head, decipher.final()]));
      } catch {
        throw new DecryptionError();
      } finally {
        // Unauthenticated output is never kept, and the copy above is the only one returned.
        head?.fill(0);
      }
    });
  }
}
