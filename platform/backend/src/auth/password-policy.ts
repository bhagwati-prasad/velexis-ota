// The password rule of the portal (PBE-013; ADR-0008 "Passwords" and its revisions of 2026-11-10 and 2026-11-11,
// PADR-0008, platform/docs/scope.md PF-01 AC2): every portal account's password has at least 12 characters with at
// least one letter and one digit, and is not in the breached-password list, and nothing else. It is stored only as an
// Argon2id hash with the OWASP parameters of ADR-0008 (m = 19 MiB, t = 2, p = 1).
//
// The rule is PCI DSS 8.3.6 (12 characters with alphabetic and numeric characters) for every account: the owner's
// decision (15e) of 2026-11-11 (FIX-W48-PLATFORM) replaced the rule of FIX-W47-PLATFORM, which asked it of platform
// admins and the owners and admins of OTAs only and left every other account at 10 characters. No live account
// existed then, so every account meets 8.3.6 from launch: sign-up (an invited person signs up first), the password
// change and the reset check the same rule, `dev:seed` gives its platform admin a password that meets it, and no other
// path sets a password (accepting an invitation and `admin:grant` set none). A password is checked only when it is
// chosen, never at sign-in.
//
// The list is `breached-passwords.txt` next to this file: the 10 000 most common passwords of SecLists
// (`Passwords/Common-Credentials/10k-most-common.txt` at commit c23b603128ed21e46164a0afd357f0c242135f41, MIT
// licence, SHA-256 68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce), one per line, lower-cased. It
// is read once, when AuthModule is built (`PasswordPolicy.load()`), and a password is compared lower-cased, so
// `QWERTYUIOP` is as breached as `qwertyuiop`. The build copies the file to `dist/auth/`. The list is checked first,
// so a listed password is named as such whatever its length (no password of the shipped list meets the rule).
//
// Sign-up (PBE-013), the password reset and change (PBE-016) call `check` before `hash`; sign-in (PBE-014) calls
// `verify`. A refused password answers `422 PASSWORD_TOO_WEAK` with a message that names the rule and one field error
// on `/password` (or the field the caller names) whose message never contains the password: `breached`, or
// `password_rule` (the length, the letter or the digit; FIX-W47-PLATFORM's `privileged_rule`, renamed with the change).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";
import { argon2id, hash, verify } from "argon2";

/**
 * The shortest password, in characters (Unicode code points), of every portal account (PCI DSS 8.3.6), which also
 * needs at least one letter and one digit.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** A letter of any script, and a decimal digit: what the rule asks a password to hold. */
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

/** The breached-password list: `src/auth/breached-passwords.txt`, `dist/auth/breached-passwords.txt` once built. */
export const BREACHED_PASSWORDS_FILE = join(__dirname, "breached-passwords.txt");

/** The Argon2id parameters of ADR-0008 (OWASP): 19 MiB of memory, 2 iterations, 1 lane. */
export const ARGON2_OPTIONS = Object.freeze({
  type: argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
});

/** Why a password is refused; the `code` of the field error. */
export type PasswordProblem = "password_rule" | "breached";

/** The messages of the field errors; they never quote the password. */
const MESSAGES: Readonly<Record<PasswordProblem, string>> = Object.freeze({
  password_rule: `Use at least ${MIN_PASSWORD_LENGTH} characters, with at least one letter and one digit.`,
  breached: "This password is too common or has appeared in a data breach. Choose another one.",
});

/** The message of the `422 PASSWORD_TOO_WEAK` envelope, which names the rule. */
export const RULE_MESSAGE =
  `The password needs at least ${MIN_PASSWORD_LENGTH} characters with at least one letter and one digit, and must ` +
  "not be a common or breached password.";

/** The passwords of a list file: one per line, lower-cased and trimmed; empty lines are skipped. */
export function parseBreachedPasswords(text: string): ReadonlySet<string> {
  const passwords = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const password = line.trim().toLowerCase();
    if (password !== "") {
      passwords.add(password);
    }
  }
  return passwords;
}

/** The number of characters of a password: its Unicode code points, so an emoji counts once. */
function lengthOf(password: string): number {
  return [...password].length;
}

/**
 * The password rules and the Argon2id hashing. AuthModule provides one instance, built with `PasswordPolicy.load()`;
 * a unit test builds one on its own list.
 */
export class PasswordPolicy {
  constructor(private readonly breached: ReadonlySet<string>) {
    if (breached.size === 0) {
      throw new Error("PasswordPolicy: the breached-password list is empty");
    }
  }

  /** The policy with the list of `file` (default: BREACHED_PASSWORDS_FILE), read once. */
  static load(file: string = BREACHED_PASSWORDS_FILE): PasswordPolicy {
    return new PasswordPolicy(parseBreachedPasswords(readFileSync(file, "utf8")));
  }

  /** How many passwords the list holds. */
  get breachedCount(): number {
    return this.breached.size;
  }

  /**
   * What `password` breaks, or `undefined` when it is allowed: the breached list first (`breached`), then the length,
   * the letter and the digit (`password_rule`).
   */
  problem(password: string): PasswordProblem | undefined {
    if (this.breached.has(password.toLowerCase())) {
      return "breached";
    }
    return lengthOf(password) < MIN_PASSWORD_LENGTH || !LETTER.test(password) || !DIGIT.test(password)
      ? "password_rule"
      : undefined;
  }

  /**
   * Throws `422 PASSWORD_TOO_WEAK` with the rule's message and one field error at `path` (a JSON pointer into the
   * request, default `/password`) when `password` breaks the rule.
   */
  check(password: string, path = "/password"): void {
    const problem = this.problem(password);
    if (problem !== undefined) {
      throw new AppError("PASSWORD_TOO_WEAK", {
        message: RULE_MESSAGE,
        fieldErrors: [{ path, code: problem, message: MESSAGES[problem] }],
      });
    }
  }

  /** The Argon2id hash of `password` in the PHC string format (`$argon2id$v=19$m=19456,t=2,p=1$…`). */
  hash(password: string): Promise<string> {
    return hash(password, { ...ARGON2_OPTIONS });
  }

  /** True when `password` matches `passwordHash`; false for a wrong password or a hash that cannot be read. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
