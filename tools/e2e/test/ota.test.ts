// The pure helpers of support/ota.ts (OFE-008, OFE-019, OAD-016, OAD-017, OFE-022). The database and Redis helpers run in the storefront
// journeys (specs/storefront/search.e2e.ts, account-bookings.e2e.ts, keyboard-checkout.e2e.ts) and the OTA admin's
// (specs/ota-admin/), against the stack's own database; the API clients, the booking seed and the stub order run here
// against a fake browser context, a fake API and a fake `fetch`. The arrangements FIX-W46-OTA moved out of the specs
// run here too: the console client and the staff sign-in against a fake `fetch` and platform API, and the move into
// the live environment in a real `tenantTx` on a fake pool that records the SQL it is sent.
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aadFor, decryptValue, DecryptionError, LocalFileKeyProvider } from "@velexis/crypto";
import { createTenantDb, tenantTx } from "@velexis/db";
import type { ApiCall } from "../support/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  agedAccessToken,
  customDomainOf,
  FIXTURE_PRECONDITIONS,
  forwardedRequestOf,
  goLiveAnswerOf,
  goLiveAttempt,
  hostResolverRules,
  livePlanCodeOf,
  newPlatformId,
  returnedHeadersOf,
  sealedClientSecret,
  serveStorefrontHost,
  storefrontHostsOf,
  uniqueLiveOfficeId,
  type ForwardedAnswer,
  type Forwarder,
  airlineTestCard,
  bookAirlineCardTrip,
  createStubOrder,
  customerScopeLeaks,
  ConsoleApi,
  DEMO_TENANT_SCHEMA,
  moveBookingIntoLive,
  signInStaffWithApi,
  STAFF_CONSOLE_KEY,
  type TenantTxRunner,
  departureDate,
  EdgeApi,
  edgeRequestOf,
  errorCodeOf,
  EXPIRED_TOKEN_AGE_SECONDS,
  forgetStorefrontCopies,
  MIDNIGHT_GUARD_MS,
  MIDNIGHT_WAIT_BUDGET_MS,
  msUntilPastMidnight,
  PAST_MIDNIGHT_MS,
  newTenantId,
  offerDepartingIn,
  scriptReadableCookieNames,
  searchIdOf,
  serveStorefrontOf,
  setCookieValue,
  shiftLocal,
  STAFF_COOKIES,
  STOREFRONT_SESSION_COPIES,
  storefrontHostOf,
  StorefrontApi,
  StorefrontApiError,
  tenantSchemaOf,
  type ApiMethod,
  type DocumentEvaluator,
  type FetchLike,
  type RoutedContext,
  type SeedApi,
  type StorageEvaluator,
  type StorefrontApiContext,
} from "../support/ota";
import { AMADEUS_STUB_URL, OTA_API_URL, PLATFORM_API_URL, REPO_ROOT, STOREFRONT_URL } from "../support/stack";
import { CSRF_COOKIE } from "../support/storefront-guards";

describe("searchIdOf", () => {
  it("reads the search id that the results page wrote into its address [OFE-008 AC1]", () => {
    expect(
      searchIdOf(`${STOREFRONT_URL}/search.html?from=MAD&search=srch_01M5XN79WJM4DFVFXWB7Z3SWS3&stops=0`),
    ).toBe("srch_01M5XN79WJM4DFVFXWB7Z3SWS3");
  });

  it("names the page, never the query string, when there is no valid id [OFE-008 AC1]", () => {
    expect(() => searchIdOf(`${STOREFRONT_URL}/search.html?from=MAD`)).toThrow(
      "the address /search.html has no search=srch_… id",
    );
    expect(() => searchIdOf(`${STOREFRONT_URL}/search.html?search=srch_x'--`)).toThrow(/has no search=srch_/);
  });
});

describe("newTenantId", () => {
  it("is ten_ and a ULID, as the platform writes tenant ids [OFE-008 AC1]", () => {
    const id = newTenantId();
    expect(id).toMatch(/^ten_0[0-9A-HJKMNP-TV-Z]{25}$/);
    expect(newTenantId()).not.toBe(id);
  });
});

describe("DEMO_TENANT_SCHEMA", () => {
  it("is the schema the OTA backend's dev:seed provisions [OFE-008 AC1]", () => {
    expect(DEMO_TENANT_SCHEMA).toBe("tenant_demo");
  });
});

describe("customerScopeLeaks", () => {
  it("finds net amounts, markups, margins, diagnostics and supplier details at any depth [OF-02 AC1]", () => {
    expect(
      customerScopeLeaks({
        data: [
          {
            price: { total: { amount: "98.47", currency: "EUR" } },
            netPrice: { amount: "90.00", currency: "EUR" },
          },
          { markup: { amount: "8.47" }, breakdown: { netBase: "80.00", NetTaxes: "10.00" } },
          { amadeus: { price: { grandTotal: "98.47", margins: [] } }, price: { total: { amount: "98.47" } } },
        ],
        meta: { diagnostics: { supplierMs: 120 } },
        error: { supplier: { code: "38189" }, supplierRequestId: "x" },
      }),
    ).toEqual([
      { pointer: "/data/0/netPrice", reason: "net_field" },
      { pointer: "/data/1/markup", reason: "console_only_field" },
      { pointer: "/data/1/breakdown/netBase", reason: "net_field" },
      { pointer: "/data/1/breakdown/NetTaxes", reason: "net_field" },
      { pointer: "/data/2/amadeus/price/margins", reason: "console_only_field" },
      { pointer: "/meta/diagnostics", reason: "console_only_field" },
      // `supplierMs` inside it is a `supplier*` key too: the walk names every one.
      { pointer: "/meta/diagnostics/supplierMs", reason: "console_only_field" },
      { pointer: "/error/supplier", reason: "console_only_field" },
      { pointer: "/error/supplierRequestId", reason: "console_only_field" },
    ]);
  });

  it("finds the verbatim Amadeus dictionaries, never another `amadeus` block [OF-02 AC1]", () => {
    expect(customerScopeLeaks({ dictionaries: { carriers: {}, amadeus: { locations: {} } } })).toEqual([
      { pointer: "/dictionaries/amadeus", reason: "console_only_field" },
    ]);
    expect(customerScopeLeaks({ amadeus: { id: "2" }, dictionaries: { carriers: {} } })).toEqual([]);
  });

  it("finds an embedded Amadeus offer that was not rewritten to the selling total [OF-02 AC1]", () => {
    const offer = (grandTotal: string) => ({
      price: { total: { amount: "98.47", currency: "EUR" } },
      amadeus: { price: { grandTotal } },
    });
    expect(customerScopeLeaks({ data: [offer("98.47")] })).toEqual([]);
    expect(customerScopeLeaks({ data: [offer("90.00")] })).toEqual([
      { pointer: "/data/0/amadeus/price/grandTotal", reason: "amadeus_price" },
    ]);
  });

  it("finds nothing in selling prices only, and escapes keys in its pointers [OF-02 AC1]", () => {
    expect(
      customerScopeLeaks({
        data: [{ price: { total: { amount: "98.47", currency: "EUR" } }, summary: { stops: 0 } }],
        meta: null,
      }),
    ).toEqual([]);
    expect(customerScopeLeaks(null)).toEqual([]);
    expect(customerScopeLeaks("netPrice")).toEqual([]);
    expect(customerScopeLeaks({ "a/b~c": { netPrice: null } })).toEqual([
      { pointer: "/a~1b~0c/netPrice", reason: "net_field" },
    ]);
  });
});

// ---- OFE-019 --------------------------------------------------------------------------------------------------------

/** One request the fake browser context received. */
interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: string | undefined;
}

/** A fake answer: its status and its JSON body (none: `json()` fails, as for a 204). */
interface FakeAnswer {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * A browser context whose request API answers `answers` in order and whose storefront cookies are `cookies`;
 * `onRequest` may change the cookies, as a `Set-Cookie` would.
 */
function fakeContext(
  answers: FakeAnswer[],
  cookies: Map<string, string>,
  onRequest: (request: SentRequest) => void = () => undefined,
): { context: StorefrontApiContext; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const context = {
    cookies: (urls?: string | readonly string[]) => {
      expect(urls).toBe(STOREFRONT_URL);
      return Promise.resolve(
        [...cookies].map(([name, value]) => ({
          name,
          value,
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: name !== CSRF_COOKIE,
          secure: true,
          sameSite: "Lax" as const,
        })),
      );
    },
    request: {
      fetch: (
        url: string,
        options: {
          method: string;
          headers: Record<string, string>;
          data?: string;
          failOnStatusCode: boolean;
        },
      ) => {
        expect(options.failOnStatusCode).toBe(false);
        const request = { url, method: options.method, headers: options.headers, data: options.data };
        sent.push(request);
        onRequest(request);
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error(`no fake answer left for ${options.method} ${url}`);
        }
        return Promise.resolve({
          status: () => answer.status,
          json: () =>
            answer.body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(answer.body),
        });
      },
    },
  };
  return { context: context as unknown as StorefrontApiContext, sent };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("StorefrontApi", () => {
  it("reads through the preview's /api proxy with the journey's end-user IP and no write headers [OFE-019 AC1]", async () => {
    const { context, sent } = fakeContext(
      [{ status: 200, body: { data: [] } }],
      new Map([[CSRF_COOKIE, "csrf-1"]]),
    );
    const api = new StorefrontApi(context, "198.18.4.5");
    await expect(api.call("bookings.list", "GET", "/v1/bookings?timeframe=past")).resolves.toEqual({
      data: [],
    });
    expect(sent).toEqual([
      {
        url: `${STOREFRONT_URL}/api/v1/bookings?timeframe=past`,
        method: "GET",
        headers: { accept: "application/json", "x-forwarded-for": "198.18.4.5" },
        data: undefined,
      },
    ]);
  });

  it("copies the CSRF cookie into every write and sends a new idempotency key with every POST [OFE-019 AC1]", async () => {
    const { context, sent } = fakeContext(
      [
        { status: 201, body: { id: "chk_1" } },
        { status: 201, body: { id: "chk_2" } },
        { status: 200, body: { id: "pay_1" } },
      ],
      new Map([[CSRF_COOKIE, "csrf-1"]]),
    );
    const api = new StorefrontApi(context, "198.19.0.1");
    await api.call("checkout.create", "POST", "/v1/checkouts", { pricedOfferId: "prc_1" }, 201);
    await api.call("checkout.create", "POST", "/v1/checkouts", { pricedOfferId: "prc_1" }, 201);
    await api.call("checkout.updatePayment", "PATCH", "/v1/payments/pay_1", { card: { brand: "VISA" } });
    const [first, second, patch] = sent;
    expect(first?.headers).toMatchObject({
      "content-type": "application/json",
      "x-csrf-token": "csrf-1",
      "x-forwarded-for": "198.19.0.1",
    });
    expect(first?.data).toBe(JSON.stringify({ pricedOfferId: "prc_1" }));
    expect(first?.headers["idempotency-key"]).toMatch(UUID);
    expect(second?.headers["idempotency-key"]).toMatch(UUID);
    expect(second?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
    expect(patch?.headers["x-csrf-token"]).toBe("csrf-1");
    expect(patch?.headers).not.toHaveProperty("idempotency-key");
  });

  it("asks storefront.get for the CSRF cookie before the first write of a context without one [OFE-019 AC1]", async () => {
    const cookies = new Map<string, string>();
    const { context, sent } = fakeContext(
      [
        { status: 200, body: { brandName: "Demo Travel" } },
        { status: 201, body: { id: "srch_1" } },
      ],
      cookies,
      (request) => {
        if (request.url.endsWith("/api/v1/storefront")) {
          cookies.set(CSRF_COOKIE, "issued");
        }
      },
    );
    await new StorefrontApi(context, "198.18.0.9").call(
      "flights.search",
      "POST",
      "/v1/flight-searches",
      {},
      201,
    );
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${STOREFRONT_URL}/api/v1/storefront`,
      `POST ${STOREFRONT_URL}/api/v1/flight-searches`,
    ]);
    expect(sent[1]?.headers["x-csrf-token"]).toBe("issued");
  });

  it("names the operation, the status and the error code of a refusal, never the body [OFE-019 AC1]", async () => {
    const { context } = fakeContext(
      [
        { status: 409, body: { error: { code: "CHECKOUT_EXPIRED", message: "secret-detail" } } },
        { status: 204 },
      ],
      new Map([[CSRF_COOKIE, "csrf-1"]]),
    );
    const api = new StorefrontApi(context, "198.18.0.1");
    const refusal = await api
      .call("checkout.create", "POST", "/v1/checkouts", {}, 201)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(StorefrontApiError);
    expect(refusal).toMatchObject({ operation: "checkout.create", status: 409, code: "CHECKOUT_EXPIRED" });
    expect(String(refusal)).toBe("StorefrontApiError: checkout.create answered 409 CHECKOUT_EXPIRED");
    // An answer without a body is no error envelope.
    await expect(api.call("auth.signOut", "POST", "/v1/auth/sign-out", {})).rejects.toThrow(
      /^auth\.signOut answered 204$/,
    );
  });

  it("reads the error code of an error envelope only [OFE-019 AC1]", () => {
    expect(errorCodeOf({ error: { code: "NOT_FOUND" } })).toBe("NOT_FOUND");
    expect(errorCodeOf({ error: { code: 404 } })).toBeUndefined();
    expect(errorCodeOf({ code: "NOT_FOUND" })).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
  });
});

/** One call of the booking seed. */
interface SeedCall {
  readonly operation: string;
  readonly method: ApiMethod;
  readonly path: string;
  readonly body: unknown;
  readonly expected: number;
  readonly extra: Readonly<Record<string, string>> | undefined;
}

/** A fake OTA API that answers the booking seed's calls like the demo OTA, or refuses `failAt`. */
function fakeSeedApi(failAt?: string): { api: SeedApi; calls: SeedCall[] } {
  const calls: SeedCall[] = [];
  const answers: Record<string, unknown> = {
    "flights.search": { id: "srch_1", offers: [{ id: "off_1" }, { id: "off_2" }] },
    "offers.price": { id: "prc_1" },
    "checkout.create": { id: "chk_1" },
    "checkout.setTravelers": { id: "chk_1" },
    "checkout.setContacts": { id: "chk_1" },
    "checkout.createPayment": { id: "pay_1", amount: { amount: "120.00", currency: "EUR" } },
    "checkout.updatePayment": { id: "pay_1", amount: { amount: "121.20", currency: "EUR" } },
    "checkout.completeWithAirlineCard": { booking: { id: "bkg_1", reference: "VXABC234" } },
  };
  const api: SeedApi = {
    call: (operation, method, path, body, expected = 200, extra) => {
      calls.push({ operation, method, path, body, expected, extra });
      if (operation === failAt) {
        return Promise.reject(new StorefrontApiError(operation, 402, "PAYMENT_DECLINED"));
      }
      return Promise.resolve(answers[operation]);
    },
  };
  return { api, calls };
}

const SEED_INPUT = Object.freeze({
  daysAhead: 45,
  traveller: { firstName: "Ada", lastName: "Seedtest", dateOfBirth: "1985-04-12", gender: "FEMALE" as const },
  email: "seed@example.com",
});

describe("bookAirlineCardTrip", () => {
  it("books through the storefront's operations in order and pays the airline's quoted total [OFE-019 AC1]", async () => {
    const { api, calls } = fakeSeedApi();
    await expect(bookAirlineCardTrip(api, SEED_INPUT)).resolves.toEqual({
      bookingId: "bkg_1",
      reference: "VXABC234",
      checkoutId: "chk_1",
      paymentId: "pay_1",
    });
    expect(calls.map(({ operation, method, path, expected }) => [operation, method, path, expected])).toEqual(
      [
        ["flights.search", "POST", "/v1/flight-searches", 201],
        ["offers.price", "POST", "/v1/priced-offers", 201],
        ["checkout.create", "POST", "/v1/checkouts", 201],
        ["checkout.setTravelers", "PUT", "/v1/checkouts/chk_1/travelers", 200],
        ["checkout.setContacts", "PUT", "/v1/checkouts/chk_1/contacts", 200],
        ["checkout.createPayment", "POST", "/v1/checkouts/chk_1/payments", 201],
        ["checkout.updatePayment", "PATCH", "/v1/payments/pay_1", 200],
        ["checkout.completeWithAirlineCard", "POST", "/v1/checkouts/chk_1/airline-card-completion", 201],
      ],
    );
    const body = (operation: string): unknown => calls.find((call) => call.operation === operation)?.body;
    expect(body("flights.search")).toEqual({
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "PAR",
      departureDate: departureDate(45),
      adults: 1,
    });
    expect(body("offers.price")).toEqual({ offerIds: ["off_1"] });
    expect(body("checkout.setTravelers")).toEqual({
      travelers: [
        {
          travelerId: "1",
          name: { firstName: "Ada", lastName: "Seedtest" },
          dateOfBirth: "1985-04-12",
          gender: "FEMALE",
        },
      ],
    });
    expect(body("checkout.setContacts")).toMatchObject({
      contacts: [{ isPrimary: true, emailAddress: "seed@example.com" }],
    });
    expect(body("checkout.createPayment")).toEqual({ method: "airline_card", termsAccepted: true });
    // The card's brand and BIN only, for the airline's fee; the completion pays the total that quote answered.
    expect(body("checkout.updatePayment")).toEqual({ card: { brand: "VISA", bin: "411111" } });
    expect(body("checkout.completeWithAirlineCard")).toMatchObject({
      paymentId: "pay_1",
      expectedTotal: { amount: "121.20", currency: "EUR" },
      card: { brand: "VISA", holderName: "Ada Seedtest", number: "4111111111111111" },
    });
    // The card number goes to the completion alone.
    const withCard = calls.filter((call) => JSON.stringify(call.body).includes("4111111111111111"));
    expect(withCard.map((call) => call.operation)).toEqual(["checkout.completeWithAirlineCard"]);
  });

  it("sends the stub's scenario with the completion alone, when one is asked for [OAD-016 AC1]", async () => {
    const plain = fakeSeedApi();
    await bookAirlineCardTrip(plain.api, SEED_INPUT);
    expect(
      plain.calls.every((call) => call.extra === undefined || Object.keys(call.extra).length === 0),
    ).toBe(true);

    const review = fakeSeedApi();
    await bookAirlineCardTrip(review.api, { ...SEED_INPUT, completionScenario: "ticketing-failed" });
    expect(
      review.calls
        .filter((call) => call.extra?.["x-stub-scenario"] !== undefined)
        .map((call) => call.operation),
    ).toEqual(["checkout.completeWithAirlineCard"]);
    expect(review.calls.at(-1)?.extra).toEqual({ "x-stub-scenario": "ticketing-failed" });
  });

  it("fails with the refusal alone, never quoting the card [OFE-019 AC1]", async () => {
    const { api } = fakeSeedApi("checkout.completeWithAirlineCard");
    const error = await bookAirlineCardTrip(api, SEED_INPUT).catch((caught: unknown) => caught);
    expect(String(error)).toBe(
      "StorefrontApiError: checkout.completeWithAirlineCard answered 402 PAYMENT_DECLINED",
    );
    expect(JSON.stringify(error)).not.toContain("4111");
  });

  it("stops with the operation's name when an answer lacks what the next step needs [OFE-019 AC1]", async () => {
    const api: SeedApi = { call: () => Promise.resolve({ offers: [] }) };
    await expect(bookAirlineCardTrip(api, SEED_INPUT)).rejects.toThrow(
      "flights.search answered without the field the next step needs",
    );
  });
});

describe("airlineTestCard and departureDate", () => {
  it("is the stub's accepted Visa test card with an expiry in the future [OFE-019 AC1]", () => {
    const card = airlineTestCard("Ada Seedtest");
    expect(card).toMatchObject({ brand: "VISA", holderName: "Ada Seedtest", number: "4111111111111111" });
    expect(card.expiryYear).toBeGreaterThan(new Date().getUTCFullYear());
  });

  it("counts days from today, never a fixed date [OFE-019 AC1]", () => {
    const now = new Date(Date.UTC(2030, 0, 31, 23, 30));
    expect(departureDate(1, now)).toBe("2030-02-01");
    expect(departureDate(0, now)).toBe("2030-01-31");
  });
});

/** A customer access token as the OTA API signs it (token.service.ts), with a key of the test's own. */
function signedToken(privateKey: Parameters<typeof sign>[2], claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "test-kid" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("agedAccessToken", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const claims = {
    typ: "customer",
    tid: "ten_01M5XN79WJM4DFVFXWB7Z3SWS3",
    sid: "ses_01M5XN79WJM4DFVFXWB7Z3SWS4",
    sub: "cus_01M5XN79WJM4DFVFXWB7Z3SWS5",
  };

  it("keeps the header and the session's claims, issues it the given age ago and signs it with the key [OFE-019 AC1]", () => {
    const now = new Date();
    const issued = Math.floor(now.getTime() / 1000);
    const token = signedToken(privateKey, { ...claims, iat: issued, exp: issued + ACCESS_TOKEN_TTL_SECONDS });
    const aged = agedAccessToken(token, pem, now, EXPIRED_TOKEN_AGE_SECONDS);

    const [header, payload, signature] = aged.split(".");
    expect(header).toBe(token.split(".")[0]);
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const iat = issued - EXPIRED_TOKEN_AGE_SECONDS;
    expect(decoded).toEqual({ ...claims, iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS });
    // Expired beyond the API's 30 s of clock skew, and still the API's own 15 minutes long.
    expect((decoded["exp"] as number) + 30).toBeLessThan(issued);
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        createPublicKey(privateKey),
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("refuses what is not a customer access token, without quoting it [OFE-019 AC1]", () => {
    const staff = signedToken(privateKey, { ...claims, typ: "staff", iat: 1, exp: 901 });
    for (const value of ["not-a-token", "a.b.c", staff, `${staff}.extra`]) {
      expect(() => agedAccessToken(value, pem, new Date(), EXPIRED_TOKEN_AGE_SECONDS)).toThrow(
        "agedAccessToken: the value is not a customer access token of the OTA API",
      );
    }
  });
});

// ---- The OTA admin's journeys (OAD-016) -------------------------------------------------------------------------------

describe("tenantSchemaOf and storefrontHostOf", () => {
  it("name an OTA's schema and storefront host after its key [OAD-016 AC1]", () => {
    expect(tenantSchemaOf("sso0a1b2c3d4e")).toBe("tenant_sso0a1b2c3d4e");
    expect(storefrontHostOf("sso0a1b2c3d4e")).toBe("sso0a1b2c3d4e.ota.example.com");
    expect(() => tenantSchemaOf("x; drop")).toThrow("not an OTA key");
  });
});

/** One request a fake `fetch` received. */
interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

/** A fake `fetch` that answers `answers` in order and records each request. */
function fakeFetch(answers: Response[]): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error(`no fake answer left for ${init.method ?? "GET"} ${url}`);
    }
    return Promise.resolve(answer);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The CSRF value storefront.get issues: 43 base64url characters. */
const CSRF = "c".repeat(43);

describe("EdgeApi", () => {
  const HOST = "sso0a1b2c3d4e.ota.example.com";
  const edge = (fetch: FetchLike) =>
    new EdgeApi(HOST, "198.18.7.7", { fetch, edgeSecret: "edge-test-secret", baseUrl: OTA_API_URL });

  it("calls the OTA API as the OTA's storefront edge, with the CSRF double submit of storefront.get on writes [OAD-016 AC1]", async () => {
    const { fetch, calls } = fakeFetch([
      json(
        200,
        { brandName: "E2E Travel" },
        { "set-cookie": `__Host-vx_csrf=${CSRF}; Path=/; Secure; SameSite=Lax` },
      ),
      json(201, { id: "srch_1" }),
      json(201, { id: "srch_2" }),
      json(200, { id: "pay_1" }),
      json(200, { data: [] }),
    ]);
    const api = edge(fetch);
    await api.call("flights.search", "POST", "/v1/flight-searches", { mode: "simple" }, 201, {
      "x-stub-scenario": "ticketing-failed",
      "x-velexis-host": "other.ota.example.com",
    });
    await api.call("flights.search", "POST", "/v1/flight-searches", {}, 201);
    await api.call("checkout.updatePayment", "PATCH", "/v1/payments/pay_1", { card: { brand: "VISA" } });
    await expect(api.call("bookings.list", "GET", "/v1/bookings")).resolves.toEqual({ data: [] });

    // storefront.get once, before the first write; then each call at the API's own address.
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${OTA_API_URL}/v1/storefront`,
      `POST ${OTA_API_URL}/v1/flight-searches`,
      `POST ${OTA_API_URL}/v1/flight-searches`,
      `PATCH ${OTA_API_URL}/v1/payments/pay_1`,
      `GET ${OTA_API_URL}/v1/bookings`,
    ]);
    const edgeHeaders = {
      accept: "application/json",
      "x-velexis-edge": "edge-test-secret",
      "x-velexis-host": HOST,
      origin: `https://${HOST}`,
      "x-forwarded-for": "198.18.7.7",
    };
    expect(calls[0]?.headers).toEqual(edgeHeaders);
    // A call's own header goes along; the edge's own headers win over one of the same name.
    const [, first, second, patch, read] = calls;
    expect(first?.headers).toMatchObject({
      ...edgeHeaders,
      "x-stub-scenario": "ticketing-failed",
      "content-type": "application/json",
      cookie: `__Host-vx_csrf=${CSRF}`,
      "x-csrf-token": CSRF,
    });
    expect(first?.body).toBe(JSON.stringify({ mode: "simple" }));
    expect(first?.headers["idempotency-key"]).toMatch(UUID);
    expect(second?.headers["idempotency-key"]).toMatch(UUID);
    expect(second?.headers["idempotency-key"]).not.toBe(first?.headers["idempotency-key"]);
    expect(second?.headers).not.toHaveProperty("x-stub-scenario");
    expect(patch?.headers).toMatchObject({ "x-csrf-token": CSRF, cookie: `__Host-vx_csrf=${CSRF}` });
    expect(patch?.headers).not.toHaveProperty("idempotency-key");
    expect(read?.headers).toEqual(edgeHeaders);
  });

  it("names the operation, the status and the error code of a refusal, never the body [OAD-016 AC1]", async () => {
    const { fetch } = fakeFetch([
      json(200, {}, { "set-cookie": `__Host-vx_csrf=${CSRF}; Path=/` }),
      json(402, { error: { code: "PAYMENT_DECLINED", message: "secret-detail" } }),
    ]);
    const refusal = await edge(fetch)
      .call(
        "checkout.completeWithAirlineCard",
        "POST",
        "/v1/checkouts/chk_1/airline-card-completion",
        {},
        201,
      )
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(StorefrontApiError);
    expect(String(refusal)).toBe(
      "StorefrontApiError: checkout.completeWithAirlineCard answered 402 PAYMENT_DECLINED",
    );
  });

  it("stops before a write when storefront.get issues no CSRF cookie [OAD-016 AC1]", async () => {
    const { fetch, calls } = fakeFetch([json(200, {})]);
    await expect(edge(fetch).call("checkout.create", "POST", "/v1/checkouts", {}, 201)).rejects.toThrow(
      "storefront.get set no __Host-vx_csrf cookie",
    );
    expect(calls).toHaveLength(1);
  });
});

describe("setCookieValue", () => {
  it("reads one cookie's value from Set-Cookie headers [OAD-016 AC1]", () => {
    const headers = ["__Host-vx_bt=bkg_1.x; Path=/; HttpOnly", `__Host-vx_csrf=${CSRF}; Path=/; Secure`];
    expect(setCookieValue(headers, "__Host-vx_csrf")).toBe(CSRF);
    expect(setCookieValue(headers, "__Host-vx_at")).toBeUndefined();
    expect(setCookieValue(["broken"], "broken")).toBeUndefined();
  });
});

describe("shiftLocal and offerDepartingIn", () => {
  const NOW = new Date(Date.UTC(2030, 0, 31, 23, 30));
  const OFFER = {
    id: "1",
    lastTicketingDate: "2031-03-01",
    itineraries: [
      {
        segments: [
          {
            departure: { iataCode: "MAD", at: "2031-03-01T06:00:00" },
            arrival: { iataCode: "LIS", at: "2031-03-01T06:25:00" },
          },
          {
            departure: { iataCode: "LIS", at: "2031-03-01T08:10:00" },
            arrival: { iataCode: "ORY", at: "2031-03-02T00:45:00" },
          },
        ],
      },
    ],
  };

  it("moves local Amadeus times and dates by whole days, their times of day kept [OAD-016 AC1]", () => {
    expect(shiftLocal("2031-03-01T06:00:00", -2)).toBe("2031-02-27T06:00:00");
    expect(shiftLocal("2031-02-28", 1)).toBe("2031-03-01");
    expect(() => shiftLocal("tomorrow", 1)).toThrow("not a local Amadeus time");
  });

  it("moves every segment of the stub's offer to depart the given days from today [OAD-016 AC1]", () => {
    const moved = offerDepartingIn(OFFER, 10, NOW) as typeof OFFER;
    // 10 days after 2030-01-31 (UTC) is 2030-02-10.
    expect(
      moved.itineraries[0]?.segments.map((segment) => [segment.departure.at, segment.arrival.at]),
    ).toEqual([
      ["2030-02-10T06:00:00", "2030-02-10T06:25:00"],
      ["2030-02-10T08:10:00", "2030-02-11T00:45:00"],
    ]);
    expect(moved.lastTicketingDate).toBe("2030-02-10");
    // The stub's offer itself is unchanged.
    expect(OFFER.itineraries[0]?.segments[0]?.departure.at).toBe("2031-03-01T06:00:00");
  });
});

describe("createStubOrder", () => {
  const OFFER = {
    type: "flight-offer",
    id: "1",
    lastTicketingDate: "2027-01-15",
    itineraries: [
      { segments: [{ departure: { at: "2027-01-15T06:00:00" }, arrival: { at: "2027-01-15T06:25:00" } }] },
    ],
  };

  it("books the stub's first offer for the office, outside Velexis and without issuing it [OAD-016 AC1]", async () => {
    const { fetch, calls } = fakeFetch([
      json(200, { access_token: "stub-token" }),
      json(200, { data: [OFFER] }),
      json(201, {
        data: {
          id: "UDVHU0dCfDIwMjYtMTAtMjk",
          associatedRecords: [{ reference: "P5GSGB", originSystemCode: "GDS" }],
        },
      }),
    ]);
    const order = await createStubOrder(
      {
        officeId: "DEV1A0006",
        traveller: { firstName: "Gita", lastName: "Terminal", dateOfBirth: "1990-06-30", gender: "FEMALE" },
        email: "gita@example.com",
        daysAhead: 58,
      },
      { fetch, baseUrl: AMADEUS_STUB_URL },
    );
    expect(order).toEqual({ id: "UDVHU0dCfDIwMjYtMTAtMjk", recordLocator: "P5GSGB" });

    const [token, search, create] = calls;
    expect(token).toMatchObject({ method: "POST", url: `${AMADEUS_STUB_URL}/v1/security/oauth2/token` });
    expect(new URLSearchParams(token?.body).get("grant_type")).toBe("client_credentials");
    const query = new URL(search?.url ?? "").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      originLocationCode: "MAD",
      destinationLocationCode: "PAR",
      departureDate: departureDate(58),
      adults: "1",
      max: "1",
    });
    expect(search?.headers["authorization"]).toBe("Bearer stub-token");
    // Flight Create Orders without `issue=true`: the order waits for its tickets, as an agent's booking does.
    expect(create?.url).toBe(`${AMADEUS_STUB_URL}/v1/booking/flight-orders`);
    expect(create?.headers).toMatchObject({
      authorization: "Bearer stub-token",
      "content-type": "application/vnd.amadeus+json",
    });
    const data = (JSON.parse(create?.body ?? "{}") as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      type: "flight-order",
      queuingOfficeId: "DEV1A0006",
      ownerOfficeId: "DEV1A0006",
      travelers: [
        {
          id: "1",
          name: { firstName: "GITA", lastName: "TERMINAL" },
          contact: { emailAddress: "gita@example.com" },
        },
      ],
    });
    const offer = (data["flightOffers"] as (typeof OFFER)[])[0];
    expect(offer?.itineraries[0]?.segments[0]?.departure.at.slice(0, 10)).toBe(departureDate(58));
    // No form of payment, so no card: the order is paid outside Velexis.
    expect(data).not.toHaveProperty("formOfPayments");
  });

  it("names the stub's operation and status when it refuses, never the body [OAD-016 AC1]", async () => {
    const { fetch } = fakeFetch([json(401, { error: "invalid_client", error_description: "secret-detail" })]);
    const failure = await createStubOrder(
      {
        officeId: "DEV1A0006",
        traveller: { firstName: "A", lastName: "B", dateOfBirth: "1990-01-01", gender: "MALE" },
        email: "a@example.com",
        daysAhead: 30,
      },
      { fetch },
    ).catch((error: unknown) => error);
    expect(String(failure)).toBe("Error: the stub's token answered 401");
  });
});

describe("STAFF_COOKIES and scriptReadableCookieNames", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("are the OTA admin's four session cookies [OAD-016 AC1]", () => {
    expect(STAFF_COOKIES).toEqual([
      "__Host-vx_staff_at",
      "__Host-vx_staff_rt",
      "__Host-vx_env",
      "__Host-vx_tenant",
    ]);
  });

  it("names the cookies a document's JavaScript reads, never their values [OAD-016 AC1]", async () => {
    // A page whose document is this process's stubbed `document`.
    const page: DocumentEvaluator = { evaluate: (fn) => Promise.resolve(fn()) };
    vi.stubGlobal("document", { cookie: "" });
    await expect(scriptReadableCookieNames(page)).resolves.toEqual([]);
    vi.stubGlobal("document", { cookie: "theme=dark; __Host-vx_csrf=secret-value" });
    await expect(scriptReadableCookieNames(page)).resolves.toEqual(["theme", "__Host-vx_csrf"]);
  });
});

describe("msUntilPastMidnight", () => {
  const OSLO = ["Europe/Oslo"] as const;
  const at = (instant: string): Date => new Date(instant);

  it("[FIX-W34-OTA AC4] waits nothing more than 3 minutes before Oslo midnight, or after it", () => {
    // 30 October 2026: Oslo is on winter time (UTC+1) since the 25th.
    expect(msUntilPastMidnight(at("2026-10-30T22:56:59.999Z"), OSLO)).toBe(0); // 23:56:59.999
    expect(msUntilPastMidnight(at("2026-10-30T12:00:00.000Z"), OSLO)).toBe(0); // 13:00
    expect(msUntilPastMidnight(at("2026-10-30T23:00:00.000Z"), OSLO)).toBe(0); // 00:00:00, the new day
    expect(msUntilPastMidnight(at("2026-10-30T23:00:03.000Z"), OSLO)).toBe(0); // 00:00:03
  });

  it("[FIX-W34-OTA AC4] waits until 00:00:05 Oslo time from 3 minutes before its midnight", () => {
    expect(msUntilPastMidnight(at("2026-10-30T22:57:00.000Z"), OSLO)).toBe(
      MIDNIGHT_GUARD_MS + PAST_MIDNIGHT_MS,
    );
    expect(msUntilPastMidnight(at("2026-10-30T22:57:00.000Z"), OSLO)).toBe(185_000);
    expect(msUntilPastMidnight(at("2026-10-30T22:58:30.250Z"), OSLO)).toBe(94_750); // 23:58:30.250
    expect(msUntilPastMidnight(at("2026-10-30T22:59:59.500Z"), OSLO)).toBe(5_500); // 23:59:59.500
    // Summer time (UTC+2): 23:58 Oslo is 21:58 UTC.
    expect(msUntilPastMidnight(at("2026-07-01T21:58:00.000Z"), OSLO)).toBe(125_000);
    expect(msUntilPastMidnight(at("2026-07-01T22:58:00.000Z"), OSLO)).toBe(0); // 00:58 Oslo
  });

  it("[FIX-W34-OTA AC4] takes every zone that decides the day: the latest midnight of the zones near one", () => {
    const zones = ["Europe/Oslo", "UTC"] as const;
    // 23:59 UTC is 00:59 in Oslo: only UTC is near its midnight.
    expect(msUntilPastMidnight(at("2026-10-30T23:59:00.000Z"), zones)).toBe(65_000);
    // 23:58 in Oslo is 22:58 UTC: only Oslo is.
    expect(msUntilPastMidnight(at("2026-10-30T22:58:00.000Z"), zones)).toBe(125_000);
    // Neither.
    expect(msUntilPastMidnight(at("2026-10-30T20:00:00.000Z"), zones)).toBe(0);
    expect(msUntilPastMidnight(at("2026-10-30T22:58:00.000Z"), [])).toBe(0);
  });

  it("[FIX-W34-OTA AC4] refuses a zone it cannot read, and its longest wait fits the hook's budget", () => {
    expect(() => msUntilPastMidnight(at("2026-10-30T22:58:00.000Z"), ["Mars/Olympus_Mons"])).toThrow(
      RangeError,
    );
    expect(MIDNIGHT_WAIT_BUDGET_MS).toBeGreaterThan(MIDNIGHT_GUARD_MS + PAST_MIDNIGHT_MS);
    expect(MIDNIGHT_WAIT_BUDGET_MS).toBeLessThanOrEqual(200_000);
  });
});

describe("edgeRequestOf", () => {
  const HOST = "sfx0a1b2c3d4e.ota.example.com";

  it("sends a storefront page's /api/ request to the OTA API as the edge of the OTA's host [OAD-017 AC1]", () => {
    expect(
      edgeRequestOf(`${STOREFRONT_URL}/api/v1/flight-searches?limit=5`, HOST, "edge-test-secret"),
    ).toEqual({
      url: `${OTA_API_URL}/v1/flight-searches?limit=5`,
      headers: { "x-velexis-edge": "edge-test-secret", "x-velexis-host": HOST, origin: `https://${HOST}` },
    });
    expect(edgeRequestOf(`${STOREFRONT_URL}/api/v1/storefront`, HOST, "s", "http://127.0.0.1:4999").url).toBe(
      "http://127.0.0.1:4999/v1/storefront",
    );
  });

  it("refuses an address that is not the preview's /api/, or a host that is not one, never naming the secret [OAD-017 AC1]", () => {
    for (const address of [
      `${STOREFRONT_URL}/search.html`,
      `${STOREFRONT_URL}/apiv1/storefront`,
      `${OTA_API_URL}/api/v1/storefront`,
    ]) {
      expect(() => edgeRequestOf(address, HOST, "edge-test-secret")).toThrow(TypeError);
    }
    expect(() =>
      edgeRequestOf(`${STOREFRONT_URL}/api/v1/storefront`, "evil.example/x", "edge-test-secret"),
    ).toThrow("not a storefront host");
    let refusal = "";
    try {
      edgeRequestOf(`${STOREFRONT_URL}/checkout.html`, HOST, "edge-test-secret");
    } catch (error) {
      refusal = String(error);
    }
    expect(refusal).toContain("is not an /api/ address of the storefront preview");
    expect(refusal).not.toContain("edge-test-secret");
  });
});

describe("serveStorefrontOf", () => {
  const HOST = "pay0a1b2c3d4e.ota.example.com";

  /** A context that keeps the route handler, and a route whose fetch and fulfil are recorded. */
  function fakeRouting() {
    let pattern = "";
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const context = {
      route: async (url: string, routeHandler: (route: unknown) => Promise<void>) => {
        pattern = url;
        handler = routeHandler;
      },
    } as unknown as RoutedContext;
    const fetched: Record<string, unknown>[] = [];
    const fulfilled: Record<string, unknown>[] = [];
    const answer = {
      headers: () => ({
        "content-type": "application/json",
        "content-length": "42",
        "set-cookie": "__Host-vx_csrf=abc; Path=/; Secure; SameSite=Lax",
        "cross-origin-opener-policy": "same-origin",
        "cache-control": "no-store",
      }),
    };
    const route = (url: string, headers: Record<string, string>) => ({
      request: () => ({ url: () => url, headers: () => headers }),
      fetch: async (options: Record<string, unknown>) => {
        fetched.push(options);
        return answer;
      },
      fulfill: async (options: Record<string, unknown>) => {
        fulfilled.push(options);
      },
    });
    return {
      context,
      fetched,
      fulfilled,
      answer,
      pattern: () => pattern,
      handle: async (url: string, headers: Record<string, string>) => {
        if (handler === undefined) {
          throw new Error("no route was registered");
        }
        await handler(route(url, headers));
      },
    };
  }

  it("answers the preview's /api/ requests from the OTA API as the OTA's edge, the browser's headers kept [OAD-017 AC1]", async () => {
    const routing = fakeRouting();
    await serveStorefrontOf(routing.context, HOST, { edgeSecret: "edge-test-secret", baseUrl: OTA_API_URL });
    expect(routing.pattern()).toBe(`${STOREFRONT_URL}/api/**`);

    await routing.handle(`${STOREFRONT_URL}/api/v1/flight-searches`, {
      accept: "application/json",
      "x-csrf-token": "abc",
      "idempotency-key": "4a7c4f9e-0000-4000-8000-000000000001",
      "x-forwarded-for": "198.18.9.9",
      // The browser cannot choose the OTA: the edge's own headers replace any of the same name.
      "x-velexis-host": "demo.ota.example.com",
      origin: STOREFRONT_URL,
    });
    expect(routing.fetched).toEqual([
      expect.objectContaining({
        url: `${OTA_API_URL}/v1/flight-searches`,
        maxRedirects: 0,
        headers: {
          accept: "application/json",
          "x-csrf-token": "abc",
          "idempotency-key": "4a7c4f9e-0000-4000-8000-000000000001",
          "x-forwarded-for": "198.18.9.9",
          "x-velexis-edge": "edge-test-secret",
          "x-velexis-host": HOST,
          origin: `https://${HOST}`,
          connection: "close",
        },
      }),
    ]);
    // The answer as it came, its cookies included, without what the preview's proxy drops or the body's old length.
    expect(routing.fulfilled).toEqual([
      {
        response: routing.answer,
        headers: {
          "content-type": "application/json",
          "set-cookie": "__Host-vx_csrf=abc; Path=/; Secure; SameSite=Lax",
          "cache-control": "no-store",
        },
      },
    ]);
  });
});

describe("STOREFRONT_SESSION_COPIES and forgetStorefrontCopies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("are the storefront's own sessionStorage keys of storefront.get and of the footer's pages [OAD-017 AC1]", () => {
    const source = (path: string): string => readFileSync(resolve(REPO_ROOT, path), "utf8");
    const config = /export const CONFIG_STORAGE_KEY = "([^"]+)";/.exec(
      source("ota/frontend/src/lib/config-cache.js"),
    )?.[1];
    const pages = /export const PAGES_STORAGE_KEY = "([^"]+)";/.exec(
      source("ota/frontend/src/components/footer.js"),
    )?.[1];
    expect([...STOREFRONT_SESSION_COPIES]).toEqual([config, pages]);
  });

  it("removes those two keys of the tab's sessionStorage and nothing else [OAD-017 AC1]", async () => {
    const stored = new Map<string, string>([
      ["vx.storefront.config", "{}"],
      ["vx.storefront.pages", "{}"],
      ["vx.storefront.currency", "EUR"],
    ]);
    vi.stubGlobal("window", { sessionStorage: { removeItem: (key: string) => stored.delete(key) } });
    const page: StorageEvaluator = {
      evaluate: async <R, A>(pageFunction: (arg: A) => R, arg: A): Promise<R> => pageFunction(arg),
    };
    await forgetStorefrontCopies(page);
    expect([...stored.keys()]).toEqual(["vx.storefront.currency"]);
  });
});

describe("the live journey's names and rules (OFE-022)", () => {
  it("[OFE-022 AC1] names a live office, the custom domain and the live plan after the OTA, and new platform ids", () => {
    expect(uniqueLiveOfficeId()).toMatch(/^E2L[0-9A-F]{6}$/);
    expect(uniqueLiveOfficeId()).not.toBe(uniqueLiveOfficeId());
    expect(customDomainOf("live0a1b2c3d4e")).toBe("book.live0a1b2c3d4e-travel.example");
    expect(livePlanCodeOf("live0a1b2c3d4e")).toBe("e2elive_live0a1b2c3d4e");
    expect(livePlanCodeOf("live0a1b2c3d4e")).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
    for (const key of ["", "Live", "x", "live-1", "evil.example"]) {
      expect(() => customDomainOf(key), key).toThrow(TypeError);
      expect(() => livePlanCodeOf(key), key).toThrow(TypeError);
    }
    expect(newPlatformId("sub")).toMatch(/^sub_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newPlatformId("dom")).toMatch(/^dom_0[0-9A-HJKMNP-TV-Z]{25}$/);
    expect(newPlatformId("sc")).toMatch(/^sc_0[0-9A-HJKMNP-TV-Z]{25}$/);
    // The preconditions the fixtures meet, as goLive names them, in its order.
    expect([...FIXTURE_PRECONDITIONS]).toEqual([
      "amadeus_live",
      "payout_account",
      "plan_live_mode",
      "subscription",
    ]);
  });

  it("[OFE-022 AC1] seals a random client secret that only its own connection row's column decrypts", async () => {
    // A key folder of this test: one KEK, `master-v1.key` (32 random bytes in base64, mode 0600), as `pnpm dev:keys` makes.
    const dir = mkdtempSync(join(tmpdir(), "e2e-keys-"));
    try {
      writeFileSync(join(dir, "master-v1.key"), randomBytes(32).toString("base64"), { mode: 0o600 });
      const keys = await LocalFileKeyProvider.fromDir(dir, "local:v1");
      const connectionId = newPlatformId("sc");
      const place = (rowId: string): string =>
        aadFor("platform", "supplier_connections", "client_secret_ciphertext", rowId);

      const sealed = await sealedClientSecret(connectionId, keys);
      expect(sealed.kekId).toBe("local:v1");
      const secret = await decryptValue(sealed.ciphertext, { aad: place(connectionId), keys });
      expect(secret.toString("utf8")).toMatch(/^[A-Za-z0-9_-]{32}$/);
      // Another row, or another column of the same row, does not decrypt it (the platform's associated data).
      await expect(
        decryptValue(sealed.ciphertext, { aad: place(newPlatformId("sc")), keys }),
      ).rejects.toThrow(DecryptionError);
      await expect(
        decryptValue(sealed.ciphertext, {
          aad: aadFor("platform", "amadeus_accounts", "client_secret_ciphertext", connectionId),
          keys,
        }),
      ).rejects.toThrow(DecryptionError);
      // Each call makes a new secret.
      const again = await decryptValue((await sealedClientSecret(connectionId, keys)).ciphertext, {
        aad: place(connectionId),
        keys,
      });
      expect(again.equals(secret)).toBe(false);
      secret.fill(0);
      again.fill(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[OFE-022 AC1] maps host names to the stack's loopback address for Chromium, refusing anything else", () => {
    expect(hostResolverRules(["live0a1b2c3d4e.ota.example.com"])).toBe(
      "--host-resolver-rules=MAP live0a1b2c3d4e.ota.example.com 127.0.0.1",
    );
    expect(hostResolverRules(["a.example", "b.example"], "127.0.0.2")).toBe(
      "--host-resolver-rules=MAP a.example 127.0.0.2, MAP b.example 127.0.0.2",
    );
    expect(() => hostResolverRules([])).toThrow(TypeError);
    for (const host of [
      "*.ota.example.com",
      "a.example, MAP b.example 10.0.0.1",
      "A.example",
      "a.example:80",
    ]) {
      expect(() => hostResolverRules([host]), host).toThrow(TypeError);
    }
  });

  it("[OFE-022 AC1] keeps goLive's status, code and missing preconditions, or the environment of its tenant, nothing more", () => {
    expect(
      goLiveAnswerOf(422, {
        error: {
          code: "LIVE_PRECONDITIONS_UNMET",
          message: "…",
          status: 422,
          requestId: "req_1",
          details: { missing: ["plan_live_mode", "subscription"] },
        },
      }),
    ).toEqual({ status: 422, code: "LIVE_PRECONDITIONS_UNMET", missing: ["plan_live_mode", "subscription"] });
    expect(goLiveAnswerOf(200, { id: "ten_1", name: "Live Travel", storefrontEnvironment: "live" })).toEqual({
      status: 200,
      storefrontEnvironment: "live",
    });
    expect(
      goLiveAnswerOf(403, { error: { code: "FEATURE_DISABLED", details: { feature: "live_switch" } } }),
    ).toEqual({
      status: 403,
      code: "FEATURE_DISABLED",
    });
    expect(goLiveAnswerOf(502, undefined)).toEqual({ status: 502 });
  });

  it("[OFE-022 AC1] calls goLive as the portal does for the owner, and answers a refusal too", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          error: { code: "LIVE_PRECONDITIONS_UNMET", details: { missing: ["subscription"] } },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    };
    const owner = {
      account: { email: "o@example.com", password: "x", fullName: "O", endUserIp: "198.18.1.2" },
      accessToken: "portal-access-token",
    };
    const answer = await goLiveAttempt(owner, "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1X", {
      bffKey: "bff-test-key",
      fetch: fetchImpl,
    });
    expect(answer).toEqual({ status: 422, code: "LIVE_PRECONDITIONS_UNMET", missing: ["subscription"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${PLATFORM_API_URL}/v1/tenants/ten_01JA2Z9W5K7Q3M8N4P6R2T0V1X/go-live`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ confirm: true }));
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer portal-access-token",
      "x-velexis-bff-key": "bff-test-key",
      "x-velexis-end-user-ip": "198.18.1.2",
    });
  });

  it("[OFE-022 AC1] reads the hosts and the environment of a storefront.get answer, and nothing from another body", () => {
    expect(
      storefrontHostsOf({
        tenantKey: "live0a1b2c3d4e",
        environment: "live",
        primaryUrl: "https://book.live0a1b2c3d4e-travel.example",
        name: "E2E Travel",
        domains: [
          { host: "live0a1b2c3d4e.ota.example.com", kind: "subdomain", primary: false },
          { host: "book.live0a1b2c3d4e-travel.example", kind: "custom", primary: true },
        ],
      }),
    ).toEqual({
      tenantKey: "live0a1b2c3d4e",
      environment: "live",
      primaryUrl: "https://book.live0a1b2c3d4e-travel.example",
      domains: [
        { host: "live0a1b2c3d4e.ota.example.com", kind: "subdomain", primary: false },
        { host: "book.live0a1b2c3d4e-travel.example", kind: "custom", primary: true },
      ],
    });
    expect(storefrontHostsOf({ error: { code: "HOST_NOT_ALLOWED" } })).toBeUndefined();
    expect(storefrontHostsOf(undefined)).toBeUndefined();
  });
});

describe("forwardedRequestOf and returnedHeadersOf", () => {
  const SUB = "http://live0a1b2c3d4e.ota.example.com:4173";
  const CUSTOM = "https://book.live0a1b2c3d4e-travel.example";
  const BROWSER = {
    accept: "application/json",
    "accept-encoding": "gzip, br",
    cookie: "__Host-vx_csrf=abc",
    "x-csrf-token": "abc",
    "idempotency-key": "4a7c4f9e-0000-4000-8000-000000000001",
    "content-type": "application/json",
    "content-length": "17",
    host: "book.live0a1b2c3d4e-travel.example",
    origin: CUSTOM,
    // The browser cannot choose the OTA or the client address: the edge's own headers replace these.
    "x-velexis-host": "demo.ota.example.com",
    "x-velexis-edge": "forged",
    "x-forwarded-for": "203.0.113.9",
    ":authority": "book.live0a1b2c3d4e-travel.example",
  };

  it("[OFE-022 AC1] sends a page's /api/ request to the OTA API as Caddy does in front of the page's own host", () => {
    expect(
      forwardedRequestOf(
        `${CUSTOM}/api/v1/flight-searches?limit=5`,
        BROWSER,
        { origin: CUSTOM, endUserIp: "198.18.3.4" },
        "edge-test-secret",
      ),
    ).toEqual({
      kind: "api",
      url: `${OTA_API_URL}/v1/flight-searches?limit=5`,
      headers: {
        accept: "application/json",
        cookie: "__Host-vx_csrf=abc",
        "x-csrf-token": "abc",
        "idempotency-key": "4a7c4f9e-0000-4000-8000-000000000001",
        "content-type": "application/json",
        "x-velexis-edge": "edge-test-secret",
        "x-velexis-host": "book.live0a1b2c3d4e-travel.example",
        origin: CUSTOM,
        "x-forwarded-for": "198.18.3.4",
      },
    });
    // The sub-domain mapped to the preview names the sub-domain to the API, its port never part of the host.
    expect(
      forwardedRequestOf(
        `${SUB}/api/v1/storefront`,
        {},
        { origin: SUB, endUserIp: "198.18.3.4" },
        "s",
        "http://127.0.0.1:4999",
      ).headers,
    ).toMatchObject({
      "x-velexis-host": "live0a1b2c3d4e.ota.example.com",
      origin: "https://live0a1b2c3d4e.ota.example.com",
    });
  });

  it("[OFE-022 AC1] takes pages and assets from the preview with a file server's headers, only where the route serves them", () => {
    expect(
      forwardedRequestOf(
        `${CUSTOM}/account/sign-in.html?next=%2Fbookings.html`,
        { ...BROWSER, accept: "text/html", "user-agent": "Chromium" },
        { origin: CUSTOM, endUserIp: "198.18.3.4", pagesFrom: STOREFRONT_URL },
        "edge-test-secret",
      ),
    ).toEqual({
      kind: "page",
      url: `${STOREFRONT_URL}/account/sign-in.html?next=%2Fbookings.html`,
      headers: { accept: "text/html", "user-agent": "Chromium" },
    });
    expect(() =>
      forwardedRequestOf(
        `${SUB}/index.html`,
        BROWSER,
        { origin: SUB, endUserIp: "198.18.3.4" },
        "edge-test-secret",
      ),
    ).toThrow("the route serves no pages");
    let refusal = "";
    try {
      forwardedRequestOf(
        `${STOREFRONT_URL}/api/v1/storefront`,
        BROWSER,
        { origin: CUSTOM, endUserIp: "198.18.3.4" },
        "edge-test-secret",
      );
    } catch (error) {
      refusal = String(error);
    }
    expect(refusal).toContain(`is not on ${CUSTOM}`);
    expect(refusal).not.toContain("edge-test-secret");
  });

  it("[OFE-022 AC1] hands an answer back without hop-by-hop and framing headers, the API's COOP dropped, each cookie kept", () => {
    const headers = {
      "content-type": "application/json",
      "content-length": "42",
      "content-encoding": "gzip",
      connection: "close",
      "cross-origin-opener-policy": "same-origin",
      "set-cookie": [
        "__Host-vx_csrf=abc; Path=/; Secure; SameSite=Lax",
        "__Host-vx_at=t; Path=/; Secure; HttpOnly",
      ],
      vary: "Origin",
    };
    expect(returnedHeadersOf("api", headers)).toEqual({
      "content-type": "application/json",
      "set-cookie":
        "__Host-vx_csrf=abc; Path=/; Secure; SameSite=Lax\n__Host-vx_at=t; Path=/; Secure; HttpOnly",
      vary: "Origin",
    });
    // A page of the preview keeps its own COOP (the airline-card page's, OADR-0017 point 3).
    expect(returnedHeadersOf("page", { "cross-origin-opener-policy": "same-origin" })).toEqual({
      "cross-origin-opener-policy": "same-origin",
    });
  });
});

describe("serveStorefrontHost", () => {
  const CUSTOM = "https://book.live0a1b2c3d4e-travel.example";

  /** A context that keeps the route handler, a route whose fulfil and abort are recorded, and a recording forwarder. */
  function fakeHostRouting(answer: ForwardedAnswer | Error) {
    let pattern = "";
    let handler: ((route: unknown) => Promise<void>) | undefined;
    const context = {
      route: async (url: string, routeHandler: (route: unknown) => Promise<void>) => {
        pattern = url;
        handler = routeHandler;
      },
    } as unknown as RoutedContext;
    const forwarded: Parameters<Forwarder>[0][] = [];
    const fulfilled: Record<string, unknown>[] = [];
    const aborted: string[] = [];
    const forward: Forwarder = async (request) => {
      forwarded.push(request);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    };
    return {
      context,
      forward,
      forwarded,
      fulfilled,
      aborted,
      pattern: () => pattern,
      handle: async (url: string, method: string, headers: Record<string, string>, body: Buffer | null) => {
        if (handler === undefined) {
          throw new Error("no route was registered");
        }
        await handler({
          request: () => ({
            url: () => url,
            method: () => method,
            allHeaders: async () => headers,
            postDataBuffer: () => body,
          }),
          fulfill: async (options: Record<string, unknown>) => {
            fulfilled.push(options);
          },
          abort: async (code: string) => {
            aborted.push(code);
          },
        });
      },
    };
  }

  it("[OFE-022 AC1] answers the origin's /api/ requests from the OTA API and its pages from the preview", async () => {
    const answer: ForwardedAnswer = {
      status: 201,
      headers: {
        "content-type": "application/json",
        "content-length": "2",
        "cross-origin-opener-policy": "same-origin",
      },
      body: Buffer.from("{}"),
    };
    const routing = fakeHostRouting(answer);
    await serveStorefrontHost(
      routing.context,
      { origin: CUSTOM, endUserIp: "198.18.5.6", pagesFrom: STOREFRONT_URL },
      { edgeSecret: "edge-test-secret", forward: routing.forward },
    );
    expect(routing.pattern()).toBe(`${CUSTOM}/**`);

    await routing.handle(
      `${CUSTOM}/api/v1/flight-searches`,
      "POST",
      { accept: "application/json" },
      Buffer.from("{}"),
    );
    await routing.handle(`${CUSTOM}/search.html`, "GET", { accept: "text/html" }, null);
    expect(routing.forwarded).toEqual([
      expect.objectContaining({
        kind: "api",
        method: "POST",
        url: `${OTA_API_URL}/v1/flight-searches`,
        body: Buffer.from("{}"),
      }),
      expect.objectContaining({
        kind: "page",
        method: "GET",
        url: `${STOREFRONT_URL}/search.html`,
        body: null,
      }),
    ]);
    expect(routing.forwarded[0]?.headers).toMatchObject({
      "x-velexis-edge": "edge-test-secret",
      "x-velexis-host": "book.live0a1b2c3d4e-travel.example",
      "x-forwarded-for": "198.18.5.6",
    });
    expect(routing.fulfilled[0]).toEqual({
      status: 201,
      headers: { "content-type": "application/json" },
      body: answer.body,
    });
    expect(routing.fulfilled[1]).toEqual({
      status: 201,
      headers: { "content-type": "application/json", "cross-origin-opener-policy": "same-origin" },
      body: answer.body,
    });
    expect(routing.aborted).toEqual([]);
  });

  it("[OFE-022 AC1] routes only /api/ of an origin the preview serves itself, and fails a request whose target is gone", async () => {
    const routing = fakeHostRouting(new Error("connect ECONNREFUSED 127.0.0.1:4000"));
    const sub = "http://live0a1b2c3d4e.ota.example.com:4173";
    await serveStorefrontHost(
      routing.context,
      { origin: sub, endUserIp: "198.18.5.6" },
      { edgeSecret: "s", forward: routing.forward },
    );
    expect(routing.pattern()).toBe(`${sub}/api/**`);
    await routing.handle(`${sub}/api/v1/storefront`, "GET", {}, null);
    expect(routing.fulfilled).toEqual([]);
    expect(routing.aborted).toEqual(["connectionrefused"]);
  });
});

describe("ConsoleApi and signInStaffWithApi (FIX-W46-OTA)", () => {
  const KEY = `sk_test_${"k".repeat(40)}`;
  const TOKEN = "eyJ.staff.token";

  it("[FIX-W46-OTA AC2] calls the console with the secret key and the end user, then the staff session's token", async () => {
    const { fetch, calls } = fakeFetch([
      json(200, { session: { accessToken: TOKEN, refreshToken: "rt_x" }, staff: {} }),
      json(201, { id: "stp_1" }),
      json(200, { data: [] }),
    ]);
    const api = new ConsoleApi(KEY, "198.18.9.9", { fetch, baseUrl: OTA_API_URL });
    await api.signIn("ptk_portal");
    await expect(
      api.call("consoleCreateStorefrontPage", "POST", "/v1/console/settings/pages", { slug: "a" }, 201),
    ).resolves.toEqual({ id: "stp_1" });
    await expect(
      api.call("consoleListStorefrontPages", "GET", "/v1/console/settings/pages"),
    ).resolves.toEqual({
      data: [],
    });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${OTA_API_URL}/v1/console/auth/sign-in`,
      `POST ${OTA_API_URL}/v1/console/settings/pages`,
      `GET ${OTA_API_URL}/v1/console/settings/pages`,
    ]);
    const base = {
      accept: "application/json",
      "x-api-key": KEY,
      "x-velexis-end-user-ip": "198.18.9.9",
      "x-velexis-end-user-agent": "velexis-e2e",
    };
    const [signIn, create, list] = calls;
    expect(signIn?.headers).toEqual({
      ...base,
      "content-type": "application/json",
      "idempotency-key": expect.stringMatching(UUID),
    });
    expect(signIn?.body).toBe(JSON.stringify({ grantType: "portal_token", portalToken: "ptk_portal" }));
    expect(create?.headers).toEqual({
      ...base,
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": expect.stringMatching(UUID),
    });
    expect(create?.headers["idempotency-key"]).not.toBe(signIn?.headers["idempotency-key"]);
    expect(list?.headers).toEqual({ ...base, authorization: `Bearer ${TOKEN}` });
  });

  it("[FIX-W46-OTA AC2] names the operation, the status and the code of a refusal, never the key, the token or the body", async () => {
    const { fetch } = fakeFetch([
      json(200, { session: { accessToken: TOKEN } }),
      json(403, { error: { code: "FORBIDDEN", message: `secret-detail ${KEY}` } }),
      json(200, { session: {} }),
    ]);
    const api = new ConsoleApi(KEY, "198.18.9.9", { fetch, baseUrl: OTA_API_URL });
    await api.signIn("ptk_portal");
    const refusal = await api
      .call("consoleCreateStorefrontPage", "POST", "/v1/console/settings/pages", {}, 201)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(StorefrontApiError);
    expect(String(refusal)).toBe("StorefrontApiError: consoleCreateStorefrontPage answered 403 FORBIDDEN");
    expect(String(refusal)).not.toContain(KEY);
    // A sign-in that answers no session is refused here, not later.
    await expect(
      new ConsoleApi(KEY, "198.18.9.9", { fetch, baseUrl: OTA_API_URL }).signIn("ptk_x"),
    ).rejects.toThrow("console.auth.signIn answered without a session");
  });

  it("[FIX-W46-OTA AC2] signs the owner in through createApiKey, createConsoleToken and console.auth.signIn only", async () => {
    const platformCalls: ApiCall[] = [];
    const platform = async <T>(call: ApiCall): Promise<T> => {
      platformCalls.push(call);
      const answers: Record<string, unknown> = {
        createApiKey: { apiKey: { id: "key_1", kind: "secret", scopes: ["console"] }, key: KEY },
        createConsoleToken: {
          portalToken: "ptk_owner",
          expiresAt: "2026-11-10T12:01:00Z",
          consoleSsoUrl: "x",
        },
      };
      return await Promise.resolve(answers[call.operation] as T);
    };
    const { fetch, calls } = fakeFetch([json(200, { session: { accessToken: TOKEN } }), json(200, {})]);
    const owner = {
      account: { email: "o@example.com", password: "p", fullName: "O", endUserIp: "198.18.0.9" },
      accessToken: "owner-token",
    };
    const api = await signInStaffWithApi(
      { owner, ota: { id: "ten_01JA2Z9W5K7Q3M8N4P6R2T0V1X" } as never },
      { platform, fetch, baseUrl: OTA_API_URL, endUserIp: "198.18.9.10" },
    );
    expect(platformCalls).toEqual([
      {
        operation: "createApiKey",
        method: "POST",
        path: "/v1/tenants/ten_01JA2Z9W5K7Q3M8N4P6R2T0V1X/api-keys",
        endUserIp: "198.18.0.9",
        accessToken: "owner-token",
        body: STAFF_CONSOLE_KEY,
      },
      {
        operation: "createConsoleToken",
        method: "POST",
        path: "/v1/tenants/ten_01JA2Z9W5K7Q3M8N4P6R2T0V1X/console-token",
        endUserIp: "198.18.0.9",
        accessToken: "owner-token",
      },
    ]);
    // A test secret key scoped `console`: console calls with a staff token only (no permission of its own).
    expect(STAFF_CONSOLE_KEY).toEqual({
      name: "E2E console server",
      kind: "secret",
      environment: "test",
      scopes: ["console"],
    });
    expect(calls[0]?.body).toBe(JSON.stringify({ grantType: "portal_token", portalToken: "ptk_owner" }));
    expect(calls[0]?.headers).toMatchObject({ "x-api-key": KEY, "x-velexis-end-user-ip": "198.18.9.10" });
    await api.call("consoleGetMe", "GET", "/v1/console/auth/me");
    expect(calls[1]?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "x-api-key": KEY });
  });
});

describe("moveBookingIntoLive (FIX-W46-OTA)", () => {
  const BOOKING = { bookingId: "bkg_1", paymentId: "pay_1", checkoutId: "chk_1" };

  /**
   * `tenantTx` of @velexis/db on a fake pool: every statement recorded (whitespace collapsed), an UPDATE answered with
   * the row count `rowCounts` gives its table.
   */
  function fakeTenantTx(rowCounts: Readonly<Record<string, number>>): {
    readonly run: TenantTxRunner;
    readonly statements: Array<{ readonly sql: string; readonly values: readonly unknown[] }>;
  } {
    const statements: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        statements.push({ sql: text.replace(/\s+/g, " ").trim(), values });
        const table = /^update "(\w+)"/.exec(text)?.[1];
        return await Promise.resolve(
          table === undefined
            ? { command: "SELECT", rowCount: 0, rows: [] }
            : { command: "UPDATE", rowCount: rowCounts[table] ?? 0, rows: [] },
        );
      },
      release: () => undefined,
    };
    const pool = { connect: async () => await Promise.resolve(client), end: async () => undefined };
    // `production`: no search_path leak guard, whose query a fake pool would have to answer.
    const db = createTenantDb(pool as never, { appEnv: "production" });
    return { run: (schema, fn) => tenantTx(db, schema, fn), statements };
  }

  it("[FIX-W46-OTA AC2] moves the booking, its payments and its checkout into live in one tenant transaction", async () => {
    const { run, statements } = fakeTenantTx({ bookings: 1, payments: 2, checkouts: 1 });
    await moveBookingIntoLive("tenant_liv0a1b2c3d4e", BOOKING, run);
    expect(statements.map((statement) => statement.sql)).toEqual([
      "begin",
      "SELECT set_config('search_path', $1, true)",
      "SELECT set_config('statement_timeout', $1, true)",
      'update "bookings" set "environment" = $1, "updated_at" = now() where "id" = $2 and "environment" = $3',
      'update "payments" set "environment" = $1 where ("booking_id" = $2 or "id" = $3) and "environment" = $4',
      'update "checkouts" set "environment" = $1 where "id" = $2 and "environment" = $3',
      "commit",
    ]);
    expect(statements[1]?.values).toEqual(["tenant_liv0a1b2c3d4e, reference"]);
    expect(statements.slice(3, 6).map((statement) => statement.values)).toEqual([
      ["live", "bkg_1", "test"],
      ["live", "bkg_1", "pay_1", "test"],
      ["live", "chk_1", "test"],
    ]);
  });

  it("[FIX-W46-OTA AC2] rolls back and throws when the booking is not a test booking, or has no payment or checkout to move", async () => {
    const missing = fakeTenantTx({ bookings: 0, payments: 1, checkouts: 1 });
    await expect(moveBookingIntoLive("tenant_liv0a1b2c3d4e", BOOKING, missing.run)).rejects.toThrow(
      "the OTA has no test booking bkg_1",
    );
    expect(missing.statements.map((statement) => statement.sql.split(" ")[0])).toEqual([
      "begin",
      "SELECT",
      "SELECT",
      "update",
      "rollback",
    ]);
    for (const rowCounts of [
      { bookings: 1, payments: 0, checkouts: 1 },
      { bookings: 1, payments: 1, checkouts: 0 },
    ]) {
      const partial = fakeTenantTx(rowCounts);
      await expect(moveBookingIntoLive("tenant_liv0a1b2c3d4e", BOOKING, partial.run)).rejects.toThrow(
        "the test booking bkg_1 has no test payment or no test checkout to move",
      );
      expect(partial.statements.at(-1)?.sql).toBe("rollback");
    }
    // The schema is checked before any SQL.
    const refused = fakeTenantTx({});
    await expect(moveBookingIntoLive("public", BOOKING, refused.run)).rejects.toThrow();
    expect(refused.statements).toEqual([]);
  });
});
