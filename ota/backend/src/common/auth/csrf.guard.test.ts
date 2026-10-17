// The CSRF guard's check (OBE-013; OADR-0006 point 3, api-changes §2.4) and the guard around it with a minimal
// execution context: which requests it checks, and what passes. The guard in the API's pipeline, against the
// operations of the document: test/integration/common/guards.int.test.ts.
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { newCsrfToken } from "../../../test/helpers/api-env";
import type { Caller, CallerContext } from "../../tenancy/caller-resolver";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";
import { newId } from "../ids";
import { CSRF_COOKIE, CsrfGuard, csrfProblem, type CsrfRequest } from "./csrf.guard";

const HOST = "demo.ota.example.com";
const TOKEN = newCsrfToken();

/** A request of a storefront page on HOST with a matching CSRF pair, changed by `change`. */
function storefrontRequest(
  change: {
    headers?: Record<string, string | undefined>;
    cookies?: Record<string, unknown> | undefined;
  } = {},
): CsrfRequest {
  const headers: Record<string, string | undefined> = {
    origin: `https://${HOST}`,
    "x-csrf-token": TOKEN,
    ...change.headers,
  };
  return {
    host: HOST,
    headers,
    cookies: "cookies" in change ? change.cookies : { [CSRF_COOKIE]: TOKEN },
  };
}

describe("csrfProblem", () => {
  it("passes the matching pair from the storefront's own origin", () => {
    expect(csrfProblem(storefrontRequest())).toBeUndefined();
    // Browsers send the scheme and host in lower case, but the comparison does not depend on it.
    expect(
      csrfProblem(storefrontRequest({ headers: { origin: `HTTPS://${HOST.toUpperCase()}` } })),
    ).toBeUndefined();
  });

  it("refuses a missing header or cookie as token_missing [OBE-013 AC1]", () => {
    expect(csrfProblem(storefrontRequest({ headers: { "x-csrf-token": undefined } }))).toBe("token_missing");
    expect(csrfProblem(storefrontRequest({ headers: { "x-csrf-token": "" } }))).toBe("token_missing");
    expect(csrfProblem(storefrontRequest({ cookies: {} }))).toBe("token_missing");
    expect(csrfProblem(storefrontRequest({ cookies: undefined }))).toBe("token_missing");
    expect(csrfProblem(storefrontRequest({ cookies: { [CSRF_COOKIE]: ["a", "b"] } }))).toBe("token_missing");
  });

  it("refuses a different header, a malformed pair and a repeated header as token_mismatch [OBE-013 AC1]", () => {
    expect(csrfProblem(storefrontRequest({ headers: { "x-csrf-token": newCsrfToken() } }))).toBe(
      "token_mismatch",
    );
    // Equal but not the shape storefront.get issues (a cookie set by other means).
    expect(
      csrfProblem(
        storefrontRequest({ headers: { "x-csrf-token": "short" }, cookies: { [CSRF_COOKIE]: "short" } }),
      ),
    ).toBe("token_mismatch");
    expect(csrfProblem(storefrontRequest({ headers: { "x-csrf-token": `${TOKEN}, ${TOKEN}` } }))).toBe(
      "token_mismatch",
    );
  });

  it("refuses a foreign Origin, another scheme or port, and null as origin_mismatch [OBE-013 AC1]", () => {
    for (const origin of [
      "https://attacker.example",
      `https://${HOST}.attacker.example`,
      "https://other.ota.example.com",
      `http://${HOST}`,
      `https://${HOST}:8443`,
      "null",
    ]) {
      expect([origin, csrfProblem(storefrontRequest({ headers: { origin } }))]).toEqual([
        origin,
        "origin_mismatch",
      ]);
    }
  });

  it("accepts a request without Origin only with Sec-Fetch-Site: same-origin", () => {
    expect(
      csrfProblem(storefrontRequest({ headers: { origin: undefined, "sec-fetch-site": "same-origin" } })),
    ).toBeUndefined();
    for (const site of [undefined, "same-site", "cross-site", "none"]) {
      expect([
        site,
        csrfProblem(storefrontRequest({ headers: { origin: undefined, "sec-fetch-site": site } })),
      ]).toEqual([site, "origin_mismatch"]);
    }
  });
});

describe("CsrfGuard", () => {
  class Handlers {
    bound(): void {}
    unbound(): void {}
  }
  Reflect.defineMetadata(OPENAPI_OPERATION, "createFlightSearch", Handlers.prototype.bound);

  const EDGE: Caller = { type: "edge", id: "edge", host: HOST };
  const keyId = newId("key");
  const KEY: Caller = {
    type: "key",
    id: keyId,
    keyId,
    kind: "publishable",
    tenantId: newId("ten"),
    environment: "test",
    scopes: [],
  };

  function guard(caller: Caller | undefined): CsrfGuard {
    return new CsrfGuard(new Reflector(), { get: () => caller } as unknown as CallerContext);
  }

  /** An execution context of `method` on `handler` without any CSRF header, cookie or Origin. */
  function bare(method: string, handler: () => void = Handlers.prototype.bound): ExecutionContext {
    const req = { method, headers: {}, cookies: {} };
    return {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => Handlers,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
  }

  it("checks the edge caller's POST, PUT, PATCH and DELETE: 403 CSRF_TOKEN_INVALID [OBE-013 AC1]", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(() => guard(EDGE).canActivate(bare(method))).toThrow(
        expect.objectContaining({
          code: "CSRF_TOKEN_INVALID",
          status: 403,
          details: { reason: "token_missing" },
        }),
      );
    }
  });

  it("never checks GET, HEAD or OPTIONS, key callers, or handlers outside the document [OBE-013 AC1]", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(guard(EDGE).canActivate(bare(method))).toBe(true);
    }
    expect(guard(KEY).canActivate(bare("POST"))).toBe(true);
    expect(guard({ type: "anonymous", id: "anonymous" }).canActivate(bare("POST"))).toBe(true);
    expect(guard(EDGE).canActivate(bare("POST", Handlers.prototype.unbound))).toBe(true);
  });

  it("throws when the caller guard has not run", () => {
    expect(() => guard(undefined).canActivate(bare("POST"))).toThrow(/CallerGuard must run first/);
  });
});
