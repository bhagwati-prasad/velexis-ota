// The template registry (OBE-004): the MVP keys of OADR-0013, their allow-lists and sample data, and the loader of
// the code defaults `<key>.{subject,html,txt}.hbs`.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATES_DIR,
  isTemplateKey,
  loadTemplateDefault,
  loadTemplateDefaults,
  TEMPLATE_KEYS,
  TEMPLATE_PARTS,
  TEMPLATE_REGISTRY,
  templateFileName,
  TemplateFilesError,
  type SampleValue,
  type TemplateKey,
} from "./registry";

/** The `key` CHECK of `notification_templates` (docs/velexis-sdk/db/tenant.sql). */
const KEY_CHECK = /^[a-z]+(\.[a-z_]+)+$/;

/** OADR-0013 item 4: customers get the account e-mails, travellers the booking e-mails, staff the alerts. */
const AUDIENCE_BY_GROUP: Readonly<Record<string, string>> = {
  auth: "customer",
  account: "customer",
  booking: "traveller",
  staff: "staff",
};

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function folderWith(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-registry-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

function completeFiles(key: TemplateKey): Record<string, string> {
  return {
    [templateFileName(key, "subject")]: "  Hello {{brand.name}}\n",
    [templateFileName(key, "html")]: "<p>Hello</p>\n",
    [templateFileName(key, "txt")]: "Hello\n",
  };
}

/** The values a variable path reaches in `data`; `[]` steps into every item of a list. */
function resolve(data: SampleValue, path: readonly string[]): SampleValue[] {
  const [head, ...rest] = path;
  if (head === undefined) {
    return [data];
  }
  if (head.endsWith("[]")) {
    const list = resolve(data, [head.slice(0, -2)]);
    return list.flatMap((value) =>
      Array.isArray(value) ? value.flatMap((item) => resolve(item, rest)) : [],
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data) || !(head in data)) {
    return [];
  }
  return resolve((data as Record<string, SampleValue>)[head] as SampleValue, rest);
}

/** Every leaf path of `data`, with `[]` for list items. */
function leafPaths(data: SampleValue, prefix = ""): string[] {
  if (Array.isArray(data)) {
    return data.flatMap((item) => leafPaths(item as SampleValue, `${prefix}[]`));
  }
  if (data !== null && typeof data === "object") {
    return Object.entries(data).flatMap(([name, value]) =>
      leafPaths(value, prefix === "" ? name : `${prefix}.${name}`),
    );
  }
  return [prefix];
}

describe("template keys", () => {
  it("[FIX-W29-OTA AC2] are the MVP keys of OADR-0013 with booking.updated of its revision of 2026-10-23 and the account keys of 2026-10-24, each allowed by the notification_templates key CHECK", () => {
    expect(TEMPLATE_KEYS).toEqual([
      "auth.verify_email",
      "auth.password_reset",
      "account.email_changed",
      "account.deleted",
      "booking.confirmed",
      "booking.ticketed",
      "booking.ticketing_delayed",
      "booking.cancelled",
      "booking.cancellation_requested",
      "booking.not_confirmed",
      "booking.updated",
      "staff.ticketing_failed",
      "staff.manual_review",
      "staff.airline_card_alert",
    ]);
    for (const key of TEMPLATE_KEYS) {
      expect(key).toMatch(KEY_CHECK);
      expect(isTemplateKey(key)).toBe(true);
    }
    expect(isTemplateKey("booking.unknown")).toBe(false);
    expect(isTemplateKey(42)).toBe(false);
  });

  it("each have an allow-list whose variables all appear in the sample data, and sample data only from it", () => {
    expect(Object.keys(TEMPLATE_REGISTRY).sort()).toEqual([...TEMPLATE_KEYS].sort());
    for (const key of TEMPLATE_KEYS) {
      const definition = TEMPLATE_REGISTRY[key];
      expect(definition.key).toBe(key);
      expect(definition.audience).toBe(AUDIENCE_BY_GROUP[key.split(".")[0] ?? ""]);
      const names = definition.variables.map((entry) => entry.name);
      expect(new Set(names).size, `${key}: duplicate variable`).toBe(names.length);
      for (const entry of definition.variables) {
        expect(entry.description, `${key}: ${entry.name}`).not.toBe("");
        const values = resolve(definition.sampleData, entry.name.split("."));
        expect(values.length, `${key}: ${entry.name} has no sample value`).toBeGreaterThan(0);
      }
      expect(
        leafPaths(definition.sampleData).filter((path) => !names.includes(path)),
        key,
      ).toEqual([]);
      // The sample data is stored as jsonb: it survives a JSON round trip unchanged.
      expect(JSON.parse(JSON.stringify(definition.sampleData))).toEqual(definition.sampleData);
    }
  });
});

describe("loadTemplateDefault", () => {
  it("returns undefined for a key without files", async () => {
    const dir = await folderWith({});

    expect(await loadTemplateDefault("booking.confirmed", dir)).toBeUndefined();
  });

  it("reads the three files of a key, with the subject trimmed to its line", async () => {
    const dir = await folderWith(completeFiles("booking.confirmed"));

    expect(await loadTemplateDefault("booking.confirmed", dir)).toEqual({
      key: "booking.confirmed",
      subject: "Hello {{brand.name}}",
      html: "<p>Hello</p>\n",
      text: "Hello\n",
    });
  });

  it("refuses a key with only some of its files, naming the missing ones", async () => {
    const dir = await folderWith({ [templateFileName("booking.ticketed", "subject")]: "Tickets\n" });

    const error = await loadTemplateDefault("booking.ticketed", dir).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TemplateFilesError);
    expect((error as TemplateFilesError).missing).toEqual([
      "booking.ticketed.html.hbs",
      "booking.ticketed.txt.hbs",
    ]);
  });
});

describe("loadTemplateDefaults", () => {
  it("returns the keys whose files exist, in registry order", async () => {
    const dir = await folderWith({
      ...completeFiles("staff.manual_review"),
      ...completeFiles("auth.verify_email"),
    });

    const defaults = await loadTemplateDefaults(dir);

    expect(defaults.map((source) => source.key)).toEqual(["auth.verify_email", "staff.manual_review"]);
  });

  it("returns nothing for a folder that does not exist", async () => {
    const dir = await folderWith({});

    expect(await loadTemplateDefaults(join(dir, "missing"))).toEqual([]);
  });

  it("finds only complete defaults of registered keys in the shipped folder", async () => {
    const expected = new Set(
      TEMPLATE_KEYS.flatMap((key) => TEMPLATE_PARTS.map((part) => templateFileName(key, part))),
    );
    const files = (await readdir(DEFAULT_TEMPLATES_DIR)).filter((name) => name.endsWith(".hbs"));

    expect(files.filter((name) => !expected.has(name))).toEqual([]);
    const defaults = await loadTemplateDefaults();
    expect(defaults).toHaveLength(files.length / TEMPLATE_PARTS.length);
  });
});
