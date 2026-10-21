// The customer password rules (OBE-032; ADR-0008 "Passwords", the storefront's published `passwordPolicy`).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DIR } from "../config";
import { CUSTOMER_PASSWORD_POLICY } from "../storefront/storefront.mapper";
import {
  BREACHED_PASSWORDS_FILE,
  CustomerPasswordPolicy,
  MIN_CUSTOMER_PASSWORD_LENGTH,
  parseBreachedPasswords,
} from "./password-policy";

/** The SHA-256 of the shipped list, as password-policy.ts documents its source (the platform's list). */
const LIST_SHA256 = "68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce";

/** A password of the test, never a real one: long enough and not on the list. */
const GOOD_PASSWORD = "Fjord-Lantern-Quiet-42";

/** The error `check` throws for `password`, or `undefined`. */
function refusal(policy: CustomerPasswordPolicy, password: string, path?: string): AppError | undefined {
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

let policy: CustomerPasswordPolicy;

beforeAll(() => {
  // Reading the 10 000 lines takes a few milliseconds alone; the bound allows for the parallel load of `pnpm test`.
  policy = CustomerPasswordPolicy.load();
}, 30_000);

describe("customer password rules", () => {
  it("[OBE-032] match the policy storefront.get publishes: at least 10 characters, breached passwords refused", () => {
    expect(MIN_CUSTOMER_PASSWORD_LENGTH).toBe(CUSTOMER_PASSWORD_POLICY.minLength);
    expect(CUSTOMER_PASSWORD_POLICY.rejectBreached).toBe(true);
    expect(policy.violations("Fjord-La4!")).toEqual([]);
    expect(policy.violations("Fjord-La4")).toEqual(["minLength"]);
    expect(policy.violations("")).toEqual(["minLength"]);
  });

  it("counts characters as Unicode code points, not UTF-16 units", () => {
    // Five emoji are ten UTF-16 units but five characters.
    expect(policy.violations("🙂🙂🙂🙂🙂")).toEqual(["minLength"]);
    expect(policy.violations("🙂🙂🙂🙂🙂-fjord")).toEqual([]);
  });

  it("[OBE-032] refuses a password of the breached list, in any letter case, and lists every rule it breaks", () => {
    for (const password of ["1234567890", "qwertyuiop", "QwertyUiop", "BASKETBALL"]) {
      expect(policy.violations(password)).toEqual(["breached"]);
    }
    expect(policy.violations("123456")).toEqual(["minLength", "breached"]);
    expect(policy.violations(GOOD_PASSWORD)).toEqual([]);
  });

  it("[OBE-032] check throws 422 PASSWORD_TOO_WEAK with the violations and a field error that never quotes it", () => {
    const tooShort = refusal(policy, "Fjord-La4");
    const breached = refusal(policy, "qwertyuiop", "/newPassword");

    expect(tooShort).toMatchObject({
      code: "PASSWORD_TOO_WEAK",
      status: 422,
      details: { violations: ["minLength"] },
    });
    expect(tooShort?.fieldErrors).toEqual([
      { path: "/password", code: "too_weak", message: "Use at least 10 characters." },
    ]);
    expect(breached?.details).toEqual({ violations: ["breached"] });
    expect(breached?.fieldErrors).toEqual([
      { path: "/newPassword", code: "too_weak", message: expect.any(String) as string },
    ]);
    expect(JSON.stringify([breached?.message, breached?.fieldErrors])).not.toContain("qwertyuiop");
    expect(JSON.stringify([tooShort?.message, tooShort?.fieldErrors])).not.toContain("Fjord-La4");
    expect(refusal(policy, GOOD_PASSWORD)).toBeUndefined();
  });
});

describe("the breached-password list", () => {
  it("is the documented SecLists top 10 000, as the platform ships it", () => {
    const text = readFileSync(BREACHED_PASSWORDS_FILE);
    expect(createHash("sha256").update(text).digest("hex")).toBe(LIST_SHA256);
    expect(policy.breachedCount).toBeGreaterThan(9_000);
  });

  it("ships next to the compiled code: the build copies it to dist/identity", () => {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(BREACHED_PASSWORDS_FILE).toBe(join(APP_DIR, "src", "identity", "breached-passwords.txt"));
    expect(manifest.scripts["build"]).toContain(
      "require('node:fs').cpSync('src/identity/breached-passwords.txt', 'dist/identity/breached-passwords.txt')",
    );
  });

  it("parses one lower-cased password per line and skips empty lines", () => {
    expect([...parseBreachedPasswords("Password\r\n\n  qwerty  \nPASSWORD\n")]).toEqual([
      "password",
      "qwerty",
    ]);
  });

  it("refuses an empty list", () => {
    expect(() => new CustomerPasswordPolicy(new Set())).toThrow(/empty/);
  });
});
