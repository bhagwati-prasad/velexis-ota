/**
 * The seam between the envelope format and the key-encryption keys (KEKs) of ADR-0010.
 *
 * The envelope code never sees a KEK: it hands a fresh data key (DEK) to `wrap` and gets it back from
 * `unwrap`. Today the only implementation is `LocalFileKeyProvider` (one `master-v<N>.key` file per KEK
 * version). A KMS-backed provider is the planned follow-up; it implements the same three methods.
 */

/** Length in bytes of every data key (AES-256). */
export const DATA_KEY_BYTES = 32;

/**
 * Length in bytes of a wrapped data key in envelope version 1: the AES-256-GCM output of a 32-byte key,
 * stored as 12-byte IV, 16-byte tag and 32-byte ciphertext. A provider whose wrapped keys have another
 * size needs a new envelope version.
 */
export const WRAPPED_DATA_KEY_BYTES = 12 + 16 + DATA_KEY_BYTES;

/** A data key wrapped by one KEK, as returned by `KeyProvider.wrap`. */
export interface WrappedDataKey {
  /** Id of the KEK that wrapped the key, for example `local:v2`. It goes into the envelope and `encryption_key_id`. */
  readonly kekId: string;
  /** The wrapped key, `WRAPPED_DATA_KEY_BYTES` long (IV, tag, ciphertext). */
  readonly wrapped: Buffer;
}

export interface KeyProvider {
  /** The KEK that wraps new data keys (`MASTER_KEY_CURRENT`, for example `local:v1`). */
  currentKekId(): string;

  /**
   * Wraps a data key with the current KEK and says which KEK that was. The caller still owns `dek` and
   * zeroes it after use.
   */
  wrap(dek: Buffer): Promise<WrappedDataKey>;

  /**
   * Unwraps a data key that `kekId` wrapped. It rejects with `DecryptionError` when the KEK is unknown or
   * the wrapped key is not authentic, and says nothing more about the cause. Other errors (for example a
   * KMS that cannot be reached) are operational and reject as they are.
   */
  unwrap(wrapped: Buffer, kekId: string): Promise<Buffer>;
}

/**
 * A value could not be decrypted: wrong associated data, a changed byte, a truncated envelope, an unknown
 * KEK or a data key wrapped by another KEK. The error carries no detail about which, so that an error
 * response or a log line cannot serve as a decryption oracle.
 */
export class DecryptionError extends Error {
  override readonly name = "DecryptionError";

  constructor() {
    super("Decryption failed");
  }
}

/**
 * A key provider cannot be used: a key file is missing, has a bad name, mode or length, or the current
 * KEK id is invalid. The message names the file and the reason; it never contains key material.
 */
export class KeyProviderError extends Error {
  override readonly name = "KeyProviderError";
}
