// The portal links of `/portal` (OAD-012 AC1): built from the configured portal URL and the session's tenant id, and
// from nothing else.
import { describe, expect, it, vi } from "vitest";

import { PORTAL_AREAS, portalLinks, portalOtaUrl } from "./portal-links";

const PORTAL = "https://platform.example.com";
const TENANT = "ten_01JA3B4C5D6E7F8G9H0J1K2M3N";

describe("portalLinks", () => {
  it("[OAD-012 AC1] builds every link as `${PUBLIC_PORTAL_URL}/otas/<tenantId>/<area>`", () => {
    expect(portalLinks(PORTAL, TENANT).map((link) => [link.id, link.href])).toEqual([
      ["overview", `${PORTAL}/otas/${TENANT}`],
      ["api-keys", `${PORTAL}/otas/${TENANT}/api-keys`],
      ["domains", `${PORTAL}/otas/${TENANT}/domains`],
      ["amadeus", `${PORTAL}/otas/${TENANT}/amadeus`],
      ["payments", `${PORTAL}/otas/${TENANT}/payments`],
      ["team", `${PORTAL}/otas/${TENANT}/team`],
      ["billing", `${PORTAL}/otas/${TENANT}/billing`],
      ["go-live", `${PORTAL}/otas/${TENANT}/go-live`],
      ["settings", `${PORTAL}/otas/${TENANT}/settings`],
    ]);
    // Each link carries its area's label and description.
    expect(portalLinks(PORTAL, TENANT).map((link) => link.label)).toEqual(
      PORTAL_AREAS.map((area) => area.label),
    );
  });

  it("[OAD-012 AC1] keeps the configured URL's scheme, host, port and path, and drops its query, fragment and credentials", () => {
    expect(portalOtaUrl("http://localhost:3000", TENANT, "team")).toBe(
      `http://localhost:3000/otas/${TENANT}/team`,
    );
    expect(portalOtaUrl("https://example.com/portal/", TENANT, "billing")).toBe(
      `https://example.com/portal/otas/${TENANT}/billing`,
    );
    expect(portalOtaUrl("https://user:secret@example.com//?next=/elsewhere#top", TENANT, "domains")).toBe(
      `https://example.com/otas/${TENANT}/domains`,
    );
  });

  it("[OAD-012 AC1] builds no link for a value that is not a tenant id", () => {
    for (const tenantId of [
      "",
      "ten_",
      "ten_01JA3B4C5D6E7F8G9H0J1K2M3",
      `${TENANT}/../../admin`,
      `../${TENANT}`,
      "ten_01JA3B4C5D6E7F8G9H0J1K2M3N?x=1",
      "acc_01JA3B4C5D6E7F8G9H0J1K2M3N",
    ]) {
      expect(portalLinks(PORTAL, tenantId)).toEqual([]);
      expect(portalOtaUrl(PORTAL, tenantId, "api-keys")).toBeUndefined();
    }
  });

  it("[OAD-012 AC1] reads nothing but its two arguments: never the process environment's URLs", () => {
    vi.stubEnv("PUBLIC_PORTAL_URL", "https://elsewhere.example.net");
    vi.stubEnv("PUBLIC_OTA_ADMIN_URL", "https://admin.elsewhere.example.net");
    const first = portalLinks(PORTAL, TENANT);
    const second = portalLinks(PORTAL, TENANT);
    expect(second).toEqual(first);
    for (const link of first) {
      expect(new URL(link.href).origin).toBe(PORTAL);
      expect(link.href).not.toContain("elsewhere");
    }
  });
});
