// The password rules and the Argon2id hashing of the portal (PBE-013; ADR-0008 "Passwords", scope PF-01 AC2).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DIR } from "../config";
import {
  ARGON2_OPTIONS,
  BREACHED_PASSWORDS_FILE,
  MIN_PASSWORD_LENGTH,
  parseBreachedPasswords,
  PasswordPolicy,
} from "./password-policy";

/** The SHA-256 of the shipped list, as password-policy.ts documents its source. */
const LIST_SHA256 = "68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce";

/** A password of the test, never a real one: long enough and not on the list. */
const GOOD_PASSWORD = "Fjord-Lantern-Quiet-42";

/** The error `check` throws for `password`, or `undefined`. */
function refusal(policy: PasswordPolicy, password: string, path?: string): AppError | undefined {
  try {
    policy.check(password, path);
    return undefined;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
}

let policy: PasswordPolicy;
let goodHash: string;

beforeAll(async () => {
  // Reading the 10 000 lines and one Argon2id hash (19 MiB, 2 passes) take well under a second alone; the bound allows
  // for the parallel load of `pnpm test` on a 4-CPU CI runner.
  policy = PasswordPolicy.load();
  goodHash = await policy.hash(GOOD_PASSWORD);
}, 30_000);

describe("password rules", () => {
  it("[PBE-013 AC2] refuses a 9-character password and accepts one of 10 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(policy.problem("Fjord-La4!")).toBeUndefined();
    expect(policy.problem("Fjord-La4")).toBe("too_short");
    expect(policy.problem("")).toBe("too_short");
  });

  it("counts characters as Unicode code points, not UTF-16 units", () => {
    // Five emoji are ten UTF-16 units but five characters.
    expect(policy.problem("🙂🙂🙂🙂🙂")).toBe("too_short");
    expect(policy.problem("🙂🙂🙂🙂🙂-fjord")).toBeUndefined();
  });

  it("[PBE-013 AC2] refuses a password of the breached list, in any letter case", () => {
    for (const password of ["1234567890", "qwertyuiop", "QwertyUiop", "BASKETBALL"]) {
      expect(policy.problem(password)).toBe("breached");
    }
    expect(policy.problem(GOOD_PASSWORD)).toBeUndefined();
  });

  it("[PBE-013 AC2] check throws 422 PASSWORD_TOO_WEAK with a field error that never quotes the password", () => {
    const tooShort = refusal(policy, "Fjord-La4");
    const breached = refusal(policy, "qwertyuiop", "/newPassword");

    expect(tooShort).toMatchObject({ code: "PASSWORD_TOO_WEAK", status: 422 });
    expect(tooShort?.fieldErrors).toEqual([
      { path: "/password", code: "too_short", message: "Use at least 10 characters." },
    ]);
    expect(breached?.fieldErrors).toEqual([
      { path: "/newPassword", code: "breached", message: expect.any(String) as string },
    ]);
    expect(JSON.stringify([breached?.message, breached?.fieldErrors])).not.toContain("qwertyuiop");
    expect(JSON.stringify([tooShort?.message, tooShort?.fieldErrors])).not.toContain("Fjord-La4");
    expect(refusal(policy, GOOD_PASSWORD)).toBeUndefined();
  });
});

describe("the breached-password list", () => {
  it("is the documented public top-10 000 list: lower-case, one password per line, read once into a set", () => {
    const text = readFileSync(BREACHED_PASSWORDS_FILE, "utf8");
    const lines = text.split("\n");

    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(LIST_SHA256);
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).every((line) => line !== "" && line === line.trim().toLowerCase())).toBe(true);
    expect(policy.breachedCount).toBeGreaterThanOrEqual(10_000);
    expect(policy.breachedCount).toBe(new Set(lines.slice(0, -1)).size);
  });

  it("ships next to the compiled code: the build copies it to dist/auth", () => {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(BREACHED_PASSWORDS_FILE).toBe(join(APP_DIR, "src", "auth", "breached-passwords.txt"));
    expect(manifest.scripts["build"]).toContain(
      "require('node:fs').cpSync('src/auth/breached-passwords.txt', 'dist/auth/breached-passwords.txt')",
    );
  });

  it("parses lists with CRLF line ends, blank lines, spaces and capitals", () => {
    expect([...parseBreachedPasswords("Password1\r\n\r\n  dragon  \nDRAGON\n")]).toEqual([
      "password1",
      "dragon",
    ]);
  });

  it("refuses to build a policy on an empty list", () => {
    expect(() => new PasswordPolicy(new Set())).toThrow("the breached-password list is empty");
  });
});

describe("hashing", () => {
  it("[PBE-013 AC5] hashes with Argon2id and the OWASP parameters of ADR-0008", () => {
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    expect(goodHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(goodHash).not.toContain(GOOD_PASSWORD);
  });

  it("verifies the right password only, and a hash that cannot be read as no match", async () => {
    await expect(policy.verify(goodHash, GOOD_PASSWORD)).resolves.toBe(true);
    await expect(policy.verify(goodHash, `${GOOD_PASSWORD}x`)).resolves.toBe(false);
    await expect(policy.verify("not-a-phc-string", GOOD_PASSWORD)).resolves.toBe(false);
  });
});
