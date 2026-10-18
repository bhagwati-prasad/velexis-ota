import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => nextHeaders);

import { createPlatformApi, type PlatformApi } from "./api";
import {
  ACCESS_TOKEN_COOKIE,
  MFA_CHALLENGE_COOKIE,
  REFRESH_REUSE_MS,
  REFRESH_TOKEN_COOKIE,
  accessTokenClaims,
  clearSession,
  clearedCookie,
  clearedSessionCookies,
  createRefresh,
  isAccessTokenFresh,
  mfaChallengeCookie,
  refreshTokenKey,
  safeNextPath,
  sessionCookies,
  sessionTokens,
  setSession,
  writeCookies,
  type AdminSession,
  type CookieWrite,
} from "./session";

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.parse("2026-10-18T10:00:00Z");
const BFF_KEY = "test_bff_key_0123456789abcdef_0123456789";

/** A JWT with the given payload; the signature is a dummy (the admin never checks it, the API does). */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

function adminSession(overrides: Partial<AdminSession> = {}): AdminSession {
  return {
    accessToken: jwt({ sub: "acc_1", aud: "platform_admin", typ: "admin", exp: NOW / 1000 + 900 }),
    accessTokenExpiresAt: new Date(NOW + 900_000).toISOString(),
    refreshToken: "rotated-refresh-token",
    refreshTokenExpiresAt: new Date(NOW + 2 * 3600_000).toISOString(),
    admin: {
      id: "acc_01JA2YQ3M7R1T5W9Z3C7F1H5K9",
      email: "lena.holm@example.com",
      fullName: "Lena Holm",
      features: {
        stripeBilling: false,
        ownStripe: false,
        settlements: false,
        ownAmadeus: false,
        customDomains: false,
        liveSwitch: false,
      },
    },
    ...overrides,
  };
}

/** The `Set-Cookie` lines that Next.js writes for `writes`. */
function setCookieLines(writes: readonly CookieWrite[]): string[] {
  const response = NextResponse.next();
  writeCookies(response.cookies, writes);
  return response.headers.getSetCookie();
}

const fetchMock = vi.fn<(input: Request) => Promise<Response>>();

function apiClient(): PlatformApi {
  return createPlatformApi({
    baseUrl: "http://127.0.0.1:3100",
    bffKey: BFF_KEY,
    requestHeaders: new Headers({ "X-Forwarded-For": "6.6.6.6, 203.0.113.7", "User-Agent": "Agent/1.0" }),
  });
}

/** A fetch answer that waits until `release()` is called, so calls overlap like parallel page requests. */
function deferredAnswer(): { answer: Promise<Response>; release: (response: Response) => void } {
  let release: (response: Response) => void = () => undefined;
  const answer = new Promise<Response>((resolveAnswer) => {
    release = resolveAnswer;
  });
  return { answer, release };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("refresh (single flight)", () => {
  it("[PAD-002 AC3] five parallel refreshes of one refresh token make exactly one adminRefresh call", async () => {
    const refresh = createRefresh(() => NOW);
    const api = apiClient();
    const { answer, release } = deferredAnswer();
    fetchMock.mockReturnValue(answer);

    const pending = Array.from({ length: 5 }, () => refresh("expiring-refresh-token", api));
    release(Response.json(adminSession()));
    const outcomes = await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]![0];
    expect(request.url).toBe("http://127.0.0.1:3100/v1/admin/auth/refresh");
    expect(await request.json()).toEqual({ refreshToken: "expiring-refresh-token" });
    // [PAD-002 AC4] the refresh call carries the end-user headers too, and no bearer token.
    expect(request.headers.get("x-velexis-end-user-ip")).toBe("203.0.113.7");
    expect(request.headers.get("x-velexis-end-user-agent")).toBe("Agent/1.0");
    expect(request.headers.get("x-velexis-bff-key")).toBe(BFF_KEY);
    expect(request.headers.has("authorization")).toBe(false);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: true, session: adminSession() });
    }
  });

  it("reuses the outcome for 10 seconds after it settled, then calls again", async () => {
    let clock = NOW;
    const refresh = createRefresh(() => clock);
    const api = apiClient();
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(adminSession())));

    await refresh("token-a", api);
    clock += REFRESH_REUSE_MS - 1;
    await refresh("token-a", api);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 1;
    await refresh("token-a", api);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(REFRESH_REUSE_MS).toBe(10_000);
  });

  it("keeps a pending refresh in flight however long the API takes", async () => {
    let clock = NOW;
    const refresh = createRefresh(() => clock);
    const api = apiClient();
    const { answer, release } = deferredAnswer();
    fetchMock.mockReturnValue(answer);

    const first = refresh("slow-token", api);
    clock += 60_000;
    const second = refresh("slow-token", api);
    release(Response.json(adminSession()));

    expect(await second).toEqual(await first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes different refresh tokens separately", async () => {
    const refresh = createRefresh(() => NOW);
    const api = apiClient();
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(adminSession())));

    await Promise.all([refresh("token-a", api), refresh("token-b", api), refresh("token-a", api)]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a final failure (the token can never work again) and marks it final", async () => {
    const refresh = createRefresh(() => NOW);
    const api = apiClient();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          { error: { code: "REFRESH_TOKEN_REUSED", status: 401, message: "m", requestId: "req_1" } },
          { status: 401 },
        ),
      ),
    );

    const first = await refresh("reused-token", api);
    const second = await refresh("reused-token", api);

    expect(first).toMatchObject({
      ok: false,
      final: true,
      error: { code: "REFRESH_TOKEN_REUSED", status: 401 },
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["REFRESH_TOKEN_INVALID", 401],
    ["VALIDATION_FAILED", 400],
  ])("treats %s as final", async (code, status) => {
    const refresh = createRefresh(() => NOW);
    fetchMock.mockResolvedValue(
      Response.json({ error: { code, status, message: "m", requestId: "r" } }, { status }),
    );

    expect(await refresh(`token-${code}`, apiClient())).toMatchObject({ ok: false, final: true });
  });

  it("forgets a failure that may pass (API unavailable, rate limited), so the next request tries again", async () => {
    const refresh = createRefresh(() => NOW);
    const api = apiClient();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code: "RATE_LIMITED", status: 429, message: "m", requestId: "r" } },
        { status: 429 },
      ),
    );
    fetchMock.mockResolvedValueOnce(Response.json(adminSession()));

    const unavailable = await refresh("token-c", api);
    const limited = await refresh("token-c", api);
    const refreshed = await refresh("token-c", api);

    expect(unavailable).toMatchObject({ ok: false, final: false, error: { code: "SERVICE_UNAVAILABLE" } });
    expect(limited).toMatchObject({ ok: false, final: false, error: { code: "RATE_LIMITED" } });
    expect(refreshed).toEqual({ ok: true, session: adminSession() });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keys the flights by the SHA-256 of the refresh token, never by the token", () => {
    const key = refreshTokenKey("some-refresh-token");

    expect(key).toBe(createHash("sha256").update("some-refresh-token").digest("hex"));
    expect(key).not.toContain("some-refresh-token");
  });
});

describe("session cookies", () => {
  it("[PAD-002 AC1] writes both session cookies HttpOnly, Secure, SameSite=Strict, Path=/ with the __Host-vxa_ prefix [PF-80]", () => {
    const lines = setCookieLines(sessionCookies(adminSession(), NOW));

    expect(lines).toHaveLength(2);
    const [access, refreshCookie] = lines as [string, string];
    expect(access).toMatch(/^__Host-vxa_at=[A-Za-z0-9_.-]+; /);
    expect(refreshCookie).toMatch(/^__Host-vxa_rt=rotated-refresh-token; /);
    for (const line of lines) {
      expect(line).toMatch(/; Path=\/(;|$)/);
      expect(line).toMatch(/; Secure(;|$)/);
      expect(line).toMatch(/; HttpOnly(;|$)/);
      expect(line).toMatch(/; SameSite=strict(;|$)/i);
      expect(line).not.toMatch(/SameSite=(lax|none)/i);
      expect(line).not.toMatch(/Domain=/i);
    }
    expect(access).toContain("Max-Age=900");
    expect(refreshCookie).toContain(`Max-Age=${2 * 3600}`);
  });

  it("keeps the access cookie within 15 minutes and the refresh cookie within the family's 12 hours", () => {
    const writes = sessionCookies(
      adminSession({
        accessTokenExpiresAt: new Date(NOW + 3600_000).toISOString(),
        refreshTokenExpiresAt: "not a date",
      }),
      NOW,
    );

    expect(writes.map((write) => [write.name, write.options.maxAge])).toEqual([
      [ACCESS_TOKEN_COOKIE, 900],
      [REFRESH_TOKEN_COOKIE, 12 * 3600],
    ]);
  });

  it("[PAD-002 AC1] writes the MFA challenge with SameSite=Strict for at most 5 minutes", () => {
    const write = mfaChallengeCookie("challenge", 300);

    expect([write.name, write.options.sameSite, write.options.maxAge]).toEqual([
      MFA_CHALLENGE_COOKIE,
      "strict",
      300,
    ]);
    expect(setCookieLines([write])).toEqual([
      expect.stringMatching(
        /^__Host-vxa_mfa=challenge; Path=\/; .*Max-Age=300; Secure; HttpOnly; SameSite=strict$/i,
      ),
    ]);
    expect(mfaChallengeCookie("challenge", 3600).options.maxAge).toBe(300);
    expect(mfaChallengeCookie("challenge", 0).options.maxAge).toBe(1);
    expect(mfaChallengeCookie("challenge", Number.NaN).options.maxAge).toBe(1);
  });

  it("deletes cookies with the same attributes and Max-Age=0, as a browser requires for __Host- cookies", () => {
    const lines = setCookieLines([...clearedSessionCookies(), clearedCookie(MFA_CHALLENGE_COOKIE)]);

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(
        /^__Host-vxa_(at|rt|mfa)=; Path=\/; Max-Age=0; .*Secure; HttpOnly; SameSite=strict$/i,
      );
    }
  });

  it("reads the session tokens; an empty cookie counts as absent", () => {
    const cookies = new Map([
      [ACCESS_TOKEN_COOKIE, { value: "" }],
      [REFRESH_TOKEN_COOKIE, { value: "refresh-value" }],
    ]);

    expect(sessionTokens({ get: (name) => cookies.get(name) })).toEqual({ refreshToken: "refresh-value" });
  });

  it("never reads the portal's session cookies", () => {
    const cookies = new Map([
      ["__Host-vxp_at", { value: "portal-access" }],
      ["__Host-vxp_rt", { value: "portal-refresh" }],
    ]);

    expect(sessionTokens({ get: (name) => cookies.get(name) })).toEqual({});
  });

  it("setSession and clearSession write through cookies() of next/headers", async () => {
    const store = { set: vi.fn() };
    nextHeaders.cookies.mockResolvedValue(store);

    await setSession(adminSession());
    await clearSession();

    expect(store.set.mock.calls.map(([name, value]) => [name, value === "" ? "" : "set"])).toEqual([
      [ACCESS_TOKEN_COOKIE, "set"],
      [REFRESH_TOKEN_COOKIE, "set"],
      [ACCESS_TOKEN_COOKIE, ""],
      [REFRESH_TOKEN_COOKIE, ""],
    ]);
    expect(
      store.set.mock.calls.every(
        ([, , options]) => options.httpOnly && options.secure && options.sameSite === "strict",
      ),
    ).toBe(true);
  });
});

describe("access token claims", () => {
  it("reads exp of an admin token without checking the signature", () => {
    expect(accessTokenClaims(jwt({ exp: 1_800_000_000, aud: "platform_admin" }))).toEqual({
      exp: 1_800_000_000,
    });
  });

  it("refuses a token of another audience: a portal token is no admin session", () => {
    expect(accessTokenClaims(jwt({ exp: 1_800_000_000, aud: "portal" }))).toBeUndefined();
    expect(accessTokenClaims(jwt({ exp: 1_800_000_000 }))).toBeUndefined();
    expect(accessTokenClaims(jwt({ exp: 1_800_000_000, aud: ["platform_admin"] }))).toBeUndefined();
  });

  it.each([
    "",
    "not-a-jwt",
    "a.b",
    "a.%%%.c",
    `${jwt({ aud: "platform_admin" })}`,
    "a.bnVsbA.c",
    "a.e30.c.d",
  ])("returns undefined for an unreadable token %#", (token) => {
    expect(accessTokenClaims(token)).toBeUndefined();
  });

  it("counts a token as fresh until 30 seconds before it expires", () => {
    const claims = { exp: NOW / 1000 + 60 };

    expect(isAccessTokenFresh(claims, NOW)).toBe(true);
    expect(isAccessTokenFresh(claims, NOW + 29_999)).toBe(true);
    expect(isAccessTokenFresh(claims, NOW + 30_000)).toBe(false);
    expect(isAccessTokenFresh(undefined, NOW)).toBe(false);
  });
});

describe("safeNextPath", () => {
  it.each([
    "https://evil.example/x",
    "//evil.example",
    "http://evil.example",
    "HTTPS://evil.example/x",
    "javascript:alert(1)",
    "evil.example/x",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/ok\u0000",
    "",
  ])("ignores the absolute, protocol-relative or malformed value %j", (value) => {
    expect(safeNextPath(value)).toBeUndefined();
  });

  it("ignores a missing value and one longer than 2 048 characters", () => {
    expect(safeNextPath(null)).toBeUndefined();
    expect(safeNextPath(undefined)).toBeUndefined();
    expect(safeNextPath(`/${"a".repeat(2047)}`)).toHaveLength(2048);
    expect(safeNextPath(`/${"a".repeat(2048)}`)).toBeUndefined();
  });

  it.each([
    ["/", "/"],
    ["/tenants?status=suspended&plan=growth", "/tenants?status=suspended&plan=growth"],
    ["/tenants/ten_1#audit", "/tenants/ten_1#audit"],
    ["/tenants/../audit", "/audit"],
    ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
  ])("keeps the relative path %j", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });
});

// ---- Client components never import the server-only modules ------------------------------------------------

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const SERVER_MODULES = ["lib/api", "lib/session", "lib/end-user", "lib/config"];
const IMPORT_SPECIFIER =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** The directive of a module ("use client" or "use server"), after leading comments and blank lines. */
function directiveOf(source: string): "use client" | "use server" | undefined {
  const body = source.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  const match = /^(["'])(use client|use server)\1/.exec(body);
  return match?.[2] as "use client" | "use server" | undefined;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The source file a local specifier names, or `undefined` for a package import. */
function resolveLocal(srcDir: string, fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = join(srcDir, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return undefined;
  }
  const withoutJsExtension = base.replace(/\.(?:js|jsx|mjs)$/, "");
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${withoutJsExtension}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function isServerModule(srcDir: string, file: string): boolean {
  const name = relative(srcDir, file)
    .replace(/\\/g, "/")
    .replace(/\.[^./]+$/, "");
  return SERVER_MODULES.includes(name);
}

/**
 * Every client component (a module starting with "use client") that imports a server-only module, directly or
 * through other local modules. Imports of type only count too. A "use server" module (server actions) ends the
 * search: client components may call actions, and actions use the API.
 */
function clientImportsOfServerModules(srcDir: string): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(srcDir)) {
    if (directiveOf(readFileSync(file, "utf8")) !== "use client") {
      continue;
    }
    const seen = new Set<string>([file]);
    const queue: { file: string; chain: string[] }[] = [{ file, chain: [relative(srcDir, file)] }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const match of readFileSync(current.file, "utf8").matchAll(IMPORT_SPECIFIER)) {
        const target = resolveLocal(srcDir, current.file, match[1] ?? match[2] ?? match[3] ?? "");
        if (target === undefined || seen.has(target)) {
          continue;
        }
        seen.add(target);
        const chain = [...current.chain, relative(srcDir, target)];
        if (isServerModule(srcDir, target)) {
          found.push(chain.join(" -> "));
        } else if (directiveOf(readFileSync(target, "utf8")) !== "use server") {
          queue.push({ file: target, chain });
        }
      }
    }
  }
  return found.sort();
}

describe("client components and the server-only modules", () => {
  let fixture: string | undefined;

  afterEach(() => {
    if (fixture !== undefined) {
      rmSync(fixture, { recursive: true, force: true });
      fixture = undefined;
    }
  });

  function writeFixture(files: Record<string, string>): string {
    fixture = mkdtempSync(join(tmpdir(), "pad-002-client-imports-"));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), content);
    }
    return fixture;
  }

  it('no file with "use client" in src/ imports lib/api, lib/session, lib/end-user or lib/config', () => {
    const files = sourceFiles(SRC_DIR);
    expect(files).toContain(join(SRC_DIR, "lib/session.ts"));
    expect(
      files.filter((file) => directiveOf(readFileSync(file, "utf8")) === "use client").length,
    ).toBeGreaterThan(0);
    expect(clientImportsOfServerModules(SRC_DIR)).toEqual([]);
  });

  it("the scan fails for every way a client component can import them", () => {
    const src = writeFixture({
      "lib/api.ts": 'import "server-only";\nexport const platformApi = 1;\n',
      "lib/session.ts": 'import "server-only";\nexport const refresh = 1;\n',
      "lib/format.ts": 'import { refresh } from "./session";\nexport const format = refresh;\n',
      "components/alias.tsx": '"use client";\nimport { platformApi } from "@/lib/api";\n',
      "components/relative.tsx":
        "// A comment first.\n'use client';\nimport { refresh } from '../lib/session';\n",
      "components/type-only.tsx": '"use client";\nimport type { PlatformApi } from "@/lib/api.ts";\n',
      "components/dynamic.tsx": '"use client";\nconst api = import("@/lib/api");\n',
      "components/re-export.tsx": '"use client";\nexport { refresh } from "@/lib/session";\n',
      "components/through-helper.tsx": '"use client";\nimport { format } from "@/lib/format";\n',
    });

    expect(clientImportsOfServerModules(src)).toEqual([
      "components/alias.tsx -> lib/api.ts",
      "components/dynamic.tsx -> lib/api.ts",
      "components/re-export.tsx -> lib/session.ts",
      "components/relative.tsx -> lib/session.ts",
      "components/through-helper.tsx -> lib/format.ts -> lib/session.ts",
      "components/type-only.tsx -> lib/api.ts",
    ]);
  });

  it("allows server components and server actions to use them, and client components to call actions", () => {
    const src = writeFixture({
      "lib/api.ts": 'import "server-only";\nexport const platformApi = 1;\n',
      "lib/session.ts": 'import "server-only";\nexport const refresh = 1;\n',
      "app/page.tsx": 'import { platformApi } from "@/lib/api";\nexport default function Page() {}\n',
      "app/actions.ts": '"use server";\nimport { platformApi } from "@/lib/api";\nimport "../lib/session";\n',
      "app/form.tsx": '"use client";\nimport { save } from "./actions";\nimport { cn } from "@/lib/utils";\n',
      "lib/utils.ts": "export const cn = 1;\n",
    });

    expect(clientImportsOfServerModules(src)).toEqual([]);
  });

  it.each(["api.ts", "session.ts", "end-user.ts", "config.ts"])("lib/%s is a server-only module", (file) => {
    const source = readFileSync(join(SRC_DIR, "lib", file), "utf8");

    expect(source.startsWith('import "server-only";\n')).toBe(true);
  });
});
