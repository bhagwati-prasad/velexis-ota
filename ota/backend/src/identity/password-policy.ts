// The password rules of customer accounts (OBE-032; ADR-0008 "Passwords", the document's signUp and
// `storefront.auth.passwordPolicy`, which storefront.get publishes as `CUSTOMER_PASSWORD_POLICY`: at least 10
// characters, at most 128, no composition rules, breached passwords refused). A password has at least 10 characters
// (Unicode code points) and is not in the breached-password list, and nothing else; it is stored only as an Argon2id
// hash with the OWASP parameters of ADR-0008 (`hashCustomerPassword` of sign-in.service.ts).
//
// The list is `breached-passwords.txt` next to this file, the same list the platform backend checks portal passwords
// against (platform/backend/src/auth/password-policy.ts): the 10 000 most common passwords of SecLists
// (`Passwords/Common-Credentials/10k-most-common.txt` at commit c23b603128ed21e46164a0afd357f0c242135f41, MIT
// licence, SHA-256 68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce), one per line, lower-cased. It
// is read once, when the identity module is built (`CustomerPasswordPolicy.load()`), and a password is compared
// lower-cased, so `QWERTYUIOP` is as breached as `qwertyuiop`. The build copies the file to `dist/identity/`.
//
// Sign-up (OBE-032) calls `check` before hashing; the password reset and change (OBE-034) do the same. A refused
// password answers `422 PASSWORD_TOO_WEAK` with `details.violations` (the rules it breaks, `minLength` and
// `breached`, as the document's example) and one field error on `/password` (or the field the caller names) whose
// message never contains the password.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@velexis/errors";

/** The shortest password, in characters (Unicode code points); `passwordPolicy.minLength` of the storefront. */
export const MIN_CUSTOMER_PASSWORD_LENGTH = 10;

/** The breached-password list: `src/identity/breached-passwords.txt`, once built `dist/identity/…`. */
export const BREACHED_PASSWORDS_FILE = join(__dirname, "breached-passwords.txt");

/** A rule a password breaks: the values of `details.violations`. */
export type PasswordViolation = "minLength" | "breached";

/** The message of the field error; it never quotes the password. */
const MESSAGES: Readonly<Record<PasswordViolation, string>> = Object.freeze({
  minLength: `Use at least ${MIN_CUSTOMER_PASSWORD_LENGTH} characters.`,
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
 * The customer password rules. The identity module provides one instance, built with `CustomerPasswordPolicy.load()`;
 * a unit test builds one on its own list.
 */
export class CustomerPasswordPolicy {
  constructor(private readonly breached: ReadonlySet<string>) {
    if (breached.size === 0) {
      throw new Error("CustomerPasswordPolicy: the breached-password list is empty");
    }
  }

  /** The policy with the list of `file` (default: BREACHED_PASSWORDS_FILE), read once. */
  static load(file: string = BREACHED_PASSWORDS_FILE): CustomerPasswordPolicy {
    return new CustomerPasswordPolicy(parseBreachedPasswords(readFileSync(file, "utf8")));
  }

  /** How many passwords the list holds. */
  get breachedCount(): number {
    return this.breached.size;
  }

  /** Every rule `password` breaks, `minLength` first; empty when it is allowed. */
  violations(password: string): PasswordViolation[] {
    const violations: PasswordViolation[] = [];
    if (lengthOf(password) < MIN_CUSTOMER_PASSWORD_LENGTH) {
      violations.push("minLength");
    }
    if (this.breached.has(password.toLowerCase())) {
      violations.push("breached");
    }
    return violations;
  }

  /**
   * Throws `422 PASSWORD_TOO_WEAK` with `details.violations` and one field error at `path` (a JSON pointer into the
   * request, default `/password`) when `password` breaks a rule.
   */
  check(password: string, path = "/password"): void {
    const violations = this.violations(password);
    const [first] = violations;
    if (first !== undefined) {
      throw new AppError("PASSWORD_TOO_WEAK", {
        details: { violations },
        fieldErrors: [{ path, code: "too_weak", message: MESSAGES[first] }],
      });
    }
  }
}
