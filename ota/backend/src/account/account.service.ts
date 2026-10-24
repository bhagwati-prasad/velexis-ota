// The customer account (OBE-035; ota/docs/scope.md §3.1, flows/my-bookings-and-guest-lookup.md §3 step 9, the
// document's getAccount, updateAccount and deleteAccount, db README §7 "End-customer erasure inside a tenant", ADR-0008
// "Passwords" and "Lockout").
//
// Every operation is the signed-in customer's own (the customer guard read its token or cookie: `sub` and `sid`). Its
// customer must still be allowed to hold a session (`active` or `pending_verification`, not deleted) and the token's
// session must still be live (its current generation neither revoked nor ended), as auth.getSession asks: an access
// token is stateless for its 15 minutes elsewhere (ADR-0008), but the account pages answer `401 UNAUTHENTICATED` as
// soon as the session was signed out, revoked (a password change, a reset, a deletion) or its customer deleted, so a
// deleted account's cookie or bearer token no longer reads or changes it.
//
// account.get reads the customer (`Customer`, `ETag: "<version>"`).
//
// account.update (`If-Match` required; quoted, weak or bare versions as checkout.mapper.ts `ifMatchSatisfied` reads
// them; a stale one is `412 PRECONDITION_FAILED` and changes nothing):
//
// - names are trimmed and must not be blank; `phone` needs `countryCallingCode` (one to four digits, a leading `+` is
//   dropped) and `number` (one to fifteen digits), as `customers` stores them (`deviceType` is not kept); `null` clears
//   `phone` or `dateOfBirth`; a date of birth in the future is refused. Problems are `400 VALIDATION_FAILED` with field
//   errors that never quote the value.
// - `marketingConsent` that differs from the current one updates `customers` (source `account`) and appends a
//   `customer_consents` event (no IP hash: the tenant has no pepper for one, as at sign-up).
// - `email` needs `currentPassword` (the document's `dependentRequired`), verified with the sign-in lockout of
//   lockout.ts before anything changes: the attempt is counted first, a wrong password answers `422
//   CURRENT_PASSWORD_INCORRECT` on `/currentPassword`, and once five attempts are counted within 15 minutes (sign-ins,
//   password changes and these together) the address answers `429 RATE_LIMITED` with `Retry-After` and
//   `details.reason: password_attempts` without a verification (the document lists no `423` for these operations).
//   The new address must not be another customer's of this OTA nor the subject of another enabled identity (`409
//   EMAIL_ALREADY_REGISTERED` on `/email`); it becomes `pendingEmail`, and VerificationService.issue sends a new
//   verification link to it (`auth.verify_email`, the token only in the outbox's encrypted `secretData`); the link of
//   an earlier change stops working. Sign-in keeps the current address until auth.verifyEmail confirms the new one,
//   which then moves it into `email` and the identity's subject (verification.service.ts). At most one verification
//   e-mail a minute per identity, as for the resend: an address change within a minute of the last link is `429
//   RATE_LIMITED` with `Retry-After` and `details.reason: verification_email`. Sending the current address again
//   withdraws a pending change (`pendingEmail` back to `null`, its link dropped). With the verification link, the same
//   transaction queues the document's security notice to the current address, `account.email_changed` (OADR-0013
//   item 4 as revised on 2026-10-24, lead decision (3), FIX-W29-OTA): when the change was asked for, in the customer's
//   language, never the new address and no link that acts on the account (a call the outbox refuses is logged and
//   skipped, as the booking e-mails' are; the change stands).
// - Then, in one transaction under the customer's `FOR UPDATE` lock, the version is compared again, the verified hash
//   must still be the stored one (a password changed meanwhile is `422`), and the changed columns are written with
//   `version` + 1 (a request that changes nothing keeps the version).
//
// account.delete (`Idempotency-Key` required; `DeleteAccountIdempotencyHooks` leaves the password out of the request
// hash):
//
// - `exportData: true` is `403 FEATURE_DISABLED` with `details.feature: dataExports`: data exports are deferred (scope
//   §3.1, access requests are handled by the OTA by hand), and a deletion that promised an export it cannot deliver
//   would erase the data first. Nothing changes.
// - `currentPassword` is verified as for an address change (`422`, `429`).
// - Then one transaction (account.repository.ts for the lock order; run again, at most three times in all, when
//   PostgreSQL rolls it back for a deadlock with a concurrent checkout.create): the customer's `open` and
//   `payment_pending` checkouts are locked, then the customer. A booking of the customer that still waits for
//   payment, ticketing or a refund (`AccountRepository.blockingBookings`) answers `409 ACCOUNT_DELETION_BLOCKED` with
//   `details.bookingIds` and changes nothing; live bookings always count, test bookings when the request is in the
//   test environment (test money is not real, so a forgotten test booking never holds back the erasure of a live
//   customer), and a `pending` booking whatever its environment (lead decision (3) of 2026-10-24, FIX-W29-OTA: its
//   order may exist and its checkout stays open for the reconciliation, OADR-0003 point 10, so no deletion leaves an
//   open checkout of a deleted customer behind). Otherwise: the checkouts become `abandoned` (the customer can no
//   longer finish them, and a still valid access token cannot turn them into bookings of a deleted account; one whose
//   booking is still `pending` is never abandoned, a safeguard only now); the Stripe payments of the abandoned
//   checkouts that are not confirmed yet or authorised, and pay
//   for no order, get a `payment.void` job on `ota-payments` after the commit (as the checkout expiry voids an expired
//   checkout's: the deleted customer's card is not held until Stripe drops the authorisation; an enqueue that fails is
//   logged, never the answer's failure, and the daily authorisation watch still sees the payment); every session is
//   revoked (`account_deleted`), the identities are disabled with the placeholder as their subject, open reset links
//   end, a marketing withdrawal is appended to the consent log, and the customer becomes `deleted` with `deleted_at`
//   and the address replaced by `<HMAC-SHA-256 hex>@deleted.invalid` (`customers_deleted_ck`). The HMAC key is 256
//   random bits that are not kept: a salted hash that cannot be linked back to the address, and two deletions of one
//   address never meet on `customers_email_lower_uq`. The address can sign up again at once. Names, phone and date
//   of birth stay until the erasure job (OBE-087, M6); bookings keep their `customer_id` until it detaches them.
//   After the commit, before anything else, `CustomerAccess.revoke` revokes what the customer guard cached of the
//   customer (FIX-W29-SECURITY): from then on its still valid access tokens are refused with `401 UNAUTHENTICATED` on
//   every customer-scope operation, not only on account.*, and a checkout.create that read the customer before the
//   commit finds it deleted after its insert (checkout.service.ts).
// - The answer is `202 AccountDeletion` (`scheduled`, erasure due 30 days later, the kept records when the customer
//   has bookings); the controller clears the edge's session cookies and rotates its CSRF value. `reason` is logged (an
//   enum), `comment` is accepted and not kept (free text may carry personal data, and the tenant has no column for
//   it). The same transaction queues the document's confirmation e-mail, `account.deleted` (OADR-0013 item 4 as revised
//   on 2026-10-24, FIX-W29-OTA), to the address before it was replaced, in the customer's language: when the account
//   was deleted, the erasure date and whether booking records are kept (once per customer; a call the outbox refuses
//   is logged and skipped).
//
// Passwords, tokens and addresses are never logged: the log lines carry ids, field names and outcomes only.
import { randomBytes } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { hmacSha256 } from "@velexis/crypto";
import { AppError, type FieldError } from "@velexis/errors";
import { verify } from "argon2";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { Clock } from "../common/clock";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotentInput,
} from "../common/http/idempotency.service";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { EMAIL_ADDRESS } from "../config";
import { CustomerAccess } from "../identity/customer-access";
import { CustomersRepository, type CustomerRecord } from "../identity/customers.repository";
import { normaliseEmail, SignInLockout } from "../identity/lockout";
import { mayHoldSession, SessionsService } from "../identity/sessions.service";
import { emailInstant, RESEND_INTERVAL_MS, VerificationService } from "../identity/verification.service";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { PAYMENT_JOB, paymentJob } from "../payments/payments.processor";
import { canonicalLocale } from "../storefront/storefront.mapper";
import { TenantContext } from "../tenancy/tenant-context";
import { afterCommit, TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { ERASURE_DUE_AFTER_MS, type AccountDeletionOutcome } from "./account.mapper";
import { AccountRepository, type AccountPasswordIdentity, type ProfileUpdate } from "./account.repository";

type Schemas = components["schemas"];
export type CustomerUpdateRequest = Schemas["CustomerUpdateRequest"];
export type AccountDeletionInput = Schemas["AccountDeletionInput"];

/** The signed-in customer of the request (the access token's `sub` and `sid`). */
export interface AccountPrincipal {
  readonly customerId: string;
  readonly sessionId: string;
}

/** The domain of the placeholder address of a deleted customer (db README §7). */
export const DELETED_ADDRESS_DOMAIN = "deleted.invalid";

/** The bytes of the key of the placeholder's HMAC: 256 random bits, never kept. */
export const DELETED_ADDRESS_KEY_BYTES = 32;

/** How long a deletion waits for its `payment.void` enqueues after the commit (Redis down: logged, not failed). */
export const VOID_ENQUEUE_TIMEOUT_MS = 2_000;

/** How often a deletion's transaction runs at most when PostgreSQL rolls it back for a deadlock. */
export const DELETION_ATTEMPTS = 3;

/** SQLSTATE `deadlock_detected`: PostgreSQL rolled the transaction back, nothing of it was written. */
const DEADLOCK_DETECTED = "40P01";

/** Whether `error` is PostgreSQL's deadlock (SQLSTATE 40P01). */
export function isDeadlock(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === DEADLOCK_DETECTED
  );
}

/** What one attempt of the deletion's transaction did: the bookings that block it, or what it changed. */
type DeletionResult =
  | { readonly blocking: readonly string[] }
  | {
      readonly now: Date;
      readonly abandonedCheckouts: number;
      readonly paymentVoidsQueued: number;
      readonly revokedSessions: number;
      readonly disabledIdentities: number;
      readonly hasBookings: boolean;
    };

/** A calling code as `customers.phone_country_code` stores it, after an optional leading `+`. */
const CALLING_CODE = /^\+?([0-9]{1,4})$/;

/** A phone number as `customers.phone_number` stores it. */
const PHONE_NUMBER = /^[0-9]{1,15}$/;

/** Why a re-authentication or an address change must wait (`details.reason` of `429 RATE_LIMITED`). */
export type RetryLaterReason = "password_attempts" | "verification_email";

const RETRY_LATER_MESSAGES: Readonly<Record<RetryLaterReason, string>> = Object.freeze({
  password_attempts: "Too many wrong passwords. Try again later or reset your password.",
  verification_email:
    "We sent a verification link a moment ago. Wait a minute before asking for another one.",
});

/** `429 RATE_LIMITED` with the seconds the controller answers as `Retry-After`. */
export class AccountRetryLaterError extends AppError<"RATE_LIMITED"> {
  constructor(
    readonly retryAfterSeconds: number,
    reason: RetryLaterReason,
  ) {
    super("RATE_LIMITED", { message: RETRY_LATER_MESSAGES[reason], details: { reason } });
  }
}

/** `422 CURRENT_PASSWORD_INCORRECT` on `/currentPassword` (`AccountUnprocessable` of the document). */
function currentPasswordIncorrect(): AppError {
  return new AppError("CURRENT_PASSWORD_INCORRECT", {
    fieldErrors: [
      { path: "/currentPassword", code: "incorrect", message: "Your current password is not correct." },
    ],
  });
}

/** `409 EMAIL_ALREADY_REGISTERED` with the document's field error on `/email`. */
function alreadyRegistered(): AppError {
  return new AppError("EMAIL_ALREADY_REGISTERED", {
    fieldErrors: [{ path: "/email", code: "taken", message: "Already registered" }],
  });
}

/** The changes of an account.update body, checked and normalised (`profileChangesOf`). */
export interface ProfileChanges {
  readonly firstName?: string;
  readonly lastName?: string;
  /** The phone as stored (`null` clears it). */
  readonly phone?: { readonly countryCallingCode: string; readonly number: string } | null;
  /** `YYYY-MM-DD` (`null` clears it). */
  readonly dateOfBirth?: string | null;
  readonly marketingConsent?: boolean;
  /** The new address, trimmed. */
  readonly email?: string;
}

/** A mutable copy of `ProfileChanges` while it is built. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The changes of an account.update body (see the file header): names trimmed, the phone as `customers` stores it, the
 * address trimmed and mailable. `today` is the date in UTC (`YYYY-MM-DD`) a date of birth must not be after. Every
 * problem is collected into one `400 VALIDATION_FAILED`, whose field errors never quote a value.
 */
export function profileChangesOf(body: CustomerUpdateRequest, today: string): ProfileChanges {
  const errors: FieldError[] = [];
  const changes: Mutable<ProfileChanges> = {};
  for (const field of ["firstName", "lastName"] as const) {
    const value = body[field];
    if (value === undefined) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      errors.push({ path: `/${field}`, code: "blank", message: "Enter a name." });
    } else {
      changes[field] = trimmed;
    }
  }
  if (body.phone === null) {
    changes.phone = null;
  } else if (body.phone !== undefined) {
    const code = CALLING_CODE.exec(body.phone.countryCallingCode?.trim() ?? "");
    const number = body.phone.number?.trim() ?? "";
    if (body.phone.countryCallingCode === undefined) {
      errors.push({
        path: "/phone/countryCallingCode",
        code: "required",
        message: "Enter the country calling code.",
      });
    } else if (code === null) {
      errors.push({
        path: "/phone/countryCallingCode",
        code: "pattern",
        message: "Enter the country calling code with one to four digits.",
      });
    }
    if (body.phone.number === undefined) {
      errors.push({ path: "/phone/number", code: "required", message: "Enter the phone number." });
    } else if (!PHONE_NUMBER.test(number)) {
      errors.push({
        path: "/phone/number",
        code: "pattern",
        message: "Enter the phone number with one to fifteen digits only.",
      });
    }
    if (code?.[1] !== undefined && PHONE_NUMBER.test(number)) {
      changes.phone = { countryCallingCode: code[1], number };
    }
  }
  if (body.dateOfBirth === null) {
    changes.dateOfBirth = null;
  } else if (body.dateOfBirth !== undefined) {
    if (body.dateOfBirth > today) {
      errors.push({
        path: "/dateOfBirth",
        code: "in_future",
        message: "The date of birth is in the future.",
      });
    } else {
      changes.dateOfBirth = body.dateOfBirth;
    }
  }
  if (body.marketingConsent !== undefined) {
    changes.marketingConsent = body.marketingConsent;
  }
  if (body.email !== undefined) {
    const email = body.email.trim();
    if (!EMAIL_ADDRESS.test(email)) {
      errors.push({ path: "/email", code: "format", message: "Enter an e-mail address we can send to." });
    } else {
      changes.email = email;
    }
  }
  if (errors.length > 0) {
    throw new AppError("VALIDATION_FAILED", { fieldErrors: errors });
  }
  return changes;
}

/**
 * The placeholder address of a deleted customer: the HMAC-SHA-256 (hex) of the normalised `email` under `key`, at
 * `deleted.invalid` (db README §7). The service passes a random key that it never keeps.
 */
export function deletedAddress(email: string, key: Uint8Array): string {
  return `${hmacSha256(key, normaliseEmail(email))}@${DELETED_ADDRESS_DOMAIN}`;
}

/**
 * The environments whose bookings may hold a deletion back: live bookings always, test bookings when the request is in
 * the test environment (see the file header). A `pending` booking holds it back whatever its environment
 * (`AccountRepository.blockingBookings`).
 */
export function deletionEnvironments(environment: "test" | "live"): readonly ("test" | "live")[] {
  return environment === "test" ? ["test", "live"] : ["live"];
}

/** The template of the security notice to the current address when its change is asked for (FIX-W29-OTA). */
export const EMAIL_CHANGED_TEMPLATE = "account.email_changed";

/** The template of the deletion's confirmation (FIX-W29-OTA). */
export const ACCOUNT_DELETED_TEMPLATE = "account.deleted";

/** The date of `now` in UTC (`YYYY-MM-DD`). */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** What `update` takes: the validated body and the request's `If-Match`. */
export interface AccountUpdateInput {
  readonly body: CustomerUpdateRequest;
  readonly ifMatch: string;
}

/** What `delete` takes: the validated body. */
export type AccountDeleteInput = AccountDeletionInput;

/** What an address change did, for the log line. */
type EmailChange = "requested" | "withdrawn" | "unchanged";

@Injectable()
export class AccountService {
  constructor(
    private readonly repository: AccountRepository,
    private readonly customers: CustomersRepository,
    private readonly sessions: SessionsService,
    private readonly verifications: VerificationService,
    private readonly lockout: SignInLockout,
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly access: CustomerAccess,
    private readonly outbox: OutboxService,
    @InjectQueue(OTA_QUEUE.payments) private readonly paymentsQueue: Queue,
    @InjectPinoLogger(AccountService.name) private readonly logger: PinoLogger,
  ) {}

  /** account.get (see the file header). */
  async get(principal: AccountPrincipal): Promise<CustomerRecord> {
    return this.tx.run(async (trx) =>
      this.requireAccount(trx, principal, await this.customers.findCustomer(trx, principal.customerId)),
    );
  }

  /** account.update (see the file header): the customer as it is afterwards. */
  async update(principal: AccountPrincipal, input: AccountUpdateInput): Promise<CustomerRecord> {
    const { customerId } = principal;
    const changes = profileChangesOf(input.body, utcDate(this.clock.now()));
    const seen = await this.tx.run(async (trx) => {
      const customer = await this.requireAccount(
        trx,
        principal,
        await this.customers.findCustomer(trx, customerId),
      );
      const identity =
        changes.email === undefined ? undefined : await this.repository.passwordIdentity(trx, customerId);
      return { customer, identity };
    });
    if (!ifMatchSatisfied(input.ifMatch, seen.customer.version)) {
      throw new AppError("PRECONDITION_FAILED");
    }
    let verified: AccountPasswordIdentity | undefined;
    if (changes.email !== undefined) {
      if (seen.identity === undefined) {
        // No password to re-authenticate with (an identity disabled meanwhile): the account cannot change its address.
        throw new AppError("UNAUTHENTICATED");
      }
      // The document's dependentRequired: the validation interceptor refused `email` without `currentPassword`.
      await this.reauthenticate(customerId, seen.identity, input.body.currentPassword ?? "");
      verified = seen.identity;
    }
    const outcome = await this.tx.run(async (trx) => {
      const customer = await this.requireAccount(
        trx,
        principal,
        await this.customers.lockCustomer(trx, customerId),
      );
      if (!ifMatchSatisfied(input.ifMatch, customer.version)) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const now = this.clock.now();
      const set: Mutable<ProfileUpdate> = {};
      if (changes.firstName !== undefined && changes.firstName !== customer.first_name) {
        set.first_name = changes.firstName;
      }
      if (changes.lastName !== undefined && changes.lastName !== customer.last_name) {
        set.last_name = changes.lastName;
      }
      if (
        changes.phone !== undefined &&
        (changes.phone?.countryCallingCode ?? null) !== customer.phone_country_code
      ) {
        set.phone_country_code = changes.phone?.countryCallingCode ?? null;
      }
      if (changes.phone !== undefined && (changes.phone?.number ?? null) !== customer.phone_number) {
        set.phone_number = changes.phone?.number ?? null;
      }
      if (changes.dateOfBirth !== undefined && changes.dateOfBirth !== customer.date_of_birth) {
        set.date_of_birth = changes.dateOfBirth;
      }
      if (changes.marketingConsent !== undefined && changes.marketingConsent !== customer.marketing_consent) {
        set.marketing_consent = changes.marketingConsent;
        set.marketing_consent_updated_at = now;
        set.marketing_consent_source = "account";
        await this.repository.insertConsent(trx, {
          id: this.ids.newId("ccn"),
          customer_id: customerId,
          kind: "marketing",
          policy_version: null,
          granted: changes.marketingConsent,
          source: "account",
          created_at: now,
          updated_at: now,
        });
      }
      let emailChange: EmailChange | undefined;
      if (changes.email !== undefined && verified !== undefined) {
        emailChange = await this.changeAddress(trx, customer, verified, changes.email, {
          firstName: set.first_name ?? customer.first_name,
          set,
          now,
        });
      }
      const fields = Object.keys(set);
      if (fields.length > 0) {
        await this.repository.updateProfile(trx, customerId, set, now);
      }
      const updated = await this.customers.findCustomer(trx, customerId);
      if (updated === undefined) {
        // Locked by this transaction: it cannot have gone.
        throw new Error("AccountService.update: the customer cannot be read back");
      }
      return { updated, fields, emailChange };
    });
    // Column names and ids only: the values, the addresses and the password are never logged.
    this.logger.info(
      { customerId, fields: outcome.fields, emailChange: outcome.emailChange },
      "customer.account_updated",
    );
    return outcome.updated;
  }

  /** account.delete (see the file header): when it was made and whether bookings are kept. */
  async delete(principal: AccountPrincipal, input: AccountDeleteInput): Promise<AccountDeletionOutcome> {
    const { customerId } = principal;
    if (input.exportData === true) {
      throw new AppError("FEATURE_DISABLED", {
        message: "Data exports are not available here: contact the travel agency for a copy of your data.",
        details: { feature: "dataExports" },
      });
    }
    const identity = await this.tx.run(async (trx) => {
      await this.requireAccount(trx, principal, await this.customers.findCustomer(trx, customerId));
      return this.repository.passwordIdentity(trx, customerId);
    });
    if (identity === undefined) {
      throw new AppError("UNAUTHENTICATED");
    }
    await this.reauthenticate(customerId, identity, input.currentPassword);
    const done = await this.deletionWithRetry(principal, identity);
    if ("blocking" in done) {
      this.logger.info({ customerId, bookings: done.blocking.length }, "customer.account_deletion_blocked");
      throw new AppError("ACCOUNT_DELETION_BLOCKED", {
        message:
          "Your account can be deleted once your bookings that wait for payment, tickets or a refund are settled.",
        details: { bookingIds: done.blocking },
      });
    }
    // Ids, counts and the reason (an enum) only: the address, the comment and the password are never logged.
    this.logger.info(
      {
        customerId,
        reason: input.reason ?? null,
        revokedSessions: done.revokedSessions,
        abandonedCheckouts: done.abandonedCheckouts,
        paymentVoidsQueued: done.paymentVoidsQueued,
        disabledIdentities: done.disabledIdentities,
      },
      "customer.account_deleted",
    );
    return { requestedAt: done.now, hasBookings: done.hasBookings };
  }

  /**
   * The deletion's transaction (see the file header), run again when PostgreSQL rolled it back for a deadlock, at most
   * DELETION_ATTEMPTS times. Its locks (the open checkouts, then the customer) meet checkout.create's in the other
   * order: the new checkout's insert holds the customer's `FOR KEY SHARE` while it abandons the customer's other open
   * checkouts of the same offer, which the deletion may have locked. PostgreSQL ends that cycle by rolling back the
   * transaction that waited first, normally the deletion's; nothing of it was written, and the next attempt waits for
   * the checkout.create to commit and abandons its checkout too.
   */
  private async deletionWithRetry(
    principal: AccountPrincipal,
    identity: AccountPasswordIdentity,
  ): Promise<DeletionResult> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.deletion(principal, identity);
      } catch (error) {
        if (!isDeadlock(error) || attempt >= DELETION_ATTEMPTS) {
          throw error;
        }
        this.logger.warn({ customerId: principal.customerId, attempt }, "customer.account_deletion_deadlock");
      }
    }
  }

  /** One attempt of the deletion's transaction (see the file header). */
  private async deletion(
    principal: AccountPrincipal,
    identity: AccountPasswordIdentity,
  ): Promise<DeletionResult> {
    const { customerId } = principal;
    const tenant = this.tenants.require();
    return await this.tx.run(async (trx): Promise<DeletionResult> => {
      await this.repository.lockOpenCheckouts(trx, customerId);
      const customer = await this.requireAccount(
        trx,
        principal,
        await this.customers.lockCustomer(trx, customerId),
      );
      const current = await this.repository.passwordIdentity(trx, customerId);
      if (current?.passwordHash !== identity.passwordHash) {
        // The password changed after it was verified: the one given is not current.
        throw currentPasswordIncorrect();
      }
      const blocking = await this.repository.blockingBookings(
        trx,
        customerId,
        deletionEnvironments(tenant.environment),
      );
      if (blocking.length > 0) {
        return { blocking };
      }
      // First after the commit: the customer guard stops trusting what it cached of this customer (FIX-W29-SECURITY).
      afterCommit(trx, () => this.access.revoke(tenant.tenantId, customerId));
      const now = this.clock.now();
      const hasBookings = await this.repository.hasBookings(trx, customerId);
      // The confirmation goes to the address before the placeholder replaces it.
      await this.notify(trx, {
        templateKey: ACCOUNT_DELETED_TEMPLATE,
        to: customer.email,
        locale: await this.localeOf(trx, customerId),
        customerId,
        data: {
          customer: { firstName: customer.first_name ?? "" },
          deletion: {
            requestedAt: emailInstant(now),
            erasureDueBy: emailInstant(new Date(now.getTime() + ERASURE_DUE_AFTER_MS)),
            bookingsKept: hasBookings,
          },
        },
        dedupeKey: `${ACCOUNT_DELETED_TEMPLATE}:${customerId}`,
      });
      const deleted = {
        customerId,
        placeholder: deletedAddress(customer.email, randomBytes(DELETED_ADDRESS_KEY_BYTES)),
        now,
      };
      const abandonedCheckouts = await this.repository.abandonOpenCheckouts(trx, customerId, now);
      const voids = await this.repository.voidablePaymentsOf(trx, abandonedCheckouts);
      if (voids.length > 0) {
        afterCommit(trx, () => this.enqueueVoids(tenant.tenantId, voids));
      }
      const revokedSessions = await this.sessions.revokeAllOfCustomer(trx, customerId, "account_deleted");
      const disabledIdentities = await this.repository.disableIdentities(trx, deleted);
      await this.repository.expireOpenResets(trx, customerId, now);
      await this.repository.insertConsent(trx, {
        id: this.ids.newId("ccn"),
        customer_id: customerId,
        kind: "marketing",
        policy_version: null,
        granted: false,
        source: "account",
        created_at: now,
        updated_at: now,
      });
      await this.repository.markDeleted(trx, deleted);
      return {
        now,
        abandonedCheckouts: abandonedCheckouts.length,
        paymentVoidsQueued: voids.length,
        revokedSessions,
        disabledIdentities,
        hasBookings,
      };
    });
  }

  /**
   * The customer of the request, when it may still use its account: it exists, may hold a session and the token's
   * session is live (see the file header); otherwise `401 UNAUTHENTICATED`.
   */
  private async requireAccount(
    trx: TenantTransaction,
    principal: AccountPrincipal,
    customer: CustomerRecord | undefined,
  ): Promise<CustomerRecord> {
    if (
      customer === undefined ||
      !mayHoldSession(customer) ||
      !(await this.repository.liveSession(trx, principal.customerId, principal.sessionId, this.clock.now()))
    ) {
      throw new AppError("UNAUTHENTICATED");
    }
    return customer;
  }

  /**
   * The address change of account.update in `trx` (the customer locked; see the file header): withdraws a pending
   * change when `email` is the current address, else checks the address, puts it into `set.pending_email` and sends
   * its verification link.
   */
  private async changeAddress(
    trx: TenantTransaction,
    customer: CustomerRecord,
    identity: AccountPasswordIdentity,
    email: string,
    context: { readonly firstName: string | null; readonly set: Mutable<ProfileUpdate>; readonly now: Date },
  ): Promise<EmailChange> {
    const current = await this.repository.passwordIdentity(trx, customer.id);
    if (current?.passwordHash !== identity.passwordHash) {
      // The password changed after it was verified: the one given is not current.
      throw currentPasswordIncorrect();
    }
    const normalised = normaliseEmail(email);
    if (normalised === normaliseEmail(customer.email)) {
      if (customer.pending_email === null) {
        return "unchanged";
      }
      context.set.pending_email = null;
      await this.repository.dropVerificationToken(trx, identity.identityId, context.now);
      return "withdrawn";
    }
    if (await this.customers.addressTaken(trx, normalised, customer.id)) {
      throw alreadyRegistered();
    }
    const verification = await this.customers.verificationIdentityOf(trx, customer.id);
    const sentAt = verification?.tokenSentAt;
    if (sentAt !== null && sentAt !== undefined) {
      const waitMs = sentAt.getTime() + RESEND_INTERVAL_MS - context.now.getTime();
      if (waitMs > 0) {
        throw new AccountRetryLaterError(Math.max(1, Math.ceil(waitMs / 1000)), "verification_email");
      }
    }
    if (customer.pending_email !== email) {
      context.set.pending_email = email;
    }
    const locale = await this.localeOf(trx, customer.id);
    await this.verifications.issue(trx, {
      customerId: customer.id,
      identityId: identity.identityId,
      to: email,
      firstName: context.firstName,
      locale,
    });
    // The security notice to the current address: when, never the new address, no link (see the file header).
    await this.notify(trx, {
      templateKey: EMAIL_CHANGED_TEMPLATE,
      to: customer.email,
      locale,
      customerId: customer.id,
      data: {
        customer: { firstName: context.firstName ?? "" },
        change: { requestedAt: emailInstant(context.now) },
      },
      dedupeKey: `${EMAIL_CHANGED_TEMPLATE}:${identity.identityId}:${context.now.getTime()}`,
    });
    return "requested";
  }

  /** The language of the customer's e-mails: their preference, else the storefront's default locale, else English. */
  private async localeOf(trx: TenantTransaction, customerId: string): Promise<string> {
    const settings = await this.customers.accountSettings(trx);
    return (
      canonicalLocale(await this.customers.preferredLocale(trx, customerId)) ??
      canonicalLocale(settings?.defaultLocale) ??
      "en"
    );
  }

  /**
   * One account e-mail in `trx` (see the file header); a call the outbox refuses is logged by template and customer,
   * never the address, and skipped: the change it reports stands.
   */
  private async notify(
    trx: TenantTransaction,
    email: Parameters<OutboxService["enqueue"]>[1] & { readonly customerId: string },
  ): Promise<void> {
    try {
      await this.outbox.enqueue(trx, email);
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error(
        { customerId: email.customerId, template: email.templateKey },
        "customer.account_email_invalid",
      );
    }
  }

  /**
   * Verifies the current password of an address change or a deletion with the sign-in lockout (see the file header):
   * the attempt is counted first; a locked address answers `429` without a verification; a wrong password answers
   * `422` (or `429` when it started the lock); the right one clears the counter, as a sign-in does.
   */
  private async reauthenticate(
    customerId: string,
    identity: AccountPasswordIdentity,
    password: string,
  ): Promise<void> {
    const attempt = await this.lockout.takeAttempt(identity.subject);
    if (!attempt.taken) {
      throw new AccountRetryLaterError(attempt.state.retryAfterSeconds, "password_attempts");
    }
    if (!(await this.matches(identity, password))) {
      this.logger.info({ customerId, locked: attempt.state.locked }, "customer.reauthentication_refused");
      if (attempt.state.locked) {
        throw new AccountRetryLaterError(attempt.state.retryAfterSeconds, "password_attempts");
      }
      throw currentPasswordIncorrect();
    }
    await this.clearLockout(identity.subject);
  }

  /** One Argon2id verification of `password` against the identity's hash; a hash Argon2 cannot read never matches. */
  private async matches(identity: AccountPasswordIdentity, password: string): Promise<boolean> {
    try {
      return await verify(identity.passwordHash, password);
    } catch {
      // Logged by id, never the hash or the password.
      this.logger.warn({ identityId: identity.identityId }, "customer.password_hash_unreadable");
      return false;
    }
  }

  /**
   * Queues `payment.void` for each of `paymentIds` (`payment-void-<pay_id>`: one job per payment however often it is
   * added) after a deletion committed; waits at most VOID_ENQUEUE_TIMEOUT_MS and never throws (see the file header).
   */
  private async enqueueVoids(tenantId: string, paymentIds: readonly string[]): Promise<void> {
    const added = Promise.all(
      paymentIds.map(async (paymentId) => {
        const job = paymentJob(PAYMENT_JOB.void, tenantId, paymentId);
        try {
          await this.paymentsQueue.add(job.name, job.data, job.opts);
        } catch (error) {
          this.logger.warn({ paymentId, err: error }, "customer.account_deletion_void_enqueue_failed");
        }
      }),
    ).then(() => "added" as const);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), VOID_ENQUEUE_TIMEOUT_MS);
    });
    try {
      if ((await Promise.race([added, timedOut])) === "timeout") {
        this.logger.warn({ payments: paymentIds.length }, "customer.account_deletion_void_enqueue_timeout");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Forgets the sign-in failures of `subject` after its password was proven. Best effort: the change has committed or
   * was refused for another reason, and a counter Redis cannot delete ends with its 15-minute TTL.
   */
  private async clearLockout(subject: string): Promise<void> {
    try {
      await this.lockout.clear(subject);
    } catch (error) {
      this.logger.warn({ err: error }, "customer.lockout_clear_failed");
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The idempotency request hash of account.delete (idempotency.service.ts): the body without the current password,
 * which has no safe unkeyed hash. The principal of the record is the customer, so a stored deletion is replayed only to
 * the customer that made it.
 */
@Injectable()
@IdempotencyHooksFor(["deleteAccount"])
export class DeleteAccountIdempotencyHooks implements IdempotencyHooks {
  hashInput(input: IdempotentInput): unknown {
    const body = isObject(input.body) ? input.body : {};
    return {
      path: input.path,
      query: input.query,
      body: {
        reason: body["reason"] ?? null,
        comment: body["comment"] ?? null,
        exportData: body["exportData"] ?? null,
      },
    };
  }
}
