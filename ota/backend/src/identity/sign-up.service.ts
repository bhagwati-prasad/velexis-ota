// Customer sign-up (OBE-032; flows/my-bookings-and-guest-lookup.md §3 step 1, the document's signUp, api-changes §2.2,
// ADR-0008 "Passwords", OADR-0006 points 2 and 4, architecture §8). In this order:
//
// 1. The storefront settings: a tenant without its settings row is not provisioned (`403 TENANT_SUSPENDED`, as
//    storefront.get answers); customer accounts must be on (`403 FEATURE_DISABLED`, `details.feature:
//    customerAccounts`).
// 2. `termsVersion` must be the terms version the storefront publishes (`storefront.legal.termsVersion`: the settings'
//    `terms_version`, else the day the settings were seeded, as storefront.mapper.ts `legalOf` has it). The storefront
//    always publishes one, so a sign-up without it, or with an older one, is `400 VALIDATION_FAILED` on
//    `/termsVersion`.
// 3. The password rules (password-policy.ts): `422 PASSWORD_TOO_WEAK`.
// 4. The address (trimmed; compared lower-cased, as identities store it) must not be a customer's of this tenant, nor
//    the subject of an enabled password identity: `409 EMAIL_ALREADY_REGISTERED` with a field error on `/email`.
//    Customers live in the tenant schema, so another OTA's customer with the same address is another account. Two
//    sign-ups racing for one address make one customer: the second fails on the unique indexes and answers `409` too.
// 5. The Argon2id hash (OWASP parameters, `hashCustomerPassword`), outside any transaction.
// 6. One transaction: `customers` (`active`, the marketing consent with source `sign_up`, the accepted terms version),
//    the password identity (the address lower-cased as its subject), `customer_preferences` (the locale of the body or
//    of `Accept-Language` among the storefront's, else its default; the body's currency when the storefront sells in
//    it, else its default), three `customer_consents` events (terms and privacy with the published versions, marketing
//    given or refused; no IP hash, as the tenant has no pepper for one), the verification e-mail
//    (VerificationService.issue: the token only in the outbox's encrypted `secretData`), and a session.
//
// The session: the document opens one unless the storefront's `emailVerification` is `required_before_sign_in`. This
// OTA's policy is `not_required`, or `required_before_checkout` while `require_email_verification` is on (checkout
// answers `403 EMAIL_NOT_VERIFIED` then), never `required_before_sign_in`, so every sign-up opens a session, as a
// sign-in with `rememberMe` would (30 days, `customers.last_sign_in_at`). The controller puts the tokens into the edge's
// cookies with a new CSRF value (`session: null` in the body) or into the body for key callers.
//
// The password is never logged, stored or hashed into the idempotency record: `SignUpIdempotencyHooks` leaves it out
// of the request hash, which covers the rest of the body with the address normalised. A stored answer is replayed with
// its session for 5 minutes, as the document says; later replays carry the customer with `session: null` and no
// cookies (sign in instead).
import { Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotencyRecord,
  type IdempotencyResponse,
  type IdempotentInput,
} from "../common/http/idempotency.service";
import { IdGenerator } from "../common/ids";
import { canonicalLocale, negotiateLocale } from "../storefront/storefront.mapper";
import { TenantTx } from "../tenancy/tenant-tx";
import type { VerificationSent } from "./customers.mapper";
import { CustomersRepository, type AccountSettings, type CustomerRecord } from "./customers.repository";
import { normaliseEmail } from "./lockout";
import { CustomerPasswordPolicy } from "./password-policy";
import { SessionsService, type SessionTokens } from "./sessions.service";
import { hashCustomerPassword } from "./sign-in.service";
import { isUniqueViolationOf, VerificationService } from "./verification.service";

/** How long a replay of a sign-up still carries its session (the document: an encrypted entry kept 5 minutes). */
export const SIGN_UP_SESSION_REPLAY_MS = 5 * 60 * 1000;

/** The longest legal version the storefront publishes (storefront.mapper.ts). */
const MAX_LEGAL_VERSION_LENGTH = 40;

/** The unique indexes a second sign-up of one address meets. */
const ADDRESS_UNIQUE_INDEXES: ReadonlySet<string> = new Set([
  "customers_email_lower_uq",
  "customer_identities_subject_uq",
]);

/** What `signUp` takes: the validated body, `Accept-Language` and the end user's user agent. */
export interface SignUpInput {
  readonly email: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly marketingConsent: boolean;
  readonly termsVersion?: string | undefined;
  readonly locale?: string | undefined;
  readonly currency?: string | undefined;
  /** Accepted and not kept (verification.service.ts). */
  readonly returnPath?: string | undefined;
  readonly acceptLanguage?: string | undefined;
  /** The request's own `User-Agent`, or a secret key's `X-Velexis-End-User-Agent`. */
  readonly userAgent?: string | null | undefined;
}

/** A new customer: its row, its first session and its verification e-mail. */
export interface SignedUp {
  readonly customer: CustomerRecord;
  readonly session: SessionTokens;
  readonly verification: VerificationSent;
}

/** The legal versions the storefront publishes (storefront.mapper.ts `legalOf`): the stored one, else the seed day. */
export interface LegalVersions {
  readonly termsVersion: string;
  readonly privacyVersion: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A stored legal version as the storefront publishes it: trimmed, non-empty, at most 40 characters. */
function publishedVersion(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" || trimmed.length > MAX_LEGAL_VERSION_LENGTH ? undefined : trimmed;
}

/** The terms and privacy versions of `settings`, as storefront.get publishes them. */
export function legalVersionsOf(
  settings: Pick<AccountSettings, "termsVersion" | "privacyVersion" | "createdAt">,
): LegalVersions {
  const since = settings.createdAt.toISOString().slice(0, 10);
  return {
    termsVersion: publishedVersion(settings.termsVersion) ?? since,
    privacyVersion: publishedVersion(settings.privacyVersion) ?? since,
  };
}

/**
 * The customer's locale: the body's, else `Accept-Language`'s, matched against the storefront's locales
 * (`negotiateLocale`: the same locale, its language's, else the default).
 */
export function signUpLocale(
  settings: Pick<AccountSettings, "defaultLocale" | "supportedLocales">,
  requested: string | undefined,
  acceptLanguage: string | undefined,
): string {
  const defaultLocale = canonicalLocale(settings.defaultLocale) ?? "en";
  const supported = [
    ...new Set(
      [defaultLocale, ...settings.supportedLocales]
        .map((locale) => canonicalLocale(locale))
        .filter((locale): locale is string => locale !== undefined),
    ),
  ];
  return negotiateLocale(requested ?? acceptLanguage, supported, defaultLocale);
}

/** The customer's currency: the body's when the storefront sells in it, else the storefront's default. */
export function signUpCurrency(
  settings: Pick<AccountSettings, "defaultCurrency" | "supportedCurrencies">,
  requested: string | undefined,
): string {
  const defaultCurrency = settings.defaultCurrency.trim().toUpperCase();
  const offered = new Set([
    defaultCurrency,
    ...settings.supportedCurrencies.map((code) => code.trim().toUpperCase()),
  ]);
  return requested !== undefined && offered.has(requested) ? requested : defaultCurrency;
}

/** `409 EMAIL_ALREADY_REGISTERED` with the document's field error on `/email`. */
function alreadyRegistered(cause?: unknown): AppError {
  return new AppError("EMAIL_ALREADY_REGISTERED", {
    fieldErrors: [{ path: "/email", code: "taken", message: "Already registered" }],
    ...(cause === undefined ? {} : { cause }),
  });
}

@Injectable()
export class SignUpService {
  constructor(
    private readonly customers: CustomersRepository,
    private readonly sessions: SessionsService,
    private readonly verifications: VerificationService,
    private readonly passwords: CustomerPasswordPolicy,
    private readonly tx: TenantTx,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(SignUpService.name) private readonly logger: PinoLogger,
  ) {}

  /** auth.signUp (see the file header). */
  async signUp(input: SignUpInput): Promise<SignedUp> {
    const email = input.email.trim();
    const subject = normaliseEmail(email);
    const { settings, taken } = await this.tx.run(async (trx) => ({
      settings: await this.customers.accountSettings(trx),
      taken: await this.customers.addressTaken(trx, subject),
    }));
    if (settings === undefined) {
      throw new AppError("TENANT_SUSPENDED", { message: "The storefront of this OTA is not ready yet." });
    }
    if (!settings.customerAccountsEnabled) {
      throw new AppError("FEATURE_DISABLED", { details: { feature: "customerAccounts" } });
    }
    const legal = legalVersionsOf(settings);
    this.checkTermsVersion(input.termsVersion, legal.termsVersion);
    this.passwords.check(input.password);
    if (taken) {
      throw alreadyRegistered();
    }
    const passwordHash = await hashCustomerPassword(input.password);
    const locale = signUpLocale(settings, input.locale, input.acceptLanguage);
    const currency = signUpCurrency(settings, input.currency);
    const customerId = this.ids.newId("cus");
    const identityId = this.ids.newId("cid");
    const opened = await this.tx
      .run(async (trx) => {
        const now = this.clock.now();
        await this.customers.insertAccount(trx, {
          customer: {
            id: customerId,
            email,
            first_name: input.firstName.trim(),
            last_name: input.lastName.trim(),
            status: "active",
            marketing_consent: input.marketingConsent,
            marketing_consent_updated_at: now,
            marketing_consent_source: "sign_up",
            terms_accepted_version: legal.termsVersion,
            terms_accepted_at: now,
            last_sign_in_at: now,
            created_at: now,
            updated_at: now,
          },
          identity: {
            id: identityId,
            customer_id: customerId,
            provider: "password",
            provider_subject: subject,
            password_hash: passwordHash,
            password_updated_at: now,
            email,
            created_at: now,
            updated_at: now,
          },
          preferences: {
            id: this.ids.newId("cpf"),
            customer_id: customerId,
            locale,
            currency,
            created_at: now,
            updated_at: now,
          },
          consents: [
            { kind: "terms", policy_version: legal.termsVersion, granted: true },
            { kind: "privacy", policy_version: legal.privacyVersion, granted: true },
            { kind: "marketing", policy_version: null, granted: input.marketingConsent },
          ].map((consent) => ({
            id: this.ids.newId("ccn"),
            customer_id: customerId,
            ...consent,
            source: "sign_up",
            created_at: now,
            updated_at: now,
          })),
        });
        const verification = await this.verifications.issue(trx, {
          customerId,
          identityId,
          to: email,
          firstName: input.firstName.trim(),
          locale,
        });
        const issued = await this.sessions.start(trx, {
          customerId,
          identityId,
          rememberMe: true,
          userAgent: input.userAgent,
        });
        const customer = await this.customers.findCustomer(trx, customerId);
        if (customer === undefined) {
          // Written in this transaction a moment ago: it cannot be missing.
          throw new Error("SignUpService.signUp: the new customer cannot be read back");
        }
        return { customer, verification, issued };
      })
      .catch((error: unknown) => {
        throw isUniqueViolationOf(error, ADDRESS_UNIQUE_INDEXES) ? alreadyRegistered(error) : error;
      });
    // Ids only: the address, the password and the tokens are never logged.
    this.logger.info({ customerId, sessionId: opened.issued.sessionId }, "customer.signed_up");
    return {
      customer: opened.customer,
      session: await this.sessions.tokensFor(opened.issued),
      verification: {
        policy: settings.requireEmailVerification ? "required_before_checkout" : "not_required",
        sentTo: opened.verification.sentTo,
        expiresAt: opened.verification.expiresAt,
      },
    };
  }

  /** `400 VALIDATION_FAILED` on `/termsVersion` unless `sent` is the published `current` version. */
  private checkTermsVersion(sent: string | undefined, current: string): void {
    if (sent === undefined) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          {
            path: "/termsVersion",
            code: "required",
            message: "Send the terms version the customer accepted (storefront.legal.termsVersion).",
          },
        ],
      });
    }
    if (sent !== current) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          {
            path: "/termsVersion",
            code: "outdated",
            message: "The terms have changed: show the current terms and ask again.",
          },
        ],
      });
    }
  }
}

/**
 * The idempotency hooks of auth.signUp (idempotency.service.ts): the request hash covers the body without the
 * password, which has no safe unkeyed hash, with the address normalised as the sign-up reads it; a replay older than
 * `SIGN_UP_SESSION_REPLAY_MS` carries the customer without the session (`session: null`, no cookies).
 */
@Injectable()
@IdempotencyHooksFor(["signUp"])
export class SignUpIdempotencyHooks implements IdempotencyHooks {
  constructor(private readonly clock: Clock) {}

  hashInput(input: IdempotentInput): unknown {
    const body = isObject(input.body) ? input.body : {};
    const { email, password: _password, ...rest } = body;
    return {
      path: input.path,
      query: input.query,
      body: { ...rest, email: typeof email === "string" ? normaliseEmail(email) : null },
    };
  }

  resolveReplay(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined> {
    const age = this.clock.now().getTime() - record.createdAt.getTime();
    if (record.status !== "completed" || age <= SIGN_UP_SESSION_REPLAY_MS) {
      return Promise.resolve(undefined);
    }
    const { body } = record.response;
    return Promise.resolve({
      ...record.response,
      setCookie: [],
      body: isObject(body) ? { ...body, session: null } : body,
    });
  }
}
