import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The portal's server actions check their forms with Zod (README §5). GHSA-mrhx-c7xc-m3w5 (memory exhaustion while
 * validating oversized constrained collections) is fixed in Zod 4.6.6: from that release a list's `.max()` refuses an
 * oversized list before any item is checked. The portal pins one exact release at or past it (PFE-029, security review
 * F-4), the same release as the platform admin and the OTA admin (docs/mvp/tech-stack.md).
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

describe("the zod the portal runs", () => {
  it("[PFE-029 AC1] is one exact 4.x release at or past 4.6.6 (GHSA-mrhx-c7xc-m3w5), and the one installed", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
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
});
