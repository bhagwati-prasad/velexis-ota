// Sign-up, e-mail verification and the resend of the verification link (PBE-013; platform/docs/flows/
// signup-and-create-ota.md steps 1 to 3, scope PF-01 and PF-02, PADR-0008 "E-mail verification", PADR-0013).
//
// - signUp: the password rules first (`422 PASSWORD_TOO_WEAK`), then the Argon2id hash, for every request, so a known
//   and an unknown address cost the same. Then one transaction: a new address gets an account (`pending_verification`,
//   with the terms the person accepted), a verification token (24 h) and the e-mail `auth.verify_email`, and the audit
//   row `account.signed_up`; an address that has an account gets only the e-mail `auth.account_exists`, to the
//   account's own address, with a password reset link (a `password_reset` token, 1 h, PADR-0013 item 5). The answer
//   is the same `202 {status: "verification_sent"}` either way (PADR-0008 item 1).
// - verifyEmail: uses up an unused, unexpired verification token; the account becomes `active` with
//   `email_verified_at`, its other open verification links stop working, and `account.email_verified` is audited.
//   Anything else answers `400 VERIFICATION_TOKEN_INVALID`, without saying why. The account is locked before its
//   token is used up, so two of its links opened at the same time give one `200` and one `400`.
// - resendVerification: answers `202` whatever the address; an unverified account gets a new link. Older links that
//   have not expired keep working (PADR-0008 item 3, the contract of resendVerification).
//
// Tokens are 256 bits (`generateToken` of @velexis/crypto); only their SHA-256 is stored. The links are built on
// PUBLIC_PORTAL_URL and travel only as the outbox's encrypted secret data (PADR-0013): never in a log, a job or an
// audit row. The rate limits (5 sign-ups per IP per hour; 3 resends per address and 10 per IP per hour) are the
// throttlers of the operations (common/http/throttler.config.ts), applied before the handler runs.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { AuditService } from "../audit/audit.service";
import type { PlatformTransaction } from "../audit/audit.repository";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { OutboxService } from "../notifications/outbox.service";
import { AccountTokensRepository, type AccountTokenPurpose } from "./account-tokens.repository";
import { AccountsRepository, type AccountIdentity, type AccountStatus } from "./accounts.repository";
import { PasswordPolicy } from "./password-policy";

export type SignUpRequest = components["schemas"]["SignUpRequest"];
export type SignUpAccepted = components["schemas"]["SignUpAccepted"];
export type VerifyEmailRequest = components["schemas"]["VerifyEmailRequest"];
export type EmailVerified = components["schemas"]["EmailVerified"];
export type ResendVerificationRequest = components["schemas"]["ResendVerificationRequest"];

const HOUR_MS = 60 * 60 * 1000;

/** How long a verification link works (ADR-0008, PADR-0008 item 3). */
export const VERIFICATION_TOKEN_TTL_MS = 24 * HOUR_MS;

/** How long the reset link of an "account exists" e-mail works: a password reset token (ADR-0008). */
export const RESET_TOKEN_TTL_MS = HOUR_MS;

/** The prefixes of the tokens (`vt_…`, `pr_…`, as in @velexis/crypto's `generateToken`). */
const TOKEN_PREFIX: Readonly<Record<AccountTokenPurpose, string>> = Object.freeze({
  email_verification: "vt",
  password_reset: "pr",
});

/** The portal pages the links open (platform/frontend/README.md): they move the token out of the URL at once. */
export const VERIFY_EMAIL_PATH = "/verify-email";
export const RESET_PASSWORD_PATH = "/reset-password";

/** The one answer of signUp, for a new and a known address alike. */
const ACCEPTED: SignUpAccepted = Object.freeze({ status: "verification_sent" });

@Injectable()
export class SignUpService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly tokens: AccountTokensRepository,
    private readonly passwords: PasswordPolicy,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly context: RequestContext,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** signUp (see the file header). */
  async signUp(request: SignUpRequest): Promise<SignUpAccepted> {
    const fullName = request.fullName.trim();
    if (fullName === "") {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path: "/fullName", code: "blank", message: "Enter your full name." }],
      });
    }
    this.passwords.check(request.password);
    const passwordHash = await this.passwords.hash(request.password);
    const email = request.email.trim();

    await runInTransaction(this.db, async (trx) => {
      const now = this.clock.now();
      const accountId = this.ids.new("acc");
      const created = await this.accounts.insertIfEmailFree(trx, {
        id: accountId,
        email,
        fullName,
        passwordHash,
        termsVersion: request.termsVersion,
        now,
      });
      if (created) {
        await this.sendVerificationLink(trx, { id: accountId, email, full_name: fullName }, now);
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "account.signed_up",
          targetType: "account",
          targetId: accountId,
          after: { status: "pending_verification" satisfies AccountStatus },
          details: { termsVersion: request.termsVersion },
        });
        return;
      }
      const existing = await this.accounts.findByEmail(trx, email);
      // An erased account (`deleted`) gets nothing: there is no one to send a reset link to.
      if (existing !== undefined && existing.status !== ("deleted" satisfies AccountStatus)) {
        await this.sendAccountExists(trx, existing, now);
      }
    });
    return ACCEPTED;
  }

  /** verifyEmail (see the file header). */
  async verifyEmail(token: string): Promise<EmailVerified> {
    const tokenHash = sha256Hex(token);
    return runInTransaction(this.db, async (trx) => {
      const now = this.clock.now();
      // The account's lock first, then its tokens: two links of one account used at the same time then run one after
      // the other (the second finds its token used up by the first verification) instead of deadlocking on each
      // other's token and account rows.
      const accountId = await this.tokens.accountOfUsable(trx, "email_verification", tokenHash, now);
      const account = accountId === undefined ? undefined : await this.accounts.lockForUpdate(trx, accountId);
      const used =
        account === undefined
          ? undefined
          : await this.tokens.consume(trx, "email_verification", tokenHash, now);
      // A token whose account has moved on (verified through another link, disabled) or whose address is no longer
      // the account's is as invalid as an unknown one. The throw rolls the consumption back.
      if (
        used === undefined ||
        account === undefined ||
        account.status !== ("pending_verification" satisfies AccountStatus) ||
        account.email.toLowerCase() !== used.email.toLowerCase()
      ) {
        throw new AppError("VERIFICATION_TOKEN_INVALID");
      }
      if (!(await this.accounts.markEmailVerified(trx, account.id, now))) {
        throw new AppError("VERIFICATION_TOKEN_INVALID");
      }
      // The account's other verification links (resends, PADR-0008 item 3) have done their job.
      await this.tokens.consumeAllOf(trx, account.id, "email_verification", now);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: account.id,
        action: "account.email_verified",
        targetType: "account",
        targetId: account.id,
        before: { status: account.status },
        after: { status: "active" satisfies AccountStatus },
      });
      return { accountId: account.id, email: account.email, emailVerified: true };
    });
  }

  /** resendVerification (see the file header). */
  async resendVerification(request: ResendVerificationRequest): Promise<void> {
    const email = request.email.trim();
    await runInTransaction(this.db, async (trx) => {
      const account = await this.accounts.findByEmail(trx, email);
      if (
        account?.status === ("pending_verification" satisfies AccountStatus) &&
        account.email_verified_at === null
      ) {
        await this.sendVerificationLink(trx, account, this.clock.now());
      }
    });
  }

  /** A new verification token of `account` and the e-mail `auth.verify_email` with its link, in `trx`. */
  private async sendVerificationLink(
    trx: PlatformTransaction,
    account: Pick<AccountIdentity, "id" | "email" | "full_name">,
    now: Date,
  ): Promise<void> {
    const token = await this.issueToken(trx, account, "email_verification", VERIFICATION_TOKEN_TTL_MS, now);
    await this.outbox.queue(trx, {
      templateKey: "auth.verify_email",
      to: account.email,
      accountId: account.id,
      data: { fullName: account.full_name },
      secretData: { verifyUrl: this.outbox.portalLink(VERIFY_EMAIL_PATH, { token }) },
    });
  }

  /** A password reset token of `account` and the e-mail `auth.account_exists` with its link, in `trx`. */
  private async sendAccountExists(
    trx: PlatformTransaction,
    account: AccountIdentity,
    now: Date,
  ): Promise<void> {
    const token = await this.issueToken(trx, account, "password_reset", RESET_TOKEN_TTL_MS, now);
    await this.outbox.queue(trx, {
      templateKey: "auth.account_exists",
      to: account.email,
      accountId: account.id,
      data: { fullName: account.full_name },
      secretData: { resetUrl: this.outbox.portalLink(RESET_PASSWORD_PATH, { token }) },
    });
  }

  /** Writes a token of `purpose` for `account`, valid for `ttlMs` from `now`, and returns the token itself. */
  private async issueToken(
    trx: PlatformTransaction,
    account: Pick<AccountIdentity, "id" | "email">,
    purpose: AccountTokenPurpose,
    ttlMs: number,
    now: Date,
  ): Promise<string> {
    const { token, hash } = generateToken(TOKEN_PREFIX[purpose]);
    await this.tokens.insert(trx, {
      id: this.ids.new("atk"),
      accountId: account.id,
      purpose,
      tokenHash: hash,
      email: account.email,
      expiresAt: new Date(now.getTime() + ttlMs),
      ipAddress: this.context.ip ?? null,
      now,
    });
    return token;
  }
}
