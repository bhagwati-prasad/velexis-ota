// OAuth 2.0 client credentials of the Amadeus stub (X-026): the token endpoint and the bearer-token check of every
// API call, with the answers and error formats of Amadeus's test environment.
//
//   POST /v1/security/oauth2/token
//   Content-Type: application/x-www-form-urlencoded
//   grant_type=client_credentials&client_id=<id>&client_secret=<secret>
//
// By default any non-empty client id and secret are accepted, so the dummy credentials of the local database work;
// `createStubServer({ credentials })` accepts one pair only, so a test can prove that wrong credentials are refused.
// Issued tokens live in memory and expire after `expires_in` (1799 s) on the injected clock. A token is never logged
// or recorded: the request log redacts the `Authorization` header and never keeps bodies.
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { AMADEUS_ERROR_CODES, amadeusErrorResponse, type StubResponse } from "./scenarios";

/** The path of the token endpoint (Amadeus's base URL plus this path). */
export const OAUTH_TOKEN_PATH = "/v1/security/oauth2/token";

/** The token lifetime Amadeus announces, in seconds. */
export const TOKEN_EXPIRES_IN = 1799;

/** The only client credentials a server accepts, when they are given. */
export interface StubCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The time source of token expiry (the backends' `Clock` shape; `FakeClock` of @velexis/testing fits). */
export interface StubClock {
  now(): Date;
}

/** The media type of the token endpoint's answers. */
const OAUTH_JSON = "application/json";
const FORM = /^application\/x-www-form-urlencoded\s*(?:;|$)/i;
const BEARER = /^Bearer +([A-Za-z0-9._~+/=-]+)$/i;
const FORGET_EXPIRED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Amadeus's flat OAuth error body (`error`, `error_description`, `code`, `title`). */
function oauthError(status: 400 | 401, error: string, description: string): StubResponse {
  return {
    status,
    contentType: OAUTH_JSON,
    body: {
      error,
      error_description: description,
      code: AMADEUS_ERROR_CODES.oauthInvalidParameters,
      title: "Invalid parameters",
    },
  };
}

const MISSING_AUTHORIZATION = amadeusErrorResponse([
  {
    status: 401,
    code: AMADEUS_ERROR_CODES.invalidHttpHeader,
    title: "Invalid HTTP header",
    detail: "Missing or invalid format for mandatory Authorization header",
  },
]);

const INVALID_TOKEN = amadeusErrorResponse([
  {
    status: 401,
    code: AMADEUS_ERROR_CODES.invalidAccessToken,
    title: "Invalid access token",
    detail: "The access token provided in the Authorization header is invalid",
  },
]);

const EXPIRED_TOKEN = amadeusErrorResponse([
  {
    status: 401,
    code: AMADEUS_ERROR_CODES.accessTokenExpired,
    title: "Access token expired",
    detail: "The access token is expired",
  },
]);

/** The issued tokens of one stub server. */
export class TokenStore {
  readonly #clock: StubClock;
  readonly #credentials: StubCredentials | undefined;
  /** token → expiry (epoch ms). */
  readonly #tokens = new Map<string, number>();

  constructor(options: { readonly clock: StubClock; readonly credentials?: StubCredentials | undefined }) {
    this.#clock = options.clock;
    this.#credentials = options.credentials;
  }

  /**
   * Checks a token request (content type, `grant_type`, client credentials). It returns the client id to issue a
   * token to, or the error response: 400 for a bad grant, 401 `invalid_client` for missing or refused credentials.
   */
  checkTokenRequest(
    headers: IncomingHttpHeaders,
    body: string,
  ): { readonly clientId: string } | { readonly error: StubResponse } {
    const form = FORM.test(headers["content-type"] ?? "") ? new URLSearchParams(body) : new URLSearchParams();
    const grantType = form.get("grant_type");
    if (grantType === null || grantType === "") {
      return { error: oauthError(400, "invalid_request", "Mandatory grant_type form parameter missing") };
    }
    if (grantType !== "client_credentials") {
      return {
        error: oauthError(
          400,
          "unsupported_grant_type",
          "Only client_credentials value is allowed for the body parameter grant_type",
        ),
      };
    }
    const clientId = form.get("client_id") ?? "";
    const clientSecret = form.get("client_secret") ?? "";
    const refused =
      clientId === "" ||
      clientSecret === "" ||
      (this.#credentials !== undefined &&
        (clientId !== this.#credentials.clientId || clientSecret !== this.#credentials.clientSecret));
    if (refused) {
      return { error: oauthError(401, "invalid_client", "Client credentials are invalid") };
    }
    return { clientId };
  }

  /** Issues a new token to `clientId` and answers like Amadeus. */
  issue(clientId: string): StubResponse {
    const now = this.#clock.now().getTime();
    // Forget tokens a day after they expired: until then they still answer "expired", not "invalid".
    for (const [token, expiresAt] of this.#tokens) {
      if (expiresAt + FORGET_EXPIRED_AFTER_MS <= now) {
        this.#tokens.delete(token);
      }
    }
    const accessToken = randomBytes(21).toString("base64url");
    this.#tokens.set(accessToken, now + TOKEN_EXPIRES_IN * 1000);
    return {
      status: 200,
      contentType: OAUTH_JSON,
      body: {
        type: "amadeusOAuth2Token",
        application_name: "velexis-amadeus-stub",
        client_id: clientId,
        token_type: "Bearer",
        access_token: accessToken,
        expires_in: TOKEN_EXPIRES_IN,
        state: "approved",
        scope: "",
      },
    };
  }

  /** `undefined` when the request carries a valid bearer token, otherwise the 401 to answer. */
  authenticate(headers: IncomingHttpHeaders): StubResponse | undefined {
    const match = BEARER.exec(headers.authorization ?? "");
    const token = match?.[1];
    if (token === undefined) {
      return MISSING_AUTHORIZATION;
    }
    const expiresAt = this.#tokens.get(token);
    if (expiresAt === undefined) {
      return INVALID_TOKEN;
    }
    return expiresAt <= this.#clock.now().getTime() ? EXPIRED_TOKEN : undefined;
  }
}
