// The CSV files of a statement's lines (PBE-060; platform/docs/api-inventory-resources.md §5 and api-inventory-admin.md
// §6, scope PF-63 AC3): the columns are the inventory's, in its order, and the OpenAPI document's; amounts keep their
// sign and are never text; text cells never start a formula; quoting follows RFC 4180; the file names match the
// document's `Content-Disposition` patterns. Pure functions, no database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DIR } from "../config";
import {
  ADMIN_SETTLEMENT_CSV_COLUMNS,
  adminSettlementCsv,
  adminSettlementCsvFilename,
  amountCell,
  csvAttachment,
  PORTAL_SETTLEMENT_CSV_COLUMNS,
  portalSettlementCsv,
  SettlementCsvError,
  statementCsvFilename,
  type SettlementCsvLine,
} from "./settlement-csv";

const REPO_ROOT = join(APP_DIR, "..", "..");
const OPENAPI = join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml");

/** The column list an inventory row gives its `text/csv` answer: "→ `text/csv` (a, b, c)". */
function inventoryColumns(file: string, operationId: string): string[] {
  const inventory = readFileSync(join(REPO_ROOT, file), "utf8");
  const row = inventory.split("\n").find((line) => line.startsWith(`| \`${operationId}\` |`));
  const list = row === undefined ? undefined : /→ `text\/csv` \(([^)]*)\)/.exec(row)?.[1];
  if (list === undefined) {
    throw new Error(`${file} no longer lists the CSV columns of ${operationId}`);
  }
  return list.split(",").map((column) => column.trim());
}

/** The cells of a CSV text, record by record (RFC 4180: CRLF ends a record, `""` is a quote inside quotes). */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else if (char === "\r" && text[index + 1] === "\n") {
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = "";
      index += 1;
    } else {
      cell += char;
    }
  }
  expect(cell, "the text ends with CRLF").toBe("");
  expect(cells, "the text ends with CRLF").toEqual([]);
  return records;
}

/** A stored line: a captured charge of 1249.00 EUR unless `overrides` says otherwise (test values only). */
function line(overrides: Partial<SettlementCsvLine> = {}): SettlementCsvLine {
  return {
    id: "sln_01JD9X1B2C3D4E5F6G7H8J9K0M",
    line_type: "charge",
    occurred_at: new Date("2027-01-04T09:14:22.000Z"),
    amount: "1249.00",
    stripe_fee: "18.36",
    original_amount: null,
    original_currency: null,
    balance_transaction_id: "txn_3QExampleCharge01",
    source_id: "ch_3QExampleCharge01",
    payment_intent_id: "pi_3QExampleCharge01",
    velexis_payment_id: "pay_01JC2H6K0N4Q8S2V6X0Z4B8D2F",
    checkout_id: "chk_01JC2H5J9M3P7R1T5W9Y3A7C1E",
    description: "Booking 7Q4M2X OSL-BCN",
    created_by_account_id: null,
    ...overrides,
  };
}

const LINES: readonly SettlementCsvLine[] = [
  line(),
  line({
    id: "sln_01JD9X2C3D4E5F6G7H8J9K0M1N",
    line_type: "charge",
    amount: "412.37",
    stripe_fee: "6.43",
    original_amount: "4790.00",
    original_currency: "NOK",
    balance_transaction_id: "txn_3QExampleCharge02",
  }),
  line({
    id: "sln_01JD9X3D4E5F6G7H8J9K0M1N2P",
    line_type: "refund",
    occurred_at: new Date("2027-01-11T15:02:10.000Z"),
    amount: "-249.00",
    stripe_fee: "0.00",
    balance_transaction_id: "txn_3QExampleRefund01",
    source_id: "re_3QExampleRefund01",
    description: "Partial refund of booking 7Q4M2X",
  }),
  line({
    id: "sln_01JD9X4E5F6G7H8J9K0M1N2P3Q",
    line_type: "carry_forward",
    occurred_at: new Date("2027-01-01T00:00:00.000Z"),
    amount: "-79.48",
    stripe_fee: "0.00",
    balance_transaction_id: null,
    source_id: null,
    payment_intent_id: null,
    velexis_payment_id: null,
    checkout_id: null,
    description: "Balance carried forward from 2026-12 (stl_01JC7T1V5X9Z3B7D1F5H9K3N7Q)",
  }),
  line({
    id: "sln_01JD9X5F6G7H8J9K0M1N2P3Q4R",
    line_type: "adjustment",
    occurred_at: new Date("2027-02-03T08:51:17.000Z"),
    amount: "-10.00",
    stripe_fee: "0.00",
    balance_transaction_id: null,
    source_id: null,
    payment_intent_id: null,
    velexis_payment_id: null,
    checkout_id: null,
    description: '-10.00 fee correction, see the "note"',
    created_by_account_id: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
  }),
];

describe("the columns of the CSV files", () => {
  let portalExampleHeader: string;
  let adminExampleHeader: string;
  let portalDisposition: RegExp;
  let adminDisposition: RegExp;

  // Reading the OpenAPI document (some 20 000 lines) once, in this hook with its own budget; the tests stay on 5 s.
  beforeAll(() => {
    const document = readFileSync(OPENAPI, "utf8");
    const exampleHeader = (first: string): string => {
      const header = document.split("\n").find((text) => text.trim().startsWith(`${first},type,occurredAt`));
      if (header === undefined) {
        throw new Error(`the OpenAPI document has no CSV example whose header starts with ${first}`);
      }
      return header.trim();
    };
    portalExampleHeader = document
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text.startsWith("type,occurredAt,amount")) as string;
    adminExampleHeader = exampleHeader("id");
    const pattern = (prefix: string): RegExp => {
      const found = new RegExp(`pattern: (\\^attachment; filename="${prefix}[^\\n]*\\$)`).exec(document)?.[1];
      if (found === undefined) {
        throw new Error(`the OpenAPI document has no Content-Disposition pattern for ${prefix}`);
      }
      return new RegExp(found);
    };
    portalDisposition = pattern("velexis-statement-");
    adminDisposition = pattern("velexis-settlement-");
  }, 30_000);

  it("[PBE-060 AC2] the portal's file has exactly the columns of api-inventory-resources.md §5 and the document", () => {
    const columns = inventoryColumns("platform/docs/api-inventory-resources.md", "downloadSettlementLines");

    expect([...PORTAL_SETTLEMENT_CSV_COLUMNS]).toEqual(columns);
    expect(columns).toEqual([
      "type",
      "occurredAt",
      "amount",
      "stripeFee",
      "paymentIntentId",
      "velexisPaymentId",
      "checkoutId",
      "description",
    ]);
    expect(portalSettlementCsv([]).replace(/\r\n$/, "")).toBe(portalExampleHeader);
    expect(parseCsv(portalSettlementCsv(LINES))[0]).toEqual(columns);
  });

  it("[PBE-060 AC2] the admin's file has exactly the columns of api-inventory-admin.md §6 and the document", () => {
    const columns = inventoryColumns("platform/docs/api-inventory-admin.md", "adminDownloadSettlementLines");

    expect([...ADMIN_SETTLEMENT_CSV_COLUMNS]).toEqual(columns);
    expect(adminSettlementCsv([]).replace(/\r\n$/, "")).toBe(adminExampleHeader);
    expect(parseCsv(adminSettlementCsv(LINES))[0]).toEqual(columns);
  });

  it("[PBE-060 AC2] the file names match the document's Content-Disposition patterns", () => {
    const january = new Date("2027-01-01T00:00:00.000Z");

    expect(statementCsvFilename(january, "EUR")).toBe("velexis-statement-2027-01-EUR.csv");
    expect(adminSettlementCsvFilename("acme", january, "EUR ")).toBe(
      "velexis-settlement-acme-2027-01-EUR.csv",
    );
    expect(csvAttachment(statementCsvFilename(january, "EUR"))).toMatch(portalDisposition);
    expect(csvAttachment(adminSettlementCsvFilename("acme", january, "EUR"))).toMatch(adminDisposition);
    expect(csvAttachment(statementCsvFilename(new Date("2026-12-01T00:00:00.000Z"), "NOK"))).toBe(
      'attachment; filename="velexis-statement-2026-12-NOK.csv"',
    );
  });
});

describe("the records", () => {
  it("[PBE-060 AC2] the portal's file has one record per line, in the order given, with the line's values", () => {
    const records = parseCsv(portalSettlementCsv(LINES));

    expect(records.slice(1)).toEqual([
      [
        "charge",
        "2027-01-04T09:14:22.000Z",
        "1249.00",
        "18.36",
        "pi_3QExampleCharge01",
        "pay_01JC2H6K0N4Q8S2V6X0Z4B8D2F",
        "chk_01JC2H5J9M3P7R1T5W9Y3A7C1E",
        "Booking 7Q4M2X OSL-BCN",
      ],
      [
        "charge",
        "2027-01-04T09:14:22.000Z",
        "412.37",
        "6.43",
        "pi_3QExampleCharge01",
        "pay_01JC2H6K0N4Q8S2V6X0Z4B8D2F",
        "chk_01JC2H5J9M3P7R1T5W9Y3A7C1E",
        "Booking 7Q4M2X OSL-BCN",
      ],
      [
        "refund",
        "2027-01-11T15:02:10.000Z",
        "-249.00",
        "0.00",
        "pi_3QExampleCharge01",
        "pay_01JC2H6K0N4Q8S2V6X0Z4B8D2F",
        "chk_01JC2H5J9M3P7R1T5W9Y3A7C1E",
        "Partial refund of booking 7Q4M2X",
      ],
      [
        "carry_forward",
        "2027-01-01T00:00:00.000Z",
        "-79.48",
        "0.00",
        "",
        "",
        "",
        "Balance carried forward from 2026-12 (stl_01JC7T1V5X9Z3B7D1F5H9K3N7Q)",
      ],
      [
        "adjustment",
        "2027-02-03T08:51:17.000Z",
        "-10.00",
        "0.00",
        "",
        "",
        "",
        `'-10.00 fee correction, see the "note"`,
      ],
    ]);
  });

  it("[PBE-060 AC2] the admin's file adds the ids, the original amount and who added an adjustment", () => {
    const records = parseCsv(adminSettlementCsv(LINES));

    expect(records).toHaveLength(LINES.length + 1);
    expect(records[2]).toEqual([
      "sln_01JD9X2C3D4E5F6G7H8J9K0M1N",
      "charge",
      "2027-01-04T09:14:22.000Z",
      "412.37",
      "6.43",
      "4790.00",
      "NOK",
      "txn_3QExampleCharge02",
      "ch_3QExampleCharge01",
      "pi_3QExampleCharge01",
      "pay_01JC2H6K0N4Q8S2V6X0Z4B8D2F",
      "chk_01JC2H5J9M3P7R1T5W9Y3A7C1E",
      "Booking 7Q4M2X OSL-BCN",
      "",
    ]);
    expect(records[5]).toEqual([
      "sln_01JD9X5F6G7H8J9K0M1N2P3Q4R",
      "adjustment",
      "2027-02-03T08:51:17.000Z",
      "-10.00",
      "0.00",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      `'-10.00 fee correction, see the "note"`,
      "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
    ]);
  });

  it("ends every record with CRLF and quotes a cell with a comma, a quote or a line break (RFC 4180)", () => {
    const text = portalSettlementCsv([line({ description: 'Line one,\nline "two"' })]);

    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.split("\r\n")).toHaveLength(3);
    expect(text).toContain(`,"Line one,\nline ""two"""\r\n`);
    expect(parseCsv(text)[1]?.at(-1)).toBe('Line one,\nline "two"');
  });

  it.each(["=HYPERLINK(1)", "+1+1", "-2+3", "@SUM(1)", "\tcmd", "\rcmd"])(
    "[PBE-060 AC2] neutralises a text cell that starts like a formula (%j) with a leading quote",
    (description) => {
      for (const text of [
        portalSettlementCsv([line({ description })]),
        adminSettlementCsv([line({ description })]),
      ]) {
        const cell = parseCsv(text)[1]?.find((value) => value.endsWith(description.slice(1)));
        expect(cell).toBe(`'${description}`);
      }
    },
  );

  it("[PBE-060 AC2] keeps the sign of an amount: an amount cell is a number, never text", () => {
    const records = parseCsv(adminSettlementCsv([line({ amount: "-1180.00", stripe_fee: "-15.00" })]));

    expect(records[1]?.slice(3, 5)).toEqual(["-1180.00", "-15.00"]);
    for (const record of records.slice(1)) {
      for (const index of [3, 4, 5]) {
        expect(record[index]).toMatch(/^(-?[0-9]+\.[0-9]{2})?$/);
      }
    }
  });

  it("refuses to write an amount that is not a decimal string", () => {
    expect(amountCell("12.50")).toBe("12.50");
    expect(amountCell("-0.01")).toBe("-0.01");
    expect(amountCell(null)).toBe("");
    for (const bad of ["", " 1.00", "1e3", "=1+1", "1,00", "--1", "1."]) {
      expect(() => amountCell(bad), bad).toThrow(SettlementCsvError);
    }
    expect(() => portalSettlementCsv([line({ amount: "=2+5" })])).toThrow(SettlementCsvError);
    expect(() => adminSettlementCsv([line({ original_amount: "@1" })])).toThrow(SettlementCsvError);
  });
});
