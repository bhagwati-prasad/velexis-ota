// @velexis/db/storage: the StorageAdapter of ADR-0017 and its local-disk implementation (X-010).
import { LocalDiskStorage } from "./local-disk-storage.js";

/**
 * Where documents and uploaded files live. Keys are `tenant_<key>/…` or `platform/…` (db README §5); the
 * metadata (content type, size, SHA-256) is kept by the caller in its own rows (`booking_documents`).
 */
export interface StorageAdapter {
  /** Stores `bytes` under `key`, replacing an existing object atomically. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The bytes stored under `key`, or `null` when there are none. */
  get(key: string): Promise<Buffer | null>;
  /** Removes `key`. Removing a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** A download URL for `key` that expires `ttlSeconds` from now. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

/** Builds the download URL of `key`, valid until `expiresAt` (the OTA backend signs it, ADR-0017). */
export type UrlSigner = (key: string, expiresAt: Date) => string;

/** The values of `STORAGE_DRIVER`; apps declare it with `env.enum(STORAGE_DRIVERS)`. */
export const STORAGE_DRIVERS = ["local", "s3"] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export interface CreateStorageOptions {
  /** `STORAGE_DRIVER`. */
  readonly driver: StorageDriver;
  /** `STORAGE_DIR`: required by the `local` driver. */
  readonly dir?: string | undefined;
  /** URL signer for `signedUrl` (see `LocalDiskStorageOptions.signUrl`). */
  readonly signUrl?: UrlSigner | undefined;
}

/**
 * The storage adapter selected by configuration. `local` is the MVP; `s3` throws until an S3 adapter is
 * needed, so the move to object storage stays a configuration change plus that adapter (ADR-0017).
 */
export function createStorage(options: CreateStorageOptions): StorageAdapter {
  switch (options.driver) {
    case "local":
      if (options.dir === undefined || options.dir.trim() === "") {
        throw new TypeError("createStorage: the local driver needs dir (STORAGE_DIR)");
      }
      return new LocalDiskStorage(options.dir, { signUrl: options.signUrl });
    case "s3":
      throw new Error("createStorage: the s3 storage driver is not implemented yet (ADR-0017)");
    default:
      throw new TypeError(
        `createStorage: unknown storage driver ${JSON.stringify(options.driver as unknown)}`,
      );
  }
}

export {
  LocalDiskStorage,
  StorageKeyError,
  assertStorageKey,
  STORAGE_KEY_MAX_LENGTH,
  type LocalDiskStorageOptions,
} from "./local-disk-storage.js";
