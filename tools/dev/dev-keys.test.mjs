// Tests of dev-keys.mjs with the Node 22 test runner (no dependencies): node --test tools/dev/dev-keys.test.mjs
// Each test runs the script as a child process against its own temporary --root.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "dev-keys.mjs");
const RANDOM_KEYS = ["master-v1.key", "api-key-pepper", "document-url.key"];
const PEM_KEYS = ["platform-jwt-ed25519.pem", "ota-jwt-ed25519.pem"];
const ALL_KEYS = [...RANDOM_KEYS, ...PEM_KEYS];

const roots = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "velexis-dev-keys-"));
  roots.push(root);
  return root;
}

function run(root, ...args) {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const mode = (file) => statSync(file).mode & 0o777;
const keysDir = (root) => path.join(root, ".local", "keys");

/** Content hash, inode and modification time of every key file: any rewrite changes at least one of them. */
function fingerprint(root) {
  return Object.fromEntries(
    ALL_KEYS.map((name) => {
      const file = path.join(keysDir(root), name);
      const stat = statSync(file);
      const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
      return [name, `${sha} ${stat.ino} ${stat.mtimeMs} ${mode(file).toString(8)}`];
    }),
  );
}

describe("dev-keys.mjs", () => {
  test("[X-016 AC3] creates the five key files with mode 0600 in a 0700 folder, and .local/storage", () => {
    const root = newRoot();
    const { status, output } = run(root);
    assert.equal(status, 0, output);

    assert.deepEqual(readdirSync(keysDir(root)).sort(), [...ALL_KEYS].sort());
    assert.equal(mode(keysDir(root)), 0o700);
    for (const name of ALL_KEYS) {
      assert.equal(mode(path.join(keysDir(root), name)), 0o600, name);
    }
    assert.ok(statSync(path.join(root, ".local", "storage")).isDirectory());

    for (const name of RANDOM_KEYS) {
      const text = readFileSync(path.join(keysDir(root), name), "utf8");
      assert.match(text, /^[A-Za-z0-9+/]{43}=\n$/, name);
      assert.equal(Buffer.from(text, "base64").length, 32, name);
    }
    for (const name of PEM_KEYS) {
      const pem = readFileSync(path.join(keysDir(root), name), "utf8");
      assert.match(pem, /^-----BEGIN PRIVATE KEY-----\n/, name);
      assert.equal(createPrivateKey(pem).asymmetricKeyType, "ed25519", name);
    }
    const contents = ALL_KEYS.map((name) => readFileSync(path.join(keysDir(root), name), "utf8"));
    assert.equal(new Set(contents).size, ALL_KEYS.length, "every key is different");
  });

  test("[X-016 AC3] a second run keeps every file unchanged", () => {
    const root = newRoot();
    assert.equal(run(root).status, 0);
    const before = fingerprint(root);

    const { status, output } = run(root);
    assert.equal(status, 0, output);
    assert.deepEqual(fingerprint(root), before);
    assert.match(output, /0 created, 0 replaced, 5 kept/);
  });

  test("[X-016 AC3] never prints key material", () => {
    const root = newRoot();
    const { output } = run(root);
    for (const name of ALL_KEYS) {
      const text = readFileSync(path.join(keysDir(root), name), "utf8");
      const secret = name.endsWith(".pem") ? text.split("\n")[1] : text.trim();
      assert.ok(!output.includes(secret), `${name} must not appear in the output`);
    }
  });

  test("[X-016 AC3] --force replaces the keys and keeps mode 0600", () => {
    const root = newRoot();
    assert.equal(run(root).status, 0);
    const before = fingerprint(root);

    const { status, output } = run(root, "--force");
    assert.equal(status, 0, output);
    const afterForce = fingerprint(root);
    for (const name of ALL_KEYS) {
      assert.notEqual(afterForce[name].split(" ")[0], before[name].split(" ")[0], name);
      assert.equal(mode(path.join(keysDir(root), name)), 0o600, name);
    }
    assert.deepEqual(readdirSync(keysDir(root)).sort(), [...ALL_KEYS].sort(), "no temporary file is left");
    assert.match(output, /0 created, 5 replaced, 0 kept/);
  });

  test("[X-016 AC3] keeps an existing file's content, creates the missing ones and tightens loose modes", () => {
    const root = newRoot();
    mkdirSync(keysDir(root), { recursive: true, mode: 0o755 });
    const pepper = path.join(keysDir(root), "api-key-pepper");
    writeFileSync(pepper, "existing-pepper\n");
    chmodSync(pepper, 0o644);

    const { status, output } = run(root);
    assert.equal(status, 0, output);
    assert.equal(readFileSync(pepper, "utf8"), "existing-pepper\n");
    assert.equal(mode(pepper), 0o600);
    assert.equal(mode(keysDir(root)), 0o700);
    assert.deepEqual(readdirSync(keysDir(root)).sort(), [...ALL_KEYS].sort());
    assert.match(output, /4 created, 0 replaced, 1 kept/);
  });

  test("[X-016 AC3] rejects unknown arguments without writing anything", () => {
    const root = newRoot();
    const { status, output } = run(root, "--bogus");
    assert.equal(status, 2);
    assert.match(output, /usage: node tools\/dev\/dev-keys\.mjs/);
    assert.deepEqual(readdirSync(root), []);
  });
});
