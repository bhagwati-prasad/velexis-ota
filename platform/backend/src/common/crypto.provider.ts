// Envelope encryption for the platform's ciphertext columns (ADR-0010; platform/docs/architecture.md §4). The KEKs are
// the `master-v<N>.key` files of MASTER_KEY_DIR, the platform zone's key folder (ADR-0026), loaded once when the
// process starts by `LocalFileKeyProvider` of @velexis/crypto: a missing current key, or a key file that group or
// others may read, stops the start-up. CommonModule provides `EnvelopeService` to every module of the API and of the
// worker:
//
//   const place = { table: "email_outbox", column: "secret_payload_ciphertext", rowId: id };
//   const { ciphertext, kekId } = await envelope.encryptJson({ verifyUrl }, place);   // store both columns
//   const secrets = await envelope.decryptJson(row.secret_payload_ciphertext, place);  // never log it
//
// The associated data of every value is `platform.<table>.<column>:<row id>` (`aadFor`), so a ciphertext copied to
// another column or row fails to decrypt. The platform never writes a tenant schema (ADR-0004), so the schema is always
// `platform`. Decrypted values live in memory only: they are never logged, queued or stored elsewhere.
import { Inject, Injectable, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  aadFor,
  decryptValue,
  encryptValue,
  LocalFileKeyProvider,
  rewrapValue,
  type EncryptedValue,
  type KeyProvider,
} from "@velexis/crypto";
import type { PlatformBackendConfig } from "../config";

/** Injection token of the process's `KeyProvider` (the KEKs of MASTER_KEY_DIR). */
export const KEY_PROVIDER = "KEY_PROVIDER";

/** The schema of every platform ciphertext column. */
const PLATFORM_SCHEMA = "platform";

/** Where a value is stored: a ciphertext column of a `platform` table and the row's id. */
export interface CiphertextPlace {
  /** The table in schema `platform`, e.g. `email_outbox`. */
  readonly table: string;
  /** The `*_ciphertext` column, e.g. `secret_payload_ciphertext`. */
  readonly column: string;
  /** The row's id, e.g. `eml_01J…`. */
  readonly rowId: string;
}

/** The associated data of a value stored at `place`: `platform.<table>.<column>:<rowId>`. */
export function associatedData(place: CiphertextPlace): string {
  return aadFor(PLATFORM_SCHEMA, place.table, place.column, place.rowId);
}

/** A decrypted JSON value that is not what `decryptJson`'s caller stored: the ciphertext is not a JSON text. */
export class CiphertextContentError extends Error {
  override readonly name = "CiphertextContentError";

  constructor() {
    super("The decrypted value is not JSON text");
  }
}

/**
 * The @velexis/crypto envelope operations bound to the process's KEKs and to the platform schema. Every failure to
 * decrypt is a `DecryptionError` without detail.
 */
@Injectable()
export class EnvelopeService {
  constructor(@Inject(KEY_PROVIDER) private readonly keys: KeyProvider) {}

  /** The KEK that wraps new data keys (MASTER_KEY_CURRENT), as `encryption_key_id` columns store it. */
  currentKekId(): string {
    return this.keys.currentKekId();
  }

  /** Encrypts one value for `place`. Store `ciphertext` in the column and `kekId` in `encryption_key_id`. */
  encrypt(plaintext: string | Uint8Array, place: CiphertextPlace): Promise<EncryptedValue> {
    return encryptValue(plaintext, { aad: associatedData(place), keys: this.keys });
  }

  /** Decrypts a value of `place`. The Buffer is the secret: never log it, and `fill(0)` it when done. */
  decrypt(ciphertext: Uint8Array, place: CiphertextPlace): Promise<Buffer> {
    return decryptValue(ciphertext, { aad: associatedData(place), keys: this.keys });
  }

  /** Re-wraps the data key of a value of `place` under the current KEK (KEK rotation, `secrets:rewrap`). */
  rewrap(ciphertext: Uint8Array, place: CiphertextPlace): Promise<EncryptedValue> {
    return rewrapValue(ciphertext, { aad: associatedData(place), keys: this.keys });
  }

  /** Encrypts the JSON text of `value` for `place`. */
  async encryptJson(value: unknown, place: CiphertextPlace): Promise<EncryptedValue> {
    const text = JSON.stringify(value);
    if (typeof text !== "string") {
      throw new TypeError("EnvelopeService.encryptJson(): the value has no JSON text");
    }
    return this.encrypt(text, place);
  }

  /** Decrypts a value of `place` that `encryptJson` wrote and parses it. The plaintext bytes are zeroed. */
  async decryptJson(ciphertext: Uint8Array, place: CiphertextPlace): Promise<unknown> {
    const plaintext = await this.decrypt(ciphertext, place);
    try {
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      throw new CiphertextContentError();
    } finally {
      plaintext.fill(0);
    }
  }
}

/**
 * The KEKs of MASTER_KEY_DIR, with MASTER_KEY_CURRENT as the current one. Nest awaits the factory, so the process
 * does not start without them (`api.start_failed`, `worker.start_failed`; the `KeyProviderError` names the file,
 * never its content).
 */
export const keyProviderProvider: FactoryProvider<KeyProvider> = {
  provide: KEY_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<PlatformBackendConfig, true>) =>
    LocalFileKeyProvider.fromDir(
      config.get("MASTER_KEY_DIR", { infer: true }),
      config.get("MASTER_KEY_CURRENT", { infer: true }),
    ),
};

/** The providers of the envelope encryption, for CommonModule (the API and the worker). */
export function cryptoProviders(): [FactoryProvider<KeyProvider>, typeof EnvelopeService] {
  return [keyProviderProvider, EnvelopeService];
}
