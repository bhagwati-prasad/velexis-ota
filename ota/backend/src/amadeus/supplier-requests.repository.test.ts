// The bodies of `supplier_requests` (OBE-018; db README §8, flows/amadeus-connection-and-tokens.md §6): the shared
// redactor, then e-mail addresses and phone numbers masked, then the 64 KB limit. The rows themselves, in a tenant
// schema, are test/integration/amadeus/client.int.test.ts.
import { redactPayload } from "@velexis/logger";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FIRST_PART_BUDGET_BYTES,
  firstPartOf,
  isForeignKeyViolation,
  maskContactData,
  maskEmail,
  maskEmailField,
  maskPhone,
  SUPPLIER_REQUEST_BODY_LIMIT_BYTES,
  supplierRequestBody,
} from "./supplier-requests.repository";

/** A Flight Create Orders body with a passport, a card, an e-mail address and phone numbers (all synthetic). */
const CREATE_ORDER = {
  data: {
    type: "flight-order",
    travelers: [
      {
        id: "1",
        name: { firstName: "ALEX", lastName: "TESTER" },
        contact: {
          emailAddress: "alex.tester@example.com",
          phones: [{ deviceType: "MOBILE", countryCallingCode: "44", number: "7700900123" }],
        },
        documents: [
          {
            documentType: "PASSPORT",
            number: "X12345678",
            expiryDate: "2030-04-14",
            issuanceCountry: "GB",
            nationality: "GB",
            holder: true,
            birthPlace: "EXAMPLE CITY",
            issuanceLocation: "EXAMPLE CITY",
          },
        ],
      },
    ],
    formOfPayments: [
      {
        creditCard: {
          brand: "VISA",
          holder: "ALEX TESTER",
          number: "4111111111111111",
          expiryDate: "2030-12",
          securityCode: "737",
        },
      },
    ],
    contacts: [
      {
        addresseeName: { firstName: "ALEX", lastName: "TESTER" },
        emailAddress: "ops@example.com",
        phones: [{ deviceType: "LANDLINE", countryCallingCode: "44", number: 2079460123 }],
      },
    ],
    remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: "CALL ALEX.TESTER@EXAMPLE.COM" }] },
    queuingOfficeId: "NCE1A0955",
  },
};

describe("a stored body", () => {
  it("masks the passport number, the card and the contact data, and drops the security code [OBE-018 AC2]", () => {
    const stored = supplierRequestBody(CREATE_ORDER);
    const json = stored.json ?? "";
    const body = JSON.parse(json) as typeof CREATE_ORDER;
    const [traveler] = body.data.travelers;
    const [payment] = body.data.formOfPayments;
    const [contact] = body.data.contacts;

    expect(stored.truncated).toBe(false);
    // Case-insensitive: the remark spells the address in capitals.
    for (const secret of ["x12345678", "4111111111111111", "737", "alex.tester@example.com", "7700900123"]) {
      expect(json.toLowerCase()).not.toContain(secret);
    }
    expect(traveler?.documents[0]).toEqual({
      documentType: "PASSPORT",
      number: "5678",
      expiryDate: "2030-04-14",
      issuanceCountry: "GB",
      nationality: "GB",
      holder: true,
    });
    // Brand and last 4 only: the holder and the expiry are dropped too (FIX-W29-SECURITY).
    expect(payment?.creditCard).toEqual({ brand: "VISA", number: "1111" });
    expect(json).not.toContain("2030-12");
    expect(traveler?.contact).toEqual({
      emailAddress: "a***@example.com",
      phones: [{ deviceType: "MOBILE", countryCallingCode: "44", number: "******0123" }],
    });
    expect(contact?.emailAddress).toBe("o***@example.com");
    expect(contact?.phones[0]?.number).toBe("******0123");
    // An address in free text is masked too.
    expect(body.data.remarks.general[0]?.text).toBe("CALL A***@EXAMPLE.COM");
    // What the tests and the console need stays: ids, names of the booking, offices, document metadata.
    expect(body.data.queuingOfficeId).toBe("NCE1A0955");
    expect(traveler?.name).toEqual({ firstName: "ALEX", lastName: "TESTER" });
  });

  it("never changes the caller's object", () => {
    const copy = structuredClone(CREATE_ORDER);
    supplierRequestBody(CREATE_ORDER);

    expect(CREATE_ORDER).toEqual(copy);
  });

  it("is no body for undefined and null", () => {
    expect(supplierRequestBody(undefined)).toEqual({ json: null, truncated: false });
    expect(supplierRequestBody(null)).toEqual({ json: null, truncated: false });
  });

  it("is cut to 64 KB with truncated = true, the preview redacted too", () => {
    const offers = Array.from({ length: 2000 }, (_, index) => ({
      id: String(index),
      documents: [{ number: `P${String(index).padStart(8, "0")}` }],
      text: "é".repeat(20),
    }));
    const stored = supplierRequestBody({ data: offers });
    const json = stored.json ?? "";
    const wrapper = JSON.parse(json) as { truncated: boolean; bytes: number; preview: string };

    expect(stored.truncated).toBe(true);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(SUPPLIER_REQUEST_BODY_LIMIT_BYTES);
    // Most of the 64 KB is preview (its quotes are escaped once more inside the wrapper).
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(60 * 1024);
    expect(wrapper.truncated).toBe(true);
    expect(wrapper.bytes).toBeGreaterThan(SUPPLIER_REQUEST_BODY_LIMIT_BYTES);
    expect(wrapper.preview.startsWith('{"data":[{"id":"0","documents":[{"number":"0000"}]')).toBe(true);
    expect(wrapper.preview).not.toContain("P00000001");
    expect(wrapper.preview).not.toContain("�");
  });

  it("keeps a body of exactly 64 KB as it is", () => {
    const filler = "a".repeat(SUPPLIER_REQUEST_BODY_LIMIT_BYTES - '{"text":""}'.length);
    const stored = supplierRequestBody({ text: filler });

    expect(stored).toEqual({ json: JSON.stringify({ text: filler }), truncated: false });
  });
});

describe("contact data", () => {
  it("masks e-mail addresses to their first character and domain, in fields and in text", () => {
    expect(maskEmail("alex.tester@example.com")).toBe("a***@example.com");
    expect(maskEmail("Write to A.B@mail.example.org or c@example.com")).toBe(
      "Write to A***@mail.example.org or c***@example.com",
    );
    expect(maskEmail("no address here")).toBe("no address here");
    expect(maskEmail("a@x.com,b@y.com")).toBe("a***@x.com,b***@y.com");
  });

  it("scans a long text in linear time", () => {
    // Without an anchored local part, each of these took seconds (every start position rescanned the rest).
    const texts = [
      "a".repeat(SUPPLIER_REQUEST_BODY_LIMIT_BYTES),
      `x@${"a".repeat(SUPPLIER_REQUEST_BODY_LIMIT_BYTES)}`,
    ];
    const started = performance.now();
    const masked = texts.map(maskEmail);

    expect(masked).toEqual(texts);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("masks an e-mail field without a recognisable address to its first character", () => {
    expect(maskEmailField("alex.tester@example.com")).toBe("a***@example.com");
    expect(maskEmailField("alex.tester@localhost")).toBe("a***");
    expect(maskEmailField("")).toBe("");
    expect(maskContactData({ contact: { emailAddress: "alex.tester@localhost" } })).toEqual({
      contact: { emailAddress: "a***" },
    });
  });

  it("masks phone numbers to their last 4 digits", () => {
    expect(maskPhone("7700900123")).toBe("******0123");
    expect(maskPhone("+44 20 7946 0123")).toBe("********0123");
    expect(maskPhone(1234)).toBe("****");
  });

  it("masks `number` under phones and emergency contacts only, and phone fields anywhere", () => {
    expect(
      maskContactData({
        flight: { number: "1234" },
        phones: [{ number: "7700900123" }],
        emergencyContact: { number: "7700900456", countryCode: "GB" },
        agency: { phoneNumber: "+44 20 7946 0999", fax: 2079460000, email: ["x@example.com"] },
      }),
    ).toEqual({
      flight: { number: "1234" },
      phones: [{ number: "******0123" }],
      emergencyContact: { number: "******0456", countryCode: "GB" },
      agency: { phoneNumber: "********0999", fax: "******0000", email: ["x***@example.com"] },
    });
  });

  it("walks objects below contact fields, and masks addresses in any text", () => {
    expect(
      maskContactData({
        mobile: { countryCallingCode: "44", number: "7700900789" },
        phone: "+44 20 7946 0555",
        email: { address: "alex.tester@example.com" },
        remarks: [{ text: "Call alex.tester@example.com before 9" }],
        id: "eJzTd9f3NjIJdgMADeQCtg",
      }),
    ).toEqual({
      mobile: { countryCallingCode: "44", number: "******0789" },
      phone: "********0555",
      email: { address: "a***@example.com" },
      remarks: [{ text: "Call a***@example.com before 9" }],
      id: "eJzTd9f3NjIJdgMADeQCtg",
    });
  });
});

// ---- OBE-092: a large body is redacted from its first part only ------------------------------------------------------

/**
 * The stored body as the whole body through the redactor and the masking gives it (the oracle of the tests below):
 * the whole redacted JSON text, cut to the limit with the wrapper of a truncated body, `bytes` being the size of the
 * body's own JSON text.
 */
function wholeBodyOracle(body: unknown): { json: string; truncated: boolean } {
  const whole = JSON.stringify(maskContactData(redactPayload(body)));
  if (Buffer.byteLength(whole, "utf8") <= SUPPLIER_REQUEST_BODY_LIMIT_BYTES) {
    return { json: whole, truncated: false };
  }
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const prefix = (text: string, size: number): string =>
    Buffer.from(text, "utf8").subarray(0, size).toString("utf8").replace(/�+$/, "");
  let preview = prefix(whole, SUPPLIER_REQUEST_BODY_LIMIT_BYTES - 256);
  let wrapped = JSON.stringify({ truncated: true, bytes, preview });
  while (Buffer.byteLength(wrapped, "utf8") > SUPPLIER_REQUEST_BODY_LIMIT_BYTES) {
    const excess = Buffer.byteLength(wrapped, "utf8") - SUPPLIER_REQUEST_BODY_LIMIT_BYTES;
    preview = prefix(preview, Buffer.byteLength(preview, "utf8") - excess);
    wrapped = JSON.stringify({ truncated: true, bytes, preview });
  }
  return { json: wrapped, truncated: true };
}

/** A synthetic offer of a search answer with a traveller's contact, phone and passport (none real). */
function offer(index: number): Record<string, unknown> {
  return {
    type: "flight-offer",
    id: String(index),
    source: "GDS",
    itineraries: [
      {
        duration: "PT2H5M",
        segments: [
          {
            departure: { iataCode: "MAD", at: "2027-01-15T07:00:00" },
            arrival: { iataCode: "ORY", at: "2027-01-15T09:05:00" },
            carrierCode: "IB",
            number: String(3400 + (index % 90)),
            aircraft: { code: "320" },
          },
        ],
      },
    ],
    price: { currency: "EUR", total: `${100 + (index % 37)}.50`, base: "80.00" },
    contact: {
      emailAddress: `traveller.${index}@example.com`,
      phones: [
        { deviceType: "MOBILE", countryCallingCode: "34", number: `6000${String(index).padStart(5, "0")}` },
      ],
    },
    documents: [
      { documentType: "PASSPORT", number: `P${String(index).padStart(8, "0")}`, birthPlace: "EXAMPLE" },
    ],
    remarks: [{ text: `CALL TRAVELLER.${index}@EXAMPLE.COM — Ñandú` }],
  };
}

/** A search answer of `count` offers (about 600 bytes of JSON each) with its dictionaries after the offers. */
function largeAnswer(count: number): Record<string, unknown> {
  return {
    meta: { count, links: { self: "https://test.api.example.com/v2/shopping/flight-offers" } },
    data: Array.from({ length: count }, (_, index) => offer(index)),
    dictionaries: { carriers: { IB: "IBERIA" }, locations: { MAD: { cityCode: "MAD", countryCode: "ES" } } },
  };
}

describe("a large stored body [OBE-092]", () => {
  // Building the answers and the oracle's whole-body redaction is done once (about 300 KB each, a few tens of ms).
  let answer: Record<string, unknown>;
  let answerOracle: { json: string; truncated: boolean };
  beforeAll(() => {
    answer = largeAnswer(480);
    answerOracle = wholeBodyOracle(answer);
  });

  it("[OBE-092 AC2] stores what the whole body through the redactor would give, from its first part", () => {
    const stored = supplierRequestBody(answer);
    const wrapper = JSON.parse(stored.json ?? "") as { truncated: boolean; bytes: number; preview: string };

    expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeGreaterThan(
      4 * SUPPLIER_REQUEST_BODY_LIMIT_BYTES,
    );
    expect(stored).toEqual(answerOracle);
    expect(stored.truncated).toBe(true);
    expect(Buffer.byteLength(stored.json ?? "", "utf8")).toBeLessThanOrEqual(
      SUPPLIER_REQUEST_BODY_LIMIT_BYTES,
    );
    expect(wrapper.bytes).toBe(Buffer.byteLength(JSON.stringify(answer), "utf8"));
    // Redacted all the way: no passport number, address or phone number of any offer the preview holds.
    expect(wrapper.preview).toContain('"number":"0000"');
    expect(wrapper.preview).toContain('"emailAddress":"t***@example.com"');
    expect(wrapper.preview).toContain("CALL T***@EXAMPLE.COM");
    expect(wrapper.preview).not.toMatch(/P0000\d{4}|traveller\.\d|6000\d{5}|EXAMPLE"/i);
  });

  it("[OBE-092 AC2] redacts no more than the first part of the body", () => {
    const first = firstPartOf(answer, FIRST_PART_BUDGET_BYTES);
    const text = JSON.stringify(first.value);
    const whole = JSON.stringify(answer);

    expect(first.cut).toBe(true);
    // The part ends with the brackets that close the offers, the answer and anything the cut runs through; without
    // them it starts the whole text.
    expect(first.closers).toBeGreaterThanOrEqual(2);
    expect(text.slice(-first.closers)).toMatch(/^[\]}]+$/);
    expect(whole.startsWith(text.slice(0, -first.closers))).toBe(true);
    // A little more than the row keeps, far less than the answer.
    expect(text.length).toBeGreaterThanOrEqual(FIRST_PART_BUDGET_BYTES);
    expect(text.length).toBeLessThan(FIRST_PART_BUDGET_BYTES + 2 * 1024);
  });

  it("never changes the caller's large body", () => {
    const copy = structuredClone(answer);
    supplierRequestBody(answer);

    expect(answer).toEqual(copy);
  });

  it("takes a longer first part when the redaction shortens it below the limit", () => {
    // The first offers carry long security codes and card holders, which the redactor drops.
    const shrinking = largeAnswer(200);
    const data = shrinking["data"] as Record<string, unknown>[];
    data.slice(0, 60).forEach((item) => {
      item["formOfPayments"] = [{ creditCard: { holder: "H".repeat(900), securityCode: "9".repeat(900) } }];
    });
    const stored = supplierRequestBody(shrinking);

    expect(stored).toEqual(wholeBodyOracle(shrinking));
    expect(stored.truncated).toBe(true);
    expect(stored.json).not.toContain("HHHH");
    expect(stored.json).not.toContain("9999");
  });

  it("keeps the preview exact when the cut runs through a value the redactor replaces", () => {
    // `token` is redacted whole: the first part's text ends inside it, and the next first part is taken longer.
    const secretFirst = {
      meta: { count: 1 },
      token: { pages: Array.from({ length: 120 }, (_, index) => offer(index)) },
      data: Array.from({ length: 120 }, (_, index) => offer(index)),
    };
    const stored = supplierRequestBody(secretFirst);

    expect(stored).toEqual(wholeBodyOracle(secretFirst));
    expect(stored.json).toContain('\\"token\\":\\"[REDACTED]\\"');
  });

  it("stores a body whole when its redacted copy fits, even when its own JSON is above the first budget", () => {
    const fits = { remarks: [{ text: "booked" }], securityCode: "1".repeat(FIRST_PART_BUDGET_BYTES) };
    const stored = supplierRequestBody(fits);

    expect(stored).toEqual({ json: '{"remarks":[{"text":"booked"}]}', truncated: false });
  });

  it("redacts a large body with a cycle whole, as the redactor writes it", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    cyclic["data"] = Array.from({ length: 120 }, (_, index) => offer(index));
    const stored = supplierRequestBody(cyclic);
    const wrapper = JSON.parse(stored.json ?? "") as { bytes: number; preview: string };

    expect(stored.truncated).toBe(true);
    expect(wrapper.preview.startsWith('{"self":"[Circular]","data":[{"type":"flight-offer"')).toBe(true);
    // Without the body's own JSON text, `bytes` is the size of the redacted copy's.
    expect(wrapper.bytes).toBe(
      Buffer.byteLength(JSON.stringify(maskContactData(redactPayload(cyclic))), "utf8"),
    );
  });
});

describe("firstPartOf [OBE-092]", () => {
  it("returns the body itself when it fits the budget", () => {
    const body = { a: [1, 2, 3], b: "text" };

    expect(firstPartOf(body, 1024)).toEqual({ value: body, cut: false, closers: 0 });
    expect(firstPartOf(body, 1024).value).toBe(body);
  });

  it("cuts in the order of the JSON text, through the member that crosses the budget", () => {
    const body = { first: "a".repeat(20), list: ["b".repeat(20), "c".repeat(20), "d".repeat(20)], last: "e" };
    const part = firstPartOf(body, 80);

    expect(part).toEqual({
      value: { first: "a".repeat(20), list: ["b".repeat(20), "c".repeat(20)] },
      cut: true,
      closers: 2,
    });
    expect(JSON.stringify(body).startsWith(JSON.stringify(part.value).slice(0, -part.closers))).toBe(true);
  });

  it("keeps the members before the cut as the body's own objects", () => {
    const kept = { id: "1" };
    const body = { data: [kept, { id: "2", text: "x".repeat(100) }] };
    const part = firstPartOf(body, 30);
    const data = (part.value as { data: unknown[] }).data;

    expect(data[0]).toBe(kept);
    expect(data[1]).toEqual({ id: "2" });
    expect(part.closers).toBe(3);
  });

  it("leaves out what JSON leaves out, writes a value with toJSON as it is and keeps a __proto__ key as data", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"rest":["x","y"]}') as Record<string, unknown>;
    const body = { skipped: undefined, at: new Date("2027-01-15T07:00:00Z"), parsed };
    const part = firstPartOf(body, 60);
    const value = part.value as Record<string, unknown>;

    expect(part.cut).toBe(true);
    expect(value["at"]).toBe(body.at);
    expect(Object.getPrototypeOf(value["parsed"])).toBe(Object.prototype);
    expect(Object.keys(value["parsed"] as object)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("cuts an empty array or object nowhere, and a budget already spent before the first member", () => {
    expect(firstPartOf([], 0)).toEqual({ value: [], cut: false, closers: 0 });
    expect(firstPartOf({ a: 1 }, 0)).toEqual({ value: {}, cut: true, closers: 1 });
  });
});

describe("contact masking of the redactor's copy [OBE-092]", () => {
  it("masks an address only in a text that has an @", () => {
    const text = "no address in 64 KB of text ".repeat(100);

    expect(maskEmail(text)).toBe(text);
    expect(maskEmail("x@example.com")).toBe("x***@example.com");
  });

  it("[OBE-092 AC2] masks in place exactly what the copying masking gives", () => {
    // The stored body masks the redactor's own copy in place; the copying `maskContactData` is the reference.
    const bodies: unknown[] = [
      CREATE_ORDER,
      {
        flight: { number: "1234" },
        phones: [{ number: "7700900123" }, "+44 20 7946 0111", 2079460222],
        emergencyContact: { number: "7700900456", countryCode: "GB" },
        agency: {
          phoneNumber: "+44 20 7946 0999",
          fax: 2079460000,
          email: ["x@example.com", { at: "y@example.com" }],
        },
        mobile: { countryCallingCode: "44", number: "7700900789" },
        email: { address: "alex.tester@example.com", list: [["nested@example.com"]] },
        remarks: [{ text: "Call alex.tester@example.com before 9" }],
        "E-Mail_Address": "alex@localhost",
        "Phone-Number": "+44 20 7946 0333",
      },
      // A Date and a value with toJSON, as callers could hand them over: the copying masking writes the redactor's
      // copy of a Date as a plain object of its own members (`{}`), and the masking in place must write the same.
      {
        at: new Date("2027-01-15T07:00:00Z"),
        dates: [new Date(0)],
        when: { toJSON: () => ({ email: "d@example.com" }) },
      },
      JSON.parse('{"__proto__":{"email":"p@example.com"},"rest":[{"phone":"7700900444"}]}'),
      ["a@example.com", null, 1, true, { mfa: { code: "123456" } }],
    ];
    for (const body of bodies) {
      // Twice: the second run reads the normalised keys from the cache.
      for (let run = 0; run < 2; run += 1) {
        expect(supplierRequestBody(body)).toEqual({
          json: JSON.stringify(maskContactData(redactPayload(body))),
          truncated: false,
        });
      }
    }
  });

  it("[OBE-092 AC2] stores a large body with dates as the whole body through the copying masking gives it", () => {
    const answer = largeAnswer(200);
    (answer["data"] as Record<string, unknown>[]).forEach((item, index) => {
      item["lastTicketingDateTime"] = new Date(Date.UTC(2027, 0, 1 + (index % 28)));
    });
    const stored = supplierRequestBody(answer);

    expect(stored.truncated).toBe(true);
    expect(stored).toEqual(wholeBodyOracle(answer));
  });

  it("normalises a key longer than the cache keeps as it does a short one", () => {
    // Normalised, these are `email` and `phone`: contact fields, whatever their length.
    const emailKey = `${"_".repeat(100)}E-Mail`;
    const phoneKey = `${"-".repeat(100)}Phone`;
    const body = { [emailKey]: "alex.tester@localhost", contact: { [phoneKey]: "+44 20 7946 0123" } };

    for (let run = 0; run < 2; run += 1) {
      expect(JSON.parse(supplierRequestBody(body).json ?? "")).toEqual({
        [emailKey]: "a***",
        contact: { [phoneKey]: "********0123" },
      });
    }
  });
});

describe("isForeignKeyViolation", () => {
  it("recognises PostgreSQL's 23503 only", () => {
    expect(isForeignKeyViolation(Object.assign(new Error("fk"), { code: "23503" }))).toBe(true);
    expect(isForeignKeyViolation(Object.assign(new Error("unique"), { code: "23505" }))).toBe(false);
    expect(isForeignKeyViolation("23503")).toBe(false);
  });
});
