// The storefront cookies (OBE-016 step 3; OADR-0006, api-changes §2.3): the exact `Set-Cookie` values, written for
// the storefront edge caller only, `HttpOnly` on every cookie but the CSRF one, and values the CSRF guard accepts.
import type { Response } from "express";
import { describe, expect, it } from "vitest";
import type { Caller, CallerContext } from "../../tenancy/caller-resolver";
import { CSRF_TOKEN_PATTERN } from "../auth/csrf.guard";
import {
  COOKIE_MAX_AGE_SECONDS,
  CookieWriter,
  isWellFormedCsrfValue,
  newCsrfValue,
  storefrontSetCookie,
  STOREFRONT_COOKIES,
  type StorefrontCookie,
} from "./cookie-writer";

const EDGE: Caller = Object.freeze({ type: "edge", id: "edge", host: "alpha.ota.example.com" });
const KEY: Caller = Object.freeze({
  type: "key",
  id: "key_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E",
  keyId: "key_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E",
  kind: "publishable",
  tenantId: "ten_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E",
  environment: "test",
  scopes: ["storefront"],
});
const ANONYMOUS: Caller = Object.freeze({ type: "anonymous", id: "anonymous" });

/** A writer for a request of `caller` (`undefined`: outside a request, or before the caller guard). */
function writerFor(caller: Caller | undefined): CookieWriter {
  return new CookieWriter({ get: () => caller } as unknown as CallerContext);
}

/** A response that records what is appended to `Set-Cookie`. */
function recordingResponse(): { readonly res: Response; readonly setCookies: string[] } {
  const setCookies: string[] = [];
  const res = {
    append(name: string, value: string | string[]) {
      expect(name).toBe("Set-Cookie");
      setCookies.push(...(Array.isArray(value) ? value : [value]));
      return res;
    },
  };
  return { res: res as unknown as Response, setCookies };
}

const ATTRIBUTES = /; (?:Max-Age=\d+|Path=\/|Secure|SameSite=Lax|HttpOnly)/g;

describe("storefrontSetCookie", () => {
  it("writes the CSRF cookie Secure, SameSite=Lax, Path=/, without Domain and without HttpOnly [OBE-016 AC1]", () => {
    const value = newCsrfValue();

    const header = storefrontSetCookie("csrf", value, { maxAgeSeconds: COOKIE_MAX_AGE_SECONDS.csrf });

    expect(header).toBe(`__Host-vx_csrf=${value}; Max-Age=2592000; Path=/; Secure; SameSite=Lax`);
    expect(header).not.toMatch(/HttpOnly/i);
    expect(header).not.toMatch(/Domain/i);
  });

  it("writes every other storefront cookie HttpOnly, with the same attributes", () => {
    const others: StorefrontCookie[] = ["accessToken", "refreshToken", "bookingTokens"];
    for (const cookie of others) {
      const header = storefrontSetCookie(cookie, "abc.DEF-123_x~bkg_1.tok", { maxAgeSeconds: 900 });

      expect(header).toBe(
        `${STOREFRONT_COOKIES[cookie]}=abc.DEF-123_x~bkg_1.tok; Max-Age=900; Path=/; Secure; SameSite=Lax; HttpOnly`,
      );
      // Nothing but the attributes of a __Host- cookie.
      expect(header.slice(header.indexOf(";")).replace(ATTRIBUTES, "")).toBe("");
    }
  });

  it("uses the __Host- prefix for every cookie", () => {
    expect(Object.values(STOREFRONT_COOKIES)).toEqual([
      "__Host-vx_at",
      "__Host-vx_rt",
      "__Host-vx_csrf",
      "__Host-vx_bt",
    ]);
  });

  it("refuses values outside the token alphabet without echoing them, and a bad Max-Age", () => {
    for (const value of ["a b", "a;b", "a,b", 'a"b', "é", "x".repeat(3_801)]) {
      expect(() => storefrontSetCookie("accessToken", value, { maxAgeSeconds: 900 })).toThrow(TypeError);
    }
    let thrown: unknown;
    try {
      storefrontSetCookie("accessToken", "secret;value", { maxAgeSeconds: 900 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain("secret");
    for (const maxAgeSeconds of [-1, 1.5, Number.NaN]) {
      expect(() => storefrontSetCookie("csrf", "abc", { maxAgeSeconds })).toThrow(RangeError);
    }
  });
});

describe("CookieWriter", () => {
  it("appends Set-Cookie for the storefront edge caller", () => {
    const { res, setCookies } = recordingResponse();

    expect(writerFor(EDGE).write(res, "csrf", "A".repeat(43))).toBe(true);

    expect(setCookies).toEqual([
      `__Host-vx_csrf=${"A".repeat(43)}; Max-Age=2592000; Path=/; Secure; SameSite=Lax`,
    ]);
  });

  it("never writes a cookie for a key caller, the anonymous caller or outside a request [OBE-016 AC1]", () => {
    for (const caller of [KEY, ANONYMOUS, undefined]) {
      const { res, setCookies } = recordingResponse();
      const writer = writerFor(caller);

      expect(writer.isEdge()).toBe(false);
      expect(writer.write(res, "csrf", newCsrfValue())).toBe(false);
      expect(writer.clear(res, "accessToken")).toBe(false);
      expect(setCookies).toEqual([]);
    }
  });

  it("clears a cookie with an empty value and Max-Age=0, and appends one header per cookie", () => {
    const { res, setCookies } = recordingResponse();
    const writer = writerFor(EDGE);

    writer.clear(res, "accessToken");
    writer.write(res, "bookingTokens", "bkg_1.tok~bkg_2.tok");

    expect(setCookies).toEqual([
      "__Host-vx_at=; Max-Age=0; Path=/; Secure; SameSite=Lax; HttpOnly",
      "__Host-vx_bt=bkg_1.tok~bkg_2.tok; Max-Age=2592000; Path=/; Secure; SameSite=Lax; HttpOnly",
    ]);
  });

  it("needs an explicit Max-Age for the refresh token, whose lifetime is the session family's", () => {
    const { res, setCookies } = recordingResponse();
    const writer = writerFor(EDGE);

    expect(() => writer.write(res, "refreshToken", "token")).toThrow(TypeError);
    expect(writer.write(res, "refreshToken", "token", 43_200)).toBe(true);
    expect(setCookies).toEqual(["__Host-vx_rt=token; Max-Age=43200; Path=/; Secure; SameSite=Lax; HttpOnly"]);
  });
});

describe("CSRF values", () => {
  it("are 256 random bits in base64url, as the CSRF guard expects", () => {
    const values = new Set(Array.from({ length: 50 }, () => newCsrfValue()));

    expect(values.size).toBe(50);
    for (const value of values) {
      expect(value).toMatch(CSRF_TOKEN_PATTERN);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
      expect(isWellFormedCsrfValue(value)).toBe(true);
    }
  });

  it("tells well-formed cookies from missing and malformed ones", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "short",
      `${"A".repeat(42)}=`,
      "A".repeat(44),
      ["A".repeat(43)],
    ]) {
      expect(isWellFormedCsrfValue(value)).toBe(false);
    }
  });
});
