import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, KeyFileError, defineConfig, env, readKeyFile } from "./index";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "velexis-config-keys-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Writes a key file and sets its mode explicitly (the umask does not apply to chmod). */
function writeKeyFile(name: string, content: string | Buffer, mode: number): string {
  const path = join(tmp, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

/** A base64 key of `bytes` random bytes, as `pnpm dev:keys` writes it (with a trailing newline). */
function base64Key(bytes: number): string {
  return `${randomBytes(bytes).toString("base64")}\n`;
}

function keyFileErrorOf(fn: () => unknown): KeyFileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KeyFileError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a KeyFileError");
}

function configErrorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ConfigError");
}

const schema = { API_KEY_PEPPER_FILE: env.secretFile({ minBytes: 32 }) };

describe("env.secretFile", () => {
  it("rejects a missing file [X-002 AC3]", () => {
    const path = join(tmp, "missing-pepper");
    const error = configErrorOf(() => defineConfig(schema, { API_KEY_PEPPER_FILE: path }));
    expect(error.problems).toEqual([
      { variable: "API_KEY_PEPPER_FILE", reason: "must name a valid key file: the file does not exist" },
    ]);
    expect(error.message).not.toContain(path);
  });

  it("rejects a file with mode 0644 [X-002 AC3]", () => {
    const content = base64Key(32);
    const path = writeKeyFile("pepper-0644", content, 0o644);
    const error = configErrorOf(() => defineConfig(schema, { API_KEY_PEPPER_FILE: path }));
    expect(error.problems).toEqual([
      {
        variable: "API_KEY_PEPPER_FILE",
        reason:
          "must name a valid key file: the file is accessible by group or others (mode 0644); restrict it to mode 0400 or 0600",
      },
    ]);
    expect(error.message).not.toContain(path);
    expect(error.message).not.toContain(content.trim());
  });

  it("rejects a file shorter than minBytes after decoding [X-002 AC3]", () => {
    const content = base64Key(31);
    const path = writeKeyFile("pepper-short", content, 0o400);
    const error = configErrorOf(() => defineConfig(schema, { API_KEY_PEPPER_FILE: path }));
    expect(error.problems).toEqual([
      {
        variable: "API_KEY_PEPPER_FILE",
        reason: "must name a valid key file: the file decodes to fewer than 32 bytes",
      },
    ]);
    expect(error.message).not.toContain(path);
    expect(error.message).not.toContain(content.trim());
  });

  it("accepts a 0400 file and returns its absolute path, not its content [X-002 AC3]", () => {
    const path = writeKeyFile("pepper-0400", base64Key(32), 0o400);
    const config = defineConfig(schema, { API_KEY_PEPPER_FILE: path });
    expect(config.API_KEY_PEPPER_FILE).toBe(path);
  });

  it("accepts a 0600 file given by a relative path and a PEM key", () => {
    mkdirSync(join(tmp, "zone"));
    writeKeyFile("zone/api-key-pepper", base64Key(32), 0o600);
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeKeyFile("zone/ota-jwt-ed25519.pem", pem, 0o600);

    const config = defineConfig(
      {
        API_KEY_PEPPER_FILE: env.secretFile({ minBytes: 32 }),
        JWT_PRIVATE_KEY_FILE: env.secretFile({ minBytes: 32, encoding: "pem" }),
        DOCUMENT_URL_KEY_FILE: env.secretFile({ minBytes: 32, optional: true }),
      },
      { API_KEY_PEPPER_FILE: "zone/api-key-pepper", JWT_PRIVATE_KEY_FILE: "zone/ota-jwt-ed25519.pem" },
      { baseDir: tmp },
    );
    expect(config).toEqual({
      API_KEY_PEPPER_FILE: join(tmp, "zone", "api-key-pepper"),
      JWT_PRIVATE_KEY_FILE: join(tmp, "zone", "ota-jwt-ed25519.pem"),
      DOCUMENT_URL_KEY_FILE: undefined,
    });
  });
});

describe("readKeyFile", () => {
  it("returns the decoded bytes of a base64 key file", () => {
    const bytes = randomBytes(32);
    const path = writeKeyFile("master-v1.key", `${bytes.toString("base64")}\n`, 0o400);
    expect(readKeyFile(path, { minBytes: 32 }).equals(bytes)).toBe(true);
    expect(readKeyFile(path, { minBytes: 32, encoding: "base64" }).equals(bytes)).toBe(true);
  });

  it("refuses any access for group or others", () => {
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o444]) {
      const path = writeKeyFile(`mode-${mode.toString(8)}`, base64Key(32), mode);
      const error = keyFileErrorOf(() => readKeyFile(path, { minBytes: 32 }));
      expect(error.problem).toBe("permissions");
      expect(error.message).toContain(path);
    }
  });

  it("refuses something that is not a regular file without blocking", () => {
    const directory = join(tmp, "a-directory");
    mkdirSync(directory, { mode: 0o700 });
    expect(keyFileErrorOf(() => readKeyFile(directory, { minBytes: 32 })).problem).toBe("not-a-file");

    const fifo = join(tmp, "a-fifo");
    execFileSync("mkfifo", ["-m", "0600", fifo]);
    expect(keyFileErrorOf(() => readKeyFile(fifo, { minBytes: 32 })).problem).toBe("not-a-file");
  });

  it("refuses an empty file and a file that is not base64, without quoting the content", () => {
    expect(
      keyFileErrorOf(() => readKeyFile(writeKeyFile("empty", "\n", 0o600), { minBytes: 32 })).problem,
    ).toBe("empty");
    const content = "not*base64*Hunter2!";
    const error = keyFileErrorOf(() => readKeyFile(writeKeyFile("garbage", content, 0o600), { minBytes: 1 }));
    expect(error.problem).toBe("invalid-encoding");
    expect(error.message).toMatch(/is not valid base64$/);
    expect(error.message).not.toContain("Hunter2");
  });

  it("names the path and the reason but never the key in its message", () => {
    const content = base64Key(16);
    const path = writeKeyFile("short-key", content, 0o600);
    const error = keyFileErrorOf(() => readKeyFile(path, { minBytes: 32 }));
    expect(error).toMatchObject({ name: "KeyFileError", problem: "too-short", path });
    expect(error.message).toBe(`Key file ${path} decodes to fewer than 32 bytes`);
    expect(error.detail).toBe("decodes to fewer than 32 bytes");
    expect(`${error.message}${error.stack ?? ""}`).not.toContain(content.trim());
  });

  it("returns the PEM text after checking the length of its key", () => {
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const path = writeKeyFile("platform-jwt-ed25519.pem", pem, 0o400);
    expect(readKeyFile(path, { minBytes: 32, encoding: "pem" })).toBe(pem);
    // A PKCS#8 Ed25519 key is 48 bytes of DER.
    expect(keyFileErrorOf(() => readKeyFile(path, { minBytes: 49, encoding: "pem" })).problem).toBe(
      "too-short",
    );

    const notPem = writeKeyFile("not-pem.pem", base64Key(64), 0o400);
    expect(keyFileErrorOf(() => readKeyFile(notPem, { minBytes: 32, encoding: "pem" })).problem).toBe(
      "invalid-encoding",
    );
  });

  it("reports a missing file and rejects a nonsensical minBytes", () => {
    const missing = keyFileErrorOf(() => readKeyFile(join(tmp, "nope", "key"), { minBytes: 32 }));
    expect(missing.problem).toBe("missing");
    expect(missing.detail).toBe("does not exist");
    expect(() => readKeyFile(join(tmp, "nope"), { minBytes: 0 })).toThrow(TypeError);
    expect(() => readKeyFile(join(tmp, "nope"), { minBytes: 1.5 })).toThrow(TypeError);
  });
});
