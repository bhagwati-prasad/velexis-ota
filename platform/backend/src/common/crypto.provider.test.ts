// The envelope encryption of the platform's ciphertext columns (PBE-011; ADR-0010): the KEKs of MASTER_KEY_DIR, the
// associated data `platform.<table>.<column>:<row id>` (and `redis.<prefix>.<field>:<id>` for a value kept in Redis,
// PBE-015), and the refusal of a value copied to another place.
import type { ConfigService } from "@nestjs/config";
import { DecryptionError, KeyProviderError, type KeyProvider } from "@velexis/crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createTestMasterKeyDir } from "../../test/support/master-key";
import type { PlatformBackendConfig } from "../config";
import {
  associatedData,
  CiphertextContentError,
  EnvelopeService,
  keyProviderProvider,
} from "./crypto.provider";

const keys = createTestMasterKeyDir();

afterAll(() => {
  keys.remove();
});

function configOf(values: Record<string, string>): ConfigService<PlatformBackendConfig, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<PlatformBackendConfig, true>;
}

async function envelope(): Promise<EnvelopeService> {
  const provider = await keyProviderProvider.useFactory(
    configOf({ MASTER_KEY_DIR: keys.path, MASTER_KEY_CURRENT: keys.current }),
  );
  return new EnvelopeService(provider);
}

const PLACE = {
  table: "email_outbox",
  column: "secret_payload_ciphertext",
  rowId: "eml_01JTESTCRYPTO000000000000",
};

describe("EnvelopeService", () => {
  it("binds a value to its platform table, column and row", () => {
    expect(associatedData(PLACE)).toBe(
      "platform.email_outbox.secret_payload_ciphertext:eml_01JTESTCRYPTO000000000000",
    );
  });

  it("binds a value kept in Redis to the key's prefix, field and id, never to a platform column (PBE-015)", async () => {
    const service = await envelope();
    const redisPlace = {
      schema: "redis",
      table: "mfasetup",
      column: "totp_secret",
      rowId: "acc_01JTESTCRYPTO000000000000",
    } as const;
    expect(associatedData(redisPlace)).toBe("redis.mfasetup.totp_secret:acc_01JTESTCRYPTO000000000000");

    const { ciphertext } = await service.encrypt("TESTONLYSECRETAAAAAAAAAAAAAAAAAA", redisPlace);

    expect((await service.decrypt(ciphertext, redisPlace)).toString("utf8")).toBe(
      "TESTONLYSECRETAAAAAAAAAAAAAAAAAA",
    );
    await expect(service.decrypt(ciphertext, { ...redisPlace, schema: "platform" })).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("encrypts JSON under MASTER_KEY_CURRENT and decrypts it only at the same place", async () => {
    const service = await envelope();
    const secret = { verifyUrl: "https://platform.example.com/verify-email?token=test-only-token" };

    const { ciphertext, kekId } = await service.encryptJson(secret, PLACE);

    expect(kekId).toBe("local:v1");
    expect(service.currentKekId()).toBe("local:v1");
    expect(ciphertext.includes(Buffer.from("test-only-token"))).toBe(false);
    await expect(service.decryptJson(ciphertext, PLACE)).resolves.toEqual(secret);
    await expect(
      service.decryptJson(ciphertext, { ...PLACE, rowId: "eml_01JTESTCRYPTO000000000001" }),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(service.decryptJson(ciphertext, { ...PLACE, column: "data" })).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(service.rewrap(ciphertext, PLACE)).resolves.toMatchObject({ kekId: "local:v1" });
  });

  it("refuses to parse a value that is not JSON text", async () => {
    const service = await envelope();
    const { ciphertext } = await service.encrypt("not json", PLACE);

    await expect(service.decryptJson(ciphertext, PLACE)).rejects.toBeInstanceOf(CiphertextContentError);
  });

  it("stops the start-up when MASTER_KEY_CURRENT has no key file in MASTER_KEY_DIR", async () => {
    const load: Promise<KeyProvider> = Promise.resolve(
      keyProviderProvider.useFactory(configOf({ MASTER_KEY_DIR: keys.path, MASTER_KEY_CURRENT: "local:v2" })),
    );

    await expect(load).rejects.toBeInstanceOf(KeyProviderError);
  });
});
