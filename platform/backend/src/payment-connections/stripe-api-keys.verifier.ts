// The verifier of the OTA's own Stripe API keys (PBE-057; flows/stripe-payments-account.md §D item 3, PADR-0010 items
// 4 to 6, PADR-0011 item 5; scope PF-62 AC1): the `stripe_api_keys` verifier of the `credentials.verify` job of PBE-052
// (common/credentials/credentials-verify.processor.ts), registered in the worker's one `CredentialVerifiers` registry
// from `onModuleInit` (PaymentConnectionsWorkerModule imports `CredentialSubmissionsModule.forWorker()`). The processor
// owns the attempt: it decrypts both secrets of the submission, calls `check` outside any transaction, then `apply` in
// its final transaction with the submission locked, writes the submission's outcome with both secret columns erased,
// the audit row `payments.api_keys_applied` or `payments.api_keys_rejected` (with what `apply` answers) and the
// submitter's e-mail, and retries an `unavailable` answer (5 attempts, backoff; then `PROVIDER_UNAVAILABLE`).
//
// `check`: first the stored keys against the submission's environment (they were checked when submitted; a stored
// row that breaks the rules is refused, never sent): the secret or restricted key and the publishable key of that mode
// (`STRIPE_LIVEMODE_MISMATCH` otherwise) and a webhook signing secret of the OTA's own rule (`STRIPE_KEY_INVALID`).
// Then `GET /v1/account` with the secret key (`StripeClient.withKey(…).accounts.retrieveCurrent()`, the pinned API
// version, a 10-second timeout, one retry):
// - an account: `verified`, with its `acct_…` as the result. Stripe's account object has no `livemode`, so the key's
//   mode is the one its prefix names (a key of the other mode never reaches Stripe, above); when an answer does carry a
//   `livemode`, it must be the environment's too (`STRIPE_LIVEMODE_MISMATCH`). An answer without an `acct_…` id proves
//   nothing: `unavailable`;
// - HTTP 401 (a key Stripe does not know, revoked or expired) or 403 (a restricted key without access to the account):
//   `rejected` with `STRIPE_KEY_INVALID` (final at once);
// - anything else Stripe answers (a timeout, a network error, 429, 5xx, another 4xx): `unavailable`, retried.
// The messages carry Stripe's error type, HTTP status and code (`invalid_request_error 401`), never Stripe's message
// (which names the key, masked) or a secret.
//
// `apply(trx, …)`, in the job's transaction, after the submission (lock order: submission, then connection):
// 1. The tenant's row `FOR SHARE`: an OTA that is no longer `active` (suspended since it submitted, PADR-0014 item 5)
//    keeps its connection; the submission fails with `TENANT_NOT_ACTIVE` (CredentialRejection).
// 2. The connection of the environment `FOR UPDATE`. A connection a platform admin disabled (`disabled` without
//    `disconnected_at`, `adminSetConnectionStatus`) is not switched behind the admin's back: `CONNECTION_DISABLED`,
//    nothing written (one a Stripe deauthorisation disabled may switch, as it may connect again). A connection whose id
//    is not the submission's `connectionId` (created for the environment after the submission, so the webhook URL the
//    owner configured names no connection) fails with `CONNECTION_CHANGED`: submitting again answers its URL.
// 3. Both secrets are envelope-encrypted again for the connection's row, each with its own associated data:
//    `platform.payment_provider_connections.secret_ciphertext:<ppc_id>` and
//    `platform.payment_provider_connections.webhook_secret_ciphertext:<ppc_id>` (ADR-0010; lead decisions (2i) of
//    2026-10-30 and (2l) of 2026-10-31: the OTA backend opens them with exactly these, `connectionSecretAad` of
//    stripe-client.factory.ts and the webhook receiver), under one KEK. The connection becomes `api_keys` with the
//    `acct_…`, the publishable key, the two ciphertexts and their KEK, `active`, `connected_at` and
//    `last_verified_at` now and `version + 1` (`applyApiKeys`); without a connection for the environment it is inserted
//    under the submission's `connectionId` (`insertApiKeys`, the test connection's descriptor suffix copied).
// 4. After the commit, `vx:invalidate {type: "connection", tenantId}`, so the OTA backend drops its cached connection
//    and uses the OTA's keys for new PaymentIntents (existing payments keep the account recorded on them, PADR-0011
//    item 7).
// The answer adds the connection's values before and after (id, mode, account, publishable key, status, version, never
// a secret or a ciphertext) to the audit row of the processor.
import { Injectable, type OnModuleInit } from "@nestjs/common";
import Stripe from "stripe";
import type { PlatformTransaction } from "../audit/audit.repository";
import {
  CredentialRejection,
  CredentialVerifiers,
  type CredentialApplied,
  type CredentialApplyInput,
  type CredentialCheck,
  type CredentialCheckInput,
  type CredentialVerifier,
} from "../common/credentials/credentials-verify.processor";
import { EnvelopeService, type CiphertextPlace } from "../common/crypto.provider";
import { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import { StripeClient } from "../common/stripe/stripe.client";
import {
  PaymentConnectionsRepository,
  type PaymentConnectionView,
  type PaymentEnvironment,
} from "./payment-connections.repository";
import { STRIPE_WEBHOOK_SECRET_PATTERN, type StripeApiKeysPublicData } from "./stripe-api-keys.service";
import { disabledByAdmin, stripeConnectFailureOf } from "./stripe-connect.service";

/** The submission result code of keys Stripe refused (PADR-0010 item 6). */
export const STRIPE_KEY_INVALID = "STRIPE_KEY_INVALID";

/** The submission result code of keys of the other mode (PADR-0010 item 6). */
export const STRIPE_LIVEMODE_MISMATCH = "STRIPE_LIVEMODE_MISMATCH";

/** The submission result code of an OTA that stopped being `active` before its keys were applied. */
export const TENANT_NOT_ACTIVE = "TENANT_NOT_ACTIVE";

/** The submission result code of a connection a platform admin disabled. */
export const CONNECTION_DISABLED = "CONNECTION_DISABLED";

/** The submission result code of a connection created for the environment after the submission. */
export const CONNECTION_CHANGED = "CONNECTION_CHANGED";

/** Stripe's account ids, as `payment_provider_connections_mode_ck` takes them. */
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;
const CONNECTION_ID = /^ppc_[0-9A-HJKMNP-TV-Z]{26}$/;
const PUBLISHABLE_KEY = /^pk_(test|live)_[A-Za-z0-9]+$/;
const SECRET_KEY = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/;

/** The place of a connection's secret (or restricted) key, for the envelope's associated data (ADR-0010). */
export function connectionSecretPlace(connectionId: string): CiphertextPlace {
  return { table: "payment_provider_connections", column: "secret_ciphertext", rowId: connectionId };
}

/** The place of a connection's webhook signing secret, for the envelope's associated data (ADR-0010). */
export function connectionWebhookSecretPlace(connectionId: string): CiphertextPlace {
  return { table: "payment_provider_connections", column: "webhook_secret_ciphertext", rowId: connectionId };
}

/** A submission whose `public_data` is not what `submitStripeApiKeys` stores: an attempt that cannot complete. */
export class InvalidStripeApiKeysSubmissionError extends Error {
  override readonly name = "InvalidStripeApiKeysSubmissionError";
}

/**
 * The non-secret fields of a `stripe_api_keys` submission, checked: a `pk_(test|live)_…` publishable key and a `ppc_…`
 * connection id. Throws `InvalidStripeApiKeysSubmissionError` (naming fields, never values) otherwise.
 */
export function stripeApiKeysPublicDataOf(
  publicData: Readonly<Record<string, unknown>>,
): StripeApiKeysPublicData {
  const { publishableKey, connectionId } = publicData;
  if (typeof publishableKey !== "string" || !PUBLISHABLE_KEY.test(publishableKey)) {
    throw new InvalidStripeApiKeysSubmissionError("public_data.publishableKey is missing or invalid");
  }
  if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) {
    throw new InvalidStripeApiKeysSubmissionError("public_data.connectionId is missing or invalid");
  }
  return { publishableKey, connectionId };
}

/** The Stripe mode a key's prefix names (`pk_live_`, `sk_test_`, `rk_live_`, …), or `undefined` for another text. */
export function keyModeOf(key: string): PaymentEnvironment | undefined {
  const match = PUBLISHABLE_KEY.exec(key) ?? SECRET_KEY.exec(key);
  return match?.[1] as PaymentEnvironment | undefined;
}

/** What `GET /v1/account` gave: the account Stripe answered, or the error it threw. */
export type AccountLookup =
  { readonly ok: true; readonly account: unknown } | { readonly ok: false; readonly error: unknown };

/** The `livemode` an answer carries, when it carries a boolean one (Stripe's account object has none). */
function livemodeOf(account: unknown): boolean | undefined {
  const value: unknown = (account as { readonly livemode?: unknown } | null | undefined)?.livemode;
  return typeof value === "boolean" ? value : undefined;
}

/** What the verifier's `check` answers for one `GET /v1/account` in `environment` (see the file header). */
export function stripeKeyCheckOf(lookup: AccountLookup, environment: PaymentEnvironment): CredentialCheck {
  if (lookup.ok) {
    const id: unknown = (lookup.account as { readonly id?: unknown } | null | undefined)?.id;
    if (typeof id !== "string" || !STRIPE_ACCOUNT_ID.test(id)) {
      return { outcome: "unavailable", errorMessage: "Stripe answered the account without an acct_ id." };
    }
    const livemode = livemodeOf(lookup.account);
    if (livemode !== undefined && livemode !== (environment === "live")) {
      return {
        outcome: "rejected",
        errorCode: STRIPE_LIVEMODE_MISMATCH,
        errorMessage: `Stripe answered for its ${livemode ? "live" : "test"} mode, but the connection is the ${environment} environment's.`,
      };
    }
    return { outcome: "verified", result: { accountId: id } };
  }
  const summary = stripeConnectFailureOf("accounts.retrieve", lookup.error).summary;
  if (lookup.error instanceof Stripe.errors.StripeAuthenticationError) {
    return {
      outcome: "rejected",
      errorCode: STRIPE_KEY_INVALID,
      errorMessage: `Stripe refused the secret key (${summary}). Enter a current secret or restricted key of the account.`,
    };
  }
  if (lookup.error instanceof Stripe.errors.StripePermissionError) {
    return {
      outcome: "rejected",
      errorCode: STRIPE_KEY_INVALID,
      errorMessage: `Stripe refused the key access to the account (${summary}). Use the secret key, or a restricted key with the permissions the payments page lists.`,
    };
  }
  return { outcome: "unavailable", errorMessage: `Stripe could not verify the key (${summary}).` };
}

/**
 * The refusal of stored keys that break the submission rules before any Stripe call (see the file header), or
 * `undefined` when they meet them.
 */
export function storedKeysProblem(
  data: StripeApiKeysPublicData,
  secrets: { readonly secret: string; readonly webhookSecret?: string },
  environment: PaymentEnvironment,
): CredentialCheck | undefined {
  const secretMode = keyModeOf(secrets.secret);
  if (secretMode === undefined || !SECRET_KEY.test(secrets.secret)) {
    return {
      outcome: "rejected",
      errorCode: STRIPE_KEY_INVALID,
      errorMessage: "The secret key is not a Stripe secret (sk_) or restricted (rk_) key.",
    };
  }
  const publishableMode = keyModeOf(data.publishableKey);
  if (secretMode !== environment || publishableMode !== environment) {
    return {
      outcome: "rejected",
      errorCode: STRIPE_LIVEMODE_MISMATCH,
      errorMessage: `The keys must be keys of Stripe's ${environment} mode, the connection's environment.`,
    };
  }
  if (secrets.webhookSecret === undefined || !STRIPE_WEBHOOK_SECRET_PATTERN.test(secrets.webhookSecret)) {
    return {
      outcome: "rejected",
      errorCode: STRIPE_KEY_INVALID,
      errorMessage: "The webhook signing secret is not a whsec_ secret of the endpoint.",
    };
  }
  return undefined;
}

/** The connection's values in the audit row: id, mode, account, publishable key, status, version; never a secret. */
function auditValuesOf(row: PaymentConnectionView): Record<string, unknown> {
  return {
    connectionId: row.id,
    accountMode: row.account_mode,
    accountReference: row.account_reference,
    publishableKey: row.publishable_key,
    connectionStatus: row.status,
    version: row.version,
  };
}

@Injectable()
export class StripeApiKeysVerifier implements CredentialVerifier, OnModuleInit {
  constructor(
    private readonly verifiers: CredentialVerifiers,
    private readonly stripe: StripeClient,
    private readonly connections: PaymentConnectionsRepository,
    private readonly envelope: EnvelopeService,
    private readonly invalidations: InvalidationPublisher,
  ) {}

  /** Registers this verifier for `stripe_api_keys` in the worker's one registry (PBE-052). */
  onModuleInit(): void {
    this.verifiers.register("stripe_api_keys", this);
  }

  /** The stored keys' rules, then `GET /v1/account` with the secret key, outside any transaction (file header). */
  async check(input: CredentialCheckInput): Promise<CredentialCheck> {
    const data = stripeApiKeysPublicDataOf(input.publicData);
    const environment = input.environment;
    const problem = storedKeysProblem(data, input.secrets, environment);
    if (problem !== undefined) {
      return problem;
    }
    let lookup: AccountLookup;
    try {
      lookup = {
        ok: true,
        account: await this.stripe.withKey(input.secrets.secret).accounts.retrieveCurrent(),
      };
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeError)) {
        // Not Stripe's answer: the processor retries the attempt (and logs the error's name, the secrets scrubbed).
        throw error;
      }
      lookup = { ok: false, error };
    }
    return stripeKeyCheckOf(lookup, environment);
  }

  /** The switch of the connection in the job's transaction (see the file header). */
  async apply(trx: PlatformTransaction, input: CredentialApplyInput): Promise<CredentialApplied> {
    const data = stripeApiKeysPublicDataOf(input.publicData);
    const { tenantId, environment, now } = input;
    const accountReference: unknown = (input.result as { readonly accountId?: unknown } | undefined)
      ?.accountId;
    if (typeof accountReference !== "string" || !STRIPE_ACCOUNT_ID.test(accountReference)) {
      throw new InvalidStripeApiKeysSubmissionError("the verified result has no acct_ id");
    }
    const webhookSecret = input.secrets.webhookSecret;
    if (webhookSecret === undefined) {
      throw new InvalidStripeApiKeysSubmissionError("the submission has no webhook secret");
    }

    const tenantStatus = await this.connections.tenantStatusForShare(trx, tenantId);
    if (tenantStatus !== "active") {
      throw new CredentialRejection(
        TENANT_NOT_ACTIVE,
        "The OTA is not active, so its payment connection cannot change. Submit the keys again once it is active.",
      );
    }
    const existing = await this.connections.lockForTenant(trx, tenantId, environment);
    if (existing !== undefined && disabledByAdmin(existing)) {
      throw new CredentialRejection(
        CONNECTION_DISABLED,
        "Velexis disabled this payment connection, so it cannot change. Contact Velexis support.",
      );
    }
    if (existing !== undefined && existing.id !== data.connectionId) {
      throw new CredentialRejection(
        CONNECTION_CHANGED,
        "The payment connection of this environment was created after the keys were submitted. Submit them again to get its webhook URL.",
      );
    }

    const connectionId = existing?.id ?? data.connectionId;
    const secret = await this.envelope.encrypt(input.secrets.secret, connectionSecretPlace(connectionId));
    const webhook = await this.envelope.encrypt(webhookSecret, connectionWebhookSecretPlace(connectionId));
    if (webhook.kekId !== secret.kekId) {
      // One encryption_key_id column wraps both: a KEK change between the two calls fails the attempt (retried).
      throw new Error("the two secrets were wrapped by different KEKs");
    }
    const write = {
      accountReference,
      publishableKey: data.publishableKey,
      secretCiphertext: secret.ciphertext,
      webhookSecretCiphertext: webhook.ciphertext,
      encryptionKeyId: secret.kekId,
      connectedByAccountId: input.submittedByAccountId,
      now,
    };
    let connection: PaymentConnectionView;
    if (existing === undefined) {
      const others = await this.connections.listForTenant(tenantId, trx);
      connection = await this.connections.insertApiKeys(trx, {
        ...write,
        id: connectionId,
        tenantId,
        environment,
        statementDescriptorSuffix:
          others.find((row) => row.environment === "test")?.statement_descriptor_suffix ?? null,
      });
    } else {
      connection = await this.connections.applyApiKeys(trx, existing.id, write);
    }

    this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
    return {
      before: existing === undefined ? { connectionId: null } : auditValuesOf(existing),
      after: auditValuesOf(connection),
      details: { connectionId: connection.id, connectionCreated: existing === undefined },
    };
  }
}
