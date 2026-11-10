// The password rules of the portal (PBE-013; ADR-0008 "Passwords" and its revision of 2026-11-10, PADR-0008,
// platform/docs/scope.md PF-01 AC2): a password has at least 10 characters and is not in the breached-password list,
// and nothing else (no composition rules), except for the accounts of the privileged rule. It is stored only as an
// Argon2id hash with the OWASP parameters of ADR-0008 (m = 19 MiB, t = 2, p = 1).
//
// The privileged rule (PCI DSS 8.3.6; the owner's decision (13g) of 2026-11-10, FIX-W47-PLATFORM): platform admins and
// the owners and admins of OTAs (an active `owner` or `admin` membership of any OTA that members may see, live or
// test) need at least 12 characters with at least one letter and one digit, and the breached list still applies.
// AccountsRepository.passwordRuleOf reads which rule an account has. The rule applies when such an account sets a
// password (its change and its reset); an existing password keeps working until then, because a password is checked
// only when it is chosen, never at sign-in. An account has no role at sign-up, accepting an invitation and
// `admin:grant` set no password, and `dev:seed` gives its platform admin a password that meets the privileged rule.
//
// The list is `breached-passwords.txt` next to this file: the 10 000 most common passwords of SecLists
// (`Passwords/Common-Credentials/10k-most-common.txt` at commit c23b603128ed21e46164a0afd357f0c242135f41, MIT
// licence, SHA-256 68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce), one per line, lower-cased. It
// is read once, when AuthModule is built (`PasswordPolicy.load()`), and a password is compared lower-cased, so
// `QWERTYUIOP` is as breached as `qwertyuiop`. The build copies the file to `dist/auth/`.
//
// Sign-up (PBE-013), the password reset and change (PBE-016) call `check` before `hash`; sign-in (PBE-014) calls
// `verify`. A refused password answers `422 PASSWORD_TOO_WEAK` with a message that names the rule the account has and
// one field error on `/password` (or the field the caller names) whose message never contains the password: `too_short`
// (the standard rule), `privileged_rule` (the privileged rule's length, letter or digit) or `breached`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";
import { argon2id, hash, verify } from "argon2";

/** The shortest password, in characters (Unicode code points). */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * The shortest password of an account of the privileged rule (platform admins, owners and admins of OTAs; PCI DSS
 * 8.3.6), which also needs at least one letter and one digit.
 */
export const PRIVILEGED_MIN_PASSWORD_LENGTH = 12;

/**
 * The membership roles whose accounts have the privileged rule, in an OTA of any storefront environment (the owner's
 * decision (13g) of 2026-11-10).
 */
export const PRIVILEGED_PASSWORD_ROLES = Object.freeze(["owner", "admin"] as const);

/**
 * The rule a new password of an account must meet: `privileged` for a platform admin or an owner or admin of an OTA,
 * `standard` for every other account (and at sign-up, when no account has a role yet).
 */
export type PasswordRule = "standard" | "privileged";

/** A letter of any script, and a decimal digit: what the privileged rule asks a password to hold. */
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
export type PasswordProblem = "too_short" | "privileged_rule" | "breached";

/** The messages of the field errors; they never quote the password. */
const MESSAGES: Readonly<Record<PasswordProblem, string>> = Object.freeze({
  too_short: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  privileged_rule:
    `Use at least ${PRIVILEGED_MIN_PASSWORD_LENGTH} characters, with at least one letter and one digit: the rule ` +
    "for platform admins and for owners and admins of an OTA.",
  breached: "This password is too common or has appeared in a data breach. Choose another one.",
});

/** The message of the `422 PASSWORD_TOO_WEAK` envelope, which names the rule of the account. */
export const RULE_MESSAGES: Readonly<Record<PasswordRule, string>> = Object.freeze({
  standard: `The password needs at least ${MIN_PASSWORD_LENGTH} characters and must not be a common or breached password.`,
  privileged:
    `The password needs at least ${PRIVILEGED_MIN_PASSWORD_LENGTH} characters with at least one letter and one ` +
    "digit, and must not be a common or breached password: the rule for platform admins and for owners and admins " +
    "of an OTA.",
});

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
   * The first part of `rule` (default `standard`) that `password` breaks, or `undefined` when it is allowed: the
   * length (`too_short`; for the privileged rule `privileged_rule`, which also covers its letter and digit), then
   * the breached list (`breached`).
   */
  problem(password: string, rule: PasswordRule = "standard"): PasswordProblem | undefined {
    const length = lengthOf(password);
    if (
      rule === "privileged" &&
      (length < PRIVILEGED_MIN_PASSWORD_LENGTH || !LETTER.test(password) || !DIGIT.test(password))
    ) {
      return "privileged_rule";
    }
    if (length < MIN_PASSWORD_LENGTH) {
      return "too_short";
    }
    return this.breached.has(password.toLowerCase()) ? "breached" : undefined;
  }

  /**
   * Throws `422 PASSWORD_TOO_WEAK` with the message of `rule` (default `standard`) and one field error at `path` (a
   * JSON pointer into the request, default `/password`) when `password` breaks the rule.
   */
  check(password: string, path = "/password", rule: PasswordRule = "standard"): void {
    const problem = this.problem(password, rule);
    if (problem !== undefined) {
      throw new AppError("PASSWORD_TOO_WEAK", {
        message: RULE_MESSAGES[rule],
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
