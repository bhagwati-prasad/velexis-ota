// The storefront images (OAD-014) against the fake OTA API (OADR-0018 point 10): the real server actions,
// `requireStaff`, `getConsoleRequest` and the SDK, with the SDK's `fetch` answered by src/test/fake-ota-api.ts. The
// upload's exact request (`multipart/form-data` as `fetch` sends it, its parts, the dialog's `Idempotency-Key`,
// `X-Velexis-Environment`), the files refused before any call (an SVG, a file above 1 MB), the API's refusals in the
// admin's words (`ASSET_INVALID` by reason, `409 asset_exists`, `409 asset_in_use`), the key after a refusal and the
// pages revalidated; and the page as Next.js renders it on the server, queried in a detached happy-dom document (the
// rows, the filter and paging a URL gives, what each role is offered, the API's codes). Next.js's request scope,
// `redirect()` and `revalidatePath()` are mocked. Every token, id and name here is a dummy.
import { randomUUID } from "node:crypto";

import type { StaffRole, StorefrontAsset } from "@velexis/ota-sdk";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  apiError,
  fakeOtaApi,
  rateLimited,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/cache", () => nextCache);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/settings/assets",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});

import { INITIAL_ACTION_STATE, type ActionState } from "@/lib/action-state";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import { deleteAsset, uploadAsset, type UploadActionState } from "./actions";
import { MAX_ASSET_BYTES, fileProblemOf, formatBytes, isSvgFile } from "./asset-rules";
import StorefrontAssetsPage from "./page";

const ME = "GET /v1/console/auth/me";
const ASSETS = "/v1/console/settings/assets";
const LOGO_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M1N";
const FAVICON_ID = "ast_01JA6B2C3D4E5F6G7H8J9K0M3Q";
const PAGE_IMAGE_ID = "ast_01JA7P4R6T8V0X2Z4B6D8F0H2K";

/** The first bytes of a PNG file (its signature and the start of its header). */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
/** The first bytes of a GIF file, which the API refuses (`type`) and the admin leaves to it. */
const GIF_BYTES = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");
const SVG_TEXT =
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

const TYPE_MESSAGE =
  "Upload a PNG, JPEG or WebP image (an ICO file for a favicon). SVG files are not accepted.";
const SIZE_MESSAGE = "The image is larger than 1 MB. Make it smaller and upload it again.";
const DIMENSIONS_MESSAGE = "A logo may be at most 2000 × 2000 pixels. Make it smaller and upload it again.";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role` whose switch says `environment`. */
function signedIn(role: StaffRole = "owner", environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`storefront-assets-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-storefront-assets-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
}

/** An uploaded image as the API answers it. */
function asset(overrides: Partial<StorefrontAsset> = {}): StorefrontAsset {
  return {
    id: LOGO_ID,
    kind: "logo",
    contentType: "image/png",
    sizeBytes: 48_213,
    width: 640,
    height: 160,
    fileName: "demo-logo.png",
    url: `https://api.ota.example.com/v1/assets/demo/${LOGO_ID}.png`,
    createdAt: "2026-10-12T10:05:00Z",
    ...overrides,
  };
}

const FAVICON = asset({
  id: FAVICON_ID,
  kind: "favicon",
  contentType: "image/x-icon",
  sizeBytes: 15_086,
  width: 48,
  height: 48,
  fileName: "favicon.ico",
  url: `https://api.ota.example.com/v1/assets/demo/${FAVICON_ID}.ico`,
});

/** The upload's answer: the stored image. */
function serveUpload(answer: StorefrontAsset = asset()): void {
  api.on(`POST ${ASSETS}`, () =>
    Response.json(answer, { status: 201, headers: { "X-Request-Id": "req_upload" } }),
  );
}

/** A file as a browser posts it. */
function file(name: string, type: string, bytes: Uint8Array | string): File {
  return new File([bytes], name, { type });
}

/** The upload form as the dialog posts it. */
function uploadForm(
  key: string,
  fields: { kind?: string; file?: File | string; fileName?: string } = {},
): FormData {
  const form = new FormData();
  form.append("actionKey", key);
  form.append("kind", fields.kind ?? "logo");
  form.append("fileName", fields.fileName ?? "");
  form.append("file", fields.file ?? file("demo-logo.png", "image/png", PNG_BYTES));
  return form;
}

/** The delete form as its dialog posts it. */
function deleteForm(assetId: string): FormData {
  const form = new FormData();
  form.append("assetId", assetId);
  form.append("actionKey", randomUUID());
  return form;
}

/** The one request of `route`, failing the test when there is not exactly one. */
function only(route: string): SentRequest {
  const sent = api.sent(route);
  expect(sent, route).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The requests besides `console.auth.me`. */
function actionRequests(): SentRequest[] {
  return api.requests.filter((request) => `${request.method} ${request.url.pathname}` !== ME);
}

/** The paths the actions revalidated. */
function revalidated(): string[] {
  return nextCache.revalidatePath.mock.calls.map(([path]) => String(path));
}

/** The uploads the SDK made, as the requests `fetch` would send (the body and its `Content-Type` with the boundary). */
function uploads(): Request[] {
  const calls = api.fetch.mock.calls as unknown as [string | URL, RequestInit | undefined][];
  return calls
    .filter(([input, init]) => new URL(String(input)).pathname === ASSETS && init?.method === "POST")
    .map(([input, init]) => new Request(String(input), init));
}

const run = (
  action: (state: ActionState, form: FormData) => Promise<ActionState>,
  form: FormData,
): Promise<UploadActionState> => action(INITIAL_ACTION_STATE, form);

/** The page rendered on the server, in a detached document. */
async function renderPage(search: Record<string, string> = {}): Promise<HTMLElement> {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(
    await StorefrontAssetsPage({ searchParams: Promise.resolve(search) }),
  );
  return document.body as unknown as HTMLElement;
}

// Once per file: the first server render and the SDK's first upload of a fresh worker are the slowest.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn("owner");
  serveUpload();
  api.on(`GET ${ASSETS}`, () => Response.json({ data: [asset()], page: { nextCursor: null, limit: 50 } }));
  await renderPage();
  await run(uploadAsset, uploadForm(randomUUID()));
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(
    new Headers({ "User-Agent": "Mozilla/5.0 Test", "X-Forwarded-For": "203.0.113.7" }),
  );
  nextCache.revalidatePath.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Upload -----------------------------------------------------------------------------------------------------

describe("uploadAsset", () => {
  it("[OAD-014 AC2] sends multipart/form-data with the kind, the name and the file, under the dialog's idempotency key", async () => {
    signedIn("owner", "live");
    serveUpload(asset({ fileName: "Demo logo 2026" }));
    const key = randomUUID();

    const state = await run(uploadAsset, uploadForm(key, { fileName: "  Demo logo 2026 " }));

    const sent = only(`POST ${ASSETS}`);
    expect(sent.headers.get("Idempotency-Key")).toBe(key);
    expect(sent.headers.get("X-Velexis-Environment")).toBe("live");
    expect(sent.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
    expect(sent.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
    const [request] = uploads();
    expect(request?.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    const parts = await request?.formData();
    expect(parts?.get("kind")).toBe("logo");
    expect(parts?.get("fileName")).toBe("Demo logo 2026");
    const sentFile = parts?.get("file");
    expect(sentFile).toBeInstanceOf(File);
    expect((sentFile as File).name).toBe("demo-logo.png");
    expect(new Uint8Array(await (sentFile as File).arrayBuffer())).toEqual(PNG_BYTES);
    expect(state).toEqual({
      ok: true,
      message: "Uploaded Demo logo 2026 as logo. Choose it in the storefront settings to use it.",
      asset: { id: LOGO_ID, kind: "logo", fileName: "Demo logo 2026" },
    });
    expect(revalidated()).toEqual(["/settings/assets", "/settings/storefront"]);
  });

  it("[OAD-014 AC2] sends the same key on a double submit, so the API stores one image", async () => {
    signedIn("admin");
    serveUpload();
    const key = randomUUID();

    await Promise.all([run(uploadAsset, uploadForm(key)), run(uploadAsset, uploadForm(key))]);

    expect(api.sent(`POST ${ASSETS}`).map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      key,
      key,
    ]);
    // Without a name the API keeps the file's own.
    expect((await uploads()[0]?.formData())?.has("fileName")).toBe(false);
  });

  it("[OAD-014 AC2] refuses an SVG before any call, with the API's ASSET_INVALID reason (type)", async () => {
    signedIn("owner");
    serveUpload();
    const svgs = [
      file("logo.svg", "image/svg+xml", SVG_TEXT),
      file("logo.SVG", "", SVG_TEXT),
      // Renamed and typed as a PNG: its bytes still start like markup.
      file("logo.png", "image/png", `\uFEFF \n${SVG_TEXT}`),
    ];

    for (const svg of svgs) {
      const state = await run(uploadAsset, uploadForm(randomUUID(), { file: svg }));
      expect(state, svg.name).toEqual({
        ok: false,
        code: "ASSET_INVALID",
        message: TYPE_MESSAGE,
        fieldErrors: { file: TYPE_MESSAGE },
      });
    }
    expect(actionRequests()).toEqual([]);
  });

  it("[OAD-014 AC2] shows the API's ASSET_INVALID reason for a file it refuses, with a new key for the next upload", async () => {
    signedIn("owner");
    for (const [reason, message] of [
      ["type", TYPE_MESSAGE],
      ["size", SIZE_MESSAGE],
      ["dimensions", DIMENSIONS_MESSAGE],
    ] as const) {
      api.on(`POST ${ASSETS}`, () => apiError("ASSET_INVALID", 422, { details: { reason } }));
      const key = randomUUID();

      const state = await run(
        uploadAsset,
        uploadForm(key, { file: file("animated.png", "image/png", GIF_BYTES) }),
      );

      expect(state).toMatchObject({
        ok: false,
        code: "ASSET_INVALID",
        message,
        requestId: "req_fake_1",
        fieldErrors: { file: message },
      });
      // The API stored the refusal under the key: a corrected file needs a new one.
      expect(state.nextActionKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(state.nextActionKey).not.toBe(key);
    }
    expect(revalidated()).toEqual([]);
  });

  it("refuses a file above 1 MB before any call, which the API would refuse after reading it", async () => {
    signedIn("owner");
    const large = new Uint8Array(MAX_ASSET_BYTES + 1);
    large.set(PNG_BYTES);

    const state = await run(
      uploadAsset,
      uploadForm(randomUUID(), { file: file("photo.png", "image/png", large) }),
    );

    expect(state).toEqual({
      ok: false,
      code: "ASSET_INVALID",
      message: SIZE_MESSAGE,
      fieldErrors: { file: SIZE_MESSAGE },
    });
    expect(actionRequests()).toEqual([]);
  });

  it("[OAD-014] explains 409 asset_exists: this file is already your favicon", async () => {
    signedIn("owner");
    api.on(`POST ${ASSETS}`, () =>
      apiError("CONFLICT", 409, {
        details: { reason: "asset_exists", assetId: FAVICON_ID, kind: "favicon" },
      }),
    );

    const state = await run(uploadAsset, uploadForm(randomUUID(), { kind: "logo" }));

    const message = `This file is already your favicon (${FAVICON_ID}). One file can be one kind of image only: delete that image first, or upload a different file.`;
    expect(state).toMatchObject({ ok: false, code: "CONFLICT", message, fieldErrors: { file: message } });
    expect(state.nextActionKey).toBeDefined();
  });

  it("keeps the key after a refusal the API did not store (429), so a retry replays the upload", async () => {
    signedIn("owner");
    api.on(`POST ${ASSETS}`, () => rateLimited());

    const state = await run(uploadAsset, uploadForm(randomUUID()));

    expect(state).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
      message: "Too many requests, retry in 60 s.",
    });
    expect(state.nextActionKey).toBeUndefined();
  });

  it("[OAD-014] refuses an agent, a finance member and a viewer before any call, naming the permission", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      api = fakeOtaApi();
      vi.stubGlobal("fetch", api.fetch);
      signedIn(role);

      expect(await run(uploadAsset, uploadForm(randomUUID()))).toEqual({
        ok: false,
        code: "FORBIDDEN",
        message: "You do not have permission to do this (settings:write).",
      });
      expect(await run(deleteAsset, deleteForm(LOGO_ID))).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(actionRequests()).toEqual([]);
    }
  });

  it("asks for a kind and a file, and for a reload without the page's key, before any call", async () => {
    signedIn("owner");

    expect(
      await run(
        uploadAsset,
        uploadForm(randomUUID(), { kind: "banner", file: file("empty.png", "image/png", "") }),
      ),
    ).toEqual({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Check the highlighted fields and try again.",
      fieldErrors: { kind: "Choose what the image is for.", file: "Choose an image file." },
    });
    expect(await run(uploadAsset, uploadForm(randomUUID(), { file: "not a file" }))).toMatchObject({
      fieldErrors: { file: "Choose an image file." },
    });
    expect(await run(uploadAsset, uploadForm("not-a-key"))).toEqual({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "This form is out of date. Reload the page and try again.",
    });
    expect(actionRequests()).toEqual([]);
  });
});

// ---- Delete -----------------------------------------------------------------------------------------------------

describe("deleteAsset", () => {
  it("[OAD-014] deletes the image by its id, without If-Match, and revalidates the images and the settings", async () => {
    signedIn("owner");
    api.on(`DELETE ${ASSETS}/${PAGE_IMAGE_ID}`, () => new Response(null, { status: 204 }));

    const state = await run(deleteAsset, deleteForm(PAGE_IMAGE_ID));

    const sent = only(`DELETE ${ASSETS}/${PAGE_IMAGE_ID}`);
    expect(sent.headers.get("If-Match")).toBeNull();
    expect(sent.headers.get("X-Velexis-Environment")).toBe("test");
    expect(state).toEqual({
      ok: true,
      message: "Image deleted. Its public address no longer works; browsers may keep a copy for a while.",
    });
    expect(revalidated()).toEqual(["/settings/assets", "/settings/storefront"]);
  });

  it("[OAD-014] explains 409 asset_in_use: where the image is used and what to do first", async () => {
    signedIn("owner");
    api.on(`DELETE ${ASSETS}/${LOGO_ID}`, () =>
      apiError("CONFLICT", 409, {
        details: {
          reason: "asset_in_use",
          settingsPaths: ["/branding/logoAssetId", "/seo/ogImageAssetId"],
          pageIds: ["stp_01JA7Q1S3U5W7Y9A1C3E5G7J9L"],
        },
      }),
    );

    const state = await run(deleteAsset, deleteForm(LOGO_ID));

    expect(state).toEqual({
      ok: false,
      code: "CONFLICT",
      requestId: "req_fake_1",
      message:
        "This image cannot be deleted: the storefront settings use it as the logo and the social sharing image and a content page shows it. Choose another image there first (Settings → Storefront, Settings → Pages), then delete it.",
    });
    expect(revalidated()).toEqual([]);
  });

  it("says an image that no longer exists is gone, and refuses an id that is not one before any call", async () => {
    signedIn("owner");
    api.on(`DELETE ${ASSETS}/${LOGO_ID}`, () => apiError("NOT_FOUND", 404));

    expect(await run(deleteAsset, deleteForm(LOGO_ID))).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
      message: "This image no longer exists. Reload the page to see the current images.",
    });
    expect(await run(deleteAsset, deleteForm("../settings"))).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
    });
    expect(api.sent(`DELETE ${ASSETS}/${LOGO_ID}`)).toHaveLength(1);
  });
});

// ---- The file check ---------------------------------------------------------------------------------------------

describe("fileProblemOf", () => {
  it("refuses SVG by type, extension or first bytes, and a file above 1 MB; leaves the rest to the API", () => {
    expect(isSvgFile({ name: "logo.svgz", type: "", size: 10 })).toBe(true);
    expect(isSvgFile({ name: "logo.png", type: "IMAGE/SVG+XML", size: 10 })).toBe(true);
    expect(isSvgFile({ name: "logo.png", type: "image/png", size: 10, head: "  <html>" })).toBe(true);
    expect(fileProblemOf({ name: "logo.png", type: "image/png", size: MAX_ASSET_BYTES })).toBeUndefined();
    expect(fileProblemOf({ name: "logo.png", type: "image/png", size: MAX_ASSET_BYTES + 1 })).toBe("size");
    expect(fileProblemOf({ name: "anim.gif", type: "image/gif", size: 10, head: "GIF89a" })).toBeUndefined();
    expect([formatBytes(812), formatBytes(48_213), formatBytes(MAX_ASSET_BYTES)]).toEqual([
      "812 bytes",
      "47 KB",
      "1.0 MB",
    ]);
  });
});

// ---- The page ---------------------------------------------------------------------------------------------------

describe("/settings/assets", () => {
  it("[OAD-014] lists the images with kind, type, size and dimensions, and offers upload and delete to an owner", async () => {
    signedIn("owner");
    api.on(`GET ${ASSETS}`, () =>
      Response.json({ data: [asset(), FAVICON], page: { nextCursor: null, limit: 50 } }),
    );

    const page = await renderPage();

    expect(Object.fromEntries(only(`GET ${ASSETS}`).url.searchParams)).toEqual({ limit: "50" });
    const rows = [...page.querySelectorAll("tr[data-asset]")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
    );
    expect(rows.map((row) => row.slice(1, 5))).toEqual([
      ["Logo", "image/png", "47 KB", "640 × 160 px"],
      ["Favicon", "image/x-icon", "15 KB", "48 × 48 px"],
    ]);
    expect(rows.map((row) => row[6])).toEqual([LOGO_ID, FAVICON_ID]);
    const open = page.querySelector<HTMLAnchorElement>(`tr[data-asset="${LOGO_ID}"] a`);
    expect(open?.getAttribute("href")).toBe(asset().url);
    expect(open?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(page.querySelectorAll('button[aria-label^="Delete "]')).toHaveLength(2);
    expect(
      [...page.querySelectorAll("button")].some((button) => button.textContent === "Upload an image"),
    ).toBe(true);
    expect(page.querySelector('[role="note"]')?.textContent).toContain("metadata in a file");
  });

  it("[OAD-014] sends the kind of the URL, and pages with the API's cursor", async () => {
    signedIn("owner");
    api.on(`GET ${ASSETS}`, () => Response.json({ data: [FAVICON], page: { nextCursor: "c2", limit: 50 } }));

    const page = await renderPage({ kind: "favicon", cursor: "c1" });

    expect(Object.fromEntries(only(`GET ${ASSETS}`).url.searchParams)).toEqual({
      limit: "50",
      kind: "favicon",
      cursor: "c1",
    });
    expect(page.querySelector('nav a[aria-current="page"]')?.textContent).toBe("Favicon");
    const paging = [...page.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Pages"] a')].map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ]);
    expect(paging).toEqual([
      ["First page", "/settings/assets?kind=favicon"],
      ["Next page", "/settings/assets?kind=favicon&cursor=c2"],
    ]);
  });

  it("[OAD-014] shows the images read only to an agent, a finance member and a viewer", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      api = fakeOtaApi();
      vi.stubGlobal("fetch", api.fetch);
      signedIn(role);
      api.on(`GET ${ASSETS}`, () =>
        Response.json({ data: [asset()], page: { nextCursor: null, limit: 50 } }),
      );

      const page = await renderPage();

      expect(page.textContent, role).toContain(
        "Read only: uploading and deleting images needs the permission settings:write.",
      );
      expect(page.querySelector('[data-permission="settings:write"] button')?.hasAttribute("disabled")).toBe(
        true,
      );
      expect(page.querySelector('button[aria-label^="Delete "]'), role).toBeNull();
    }
  });

  it("never sends a kind the API would refuse, and links no address that is not http(s)", async () => {
    signedIn("owner");
    const refused = await renderPage({ kind: "banner" });
    expect(refused.textContent).toContain("This link has a filter the list cannot use");
    expect(actionRequests()).toEqual([]);

    api.on(`GET ${ASSETS}`, () =>
      Response.json({ data: [asset({ url: "javascript:alert(1)" })], page: { nextCursor: null, limit: 50 } }),
    );
    const listed = await renderPage();
    expect(listed.querySelector(`tr[data-asset="${LOGO_ID}"] a`)).toBeNull();
  });

  it("renders the API's refusal with its request id, and redirects an expired session", async () => {
    signedIn("owner");
    api.on(`GET ${ASSETS}`, () => apiError("INTERNAL_ERROR", 500));

    const failed = await renderPage({ kind: "logo" });
    expect(failed.querySelector('[role="alert"] h2')?.textContent).toBe("The images could not be loaded");
    expect(failed.textContent).toContain("req_fake_1");

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    signedIn("owner");
    api.on(`GET ${ASSETS}`, () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => renderPage({ kind: "logo" }))).toBe(
      `/auth/refresh?next=${encodeURIComponent("/settings/assets?kind=logo")}`,
    );
  });

  it("says when there is no image yet", async () => {
    signedIn("owner");
    api.on(`GET ${ASSETS}`, () => Response.json({ data: [], page: { nextCursor: null, limit: 50 } }));

    expect((await renderPage()).textContent).toContain(
      "No image yet. Upload the logo and the favicon first.",
    );
  });
});
