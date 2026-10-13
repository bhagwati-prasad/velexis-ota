import { describe, expect, it, vi } from "vitest";

// Liveness must not depend on the configuration: a broken environment shows up in /health/ready only.
vi.mock("@/lib/config", () => ({
  getConfig: () => {
    throw new Error("/health/live must not read the configuration");
  },
}));

import { GET } from "./route";

describe("GET /health/live", () => {
  it("answers 200 without checking the platform API or reading the configuration", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
