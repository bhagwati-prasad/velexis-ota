// Unit tests of the signed document URLs (OBE-054; OADR-0013 item 9, ADR-0017): signing for the storefront edge and for
// key callers, and the checks of the file endpoint (expired, tampered, foreign keys). The key is random per test
// process; the clock is a fixed instant, so nothing depends on the time the tests run at.
import { randomBytes } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { signUrl } from "@velexis/crypto";
import { describe, expect, it } from "vitest";
import type { Clock } from "../common/clock";
import type { ApiConfig } from "../config";
import { attachmentDisposition } from "./files.controller";
import {
  DOCUMENT_URL_TTL_SECONDS,
  documentFilePath,
  documentUrlExpiry,
  DocumentUrlSigner,
  parseDocumentKey,
  signDocumentUrl,
  verifyDocumentUrl,
} from "./signed-url";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const DOCUMENT_ID = "doc_01JA4CG8B6E9H2L5P8S1W4Z7C0";
const STORAGE_KEY = `tenant_acme/documents/${BOOKING_ID}/${DOCUMENT_ID}.pdf`;
/** A fixed instant with milliseconds, so the rounding of `exp` shows. */
const NOW = new Date(Date.UTC(2030, 0, 15, 8, 30, 12, 345));
const API_URL = "https://api.ota.example.com";

/** The signed path and query of a URL, as the API receives it (the edge's `/api` and a key caller's origin removed). */
function received(url: string): string {
  return url.replace(/^\/api(?=\/v1\/files\/)/, "").replace(/^https:\/\/api\.ota\.example\.com/, "");
}

const signedForEdge = (now = NOW) =>
  signDocumentUrl(STORAGE_KEY, { key: KEY, now, audience: { caller: "edge" } });

describe("signing a document URL", () => {
  it("gives the edge the same-origin path /api/v1/files/<key>?exp=…&sig=… [OBE-054 AC2]", () => {
    const { url, expiresAt } = signedForEdge();

    expect(url.startsWith(`/api/v1/files/${STORAGE_KEY}?exp=`)).toBe(true);
    expect(url).toMatch(/\?exp=[1-9][0-9]*&sig=[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain("://");
    expect(new URL(url, "https://acme.ota.example.com").origin).toBe("https://acme.ota.example.com");
    expect(expiresAt.getTime()).toBe(
      Number(new URL(url, "https://x.invalid").searchParams.get("exp")) * 1000,
    );
  });

  it("gives a key caller an absolute URL on the API host, whatever trailing slash PUBLIC_OTA_API_URL has [OBE-054 AC2]", () => {
    for (const publicApiUrl of [API_URL, `${API_URL}/`]) {
      const { url } = signDocumentUrl(STORAGE_KEY, {
        key: KEY,
        now: NOW,
        audience: { caller: "key", publicApiUrl },
      });
      const parsed = new URL(url);

      expect([parsed.origin, parsed.pathname]).toEqual([API_URL, `/v1/files/${STORAGE_KEY}`]);
      expect([...parsed.searchParams.keys()]).toEqual(["exp", "sig"]);
    }
  });

  it("signs the same path and query for both audiences, valid for five minutes rounded down to the second", () => {
    const edge = signedForEdge();
    const key = signDocumentUrl(STORAGE_KEY, {
      key: KEY,
      now: NOW,
      audience: { caller: "key", publicApiUrl: API_URL },
    });

    expect(received(edge.url)).toBe(received(key.url));
    expect(DOCUMENT_URL_TTL_SECONDS).toBe(300);
    expect(documentUrlExpiry(NOW)).toEqual(new Date(Date.UTC(2030, 0, 15, 8, 35, 12, 0)));
    expect(edge.expiresAt).toEqual(documentUrlExpiry(NOW));
  });
});

describe("checking a request's URL", () => {
  it("accepts the signed path and query until exp, and names the document [OBE-054 AC1]", () => {
    const { url, expiresAt } = signedForEdge();

    for (const now of [NOW, new Date(expiresAt.getTime() - 1), expiresAt]) {
      expect(verifyDocumentUrl(received(url), { key: KEY, now })).toEqual({
        valid: true,
        storageKey: STORAGE_KEY,
        document: {
          schemaName: "tenant_acme",
          tenantKey: "acme",
          bookingId: BOOKING_ID,
          documentId: DOCUMENT_ID,
        },
        expiresAt,
      });
    }
  });

  it("refuses an expired link [OBE-054 AC1]", () => {
    const { url, expiresAt } = signedForEdge();

    for (const now of [new Date(expiresAt.getTime() + 1000), new Date(expiresAt.getTime() + 86_400_000)]) {
      expect(verifyDocumentUrl(received(url), { key: KEY, now })).toEqual({
        valid: false,
        reason: "expired",
      });
    }
  });

  it("refuses a tampered signature, path or expiry, and a URL signed with another key [OBE-054 AC1]", () => {
    const path = received(signedForEdge().url);
    const [base = "", query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const sig = params.get("sig") ?? "";
    const exp = params.get("exp") ?? "";
    const flipped = `${sig.charAt(0) === "A" ? "B" : "A"}${sig.slice(1)}`;
    const otherDocument = base.replace(DOCUMENT_ID, "doc_01JA4CG8C7F0J3M6Q9T2X5A8D1");
    const otherTenant = base.replace("tenant_acme/", "tenant_beta/");
    const tampered = [
      `${base}?exp=${exp}&sig=${flipped}`,
      `${otherDocument}?exp=${exp}&sig=${sig}`,
      `${otherTenant}?exp=${exp}&sig=${sig}`,
      `${base}?exp=${Number(exp) + 3600}&sig=${sig}`,
    ];

    for (const url of tampered) {
      expect([url, verifyDocumentUrl(url, { key: KEY, now: NOW })]).toEqual([
        url,
        { valid: false, reason: "signature" },
      ]);
    }
    expect(verifyDocumentUrl(path, { key: OTHER_KEY, now: NOW })).toEqual({
      valid: false,
      reason: "signature",
    });
  });

  it("refuses a query other than exp then sig, a percent-encoded or dotted path, and a truncated signature", () => {
    const path = received(signedForEdge().url);
    const [base = "", query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const malformed = [
      base,
      `${base}?sig=${params.get("sig") ?? ""}&exp=${params.get("exp") ?? ""}`,
      `${path}&download=1`,
      `${base.replace(/\//g, (slash, index: number) => (index > 9 ? "%2F" : slash))}?${query}`,
      `${base.replace("/documents/", "/documents/./")}?${query}`,
      `${base}?exp=${params.get("exp") ?? ""}&sig=${(params.get("sig") ?? "").slice(1)}`,
    ];

    for (const url of malformed) {
      expect([url, verifyDocumentUrl(url, { key: KEY, now: NOW })]).toEqual([
        url,
        { valid: false, reason: "malformed" },
      ]);
    }
  });

  it("refuses a correctly signed path that is not a document of the file endpoint", () => {
    const expiresAt = documentUrlExpiry(NOW);
    for (const path of [
      `/v1/assets/acme/ast_01JA6B2C3D4E5F6G7H8J9K0M1N.png`,
      `/v1/files/tenant_acme/assets/${"a".repeat(64)}.png`,
      `/v1/files/platform/exports/report.csv`,
      `/v1/files/tenant_acme/documents/${BOOKING_ID}/${DOCUMENT_ID}.png`,
    ]) {
      const url = signUrl(path, { expiresAt, key: KEY });
      expect([path, verifyDocumentUrl(url, { key: KEY, now: NOW })]).toEqual([
        path,
        { valid: false, reason: "not_a_document" },
      ]);
    }
  });
});

describe("document storage keys", () => {
  it("reads the tenant, booking and document of the processor's keys, and nothing else", () => {
    expect(parseDocumentKey(STORAGE_KEY)).toEqual({
      schemaName: "tenant_acme",
      tenantKey: "acme",
      bookingId: BOOKING_ID,
      documentId: DOCUMENT_ID,
    });
    expect(parseDocumentKey(`tenant_alpha_2/documents/${BOOKING_ID}/${DOCUMENT_ID}.pdf`)?.tenantKey).toBe(
      "alpha_2",
    );
    for (const key of [
      `tenant_acme/documents/${BOOKING_ID}/../${DOCUMENT_ID}.pdf`,
      `tenant_acme/documents/${DOCUMENT_ID}.pdf`,
      `tenant_Acme/documents/${BOOKING_ID}/${DOCUMENT_ID}.pdf`,
      `public/documents/${BOOKING_ID}/${DOCUMENT_ID}.pdf`,
      `tenant_acme/assets/${BOOKING_ID}/${DOCUMENT_ID}.pdf`,
      `tenant_acme/documents/${BOOKING_ID}/${DOCUMENT_ID}.pdf/x`,
      `/tenant_acme/documents/${BOOKING_ID}/${DOCUMENT_ID}.pdf`,
    ]) {
      expect([key, parseDocumentKey(key)]).toEqual([key, undefined]);
    }
    expect(documentFilePath(STORAGE_KEY)).toBe(`/v1/files/${STORAGE_KEY}`);
  });
});

describe("DocumentUrlSigner", () => {
  const config = { get: () => API_URL } as unknown as ConfigService<ApiConfig, true>;

  it("signs with the injected clock and PUBLIC_OTA_API_URL, and checks with the same key [OBE-054 AC2]", () => {
    let now = NOW;
    const clock = { now: () => now } as Clock;
    const signer = new DocumentUrlSigner(KEY, clock, config);

    const edge = signer.sign(STORAGE_KEY, "edge");
    const key = signer.sign(STORAGE_KEY, "key");

    expect(edge.url.startsWith("/api/v1/files/")).toBe(true);
    expect(key.url.startsWith(`${API_URL}/v1/files/`)).toBe(true);
    expect([edge.expiresAt, key.expiresAt]).toEqual([documentUrlExpiry(NOW), documentUrlExpiry(NOW)]);
    expect(signer.verify(received(edge.url)).valid).toBe(true);
    now = new Date(edge.expiresAt.getTime() + 1000);
    expect(signer.verify(received(key.url))).toEqual({ valid: false, reason: "expired" });
  });
});

describe("the file's Content-Disposition", () => {
  it("is an attachment with the document's file name, kept to letters, digits, dots, underscores and hyphens", () => {
    expect(attachmentDisposition("VX7K2Q-itinerary.pdf")).toBe('attachment; filename="VX7K2Q-itinerary.pdf"');
    expect(attachmentDisposition('a "b"\r\n;c.pdf')).toBe('attachment; filename="a__b____c.pdf"');
    expect(attachmentDisposition("")).toBe('attachment; filename="document.pdf"');
  });
});
