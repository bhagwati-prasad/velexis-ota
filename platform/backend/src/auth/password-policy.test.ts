// The password rule and the Argon2id hashing of the portal (PBE-013; ADR-0008 "Passwords", scope PF-01 AC2): since
// the owner's decision (15e) of 2026-11-11 (FIX-W48-PLATFORM; ADR-0008 revision of 2026-11-11) every portal account's
// password needs 12 characters with a letter and a digit (PCI DSS 8.3.6), the rule FIX-W47-PLATFORM had asked of
// platform admins and the owners and admins of OTAs only. Since lead decision (17b) of 2026-11-11 (PBE-073) the
// breached-password list holds the rule-meeting entries of a public list of about a million breached passwords, built
// and checked by scripts/breached-passwords.mjs, which this file runs (`--check`) and imports.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "@velexis/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_DIR } from "../config";
import {
  ARGON2_OPTIONS,
  BREACHED_PASSWORDS_FILE,
  MIN_PASSWORD_LENGTH,
  parseBreachedPasswords,
  PasswordPolicy,
  RULE_MESSAGE,
} from "./password-policy";

/** The SHA-256 of the shipped list, as password-policy.ts and scripts/breached-passwords.mjs record it (PBE-073). */
const LIST_SHA256 = "df67d6b895d1c029308223dd82298bbde1b2f776fd9ae5d5b9ac3bbe17e31faf";
/** Its entries and bytes: the rule-meeting entries of the pinned source, lower-cased and unique. */
const LIST_ENTRIES = 28_897;
const LIST_BYTES = 421_156;
/** The pinned source: SecLists `xato-net-10-million-passwords-1000000.txt` at this commit, with this SHA-256. */
const SOURCE_COMMIT = "c23b603128ed21e46164a0afd357f0c242135f41";
const SOURCE_SHA256 = "424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51";

/** Rule-meeting entries of the shipped list, as listed (lower-cased) and in other letter cases. */
const LISTED = ["password1234", "1qaz2wsx3edc", "qwertyuiop123", "iloveyou1234"] as const;
const LISTED_OTHER_CASE = ["Password1234", "1QAZ2wsx3EDC", "QWERTYUIOP123", "ILoveYou1234"] as const;

/** A password of the test, never a real one: long enough, with a letter and a digit, and not on the list. */
const GOOD_PASSWORD = "Fjord-Lantern-Quiet-42";

/** The field error message of the rule. */
const RULE_FIELD_MESSAGE = "Use at least 12 characters, with at least one letter and one digit.";

/** scripts/breached-passwords.mjs, and what this file uses of it. */
const SCRIPT = join(APP_DIR, "scripts", "breached-passwords.mjs");
interface BreachedPasswordsScript {
  readonly MIN_PASSWORD_LENGTH: number;
  readonly SOURCE: { readonly commit: string; readonly sha256: string; readonly lines: number };
  readonly LIST: { readonly entries: number; readonly bytes: number; readonly sha256: string };
  readonly DEFAULT_LIST: string;
  meetsRule(password: string): boolean;
  compareCodePoints(a: string, b: string): number;
  buildList(sourceText: string): { text: string; sourceLines: number; meetingRule: number; entries: number };
  checkList(
    text: string,
    expected?: { entries?: number; sha256?: string },
  ): { problems: string[]; entries: number; bytes: number; sha256: string };
  main(argv: string[], log?: (line: string) => void): number;
}

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

/** Runs the script with `args` (no shell, no network). */
function runScript(...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

let policy: PasswordPolicy;
let goodHash: string;
let script: BreachedPasswordsScript;
let shippedText: string;
let scratch: string;
/** The script's runs: `--check` of the shipped list, of two altered copies, and a refused `--source`. */
let runs: Record<"shipped" | "altered" | "entryDropped" | "wrongSource", SpawnSyncReturns<string>>;
let wrongSourceOutput: string;

beforeAll(async () => {
  // Reading the 28 897 lines, one Argon2id hash (19 MiB, 2 passes), importing the script and four runs of it (a Node
  // start each) take about a second alone; the bound allows for the parallel load of `pnpm test` on a 4-CPU runner.
  policy = PasswordPolicy.load();
  goodHash = await policy.hash(GOOD_PASSWORD);
  script = (await import(pathToFileURL(SCRIPT).href)) as BreachedPasswordsScript;
  shippedText = readFileSync(BREACHED_PASSWORDS_FILE, "utf8");

  scratch = mkdtempSync(join(tmpdir(), "breached-passwords-"));
  const altered = join(scratch, "altered.txt");
  // A duplicate, an entry that breaks the rule, one out of order, one in capitals, one with spaces around it, an empty
  // line, and a last line that ends with a CR and no LF.
  writeFileSync(
    altered,
    "iloveyou1234\niloveyou1234\nqwerty\npassword1234\nPASSWORD12345\n zz-password-1234 \n\nzz-password-5678\r",
  );
  const entryDropped = join(scratch, "entry-dropped.txt");
  // The shipped list without its first entry: still well-formed, so only the count and the checksum tell.
  writeFileSync(entryDropped, shippedText.slice(shippedText.indexOf("\n") + 1));
  const wrongSource = join(scratch, "source.txt");
  wrongSourceOutput = join(scratch, "written.txt");
  writeFileSync(wrongSource, "Password1234\nqwertyuiop123\n");
  runs = {
    shipped: runScript("--check"),
    altered: runScript("--check", "--list", altered),
    entryDropped: runScript("--check", "--list", entryDropped),
    wrongSource: runScript("--source", wrongSource, "--list", wrongSourceOutput),
  };
}, 30_000);

afterAll(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("the password rule of every portal account (PCI DSS 8.3.6)", () => {
  it("[FIX-W48-PLATFORM AC1] asks for 12 characters: refuses 9, 10 and 11, and accepts 12, letters and digits included", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(policy.problem("Fjord-Lan4!x")).toBeUndefined();
    // The lengths the 10-character rule took before (PBE-013) and the privileged rule refused (FIX-W47-PLATFORM).
    expect(policy.problem("Fjord-Lan4!")).toBe("password_rule");
    expect(policy.problem("Fjord-La4!")).toBe("password_rule");
    expect(policy.problem("Fjord-La4")).toBe("password_rule");
    expect(policy.problem("")).toBe("password_rule");
  });

  it("[FIX-W48-PLATFORM AC1] asks for at least one letter and one digit, of any script, and counts code points", () => {
    expect(policy.problem("Fjord-Lantern-Quiet")).toBe("password_rule");
    expect(policy.problem("4815-1623-4200")).toBe("password_rule");
    expect(policy.problem("!!--__??..//")).toBe("password_rule");
    expect(policy.problem("Fjord-Lantern-Quiet-4")).toBeUndefined();
    expect(policy.problem("ÅÄÖ-жизнь-7-ü")).toBeUndefined();
    expect(policy.problem("٣٤٥٦-fjord-lantern")).toBeUndefined();
  });

  it("counts characters as Unicode code points, not UTF-16 units", () => {
    // Eleven emoji, a letter and a digit are 13 characters; eleven characters with one emoji (12 UTF-16 units) are not
    // enough, and neither are six emoji (12 UTF-16 units) with a letter and a digit.
    expect(policy.problem("🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂a1")).toBeUndefined();
    expect(policy.problem("🙂abcdefgh12")).toBe("password_rule");
    expect(policy.problem("🙂🙂🙂🙂🙂🙂a1")).toBe("password_rule");
  });

  it("[PBE-013 AC2] refuses a password of the breached list, in any letter case, and names it before the rule [PBE-073 AC2]", () => {
    // The shipped list: rule-meeting entries, as listed and in other letter cases.
    for (const password of [...LISTED, ...LISTED_OTHER_CASE]) {
      expect(policy.problem(password)).toBe("breached");
    }
    // Not listed, though they hold a listed password: the list is compared whole, never as a part.
    for (const password of [GOOD_PASSWORD, "Password1234-Fjord", "Fjord-iloveyou1234"]) {
      expect(policy.problem(password)).toBeUndefined();
    }
    // The order of decision (16b): every entry of the shipped list meets the rule, so the order shows with a list of
    // the test's own, whose entries break it (too short; no digit).
    const own = new PasswordPolicy(parseBreachedPasswords("QwertyUiop\nbasketball\n"));
    for (const password of ["qwertyuiop", "QWERTYUIOP", "BasketBall"]) {
      expect(own.problem(password)).toBe("breached");
    }
    expect(own.problem("Qwerty")).toBe("password_rule");
    expect(own.problem(GOOD_PASSWORD)).toBeUndefined();
  });

  it("[PBE-073 AC2] refuses a short common password by the rule: no entry of the shipped list breaks it", () => {
    // The top-10 000 list named these `breached` until PBE-073 (lead decision (17b)); the rule refuses them now.
    for (const password of ["QwertyUiop", "qwertyuiop", "1234567890", "BASKETBALL", "password1"]) {
      expect(policy.problem(password)).toBe("password_rule");
    }
  });

  it("[FIX-W48-PLATFORM AC1] still refuses a listed password that has the length, a letter and a digit", () => {
    // The shipped list does so too (the test above); this policy's own list keeps the case of decision (16b) apart
    // from the shipped file.
    const own = new PasswordPolicy(parseBreachedPasswords("Copper-Kettle-Morning-9\n"));
    for (const password of ["Copper-Kettle-Morning-9", "COPPER-KETTLE-MORNING-9"]) {
      expect(own.problem(password)).toBe("breached");
    }
    expect(own.problem(GOOD_PASSWORD)).toBeUndefined();
  });

  it("[FIX-W48-PLATFORM AC1] check throws 422 PASSWORD_TOO_WEAK naming the rule, with a field error that never quotes the password [PBE-073 AC2]", () => {
    const short = refusal(policy, "Fjord-Lan4!");
    const noDigit = refusal(policy, "Kettle-Morning!", "/newPassword");
    const breached = refusal(policy, "ILoveYou1234", "/newPassword");

    expect(short).toMatchObject({ code: "PASSWORD_TOO_WEAK", status: 422 });
    expect(short?.message).toBe(RULE_MESSAGE);
    expect(RULE_MESSAGE).toBe(
      "The password needs at least 12 characters with at least one letter and one digit, and must not be a common or breached password.",
    );
    expect(short?.fieldErrors).toEqual([
      { path: "/password", code: "password_rule", message: RULE_FIELD_MESSAGE },
    ]);
    expect(noDigit?.fieldErrors).toEqual([
      { path: "/newPassword", code: "password_rule", message: RULE_FIELD_MESSAGE },
    ]);
    expect(breached).toMatchObject({ code: "PASSWORD_TOO_WEAK", status: 422 });
    expect(breached?.message).toBe(RULE_MESSAGE);
    expect(breached?.fieldErrors).toEqual([
      { path: "/newPassword", code: "breached", message: expect.any(String) as string },
    ]);
    expect(JSON.stringify([breached?.message, breached?.fieldErrors]).toLowerCase()).not.toContain(
      "iloveyou1234",
    );
    expect(JSON.stringify([short?.message, short?.fieldErrors])).not.toContain("Fjord-Lan4!");
    expect(JSON.stringify([noDigit?.message, noDigit?.fieldErrors])).not.toContain("Kettle-Morning!");
    expect(refusal(policy, GOOD_PASSWORD)).toBeUndefined();
  });
});

describe("the breached-password list", () => {
  it("[PBE-073 AC1] is the recorded list: lower-case, trimmed, unique, in code-point order, one password per line, read once into a set", () => {
    const lines = shippedText.split("\n");

    expect(createHash("sha256").update(shippedText, "utf8").digest("hex")).toBe(LIST_SHA256);
    expect(Buffer.byteLength(shippedText, "utf8")).toBe(LIST_BYTES);
    expect(lines.at(-1)).toBe("");
    const entries = lines.slice(0, -1);
    expect(entries.every((line) => line !== "" && line === line.trim().toLowerCase())).toBe(true);
    expect(entries.every((line, i) => i === 0 || script.compareCodePoints(entries[i - 1]!, line) < 0)).toBe(
      true,
    );
    expect(entries).toHaveLength(LIST_ENTRIES);
    expect(policy.breachedCount).toBe(entries.length);
    expect(script.LIST).toEqual({ entries: LIST_ENTRIES, bytes: LIST_BYTES, sha256: LIST_SHA256 });
    expect(script.SOURCE).toMatchObject({ commit: SOURCE_COMMIT, sha256: SOURCE_SHA256, lines: 999_999 });
  });

  it("[PBE-073 AC1] breached-passwords.mjs --check passes offline on the shipped list", () => {
    expect(runs.shipped.stderr).toBe("");
    expect(runs.shipped.status).toBe(0);
    expect(runs.shipped.stdout).toContain(
      `OK: ${LIST_ENTRIES} entries, ${LIST_BYTES} bytes, SHA-256 ${LIST_SHA256}`,
    );
    expect(script.DEFAULT_LIST).toBe(BREACHED_PASSWORDS_FILE);
  });

  it("[PBE-073 AC1] breached-passwords.mjs --check refuses a list with a duplicate, a rule-breaking, unordered, capital, spaced or empty entry, a CR, no final LF, or a dropped entry", () => {
    expect(runs.altered.status).toBe(1);
    expect(runs.altered.stdout).toContain("FAILED");
    for (const problem of [
      "line 2: repeats the line before it",
      "line 3: does not meet the rule (12 characters, a letter and a digit)",
      "line 4: not in code-point order after the line before it",
      "line 5: not lower-cased",
      "line 6: has spaces around it",
      "line 7: empty",
      "the file holds a CR; lines end with LF only",
      "the file does not end with LF",
      "8 lines, 28897 recorded",
    ]) {
      expect(runs.altered.stdout).toContain(problem);
    }
    // The problems name lines, never the passwords.
    expect(runs.altered.stdout).not.toMatch(/iloveyou1234|zz-password/);

    expect(runs.entryDropped.status).toBe(1);
    expect(runs.entryDropped.stdout).toContain(`${LIST_ENTRIES - 1} lines, ${LIST_ENTRIES} recorded`);
    expect(runs.entryDropped.stdout).toContain(`, ${LIST_SHA256} recorded`);
    expect(runs.entryDropped.stdout).not.toContain("line 1:");
  });

  it("[PBE-073 AC1] breached-passwords.mjs refuses a source that is not the pinned one and writes nothing", () => {
    expect(runs.wrongSource.status).toBe(1);
    expect(runs.wrongSource.stdout).toContain(`not the pinned ${SOURCE_SHA256}`);
    expect(runs.wrongSource.stdout).toContain("nothing was written");
    expect(() => readFileSync(wrongSourceOutput)).toThrow(/ENOENT/);
  });

  it("[PBE-073 AC1] breached-passwords.mjs answers 2 with its usage to missing, unknown or conflicting arguments", () => {
    for (const argv of [[], ["--check", "--source", "source.txt"], ["--list"], ["--force"], ["list.txt"]]) {
      const lines: string[] = [];
      expect(script.main(argv, (line) => lines.push(line))).toBe(2);
      expect(lines.join("\n")).toContain(
        "usage: node platform/backend/scripts/breached-passwords.mjs --check",
      );
    }
  });

  it("[PBE-073 AC1] the script keeps exactly the source lines PasswordPolicy's rule lets through, lower-cased, unique and in code-point order", () => {
    // A policy whose list names none of these, so `problem` answers for the rule alone.
    const ruleOnly = new PasswordPolicy(parseBreachedPasswords("not-a-line-of-this-source\n"));
    const source = [
      "Password1234",
      "password1234", // the same entry once lower-cased
      "  1qaz2wsx3edc  ", // trimmed
      "qwerty", // too short
      "Qwertyuiop1", // 11 characters with a letter and a digit: one short
      "abcdefghijklmn", // no digit
      "123456789012345", // no letter
      "жизнь-12345678", // letters of another script
      "٣٤٥٦٧٨٩٠-abcd", // Arabic-Indic digits
      "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂a1", // 12 code points, 22 UTF-16 units
      "🙂🙂🙂🙂🙂a1", // 7 code points, 12 UTF-16 units
      "\u{FF5E}fjord-lantern-1", // U+FF5E sorts before the emoji by code point, after them by UTF-16 unit
      "",
    ].join("\r\n");

    const built = script.buildList(source);
    const kept = built.text.split("\n").slice(0, -1);

    expect(kept).toEqual([
      "1qaz2wsx3edc",
      "password1234",
      "жизнь-12345678",
      "٣٤٥٦٧٨٩٠-abcd",
      "\u{FF5E}fjord-lantern-1",
      "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂a1",
    ]);
    expect(built).toMatchObject({ sourceLines: 12, meetingRule: 7, entries: 6 });
    for (const line of source.split("\r\n")) {
      const keptByRule = ruleOnly.problem(line.trim()) === undefined;
      expect(kept.includes(line.trim().toLowerCase())).toBe(keptByRule);
      expect(script.meetsRule(line.trim())).toBe(keptByRule);
    }
    expect(script.MIN_PASSWORD_LENGTH).toBe(MIN_PASSWORD_LENGTH);
    expect(script.checkList(built.text, {}).problems).toEqual([]);
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

  it("[FIX-W48-PLATFORM AC1] holds only passwords that meet the rule, flipped by lead decision (17b) from 'holds no password that meets the rule' [PBE-073 AC1]", () => {
    // Until PBE-073 the top-10 000 list held no password that met the rule; lead decision (17b) of 2026-11-11 keeps
    // only the rule-meeting entries of the larger list, so the opposite holds now: every entry meets the rule, as
    // PasswordPolicy counts it (a policy whose own list names none of them).
    const ruleOnly = new PasswordPolicy(parseBreachedPasswords("not-a-line-of-the-list\n"));
    const entries = shippedText.split("\n").slice(0, -1);
    expect(entries.filter((password) => ruleOnly.problem(password) !== undefined)).toEqual([]);
    expect(entries.filter((password) => ruleOnly.problem(password.toUpperCase()) !== undefined)).toEqual([]);
  });

  it("[PBE-073 AC3] the source, its checksum, the list's checksum and its size are recorded in password-policy.ts, the README and ADR-0008", () => {
    const records = {
      "password-policy.ts": readFileSync(join(APP_DIR, "src", "auth", "password-policy.ts"), "utf8"),
      "README.md": readFileSync(join(APP_DIR, "README.md"), "utf8"),
      "ADR-0008": readFileSync(
        join(APP_DIR, "..", "..", "docs", "mvp", "adr", "0008-identity-accounts-customers-sessions.md"),
        "utf8",
      ),
    };
    const facts = [
      "xato-net-10-million-passwords-1000000.txt",
      SOURCE_COMMIT,
      SOURCE_SHA256,
      LIST_SHA256,
      "28 897",
      "421 156 bytes",
      "348 130 bytes",
    ];
    const missing = Object.entries(records).flatMap(([name, text]) =>
      facts.filter((fact) => !text.includes(fact)).map((fact) => `${name}: ${fact}`),
    );
    expect(missing).toEqual([]);
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
