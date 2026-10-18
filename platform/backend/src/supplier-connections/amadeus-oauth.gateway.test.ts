// The Amadeus token check (PBE-020, flows/amadeus-connection.md §A step 2) without a network: the request it sends
// (form, path, no redirects), and how it classifies and describes each kind of answer: a token, a refusal, an outage,
// a timeout, a network error and an endless body. The texts hold the HTTP status and the Amadeus codes only, never a
// description, the secret or the token.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AMADEUS_TOKEN_MAX_BODY_BYTES,
  AMADEUS_TOKEN_PATH,
  AmadeusOAuthGateway,
  classifyStatus,
  describeAnswer,
  describeFailure,
  tokenUrl,
  type FetchFunction,
} from "./amadeus-oauth.gateway";

/** Not a real secret: a value the tests look for in what the gateway returns. */
const SECRET = "unit-test-client-secret-0123456789";
const TOKEN = "unit-test-access-token-abcdef";
const CREDENTIALS = {
  baseUrl: "https://test.travel.api.amadeus.com/",
  clientId: "velexis-client",
  clientSecret: SECRET,
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch that answers `response` and records its calls. */
function fakeFetch(response: () => Response): { fetch: FetchFunction; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response());
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let server: Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running !== undefined) {
    running.closeAllConnections();
    await new Promise<void>((done) => running.close(() => done()));
  }
});

/** A loopback HTTP server for the timeout and body-size cases, answered by `handler`. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("AmadeusOAuthGateway.checkCredentials", () => {
  it("posts the client credentials form to {baseUrl}/v1/security/oauth2/token, follows no redirect, and discards the token", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, { type: "amadeusOAuth2Token", access_token: TOKEN, expires_in: 1799, state: "approved" }),
    );
    const result = await new AmadeusOAuthGateway({ fetch }).checkCredentials(CREDENTIALS);

    expect(result).toEqual({ outcome: "verified", httpStatus: 200 });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`https://test.travel.api.amadeus.com${AMADEUS_TOKEN_PATH}`);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(call?.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(call?.init.body)))).toEqual({
      grant_type: "client_credentials",
      client_id: "velexis-client",
      client_secret: SECRET,
    });
  });

  it("rejects refused credentials with the status, the OAuth error and the Amadeus code, never the description", async () => {
    const { fetch } = fakeFetch(() =>
      json(401, {
        error: "invalid_client",
        error_description: `Client credentials are invalid: ${SECRET}`,
        code: 38187,
        title: "Invalid parameters",
      }),
    );
    const result = await new AmadeusOAuthGateway({ fetch }).checkCredentials(CREDENTIALS);

    expect(result).toEqual({
      outcome: "rejected",
      httpStatus: 401,
      error: "HTTP 401 invalid_client (Amadeus code 38187)",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("reports a 5xx as unavailable with the Amadeus code of `errors[0]`, never its title or detail", async () => {
    const { fetch } = fakeFetch(() =>
      json(500, { errors: [{ status: 500, code: 141, title: "SYSTEM ERROR HAS OCCURRED", detail: "boom" }] }),
    );
    const result = await new AmadeusOAuthGateway({ fetch }).checkCredentials(CREDENTIALS);

    expect(result).toEqual({ outcome: "unavailable", httpStatus: 500, error: "HTTP 500 (Amadeus code 141)" });
  });

  it("rejects a 2xx without an access token and a redirect, which it never follows", async () => {
    const empty = fakeFetch(() => json(200, { state: "approved" }));
    const redirect = fakeFetch(
      () => new Response(null, { status: 302, headers: { Location: "https://evil.example.com/" } }),
    );

    expect(await new AmadeusOAuthGateway({ fetch: empty.fetch }).checkCredentials(CREDENTIALS)).toEqual({
      outcome: "rejected",
      httpStatus: 200,
      error: "HTTP 200 without an access token",
    });
    expect(await new AmadeusOAuthGateway({ fetch: redirect.fetch }).checkCredentials(CREDENTIALS)).toEqual({
      outcome: "rejected",
      httpStatus: 302,
      error: "HTTP 302",
    });
    expect(redirect.calls).toHaveLength(1);
  });

  it("refuses a base URL that is neither https nor the loopback stub without sending the secret", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { access_token: TOKEN }));
    const result = await new AmadeusOAuthGateway({ fetch }).checkCredentials({
      ...CREDENTIALS,
      baseUrl: "http://test.travel.api.amadeus.com",
    });

    expect(result).toEqual({ outcome: "rejected", httpStatus: null, error: "base URL is not https" });
    expect(calls).toHaveLength(0);
  });

  it("gives up after its timeout as unavailable, and names a network error by its code only", async () => {
    // A server that never answers; the gateway's own timeout is shortened to 200 ms for the test.
    const hanging = await serve(() => undefined);
    const timedOut = await new AmadeusOAuthGateway({ timeoutMs: 200 }).checkCredentials({
      ...CREDENTIALS,
      baseUrl: hanging,
    });
    const refused = await new AmadeusOAuthGateway({
      fetch: () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })),
    }).checkCredentials(CREDENTIALS);

    expect(timedOut).toEqual({ outcome: "unavailable", httpStatus: null, error: "timeout after 1 s" });
    expect(refused).toEqual({
      outcome: "unavailable",
      httpStatus: null,
      error: "network error (ECONNREFUSED)",
    });
  });

  it("reads at most 64 KiB of an answer", async () => {
    let written = 0;
    const endless = await serve((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      const write = (): void => {
        while (written < 10 * AMADEUS_TOKEN_MAX_BODY_BYTES && res.write(chunk)) {
          written += chunk.length;
        }
        if (written < 10 * AMADEUS_TOKEN_MAX_BODY_BYTES) {
          res.once("drain", write);
        } else {
          res.end();
        }
      };
      write();
    });
    const result = await new AmadeusOAuthGateway().checkCredentials({ ...CREDENTIALS, baseUrl: endless });

    expect(result).toEqual({ outcome: "unavailable", httpStatus: 500, error: "HTTP 500" });
  });
});

describe("the answer texts", () => {
  it("classifies 5xx, 408 and 429 as unavailable and every other status as rejected", () => {
    expect([500, 502, 503, 504, 408, 429].map(classifyStatus)).toEqual(Array(6).fill("unavailable"));
    expect([301, 302, 400, 401, 403, 404, 405].map(classifyStatus)).toEqual(Array(7).fill("rejected"));
  });

  it("keeps only an OAuth error code and a numeric Amadeus code of the body", () => {
    expect(describeAnswer(400, { error: "invalid_request", code: "38187" })).toBe(
      "HTTP 400 invalid_request (Amadeus code 38187)",
    );
    expect(describeAnswer(401, { error: "Client secret <script>", code: "x1" })).toBe("HTTP 401");
    expect(describeAnswer(503, "Service Unavailable")).toBe("HTTP 503");
    expect(describeAnswer(500, { errors: [{ code: 1.5 }] })).toBe("HTTP 500");
  });

  it("describes failures without a message", () => {
    expect(describeFailure(new DOMException("aborted", "TimeoutError"), 10_000)).toBe("timeout after 10 s");
    expect(describeFailure(new TypeError("fetch failed", { cause: { code: "lower case" } }), 10_000)).toBe(
      "network error",
    );
  });

  it("joins the token path to a base URL with or without a trailing slash", () => {
    expect(tokenUrl("http://127.0.0.1:4900")).toBe(`http://127.0.0.1:4900${AMADEUS_TOKEN_PATH}`);
    expect(tokenUrl("https://example.com/amadeus/")).toBe(`https://example.com/amadeus${AMADEUS_TOKEN_PATH}`);
  });
});
