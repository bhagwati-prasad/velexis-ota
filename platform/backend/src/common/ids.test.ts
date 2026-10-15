import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR } from "../config";
import { Clock } from "./clock";
import { IdGenerator, isPlatformIdPrefix, PLATFORM_ID_PREFIXES } from "./ids";

const REPO_ROOT = join(APP_DIR, "..", "..");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The millisecond timestamp in the first 10 characters of a ULID. */
function ulidTime(id: string): number {
  const ulid = id.slice(id.indexOf("_") + 1);
  return [...ulid.slice(0, 10)].reduce((time, char) => time * 32 + CROCKFORD.indexOf(char), 0);
}

class FixedClock extends Clock {
  constructor(private readonly instant: Date) {
    super();
  }

  override now(): Date {
    return new Date(this.instant);
  }
}

/** The prefixes of the conventions bullet of platform/docs/api-inventory.md §2 ("ids are prefixed ULIDs (`acc_`, …)"). */
function inventoryPrefixes(): string[] {
  const inventory = readFileSync(join(REPO_ROOT, "platform/docs/api-inventory.md"), "utf8");
  const bullet = /^- JSON in camelCase; ids are prefixed ULIDs \(([^)]*)\)/m.exec(inventory)?.[1];
  if (bullet === undefined) {
    throw new Error("api-inventory.md §2 no longer lists the id prefixes in its first conventions bullet");
  }
  return [...bullet.matchAll(/`([a-z]+)_`/g)].map((match) => match[1] ?? "");
}

/** The `CHECK (id LIKE '<prefix>\_%')` prefixes of the platform migrations. */
function migrationPrefixes(): string[] {
  const dir = join(APP_DIR, "migrations/platform");
  const sql = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
  return [...new Set([...sql.matchAll(/\bid LIKE '([a-z]+)\\_%'/g)].map((match) => match[1] ?? ""))];
}

describe("IdGenerator", () => {
  it('[PBE-008 AC4] new("ten") matches ^ten_[0-9A-HJKMNP-TV-Z]{26}$', () => {
    const ids = new IdGenerator(new Clock());

    const id: `ten_${string}` = ids.new("ten");

    expect(id).toMatch(/^ten_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("makes ids of every prefix with a fresh random part every time", () => {
    const ids = new IdGenerator(new Clock());

    for (const prefix of PLATFORM_ID_PREFIXES) {
      const made = Array.from({ length: 20 }, () => ids.new(prefix));

      for (const id of made) {
        expect(id).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
      }
      expect(new Set(made).size).toBe(made.length);
    }
  });

  it("takes the timestamp from the injected Clock, so ids sort with created_at", () => {
    const at = new Date("2026-10-13T08:30:00.000Z");
    const ids = new IdGenerator(new FixedClock(at));

    const id = ids.new("acc");

    expect(ulidTime(id)).toBe(at.getTime());
    // Ids made at the same instant still differ: the random part is never monotonic or repeated.
    expect(new Set(Array.from({ length: 50 }, () => ids.new("acc"))).size).toBe(50);
  });

  it("refuses a prefix outside the platform list, at compile time and at run time", () => {
    const ids = new IdGenerator(new Clock());

    // @ts-expect-error An OTA prefix is not a platform prefix.
    expect(() => ids.new("bkg")).toThrow(TypeError);
    // @ts-expect-error Stripe's own event ids are never generated.
    expect(() => ids.new("evt")).toThrow(TypeError);
    // @ts-expect-error Upper-case prefixes do not compile.
    expect(() => ids.new("TEN")).toThrow(TypeError);
    expect(isPlatformIdPrefix("ten")).toBe(true);
    expect(isPlatformIdPrefix("ten_")).toBe(false);
    expect(isPlatformIdPrefix(undefined)).toBe(false);
  });
});

describe("PLATFORM_ID_PREFIXES", () => {
  it("lists every prefix of api-inventory §2, in its order", () => {
    const inventory = inventoryPrefixes();

    expect(inventory).toHaveLength(15);
    expect(PLATFORM_ID_PREFIXES.slice(0, inventory.length)).toEqual(inventory);
  });

  it("is the inventory's prefixes plus the id CHECKs of the platform migrations, except Stripe's evt_", () => {
    const tables = migrationPrefixes();
    const expected = new Set([...inventoryPrefixes(), ...tables.filter((prefix) => prefix !== "evt")]);

    expect(tables).toContain("evt");
    expect([...PLATFORM_ID_PREFIXES].sort()).toEqual([...expected].sort());
    expect(Object.isFrozen(PLATFORM_ID_PREFIXES)).toBe(true);
  });
});
