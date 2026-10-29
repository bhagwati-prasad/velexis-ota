// The pure helpers of support/ota.ts (OFE-008, OFE-019). The database and Redis helpers run in the storefront journeys
// (specs/storefront/search.e2e.ts, account-bookings.e2e.ts, keyboard-checkout.e2e.ts), against the stack's own
// database; the API client and the booking seed run here against a fake browser context and a fake API.
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  agedAccessToken,
  airlineTestCard,
  bookAirlineCardTrip,
  customerScopeLeaks,
  DEMO_TENANT_SCHEMA,
  departureDate,
  errorCodeOf,
  EXPIRED_TOKEN_AGE_SECONDS,
  newTenantId,
  searchIdOf,
  StorefrontApi,
  StorefrontApiError,
  type ApiMethod,
  type SeedApi,
  type StorefrontApiContext,
} from "../support/ota";
import { STOREFRONT_URL } from "../support/stack";
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
    call: (operation, method, path, body, expected = 200) => {
      calls.push({ operation, method, path, body, expected });
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
