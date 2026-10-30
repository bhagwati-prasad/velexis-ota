// The payout account use cases (PBE-058; platform/docs/flows/stripe-payments-account.md §B, PADR-0003 item 10,
// api-inventory-resources.md §5 and api-inventory-admin.md §6, scope PF-64): the bank account where Velexis pays the
// OTA's monthly settlements in `velexis` mode. Who may call them is the guards' business (the portal's TenantRoleGuard,
// RecentMfaGuard and FeatureGuard, the admin's AdminAuthGuard and RecentMfaGuard, by the operations' `x-scope`,
// `x-mfa-step-up` and `x-feature`); this service owns the rules, the transactions, the audit rows and the e-mails.
//
// - `get` (`getPayoutAccount`, owners and finance; `adminGetPayoutAccount`): the account masked (`toPayoutAccount`):
//   holder, bank country, currency, scheme, `last4`, review status and note, never a bank number; `404 NOT_FOUND`
//   without one.
// - `set` (`setPayoutAccount`, owners, MFA step-up, `FEATURE_SETTLEMENTS`): an IBAN account (the IBAN normalised and
//   checked with mod 97, an optional BIC) or a local one (account and routing numbers as typed); iban.ts holds the
//   rules, and a broken one answers `400 VALIDATION_FAILED` with a field error that never holds the value. The bank
//   identifiers are envelope-encrypted as one JSON value bound to the row (`bankDetailsPlace`) before the transaction;
//   in it the row is written (a new one, or the next version of the old one) back in `pending_review` with the review
//   cleared, audited as `payout_account.updated` (the masked fields before and after: `last4`, never a number), and an
//   `ops.alert` e-mail asks a platform admin to review it. Every successful call is a change: a new ciphertext, a new
//   version and a new review, even for the same numbers (bank fields are write-only, so the owner types them again on
//   purpose). The tenant may be in any state its members see: settlements of a suspended OTA are still paid
//   (PADR-0014 item 5 makes API keys, domains and connections read-only, not the payout account).
// - `reveal` (`adminRevealPayoutAccount`, MFA step-up, **reason**): the reason must keep 5 characters once the spaces
//   at either end are gone (`400 VALIDATION_FAILED` on `/reason` otherwise: five spaces are no reason); in one
//   transaction the row is read `FOR SHARE`, its bank identifiers decrypted and the audit row `payout_account.revealed`
//   written with the trimmed reason (never a number); the identifiers are answered only after the commit, so no reveal
//   goes unaudited. The controller sends the answer with `Cache-Control: no-store`; nothing here logs it.
// - `review` (`adminReviewPayoutAccount`, `If-Match`): `verified` (the note cleared) or `rejected` with a note. In one
//   transaction the row is locked; a stale `If-Match` answers `412 PRECONDITION_FAILED` (for example after the owner
//   changed the account, which returned it to `pending_review`). The review is written with `version + 1`, audited as
//   `payout_account.reviewed`, and every active owner is e-mailed `payouts.reviewed` (the outcome and a link to the
//   portal page, where the note is shown; the note itself stays out of the e-mail). A review the account already has
//   (same status and note) writes, audits and e-mails nothing.
//
// No invalidation is published: the OTA backend never reads payout accounts (`velexis_ota_app` has no privilege on the
// table, platform/docs/architecture.md §7). "Now" is the injected Clock's time.
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService, type AuditValues } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { CiphertextContentError, EnvelopeService, type CiphertextPlace } from "../common/crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import { OutboxService } from "../notifications/outbox.service";
import {
  accountNumberProblems,
  ibanProblems,
  lastFour,
  normaliseBic,
  normaliseIban,
  NORMALISED_IBAN_PATTERN,
  type BankDetailProblem,
} from "./iban";
import {
  PayoutAccountsRepository,
  type PayoutAccountView,
  type PayoutScheme,
  type TenantLabel,
} from "./payout-accounts.repository";

export type PayoutAccount = components["schemas"]["PayoutAccount"];
export type SetPayoutAccountRequest = components["schemas"]["SetPayoutAccountRequest"];
export type RevealedPayoutAccount = components["schemas"]["RevealedPayoutAccount"];
export type ReviewPayoutAccountRequest = components["schemas"]["ReviewPayoutAccountRequest"];

/** One failed field of a request (the `FieldError` of the document). */
interface FieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** Where the bank identifiers of `tenantId`'s payout account are stored: the envelope's associated data. */
export function bankDetailsPlace(tenantId: string): CiphertextPlace {
  return { table: "tenant_payout_accounts", column: "bank_details_ciphertext", rowId: tenantId };
}

/** The `PayoutAccount` of the OpenAPI document for a row read without its ciphertext: masked, `last4` only. */
export function toPayoutAccount(row: PayoutAccountView): PayoutAccount {
  return {
    accountHolderName: row.account_holder_name,
    countryCode: row.country_code,
    currency: row.currency,
    scheme: row.scheme as PayoutAccount["scheme"],
    last4: row.last4,
    status: row.status as PayoutAccount["status"],
    reviewNote: row.review_note,
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

/** The masked fields of a row, as the audit rows keep them (`last4`, never a bank number). */
function auditedFields(row: PayoutAccountView): AuditValues {
  return {
    accountHolderName: row.account_holder_name,
    countryCode: row.country_code,
    currency: row.currency,
    scheme: row.scheme,
    last4: row.last4,
    status: row.status,
  };
}

/** The bank identifiers of a valid request, as they are encrypted and later revealed, with their `last4`. */
interface BankDetails {
  readonly scheme: PayoutScheme;
  readonly details: RevealedPayoutAccount;
  readonly last4: string;
}

/** A broken rule of a field of the request, as a field error that never holds the value. */
const fieldError = (
  path: string,
  problem: BankDetailProblem | { code: string; message: string },
): FieldError => ({
  path,
  code: problem.code,
  message: problem.message,
});

/**
 * The bank identifiers of a validated `setPayoutAccount` body: the normalised IBAN and BIC, or the account and routing
 * numbers as typed. Throws `400 VALIDATION_FAILED` with field errors (never a value) for a broken rule of iban.ts.
 */
export function bankDetailsOf(body: SetPayoutAccountRequest): BankDetails {
  const errors: FieldError[] = [];
  if (body.accountHolderName.trim() === "") {
    errors.push(
      fieldError("/accountHolderName", {
        code: "blank",
        message: "Enter the legal name on the bank account.",
      }),
    );
  }
  let bank: BankDetails | undefined;
  if (body.scheme === "iban") {
    const problems = ibanProblems(body.iban);
    errors.push(...problems.map((problem) => fieldError("/iban", problem)));
    if (problems.length === 0) {
      const iban = normaliseIban(body.iban);
      bank = {
        scheme: "iban",
        details: body.bic === undefined ? { iban } : { iban, bic: normaliseBic(body.bic) },
        last4: lastFour(iban),
      };
    }
  } else {
    const problems = accountNumberProblems(body.accountNumber);
    errors.push(...problems.map((problem) => fieldError("/accountNumber", problem)));
    if (problems.length === 0) {
      bank = {
        scheme: "local",
        details: { accountNumber: body.accountNumber, routingNumber: body.routingNumber },
        last4: lastFour(body.accountNumber),
      };
    }
  }
  if (errors.length > 0 || bank === undefined) {
    throw new AppError("VALIDATION_FAILED", { fieldErrors: errors });
  }
  return bank;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The revealed identifiers of a decrypted value of a row of `scheme`: exactly the fields `bankDetailsOf` stored.
 * Anything else is a `CiphertextContentError` (no detail, never the value).
 */
export function revealedDetails(value: unknown, scheme: string): RevealedPayoutAccount {
  if (isRecord(value)) {
    const keys = Object.keys(value).sort().join(",");
    const { iban, bic, accountNumber, routingNumber } = value;
    if (
      scheme === "iban" &&
      typeof iban === "string" &&
      NORMALISED_IBAN_PATTERN.test(iban) &&
      (keys === "iban" || (keys === "bic,iban" && typeof bic === "string"))
    ) {
      return typeof bic === "string" ? { iban, bic } : { iban };
    }
    if (
      scheme === "local" &&
      keys === "accountNumber,routingNumber" &&
      typeof accountNumber === "string" &&
      typeof routingNumber === "string"
    ) {
      return { accountNumber, routingNumber };
    }
  }
  throw new CiphertextContentError();
}

/**
 * The shortest reason of a reveal once the spaces at either end are gone (`AdminReason`'s `minLength`): the request
 * validation counts the spaces, so `"     "` passes it and is refused here.
 */
const MIN_REASON_LENGTH = 5;

/** The `payouts.reviewed` e-mail's outcome and next step, by decision (no note: the portal shows it). */
const REVIEW_OUTCOMES = Object.freeze({
  verified: {
    outcome: "verified",
    nextStep: "Velexis can now pay your monthly settlements to this account.",
  },
  rejected: {
    outcome: "rejected",
    nextStep:
      "Velexis cannot pay settlements to it. Read the reviewer's note on the payout account page and enter the account again.",
  },
} as const);

@Injectable()
export class PayoutAccountsService {
  constructor(
    private readonly accounts: PayoutAccountsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly envelope: EnvelopeService,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
  ) {}

  /** getPayoutAccount, adminGetPayoutAccount: the tenant's payout account without its ciphertext; `404` without one. */
  async get(tenantId: string): Promise<PayoutAccountView> {
    const row = await this.accounts.findForTenant(tenantId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return row;
  }

  /** setPayoutAccount: sets or replaces the tenant's payout account for the owner `membership` (see the file header). */
  async set(membership: TenantMembership, body: SetPayoutAccountRequest): Promise<PayoutAccountView> {
    const { tenantId, accountId } = membership;
    const bank = bankDetailsOf(body);
    // Encrypted before the transaction: the plaintext JSON exists only inside encryptJson.
    const encrypted = await this.envelope.encryptJson(bank.details, bankDetailsPlace(tenantId));
    return runInTransaction(this.db, async (trx) => {
      const tenant = await this.accounts.tenantLabel(tenantId, trx);
      if (tenant === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const before = await this.accounts.lockForTenant(trx, tenantId);
      const after = await this.accounts.upsert(trx, {
        tenantId,
        accountHolderName: body.accountHolderName.trim(),
        countryCode: body.countryCode,
        currency: body.currency,
        scheme: bank.scheme,
        bankDetailsCiphertext: encrypted.ciphertext,
        encryptionKeyId: encrypted.kekId,
        last4: bank.last4,
        updatedByAccountId: accountId,
        now: this.clock.now(),
      });
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "payout_account.updated",
        targetType: "payout_account",
        targetId: tenantId,
        tenantId,
        ...(before === undefined ? {} : { before: auditedFields(before) }),
        after: auditedFields(after),
        details: { version: after.version },
      });
      await this.alertOps(trx, tenantId, tenant, after);
      return after;
    });
  }

  /**
   * adminRevealPayoutAccount: the bank identifiers of the tenant's payout account for the platform admin of `caller`,
   * audited with the trimmed `typedReason` in the same transaction; `400` for a reason shorter than 5 characters once
   * trimmed, `404` without an account (see the file header).
   */
  async reveal(
    caller: AccessTokenClaims,
    tenantId: string,
    typedReason: string,
  ): Promise<RevealedPayoutAccount> {
    const reason = typedReason.trim();
    if (reason.length < MIN_REASON_LENGTH) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          {
            path: "/reason",
            code: "minLength",
            message: `Write why you reveal the bank details, in at least ${MIN_REASON_LENGTH} characters besides spaces.`,
          },
        ],
      });
    }
    return runInTransaction(this.db, async (trx) => {
      const row = await this.accounts.findWithDetails(trx, tenantId);
      if (row === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const details = revealedDetails(
        await this.envelope.decryptJson(row.bank_details_ciphertext, bankDetailsPlace(tenantId)),
        row.scheme,
      );
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "payout_account.revealed",
        targetType: "payout_account",
        targetId: tenantId,
        tenantId,
        details: { reason, scheme: row.scheme, version: row.version },
      });
      return details;
    });
  }

  /**
   * adminReviewPayoutAccount: records the review of the platform admin of `caller` when `expectedVersion` is the
   * account's version, and e-mails the owners (see the file header).
   */
  async review(
    caller: AccessTokenClaims,
    tenantId: string,
    expectedVersion: number,
    body: ReviewPayoutAccountRequest,
  ): Promise<PayoutAccountView> {
    const note = body.decision === "rejected" ? body.note.trim() : null;
    if (note === "") {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [{ path: "/note", code: "blank", message: "Write why the account is rejected." }],
      });
    }
    return runInTransaction(this.db, async (trx) => {
      const current = await this.accounts.lockForTenant(trx, tenantId);
      if (current === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (current.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (current.status === body.decision && current.review_note === note) {
        return current;
      }
      const reviewed = await this.accounts.review(trx, {
        tenantId,
        status: body.decision,
        reviewNote: note,
        reviewedByAccountId: caller.sub,
        now: this.clock.now(),
      });
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: caller.sub,
        action: "payout_account.reviewed",
        targetType: "payout_account",
        targetId: tenantId,
        tenantId,
        before: { status: current.status, reviewNote: current.review_note },
        after: { status: reviewed.status, reviewNote: reviewed.review_note },
        details: { decision: body.decision, version: reviewed.version },
      });
      await this.notifyOwners(trx, tenantId, reviewed);
      return reviewed;
    });
  }

  /** Queues the `ops.alert` of a new or changed payout account: who, never a number. */
  private async alertOps(
    trx: PlatformTransaction,
    tenantId: string,
    tenant: TenantLabel,
    account: PayoutAccountView,
  ): Promise<void> {
    await this.outbox.queueOpsAlert(trx, {
      title: `Payout account to review: ${tenant.name} (${tenant.key})`,
      message:
        `The owner of ${tenant.name} (${tenant.key}, ${tenantId}) set a new payout account ` +
        `(${account.scheme} account in ${account.country_code}, ${account.currency}; version ${account.version}).\n` +
        "It stays pending review until a platform admin verifies it: open the OTA's payout account in the platform " +
        "admin, check the holder name against the OTA's legal name, then verify or reject it.",
      tenantId,
      idempotencyKey: `payout_account:${tenantId}:${account.version}`,
    });
  }

  /** Queues `payouts.reviewed` to every active owner of the tenant, once per owner and version. */
  private async notifyOwners(
    trx: PlatformTransaction,
    tenantId: string,
    account: PayoutAccountView,
  ): Promise<void> {
    const tenant = await this.accounts.tenantLabel(tenantId, trx);
    if (tenant === undefined) {
      return;
    }
    const outcome = REVIEW_OUTCOMES[account.status === "verified" ? "verified" : "rejected"];
    const payoutAccountUrl = this.outbox.portalLink(`/otas/${tenantId}/payments/payout-account`);
    for (const owner of await this.accounts.activeOwners(trx, tenantId)) {
      await this.outbox.queue(trx, {
        templateKey: "payouts.reviewed",
        to: owner.email,
        accountId: owner.account_id,
        tenantId,
        data: {
          fullName: owner.full_name,
          tenantName: tenant.name,
          tenantKey: tenant.key,
          outcome: outcome.outcome,
          nextStep: outcome.nextStep,
          payoutAccountUrl,
        },
        idempotencyKey: `payout_review:${tenantId}:${account.version}`,
      });
    }
  }
}
