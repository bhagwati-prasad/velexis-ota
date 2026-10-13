import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  DATA_KEY_BYTES,
  DecryptionError,
  KeyProviderError,
  WRAPPED_DATA_KEY_BYTES,
  type KeyProvider,
} from "./key-provider.js";

/**
 * Envelope encryption of one value (ADR-0010). The stored `bytea` is:
 *
 * ```text
 * 0x01 | kekId length (1 byte) | kekId (ASCII) | wrapped DEK (iv 12, tag 16, ct 32) | iv (12) | tag (16) | ciphertext
 * ```
 *
 * Each value gets a fresh 32-byte data key (DEK) used with AES-256-GCM and the value's associated data
 * (`aadFor(schema, table, column, rowId)`). The DEK is wrapped with the current KEK by the `KeyProvider`.
 */

/** First byte of every envelope this module writes. */
export const ENVELOPE_VERSION = 0x01;

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** KEK ids are 1 to 255 printable ASCII characters without spaces (`local:v1`), so one length byte holds them. */
const KEK_ID = /^[\x21-\x7e]{1,255}$/;

/** The result of `encryptValue` and `rewrapValue`: the `*_ciphertext` value and its `encryption_key_id`. */
export interface EncryptedValue {
  readonly ciphertext: Buffer;
  /** Id of the KEK that wraps the value's data key; store it in `encryption_key_id`. */
  readonly kekId: string;
}

export interface EncryptOptions {
  /** Associated data that binds the value to its place, from `aadFor(…)`. */
  readonly aad: string;
  readonly keys: KeyProvider;
}

export interface DecryptOptions {
  /** The same associated data that was used to encrypt the value. */
  readonly aad: string;
  readonly keys: KeyProvider;
}

export interface RewrapOptions {
  readonly keys: KeyProvider;
  /**
   * Optional associated data of the value. When given, the value must authenticate at that place before
   * its data key is re-wrapped (`DecryptionError` otherwise); the plaintext is checked and then discarded.
   */
  readonly aad?: string;
}

interface Envelope {
  readonly kekId: string;
  readonly wrapped: Buffer;
  /** `iv | tag | ciphertext`, which a re-wrap copies unchanged. */
  readonly body: Buffer;
}

function aadBytes(aad: unknown, fn: string): Buffer {
  if (typeof aad !== "string" || aad.length === 0) {
    throw new TypeError(`${fn}(): aad must be a non-empty string (use aadFor)`);
  }
  return Buffer.from(aad, "utf8");
}

function header(kekId: string): Buffer {
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION, kekId.length]), Buffer.from(kekId, "ascii")]);
}

/** Checks what a provider's `wrap` returned before it is written into an envelope. */
function assertWrapped(kekId: unknown, wrapped: unknown): asserts kekId is string {
  if (typeof kekId !== "string" || !KEK_ID.test(kekId)) {
    throw new KeyProviderError("KeyProvider.wrap() returned an invalid KEK id");
  }
  if (!(wrapped instanceof Uint8Array) || wrapped.length !== WRAPPED_DATA_KEY_BYTES) {
    throw new KeyProviderError(
      `KeyProvider.wrap() must return a ${WRAPPED_DATA_KEY_BYTES}-byte wrapped key for envelope version ${ENVELOPE_VERSION}`,
    );
  }
}

/** Splits an envelope into its parts; any malformed input is a `DecryptionError`. */
function parseEnvelope(ciphertext: unknown, fn: string): Envelope {
  if (!(ciphertext instanceof Uint8Array)) {
    throw new TypeError(`${fn}(): ciphertext must be a Buffer`);
  }
  const bytes = Buffer.from(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength);
  const kekIdLength = bytes[1] ?? 0;
  const kekIdEnd = 2 + kekIdLength;
  if (
    bytes[0] !== ENVELOPE_VERSION ||
    kekIdLength === 0 ||
    bytes.length < kekIdEnd + WRAPPED_DATA_KEY_BYTES + IV_BYTES + TAG_BYTES
  ) {
    throw new DecryptionError();
  }
  const kekId = bytes.toString("latin1", 2, kekIdEnd);
  if (!KEK_ID.test(kekId)) {
    throw new DecryptionError();
  }
  return {
    kekId,
    wrapped: Buffer.from(bytes.subarray(kekIdEnd, kekIdEnd + WRAPPED_DATA_KEY_BYTES)),
    body: Buffer.from(bytes.subarray(kekIdEnd + WRAPPED_DATA_KEY_BYTES)),
  };
}

async function unwrapDataKey(keys: KeyProvider, envelope: Envelope): Promise<Buffer> {
  const dek = await keys.unwrap(envelope.wrapped, envelope.kekId);
  if (!(dek instanceof Uint8Array) || dek.length !== DATA_KEY_BYTES) {
    if (dek instanceof Uint8Array) {
      dek.fill(0);
    }
    throw new DecryptionError();
  }
  return dek;
}

/** Decrypts `iv | tag | ciphertext` with the data key; unauthenticated output never leaves this function. */
function openBody(dek: Buffer, body: Buffer, aad: Buffer): Buffer {
  const iv = body.subarray(0, IV_BYTES);
  const tag = body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = body.subarray(IV_BYTES + TAG_BYTES);
  let head: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    head = decipher.update(ciphertext);
    return Buffer.concat([head, decipher.final()]);
  } catch {
    throw new DecryptionError();
  } finally {
    head?.fill(0);
  }
}

/**
 * The public functions rethrow a `DecryptionError` from any inner check as a fresh one created here, after
 * an `await`. Its stack trace is then the same whether parsing, the provider's unwrap or the data's tag
 * failed, so a logged error is no decryption oracle either. Other errors pass through unchanged.
 */
function withoutFailureDetail(error: unknown): unknown {
  return error instanceof DecryptionError ? new DecryptionError() : error;
}

async function openEnvelope(ciphertext: Uint8Array, keys: KeyProvider, aad: Buffer): Promise<Buffer> {
  const envelope = parseEnvelope(ciphertext, "decryptValue");
  const dek = await unwrapDataKey(keys, envelope);
  try {
    return openBody(dek, envelope.body, aad);
  } finally {
    dek.fill(0);
  }
}

async function rewrapEnvelope(
  ciphertext: Uint8Array,
  keys: KeyProvider,
  aad: Buffer | undefined,
): Promise<EncryptedValue> {
  const envelope = parseEnvelope(ciphertext, "rewrapValue");
  const dek = await unwrapDataKey(keys, envelope);
  try {
    if (aad !== undefined) {
      openBody(dek, envelope.body, aad).fill(0);
    }
    if (envelope.kekId === keys.currentKekId()) {
      return { ciphertext: Buffer.from(ciphertext), kekId: envelope.kekId };
    }
    const { kekId, wrapped } = await keys.wrap(dek);
    assertWrapped(kekId, wrapped);
    return { ciphertext: Buffer.concat([header(kekId), wrapped, envelope.body]), kekId };
  } finally {
    dek.fill(0);
  }
}

/**
 * Encrypts one value for a `*_ciphertext` column: a fresh data key, AES-256-GCM with `aad`, the data key
 * wrapped with the current KEK. Strings are encoded as UTF-8. Store `ciphertext` in the column and `kekId`
 * in `encryption_key_id`.
 */
export async function encryptValue(
  plaintext: string | Uint8Array,
  options: EncryptOptions,
): Promise<EncryptedValue> {
  const aad = aadBytes(options.aad, "encryptValue");
  let data: Uint8Array;
  if (typeof plaintext === "string") {
    data = Buffer.from(plaintext, "utf8");
  } else if (plaintext instanceof Uint8Array) {
    data = plaintext;
  } else {
    throw new TypeError("encryptValue(): plaintext must be a string or a Buffer");
  }

  const dek = randomBytes(DATA_KEY_BYTES);
  try {
    const { kekId, wrapped } = await options.keys.wrap(dek);
    assertWrapped(kekId, wrapped);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return {
      ciphertext: Buffer.concat([header(kekId), wrapped, iv, cipher.getAuthTag(), encrypted]),
      kekId,
    };
  } finally {
    dek.fill(0);
    if (typeof plaintext === "string") {
      data.fill(0);
    }
  }
}

/**
 * Decrypts a value written by `encryptValue` (or moved by `rewrapValue`) with the associated data of its
 * place. Any KEK the provider knows can unwrap it, not only the current one. Every failure is a
 * `DecryptionError` without detail. The returned Buffer is the secret: never log it, and `fill(0)` it
 * when done.
 */
export async function decryptValue(ciphertext: Uint8Array, options: DecryptOptions): Promise<Buffer> {
  const aad = aadBytes(options.aad, "decryptValue");
  try {
    return await openEnvelope(ciphertext, options.keys, aad);
  } catch (error) {
    throw withoutFailureDetail(error);
  }
}

/**
 * Re-wraps the value's data key under the current KEK (KEK rotation, ADR-0010). The data itself is not
 * re-encrypted: `iv | tag | ciphertext` is copied unchanged. The old wrapped key must still unwrap
 * (`DecryptionError` otherwise). A value already under the current KEK comes back unchanged. Store the
 * returned `ciphertext` and `kekId` together.
 */
export async function rewrapValue(ciphertext: Uint8Array, options: RewrapOptions): Promise<EncryptedValue> {
  const aad = options.aad === undefined ? undefined : aadBytes(options.aad, "rewrapValue");
  try {
    return await rewrapEnvelope(ciphertext, options.keys, aad);
  } catch (error) {
    throw withoutFailureDetail(error);
  }
}

/**
 * The KEK id stored in an envelope, without decrypting anything, for checks against `encryption_key_id`
 * and rotation reports. A malformed envelope is a `DecryptionError`.
 */
export function envelopeKekId(ciphertext: Uint8Array): string {
  return parseEnvelope(ciphertext, "envelopeKekId").kekId;
}
