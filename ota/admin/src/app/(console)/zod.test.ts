// The Zod the admin's server actions check their forms with (OAD-020; README §12, docs/mvp/tech-stack.md).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";
import type * as Zod from "zod";

/**
 * GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating oversized constrained collections) is fixed in Zod 4.6.6:
 * from that release a list's `.max()` refuses an oversized list before any item is checked. The admin pins one exact
 * release at or past it, the same release as the portal and the platform admin (security review OTA-SR-03).
 */
const FIXED = [4, 6, 6] as const;

function versionOf(text: string): readonly number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (match === null) {
    throw new Error(`"${text}" is not an exact version`);
  }
  return match.slice(1).map(Number);
}

function atLeast(version: readonly number[], floor: readonly number[]): boolean {
  for (let index = 0; index < floor.length; index += 1) {
    const part = version[index] ?? 0;
    const min = floor[index] ?? 0;
    if (part !== min) {
      return part > min;
    }
  }
  return true;
}

describe("the zod the OTA admin runs", () => {
  it("[OAD-020 AC1] is one exact 4.x release at or past 4.6.6 (GHSA-mrhx-c7xc-m3w5), and the one installed", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const pinned = manifest.dependencies["zod"] ?? "";
    const version = versionOf(pinned);
    expect(version[0]).toBe(4);
    expect(atLeast(version, FIXED)).toBe(true);
    expect(atLeast([4, 6, 5], FIXED)).toBe(false);

    const installed = (createRequire(import.meta.url)("zod/package.json") as { readonly version: string })
      .version;
    expect(installed).toBe(pinned);
  });

  it("[OAD-020] the modules the client forms import build no Zod schema while they load", async () => {
    // Zod 4 registers its English messages (which name a "credit card number") on the first schema built: a schema
    // built when one of these modules loads would put them in the browser's chunks, where the built-pages test refuses
    // card labels (OAD-008 AC2). Every call to `z` is counted while the modules load, and after.
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock("zod", async (importOriginal) => {
      const actual = await importOriginal<typeof Zod>();
      const z = new Proxy(actual.z, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? (...args: unknown[]) => {
                calls.push(String(property));
                return (value as (...parameters: unknown[]) => unknown).apply(target, args);
              }
            : value;
        },
      });
      return { ...actual, z };
    });
    try {
      const content = await import("./settings/content-rules");
      const pricing = await import("./settings/pricing-rules");
      const settings = await import("./settings/storefront/settings-rules");
      expect(calls).toEqual([]);

      // The schemas are built on their first use.
      content.newPageSchema();
      pricing.ruleFormSchema("markup");
      settings.sectionChangesOf("brand", new FormData());
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock("zod");
      vi.resetModules();
    }
  });
});
