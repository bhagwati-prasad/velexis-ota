// The Stripe clients of the OTA backend (OADR-0010 point 1, ADR-0011 (A); OBE-038). One `stripe` SDK client per
// environment and key, created on first use and kept for the process, always with:
//
//   apiVersion          STRIPE_API_VERSION, pinned here: an SDK upgrade never changes the API version silently
//   timeout             10 s per attempt
//   maxNetworkRetries   1 (safe: every POST of the gateway carries an idempotency key, OADR-0010 point 3)
//   telemetry           off (no request timings sent to Stripe)
//
// `velexis` mode uses the Velexis account's keys of the environment file (STRIPE_SECRET_KEY_<ENV>,
// STRIPE_PUBLISHABLE_KEY_<ENV>); an environment without both has no Velexis client, and its payments answer `424
// PAYMENT_PROVIDER_NOT_CONFIGURED` (stripe.gateway.ts). The keys stay in this class: no getter returns the secret key,
// and nothing logs it. `connect_standard` (the Velexis key with `Stripe-Account`) and `api_keys` (the OTA's decrypted
// key) join in M5 (OBE-077).
//
// Tests mock Stripe at the HTTP layer: a global module of the test provides STRIPE_API_ENDPOINT (a local fake of the
// Stripe API on 127.0.0.1), and every client then sends its requests there. Nothing in the application provides it,
// and a production process refuses to start with one, so no configuration can send Stripe traffic elsewhere.
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import type { ApiConfig } from "../../config";

/** The Stripe API version of every request (the version the installed `stripe` 18 SDK is typed for). */
export const STRIPE_API_VERSION = "2025-08-27.basil" satisfies Stripe.LatestApiVersion;

/** Per-attempt timeout of a Stripe request. */
export const STRIPE_TIMEOUT_MS = 10_000;

/** Network retries of the SDK (with the request's own idempotency key). */
export const STRIPE_MAX_NETWORK_RETRIES = 1;

/** Injection token of an optional `StripeApiEndpoint`: provided only by tests, never by the application. */
export const STRIPE_API_ENDPOINT = "STRIPE_API_ENDPOINT";

/** Where a test's fake Stripe API listens. */
export interface StripeApiEndpoint {
  readonly host: string;
  readonly port: number;
  readonly protocol: "http" | "https";
}

/** The environments of a payment connection. */
export type StripeEnvironment = "test" | "live";

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
}
