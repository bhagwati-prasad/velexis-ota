import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorage, STORAGE_DRIVERS, type StorageAdapter } from "./index.js";
import { assertStorageKey, LocalDiskStorage, StorageKeyError } from "./local-disk-storage.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "velexis-storage-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PDF = Buffer.from("%PDF-1.7 test document");

describe("assertStorageKey", () => {
  it.each([
    "tenant_acme/documents/doc_01J9ZK3X.pdf",
    "tenant_acme/assets/3f5a.png",
    "tenant_alpha/x.pdf",
    "platform/exports/2026-10.csv",
    "platform/a_b-c.d",
  ])("accepts %j", (key) => {
    expect(() => {
      assertStorageKey(key);
    }).not.toThrow();
  });

  it.each([
    ["..", "tenant_acme/../tenant_beta/x.pdf"],
    ["..", "tenant_acme/.."],
    ["..", "../etc/passwd"],
    ["..", "tenant_acme/a..b.pdf"],
    ["prefix", "/etc/passwd"],
    ["prefix", "public/x.pdf"],
    ["prefix", "tenant_a/x.pdf"],
    ["prefix", "Tenant_acme/x.pdf"],
    ["prefix", "tenant_acme"],
    ["name", "platform"],
    ["segment", "tenant_acme/"],
    ["segment", "tenant_acme//x.pdf"],
    ["segment", "tenant_acme/./x.pdf"],
    ["segment", "tenant_acme/.hidden"],
    ["segment", "tenant_acme\\..\\x.pdf"],
    ["segment", "tenant_acme/x y.pdf"],
    ["segment", "tenant_acme/x\u0000.pdf"],
    ["empty", ""],
  ])("rejects a key with a bad %s: %j", (_problem, key) => {
    expect(() => {
      assertStorageKey(key);
    }).toThrow(StorageKeyError);
  });

  it("rejects keys longer than 512 characters and non-strings", () => {
    expect(() => {
      assertStorageKey(`tenant_acme/${"x".repeat(501)}`);
    }).toThrow(StorageKeyError);
    expect(() => {
      assertStorageKey(42);
    }).toThrow(StorageKeyError);
  });
});

describe("LocalDiskStorage", () => {
  it("writes files with mode 0600 in directories with mode 0700 [X-010 AC6]", async () => {
    const storage = new LocalDiskStorage(dir);

    await storage.put("tenant_acme/documents/doc_1.pdf", PDF, "application/pdf");

    const file = join(dir, "tenant_acme", "documents", "doc_1.pdf");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "tenant_acme"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "tenant_acme", "documents"))).mode & 0o777).toBe(0o700);
    expect(await readFile(file)).toEqual(PDF);
  });

  it("never relies on the umask: a permissive umask 000 still gives files 0600 and directories 0700", async () => {
    const previous = process.umask(0o000);
    try {
      await new LocalDiskStorage(dir).put("platform/exports/report.csv", Buffer.from("a,b\n"), "text/csv");
    } finally {
      process.umask(previous);
    }
    expect((await stat(join(dir, "platform", "exports", "report.csv"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "platform"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "platform", "exports"))).mode & 0o777).toBe(0o700);
  });

  it.each([
    "tenant_acme/../tenant_beta/doc.pdf",
    "tenant_acme/../../etc/passwd",
    "../outside.pdf",
    "tenant_acme/..",
  ])("rejects the key %j with .. in put, get, delete and signedUrl [X-010 AC6]", async (key) => {
    const storage = new LocalDiskStorage(dir, { signUrl: () => "https://example.test/x" });

    await expect(storage.put(key, PDF, "application/pdf")).rejects.toThrow(StorageKeyError);
    await expect(storage.get(key)).rejects.toThrow(StorageKeyError);
    await expect(storage.delete(key)).rejects.toThrow(StorageKeyError);
    await expect(storage.signedUrl(key, 300)).rejects.toThrow(StorageKeyError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("reads back what it stored, returns null for a missing key and deletes idempotently", async () => {
    const storage: StorageAdapter = new LocalDiskStorage(dir);
    const key = "tenant_acme/documents/doc_2.pdf";

    expect(await storage.get(key)).toBeNull();
    await storage.put(key, PDF, "application/pdf");
    expect(await storage.get(key)).toEqual(PDF);

    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    await expect(storage.delete(key)).resolves.toBeUndefined();
    expect(await storage.get("tenant_acme/documents/doc_2.pdf/inner")).toBeNull();
  });

  it("replaces an object atomically and leaves no temporary file behind", async () => {
    const storage = new LocalDiskStorage(dir);
    const key = "tenant_acme/assets/logo.png";

    await storage.put(key, Buffer.from("first"), "image/png");
    await storage.put(key, Buffer.from("second version"), "image/png");

    expect(await storage.get(key)).toEqual(Buffer.from("second version"));
    expect(await readdir(join(dir, "tenant_acme", "assets"))).toEqual(["logo.png"]);
  });

  it("removes the temporary file and keeps the old object when a write fails", async () => {
    const storage = new LocalDiskStorage(dir);
    const key = "tenant_acme/assets/logo.png";
    await storage.put(key, Buffer.from("first"), "image/png");
    // A directory in the way of the rename makes the final step fail after the temp file was written.
    const blocked = "tenant_acme/assets/blocked";
    await storage.put(`${blocked}/inner.png`, Buffer.from("x"), "image/png");

    await expect(storage.put(blocked, Buffer.from("y"), "image/png")).rejects.toThrow();

    expect((await readdir(join(dir, "tenant_acme", "assets"))).sort()).toEqual(["blocked", "logo.png"]);
    expect(await storage.get(key)).toEqual(Buffer.from("first"));
  });

  it("checks the bytes and the content type", async () => {
    const storage = new LocalDiskStorage(dir);
    await expect(
      storage.put("tenant_acme/x.pdf", "text" as unknown as Uint8Array, "application/pdf"),
    ).rejects.toThrow(TypeError);
    await expect(storage.put("tenant_acme/x.pdf", PDF, "pdf")).rejects.toThrow(TypeError);
    await expect(storage.put("tenant_acme/x.csv", PDF, "text/csv; charset=utf-8")).resolves.toBeUndefined();
  });

  it("signs a URL that expires ttlSeconds from now through the injected signer", async () => {
    const signUrl = vi.fn(
      (key: string, expiresAt: Date) =>
        `https://api.example.test/v1/files/${key}?exp=${expiresAt.toISOString()}`,
    );
    const storage = new LocalDiskStorage(dir, { signUrl, now: () => new Date("2026-10-13T07:44:00Z") });

    await expect(storage.signedUrl("tenant_acme/documents/doc_1.pdf", 300)).resolves.toBe(
      "https://api.example.test/v1/files/tenant_acme/documents/doc_1.pdf?exp=2026-10-13T07:49:00.000Z",
    );
    expect(signUrl).toHaveBeenCalledWith("tenant_acme/documents/doc_1.pdf", new Date("2026-10-13T07:49:00Z"));
    await expect(storage.signedUrl("tenant_acme/documents/doc_1.pdf", 0)).rejects.toThrow(TypeError);
  });

  it("refuses to sign without a signer", async () => {
    await expect(new LocalDiskStorage(dir).signedUrl("tenant_acme/x.pdf", 300)).rejects.toThrow(
      /needs the signUrl option/,
    );
  });
});

describe("createStorage", () => {
  it("creates a LocalDiskStorage for the local driver", () => {
    const storage = createStorage({ driver: "local", dir });
    expect(storage).toBeInstanceOf(LocalDiskStorage);
    expect((storage as LocalDiskStorage).root).toBe(dir);
  });

  it("needs a directory for the local driver", () => {
    expect(() => createStorage({ driver: "local" })).toThrow(/needs dir/);
  });

  it('throws "not implemented" for the s3 driver', () => {
    expect(() => createStorage({ driver: "s3" })).toThrow(/not implemented/);
  });

  it("lists the drivers of STORAGE_DRIVER", () => {
    expect(STORAGE_DRIVERS).toEqual(["local", "s3"]);
  });
});
