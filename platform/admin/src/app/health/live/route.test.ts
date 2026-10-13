import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import loadCustomRoutes from "next/dist/lib/load-custom-routes";
import { describe, expect, it } from "vitest";

import nextConfig from "../../../../next.config";
import { GET } from "./route";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../../..", import.meta.url)));

/**
 * The static headers Next.js adds to a response for `path`: the header rules of next.config.ts, loaded and
 * compiled to the regular expressions that `next build` writes to routes-manifest.json and the standalone
 * server matches every request against.
 */
async function staticHeadersFor(path: string): Promise<Headers> {
  const { headers: rules } = await loadCustomRoutes(nextConfig);
  const headers = new Headers();
  for (const rule of rules) {
    const { regex } = buildCustomRoute("header", rule);
    if (new RegExp(regex).test(path)) {
      for (const { key, value } of rule.headers) {
        headers.set(key, value);
      }
    }
  }
  return headers;
}

describe("GET /health/live", () => {
  it("[PAD-001 AC1] answers 200 {status: ok} without caching", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("[PAD-001 AC1] carries X-Robots-Tag: noindex and the other static headers", async () => {
    const headers = await staticHeadersFor("/health/live");

    expect(headers.get("x-robots-tag")).toBe("noindex");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("same-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
  });
});

describe("next.config.ts", () => {
  it.each([
    "/",
    "/health/ready",
    "/sign-in",
    "/tenants/ten_01HZX",
    "/_next/static/chunks/main.js",
    "/no-such",
  ])(
    "[PAD-001 AC1] sends X-Robots-Tag: noindex, nosniff and Referrer-Policy: same-origin on %s",
    async (path) => {
      const headers = await staticHeadersFor(path);

      expect(headers.get("x-robots-tag")).toBe("noindex");
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("referrer-policy")).toBe("same-origin");
    },
  );

  it("[PAD-001 AC1] builds standalone output traced from the repository root", () => {
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.outputFileTracingRoot).toBe(REPO_ROOT);
  });

  it("does not announce the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
