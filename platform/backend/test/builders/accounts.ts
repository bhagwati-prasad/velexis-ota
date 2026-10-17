// Builders for portal accounts and their single-use tokens (PBE-013), on top of the row builders of platform-rows.ts:
// an account that has signed up but not verified its address yet, and an `account_tokens` row for a token whose
// plain value the test knows (only its SHA-256 is stored, as AuthModule stores it). Tests arrange their own accounts
// with them instead of sharing fixtures (conventions §10). The sign-in, reset and account tasks (PBE-014 to PBE-016)
// use them too.
//
//   const account = await insertUnverifiedAccount(pool, { email: uniqueEmail("verify") });
//   const { token } = await insertAccountToken(pool, account, { expires_at: hoursFrom(clock.now(), 24) });
//   await t.http.post("/v1/auth/verify-email").send({ token });
import { generateToken, sha256Hex } from "@velexis/crypto";
import { defineBuilder, type Builder, type BuilderOverrides } from "@velexis/testing";
import {
  insertAccount,
  insertRow,
  testId,
  type AccountRow,
  type PlatformInsert,
  type PlatformRow,
  type Queryable,
} from "./platform-rows";

/**
 * A password that meets the rules of PasswordPolicy (10+ characters, not breached), for tests that sign up or sign in.
 * A test value, never a real password.
 */
export const TEST_PASSWORD = "Northern-Lights-Fjord-2026";

/** The terms version of the test sign-ups (`termsVersion`, `accounts.terms_version`). */
export const TEST_TERMS_VERSION = "2026-10-01";

/** `instant` plus `hours` hours, for token expiries. */
export function hoursFrom(instant: Date, hours: number): Date {
  return new Date(instant.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Writes an account in `pending_verification`, as a sign-up leaves it: no verified address, the terms accepted. The
 * overrides of `insertAccount` apply on top (set `email` to a `uniqueEmail` when the test reads Mailpit).
 */
export function insertUnverifiedAccount(
  db: Queryable,
  overrides: Partial<AccountRow> = {},
): Promise<PlatformRow<"accounts">> {
  return insertAccount(db, {
    status: "pending_verification",
    email_verified_at: null,
    terms_accepted_at: new Date("2026-10-01T09:00:00.000Z"),
    terms_version: TEST_TERMS_VERSION,
    ...overrides,
  });
}

/**
 * `platform.account_tokens`: an unused e-mail verification token; the insert takes the account and computes
 * `token_hash` and `email`. `expires_at` defaults to 24 hours after the FakeClock's default start
 * (2026-01-15T10:00:00Z), as for a token issued then; a test that moves its clock sets it with `hoursFrom`.
 */
export type AccountTokenRow = Omit<PlatformInsert<"account_tokens">, "account_id" | "token_hash" | "email">;
export const buildAccountToken: Builder<AccountTokenRow> = defineBuilder<AccountTokenRow>((n) => ({
  id: testId("atk", n),
  purpose: "email_verification",
  expires_at: new Date("2026-01-16T10:00:00.000Z"),
}));

/** An inserted token: its row and the plain token a link would carry. */
export interface InsertedAccountToken {
  readonly row: PlatformRow<"account_tokens">;
  readonly token: string;
}

/** Overrides of `insertAccountToken`: row values, `email` (default: the account's), and the plain `token`. */
export type AccountTokenOverrides = BuilderOverrides<AccountTokenRow> & {
  readonly email?: string;
  readonly token?: string;
};

/**
 * Writes a token of `account` (default: a fresh `vt_` or `pr_` token of 256 bits, as AuthModule makes them) and returns
 * it with its row. Only the SHA-256 of the token is stored.
 */
export async function insertAccountToken(
  db: Queryable,
  account: Pick<PlatformRow<"accounts">, "id" | "email">,
  overrides: AccountTokenOverrides = {},
): Promise<InsertedAccountToken> {
  const { email, token: given, ...values } = overrides;
  const built = buildAccountToken(values);
  const token = given ?? generateToken(built.purpose === "password_reset" ? "pr" : "vt").token;
  const row = await insertRow(db, "account_tokens", {
    ...built,
    account_id: account.id,
    email: email ?? account.email,
    token_hash: sha256Hex(token),
  });
  return { row, token };
}

/** The account whose address equals `email` ignoring letter case, as the database holds it. */
export async function accountByEmail(
  db: Queryable,
  email: string,
): Promise<PlatformRow<"accounts"> | undefined> {
  const { rows } = await db.query("SELECT * FROM platform.accounts WHERE lower(email) = lower($1)", [email]);
  return rows[0] as PlatformRow<"accounts"> | undefined;
}

/** The tokens of an account, oldest first. */
export async function tokensOf(
  db: Queryable,
  accountId: string,
): Promise<Array<PlatformRow<"account_tokens">>> {
  const { rows } = await db.query(
    "SELECT * FROM platform.account_tokens WHERE account_id = $1 ORDER BY created_at, id",
    [accountId],
  );
  return rows as Array<PlatformRow<"account_tokens">>;
}
