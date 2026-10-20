// The CSV file of adminExportAudit (PBE-032; platform/backend/openapi, `adminExportAudit`): the header and column
// order of the document, RFC 4180 quoting, empty cells for nulls, the OWASP neutralisation of formula starts, and the
// file name of the period. A small RFC 4180 reader in this file reads the records back, so the tests prove that a
// spreadsheet gets every value as written (apart from the leading `'` of a neutralised cell).
import { describe, expect, it } from "vitest";
import {
  AUDIT_CSV_COLUMNS,
  AUDIT_CSV_CONTENT_TYPE,
  auditCsvHeader,
  auditCsvRecord,
  auditExportDisposition,
  auditExportFilename,
  csvCell,
  csvRecord,
  CSV_RECORD_END,
  type AuditEntry,
} from "./audit-csv";

/** Reads RFC 4180 text (CRLF records, quoted cells with doubled quotes) into rows of cells. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
    } else {
      cell += character;
    }
  }
  if (cell !== "" || row.length > 0) {
    throw new Error("readCsv: the text does not end with a record end");
  }
  return rows;
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "1187",
    tenantId: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F",
    tenantKey: "acme",
    actorType: "platform_admin",
    actorAccountId: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
    actorLabel: "lena.holm@velexis.example.com",
    action: "tenant.suspended",
    targetType: "tenant",
    targetId: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F",
    requestId: "req_01JC4M2P6R0T4W8Y2A6C0E4G8K",
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0",
    details: {
      reason: "Card testing from the storefront, reported by Stripe.",
      before: { status: "active" },
      after: { status: "suspended", suspensionReason: "abuse" },
    },
    createdAt: "2026-10-20T07:33:05.000Z",
    ...overrides,
  };
}

describe("the header", () => {
  it("names the fourteen columns of the document, in its order, as one CRLF record", () => {
    expect(auditCsvHeader()).toBe(
      "id,createdAt,tenantId,tenantKey,actorType,actorAccountId,actorLabel,action,targetType,targetId,requestId," +
        "ipAddress,userAgent,details\r\n",
    );
    expect(readCsv(auditCsvHeader())).toEqual([[...AUDIT_CSV_COLUMNS]]);
    expect(CSV_RECORD_END).toBe("\r\n");
    expect(AUDIT_CSV_CONTENT_TYPE).toBe("text/csv; charset=utf-8");
  });
});

describe("a record", () => {
  it("holds every field of the row in the header's order, with details as the row's JSON", () => {
    const row = entry();
    const [cells] = readCsv(auditCsvRecord(row));

    expect(cells).toEqual([
      row.id,
      row.createdAt,
      row.tenantId,
      row.tenantKey,
      row.actorType,
      row.actorAccountId,
      row.actorLabel,
      row.action,
      row.targetType,
      row.targetId,
      row.requestId,
      row.ipAddress,
      row.userAgent,
      JSON.stringify(row.details),
    ]);
    expect(JSON.parse(cells?.[13] ?? "")).toEqual(row.details);
  });

  it("writes a null as an empty cell", () => {
    const row = entry({
      tenantId: null,
      tenantKey: null,
      actorType: "system",
      actorAccountId: null,
      actorLabel: null,
      targetId: null,
      requestId: null,
      ipAddress: null,
      userAgent: null,
      details: {},
    });

    expect(auditCsvRecord(row)).toBe(
      `1187,2026-10-20T07:33:05.000Z,,,system,,,tenant.suspended,tenant,,,,,{}\r\n`,
    );
  });

  it("quotes cells with commas, quotes, carriage returns or line feeds and doubles the quotes inside", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
    expect(csvCell("")).toBe("");
    expect(csvCell(null)).toBe("");

    const values = ['a "quoted", text', "two\r\nlines", "x"];
    expect(readCsv(csvRecord(values))).toEqual([values]);
  });

  it("neutralises cells a spreadsheet would run as a formula with a leading apostrophe (OWASP)", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
      const value = `${start}HYPERLINK("https://attacker.example.net")`;
      const [cells] = readCsv(csvRecord([value]));
      expect(cells).toEqual([`'${value}`]);
    }
    expect(csvCell("=1+2")).toBe("'=1+2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    // Quoting comes after the apostrophe: a neutralised cell with a comma is quoted as a whole.
    expect(csvCell("=A1,B1")).toBe(`"'=A1,B1"`);
    // Only the first character counts.
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("1-2")).toBe("1-2");
  });

  it("neutralises a hostile user agent and actor label of a row", () => {
    const row = entry({ userAgent: "=cmd|' /C calc'!A0", actorLabel: "+danger@example.com" });
    const [cells] = readCsv(auditCsvRecord(row));

    expect(cells?.[12]).toBe("'=cmd|' /C calc'!A0");
    expect(cells?.[6]).toBe("'+danger@example.com");
  });

  it("keeps the text of a redacted value as stored", () => {
    const row = entry({ details: { reason: "Rotated, see SUP-1", clientSecret: "[REDACTED]" } });
    const [cells] = readCsv(auditCsvRecord(row));

    expect(JSON.parse(cells?.[13] ?? "")).toEqual({
      reason: "Rotated, see SUP-1",
      clientSecret: "[REDACTED]",
    });
  });
});

describe("the file name", () => {
  it("names the UTC dates of the period, as the document's Content-Disposition pattern requires", () => {
    const from = new Date("2026-10-01T00:00:00Z");
    const to = new Date("2026-11-01T00:00:00Z");

    expect(auditExportFilename(from, to)).toBe("velexis-audit-2026-10-01-2026-11-01.csv");
    expect(auditExportDisposition(from, to)).toBe(
      'attachment; filename="velexis-audit-2026-10-01-2026-11-01.csv"',
    );
    expect(auditExportDisposition(from, to)).toMatch(
      /^attachment; filename="velexis-audit-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv"$/,
    );
  });

  it("uses the UTC date of a time with an offset", () => {
    // 23:30 at -02:00 is 01:30 UTC on the next day.
    expect(auditExportFilename(new Date("2026-03-31T23:30:00-02:00"), new Date("2026-04-30T00:00:00Z"))).toBe(
      "velexis-audit-2026-04-01-2026-04-30.csv",
    );
  });
});
