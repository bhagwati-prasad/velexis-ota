import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  DATA_KEY_BYTES,
  DecryptionError,
  KeyProviderError,
  LocalFileKeyProvider,
  WRAPPED_DATA_KEY_BYTES,
} from "./index.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh key folder (mode 0700, as `pnpm dev:keys` creates `.local/keys/`). */
async function keyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-crypto-kp-"));
  created.push(dir);
  await chmod(dir, 0o700);
  return dir;
}

/** Writes a file and sets its mode explicitly (the umask does not apply to chmod). */
async function writeKey(dir: string, name: string, content: string, mode = 0o600): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

/** `bytes` random bytes in base64 with a trailing newline, as `openssl rand -base64 32` writes them. */
function base64Key(bytes = 32): string {
  return `${randomBytes(bytes).toString("base64")}\n`;
}

async function keyProviderError(promise: Promise<unknown>): Promise<KeyProviderError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(KeyProviderError);
  return error as KeyProviderError;
}

describe("LocalFileKeyProvider.fromDir", () => {
  it("loads every master-v<N>.key as KEK local:v<N> and ignores the other key files", async () => {
    const dir = await keyDir();
    await writeKey(dir, "master-v1.key", base64Key());
    await writeKey(dir, "master-v2.key", base64Key(), 0o400);
    await writeKey(dir, "master-v10.key", base64Key());
    await writeKey(dir, "api-key-pepper", base64Key(), 0o644);
    await writeKey(dir, "document-url.key", "not base64 at all", 0o644);
    await writeKey(dir, "platform-jwt-ed25519.pem", "-----BEGIN PRIVATE KEY-----\n", 0o644);

    const keys = await LocalFileKeyProvider.fromDir(dir, "local:v2");

    expect(keys.kekIds()).toEqual(["local:v1", "local:v2", "local:v10"]);
    expect(keys.currentKekId()).toBe("local:v2");
  });

  it("fails when the current KEK has no file", async () => {
    const dir = await keyDir();
    await writeKey(dir, "master-v1.key", base64Key());

    const error = await keyProviderError(LocalFileKeyProvider.fromDir(dir, "local:v2"));
    expect(error.message).toContain("master-v2.key");
    expect(error.message).toContain("local:v2");

    const empty = await keyDir();
    await keyProviderError(LocalFileKeyProvider.fromDir(empty, "local:v1"));
  });

  it("rejects a current KEK id that is not local:v<N>", async () => {
    const dir = await keyDir();
    await writeKey(dir, "master-v1.key", base64Key());

    for (const current of ["", "v1", "local:1", "local:v0", "local:v01", "local:v1 ", "kms:v1", "LOCAL:V1"]) {
      await keyProviderError(LocalFileKeyProvider.fromDir(dir, current));
    }
  });

  it("refuses key files readable (or writable) by group or others, also for an old version", async () => {
    for (const mode of [0o640, 0o604, 0o644, 0o440, 0o404, 0o620, 0o602, 0o610, 0o777]) {
      const dir = await keyDir();
      await writeKey(dir, "master-v1.key", base64Key(), mode);
      await writeKey(dir, "master-v2.key", base64Key());

      const error = await keyProviderError(LocalFileKeyProvider.fromDir(dir, "local:v2"));
      expect(error.message).toContain("master-v1.key");
      expect(error.message).toContain("group or others");
    }
  });

  it("accepts key files with mode 0400 and 0600", async () => {
    const dir = await keyDir();
    await writeKey(dir, "master-v1.key", base64Key(), 0o400);
    await writeKey(dir, "master-v2.key", base64Key(), 0o600);

    await expect(LocalFileKeyProvider.fromDir(dir, "local:v1")).resolves.toBeInstanceOf(LocalFileKeyProvider);
  });

  it("requires exactly 32 bytes after base64 decoding and never quotes the file", async () => {
    const contents = [
      base64Key(16),
      base64Key(31),
      base64Key(33),
      base64Key(64),
      "",
      "\n",
      "this is not base64 at all!",
      `${randomBytes(32).toString("hex")}\n`,
      `${randomBytes(32).toString("base64url")}x\n`,
    ];
    for (const content of contents) {
      const dir = await keyDir();
      await writeKey(dir, "master-v1.key", content);

      const error = await keyProviderError(LocalFileKeyProvider.fromDir(dir, "local:v1"));
      expect(error.message).toContain("master-v1.key");
      if (content.trim().length > 0) {
        expect(error.message).not.toContain(content.trim());
      }
    }
  });

  it("accepts base64 split over several lines", async () => {
    const dir = await keyDir();
    const key = randomBytes(32).toString("base64");
    await writeKey(dir, "master-v1.key", `${key.slice(0, 20)}\n${key.slice(20)}\n`);

    await expect(LocalFileKeyProvider.fromDir(dir, "local:v1")).resolves.toBeInstanceOf(LocalFileKeyProvider);
  });

  it("refuses ambiguous KEK file names instead of ignoring them", async () => {
    for (const name of [
      "master-v01.key",
      "master-v0.key",
      "master-vx.key",
      "master-v.key",
      "master-v1-old.key",
    ]) {
      const dir = await keyDir();
      await writeKey(dir, "master-v1.key", base64Key());
      await writeKey(dir, name, base64Key());

      const error = await keyProviderError(LocalFileKeyProvider.fromDir(dir, "local:v1"));
      expect(error.message).toContain(name);
    }
  });

  it("refuses a KEK path that is not a regular file and a folder that does not exist", async () => {
    const dir = await keyDir();
    await writeKey(dir, "master-v1.key", base64Key());
    await mkdir(join(dir, "master-v2.key"), { mode: 0o700 });
    const notAFile = await keyProviderError(LocalFileKeyProvider.fromDir(dir, "local:v1"));
    expect(notAFile.message).toContain("not a regular file");

    const missing = await keyProviderError(LocalFileKeyProvider.fromDir(join(dir, "missing"), "local:v1"));
    expect(missing.message).toContain("cannot be read");
  });

  it("never exposes key material through inspect, JSON or error messages", async () => {
    const dir = await keyDir();
    const key = randomBytes(32);
    await writeKey(dir, "master-v1.key", `${key.toString("base64")}\n`);
    const keys = await LocalFileKeyProvider.fromDir(dir, "local:v1");

    const printed = `${inspect(keys, { showHidden: true, depth: 10 })}${JSON.stringify(keys)}`;
    expect(printed).not.toContain(key.toString("base64"));
    expect(printed).not.toContain(key.toString("hex"));
  });
});

describe("LocalFileKeyProvider wrap and unwrap", () => {
  async function twoVersions(): Promise<{ dir: string; v1: LocalFileKeyProvider; v2: LocalFileKeyProvider }> {
    const dir = await keyDir();
    await writeKey(dir, "master-v1.key", base64Key());
    await writeKey(dir, "master-v2.key", base64Key());
    return {
      dir,
      v1: await LocalFileKeyProvider.fromDir(dir, "local:v1"),
      v2: await LocalFileKeyProvider.fromDir(dir, "local:v2"),
    };
  }

  it("wraps a data key with the current KEK into 60 bytes and unwraps it with any loaded version", async () => {
    const { v1, v2 } = await twoVersions();
    const dek = randomBytes(DATA_KEY_BYTES);

    const first = await v1.wrap(dek);
    const second = await v1.wrap(dek);
    expect(first.kekId).toBe("local:v1");
    expect(first.wrapped).toHaveLength(WRAPPED_DATA_KEY_BYTES);
    expect(first.wrapped.equals(second.wrapped)).toBe(false);

    expect((await v1.unwrap(first.wrapped, "local:v1")).equals(dek)).toBe(true);
    // After the switch to local:v2 the provider still unwraps keys that local:v1 wrapped.
    expect((await v2.unwrap(first.wrapped, "local:v1")).equals(dek)).toBe(true);
    const underV2 = await v2.wrap(dek);
    expect(underV2.kekId).toBe("local:v2");
    expect((await v2.unwrap(underV2.wrapped, "local:v2")).equals(dek)).toBe(true);
  });

  it("rejects with a bare DecryptionError for an unknown KEK, another KEK, a changed byte or a bad length", async () => {
    const { v1, v2 } = await twoVersions();
    const { wrapped } = await v1.wrap(randomBytes(DATA_KEY_BYTES));
    const flipped = Buffer.from(wrapped);
    flipped.writeUInt8(flipped.readUInt8(30) ^ 0x01, 30);

    const attempts: Array<() => Promise<Buffer>> = [
      () => v2.unwrap(wrapped, "local:v3"),
      () => v2.unwrap(wrapped, "local:v2"),
      () => v2.unwrap(flipped, "local:v1"),
      () => v2.unwrap(wrapped.subarray(0, WRAPPED_DATA_KEY_BYTES - 1), "local:v1"),
      () => v2.unwrap(Buffer.concat([wrapped, Buffer.alloc(1)]), "local:v1"),
      () => v2.unwrap(Buffer.alloc(0), "local:v1"),
    ];
    for (const attempt of attempts) {
      const error: unknown = await attempt().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(DecryptionError);
      expect((error as Error).message).toBe("Decryption failed");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("rejects a data key that is not 32 bytes", async () => {
    const { v1 } = await twoVersions();

    await expect(v1.wrap(randomBytes(16))).rejects.toBeInstanceOf(TypeError);
    await expect(v1.wrap(randomBytes(33))).rejects.toBeInstanceOf(TypeError);
  });
});
