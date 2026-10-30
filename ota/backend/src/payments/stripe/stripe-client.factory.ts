// The Stripe clients of the OTA backend (OADR-0010 point 1, ADR-0011 (A); OBE-038, OBE-077). Every `stripe` SDK client
// is created with:
//
//   apiVersion          STRIPE_API_VERSION, pinned here: an SDK upgrade never changes the API version silently
//   timeout             10 s per attempt
//   maxNetworkRetries   1 (safe: every POST of the gateway carries an idempotency key, OADR-0010 point 3)
//   telemetry           off (no request timings sent to Stripe)
//
// One code path serves the three account modes; what differs is data (`withAccount`, the StripeAccountTarget the
// gateway resolves from the tenant's connection or from a payment's recorded account):
//
//   account_mode       client                                             every request of the call adds
//   velexis            the Velexis client of the environment              nothing
//   connect_standard   the same Velexis client (STRIPE_SECRET_KEY_<ENV>)  Stripe-Account: <acct_…> (direct charges)
//   api_keys           a client made for this call with the connection's  nothing
//                      secret key, decrypted here and dropped after it
//
// `velexis` and `connect_standard` use the Velexis account's keys of the environment file (STRIPE_SECRET_KEY_<ENV>,
// STRIPE_PUBLISHABLE_KEY_<ENV>); an environment without both has no Velexis client, and its payments answer `424
// PAYMENT_PROVIDER_NOT_CONFIGURED` (stripe.gateway.ts). One Velexis client per environment is created on first use and
// kept for the process. The keys stay in this class: no getter returns the secret key, and nothing logs it.
//
// The live pair (STRIPE_SECRET_KEY_LIVE, STRIPE_PUBLISHABLE_KEY_LIVE) is therefore needed only once a live tenant
// (`storefront_environment = live`) uses `velexis` or `connect_standard` (OBE-081): nothing reads it at start-up, an
// `api_keys` target never touches it, so a process without it serves live tenants on their own accounts, and a live
// `velexis` or `connect_standard` tenant gets `424` and a storefront without a card method until it is filled in.
//
// `api_keys` (the OTA's own account): the connection row carries the secret key as the platform's envelope ciphertext
// (`platform.payment_provider_connections.secret_ciphertext`, associated data `platform.payment_provider_connections.
// secret_ciphertext:<ppc_id>`, ADR-0010), cached as base64 text like any connection row. `withAccount` decrypts it
// with the KEKs of MASTER_KEY_DIR (STRIPE_KEY_PROVIDER) when the call starts, checks that it is a secret or restricted
// key of the call's environment, creates a client with it for that call only and drops it when the call ends: the
// decrypted key is never cached, kept in a field, logged, queued or put into an error (a key that cannot be decrypted
// or is not a key of the environment is a `StripeAccountUnavailableError` naming the reason and the connection id
// only). A key the platform replaces therefore serves from the next read of the connection, at the latest 60 s later
// (the connection cache), at once after the platform's `connection` invalidation.
//
// Tests mock Stripe at the HTTP layer: a global module of the test provides STRIPE_API_ENDPOINT (a local fake of the
// Stripe API on 127.0.0.1), and every client then sends its requests there. Nothing in the application provides it,
// and a production process refuses to start with one, so no configuration can send Stripe traffic elsewhere.
import { Inject, Injectable, Optional, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { aadFor, decryptValue, LocalFileKeyProvider, type KeyProvider } from "@velexis/crypto";
import Stripe from "stripe";
import { STRIPE_KEY_PATTERNS, type ApiConfig } from "../../config";

/** The Stripe API version of every request (the version the installed `stripe` 18 SDK is typed for). */
export const STRIPE_API_VERSION = "2025-08-27.basil" satisfies Stripe.LatestApiVersion;

/** Per-attempt timeout of a Stripe request. */
export const STRIPE_TIMEOUT_MS = 10_000;

/** Network retries of the SDK (with the request's own idempotency key). */
export const STRIPE_MAX_NETWORK_RETRIES = 1;

/** Injection token of an optional `StripeApiEndpoint`: provided only by tests, never by the application. */
export const STRIPE_API_ENDPOINT = "STRIPE_API_ENDPOINT";

/** Injection token of the KEKs that decrypt an `api_keys` connection's secret key (MASTER_KEY_DIR). */
export const STRIPE_KEY_PROVIDER = "STRIPE_KEY_PROVIDER";

/**
 * The KEKs of MASTER_KEY_DIR, MASTER_KEY_CURRENT (ADR-0010, ADR-0026): the identical copies of the platform zone's
 * files, so the gateway decrypts the secret keys the platform encrypted. Nest awaits the factory, so neither process
 * starts without them (a `KeyProviderError` names the file, never its content). Every module that provides
 * `StripeClientFactory` provides this too.
 */
export const stripeKeyProvider: FactoryProvider<Promise<KeyProvider>> = {
  provide: STRIPE_KEY_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<ApiConfig, true>) =>
    LocalFileKeyProvider.fromDir(
      config.get("MASTER_KEY_DIR", { infer: true }),
      config.get("MASTER_KEY_CURRENT", { infer: true }),
    ),
};

/** Where a test's fake Stripe API listens. */
export interface StripeApiEndpoint {
  readonly host: string;
  readonly port: number;
  readonly protocol: "http" | "https";
}

/** The environments of a payment connection. */
export type StripeEnvironment = "test" | "live";

/**
 * The Stripe account a call is made on, and what reaches it: no secret (an `api_keys` target carries the ciphertext of
 * its connection's key, decrypted only by `withAccount`).
 */
export type StripeAccountTarget =
  | { readonly accountMode: "velexis"; readonly environment: StripeEnvironment }
  | {
      readonly accountMode: "connect_standard";
      readonly environment: StripeEnvironment;
      /** The OTA's connected account, sent as `Stripe-Account` on every request. */
      readonly accountReference: string;
    }
  | {
      readonly accountMode: "api_keys";
      readonly environment: StripeEnvironment;
      /** `ppc_…`: the row the ciphertext belongs to (its associated data). */
      readonly connectionId: string;
      /** base64 of `secret_ciphertext`. */
      readonly secretCiphertext: string;
    };

/**
 * What the requests of one call add to their own options (the idempotency key): `stripeAccount` (the `Stripe-Account`
 * header) in `connect_standard` mode, nothing otherwise.
 */
export type StripeRequestScope = Readonly<Pick<Stripe.RequestOptions, "stripeAccount">>;

/** Why `withAccount` cannot reach an account; with ids only. */
export type StripeAccountUnavailableReason = "no_velexis_keys" | "secret_unreadable" | "secret_key_invalid";

/** A target `withAccount` cannot reach: the reason and the connection id (an `api_keys` one), never a key. */
export class StripeAccountUnavailableError extends Error {
  override readonly name = "StripeAccountUnavailableError";

  constructor(
    readonly reason: StripeAccountUnavailableReason,
    readonly environment: StripeEnvironment,
    readonly connectionId: string | null,
  ) {
    const connection = connectionId === null ? "" : `, ${connectionId}`;
    super(`The Stripe account (${environment}${connection}) cannot be reached: ${reason}`);
  }
}

/** The associated data of an `api_keys` connection's secret key (ADR-0010). */
export function connectionSecretAad(connectionId: string): string {
  return aadFor("platform", "payment_provider_connections", "secret_ciphertext", connectionId);
}

/** The Velexis account's keys of one environment; the secret one never leaves this file. */
interface VelexisKeys {
  readonly secretKey: string;
  readonly publishableKey: string;
}

/** The options every client is created with (exported for the factory's test). */
export function stripeClientOptions(endpoint: StripeApiEndpoint | undefined): Stripe.StripeConfig {
  return {
    apiVersion: STRIPE_API_VERSION,
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    telemetry: false,
    appInfo: { name: "velexis-ota-backend" },
    ...(endpoint === undefined
      ? {}
      : { host: endpoint.host, port: endpoint.port, protocol: endpoint.protocol }),
  };
}

@Injectable()
export class StripeClientFactory {
  private readonly keys: Readonly<Record<StripeEnvironment, VelexisKeys | undefined>>;
  private readonly clients = new Map<StripeEnvironment, Stripe>();

  constructor(
    config: ConfigService<ApiConfig, true>,
    @Inject(STRIPE_KEY_PROVIDER) private readonly secretKeys: KeyProvider,
    @Optional() @Inject(STRIPE_API_ENDPOINT) private readonly endpoint?: StripeApiEndpoint,
  ) {
    if (endpoint !== undefined && config.get("APP_ENV", { infer: true }) === "production") {
      throw new Error("STRIPE_API_ENDPOINT is for tests only: a production process talks to Stripe itself");
    }
    const pair = (
      secretKey: string | undefined,
      publishableKey: string | undefined,
    ): VelexisKeys | undefined =>
      secretKey === undefined || publishableKey === undefined ? undefined : { secretKey, publishableKey };
    this.keys = Object.freeze({
      test: pair(
        config.get("STRIPE_SECRET_KEY_TEST", { infer: true }),
        config.get("STRIPE_PUBLISHABLE_KEY_TEST", { infer: true }),
      ),
      live: pair(
        config.get("STRIPE_SECRET_KEY_LIVE", { infer: true }),
        config.get("STRIPE_PUBLISHABLE_KEY_LIVE", { infer: true }),
      ),
    });
  }

  /** Whether the Velexis account has both keys of `environment`. */
  hasVelexisAccount(environment: StripeEnvironment): boolean {
    return this.keys[environment] !== undefined;
  }

  /** The Velexis account's publishable key of `environment` (safe in the browser), or `undefined`. */
  velexisPublishableKey(environment: StripeEnvironment): string | undefined {
    return this.keys[environment]?.publishableKey;
  }

  /** The client with the Velexis account's secret key of `environment`, or `undefined` without its keys. */
  velexisClient(environment: StripeEnvironment): Stripe | undefined {
    const keys = this.keys[environment];
    if (keys === undefined) {
      return undefined;
    }
    let client = this.clients.get(environment);
    if (client === undefined) {
      client = new Stripe(keys.secretKey, stripeClientOptions(this.endpoint));
      this.clients.set(environment, client);
    }
    return client;
  }

  /**
   * Runs `call` with the client of `target` and what every request of it adds to its options (the file header's
   * table). An `api_keys` connection's key is decrypted when the call starts and lives only in the client made for the
   * call, which nothing keeps after it. `StripeAccountUnavailableError` when the target cannot be reached; whatever
   * `call` throws passes through unchanged.
   */
  async withAccount<T>(
    target: StripeAccountTarget,
    call: (client: Stripe, scope: StripeRequestScope) => Promise<T>,
  ): Promise<T> {
    switch (target.accountMode) {
      case "velexis":
        return await call(this.requireVelexisClient(target.environment), {});
      case "connect_standard":
        return await call(this.requireVelexisClient(target.environment), {
          stripeAccount: target.accountReference,
        });
      case "api_keys":
        return await call(await this.connectionClient(target), {});
    }
  }

  private requireVelexisClient(environment: StripeEnvironment): Stripe {
    const client = this.velexisClient(environment);
    if (client === undefined) {
      throw new StripeAccountUnavailableError("no_velexis_keys", environment, null);
    }
    return client;
  }

  /** A client of one call with the decrypted key of an `api_keys` connection. */
  private async connectionClient(
    target: Extract<StripeAccountTarget, { accountMode: "api_keys" }>,
  ): Promise<Stripe> {
    let plaintext: Buffer;
    try {
      plaintext = await decryptValue(Buffer.from(target.secretCiphertext, "base64"), {
        aad: connectionSecretAad(target.connectionId),
        keys: this.secretKeys,
      });
    } catch {
      // Never the error itself: what failed is enough (a missing KEK, another row's ciphertext, a damaged value).
      throw new StripeAccountUnavailableError("secret_unreadable", target.environment, target.connectionId);
    }
    let secretKey: string;
    try {
      secretKey = plaintext.toString("utf8");
    } finally {
      plaintext.fill(0);
    }
    if (!STRIPE_KEY_PATTERNS.secret[target.environment].test(secretKey)) {
      throw new StripeAccountUnavailableError("secret_key_invalid", target.environment, target.connectionId);
    }
    return new Stripe(secretKey, stripeClientOptions(this.endpoint));
  }
}
