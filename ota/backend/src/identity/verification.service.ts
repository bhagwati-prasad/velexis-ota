// Customer e-mail verification (OBE-032; flows/my-bookings-and-guest-lookup.md §3 steps 1–2, the document's signUp,
// verifyEmail and resendEmailVerification, ADR-0008 "E-mail verification and password reset", db README §7 and §8).
//
// - `issue(trx, target)`, in the caller's transaction (sign-up; account.update's address change of OBE-035): a new
//   one-time token `vt_` + 256 random bits (the document's `^vt_[A-Za-z0-9_-]{32,64}$`), stored only as its SHA-256 in
//   the identity's `verification_token_hash` with `verification_sent_at` and an expiry 24 hours later (an earlier
//   token of the identity stops working: its hash is gone), and the `auth.verify_email` e-mail queued in the outbox
//   with the token only in `secretData` (encrypted in `notifications.secret_payload_ciphertext`, erased once sent;
//   OADR-0013). The renderer builds the link `/account/verify.html?token=…` on the tenant's storefront host
//   (OADR-0015 point 5). The e-mail goes to the customer's pending address when it has one, else to its address:
//   the identity holds one token, and `verify` confirms the pending address whenever there is one, so while a change
//   is pending a token may only ever reach the pending address's mailbox. Whoever sets `pending_email` (account.update,
//   OBE-035) issues a new token for it in the same transaction, and whoever clears it otherwise also drops the token,
//   so no link outlives the change it was sent for.
// - `verify(token)` is auth.verifyEmail, in one transaction: the identity of the token's hash, under its customer's
//   `FOR UPDATE` lock (customers.repository.ts); an unknown token (none, replaced by a newer one, of an erased or
//   disabled identity, of another tenant) answers `400 VERIFICATION_TOKEN_INVALID` with `details.reason: unknown`, a
//   token whose address was verified since it was issued `used`, one past its 24 hours `expired`. Otherwise the
//   customer's pending address moves into `customers.email` (and the identity's subject; another customer holding it
//   is `409 EMAIL_ALREADY_REGISTERED`), or its address is marked verified; `pending_verification` becomes `active` and
//   the customer's `version` goes up. Then the guest bookings of the request's environment whose `contact_email` is
//   the verified address and that have no customer are attached to the customer, each with a `booking.claimed` event
//   (`claimedGuestBookings`). No session is opened (the link may be opened on another device). The token's hash stays,
//   so presenting it again is told apart from an unknown token (`used`); the two of one token presented at the same
//   time wait for each other on the customer's lock: one `200` and one `used`.
// - `resend({customerId?, email?})` is auth.resendVerification: a signed-in customer (the customer guard read the
//   token) gets a new link for its pending address, else for its unverified address; an anonymous call names the
//   address (`400 VALIDATION_FAILED` on `/email` without it) and gets a link only when that address is an unverified
//   account's with no address change pending (`resendTarget`: that link would confirm the pending address). Nothing
//   is sent for an unknown address, a verified one, a disabled or deleted customer, or when the identity's last token
//   is less than a minute old (the document's "at most 1 email per 60 seconds"); the controller answers the same
//   `202` in every case. The rate limits of architecture §8 (5 per hour per IP, 3 per hour per address, shared with
//   sign-up and the password reset) are the operation's throttlers (rate-limits.ts).
//
// `returnPath` (sign-up, resend) is accepted and not kept: the tenant schema has no place for it and the e-mail link
// is fixed (OADR-0015 point 5), so `EmailVerificationResult.returnPath` is `null`; the hosted storefront's pages carry
// their own `next`. Tokens and addresses are never logged: the log lines carry ids and outcomes only.
import { Injectable } from "@nestjs/common";
import { generateToken, sha256Hex } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { OutboxService } from "../notifications/outbox.service";
import { canonicalLocale } from "../storefront/storefront.mapper";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import type { VerifiedEmail } from "./customers.mapper";
import { CustomersRepository, type CustomerRecord, type VerificationIdentity } from "./customers.repository";
import { normaliseEmail } from "./lockout";
import { mayHoldSession } from "./sessions.service";

/** The prefix of verification tokens (`vt_…`, `EmailVerificationConfirmRequest.token`). */
export const VERIFICATION_TOKEN_PREFIX = "vt";

/** The bytes of a verification token: 256 bits. */
export const VERIFICATION_TOKEN_BYTES = 32;

/** How long a verification link works (ADR-0008, the document's `EmailVerificationStatus.expiresAt`): 24 hours. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** The shortest time between two verification e-mails of one identity (resendEmailVerification). */
export const RESEND_INTERVAL_MS = 60 * 1000;

/** The unique indexes a confirmed address can meet when another customer took it meanwhile. */
const ADDRESS_UNIQUE_INDEXES: ReadonlySet<string> = new Set([
  "customers_email_lower_uq",
  "customer_identities_subject_uq",
]);

/** The PostgreSQL unique violation of one of `indexes`. */
export function isUniqueViolationOf(error: unknown, indexes: ReadonlySet<string>): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && typeof constraint === "string" && indexes.has(constraint);
}

/** Why a verification token is refused (`details.reason` of `VERIFICATION_TOKEN_INVALID`). */
export type VerificationTokenRefusal = "unknown" | "used" | "expired";

const REFUSAL_MESSAGES: Readonly<Record<VerificationTokenRefusal, string>> = Object.freeze({
  unknown: "This verification link is not valid. Request a new one.",
  used: "This verification link was already used.",
  expired: "This verification link has expired. Request a new one.",
});

/** `400 VERIFICATION_TOKEN_INVALID` with its reason. */
export function verificationTokenInvalid(reason: VerificationTokenRefusal): AppError {
  return new AppError("VERIFICATION_TOKEN_INVALID", {
    message: REFUSAL_MESSAGES[reason],
    details: { reason },
  });
}

/**
 * The state of an identity's current token at `now`: `used` once the identity's address was verified at or after the
 * token was issued, `expired` at or past its expiry, else `valid`.
 */
export function tokenState(
  identity: Pick<VerificationIdentity, "emailVerifiedAt" | "tokenSentAt" | "tokenExpiresAt">,
  now: Date,
): VerificationTokenRefusal | "valid" {
  if (
    identity.emailVerifiedAt !== null &&
    identity.tokenSentAt !== null &&
    identity.emailVerifiedAt.getTime() >= identity.tokenSentAt.getTime()
  ) {
    return "used";
  }
  if (identity.tokenExpiresAt === null || identity.tokenExpiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "valid";
}

/** An instant as the e-mail shows it: ISO 8601 in UTC, whole seconds (`2026-11-02T10:00:00Z`). */
export function emailInstant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Whom a verification e-mail goes to. */
export interface VerificationTarget {
  readonly customerId: string;
  /** The customer's enabled password identity (`cid_…`), which holds the token. */
  readonly identityId: string;
  /** The address to verify: the pending one, or the customer's address. */
  readonly to: string;
  readonly firstName: string | null;
  /** The rendering locale (BCP 47): the customer's preference, else the storefront's default. */
  readonly locale: string;
}

/** An issued verification e-mail. */
export interface IssuedVerification {
  /** The address it went to (unmasked: the mapper masks it for an answer). */
  readonly sentTo: string;
  readonly expiresAt: Date;
}

/** What `resend` takes: the signed-in customer, else the address of an anonymous call. */
export interface ResendInput {
  readonly customerId?: string | undefined;
  readonly email?: string | undefined;
}

/** What `resend` did, for the log line only: the answer is the same for all. */
export type ResendOutcome = "sent" | "unknown" | "blocked" | "verified" | "pending_change" | "throttled";

/**
 * Where a resend sends the identity's new link (`to`), or why it sends none. A signed-in customer (`anonymousAddress`
 * undefined) gets it at its pending address, else at its unverified address. An anonymous call naming the account's
 * address gets it there only while that address is unverified and no change is pending: the identity's one token
 * confirms the pending address when there is one (`verify`), so a link mailed to the current address would let that
 * mailbox confirm an address nobody proved to hold (and claim its guest bookings).
 */
export function resendTarget(
  customer: Pick<CustomerRecord, "email" | "email_verified_at" | "pending_email">,
  anonymousAddress: string | undefined,
): { readonly to: string } | { readonly outcome: "verified" | "pending_change" } {
  if (anonymousAddress === undefined) {
    if (customer.pending_email !== null) {
      return { to: customer.pending_email };
    }
    return customer.email_verified_at === null ? { to: customer.email } : { outcome: "verified" };
  }
  if (customer.pending_email !== null) {
    return { outcome: "pending_change" };
  }
  return customer.email_verified_at === null &&
    normaliseEmail(customer.email) === normaliseEmail(anonymousAddress)
    ? { to: customer.email }
    : { outcome: "verified" };
}

@Injectable()
export class VerificationService {
  constructor(
    private readonly customers: CustomersRepository,
    private readonly outbox: OutboxService,
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(VerificationService.name) private readonly logger: PinoLogger,
  ) {}

  /** Issues a new token for `target` and queues its e-mail, in `trx` (see the file header). */
  async issue(trx: TenantTransaction, target: VerificationTarget): Promise<IssuedVerification> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS);
    const { token, hash } = generateToken(VERIFICATION_TOKEN_PREFIX, VERIFICATION_TOKEN_BYTES);
    await this.customers.setVerificationToken(trx, target.identityId, {
      tokenHash: hash,
      sentAt: now,
      expiresAt,
    });
    await this.outbox.enqueue(trx, {
      templateKey: "auth.verify_email",
      to: target.to,
      locale: target.locale,
      customerId: target.customerId,
      data: { customer: { firstName: target.firstName ?? "" }, expiresAt: emailInstant(expiresAt) },
      secretData: { token },
      dedupeKey: `auth.verify_email:${target.identityId}:${now.getTime()}`,
    });
    return { sentTo: target.to, expiresAt };
  }

  /** auth.verifyEmail (see the file header). */
  async verify(token: string): Promise<VerifiedEmail> {
    const tokenHash = sha256Hex(token);
    const tenant = this.tenants.require();
    let verified: VerifiedEmail;
    try {
      verified = await this.tx.run(async (trx) => {
        const found = await this.customers.findByVerificationHash(trx, tokenHash);
        if (found === undefined) {
          throw verificationTokenInvalid("unknown");
        }
        const customer = await this.customers.lockCustomer(trx, found.customerId);
        // Read again under the lock: a resend or a verification that committed meanwhile is seen now.
        const current = await this.customers.findByVerificationHash(trx, tokenHash);
        const identity =
          customer === undefined ? undefined : await this.customers.verificationIdentityOf(trx, customer.id);
        if (
          customer === undefined ||
          customer.deleted_at !== null ||
          customer.status === "deleted" ||
          identity === undefined ||
          current?.identityId !== identity.identityId
        ) {
          throw verificationTokenInvalid("unknown");
        }
        const now = this.clock.now();
        const state = tokenState(identity, now);
        if (state !== "valid") {
          throw verificationTokenInvalid(state);
        }
        const pending = customer.pending_email;
        const address = { customerId: customer.id, identityId: identity.identityId, now };
        if (pending !== null) {
          const normalisedEmail = normaliseEmail(pending);
          if (await this.customers.addressTaken(trx, normalisedEmail, customer.id)) {
            throw new AppError("EMAIL_ALREADY_REGISTERED");
          }
          await this.customers.confirmPendingEmail(trx, { ...address, email: pending, normalisedEmail });
        } else {
          await this.customers.markEmailVerified(trx, address);
        }
        const verifiedEmail = pending ?? customer.email;
        const claimedGuestBookings = await this.customers.claimGuestBookings(trx, {
          customerId: customer.id,
          email: verifiedEmail,
          environment: tenant.environment,
          now,
          newEventId: () => this.ids.newId("evt"),
          requestId: tenant.requestId,
        });
        const updated = await this.customers.findCustomer(trx, customer.id);
        if (updated === undefined) {
          // Locked by this transaction: it cannot have gone.
          throw new Error("VerificationService.verify: the customer cannot be read back");
        }
        return {
          customer: updated,
          verifiedEmail,
          emailChanged: pending !== null,
          claimedGuestBookings,
          returnPath: null,
        };
      });
    } catch (error) {
      if (isUniqueViolationOf(error, ADDRESS_UNIQUE_INDEXES)) {
        // Another customer took the pending address between the check and the move.
        throw new AppError("EMAIL_ALREADY_REGISTERED", { cause: error });
      }
      throw error;
    }
    // Ids and counts only: the address and the token are never logged.
    this.logger.info(
      {
        customerId: verified.customer.id,
        emailChanged: verified.emailChanged,
        claimedGuestBookings: verified.claimedGuestBookings,
      },
      "customer.email_verified",
    );
    return verified;
  }

  /** auth.resendVerification (see the file header). Resolves alike whatever it did. */
  async resend(input: ResendInput): Promise<void> {
    if (input.customerId === undefined && input.email === undefined) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          { path: "/email", code: "required", message: "email is required without a signed-in customer" },
        ],
      });
    }
    const result = await this.tx.run(async (trx) => {
      const settings = await this.customers.accountSettings(trx);
      if (settings !== undefined && !settings.customerAccountsEnabled) {
        throw new AppError("FEATURE_DISABLED", { details: { feature: "customerAccounts" } });
      }
      const anonymousAddress = input.customerId === undefined ? input.email : undefined;
      const customerId =
        input.customerId ??
        (anonymousAddress === undefined
          ? undefined
          : (await this.customers.findPasswordIdentity(trx, normaliseEmail(anonymousAddress)))?.customerId);
      if (customerId === undefined) {
        return { outcome: "unknown" as const, customerId };
      }
      const customer = await this.customers.lockCustomer(trx, customerId);
      const identity =
        customer === undefined ? undefined : await this.customers.verificationIdentityOf(trx, customerId);
      if (customer === undefined || identity === undefined || !mayHoldSession(customer)) {
        return { outcome: "blocked" as const, customerId };
      }
      const target = resendTarget(customer, anonymousAddress);
      if (!("to" in target)) {
        return { outcome: target.outcome, customerId };
      }
      const now = this.clock.now();
      if (
        identity.tokenSentAt !== null &&
        now.getTime() - identity.tokenSentAt.getTime() < RESEND_INTERVAL_MS
      ) {
        return { outcome: "throttled" as const, customerId };
      }
      const locale =
        canonicalLocale(await this.customers.preferredLocale(trx, customerId)) ??
        canonicalLocale(settings?.defaultLocale) ??
        "en";
      await this.issue(trx, {
        customerId,
        identityId: identity.identityId,
        to: target.to,
        firstName: customer.first_name,
        locale,
      });
      return { outcome: "sent" as const, customerId };
    });
    this.logger.info(
      { customerId: result.customerId, outcome: result.outcome satisfies ResendOutcome },
      "customer.verification_resend",
    );
  }
}
