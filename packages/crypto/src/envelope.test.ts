import { createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DecryptionError,
  ENVELOPE_VERSION,
  KeyProviderError,
  LocalFileKeyProvider,
  WRAPPED_DATA_KEY_BYTES,
  aadFor,
  decryptValue,
  encryptValue,
  envelopeKekId,
  rewrapValue,
  type KeyProvider,
} from "./index.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function keyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-crypto-env-"));
  created.push(dir);
  await chmod(dir, 0o700);
  return dir;
}

/** Writes a KEK file (32 random bytes, base64, mode 0600) and returns its content. */
async function writeKek(dir: string, version: number, content = `${randomBytes(32).toString("base64")}\n`) {
  const path = join(dir, `master-v${version}.key`);
  await writeFile(path, content);
  await chmod(path, 0o600);
  return content;
}

/** Captures the rejection of a promise (and fails the test when it resolves). */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (reason: unknown) => reason,
  );
}

function flipped(buffer: Buffer, index: number, mask: number): Buffer {
  const copy = Buffer.from(buffer);
  copy.writeUInt8(copy.readUInt8(index) ^ mask, index);
  return copy;
}

/** Length of the envelope header for a KEK id: version byte, length byte, the id. */
function headerLength(kekId: string): number {
  return 2 + kekId.length;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = aadFor(
  "platform",
  "supplier_connections",
  "client_secret_ciphertext",
  "sup_01JAAAAAAAAAAAAAAAAAAAAAAA",
);

let dir: string;
let v1Only: LocalFileKeyProvider;
let both: LocalFileKeyProvider;
beforeAll(async () => {
  dir = await keyDir();
  await writeKek(dir, 1);
  v1Only = await LocalFileKeyProvider.fromDir(dir, "local:v1");
  await writeKek(dir, 2);
  both = await LocalFileKeyProvider.fromDir(dir, "local:v2");
});

describe("encryptValue and decryptValue", () => {
  it("round-trips strings, Buffers, empty and large values [X-004 AC1]", async () => {
    const values: Array<string | Buffer> = [
      "dummy-client-secret-for-tests",
      "päss wörd ✓ 🔑",
      "",
      Buffer.alloc(0),
      randomBytes(1),
      randomBytes(64 * 1024),
    ];
    for (const value of values) {
      const { ciphertext, kekId } = await encryptValue(value, { aad: AAD, keys: v1Only });
      expect(kekId).toBe("local:v1");
      const plain = await decryptValue(ciphertext, { aad: AAD, keys: v1Only });
      expect(plain.equals(typeof value === "string" ? Buffer.from(value, "utf8") : value)).toBe(true);
    }
  });

  it("gives a different ciphertext, data key and IV each time the same plaintext is encrypted [X-004 AC1]", async () => {
    const first = await encryptValue("the same plaintext", { aad: AAD, keys: v1Only });
    const second = await encryptValue("the same plaintext", { aad: AAD, keys: v1Only });

    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    const start = headerLength("local:v1");
    const wrappedOf = (c: Buffer) => c.subarray(start, start + WRAPPED_DATA_KEY_BYTES);
    const ivOf = (c: Buffer) =>
      c.subarray(start + WRAPPED_DATA_KEY_BYTES, start + WRAPPED_DATA_KEY_BYTES + IV_BYTES);
    expect(wrappedOf(first.ciphertext).equals(wrappedOf(second.ciphertext))).toBe(false);
    expect(ivOf(first.ciphertext).equals(ivOf(second.ciphertext))).toBe(false);
    expect((await decryptValue(first.ciphertext, { aad: AAD, keys: v1Only })).toString()).toBe(
      "the same plaintext",
    );
    expect((await decryptValue(second.ciphertext, { aad: AAD, keys: v1Only })).toString()).toBe(
      "the same plaintext",
    );
  });

  it("writes the ADR-0010 envelope: 0x01 | kekId length + kekId | wrapped DEK (iv, tag, ct) | iv | tag | ciphertext", async () => {
    const kekDir = await keyDir();
    const kekBase64 = await writeKek(kekDir, 7);
    const keys = await LocalFileKeyProvider.fromDir(kekDir, "local:v7");
    const plaintext = Buffer.from("format check value", "utf8");

    const { ciphertext, kekId } = await encryptValue(plaintext, { aad: AAD, keys });

    expect(kekId).toBe("local:v7");
    expect(ciphertext.readUInt8(0)).toBe(ENVELOPE_VERSION);
    expect(ENVELOPE_VERSION).toBe(0x01);
    expect(ciphertext.readUInt8(1)).toBe("local:v7".length);
    expect(ciphertext.toString("ascii", 2, 10)).toBe("local:v7");
    expect(ciphertext).toHaveLength(10 + 60 + IV_BYTES + TAG_BYTES + plaintext.length);
    expect(envelopeKekId(ciphertext)).toBe("local:v7");

    // Open the envelope by hand with the KEK from the file, to pin the layout byte for byte.
    const kek = Buffer.from(kekBase64.trim(), "base64");
    const wrapped = ciphertext.subarray(10, 70);
    const unwrap = createDecipheriv("aes-256-gcm", kek, wrapped.subarray(0, 12), { authTagLength: 16 });
    unwrap.setAAD(Buffer.from("local:v7", "utf8"));
    unwrap.setAuthTag(wrapped.subarray(12, 28));
    const dek = Buffer.concat([unwrap.update(wrapped.subarray(28)), unwrap.final()]);
    expect(dek).toHaveLength(32);

    const body = ciphertext.subarray(70);
    const open = createDecipheriv("aes-256-gcm", dek, body.subarray(0, 12), { authTagLength: 16 });
    open.setAAD(Buffer.from(AAD, "utf8"));
    open.setAuthTag(body.subarray(12, 28));
    expect(Buffer.concat([open.update(body.subarray(28)), open.final()]).equals(plaintext)).toBe(true);
  });

  it("fails with different associated data: another row, column, table or tenant schema [X-004 AC2]", async () => {
    const aad = aadFor(
      "tenant_alpha",
      "saved_traveler_documents",
      "number_ciphertext",
      "std_01JAAAAAAAAAAAAAAAAAAAAAAA",
    );
    const { ciphertext } = await encryptValue("X1234567", { aad, keys: both });

    const others = [
      aadFor(
        "tenant_alpha",
        "saved_traveler_documents",
        "number_ciphertext",
        "std_01JBBBBBBBBBBBBBBBBBBBBBBB",
      ),
      aadFor(
        "tenant_alpha",
        "saved_traveler_documents",
        "details_ciphertext",
        "std_01JAAAAAAAAAAAAAAAAAAAAAAA",
      ),
      aadFor("tenant_alpha", "booking_travelers", "number_ciphertext", "std_01JAAAAAAAAAAAAAAAAAAAAAAA"),
      aadFor(
        "tenant_beta",
        "saved_traveler_documents",
        "number_ciphertext",
        "std_01JAAAAAAAAAAAAAAAAAAAAAAA",
      ),
      `${aad} `,
    ];
    for (const other of others) {
      expect(await rejectionOf(decryptValue(ciphertext, { aad: other, keys: both }))).toBeInstanceOf(
        DecryptionError,
      );
    }
    expect((await decryptValue(ciphertext, { aad, keys: both })).toString()).toBe("X1234567");
  });

  it("fails when any single byte of the envelope is flipped [X-004 AC2]", async () => {
    for (const keys of [v1Only, both]) {
      const { ciphertext } = await encryptValue("flip me", { aad: AAD, keys });
      for (let index = 0; index < ciphertext.length; index += 1) {
        for (const mask of [0x01, 0x80, 0xff]) {
          const error = await rejectionOf(
            decryptValue(flipped(ciphertext, index, mask), { aad: AAD, keys: both }),
          );
          expect(error, `byte ${index} ^ 0x${mask.toString(16)}`).toBeInstanceOf(DecryptionError);
        }
      }
    }
  });

  it("fails with a data key wrapped by another KEK [X-004 AC2]", async () => {
    const underV1 = await encryptValue("wrapped by v1", { aad: AAD, keys: v1Only });
    const underV2 = await encryptValue("wrapped by v2", { aad: AAD, keys: both });
    const start = headerLength("local:v1");
    const end = start + WRAPPED_DATA_KEY_BYTES;

    // The v1 header with the data key that local:v2 wrapped.
    const transplanted = Buffer.concat([
      underV1.ciphertext.subarray(0, start),
      underV2.ciphertext.subarray(start, end),
      underV1.ciphertext.subarray(end),
    ]);
    // The v1 value relabelled as local:v2 (both ids have the same length).
    const relabelled = Buffer.from(underV1.ciphertext);
    relabelled.write("local:v2", 2, "ascii");
    // The same id, but a different key behind it (another folder's master-v1.key).
    const otherDir = await keyDir();
    await writeKek(otherDir, 1);
    const otherV1 = await LocalFileKeyProvider.fromDir(otherDir, "local:v1");

    const errors = await Promise.all([
      rejectionOf(decryptValue(transplanted, { aad: AAD, keys: both })),
      rejectionOf(decryptValue(relabelled, { aad: AAD, keys: both })),
      rejectionOf(decryptValue(underV1.ciphertext, { aad: AAD, keys: otherV1 })),
      rejectionOf(decryptValue(underV2.ciphertext, { aad: AAD, keys: v1Only })),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(DecryptionError);
    }
  });

  it("fails for truncated, extended, empty and unknown-version input [X-004 AC2]", async () => {
    const { ciphertext } = await encryptValue("whole value", { aad: AAD, keys: both });

    for (let length = 0; length < ciphertext.length; length += 1) {
      const error = await rejectionOf(decryptValue(ciphertext.subarray(0, length), { aad: AAD, keys: both }));
      expect(error, `truncated to ${length} bytes`).toBeInstanceOf(DecryptionError);
    }
    const extended = Buffer.concat([ciphertext, Buffer.from([0])]);
    const version2 = Buffer.from(ciphertext);
    version2.writeUInt8(0x02, 0);
    for (const attempt of [extended, version2, Buffer.alloc(200)]) {
      expect(await rejectionOf(decryptValue(attempt, { aad: AAD, keys: both }))).toBeInstanceOf(
        DecryptionError,
      );
    }
  });

  it("throws the same DecryptionError without detail for every cause", async () => {
    const { ciphertext } = await encryptValue("no oracle", { aad: AAD, keys: both });
    const errors = await Promise.all([
      rejectionOf(decryptValue(ciphertext, { aad: `${AAD}x`, keys: both })),
      rejectionOf(decryptValue(flipped(ciphertext, ciphertext.length - 1, 1), { aad: AAD, keys: both })),
      rejectionOf(decryptValue(flipped(ciphertext, 20, 1), { aad: AAD, keys: both })),
      rejectionOf(decryptValue(ciphertext.subarray(0, 50), { aad: AAD, keys: both })),
      rejectionOf(decryptValue(ciphertext, { aad: AAD, keys: v1Only })),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(DecryptionError);
      const { name, message, cause } = error as Error;
      expect({ name, message, cause, own: Object.keys(error as object) }).toEqual({
        name: "DecryptionError",
        message: "Decryption failed",
        cause: undefined,
        own: ["name"],
      });
    }
  });

  it("gives every DecryptionError the same stack frames in this package, so a logged error does not tell which check failed", async () => {
    const { ciphertext } = await encryptValue("no oracle in the stack", { aad: AAD, keys: v1Only });
    const unknownKek = Buffer.from(ciphertext);
    unknownKek.write("local:v9", 2, "ascii");
    // Malformed envelope, data key that does not unwrap, unknown KEK, wrong associated data, changed data.
    const attempts: Array<[Buffer, string]> = [
      [ciphertext.subarray(0, 50), AAD],
      [flipped(ciphertext, 20, 1), AAD],
      [unknownKek, AAD],
      [ciphertext, `${AAD}x`],
      [flipped(ciphertext, ciphertext.length - 1, 1), AAD],
    ];
    // The frames that lie in the package's own source files; the caller's frames are not its business.
    const packageFrames = (error: unknown): string =>
      ((error as Error).stack ?? "")
        .split("\n")
        .filter((line) => line.includes(__dirname) && !line.includes(".test.ts"))
        .join("\n");

    for (const operation of ["decryptValue", "rewrapValue"] as const) {
      const stacks = new Set<string>();
      for (const [input, aad] of attempts) {
        const options = { aad, keys: both };
        const error = await rejectionOf(
          operation === "decryptValue" ? decryptValue(input, options) : rewrapValue(input, options),
        );
        expect(error, `${operation} with ${input.length} bytes`).toBeInstanceOf(DecryptionError);
        expect(packageFrames(error), operation).toContain(operation);
        stacks.add(packageFrames(error));
      }
      expect([...stacks], operation).toHaveLength(1);
    }
  });

  it("rejects missing associated data and a plaintext that is neither a string nor a Buffer", async () => {
    await expect(encryptValue("value", { aad: "", keys: both })).rejects.toBeInstanceOf(TypeError);
    await expect(encryptValue(42 as unknown as string, { aad: AAD, keys: both })).rejects.toBeInstanceOf(
      TypeError,
    );
    const { ciphertext } = await encryptValue("value", { aad: AAD, keys: both });
    await expect(decryptValue(ciphertext, { aad: "", keys: both })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("KEK rotation", () => {
  it("decrypts a value encrypted under local:v1 after current becomes local:v2 [X-004 AC3]", async () => {
    const rotationDir = await keyDir();
    await writeKek(rotationDir, 1);
    const beforeRotation = await LocalFileKeyProvider.fromDir(rotationDir, "local:v1");
    const old = await encryptValue("survives the rotation", { aad: AAD, keys: beforeRotation });
    expect(old.kekId).toBe("local:v1");

    // Step 1 of the rotation: add master-v2.key and set MASTER_KEY_CURRENT=local:v2.
    await writeKek(rotationDir, 2);
    const afterRotation = await LocalFileKeyProvider.fromDir(rotationDir, "local:v2");

    expect((await decryptValue(old.ciphertext, { aad: AAD, keys: afterRotation })).toString()).toBe(
      "survives the rotation",
    );
    const fresh = await encryptValue("new value", { aad: AAD, keys: afterRotation });
    expect(fresh.kekId).toBe("local:v2");
    expect(envelopeKekId(fresh.ciphertext)).toBe("local:v2");
  });

  it("rewrapValue moves a value to local:v2 without changing the plaintext or the data ciphertext [X-004 AC3]", async () => {
    const rotationDir = await keyDir();
    await writeKek(rotationDir, 1);
    const beforeRotation = await LocalFileKeyProvider.fromDir(rotationDir, "local:v1");
    const plaintext = "moved, not re-encrypted";
    const old = await encryptValue(plaintext, { aad: AAD, keys: beforeRotation });
    const v2Key = await writeKek(rotationDir, 2);
    const afterRotation = await LocalFileKeyProvider.fromDir(rotationDir, "local:v2");

    const moved = await rewrapValue(old.ciphertext, { keys: afterRotation });

    expect(moved.kekId).toBe("local:v2");
    expect(envelopeKekId(moved.ciphertext)).toBe("local:v2");
    expect((await decryptValue(moved.ciphertext, { aad: AAD, keys: afterRotation })).toString()).toBe(
      plaintext,
    );
    // Only the data key was re-wrapped: iv | tag | ciphertext are the same bytes.
    const body = (c: Buffer, kekId: string) => c.subarray(headerLength(kekId) + WRAPPED_DATA_KEY_BYTES);
    expect(body(moved.ciphertext, "local:v2").equals(body(old.ciphertext, "local:v1"))).toBe(true);

    // Step 4: once everything is re-wrapped, local:v1 can be removed; the moved value needs v2 only.
    const v2OnlyDir = await keyDir();
    await writeKek(v2OnlyDir, 2, v2Key);
    const v2Only = await LocalFileKeyProvider.fromDir(v2OnlyDir, "local:v2");
    expect((await decryptValue(moved.ciphertext, { aad: AAD, keys: v2Only })).toString()).toBe(plaintext);
    expect(await rejectionOf(decryptValue(old.ciphertext, { aad: AAD, keys: v2Only }))).toBeInstanceOf(
      DecryptionError,
    );

    // A second run changes nothing.
    const again = await rewrapValue(moved.ciphertext, { keys: afterRotation });
    expect(again.kekId).toBe("local:v2");
    expect(again.ciphertext.equals(moved.ciphertext)).toBe(true);
  });

  it("rewrapValue checks the associated data when given and refuses values it cannot unwrap", async () => {
    const old = await encryptValue("checked before the move", { aad: AAD, keys: v1Only });

    const moved = await rewrapValue(old.ciphertext, { keys: both, aad: AAD });
    expect(moved.kekId).toBe("local:v2");
    expect(await rejectionOf(rewrapValue(old.ciphertext, { keys: both, aad: `${AAD}x` }))).toBeInstanceOf(
      DecryptionError,
    );
    const start = headerLength("local:v1");
    expect(
      await rejectionOf(rewrapValue(flipped(old.ciphertext, start + 40, 1), { keys: both })),
    ).toBeInstanceOf(DecryptionError);
    expect(await rejectionOf(rewrapValue(old.ciphertext.subarray(0, 40), { keys: both }))).toBeInstanceOf(
      DecryptionError,
    );
  });
});

describe("KeyProvider contract", () => {
  it("lets operational errors of a provider through and refuses a wrapped key of the wrong size", async () => {
    const outage = new Error("key service unreachable");
    const failing: KeyProvider = {
      currentKekId: () => "kms:test",
      wrap: () => Promise.resolve({ kekId: "kms:test", wrapped: Buffer.alloc(WRAPPED_DATA_KEY_BYTES + 1) }),
      unwrap: () => Promise.reject(outage),
    };
    const { ciphertext } = await encryptValue("value", { aad: AAD, keys: both });

    expect(await rejectionOf(decryptValue(ciphertext, { aad: AAD, keys: failing }))).toBe(outage);
    expect(await rejectionOf(encryptValue("value", { aad: AAD, keys: failing }))).toBeInstanceOf(
      KeyProviderError,
    );
  });
});

describe("aadFor", () => {
  it('gives "<schema>.<table>.<column>:<rowId>"', () => {
    expect(aadFor("platform", "supplier_connections", "client_secret_ciphertext", "sup_01J9Z")).toBe(
      "platform.supplier_connections.client_secret_ciphertext:sup_01J9Z",
    );
    expect(aadFor("tenant_acme", "notifications", "secret_payload_ciphertext", "ntf_01J9Z")).toBe(
      "tenant_acme.notifications.secret_payload_ciphertext:ntf_01J9Z",
    );
  });

  it("refuses parts that could make two places share one string", () => {
    const bad: Array<[string, string, string, string]> = [
      ["", "t", "c", "id"],
      ["Platform", "t", "c", "id"],
      ["platform.x", "t", "c", "id"],
      ["platform", "t:x", "c", "id"],
      ["platform", "t", "1c", "id"],
      ["platform", "t", "c-x", "id"],
      ["platform", "t", "c".repeat(64), "id"],
      ["platform", "t", "c", ""],
      ["platform", "t", "c", "id with space"],
      ["platform", "t", "c", "id\n"],
      ["platform", "t", "c", "idé"],
      ["platform", "t", "c", "x".repeat(256)],
    ];
    for (const parts of bad) {
      expect(() => aadFor(...parts), parts.join("|")).toThrow(TypeError);
    }
  });
});

describe("package.json and imports", () => {
  const CRYPTO_LIBRARY =
    /crypt|sodium|nacl|forge|jose|jwt|jsonwebtoken|noble|elliptic|secp256|ed25519|openpgp|sjcl|tink|kms|aes|cipher|argon|scrypt|pbkdf|hmac|sha\d|hash-wasm|webcrypto|peculiar/i;

  it("lists no third-party crypto library [X-004 AC4]", async () => {
    const manifest = JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const names = fields.flatMap((field) => Object.keys((manifest[field] as Record<string, string>) ?? {}));

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => CRYPTO_LIBRARY.test(name))).toEqual([]);
    expect(manifest["bundledDependencies"] ?? manifest["bundleDependencies"]).toBeUndefined();
  });

  it("imports only Node built-ins and its own modules in the envelope code [X-004 AC4]", async () => {
    const sources = ["envelope.ts", "key-provider.ts", "local-file-key-provider.ts", "aad.ts", "index.ts"];
    for (const source of sources) {
      const text = await readFile(join(__dirname, source), "utf8");
      const specifiers = [...text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1],
      );
      for (const specifier of specifiers) {
        expect(specifier, `${source} imports ${specifier}`).toMatch(/^(node:|\.\/)/);
      }
    }
  });
});
