// The bodies of `supplier_requests` (OBE-018; db README §8, flows/amadeus-connection-and-tokens.md §6): the shared
// redactor, then e-mail addresses and phone numbers masked, then the 64 KB limit. The rows themselves, in a tenant
// schema, are test/integration/amadeus/client.int.test.ts.
import { describe, expect, it } from "vitest";
import {
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
    expect(payment?.creditCard).toEqual({
      brand: "VISA",
      holder: "ALEX TESTER",
      number: "1111",
      expiryDate: "2030-12",
    });
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

describe("isForeignKeyViolation", () => {
  it("recognises PostgreSQL's 23503 only", () => {
    expect(isForeignKeyViolation(Object.assign(new Error("fk"), { code: "23503" }))).toBe(true);
    expect(isForeignKeyViolation(Object.assign(new Error("unique"), { code: "23505" }))).toBe(false);
    expect(isForeignKeyViolation("23503")).toBe(false);
  });
});
