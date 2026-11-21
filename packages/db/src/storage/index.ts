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

/**
 * The values of `STORAGE_DRIVER` that work; apps declare it with `env.enum(STORAGE_DRIVERS)`, so the configuration
 * check refuses any other value ("STORAGE_DRIVER must be one of local") before a process starts (KI-036). A planned
 * driver joins this list only together with its adapter.
 */
export const STORAGE_DRIVERS = ["local"] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/**
 * Drivers that ADR-0017 plans but that have no adapter yet: not in `STORAGE_DRIVERS`, so no configuration selects
 * one, and `createStorage` refuses them with a clear error should a caller pass one anyway.
 */
export const PLANNED_STORAGE_DRIVERS = ["s3"] as const;
export type PlannedStorageDriver = (typeof PLANNED_STORAGE_DRIVERS)[number];

export interface CreateStorageOptions {
  /** `STORAGE_DRIVER` (a planned driver is refused). */
  readonly driver: StorageDriver | PlannedStorageDriver;
  /** `STORAGE_DIR`: required by the `local` driver. */
  readonly dir?: string | undefined;
  /** URL signer for `signedUrl` (see `LocalDiskStorageOptions.signUrl`). */
  readonly signUrl?: UrlSigner | undefined;
}

/**
 * The storage adapter selected by configuration. `local` is the MVP; `s3` (planned, not a `STORAGE_DRIVERS` value, so
 * the configuration check already refuses it) throws until an S3 adapter is needed, so the move to object storage
 * stays that adapter plus its entry in `STORAGE_DRIVERS` and a configuration change (ADR-0017).
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
