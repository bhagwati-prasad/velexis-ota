// The password rules of the portal (PBE-013; ADR-0008 "Passwords", PADR-0008, platform/docs/scope.md PF-01 AC2): a
// password has at least 10 characters and is not in the breached-password list, and nothing else (no composition
// rules). It is stored only as an Argon2id hash with the OWASP parameters of ADR-0008 (m = 19 MiB, t = 2, p = 1).
//
// The list is `breached-passwords.txt` next to this file: the 10 000 most common passwords of SecLists
// (`Passwords/Common-Credentials/10k-most-common.txt` at commit c23b603128ed21e46164a0afd357f0c242135f41, MIT
// licence, SHA-256 68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce), one per line, lower-cased. It
// is read once, when AuthModule is built (`PasswordPolicy.load()`), and a password is compared lower-cased, so
// `QWERTYUIOP` is as breached as `qwertyuiop`. The build copies the file to `dist/auth/`.
//
// Sign-up (PBE-013), the password reset and change (PBE-016) call `check` before `hash`; sign-in (PBE-014) calls
// `verify`. A refused password answers `422 PASSWORD_TOO_WEAK` with one field error on `/password` (or the field the
// caller names) whose message never contains the password.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";
import { argon2id, hash, verify } from "argon2";

/** The shortest password, in characters (Unicode code points). */
export const MIN_PASSWORD_LENGTH = 10;

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
export type PasswordProblem = "too_short" | "breached";

/** The messages of the field errors; they never quote the password. */
const MESSAGES: Readonly<Record<PasswordProblem, string>> = Object.freeze({
  too_short: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  breached: "This password is too common or has appeared in a data breach. Choose another one.",
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

  /** The first rule `password` breaks (`too_short`, then `breached`), or `undefined` when it is allowed. */
  problem(password: string): PasswordProblem | undefined {
    if (lengthOf(password) < MIN_PASSWORD_LENGTH) {
      return "too_short";
    }
    return this.breached.has(password.toLowerCase()) ? "breached" : undefined;
  }

  /**
   * Throws `422 PASSWORD_TOO_WEAK` with one field error at `path` (a JSON pointer into the request, default
   * `/password`) when `password` breaks a rule.
   */
  check(password: string, path = "/password"): void {
    const problem = this.problem(password);
    if (problem !== undefined) {
      throw new AppError("PASSWORD_TOO_WEAK", {
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
