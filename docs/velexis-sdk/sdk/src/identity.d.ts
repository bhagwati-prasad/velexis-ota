/**
 * @velexis/ota-sdk — Storefront, customer identity, account and reference data (area B1).
 *
 * Namespaces: `storefront` ({@link StorefrontApi}), `auth` ({@link AuthApi}), `account` ({@link AccountApi}),
 * `reference` ({@link ReferenceApi}). None of these methods calls Amadeus: storefront settings, customers and
 * saved travellers live in the OTA's own tenant schema, reference data in the shared `reference` schema.
 *
 * Keys and tokens:
 * - Publishable key (`pk_…`): every method here may be called with it, including from client components,
 *   but methods that return tokens (`auth.signIn`, `auth.signUp`, `auth.refresh`, `auth.resetPassword`,
 *   `auth.changePassword`) should run in server actions / route handlers so the refresh token goes straight into an
 *   httpOnly cookie and never reaches browser JavaScript.
 * - Customer access token (`customerAuth`): required by `auth.getSession`, `auth.changePassword` and every
 *   `account.*` method. Configure `accessToken` / `refreshToken` on the client (see `@velexis/ota-sdk/next`) and the
 *   SDK refreshes an expired token once and retries.
 * - Hosting key (`hk_test_…` / `hk_live_…`, client option `hostingKey`): one server-only key for a Next.js deployment
 *   that serves several OTA domains. Every call then needs the storefront host (client option `host` or
 *   `options.host`, sent as `X-Velexis-Host`) and acts as that OTA's secret key. Resolve hosts with
 *   {@link StorefrontApi.resolve}.
 *
 * End user on server calls: when your server calls on behalf of a visitor with a secret or hosting key (server
 * actions, route handlers, server components, middleware), pass the visitor's IP and user agent as `options.endUser`
 * (or the client option `endUser`). The SDK sends them as `X-Velexis-End-User-IP` / `X-Velexis-End-User-Agent`; the API
 * honours them for secret and hosting keys only and uses them for per-IP rate limits, sign-in lockouts and session
 * metadata. Without them every visitor shares your server's IP limits.
 *
 * Errors are thrown as subclasses of {@link VelexisError} (see `./shared`); `error.code` holds the public code.
 */
import type {
  Schemas,
  RequestOptions,
  Page,
  ListParams,
  WithWarnings,
  Money,
  VelexisError,
  ValidationError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServerError,
  ConnectionError,
} from "./shared";

/* ------------------------------------------------------------------------------------------------
 * End user, hosting key and storefront host (request and client options)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The visitor on whose behalf your server makes a call. Sent as `X-Velexis-End-User-IP` / `X-Velexis-End-User-Agent`;
 * honoured by the API for secret (`sk_…`) and hosting (`hk_…`) keys only (ignored for publishable keys, whose calls come
 * from the visitor's browser). Used for per-IP rate limits (sign-up, sign-in, verification and reset emails, reference
 * autocomplete, guest booking lookup), sign-in lockouts and session metadata (`AuthSessionDetails.userAgent` / `ipCountry`).
 */
export interface EndUserContext {
  /** Visitor IP (IPv4 or IPv6), e.g. the first entry of `x-forwarded-for` set by your own hosting proxy. Invalid values are ignored. */
  ip?: string;
  /** Visitor's `User-Agent` (truncated to 512 characters). */
  userAgent?: string;
}

/** Client-level end-user source: a fixed context or a function called before every request (e.g. reading `headers()`). */
export type EndUserSource =
  | EndUserContext
  | (() => EndUserContext | null | undefined | Promise<EndUserContext | null | undefined>);

declare module "./shared" {
  interface RequestOptions {
    /**
     * The visitor this server-side call is made for (`X-Velexis-End-User-IP` / `X-Velexis-End-User-Agent`). Overrides the
     * client option `endUser`. Honoured for secret and hosting keys only.
     */
    endUser?: EndUserContext;
    /**
     * Storefront host this call is made for (`X-Velexis-Host`, lower case, no port). Required for every call made with a
     * hosting key (overrides the client option `host`); optional with secret/publishable keys, where it must be a verified
     * domain of the key's OTA. Errors: `HOST_NOT_ALLOWED` (403).
     */
    host?: string;
  }
  interface VelexisClientOptions {
    /**
     * Hosting key (`hk_test_…` / `hk_live_…`): server-only key for one deployment serving several OTA domains, created in
     * the Velexis portal for the OTAs you administer. Sent as `X-Api-Key`; combine with `host` (per client or per call).
     * Never ship it to the browser.
     */
    hostingKey?: string;
    /** Default storefront host for every call (`X-Velexis-Host`); typically set per request from the `Host` header. */
    host?: string;
    /** Default end user for every call (server code acting for a visitor), e.g. `() => endUserFromHeaders()`. */
    endUser?: EndUserSource;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Parameter types
 * ---------------------------------------------------------------------------------------------- */

/** Params of {@link StorefrontApi.get}. */
export interface StorefrontGetParams {
  /** Locale for localised texts (SEO, consent categories); shortcut for `options.locale` / `Accept-Language`. */
  locale?: string;
}

/** Params of {@link StorefrontApi.resolve}. */
export interface StorefrontResolveParams {
  /** Host of the visitor's request (the `Host` header); upper case, a port and a trailing dot are tolerated. */
  host: string;
}

/** Params of {@link AuthApi.getSession} (none). */
export type AuthGetSessionParams = Record<string, never>;

/** Params of {@link AccountApi.get} (none). */
export type AccountGetParams = Record<string, never>;

/** Params of {@link AccountPreferencesApi.get} (none). */
export type AccountPreferencesGetParams = Record<string, never>;

/**
 * Optimistic-concurrency precondition sent as `If-Match`.
 * Pass the resource's `version` (number, sent as `"<version>"`) or the raw `ETag` string of the last read.
 */
export interface AccountIfMatch {
  ifMatch: string | number;
}

/** Params of {@link AccountApi.update}: the fields to change plus `ifMatch`. */
export type AccountUpdateParams = Schemas["CustomerUpdateRequest"] & AccountIfMatch;

/** Params of {@link AccountPreferencesApi.update}: the preferences to change plus `ifMatch`. */
export type AccountPreferencesUpdateParams = Schemas["CustomerPreferencesUpdateRequest"] & AccountIfMatch;

/** Params of {@link AccountDataExportsApi.get}. */
export interface AccountDataExportGetParams {
  /** Data export id (`dex_…`). */
  dataExportId: string;
}

/** Params of {@link AccountSavedTravelersApi.list}. */
export type SavedTravelerListParams = ListParams;

/** Params of {@link AccountSavedTravelersApi.get} and {@link AccountSavedTravelersApi.delete}. */
export interface SavedTravelerRefParams {
  /** Saved traveller id (`trv_…`). */
  savedTravelerId: string;
}

/** Params of {@link AccountSavedTravelersApi.update}: id + `ifMatch` + the fields to change (lists replace the stored lists). */
export type SavedTravelerUpdateParams = Schemas["SavedTravelerUpdateRequest"] & SavedTravelerRefParams & AccountIfMatch;

/** Location sub-types accepted by {@link ReferenceLocationsApi.search} (same values as Amadeus `AmadeusLocationSubtype`). */
export type LocationSubType = "AIRPORT" | "CITY";

/** Params of {@link ReferenceLocationsApi.search}. */
export interface LocationSearchParams extends ListParams {
  /** Text typed by the user (2–50 characters): IATA code, airport or city name. */
  keyword: string;
  /** Restrict to airports and/or cities. Default both. Sent as `subType=AIRPORT,CITY`. */
  subType?: LocationSubType[];
  /** Restrict to one country (ISO 3166-1 alpha-2). */
  countryCode?: string;
}

/** Params of {@link ReferenceAirportsApi.get}. */
export interface AirportGetParams {
  /** 3-letter IATA airport code, e.g. `"LHR"`. */
  iataCode: string;
}

/** Params of {@link ReferenceAirlinesApi.list}. */
export interface AirlineListParams extends ListParams {
  /** IATA designators to resolve (max 100), e.g. `["BA", "U2"]`. Omit to page through all active airlines. */
  iataCodes?: string[];
}

/** Params of {@link ReferenceAirlinesApi.get}. */
export interface AirlineGetParams {
  /** 2-character IATA airline designator, e.g. `"BA"`. */
  iataCode: string;
}

/** Params of {@link ReferenceCountriesApi.list}. */
export type CountryListParams = ListParams;

/** Params of {@link ReferenceCurrenciesApi.list}. */
export type CurrencyListParams = ListParams;

/* ------------------------------------------------------------------------------------------------
 * storefront
 * ---------------------------------------------------------------------------------------------- */

/** `client.storefront` — public bootstrap configuration of the OTA's storefront, and host → OTA resolution. */
export interface StorefrontApi {
  /**
   * Get the storefront bootstrap configuration: OTA name, branding (logo/colour/font URLs), verified storefront
   * `domains`, locales, currencies and markets with defaults, enabled features (`guestCheckout`, `customerAccounts`,
   * `savedTravelers`, `ancillaries`, `seatSelection`, `brandedFareUpsell`, `autoIssue`), payment provider public config,
   * legal links and versions, support contact, consent requirements, auth policy and SEO defaults.
   *
   * `payment` matches what checkout accepts: `provider` uses the `Payment.provider` ids (`stripe`, `adyen`,
   * `checkout_com`, `paypal`), `supportedMethods` are exactly the `method` values of `checkout.createPayment`, and
   * `cardBrands` are Amadeus payment brands (`VISA`, `AMERICAN_EXPRESS`, …) to send as `card.brand` /
   * `payments[].brand`; `pspCardBrands` gives the provider's own name of each brand for its card element.
   *
   * - **HTTP:** `GET /v1/storefront`
   * - **Amadeus:** none.
   * - **Key/token:** publishable or secret key (or a hosting key + `host`); no user token. Contains no secrets.
   * - **Where:** anywhere — server components (recommended, in the root layout), route handlers, middleware, client components.
   * - **Next.js caching:** cacheable. Use `{ next: { revalidate: 300, tags: ["velexis:storefront"] } }`: Velexis sends no
   *   change notification (no webhook), so settings edits appear within the revalidation window; call
   *   `revalidateTag("velexis:storefront")` yourself (e.g. from an admin-only route handler protected by your own secret)
   *   when an edit must show at once. The API sends `ETag` and `Cache-Control: public, max-age=60, stale-while-revalidate=600`.
   *
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {PermissionError} `TENANT_SUSPENDED` (render a maintenance page), `ORIGIN_NOT_ALLOWED` (browser origin not allow-listed for the publishable key), `HOST_NOT_ALLOWED` (hosting key without a valid `host`).
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // app/layout.tsx (server component)
   * import { velexis } from "@/lib/velexis";
   * export async function generateMetadata() {
   *   const sf = await velexis.storefront.get({}, { next: { revalidate: 300, tags: ["velexis:storefront"] } });
   *   return { title: { template: sf.seo.titleTemplate, default: sf.seo.defaultTitle }, description: sf.seo.defaultDescription };
   * }
   * export default async function RootLayout({ children }: { children: React.ReactNode }) {
   *   const sf = await velexis.storefront.get({}, { next: { revalidate: 300, tags: ["velexis:storefront"] } });
   *   return (
   *     <html lang={sf.defaultLocale} style={{ ["--brand" as string]: sf.branding.colors.primary }}>
   *       <body>{children}</body>
   *     </html>
   *   );
   * }
   */
  get(params?: StorefrontGetParams, options?: RequestOptions): Promise<Schemas["StorefrontConfig"]>;

  /**
   * Resolve a storefront host name to its OTA, for **one Next.js deployment serving several OTA domains**. Returns the
   * OTA's `tenantKey` and `tenantStatus`, the key's `environment`, the matched and all verified storefront `domains`
   * (redirect secondary hosts to `primaryUrl`), the OTA's custom `apiBaseUrl` (or null) and its storefront
   * `publishableKey` for the browser client on that host. Cache the answer for `cacheTtlSeconds`. Then make every call
   * for that host with the same hosting key plus `host` (client option or `options.host`): the API treats it as the
   * OTA's secret key.
   *
   * - **HTTP:** `GET /v1/storefront/resolve?host=` (`Cache-Control: private, max-age=300`)
   * - **Amadeus:** none. **Tables:** platform.tenant_domains, platform.tenants, platform.api_keys (no tenant tables).
   * - **Key/token:** hosting key (`hk_…`, resolves the hosts of every OTA it is granted for) or an OTA's secret key (its
   *   own hosts only). Publishable keys → `SCOPE_NOT_ALLOWED`.
   * - **Where:** middleware or server code only (the key is a secret).
   * - **Next.js caching:** keep an in-memory / edge KV cache keyed by host (`cacheTtlSeconds`, 300).
   *
   * @throws {NotFoundError} `NOT_FOUND` — unknown or unverified host, or an OTA the key may not act for (answer 404).
   * @throws {ValidationError} `VALIDATION_FAILED` (malformed host).
   * @throws {PermissionError} `SCOPE_NOT_ALLOWED` (publishable key).
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // lib/tenants.ts — server only; one hosting key per environment instead of every OTA's secret key
   * import { createVelexisClient, isVelexisError, type Schemas } from "@velexis/ota-sdk";
   * const platform = createVelexisClient({ hostingKey: process.env.VELEXIS_HOSTING_KEY! });
   * const cache = new Map<string, { at: number; value: Schemas["StorefrontHostResolution"] | null }>();
   * export async function resolveHost(host: string) {
   *   const hit = cache.get(host);
   *   if (hit && Date.now() - hit.at < 300_000) return hit.value;
   *   const value = await platform.storefront.resolve({ host }).catch((e) => (isVelexisError(e, "NOT_FOUND") ? null : Promise.reject(e)));
   *   cache.set(host, { at: Date.now(), value });
   *   return value;
   * }
   * // per request: const v = platform.withOptions({ host: resolved.host }); await v.storefront.get();
   */
  resolve(params: StorefrontResolveParams, options?: RequestOptions): Promise<Schemas["StorefrontHostResolution"]>;
}

/* ------------------------------------------------------------------------------------------------
 * auth
 * ---------------------------------------------------------------------------------------------- */

/** `client.auth` — customer sign-up, email verification, sessions and passwords. */
export interface AuthApi {
  /**
   * Create a customer account with email, password, name and marketing consent; records terms acceptance and queues
   * a verification email. Returns the customer, a session (null when the OTA requires verification before sign-in,
   * `storefront.auth.emailVerification === "required_before_sign_in"`) and the verification state.
   *
   * - **HTTP:** `POST /v1/auth/sign-up` (201, `Idempotency-Key` generated by the SDK when omitted)
   * - **Amadeus:** none. **Tenant tables:** customers, customer_identities, customer_preferences, customer_consents, customer_sessions, notifications.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** a server action or route handler (the result contains tokens — put them into httpOnly cookies).
   * - **Next.js caching:** never cached (POST).
   *
   * @throws {ValidationError} `VALIDATION_FAILED` (see `fieldErrors`, e.g. `/email`, outdated `/termsVersion`), `PASSWORD_TOO_WEAK` (422, `details.violations`).
   * @throws {ConflictError} `EMAIL_ALREADY_REGISTERED` (offer sign-in / password reset), `IDEMPOTENCY_KEY_REUSED`.
   * @throws {PermissionError} `FEATURE_DISABLED` (customer accounts off), `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {RateLimitError} `RATE_LIMITED` (5 sign-ups per hour per end-user IP and per email — pass `options.endUser` from server code).
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // app/(auth)/sign-up/actions.ts
   * "use server";
   * import { redirect } from "next/navigation";
   * import { velexis, setSessionCookies, endUserFromHeaders } from "@/lib/velexis";
   * import { isVelexisError } from "@velexis/ota-sdk";
   * export async function signUpAction(_: unknown, form: FormData) {
   *   try {
   *     const res = await velexis.auth.signUp({
   *       email: String(form.get("email")), password: String(form.get("password")),
   *       firstName: String(form.get("firstName")), lastName: String(form.get("lastName")),
   *       marketingConsent: form.get("marketing") === "on", termsVersion: String(form.get("termsVersion")),
   *     }, { endUser: await endUserFromHeaders() });
   *     if (res.session) await setSessionCookies(res.session);
   *   } catch (e) {
   *     if (isVelexisError(e, "EMAIL_ALREADY_REGISTERED")) return { error: "You already have an account. Sign in instead." };
   *     if (isVelexisError(e, "PASSWORD_TOO_WEAK")) return { error: e.message };
   *     throw e;
   *   }
   *   redirect("/sign-up/check-email");
   * }
   */
  signUp(params: Schemas["SignUpRequest"], options?: RequestOptions): Promise<Schemas["AuthSignUpResult"]>;

  /**
   * Confirm an email address with the one-time token from the verification link (first verification or a pending
   * email change). Attaches earlier guest bookings with the same email to the account. Does not create a session.
   *
   * - **HTTP:** `POST /v1/auth/email-verification/confirm`
   * - **Amadeus:** none. **Tenant tables:** customer_identities, customers, bookings, booking_events.
   * - **Key/token:** publishable or secret key; anonymous (the token is the proof).
   * - **Where:** the server component / server action of the page the email links to (`/verify-email?token=…`).
   * - **Next.js caching:** never cached.
   *
   * @throws {ValidationError} `VERIFICATION_TOKEN_INVALID` (`details.reason`: `unknown` | `used` | `expired` — offer {@link AuthApi.resendVerification}), `VALIDATION_FAILED`.
   * @throws {ConflictError} `EMAIL_ALREADY_REGISTERED` (new address taken meanwhile), `IDEMPOTENCY_KEY_REUSED`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // app/verify-email/page.tsx
   * export default async function VerifyEmail({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
   *   const { token } = await searchParams;
   *   try {
   *     const r = await velexis.auth.verifyEmail({ token: token ?? "" });
   *     return <p>Thanks — {r.verifiedEmail} is confirmed. <a href={r.returnPath ?? "/"}>Continue</a></p>;
   *   } catch (e) {
   *     if (isVelexisError(e, "VERIFICATION_TOKEN_INVALID")) return <ResendVerificationForm />;
   *     throw e;
   *   }
   * }
   */
  verifyEmail(params: Schemas["EmailVerificationConfirmRequest"], options?: RequestOptions): Promise<Schemas["EmailVerificationResult"]>;

  /**
   * Send a new verification email. Signed in: omit `email` (goes to the unverified or pending address). Anonymous:
   * pass `email`. Always resolves with the same `accepted` result (no account enumeration).
   *
   * - **HTTP:** `POST /v1/auth/email-verification/resend` (202)
   * - **Amadeus:** none. **Tenant tables:** customers, customer_identities, notifications.
   * - **Key/token:** publishable or secret key; customer token optional.
   * - **Where:** server action or client component (no tokens in the response).
   * - **Next.js caching:** never cached.
   *
   * @throws {ValidationError} `VALIDATION_FAILED` (email missing when anonymous).
   * @throws {AuthenticationError} `INVALID_API_KEY`, `TOKEN_EXPIRED`.
   * @throws {PermissionError} `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {RateLimitError} `RATE_LIMITED` (20 per hour per end-user IP — pass `options.endUser` from server code).
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function resendAction(form: FormData) {
   *   await velexis.auth.resendVerification({ email: String(form.get("email")), returnPath: "/account" }, { endUser: await endUserFromHeaders() });
   * }
   */
  resendVerification(params: Schemas["EmailVerificationResendRequest"], options?: RequestOptions): Promise<Schemas["AuthAcceptedResult"]>;

  /**
   * Sign in with email and password. Returns a session (15-minute access token, rotating refresh token valid 30 days
   * with `rememberMe`, else 12 hours) and the customer.
   *
   * - **HTTP:** `POST /v1/auth/sign-in`
   * - **Amadeus:** none. **Tenant tables:** customers, customer_identities, customer_sessions.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** server action or route handler only — store `session.accessToken` / `session.refreshToken` in httpOnly,
   *   Secure, SameSite=Lax cookies (`@velexis/ota-sdk/next` does this); never expose the refresh token to client JS.
   * - **Next.js caching:** never cached.
   *
   * @throws {AuthenticationError} `INVALID_CREDENTIALS` (`details.remainingAttempts`), `INVALID_API_KEY`.
   * @throws {PermissionError} `EMAIL_NOT_VERIFIED` (a fresh link was sent; `details.verificationSentTo`), `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {VelexisError} `ACCOUNT_LOCKED` (423; `details.lockedUntil`, offer password reset).
   * @throws {ValidationError} `VALIDATION_FAILED`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {RateLimitError} `RATE_LIMITED` (`retryAfterSeconds`; 20 attempts/min per end-user IP — pass `options.endUser`
   *   from server code, otherwise lockout counters and limits apply to your server's IP and one visitor throttles all).
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // app/(auth)/sign-in/actions.ts
   * "use server";
   * export async function signInAction(_: unknown, form: FormData) {
   *   try {
   *     const { session } = await velexis.auth.signIn({
   *       email: String(form.get("email")), password: String(form.get("password")), rememberMe: form.get("remember") === "on",
   *     }, { endUser: await endUserFromHeaders() }); // rememberMe is optional (default true)
   *     await setSessionCookies(session);
   *   } catch (e) {
   *     if (isVelexisError(e, "INVALID_CREDENTIALS")) return { error: "Email or password is wrong." };
   *     if (isVelexisError(e, "ACCOUNT_LOCKED")) return { error: e.message };
   *     if (isVelexisError(e, "EMAIL_NOT_VERIFIED")) return { error: "Please confirm your email — we sent you a new link." };
   *     throw e;
   *   }
   *   redirect(String(form.get("next") ?? "/account"));
   * }
   */
  signIn(params: Schemas["SignInRequest"], options?: RequestOptions): Promise<Schemas["AuthSessionResult"]>;

  /**
   * Exchange the refresh token for a new access + refresh token pair (rotation: the old refresh token stops working).
   * Returns `{ session, customer }` — the same `AuthSessionResult` shape as {@link AuthApi.signIn} and
   * {@link AuthApi.changePassword} (and like `console.auth.refresh`, a wrapper around the session), so shared refresh code
   * reads `result.session` everywhere; the SDK's automatic refresh passes `result.session` to `onSessionRefreshed`.
   * Usually called by the SDK itself when `refreshToken` is configured on the client and a call fails with
   * `TOKEN_EXPIRED`, and by the `@velexis/ota-sdk/next` middleware shortly before the access token expires.
   * Concurrent refreshes with the same token within 10 seconds receive the same new pair.
   *
   * - **HTTP:** `POST /v1/auth/refresh`
   * - **Amadeus:** none. **Tenant tables:** customer_sessions, customers, customer_identities.
   * - **Key/token:** publishable or secret key; the refresh token is in the body.
   * - **Where:** middleware, route handlers, server actions — never client components.
   * - **Next.js caching:** never cached.
   *
   * @throws {AuthenticationError} `REFRESH_TOKEN_INVALID` (expired/revoked), `REFRESH_TOKEN_REUSED` (all sessions of the family revoked) — clear cookies and redirect to sign-in; `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {ValidationError} `VALIDATION_FAILED`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // middleware.ts (edge)
   * const rt = req.cookies.get("vx_rt")?.value;
   * if (rt && accessTokenExpiresSoon(req)) {
   *   const { session: s } = await velexis.auth.refresh({ refreshToken: rt });
   *   const res = NextResponse.next();
   *   res.cookies.set("vx_at", s.accessToken, { httpOnly: true, secure: true, sameSite: "lax", expires: new Date(s.accessTokenExpiresAt) });
   *   res.cookies.set("vx_rt", s.refreshToken, { httpOnly: true, secure: true, sameSite: "lax", expires: new Date(s.refreshTokenExpiresAt) });
   *   return res;
   * }
   */
  refresh(params: Schemas["AuthRefreshRequest"], options?: RequestOptions): Promise<Schemas["AuthSessionResult"]>;

  /**
   * Sign out of the current session (`scope` optional, default `"current"`) or of all sessions (`scope: "all"`). Revoked
   * sessions stop working immediately. Pass `refreshToken` when the access token may already have expired.
   *
   * - **HTTP:** `POST /v1/auth/sign-out` (204)
   * - **Amadeus:** none. **Tenant tables:** customer_sessions.
   * - **Key/token:** customer token, or key only with `refreshToken` in the params.
   * - **Where:** server action / route handler (then delete the cookies).
   * - **Next.js caching:** never cached.
   *
   * @throws {AuthenticationError} `UNAUTHENTICATED` (neither token nor refresh token), `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {ValidationError} `VALIDATION_FAILED`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function signOutAction() {
   *   const jar = await cookies();
   *   await velexis.auth.signOut({ scope: "current", refreshToken: jar.get("vx_rt")?.value }).catch(() => undefined);
   *   jar.delete("vx_at"); jar.delete("vx_rt");
   *   redirect("/");
   * }
   */
  signOut(params?: Schemas["AuthSignOutRequest"], options?: RequestOptions): Promise<void>;

  /**
   * Request a password-reset email (link valid 60 minutes). Always resolves with the same `accepted` result.
   *
   * - **HTTP:** `POST /v1/auth/password-resets` (202)
   * - **Amadeus:** none. **Tenant tables:** customers, customer_identities, customer_password_resets, notifications.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** server action or client component.
   * - **Next.js caching:** never cached.
   *
   * @throws {ValidationError} `VALIDATION_FAILED`.
   * @throws {PermissionError} `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {RateLimitError} `RATE_LIMITED` (10 per hour per end-user IP — pass `options.endUser` from server code).
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function forgotAction(form: FormData) {
   *   const r = await velexis.auth.requestPasswordReset({ email: String(form.get("email")) }, { endUser: await endUserFromHeaders() });
   *   return { message: r.message };
   * }
   */
  requestPasswordReset(params: Schemas["PasswordResetRequest"], options?: RequestOptions): Promise<Schemas["AuthAcceptedResult"]>;

  /**
   * Set a new password with the token from the reset link. Revokes all existing sessions, unlocks the account and
   * marks the email verified; with `signIn: true` (optional, default) returns a new session.
   *
   * - **HTTP:** `POST /v1/auth/password-resets/confirm`
   * - **Amadeus:** none. **Tenant tables:** customer_password_resets, customer_identities, customer_sessions, customers, notifications.
   * - **Key/token:** publishable or secret key; anonymous (the token is the proof).
   * - **Where:** server action (the result may contain tokens).
   * - **Next.js caching:** never cached.
   *
   * @throws {ValidationError} `PASSWORD_RESET_TOKEN_INVALID` (`details.reason`), `PASSWORD_TOO_WEAK` (422), `VALIDATION_FAILED`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function resetAction(token: string, form: FormData) {
   *   const r = await velexis.auth.resetPassword({ token, newPassword: String(form.get("password")), signIn: true });
   *   if (r.session) await setSessionCookies(r.session);
   *   redirect("/account");
   * }
   */
  resetPassword(params: Schemas["PasswordResetConfirmRequest"], options?: RequestOptions): Promise<Schemas["PasswordResetResult"]>;

  /**
   * Change the signed-in customer's password (re-checks `currentPassword`). The current session is rotated — store
   * the returned session — and with `signOutOtherSessions: true` (optional, default) all other sessions are revoked.
   *
   * - **HTTP:** `POST /v1/auth/password/change`
   * - **Amadeus:** none. **Tenant tables:** customer_identities, customer_sessions, customers, notifications.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server action / route handler (response contains tokens).
   * - **Next.js caching:** never cached.
   *
   * @throws {ValidationError} `CURRENT_PASSWORD_INCORRECT` (422), `PASSWORD_TOO_WEAK` (422), `VALIDATION_FAILED`.
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {VelexisError} `ACCOUNT_LOCKED` (423 after repeated wrong current passwords).
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function changePasswordAction(_: unknown, form: FormData) {
   *   const v = await customerClient();
   *   try {
   *     const { session } = await v.auth.changePassword({
   *       currentPassword: String(form.get("current")), newPassword: String(form.get("next")), signOutOtherSessions: true,
   *     });
   *     await setSessionCookies(session);
   *     return { ok: true };
   *   } catch (e) {
   *     if (isVelexisError(e, "CURRENT_PASSWORD_INCORRECT") || isVelexisError(e, "PASSWORD_TOO_WEAK")) return { error: e.message };
   *     throw e;
   *   }
   * }
   */
  changePassword(params: Schemas["PasswordChangeRequest"], options?: RequestOptions): Promise<Schemas["AuthSessionResult"]>;

  /**
   * Get the signed-in customer and metadata of the current session ("me"). Cheap; use it to render signed-in UI.
   *
   * - **HTTP:** `GET /v1/auth/session`
   * - **Amadeus:** none. **Tenant tables:** customer_sessions, customers, customer_identities.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server components, route handlers, middleware; client components only through your own route handler
   *   (the access token lives in an httpOnly cookie).
   * - **Next.js caching:** personal — always `cache: "no-store"` (the SDK default for this method).
   *
   * @throws {AuthenticationError} `UNAUTHENTICATED` (render signed-out UI), `TOKEN_EXPIRED` (the SDK refreshes and retries once when a refresh token source is configured), `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // app/components/AccountMenu.tsx (server component)
   * export async function AccountMenu() {
   *   const v = await customerClient();
   *   const me = await v.auth.getSession().catch((e) => (isVelexisError(e, "UNAUTHENTICATED") ? null : Promise.reject(e)));
   *   return me ? <a href="/account">Hi {me.customer.firstName}</a> : <a href="/sign-in">Sign in</a>;
   * }
   */
  getSession(params?: AuthGetSessionParams, options?: RequestOptions): Promise<Schemas["AuthSessionInfo"]>;
}

/* ------------------------------------------------------------------------------------------------
 * account
 * ---------------------------------------------------------------------------------------------- */

/**
 * `client.account` — the signed-in customer's own data. Every method needs a customer access token
 * (`customerAuth`) and acts on that customer; responses are personal: never cache them (`cache: "no-store"`).
 */
export interface AccountApi {
  /**
   * Get the signed-in customer's profile (also the source for pre-filling checkout contact and first traveller).
   *
   * - **HTTP:** `GET /v1/account` (response `ETag` = quoted `version`)
   * - **Amadeus:** none. **Tenant tables:** customers, customer_identities.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server components / route handlers (token from cookies).
   * - **Next.js caching:** `cache: "no-store"`.
   *
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // app/account/page.tsx
   * export default async function AccountPage() {
   *   const v = await customerClient();
   *   const me = await v.account.get();
   *   return <ProfileForm customer={me} />;
   * }
   */
  get(params?: AccountGetParams, options?: RequestOptions): Promise<Schemas["Customer"]>;

  /**
   * Update the profile partially (names, phone, date of birth, marketing consent; email with `currentPassword` —
   * the new address becomes `pendingEmail` until confirmed with {@link AuthApi.verifyEmail}).
   *
   * - **HTTP:** `PATCH /v1/account` with `If-Match` from `ifMatch` (pass `customer.version`)
   * - **Amadeus:** none. **Tenant tables:** customers, customer_identities, customer_consents, notifications.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server action.
   * - **Next.js caching:** n/a; `revalidatePath("/account")` afterwards.
   *
   * @throws {VelexisError} `PRECONDITION_FAILED` (412 — stale `ifMatch`; reload and retry).
   * @throws {ConflictError} `EMAIL_ALREADY_REGISTERED`.
   * @throws {ValidationError} `VALIDATION_FAILED`, `CURRENT_PASSWORD_INCORRECT` (422).
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function saveProfile(version: number, form: FormData) {
   *   const v = await customerClient();
   *   await v.account.update({ ifMatch: version, firstName: String(form.get("firstName")), marketingConsent: form.get("marketing") === "on" });
   *   revalidatePath("/account");
   * }
   */
  update(params: AccountUpdateParams, options?: RequestOptions): Promise<Schemas["Customer"]>;

  /**
   * Delete the account (re-authenticated with `currentPassword`). Signs the customer out everywhere immediately,
   * optionally creates a data export first (`exportData: true`, link emailed), and erases personal data within 30 days;
   * bookings and payments are retained as required by law (`retainedRecords`).
   *
   * - **HTTP:** `POST /v1/account/deletion` (202)
   * - **Amadeus:** none (Amadeus orders are untouched).
   * - **Tenant tables:** customers, customer_identities, customer_sessions, customer_preferences, customer_consents, customer_data_exports, saved_travelers, saved_traveler_documents, checkouts, bookings, notifications.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server action; delete the session cookies afterwards.
   * - **Next.js caching:** n/a.
   *
   * @throws {ConflictError} `ACCOUNT_DELETION_BLOCKED` (`details.bookingIds` awaiting payment/ticketing/refund), `IDEMPOTENCY_KEY_REUSED`.
   * @throws {ValidationError} `CURRENT_PASSWORD_INCORRECT` (422), `VALIDATION_FAILED`.
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function deleteAccountAction(_: unknown, form: FormData) {
   *   const v = await customerClient();
   *   try {
   *     await v.account.delete({ currentPassword: String(form.get("password")), exportData: form.get("export") === "on", reason: "no_longer_needed" });
   *   } catch (e) {
   *     if (isVelexisError(e, "ACCOUNT_DELETION_BLOCKED")) return { error: e.message };
   *     throw e;
   *   }
   *   await clearSessionCookies();
   *   redirect("/goodbye");
   * }
   */
  delete(params: Schemas["AccountDeletionInput"], options?: RequestOptions): Promise<Schemas["AccountDeletion"]>;

  /** Travel and notification preferences. */
  preferences: AccountPreferencesApi;
  /** Saved travellers with documents and loyalty programmes (usable directly in checkout). */
  savedTravelers: AccountSavedTravelersApi;
  /** GDPR personal-data exports. */
  dataExports: AccountDataExportsApi;
}

/** `client.account.preferences` */
export interface AccountPreferencesApi {
  /**
   * Get the customer's preferences: locale, currency, home airport, default cabin (`travelClass`), seat and meal
   * preference, optional notifications. Use them as defaults for the SDK `locale`/`currency` options and the search form.
   *
   * - **HTTP:** `GET /v1/account/preferences` (`ETag` = quoted `version`)
   * - **Amadeus:** none. **Tenant tables:** customer_preferences.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server components / route handlers.
   * - **Next.js caching:** `cache: "no-store"`.
   *
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * const prefs = await (await customerClient()).account.preferences.get();
   * const defaults = { originLocationCode: prefs.homeAirport ?? undefined, travelClass: prefs.travelClass ?? "ECONOMY" };
   */
  get(params?: AccountPreferencesGetParams, options?: RequestOptions): Promise<Schemas["CustomerPreferences"]>;

  /**
   * Update preferences partially (`notifications.email` / `.sms` are merged key by key; null clears).
   * `currency`/`locale` must be offered by the storefront; `homeAirport` must exist in reference data.
   *
   * - **HTTP:** `PATCH /v1/account/preferences` with `If-Match` from `ifMatch` (pass `preferences.version`)
   * - **Amadeus:** none. **Tenant tables:** customer_preferences, customers, storefront_settings.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server action.
   * - **Next.js caching:** n/a.
   *
   * @throws {ValidationError} `VALIDATION_FAILED` (fieldError codes `unsupported_currency`, `unsupported_locale`, `unknown_airport`, `phone_required`).
   * @throws {VelexisError} `PRECONDITION_FAILED` (412).
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function setCurrency(version: number, currency: string) {
   *   const v = await customerClient();
   *   await v.account.preferences.update({ ifMatch: version, currency });
   *   (await cookies()).set("vx_currency", currency);
   * }
   */
  update(params: AccountPreferencesUpdateParams, options?: RequestOptions): Promise<Schemas["CustomerPreferences"]>;
}

/** `client.account.savedTravelers` */
export interface AccountSavedTravelersApi {
  /**
   * List saved travellers (account holder first, then most recently used). Documents carry `numberMasked` only and
   * there is no `amadeus` projection — pass `savedTravelerId` to checkout or call {@link AccountSavedTravelersApi.get}.
   *
   * - **HTTP:** `GET /v1/account/saved-travelers?cursor&limit`
   * - **Amadeus:** none. **Tenant tables:** saved_travelers, saved_traveler_documents.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server components (checkout traveller picker, account page).
   * - **Next.js caching:** `cache: "no-store"`.
   *
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {ValidationError} `VALIDATION_FAILED` (bad cursor/limit).
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * const v = await customerClient();
   * const travelers: Schemas["SavedTraveler"][] = [];
   * for await (const t of await v.account.savedTravelers.list({ limit: 20 })) travelers.push(t);
   */
  list(params?: SavedTravelerListParams, options?: RequestOptions): Promise<Page<Schemas["SavedTraveler"]>>;

  /**
   * Save a traveller (AmadeusTraveler field names; documents with AmadeusIdentityDocument field names).
   * Returns the full traveller including the `amadeus` projection.
   *
   * - **HTTP:** `POST /v1/account/saved-travelers` (201 + `Location`, `ETag`)
   * - **Amadeus:** none. **Tenant tables:** saved_travelers, saved_traveler_documents.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server action (e.g. "Save this traveller for next time" in checkout).
   * - **Next.js caching:** n/a.
   *
   * @throws {ValidationError} `TRAVELER_DATA_INVALID` (422, see `fieldErrors`), `SAVED_TRAVELER_LIMIT_REACHED` (422, max 20), `VALIDATION_FAILED`.
   * @throws {PermissionError} `FEATURE_DISABLED`, `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function addTraveler(form: FormData) {
   *   const v = await customerClient();
   *   await v.account.savedTravelers.create({
   *     name: { firstName: "LEO", lastName: "BERG" }, dateOfBirth: "2019-06-02", gender: "MALE",
   *     documents: [{ documentType: "PASSPORT", number: "128840457", expiryDate: "2027-01-15", issuanceCountry: "GB", nationality: "GB", holder: true }],
   *   });
   *   revalidatePath("/account/travelers");
   * }
   */
  create(params: Schemas["SavedTravelerCreateRequest"], options?: RequestOptions): Promise<Schemas["SavedTraveler"]>;

  /**
   * Get one saved traveller with full document numbers and the `amadeus` (AmadeusTraveler) projection.
   *
   * - **HTTP:** `GET /v1/account/saved-travelers/{savedTravelerId}` (`ETag`)
   * - **Amadeus:** none. **Tenant tables:** saved_travelers, saved_traveler_documents.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server components (edit form). Avoid sending full document numbers to client components unless editing.
   * - **Next.js caching:** `cache: "no-store"`.
   *
   * @throws {NotFoundError} `NOT_FOUND`.
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // app/account/travelers/[id]/page.tsx
   * export default async function EditTraveler({ params }: { params: Promise<{ id: string }> }) {
   *   const { id } = await params;
   *   const t = await (await customerClient()).account.savedTravelers.get({ savedTravelerId: id });
   *   return <TravelerForm traveler={t} />;
   * }
   */
  get(params: SavedTravelerRefParams, options?: RequestOptions): Promise<Schemas["SavedTraveler"]>;

  /**
   * Update a saved traveller partially; `documents`, `loyaltyPrograms` and `discountEligibility` replace the stored lists
   * (documents with an existing `id` are updated in place).
   *
   * - **HTTP:** `PATCH /v1/account/saved-travelers/{savedTravelerId}` with `If-Match` from `ifMatch` (pass `traveler.version`)
   * - **Amadeus:** none. **Tenant tables:** saved_travelers, saved_traveler_documents.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server action.
   * - **Next.js caching:** n/a.
   *
   * @throws {ValidationError} `TRAVELER_DATA_INVALID` (422), `VALIDATION_FAILED`.
   * @throws {VelexisError} `PRECONDITION_FAILED` (412).
   * @throws {NotFoundError} `NOT_FOUND`.
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * await v.account.savedTravelers.update({ savedTravelerId: t.id, ifMatch: t.version, loyaltyPrograms: [{ programOwner: "BA", id: "41234567" }] });
   */
  update(params: SavedTravelerUpdateParams, options?: RequestOptions): Promise<Schemas["SavedTraveler"]>;

  /**
   * Delete a saved traveller and its documents (existing bookings keep their own copies).
   *
   * - **HTTP:** `DELETE /v1/account/saved-travelers/{savedTravelerId}` (204)
   * - **Amadeus:** none. **Tenant tables:** saved_travelers, saved_traveler_documents.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server action.
   * - **Next.js caching:** n/a.
   *
   * @throws {NotFoundError} `NOT_FOUND`.
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function removeTraveler(id: string) {
   *   await (await customerClient()).account.savedTravelers.delete({ savedTravelerId: id });
   *   revalidatePath("/account/travelers");
   * }
   */
  delete(params: SavedTravelerRefParams, options?: RequestOptions): Promise<void>;
}

/** `client.account.dataExports` */
export interface AccountDataExportsApi {
  /**
   * Request an export of all personal data (profile, preferences, consents, saved travellers, optionally bookings) as a
   * ZIP of JSON or CSV files. Returns the queued job (or the one already in progress); the customer is emailed when ready.
   *
   * - **HTTP:** `POST /v1/account/data-exports` (202 + `Location`)
   * - **Amadeus:** none. **Tenant tables:** customer_data_exports (+ every table read into the export).
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server action.
   * - **Next.js caching:** n/a.
   *
   * @throws {RateLimitError} `RATE_LIMITED` (one new export per 24 h; `retryAfterSeconds`).
   * @throws {ValidationError} `VALIDATION_FAILED`.
   * @throws {ConflictError} `IDEMPOTENCY_KEY_REUSED`.
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * "use server";
   * export async function exportMyData() {
   *   const job = await (await customerClient()).account.dataExports.create({ format: "json", includeBookings: true });
   *   redirect(`/account/privacy/exports/${job.id}`);
   * }
   */
  create(params?: Schemas["AccountDataExportInput"], options?: RequestOptions): Promise<Schemas["AccountDataExport"]>;

  /**
   * Get an export's status; when `status === "ready"`, `downloadUrl` is a signed URL valid 15 minutes (each call
   * signs a new one) until `expiresAt` (7 days).
   *
   * - **HTTP:** `GET /v1/account/data-exports/{dataExportId}`
   * - **Amadeus:** none. **Tenant tables:** customer_data_exports.
   * - **Key/token:** publishable or secret key + customer access token.
   * - **Where:** server component or route handler (poll every few seconds from the client via your route handler).
   * - **Next.js caching:** `cache: "no-store"`.
   *
   * @throws {NotFoundError} `NOT_FOUND`.
   * @throws {AuthenticationError} `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * const job = await (await customerClient()).account.dataExports.get({ dataExportId: "dex_9Zx3Cv6Bn2Mq8Wl4" });
   * if (job.status === "ready" && job.downloadUrl) redirect(job.downloadUrl);
   */
  get(params: AccountDataExportGetParams, options?: RequestOptions): Promise<Schemas["AccountDataExport"]>;
}

/* ------------------------------------------------------------------------------------------------
 * reference
 * ---------------------------------------------------------------------------------------------- */

/**
 * `client.reference` — read-only reference data (airports, cities, airlines, countries, currencies) from the shared
 * `reference` schema. Public: works with a publishable key, needs no user token, and is safe to call from client
 * components. Responses are CDN-cacheable; cache them in Next.js (`next: { revalidate }`).
 */
export interface ReferenceApi {
  /** Airport and city autocomplete. */
  locations: ReferenceLocationsApi;
  /** Airports by IATA code. */
  airports: ReferenceAirportsApi;
  /** Airline names and logos. */
  airlines: ReferenceAirlinesApi;
  /** Countries (nationality, issuing country, phone calling codes). */
  countries: ReferenceCountriesApi;
  /** Currencies (codes, symbols, decimals). */
  currencies: ReferenceCurrenciesApi;
}

/** `client.reference.locations` */
export interface ReferenceLocationsApi {
  /**
   * Autocomplete airports and cities by keyword, best match first: exact IATA code, then case-insensitive **prefix**
   * matches on airport, airport-city and city names, ranked by popularity. Names are the English reference names; there
   * is no fuzzy, typo-tolerant, accent-insensitive or translated matching (`mun` finds Munich, `münchen` does not).
   * City results include their airports. Feed `iataCode` (+ `subType`) into the flight search origin/destination.
   *
   * - **HTTP:** `GET /v1/reference/locations?keyword&subType&countryCode&cursor&limit`
   * - **Amadeus:** none (reference data). **Tables:** reference.airports, reference.cities, reference.countries.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** client components (debounce ~200 ms and pass an `AbortSignal`) or server components.
   * - **Next.js caching:** cacheable — `{ next: { revalidate: 86400 } }` on the server; the API sends `Cache-Control: public, max-age=86400`.
   *
   * @throws {ValidationError} `VALIDATION_FAILED` (keyword shorter than 2 characters, bad `countryCode`).
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   * @throws {ConnectionError} `ABORTED` when your `signal` cancels a stale request (ignore it).
   *
   * @example
   * // app/components/AirportInput.tsx
   * "use client";
   * import { useEffect, useState } from "react";
   * import { browserClient } from "@/lib/velexis-browser";
   * export function AirportInput({ onPick }: { onPick: (code: string, subType: "AIRPORT" | "CITY") => void }) {
   *   const [q, setQ] = useState("");
   *   const [items, setItems] = useState<Schemas["Location"][]>([]);
   *   useEffect(() => {
   *     if (q.length < 2) return setItems([]);
   *     const ctrl = new AbortController();
   *     const t = setTimeout(() => {
   *       browserClient.reference.locations.search({ keyword: q, limit: 8 }, { signal: ctrl.signal })
   *         .then((p) => setItems(p.data)).catch(() => undefined);
   *     }, 200);
   *     return () => { clearTimeout(t); ctrl.abort(); };
   *   }, [q]);
   *   return (
   *     <div>
   *       <input value={q} onChange={(e) => setQ(e.target.value)} aria-autocomplete="list" />
   *       <ul>{items.map((l) => <li key={l.id} onClick={() => onPick(l.iataCode, l.subType)}>{l.detailedName}</li>)}</ul>
   *     </div>
   *   );
   * }
   */
  search(params: LocationSearchParams, options?: RequestOptions): Promise<Page<Schemas["Location"]>>;
}

/** `client.reference.airports` */
export interface ReferenceAirportsApi {
  /**
   * Get an airport by IATA code (name, city, country, time zone, coordinates).
   *
   * - **HTTP:** `GET /v1/reference/airports/{iataCode}`
   * - **Amadeus:** none. **Tables:** reference.airports, reference.cities, reference.countries.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** anywhere; typically server components (itinerary, SEO landing pages).
   * - **Next.js caching:** `{ next: { revalidate: 604800 } }` (7 days).
   *
   * @throws {NotFoundError} `NOT_FOUND` (unknown code).
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * // app/flights-to/[iata]/page.tsx
   * const airport = await velexis.reference.airports.get({ iataCode: "LHR" }, { next: { revalidate: 604800 } });
   */
  get(params: AirportGetParams, options?: RequestOptions): Promise<Schemas["Airport"]>;
}

/** `client.reference.airlines` */
export interface ReferenceAirlinesApi {
  /**
   * List airlines, or resolve up to 100 IATA designators at once (names, alliance, logo URLs) — e.g. all carriers on a
   * search results page. Unknown codes are omitted.
   *
   * - **HTTP:** `GET /v1/reference/airlines?iataCodes=BA,U2&cursor&limit`
   * - **Amadeus:** none. **Tables:** reference.airlines.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** server components (recommended) or client components.
   * - **Next.js caching:** `{ next: { revalidate: 86400 } }`; logo URLs are immutable.
   *
   * @throws {ValidationError} `VALIDATION_FAILED` (more than 100 codes, bad code format).
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * Result pages of `flights.listResults` already carry `dictionaries.carriers` (name, logoUrl); use this method for
   * alliance / ICAO / website data or codes outside a result page.
   *
   * @example
   * // `amadeus` is omitted in the default summary view of result pages — use the top-level Velexis fields
   * const codes = [...new Set(offers.flatMap((o) => o.validatingAirlineCodes ?? []))];
   * const { data } = await velexis.reference.airlines.list({ iataCodes: codes.slice(0, 100), limit: 100 }, { next: { revalidate: 86400 } });
   * const airlineByCode = new Map(data.map((a) => [a.iataCode, a]));
   */
  list(params?: AirlineListParams, options?: RequestOptions): Promise<Page<Schemas["Airline"]>>;

  /**
   * Get one airline by IATA designator.
   *
   * - **HTTP:** `GET /v1/reference/airlines/{iataCode}`
   * - **Amadeus:** none. **Tables:** reference.airlines.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** anywhere.
   * - **Next.js caching:** `{ next: { revalidate: 604800 } }`.
   *
   * @throws {NotFoundError} `NOT_FOUND`.
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * const ba = await velexis.reference.airlines.get({ iataCode: "BA" }, { next: { revalidate: 604800 } });
   * // <img src={ba.logoSquareUrl} alt={ba.name} width={32} height={32} />
   */
  get(params: AirlineGetParams, options?: RequestOptions): Promise<Schemas["Airline"]>;
}

/** `client.reference.countries` */
export interface ReferenceCountriesApi {
  /**
   * List countries (ISO codes, localised name, calling code, main currency, flag) sorted by localised name. ~250
   * entries: iterate all pages with `for await` and cache.
   *
   * - **HTTP:** `GET /v1/reference/countries?cursor&limit`
   * - **Amadeus:** none. **Tables:** reference.countries.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** server components (build select options once) or client components.
   * - **Next.js caching:** `{ next: { revalidate: 604800 } }`; vary by `locale`.
   *
   * @throws {ValidationError} `VALIDATION_FAILED`.
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * const countries: Schemas["Country"][] = [];
   * for await (const c of await velexis.reference.countries.list({ limit: 100 }, { locale: "fr-FR", next: { revalidate: 604800 } })) countries.push(c);
   */
  list(params?: CountryListParams, options?: RequestOptions): Promise<Page<Schemas["Country"]>>;
}

/** `client.reference.currencies` */
export interface ReferenceCurrenciesApi {
  /**
   * List currencies (ISO 4217 code, localised name, symbol, decimals) sorted by code. The currencies the OTA sells in
   * are `storefront.currencies`; use this list for formatting (`decimals`) and console settings.
   *
   * - **HTTP:** `GET /v1/reference/currencies?cursor&limit`
   * - **Amadeus:** none. **Tables:** reference.currencies.
   * - **Key/token:** publishable or secret key; anonymous.
   * - **Where:** anywhere.
   * - **Next.js caching:** `{ next: { revalidate: 604800 } }`.
   *
   * @throws {ValidationError} `VALIDATION_FAILED`.
   * @throws {AuthenticationError} `INVALID_API_KEY`.
   * @throws {PermissionError} `ORIGIN_NOT_ALLOWED`, `TENANT_SUSPENDED`.
   * @throws {RateLimitError} `RATE_LIMITED`.
   * @throws {ServerError} `INTERNAL_ERROR`.
   *
   * @example
   * const page = await velexis.reference.currencies.list({ limit: 100 }, { next: { revalidate: 604800 } });
   * const decimals = new Map(page.data.map((c) => [c.code, c.decimals]));
   * const format = (m: Money) => Number(m.amount).toFixed(decimals.get(m.currency) ?? 2) + " " + m.currency;
   */
  list(params?: CurrencyListParams, options?: RequestOptions): Promise<Page<Schemas["Currency"]>>;
}
