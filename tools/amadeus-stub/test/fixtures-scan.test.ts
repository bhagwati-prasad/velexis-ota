// The personal-data scan of every committed fixture (X-034): `pnpm test` fails when a file under fixtures/ holds an
// e-mail address outside example.com, a run of 13 to 19 digits not marked synthetic, a document number that is not
// synthetic (a passport number), a phone number outside the reserved test ranges, or a name that is not synthetic.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_DIR } from "../src/index";
import { scanForPersonalData, type ScanFinding } from "../src/scrub";

interface FileFinding extends ScanFinding {
  /** The fixture file, relative to the scanned folder. */
  readonly file: string;
}

/** Every `.json` file under `dir`, recursively, sorted. */
function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".json"))
    .map((path) => join(dir, path))
    .sort();
}

/** The scan of every fixture under `dir`; a file that is not JSON is a finding too. */
function scanFixtureDir(dir: string): FileFinding[] {
  return fixtureFiles(dir).flatMap((path) => {
    const file = relative(dir, path);
    const text = readFileSync(path, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${file} is not valid JSON`);
    }
    return scanForPersonalData(value).map((finding) => ({ file, ...finding }));
  });
}

const copies: string[] = [];

/** A copy of the committed fixtures folder in a temporary directory. */
function copyFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "amadeus-stub-fixtures-"));
  copies.push(dir);
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

function editFixture(
  dir: string,
  file: string,
  edit: (fixture: { body: Record<string, unknown> }) => void,
): void {
  const path = join(dir, file);
  const fixture = JSON.parse(readFileSync(path, "utf8")) as { body: Record<string, unknown> };
  edit(fixture);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
}

const SEARCH_FIXTURE = join("flight-offers-search", "success.json");
/** Real-looking personal data: a made-up mailbox at a real provider, Stripe's test card, a 9-digit passport. */
const REAL_LOOKING_EMAIL = "jules.martin@gmail.com";
const SIXTEEN_DIGITS = "4242424242424242";
const PASSPORT_NUMBER = "512345678";

afterEach(() => {
  for (const dir of copies.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fixture scan", () => {
  it("passes on every committed fixture [X-034 AC2]", () => {
    const files = fixtureFiles(FIXTURE_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((path) => relative(FIXTURE_DIR, path))).toContain(SEARCH_FIXTURE);
    expect(scanFixtureDir(FIXTURE_DIR)).toEqual([]);
  });

  it("fails on a copy with a real-looking e-mail address, a 16-digit number and a passport number [X-034 AC2]", () => {
    const dir = copyFixtures();
    expect(scanFixtureDir(dir)).toEqual([]);

    editFixture(dir, SEARCH_FIXTURE, (fixture) => {
      fixture.body["contacts"] = [{ purpose: "STANDARD", emailAddress: REAL_LOOKING_EMAIL }];
      fixture.body["remarks"] = {
        general: [{ subType: "GENERAL_MISCELLANEOUS", text: `PAID ${SIXTEEN_DIGITS}` }],
      };
      fixture.body["travelers"] = [
        { id: "1", documents: [{ documentType: "PASSPORT", number: PASSPORT_NUMBER }] },
      ];
    });

    const findings = scanFixtureDir(dir);
    expect(findings).toEqual([
      expect.objectContaining({
        file: SEARCH_FIXTURE,
        pointer: "/body/contacts/0/emailAddress",
        rule: "email",
      }),
      expect.objectContaining({
        file: SEARCH_FIXTURE,
        pointer: "/body/remarks/general/0/text",
        rule: "digit-run",
      }),
      expect.objectContaining({
        file: SEARCH_FIXTURE,
        pointer: "/body/travelers/0/documents/0/number",
        rule: "document-number",
      }),
    ]);
    // A finding says where and why, never what.
    const report = JSON.stringify(findings);
    for (const value of [REAL_LOOKING_EMAIL, SIXTEEN_DIGITS, PASSPORT_NUMBER]) {
      expect(report).not.toContain(value);
    }
  });

  it("finds each of them alone, wherever it is in the file [X-034 AC2]", () => {
    const cases: readonly [string, unknown, ScanFinding["rule"]][] = [
      ["an e-mail address in free text", `Booked by ${REAL_LOOKING_EMAIL}`, "email"],
      ["an e-mail address in the SSR form", "CTCE JULES.MARTIN//GMAIL.COM", "email"],
      ["16 digits with spaces", "4242 4242 4242 4242", "digit-run"],
      ["a 13-digit ticket number with a hyphen", "172-2400000001", "digit-run"],
      ["16 digits as a JSON number", 4242424242424242, "digit-run"],
      ["a passport number in free text", `PASSPORT NO ${PASSPORT_NUMBER}`, "document-number"],
      ["a passport number in an SSR DOCS text", `P/GBR/${PASSPORT_NUMBER}/GBR/16JAN82/M`, "document-number"],
      ["a French phone number in free text", "CTCM +33 6 12 34 56 78", "phone"],
    ];
    for (const [what, value, rule] of cases) {
      const findings = scanForPersonalData({ body: { remarks: { general: [{ text: value }] } } });
      expect(findings, what).toEqual([
        expect.objectContaining({ pointer: "/body/remarks/general/0/text", rule }),
      ]);
    }
  });

  it("names a key that holds personal data by its position, never by the key itself", () => {
    const findings = scanForPersonalData({
      body: {
        meta: { count: 1 },
        [REAL_LOOKING_EMAIL]: { paidWith: SIXTEEN_DIGITS },
      },
    });
    expect(findings).toEqual([
      expect.objectContaining({ pointer: "/body/<key 1> (key)", rule: "email" }),
      expect.objectContaining({ pointer: "/body/<key 1>/paidWith", rule: "digit-run" }),
    ]);
    const report = JSON.stringify(findings);
    expect(report).not.toContain("jules.martin");
    expect(report).not.toContain(SIXTEEN_DIGITS);
  });

  it("checks phone numbers, names and document numbers by the field that holds them", () => {
    const traveler = (overrides: Record<string, unknown>) => ({
      data: {
        travelers: [
          {
            id: "1",
            name: { firstName: "ALEX", lastName: "TESTER" },
            contact: { phones: [{ countryCallingCode: "44", number: "7700900123" }] },
            documents: [{ documentType: "PASSPORT", number: "000000001" }],
            ...overrides,
          },
        ],
      },
    });
    expect(scanForPersonalData(traveler({}))).toEqual([]);

    expect(scanForPersonalData(traveler({ name: { firstName: "JULES", lastName: "TESTER" } }))).toEqual([
      expect.objectContaining({ pointer: "/data/travelers/0/name/firstName", rule: "name" }),
    ]);
    expect(
      scanForPersonalData(
        traveler({ contact: { phones: [{ countryCallingCode: "33", number: "612345678" }] } }),
      ),
    ).toEqual([
      expect.objectContaining({ pointer: "/data/travelers/0/contact/phones/0/number", rule: "phone" }),
    ]);
    // A North American 555-01xx number is reserved for fiction.
    expect(
      scanForPersonalData(
        traveler({ contact: { phones: [{ countryCallingCode: "1", number: "2025550143" }] } }),
      ),
    ).toEqual([]);
    expect(
      scanForPersonalData(traveler({ documents: [{ documentType: "PASSPORT", number: "XN0019390" }] })),
    ).toEqual([
      expect.objectContaining({ pointer: "/data/travelers/0/documents/0/number", rule: "document-number" }),
    ]);
    expect(
      scanForPersonalData(
        traveler({ emergencyContact: { addresseeName: "EMILIE MARTIN", number: "612345678" } }),
      ),
    ).toEqual([
      expect.objectContaining({ pointer: "/data/travelers/0/emergencyContact/addresseeName", rule: "name" }),
      expect.objectContaining({ pointer: "/data/travelers/0/emergencyContact/number", rule: "phone" }),
    ]);
  });

  it("accepts example.com addresses, synthetic numbers and the flight data of the committed fixtures", () => {
    expect(
      scanForPersonalData({
        email: "person1@example.com",
        ssr: "PERSON2//EXAMPLE.COM",
        ticket: "000-0000000001",
        card: "XXXXXXXXXXXX0000",
        run: "0000 0000 0000 0002",
        remark: "PASSPORT NO 000000003, PASSPORT REQUIRED",
        phone: "+44 7700 900123",
        link: "https://test.travel.api.amadeus.com/v2/shopping/flight-offers?departureDate=2027-01-15&adults=1",
      }),
    ).toEqual([]);
  });
});
