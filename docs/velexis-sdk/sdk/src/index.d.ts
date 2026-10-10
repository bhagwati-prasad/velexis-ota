/**
 * @velexis/ota-sdk — JavaScript SDK for building OTA storefronts and consoles on Velexis.
 *
 * ```ts
 * import { createVelexisClient } from "@velexis/ota-sdk";
 *
 * // Browser / client components: publishable key, customer scope only.
 * const velexis = createVelexisClient({ publishableKey: process.env.NEXT_PUBLIC_VELEXIS_PK! });
 *
 * // Server (server components, route handlers, server actions): secret key + the user's token.
 * const server = createVelexisClient({ secretKey: process.env.VELEXIS_SK!, accessToken: () => getTokenFromCookie() });
 * ```
 *
 * For Next.js prefer the helpers in `@velexis/ota-sdk/next` (cookie-based sessions, server client, middleware)
 * and the optional hooks in `@velexis/ota-sdk/react`.
 */
import type { VelexisClientOptions } from "./shared";
import type { StorefrontApi, AuthApi, AccountApi, ReferenceApi } from "./identity";
import type { FlightsApi } from "./flights";
import type { CheckoutApi, BookingsApi } from "./bookings";
import type { ConsoleApi } from "./console";

export * from "./shared";
export * from "./identity";
export * from "./flights";
export * from "./bookings";
export * from "./console";

/** HTTP methods accepted by {@link VelexisClient.request}. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A configured Velexis client. All namespaces share the client's keys, tokens and defaults. */
export interface VelexisClient {
  /** Storefront bootstrap (branding, locales, currencies, features, payment provider public config). */
  readonly storefront: StorefrontApi;
  /** Customer sign-up, sign-in, sessions, email verification, password reset. */
  readonly auth: AuthApi;
  /** Signed-in customer's profile, preferences and saved travellers. */
  readonly account: AccountApi;
  /** Airports, cities, airlines, countries, currencies (platform reference data). */
  readonly reference: ReferenceApi;
  /** Flight search, availability, offer details, branded-fare upsell, pricing, fare rules, ancillary options. */
  readonly flights: FlightsApi;
  /** Checkout session: travellers, contacts, ancillaries, payment, completion (creates the booking). */
  readonly checkout: CheckoutApi;
  /** Customer bookings: list (upcoming / past / cancelled), detail, guest lookup, changes, cancellation, documents. */
  readonly bookings: BookingsApi;
  /** Staff console (secret key or staff token): all bookings, PNR lookup, order management, issuance, queues, raw Amadeus access. */
  readonly console: ConsoleApi;
  /** A new client with some options replaced (e.g. a per-request access token on the server). */
  withOptions(overrides: Partial<VelexisClientOptions>): VelexisClient;
  /** Low-level escape hatch for endpoints that are not wrapped yet. Applies keys, tokens, retries and error mapping. */
  request<T = unknown>(method: HttpMethod, path: string, init?: { query?: Record<string, string | number | boolean | string[] | undefined>; body?: unknown; options?: import("./shared").RequestOptions }): Promise<T>;
}

/** Create a client. Pass `publishableKey` in browser code and `secretKey` only on the server. */
export declare function createVelexisClient(options: VelexisClientOptions): VelexisClient;

/** SDK version. */
export declare const VERSION: string;
