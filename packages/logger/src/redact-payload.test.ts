import { describe, expect, it } from "vitest";
import { maskPan } from "./mask.js";
import { REDACT_CENSOR } from "./redact-paths.js";
import { CIRCULAR_REFERENCE, redactPayload } from "./redact-payload.js";

// Test data only: Visa's documented test PAN and a made-up password and token.
const TEST_PAN = "4111111111111111";
const TEST_CVV = "123";
const TEST_PASSWORD = "Hunter2!";
const TEST_TOKEN = "test-only-token-0a1b2c3d4e5f";

type Json = Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** An Amadeus Flight Create Orders request body with an airline-card form of payment. */
function createOrderBody(): Json {
  return {
    data: {
      type: "flight-order",
      flightOffers: [{ type: "flight-offer", id: "1" }],
      travelers: [
        {
          id: "1",
          name: { firstName: "JORGE", lastName: "GONZALES" },
          documents: [
            {
              documentType: "PASSPORT",
              number: "00000000X1234",
              birthPlace: "Madrid",
              issuanceLocation: "Madrid",
              issuanceCountry: "ES",
              nationality: "ES",
              expiryDate: "2030-04-14",
            },
          ],
          discountEligibility: [
            { subType: "SPANISH_RESIDENT", cardNumber: "12568215Z", certificateNumber: "12568216Y" },
          ],
        },
      ],
      formOfPayments: [
        {
          creditCard: {
            brand: "VISA",
            holder: "JORGE GONZALES",
            number: TEST_PAN,
            expiryDate: "2030-12",
            securityCode: TEST_CVV,
            flightOfferIds: ["1"],
          },
        },
      ],
    },
  };
}

describe("redactPayload", () => {
  it("keeps 1111 of an Amadeus formOfPayments[0].creditCard number, removes securityCode and leaves the input unchanged [X-003 AC3]", () => {
    const input = createOrderBody();
    const snapshot = structuredClone(input);
    deepFreeze(input);

    const output = redactPayload(input);

    expect(input).toEqual(snapshot);
    expect(output).not.toBe(input);
    const data = output["data"] as Json;
    // The holder and the expiry go too since FIX-W29-SECURITY (lead decision (1) of 2026-10-24): brand and last 4 stay.
    expect(data["formOfPayments"]).toEqual([
      {
        creditCard: {
          brand: "VISA",
          number: "1111",
          flightOfferIds: ["1"],
        },
      },
    ]);
    expect(JSON.stringify(output)).not.toContain(TEST_PAN);
    expect(JSON.stringify(output)).not.toContain("securityCode");
  });

  it("drops a card's holder and expiry in every spelling, in a card and anywhere below formOfPayments, at any depth [FIX-W29-SECURITY AC2]", () => {
    // What Amadeus echoes of the card it charged (number masked by Amadeus), the airline-card body's spellings, a
    // virtual card of a B2B wallet, and a holder nested deeper inside a form of payment.
    const formOfPayments = (): Json[] => [
      {
        creditCard: {
          brand: "VISA",
          holder: "JORGE GONZALES",
          number: "XXXXXXXXXXXX1111",
          expiryDate: "2030-12",
          flightOfferIds: ["1"],
        },
      },
      {
        b2bWallet: {
          cardId: "1",
          virtualCreditCardDetails: { brand: "VISA", holder: "JORGE GONZALES", expiry_date: "2030-12" },
          reportingData: [{ name: "holder", value: "x" }],
        },
      },
      {
        other: {
          method: "ACCOUNT",
          payer: { holderName: "JORGE GONZALES", expiryMonth: 12, expiryYear: 2030 },
        },
      },
    ];
    const kept: Json[] = [
      { creditCard: { brand: "VISA", number: "1111", flightOfferIds: ["1"] } },
      {
        b2bWallet: {
          cardId: "1",
          virtualCreditCardDetails: { brand: "VISA" },
          reportingData: [{ name: "holder", value: "x" }],
        },
      },
      { other: { method: "ACCOUNT", payer: {} } },
    ];
    const input = deepFreeze({
      // An order's data as order_snapshot keeps it, the column bookings.form_of_payments, a reply nested deeper
      // (supplier_requests.response_body), a card outside a form of payment, and the completion body's card.
      data: { type: "flight-order", id: "eJzTd9f3NjIJdgMADeQCtg", formOfPayments: formOfPayments() },
      form_of_payments: formOfPayments(),
      reply: { body: { data: { formOfPayments: formOfPayments() } } },
      payment: {
        creditCard: { brand: "VISA", holder: "JORGE GONZALES", expiryDate: "2030-12", number: TEST_PAN },
      },
      card: {
        brand: "VISA",
        holderName: "Jorge Gonzales",
        number: TEST_PAN,
        expiryMonth: 12,
        expiryYear: 2030,
      },
    });

    const output = redactPayload(input);

    expect(output).toEqual({
      data: { type: "flight-order", id: "eJzTd9f3NjIJdgMADeQCtg", formOfPayments: kept },
      form_of_payments: kept,
      reply: { body: { data: { formOfPayments: kept } } },
      payment: { creditCard: { brand: "VISA", number: "1111" } },
      card: { brand: "VISA", number: "1111" },
    });
    const text = JSON.stringify(output);
    for (const value of ["JORGE GONZALES", "Jorge Gonzales", "2030-12", "2030", TEST_PAN]) {
      expect(text).not.toContain(value);
    }
    expect(redactPayload(output)).toEqual(output);
  });

  it("drops a holder and an expiry nested inside a card, in a form of payment and outside one [FIX-W29-SECURITY AC2]", () => {
    // A card that carries the holder and the expiry one or two objects further down (an issuer's or a 3-D Secure
    // block), below formOfPayments and as a card of its own: neither copy keeps them.
    const nested = (): Json => ({
      brand: "VISA",
      number: TEST_PAN,
      paymentOperationContext: {
        interactionCondition: "ECOMMERCE",
        cardholder: { holder: "JORGE GONZALES", holderName: "Jorge Gonzales", expiry_date: "2030-12" },
      },
      issuer: { expiryMonth: 12, expiryYear: 2030, country: "ES" },
      flightOfferIds: ["1"],
    });
    const kept: Json = {
      brand: "VISA",
      number: "1111",
      paymentOperationContext: { interactionCondition: "ECOMMERCE", cardholder: {} },
      issuer: { country: "ES" },
      flightOfferIds: ["1"],
    };

    const output = redactPayload(
      deepFreeze({ data: { formOfPayments: [{ creditCard: nested() }] }, payment: { card: nested() } }),
    );

    expect(output).toEqual({ data: { formOfPayments: [{ creditCard: kept }] }, payment: { card: kept } });
    const text = JSON.stringify(output);
    for (const value of ["JORGE GONZALES", "Jorge Gonzales", "2030-12", "2030", TEST_PAN]) {
      expect(text).not.toContain(value);
    }
  });

  it("keeps the expiry of an identity document and the holder flag of a traveller document [FIX-W29-SECURITY AC2]", () => {
    const traveler = {
      documents: [{ documentType: "PASSPORT", number: "PX48213579", expiryDate: "2030-04-14", holder: true }],
    };

    expect(redactPayload({ travelers: [traveler] })).toEqual({
      travelers: [
        { documents: [{ documentType: "PASSPORT", number: "3579", expiryDate: "2030-04-14", holder: true }] },
      ],
    });
  });

  it("returns a deep copy that shares no object with the input [X-003 AC3]", () => {
    const input = createOrderBody();
    const output = redactPayload(input);
    const inputData = input["data"] as Json;
    const outputData = output["data"] as Json;
    expect(outputData).not.toBe(inputData);
    expect(outputData["flightOffers"]).not.toBe(inputData["flightOffers"]);
    expect(outputData["flightOffers"]).toEqual(inputData["flightOffers"]);
    (outputData["flightOffers"] as Json[]).push({ id: "2" });
    expect(inputData["flightOffers"]).toHaveLength(1);
  });

  it("masks identity documents and resident discount numbers to their last 4 characters (db README §8)", () => {
    const output = redactPayload(createOrderBody());
    const [traveler] = (output["data"] as { travelers: Json[] }).travelers;
    expect(traveler?.["documents"]).toEqual([
      {
        documentType: "PASSPORT",
        number: "1234",
        issuanceCountry: "ES",
        nationality: "ES",
        expiryDate: "2030-04-14",
      },
    ]);
    expect(traveler?.["discountEligibility"]).toEqual([
      { subType: "SPANISH_RESIDENT", cardNumber: "215Z", certificateNumber: "216Y" },
    ]);
  });

  it("masks formOfIdentifications[].number to its last 4 characters, like documents[].number, at any depth [FIX-W26-SECURITY AC4]", () => {
    // Test values only: made-up passport, identity card and driving licence numbers of an Amadeus flight order.
    const identifications = (): Json[] => [
      {
        identificationType: "PASSPORT",
        carrierCode: "IB",
        number: "PX48213579",
        travelerIds: ["1"],
        flightOfferIds: ["1"],
      },
      { identificationType: "NATIONAL_IDENTITY_CARD", number: " ID20746135 ", travelerIds: ["2"] },
      { identificationType: "DRIVERS_LICENSE", number: 90817263, travelerIds: ["3"] },
      { identificationType: "OTHER_ID", number: "X12" },
      { identificationType: "TICKET", travelerIds: ["1"] },
    ];
    const masked: Json[] = [
      {
        identificationType: "PASSPORT",
        carrierCode: "IB",
        number: "3579",
        travelerIds: ["1"],
        flightOfferIds: ["1"],
      },
      { identificationType: "NATIONAL_IDENTITY_CARD", number: "6135", travelerIds: ["2"] },
      { identificationType: "DRIVERS_LICENSE", number: "7263", travelerIds: ["3"] },
      { identificationType: "OTHER_ID", number: "X12" },
      { identificationType: "TICKET", travelerIds: ["1"] },
    ];
    const input = deepFreeze({
      // A Flight Order Management answer's data, as order_snapshot and supplier_requests keep it ...
      data: { type: "flight-order", id: "eJzTd9f3NjIJdgMADeQCtg", formOfIdentifications: identifications() },
      // ... nested deeper (a reply inside another object), under the column's name, and as a single object.
      reply: { body: { data: { formOfIdentifications: identifications() } } },
      form_of_identifications: identifications(),
      FormOfIdentifications: { identificationType: "PASSPORT", number: "PX48213579" },
    });

    const output = redactPayload(input);

    expect(output).toEqual({
      data: { type: "flight-order", id: "eJzTd9f3NjIJdgMADeQCtg", formOfIdentifications: masked },
      reply: { body: { data: { formOfIdentifications: masked } } },
      form_of_identifications: masked,
      FormOfIdentifications: { identificationType: "PASSPORT", number: "3579" },
    });
    for (const full of ["PX48213579", "ID20746135", "90817263"]) {
      expect(JSON.stringify(output)).not.toContain(full);
    }
    // Masking a masked copy again changes nothing (OBE-062's keptOrderDataOf cuts the numbers once more).
    expect(redactPayload(output)).toEqual(output);
  });

  it("drops securityCode, cvc and cvv wherever they appear", () => {
    const output = redactPayload({
      card: { number: "4111 1111 1111 1111", cvc: TEST_CVV },
      payment: { card: { number: TEST_PAN, cvv: TEST_CVV, security_code: TEST_CVV } },
      securityCode: TEST_CVV,
    });
    expect(output).toEqual({ card: { number: "1111" }, payment: { card: { number: "1111" } } });
  });

  it("replaces password, token, secret and apiKey fields with [REDACTED]", () => {
    const output = redactPayload({
      email: "a@example.com",
      password: TEST_PASSWORD,
      newPassword: TEST_PASSWORD,
      accessToken: TEST_TOKEN,
      refresh_token: TEST_TOKEN,
      bookingToken: TEST_TOKEN,
      clientSecret: TEST_TOKEN,
      secret: { nested: TEST_TOKEN },
      apiKey: TEST_TOKEN,
      mfaCode: "123456",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        Cookie: `__Host-session=${TEST_TOKEN}`,
        "X-Api-Key": TEST_TOKEN,
        "x-csrf-token": TEST_TOKEN,
        "x-velexis-edge": TEST_TOKEN,
        accept: "application/json",
      },
    });
    expect(output).toEqual({
      email: "a@example.com",
      password: REDACT_CENSOR,
      newPassword: REDACT_CENSOR,
      accessToken: REDACT_CENSOR,
      refresh_token: REDACT_CENSOR,
      bookingToken: REDACT_CENSOR,
      clientSecret: REDACT_CENSOR,
      secret: REDACT_CENSOR,
      apiKey: REDACT_CENSOR,
      mfaCode: REDACT_CENSOR,
      headers: {
        Authorization: REDACT_CENSOR,
        Cookie: REDACT_CENSOR,
        "X-Api-Key": REDACT_CENSOR,
        "x-csrf-token": REDACT_CENSOR,
        "x-velexis-edge": REDACT_CENSOR,
        accept: "application/json",
      },
    });
    expect(JSON.stringify(output)).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(output)).not.toContain(TEST_PASSWORD);
  });

  it("replaces the platform's secrets, bank numbers, recovery codes and otpauth URLs with [REDACTED] (platform architecture §8)", () => {
    // Test values only: a made-up IBAN, account number, TOTP secret and recovery codes.
    const iban = "XX00TEST0000111122223333";
    const accountNumber = "000123456789";
    const totpSecret = "TESTTOTPSECRETAAAAAAAAAAAAAAAAAA";
    const output = redactPayload({
      before: {
        holderName: "Acme Travel SL",
        iban,
        account_number: accountNumber,
        last4: "3333",
        bic: "TESTXXYY",
      },
      after: { IBAN: iban, AccountNumber: accountNumber },
      secretKey: `sk_test_${TEST_TOKEN}`,
      webhookSecret: `whsec_${TEST_TOKEN}`,
      totpSecret,
      otpauthUrl: `otpauth://totp/Velexis:anna%40example.com?secret=${totpSecret}`,
      recoveryCode: "TEST-AAAA-BBBB-CCCC",
      recoveryCodes: ["TEST-AAAA-BBBB-CCCC", "TEST-DDDD-EEEE-FFFF"],
      mfaChallengeToken: TEST_TOKEN,
      invitationToken: TEST_TOKEN,
    });
    expect(output).toEqual({
      before: {
        holderName: "Acme Travel SL",
        iban: REDACT_CENSOR,
        account_number: REDACT_CENSOR,
        last4: "3333",
        // A bank number since FIX-W35-PLATFORM (lead decision (2h) of 2026-10-30): it stayed visible before.
        bic: REDACT_CENSOR,
      },
      after: { IBAN: REDACT_CENSOR, AccountNumber: REDACT_CENSOR },
      secretKey: REDACT_CENSOR,
      webhookSecret: REDACT_CENSOR,
      totpSecret: REDACT_CENSOR,
      otpauthUrl: REDACT_CENSOR,
      recoveryCode: REDACT_CENSOR,
      recoveryCodes: REDACT_CENSOR,
      mfaChallengeToken: REDACT_CENSOR,
      invitationToken: REDACT_CENSOR,
    });
    for (const value of [iban, accountNumber, totpSecret, TEST_TOKEN, "TEST-AAAA", "TESTXXYY"]) {
      expect(JSON.stringify(output)).not.toContain(value);
    }
  });

  it("replaces bic, routingNumber, routing_number and account_number like iban and accountNumber, in nested objects and arrays [FIX-W35-PLATFORM AC2]", () => {
    // Test values only: a made-up IBAN, BIC, account number and routing number.
    const iban = "XX00TEST0000111122223333";
    const bic = "TESTXXYYZZZ";
    const accountNumber = "000123456789";
    const routingNumber = "000000000";
    const input = deepFreeze({
      payoutAccount: { scheme: "iban", iban, bic, last4: "3333" },
      local: { scheme: "local", accountNumber, routingNumber, last4: "6789" },
      snake: { account_number: accountNumber, routing_number: routingNumber },
      shouty: { BIC: bic, "ROUTING-NUMBER": routingNumber, Account_Number: accountNumber },
      history: [
        { version: 1, details: { iban, bic } },
        { version: 2, details: [{ accountNumber, routingNumber }, { routing_number: routingNumber }] },
      ],
      bic,
      routingNumber,
      routing_number: routingNumber,
      account_number: accountNumber,
      bankCountry: "GB",
    });
    const output = redactPayload(input);
    expect(output).toEqual({
      payoutAccount: { scheme: "iban", iban: REDACT_CENSOR, bic: REDACT_CENSOR, last4: "3333" },
      local: { scheme: "local", accountNumber: REDACT_CENSOR, routingNumber: REDACT_CENSOR, last4: "6789" },
      snake: { account_number: REDACT_CENSOR, routing_number: REDACT_CENSOR },
      shouty: { BIC: REDACT_CENSOR, "ROUTING-NUMBER": REDACT_CENSOR, Account_Number: REDACT_CENSOR },
      history: [
        { version: 1, details: { iban: REDACT_CENSOR, bic: REDACT_CENSOR } },
        {
          version: 2,
          details: [
            { accountNumber: REDACT_CENSOR, routingNumber: REDACT_CENSOR },
            { routing_number: REDACT_CENSOR },
          ],
        },
      ],
      bic: REDACT_CENSOR,
      routingNumber: REDACT_CENSOR,
      routing_number: REDACT_CENSOR,
      account_number: REDACT_CENSOR,
      bankCountry: "GB",
    });
    for (const value of [iban, bic, accountNumber, routingNumber]) {
      expect(JSON.stringify(output)).not.toContain(value);
    }
    // A bank number given as an object or a list is censored whole, like an IBAN.
    expect(redactPayload({ bic: { code: bic }, routingNumber: [routingNumber], iban: [iban] })).toEqual({
      bic: REDACT_CENSOR,
      routingNumber: REDACT_CENSOR,
      iban: REDACT_CENSOR,
    });
  });

  it("replaces an e-mail's secret variables and its links with tokens with [REDACTED] (PBE-011)", () => {
    const output = redactPayload({
      template: "team.invitation",
      secretData: { acceptUrl: `https://platform.example.com/invitations/accept?token=${TEST_TOKEN}` },
      links: {
        verifyUrl: `https://platform.example.com/verify-email?token=${TEST_TOKEN}`,
        reset_url: `https://platform.example.com/reset-password?token=${TEST_TOKEN}`,
        AcceptUrl: `https://platform.example.com/invitations/accept?token=${TEST_TOKEN}`,
        portalUrl: "https://platform.example.com",
      },
    });

    expect(output).toEqual({
      template: "team.invitation",
      secretData: REDACT_CENSOR,
      links: {
        verifyUrl: REDACT_CENSOR,
        reset_url: REDACT_CENSOR,
        AcceptUrl: REDACT_CENSOR,
        portalUrl: "https://platform.example.com",
      },
    });
    expect(JSON.stringify(output)).not.toContain(TEST_TOKEN);
  });

  it("replaces code and state anywhere below mfa or oauth and keeps every other code", () => {
    const output = redactPayload({
      mfa: { mfaChallengeToken: TEST_TOKEN, code: "918273" },
      oauth: {
        state: `state-${TEST_TOKEN}`,
        query: { code: `ac_${TEST_TOKEN}` },
        attempts: [{ code: "x1" }],
      },
      code: "VALIDATION_FAILED",
      error: { code: "CONNECT_STATE_INVALID", state: "failed" },
      account: { mfa: true },
    });
    expect(output).toEqual({
      mfa: { mfaChallengeToken: REDACT_CENSOR, code: REDACT_CENSOR },
      oauth: { state: REDACT_CENSOR, query: { code: REDACT_CENSOR }, attempts: [{ code: REDACT_CENSOR }] },
      code: "VALIDATION_FAILED",
      error: { code: "CONNECT_STATE_INVALID", state: "failed" },
      account: { mfa: true },
    });
  });

  it("handles arrays at the top level and inside objects", () => {
    const output = redactPayload([
      { creditCard: { number: TEST_PAN, securityCode: TEST_CVV } },
      [{ card: { number: 4111111111111111 } }],
      "plain",
      42,
      null,
    ]);
    expect(output).toEqual([
      { creditCard: { number: "1111" } },
      [{ card: { number: "1111" } }],
      "plain",
      42,
      null,
    ]);
  });

  it("does not loop on cycles and replaces the back reference", () => {
    const node: Json = { id: "bkg_01", creditCard: { number: TEST_PAN } };
    node["self"] = node;
    node["list"] = [node];
    const shared = { id: "shared" };

    const output = redactPayload({ node, a: shared, b: shared });

    expect(output).toEqual({
      node: {
        id: "bkg_01",
        creditCard: { number: "1111" },
        self: CIRCULAR_REFERENCE,
        list: [CIRCULAR_REFERENCE],
      },
      a: { id: "shared" },
      b: { id: "shared" },
    });
    expect(() => JSON.stringify(output)).not.toThrow();
  });

  it("redacts what JSON.stringify would persist and copies dates", () => {
    const createdAt = new Date("2026-10-13T08:00:00.000Z");
    const card = { toJSON: () => ({ number: TEST_PAN, securityCode: TEST_CVV }) };
    const output = redactPayload({ createdAt, card, label: "x" });
    expect(output.createdAt).toEqual(createdAt);
    expect(output.createdAt).not.toBe(createdAt);
    expect(output.card).toEqual({ number: "1111" });
  });

  it("keeps a __proto__ key as data", () => {
    const input = JSON.parse('{"__proto__": {"password": "x"}, "id": "1"}') as Json;
    const output = redactPayload(input);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.keys(output)).toEqual(["__proto__", "id"]);
    expect(Object.getOwnPropertyDescriptor(output, "__proto__")?.value).toEqual({ password: REDACT_CENSOR });
  });

  it("returns primitives unchanged", () => {
    expect(redactPayload("text")).toBe("text");
    expect(redactPayload(7)).toBe(7);
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
  });
});

describe("maskPan", () => {
  it("keeps the BIN and the last 4 digits (ADR-0011)", () => {
    expect(maskPan(TEST_PAN)).toBe("411111******1111");
    expect(maskPan("4111 1111 1111 1111")).toBe("411111******1111");
    expect(maskPan("378282246310005")).toBe("378282*****0005");
    expect(maskPan(4111111111111111)).toBe("411111******1111");
  });

  it("never shows more than the last 4 digits of a value too short to be a card number", () => {
    expect(maskPan("12345678")).toBe("****5678");
    expect(maskPan("1234")).toBe("****");
    expect(maskPan("")).toBe("");
  });
});
