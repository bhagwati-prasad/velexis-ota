// The content pages and e-mail templates (OAD-015) against the fake OTA API (OADR-0018 point 10): the real server
// actions, `requireStaff`, `getConsoleRequest` and the SDK, with the SDK's `fetch` answered by src/test/fake-ota-api.ts.
// Each action's exact request (method, path, `Idempotency-Key`, `If-Match`, `X-Velexis-Environment`, body), the form's
// own checks and `requireStaff` before any call, the API's refusals as the form's state (a refused body with the line it
// names, `422 TEMPLATE_INVALID` per part and line, `409 page_exists` / `page_linked`, `412`), the key after a refusal and
// the paths revalidated; and the four pages as Next.js renders them on the server, queried in a detached happy-dom
// document (a server-mode SDK client refuses to run in a browser-like test environment, rightly): the requests a URL
// gives, what each role is offered, the API's codes handled on the server, and the forms the pages render posted as they
// are to the real actions. Next.js's request scope, `redirect()` and `revalidatePath()` are mocked. Every token, id and
// name here is a dummy; the OTA is in Europe/Oslo.
import { randomUUID } from "node:crypto";

import type { NotificationTemplate, StaffRole, StorefrontPage } from "@velexis/ota-sdk";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
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
    usePathname: () => "/settings/pages",
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

import { lineExcerpt, lineRange, pageListQueryOf, templateProblemsOf, templateRefOf } from "./content-rules";
import ContentPagePage from "./pages/[pageId]/page";
import { createPage, deletePage, updatePage } from "./pages/actions";
import ContentPagesPage from "./pages/page";
import TemplatePage from "./templates/[key]/[channel]/[locale]/page";
import { previewTemplate, resetTemplate, saveTemplate } from "./templates/actions";
import TemplatesPage from "./templates/page";

const ME = "GET /v1/console/auth/me";
const PAGES = "/v1/console/settings/pages";
const PAGE_ID = "stp_01JA7Q1S3U5W7Y9A1C3E5G7J9L";
const NEW_PAGE_ID = "stp_01JA7Q1S3U5W7Y9A1C3E5G7J9M";
const STOREFRONT = "GET /v1/console/settings/storefront";
const TEMPLATES = "/v1/console/settings/notification-templates";
const CONFIRMED = `${TEMPLATES}/booking.confirmed/email/en`;
const CONFIRMED_FR = `${TEMPLATES}/booking.confirmed/email/fr`;

/** The message of the API's `422 markdown_not_allowed` on line 3, in the admin's words. */
const LINE_3_MESSAGE =
  "Line 3 uses Markdown that content pages do not allow. Change it to the subset the help above the body lists.";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role` whose switch says `environment`. */
function signedIn(role: StaffRole = "owner", environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`content-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-content-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
}

/** A content page as the API answers it. */
function storefrontPage(overrides: Partial<StorefrontPage> = {}): StorefrontPage {
  return {
    id: PAGE_ID,
    slug: "baggage-faq",
    locale: "en",
    kind: "faq",
    title: "Baggage FAQ",
    bodyMarkdown: "## How many bags?\n\nIt depends on your fare.",
    isPublished: true,
    showInFooter: true,
    sortOrder: 20,
    publishedAt: "2026-10-12T08:00:00Z",
    version: 3,
    createdAt: "2026-10-12T08:00:00Z",
    updatedAt: "2026-10-20T09:30:00Z",
    ...overrides,
  };
}

/** A template as the API answers it. */
function template(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
  return {
    key: "booking.confirmed",
    channel: "email",
    locale: "en",
    subject: "Your trip {{booking.reference}} is confirmed",
    bodyHtml: "<p>Hello {{booking.contact.firstName}},</p>",
    bodyText: "Hello {{booking.contact.firstName}},",
    variables: [
      { name: "booking.reference", description: "The booking reference." },
      { name: "booking.contact.firstName", description: "The contact's first name." },
    ],
    customised: true,
    inheritedFrom: null,
    isActive: true,
    version: 4,
    updatedAt: "2026-10-21T10:00:00Z",
    ...overrides,
  };
}

function pageAnswer(page: StorefrontPage, status = 200): Response {
  return Response.json(page, { status, headers: { ETag: `"${page.version}"`, "X-Request-Id": "req_page" } });
}

function listAnswer(data: readonly StorefrontPage[], nextCursor: string | null = null): Response {
  return Response.json(
    { data, page: { nextCursor, limit: 50 } },
    { headers: { "X-Request-Id": "req_list" } },
  );
}

/** The one request of `route`, failing the test when there is not exactly one. */
function only(route: string): SentRequest {
  const sent = api.sent(route);
  expect(sent, route).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The requests besides `console.auth.me`. */
function apiRequests(): SentRequest[] {
  return api.requests.filter((request) => `${request.method} ${request.url.pathname}` !== ME);
}

/** The paths the actions revalidated. */
function revalidated(): string[] {
  return nextCache.revalidatePath.mock.calls.map(([path]) => String(path));
}

/** A form as a browser posts it. */
function formOf(fields: Readonly<Record<string, string>>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  return form;
}

/** The new page's form, as its form posts it. */
function newPageForm(key: string, overrides: Readonly<Record<string, string>> = {}): FormData {
  return formOf({
    actionKey: key,
    slug: "baggage-faq",
    locale: "en",
    kind: "faq",
    title: "  Baggage FAQ ",
    bodyMarkdown: "## How many bags?\r\n\r\nIt depends on your fare.",
    isPublished: "true",
    sortOrder: "20",
    ...overrides,
  });
}

/** A page's form, as its form posts it. */
function pageForm(overrides: Readonly<Record<string, string>> = {}): FormData {
  return formOf({
    pageId: PAGE_ID,
    version: "3",
    kind: "faq",
    title: "Baggage FAQ",
    bodyMarkdown: "## How many bags?\n\nIt depends on your fare.\n\n<b>Not allowed</b>",
    isPublished: "true",
    showInFooter: "true",
    sortOrder: "20",
    ...overrides,
  });
}

/** A template's form, as its form posts it. */
function templateForm(overrides: Readonly<Record<string, string>> = {}): FormData {
  return formOf({
    templateKey: "booking.confirmed",
    channel: "email",
    locale: "en",
    version: "4",
    subject: "Booked: {{booking.reference}}",
    bodyHtml: "<p>Hello {{booking.contact.firstName}},</p>\r\n<p>{{booking.pnr}}</p>",
    bodyText: "Hello {{booking.contact.firstName}},",
    isActive: "true",
    ...overrides,
  });
}

const run = <S extends ActionState>(
  action: (state: ActionState, form: FormData) => Promise<S>,
  form: FormData,
): Promise<S> => action(INITIAL_ACTION_STATE, form);

/** A server component's `searchParams` for a query string, as Next.js parses it. */
function searchParamsOf(search: string): Record<string, string | string[]> {
  const query = new URLSearchParams(search);
  const record: Record<string, string | string[]> = {};
  for (const name of new Set(query.keys())) {
    const values = query.getAll(name);
    record[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return record;
}

/** A page's element rendered to HTML on the "server" and parsed into a detached document. */
async function render(element: Promise<ReactElement>): Promise<HTMLElement> {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(await element);
  return document.body as unknown as HTMLElement;
}

const pagesList = (search = "") =>
  render(ContentPagesPage({ searchParams: Promise.resolve(searchParamsOf(search)) }));
const contentPage = (pageId: string) => render(ContentPagePage({ params: Promise.resolve({ pageId }) }));
const templatesList = () => render(TemplatesPage());
const templatePage = (key: string, channel: string, locale: string) =>
  render(TemplatePage({ params: Promise.resolve({ key, channel, locale }) }));

/** The fields a rendered form posts, as a Node `FormData` (happy-dom reads the inputs as a browser would). */
function formDataOf(form: HTMLFormElement): FormData {
  // happy-dom 17 selects the option before the one marked `selected` when it parses server-rendered HTML; a browser
  // selects the marked one, so the select is set to it first.
  for (const select of form.querySelectorAll("select")) {
    const marked = select.querySelector<HTMLOptionElement>("option[selected]");
    if (marked !== null) {
      select.value = marked.value;
    }
  }
  const window = form.ownerDocument.defaultView as unknown as { FormData: new (form: unknown) => FormData };
  const posted = new FormData();
  for (const [name, value] of new window.FormData(form).entries()) {
    posted.append(name, String(value));
  }
  return posted;
}

/** The form of a rendered page that holds an input named `name`. */
function formWith(body: HTMLElement, name: string): HTMLFormElement {
  const form = body.querySelector(`[name="${name}"]`)?.closest("form");
  if (form === null || form === undefined) {
    throw new Error(`no form with ${name}`);
  }
  return form;
}

// Once per file: the first server render and the SDK's first call are the slowest in a fresh worker.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn("owner");
  api.on(`GET ${PAGES}`, () => listAnswer([storefrontPage()]));
  api.on(`GET ${PAGES}/${PAGE_ID}`, () => pageAnswer(storefrontPage()));
  api.on(`GET ${CONFIRMED}`, () => Response.json(template()));
  await pagesList();
  await contentPage(PAGE_ID);
  await templatePage("booking.confirmed", "email", "en");
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

// ---- Pages: create ----------------------------------------------------------------------------------------------

describe("createPage", () => {
  it("sends the new page under the form's idempotency key, then opens the page's own form", async () => {
    signedIn("owner", "live");
    api.on(`POST ${PAGES}`, () => pageAnswer(storefrontPage({ id: NEW_PAGE_ID, version: 1 }), 201));
    const key = randomUUID();

    const target = await redirectOf(() => run(createPage, newPageForm(key)));

    expect(target).toBe(`/settings/pages/${NEW_PAGE_ID}`);
    const sent = only(`POST ${PAGES}`);
    expect(sent.headers.get("Idempotency-Key")).toBe(key);
    expect(sent.headers.get("X-Velexis-Environment")).toBe("live");
    expect(sent.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
    expect(sent.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
    // The title trimmed, the body's line breaks as `\n`, an unticked checkbox `false`.
    expect(sent.body).toEqual({
      slug: "baggage-faq",
      locale: "en",
      kind: "faq",
      title: "Baggage FAQ",
      bodyMarkdown: "## How many bags?\n\nIt depends on your fare.",
      isPublished: true,
      showInFooter: false,
      sortOrder: 20,
    });
    expect(revalidated()).toEqual(["/settings/pages"]);
  });

  it("sends the same key on a double submit, so the API creates one page", async () => {
    signedIn("admin");
    api.on(`POST ${PAGES}`, () => pageAnswer(storefrontPage({ id: NEW_PAGE_ID, version: 1 }), 201));
    const key = randomUUID();

    await Promise.all([
      redirectOf(() => run(createPage, newPageForm(key))),
      redirectOf(() => run(createPage, newPageForm(key))),
    ]);

    expect(api.sent(`POST ${PAGES}`).map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      key,
      key,
    ]);
  });

  it("refuses an agent, finance and a viewer before any call", async () => {
    for (const role of ["agent", "finance", "viewer"] as const) {
      api = fakeOtaApi();
      vi.stubGlobal("fetch", api.fetch);
      signedIn(role);

      const state = await run(createPage, newPageForm(randomUUID()));

      expect(state, role).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
        message: "You do not have permission to do this (settings:write).",
      });
      expect(apiRequests(), role).toEqual([]);
    }
  });

  it("names every problem of the form at once, before any call", async () => {
    signedIn("owner");

    const state = await run(
      createPage,
      newPageForm(randomUUID(), {
        slug: "Baggage FAQ",
        locale: "english",
        kind: "blog",
        title: "   ",
        sortOrder: "10001",
        bodyMarkdown: "x".repeat(50_001),
      }),
    );

    expect(state).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual([
      "bodyMarkdown",
      "kind",
      "locale",
      "slug",
      "sortOrder",
      "title",
    ]);
    expect(apiRequests()).toEqual([]);
  });

  it("puts a locale in the API's spelling", async () => {
    signedIn("owner");
    api.on(`POST ${PAGES}`, () => pageAnswer(storefrontPage({ id: NEW_PAGE_ID, version: 1 }), 201));

    await redirectOf(() => run(createPage, newPageForm(randomUUID(), { locale: "fr_ca" })));

    expect((only(`POST ${PAGES}`).body as { locale: string }).locale).toBe("fr-CA");
  });

  it("[OAD-015 AC2] shows a refused body on its line, with a new key for the corrected page", async () => {
    signedIn("owner");
    api.on(`POST ${PAGES}`, () =>
      apiError("UNPROCESSABLE", 422, { details: { reason: "markdown_not_allowed", line: 3 } }),
    );
    const key = randomUUID();

    const state = await run(createPage, newPageForm(key));

    expect(state).toMatchObject({
      ok: false,
      code: "UNPROCESSABLE",
      message: LINE_3_MESSAGE,
      requestId: "req_fake_1",
      fieldErrors: { bodyMarkdown: LINE_3_MESSAGE },
      bodyLine: 3,
    });
    // The API stored the refusal under the key: the corrected page needs a new one.
    expect(state.nextActionKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.nextActionKey).not.toBe(key);
  });

  it("names the image's line for an image that is not an uploaded page image", async () => {
    signedIn("owner");
    for (const [reason, message] of [
      [
        "asset_not_found",
        "The image on line 5 names no uploaded image. Upload it as a page image on the Assets page and use its id.",
      ],
      [
        "asset_kind",
        "The image on line 5 is not a page image. Upload the picture as a page image on the Assets page and use that id.",
      ],
    ] as const) {
      api.on(`POST ${PAGES}`, () => apiError("UNPROCESSABLE", 422, { details: { reason, line: 5 } }));

      const state = await run(createPage, newPageForm(randomUUID()));

      expect(state, reason).toMatchObject({ message, fieldErrors: { bodyMarkdown: message }, bodyLine: 5 });
    }
  });

  it("puts a locale the storefront does not offer on the language, and a taken address on the address", async () => {
    signedIn("owner");
    api.on(`POST ${PAGES}`, () =>
      apiError("UNPROCESSABLE", 422, { details: { reason: "locale_not_supported" } }),
    );
    expect(await run(createPage, newPageForm(randomUUID()))).toMatchObject({
      fieldErrors: {
        locale:
          "The storefront does not offer this language. Add it to the supported languages in the storefront settings first.",
      },
    });

    api.on(`POST ${PAGES}`, () =>
      apiError("CONFLICT", 409, { details: { reason: "page_exists", slug: "baggage-faq", locale: "en" } }),
    );
    const key = randomUUID();
    const state = await run(createPage, newPageForm(key));
    const message =
      "A page with the address /p/baggage-faq already exists in en. Open that page to change it, or choose another address.";
    expect(state).toMatchObject({ code: "CONFLICT", message, fieldErrors: { slug: message } });
    expect(state.nextActionKey).not.toBe(key);
    expect(state.nextActionKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the key while the first request with it still runs, after a 429 and after IDEMPOTENCY_KEY_REUSED", async () => {
    signedIn("owner");
    for (const answer of [
      () => apiError("CONFLICT", 409, { details: { reason: "idempotency_key_in_use" } }),
      () => rateLimited(),
      () => apiError("IDEMPOTENCY_KEY_REUSED", 409),
    ]) {
      api.on(`POST ${PAGES}`, answer);
      const state = await run(createPage, newPageForm(randomUUID()));
      expect(state.ok).toBe(false);
      expect(state.nextActionKey).toBeUndefined();
    }
  });

  it("refuses a form without the page's key as out of date", async () => {
    signedIn("owner");

    expect(await run(createPage, newPageForm("not-a-key"))).toEqual({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "This form is out of date. Reload the page and try again.",
    });
    expect(apiRequests()).toEqual([]);
  });
});

// ---- Pages: update and delete -----------------------------------------------------------------------------------

describe("updatePage", () => {
  it("sends the writable fields with If-Match = the displayed version, and revalidates the list and the page", async () => {
    signedIn("owner");
    api.on(`PATCH ${PAGES}/${PAGE_ID}`, () => pageAnswer(storefrontPage({ version: 4 })));

    const state = await run(updatePage, pageForm({ bodyMarkdown: "Fixed.\r\n" }));

    const sent = only(`PATCH ${PAGES}/${PAGE_ID}`);
    expect(sent.headers.get("If-Match")).toBe('"3"');
    expect(sent.headers.get("Idempotency-Key")).toBeNull();
    expect(sent.body).toEqual({
      kind: "faq",
      title: "Baggage FAQ",
      bodyMarkdown: "Fixed.\n",
      isPublished: true,
      showInFooter: true,
      sortOrder: 20,
    });
    expect(state).toEqual({ ok: true, message: "Saved. The storefront shows the change within 5 minutes." });
    expect(revalidated()).toEqual(["/settings/pages", `/settings/pages/${PAGE_ID}`]);
  });

  it("says that a draft is not on the storefront", async () => {
    signedIn("admin");
    api.on(`PATCH ${PAGES}/${PAGE_ID}`, () => pageAnswer(storefrontPage({ isPublished: false, version: 4 })));

    const state = await run(updatePage, pageForm({ isPublished: "" }));

    expect((only(`PATCH ${PAGES}/${PAGE_ID}`).body as { isPublished: boolean }).isPublished).toBe(false);
    expect(state.message).toBe(
      "Saved as a draft: the storefront does not show this page (a page that was published disappears within 5 minutes).",
    );
  });

  it("[OAD-015 AC2] answers a refused body with the line the API names, and no new key (a PATCH has none)", async () => {
    signedIn("owner");
    api.on(`PATCH ${PAGES}/${PAGE_ID}`, () =>
      apiError("UNPROCESSABLE", 422, { details: { reason: "markdown_not_allowed", line: 3 } }),
    );

    const state = await run(updatePage, pageForm());

    expect(state).toEqual({
      ok: false,
      code: "UNPROCESSABLE",
      message: LINE_3_MESSAGE,
      requestId: "req_fake_1",
      fieldErrors: { bodyMarkdown: LINE_3_MESSAGE },
      bodyLine: 3,
    });
    expect(revalidated()).toEqual([]);
  });

  it("asks for a reload after 412, says a deleted page is gone, and puts the API's field errors on their fields", async () => {
    signedIn("owner");
    api.on(`PATCH ${PAGES}/${PAGE_ID}`, () => apiError("PRECONDITION_FAILED", 412));
    expect(await run(updatePage, pageForm())).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "This record changed; reload to see the latest version.",
    });

    api.on(`PATCH ${PAGES}/${PAGE_ID}`, () => apiError("NOT_FOUND", 404));
    expect(await run(updatePage, pageForm())).toMatchObject({
      message: "This page no longer exists. Go back to the list of pages.",
    });

    api.on(`PATCH ${PAGES}/${PAGE_ID}`, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/title", code: "pattern", message: "must not hold control characters" }],
      }),
    );
    expect(await run(updatePage, pageForm())).toMatchObject({
      fieldErrors: { title: "must not hold control characters" },
    });

    api.on(`PATCH ${PAGES}/${PAGE_ID}`, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/header/If-Match", code: "pattern" }],
      }),
    );
    expect((await run(updatePage, pageForm())).message).toBe(
      "This form is out of date. Reload the page and try again.",
    );
  });

  it("refuses a viewer, and a form without the page's id or version, before any call", async () => {
    signedIn("viewer");
    expect(await run(updatePage, pageForm())).toMatchObject({ code: "FORBIDDEN" });

    signedIn("owner");
    expect(await run(updatePage, pageForm({ pageId: "bkg_01JA" }))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(await run(updatePage, pageForm({ version: "0" }))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(apiRequests()).toEqual([]);
  });
});

describe("deletePage", () => {
  const deleteForm = (overrides: Readonly<Record<string, string>> = {}) =>
    formOf({ pageId: PAGE_ID, version: "3", actionKey: randomUUID(), ...overrides });

  it("deletes with If-Match = the displayed version and no body, then goes to the list", async () => {
    signedIn("admin");
    api.on(`DELETE ${PAGES}/${PAGE_ID}`, () => new Response(null, { status: 204 }));

    const target = await redirectOf(() => run(deletePage, deleteForm()));

    expect(target).toBe("/settings/pages");
    const sent = only(`DELETE ${PAGES}/${PAGE_ID}`);
    expect(sent.headers.get("If-Match")).toBe('"3"');
    expect(sent.body).toBeUndefined();
    expect(revalidated()).toEqual(["/settings/pages", `/settings/pages/${PAGE_ID}`]);
  });

  it("says why a page a legal link names cannot be deleted, and that a deleted page is gone", async () => {
    signedIn("owner");
    api.on(`DELETE ${PAGES}/${PAGE_ID}`, () =>
      apiError("CONFLICT", 409, { details: { reason: "page_linked", slug: "terms" } }),
    );
    expect(await run(deletePage, deleteForm())).toMatchObject({
      code: "CONFLICT",
      message:
        "A legal link of the storefront settings points to /p/terms, so no page of that address can be deleted. Change the link in the storefront settings first, or unpublish the page to take it off the storefront.",
      requestId: "req_fake_1",
    });
    expect(revalidated()).toEqual([]);

    api.on(`DELETE ${PAGES}/${PAGE_ID}`, () => apiError("NOT_FOUND", 404));
    expect(await run(deletePage, deleteForm())).toMatchObject({
      message: "This page no longer exists. Go back to the list of pages.",
    });
    expect(revalidated()).toEqual(["/settings/pages"]);
  });

  it("refuses an agent before any call", async () => {
    signedIn("agent");

    expect(await run(deletePage, deleteForm())).toMatchObject({ code: "FORBIDDEN" });
    expect(apiRequests()).toEqual([]);
  });
});

// ---- Templates ----------------------------------------------------------------------------------------------------

describe("saveTemplate", () => {
  it("puts the three parts and isActive with If-Match = the displayed version, and revalidates", async () => {
    signedIn("owner", "live");
    api.on(`PUT ${CONFIRMED}`, () => Response.json(template({ version: 5 })));

    const state = await run(saveTemplate, templateForm());

    const sent = only(`PUT ${CONFIRMED}`);
    expect(sent.headers.get("If-Match")).toBe('"4"');
    expect(sent.headers.get("Idempotency-Key")).toBeNull();
    expect(sent.headers.get("X-Velexis-Environment")).toBe("live");
    expect(sent.body).toEqual({
      subject: "Booked: {{booking.reference}}",
      bodyHtml: "<p>Hello {{booking.contact.firstName}},</p>\n<p>{{booking.pnr}}</p>",
      bodyText: "Hello {{booking.contact.firstName}},",
      isActive: true,
    });
    expect(state).toEqual({ ok: true, message: "Saved. The next e-mails in en use this template." });
    expect(revalidated()).toEqual(["/settings/templates", "/settings/templates/booking.confirmed/email/en"]);
  });

  it("sends no If-Match for a locale without its own row (an inherited template or the default)", async () => {
    signedIn("admin");
    api.on(`PUT ${CONFIRMED_FR}`, () =>
      Response.json(template({ locale: "fr", version: 1, isActive: false })),
    );

    const state = await run(saveTemplate, templateForm({ locale: "fr", version: "", isActive: "" }));

    const sent = only(`PUT ${CONFIRMED_FR}`);
    expect(sent.headers.get("If-Match")).toBeNull();
    expect((sent.body as { isActive: boolean }).isActive).toBe(false);
    expect(state.message).toBe(
      "Saved as inactive: e-mails in fr keep using the template of its language or the default until you activate it.",
    );
  });

  it("lists a refused template per part and line, each part's first problem on its field", async () => {
    signedIn("owner");
    api.on(`PUT ${CONFIRMED}`, () =>
      apiError("TEMPLATE_INVALID", 422, {
        details: {
          errors: [
            { part: "bodyHtml", line: 2, message: "booking.pnr is not a variable of booking.confirmed." },
            { part: "subject", line: 1, message: "Expecting 'ID', got 'CLOSE'." },
            { part: "bodyHtml", line: 9, message: "Unclosed {{#if}}." },
            { part: "bodyText", line: null, message: '"booking.total" has no value in the render data' },
            { part: "elsewhere", line: 1, message: "Not a part." },
          ],
        },
      }),
    );

    const state = await run(saveTemplate, templateForm());

    expect(state).toEqual({
      ok: false,
      code: "TEMPLATE_INVALID",
      message: "The template does not compile. Check the highlighted parts.",
      requestId: "req_fake_1",
      problems: [
        { part: "bodyHtml", line: 2, message: "booking.pnr is not a variable of booking.confirmed." },
        { part: "subject", line: 1, message: "Expecting 'ID', got 'CLOSE'." },
        { part: "bodyHtml", line: 9, message: "Unclosed {{#if}}." },
        { part: "bodyText", line: null, message: '"booking.total" has no value in the render data' },
      ],
      fieldErrors: {
        bodyHtml: "Line 2: booking.pnr is not a variable of booking.confirmed.",
        subject: "Line 1: Expecting 'ID', got 'CLOSE'.",
        bodyText: '"booking.total" has no value in the render data',
      },
    });
    expect(revalidated()).toEqual([]);
  });

  it("answers 412 and a locale the storefront does not offer in this page's words", async () => {
    signedIn("owner");
    api.on(`PUT ${CONFIRMED}`, () => apiError("PRECONDITION_FAILED", 412));
    expect((await run(saveTemplate, templateForm())).message).toBe(
      "This template changed since the page was shown (saved, created or reset elsewhere). Reload the page to see it, then make your change again.",
    );

    api.on(`PUT ${CONFIRMED}`, () =>
      apiError("UNPROCESSABLE", 422, { details: { reason: "locale_not_supported" } }),
    );
    expect((await run(saveTemplate, templateForm())).message).toBe(
      "The storefront does not offer en. Add it to the supported languages in the storefront settings first, then save the template.",
    );
  });

  it("refuses an agent, empty parts and an address the API would refuse before any call", async () => {
    signedIn("agent");
    expect(await run(saveTemplate, templateForm())).toMatchObject({ code: "FORBIDDEN" });

    signedIn("owner");
    const state = await run(saveTemplate, templateForm({ subject: "  ", bodyHtml: "", bodyText: "" }));
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(["bodyHtml", "bodyText", "subject"]);
    for (const overrides of [
      { channel: "sms" },
      { locale: "en_GB" },
      { templateKey: "../secret" },
      { version: "x" },
    ]) {
      expect(await run(saveTemplate, templateForm(overrides)), JSON.stringify(overrides)).toMatchObject({
        code: "VALIDATION_FAILED",
        message: "This form is out of date. Reload the page and try again.",
      });
    }
    expect(apiRequests()).toEqual([]);
  });
});

describe("previewTemplate", () => {
  it("renders the draft for every role, without storing or revalidating anything", async () => {
    signedIn("viewer");
    api.on(`POST ${CONFIRMED}/preview`, () =>
      Response.json({
        subject: "Booked: VX7K2Q",
        html: "<p>Hello Anna,</p><script>parent.document.title='x'</script>",
        text: "Hello Anna,",
      }),
    );

    const state = await run(previewTemplate, templateForm({ bodyText: "" }));

    expect(only(`POST ${CONFIRMED}/preview`).body).toEqual({
      subject: "Booked: {{booking.reference}}",
      bodyHtml: "<p>Hello {{booking.contact.firstName}},</p>\n<p>{{booking.pnr}}</p>",
      bodyText: "",
    });
    expect(state).toEqual({
      ok: true,
      message: "Preview rendered below with the template's sample data. Nothing was saved or sent.",
      preview: {
        subject: "Booked: VX7K2Q",
        html: "<p>Hello Anna,</p><script>parent.document.title='x'</script>",
        text: "Hello Anna,",
      },
    });
    expect(revalidated()).toEqual([]);
  });

  it("lists a draft that does not compile per part and line", async () => {
    signedIn("agent");
    api.on(`POST ${CONFIRMED}/preview`, () =>
      apiError("TEMPLATE_INVALID", 422, {
        details: { errors: [{ part: "bodyHtml", line: 2, message: "booking.pnr is not a variable." }] },
      }),
    );

    expect(await run(previewTemplate, templateForm())).toMatchObject({
      ok: false,
      problems: [{ part: "bodyHtml", line: 2, message: "booking.pnr is not a variable." }],
      fieldErrors: { bodyHtml: "Line 2: booking.pnr is not a variable." },
    });
  });
});

describe("resetTemplate", () => {
  const resetForm = (locale = "en") =>
    formOf({ templateKey: "booking.confirmed", channel: "email", locale, actionKey: randomUUID() });

  it("resets the locale's own row and says what serves the locale now", async () => {
    signedIn("owner");
    api.on(`POST ${CONFIRMED}/reset`, () =>
      Response.json(template({ customised: false, version: null, updatedAt: null })),
    );
    expect(await run(resetTemplate, resetForm())).toEqual({
      ok: true,
      message: "Reset. E-mails in en use the default template again.",
    });
    expect(only(`POST ${CONFIRMED}/reset`).body).toBeUndefined();
    expect(revalidated()).toEqual(["/settings/templates", "/settings/templates/booking.confirmed/email/en"]);

    api.on(`POST ${TEMPLATES}/booking.confirmed/email/en-GB/reset`, () =>
      Response.json(template({ locale: "en-GB", inheritedFrom: "en", version: null, updatedAt: null })),
    );
    expect((await run(resetTemplate, resetForm("en-GB"))).message).toBe(
      "Reset. E-mails in en-GB use the en template again.",
    );
  });

  it("refuses finance and a viewer before any call", async () => {
    for (const role of ["finance", "viewer"] as const) {
      signedIn(role);
      expect(await run(resetTemplate, resetForm()), role).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(apiRequests()).toEqual([]);
  });
});

// ---- Rules --------------------------------------------------------------------------------------------------------

describe("content rules", () => {
  it("[OAD-015 AC2] finds the lines around a reported line and where it is in the body", () => {
    const body = "## Title\n\nText\n<b>bold</b>\nmore\n\nend";

    expect(lineExcerpt(body, 4)).toEqual([
      { number: 2, text: "" },
      { number: 3, text: "Text" },
      { number: 4, text: "<b>bold</b>" },
      { number: 5, text: "more" },
      { number: 6, text: "" },
    ]);
    expect(lineExcerpt(body, 1, 1)).toEqual([
      { number: 1, text: "## Title" },
      { number: 2, text: "" },
    ]);
    expect(lineExcerpt(body, 99)).toEqual([]);
    const range = lineRange(body, 4);
    expect(range === undefined ? undefined : body.slice(range.start, range.end)).toBe("<b>bold</b>");
    expect(lineRange("a\r\nb", 2)).toEqual({ start: 2, end: 3 });
  });

  it("reads TEMPLATE_INVALID's problems defensively and checks a template's address", () => {
    expect(templateProblemsOf({ errors: "not a list" })).toEqual([]);
    expect(templateProblemsOf({ errors: [{ part: "subject", line: 0, message: " x " }, null] })).toEqual([
      { part: "subject", line: null, message: "x" },
    ]);
    expect(templateRefOf("booking.confirmed", "email", "fr-CA")).toEqual({
      templateKey: "booking.confirmed",
      channel: "email",
      locale: "fr-CA",
    });
    expect(templateRefOf("booking", "email", "en")).toBeUndefined();
    expect(templateRefOf("booking.confirmed", "email", "FR")).toBeUndefined();
    expect(pageListQueryOf(new URLSearchParams("locale=fr&published=maybe")).invalid).toEqual(["published"]);
    // The language filter is typed: it is put in the API's spelling, and what cannot be is refused, never sent.
    expect(pageListQueryOf(new URLSearchParams("locale=fr_ca"))).toMatchObject({
      locale: "fr-CA",
      invalid: [],
    });
    expect(pageListQueryOf(new URLSearchParams("locale=EN"))).toMatchObject({ locale: "en", invalid: [] });
    expect(pageListQueryOf(new URLSearchParams("locale=English")).invalid).toEqual(["locale"]);
    expect(pageListQueryOf(new URLSearchParams("locale=en&locale=fr")).invalid).toEqual(["locale"]);
  });
});

// ---- Pages: the list and a page -------------------------------------------------------------------------------------

describe("/settings/pages", () => {
  it("lists the pages with the filters of the URL and offers owners a new page", async () => {
    signedIn("owner");
    api.on(`GET ${PAGES}`, () =>
      listAnswer(
        [
          storefrontPage(),
          storefrontPage({ id: NEW_PAGE_ID, title: "Conditions", isPublished: false, publishedAt: null }),
        ],
        "cursor_2",
      ),
    );

    const page = await pagesList("locale=en&published=true&cursor=cursor_1");

    const sent = only(`GET ${PAGES}`);
    expect(Object.fromEntries(sent.url.searchParams)).toEqual({
      limit: "50",
      locale: "en",
      published: "true",
      cursor: "cursor_1",
    });
    const rows = [...page.querySelectorAll("tr[data-page]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("/p/baggage-faq");
    expect(rows[0]?.textContent).toContain("Published");
    expect(rows[1]?.textContent).toContain("Draft");
    expect(page.querySelector(`a[href="/settings/pages/${PAGE_ID}"]`)?.textContent).toBe("Baggage FAQ");
    expect(page.querySelector('a[href="/settings/pages/new"]')?.textContent).toBe("New page");
    const paging = page.querySelector('nav[aria-label="Pages"]');
    expect(
      paging?.querySelector('a[href="/settings/pages?locale=en&published=true&cursor=cursor_2"]')
        ?.textContent,
    ).toBe("Next page");
    expect(paging?.querySelector('a[href="/settings/pages?locale=en&published=true"]')?.textContent).toBe(
      "First page",
    );
  });

  it("shows the list read only to the other roles, and never sends a link the API would refuse", async () => {
    signedIn("viewer");
    api.on(`GET ${PAGES}`, () => listAnswer([storefrontPage()]));

    const page = await pagesList();
    expect(page.textContent).toContain(
      "Read only: creating, changing and deleting pages needs the permission",
    );
    expect(page.querySelector('a[href="/settings/pages/new"]')).toBeNull();
    expect(page.querySelector('[data-permission="settings:write"]')).not.toBeNull();

    const invalid = await pagesList("locale=English&published=yes");
    expect(invalid.textContent).toContain("This link has a filter the list cannot use");
    expect(api.sent(`GET ${PAGES}`)).toHaveLength(1);
  });

  it("handles the API's codes on the server", async () => {
    signedIn("owner");
    api.on(`GET ${PAGES}`, () => apiError("VALIDATION_FAILED", 400));
    const failed = await pagesList("cursor=stale");
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain("req_fake_1");
    expect(failed.querySelector('[role="alert"] a[href="/settings/pages"]')?.textContent).toBe("First page");

    api.on(`GET ${PAGES}`, () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => pagesList("published=false"))).toBe(
      "/auth/refresh?next=%2Fsettings%2Fpages%3Fpublished%3Dfalse",
    );
  });
});

describe("/settings/pages/[pageId]", () => {
  it("renders the page's form for owners, which posts as it is to the real action", async () => {
    signedIn("owner");
    api.on(`GET ${PAGES}/${PAGE_ID}`, () => pageAnswer(storefrontPage()));

    const page = await contentPage(PAGE_ID);

    expect(page.querySelector("h1")?.textContent).toBe("Baggage FAQ");
    expect(page.textContent).toContain("/p/baggage-faq");
    expect(page.textContent).toContain("Markdown help");
    expect(page.querySelector("button")?.textContent).toBeDefined();
    expect([...page.querySelectorAll("button")].map((button) => button.textContent)).toContain("Delete page");
    const form = formWith(page, "bodyMarkdown");

    api.on(`PATCH ${PAGES}/${PAGE_ID}`, () => pageAnswer(storefrontPage({ version: 4 })));
    expect(await run(updatePage, formDataOf(form))).toMatchObject({ ok: true });
    const sent = only(`PATCH ${PAGES}/${PAGE_ID}`);
    expect(sent.headers.get("If-Match")).toBe('"3"');
    expect(sent.body).toEqual({
      kind: "faq",
      title: "Baggage FAQ",
      bodyMarkdown: "## How many bags?\n\nIt depends on your fare.",
      isPublished: true,
      showInFooter: true,
      sortOrder: 20,
    });
  });

  it("shows the page read only to a viewer, its body as written", async () => {
    signedIn("viewer");
    api.on(`GET ${PAGES}/${PAGE_ID}`, () => pageAnswer(storefrontPage()));

    const page = await contentPage(PAGE_ID);

    expect(page.querySelector("form")).toBeNull();
    expect(page.querySelector("pre")?.textContent).toBe("## How many bags?\n\nIt depends on your fare.");
    expect(page.textContent).toContain("Read only: changing pages needs the permission settings:write.");
  });

  it("renders a new page's form with the storefront's languages, which posts as it is to the real action", async () => {
    signedIn("admin");
    api.on(STOREFRONT, () =>
      Response.json({ version: 2, locales: { default: "en", supported: ["en", "fr", "de"] } }),
    );

    const page = await contentPage("new");

    const options = [...page.querySelectorAll('select[name="locale"] option')].map((option) =>
      option.getAttribute("value"),
    );
    expect(options).toEqual(["", "en", "fr", "de"]);
    const form = formWith(page, "slug");
    const posted = formDataOf(form);
    posted.set("slug", "terms");
    posted.set("title", "Terms");
    api.on(`POST ${PAGES}`, () => pageAnswer(storefrontPage({ id: NEW_PAGE_ID, version: 1 }), 201));
    expect(await redirectOf(() => run(createPage, posted))).toBe(`/settings/pages/${NEW_PAGE_ID}`);
    expect(only(`POST ${PAGES}`).body).toEqual({
      slug: "terms",
      locale: "en",
      kind: "content",
      title: "Terms",
      bodyMarkdown: "",
      isPublished: false,
      showInFooter: false,
      sortOrder: 100,
    });
    expect(only(`POST ${PAGES}`).headers.get("Idempotency-Key")).toBe(posted.get("actionKey"));
  });

  it("takes a typed language when the storefront's could not be read, and refuses the new page to an agent", async () => {
    signedIn("owner");
    api.on(STOREFRONT, () => apiError("INTERNAL_ERROR", 500));
    const page = await contentPage("new");
    expect(page.querySelector<HTMLInputElement>('input[name="locale"]')?.getAttribute("value")).toBe("en");
    expect(page.textContent).toContain("The storefront's languages could not be loaded");

    signedIn("agent");
    const refused = await contentPage("new");
    expect(refused.textContent).toContain("You do not have permission to do this (settings:write).");
    expect(refused.querySelector("form")).toBeNull();
  });

  it("renders 'Page not found' for an id that is not one (no request) and for 404", async () => {
    signedIn("owner");
    const invalid = await contentPage("ast_01JA6B2C3D4E5F6G7H8J9K0M1N");
    expect(invalid.querySelector("h2")?.textContent).toBe("Page not found");
    expect(apiRequests()).toEqual([]);

    api.on(`GET ${PAGES}/${PAGE_ID}`, () => apiError("NOT_FOUND", 404));
    expect((await contentPage(PAGE_ID)).querySelector("h2")?.textContent).toBe("Page not found");
  });
});

// ---- Templates: the list and a template ---------------------------------------------------------------------------

describe("/settings/templates", () => {
  it("lists every effective template by audience with where it comes from", async () => {
    signedIn("viewer");
    api.on(`GET ${TEMPLATES}`, () =>
      Response.json({
        data: [
          template({ key: "auth.verify_email", customised: false, version: 1 }),
          template(),
          template({ locale: "en-GB", inheritedFrom: "en", version: null, updatedAt: null }),
          template({ locale: "fr", customised: false, version: null, updatedAt: null, isActive: true }),
          template({ key: "staff.manual_review", isActive: false }),
        ],
      }),
    );

    const page = await templatesList();

    expect([...page.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Customer accounts",
      "Bookings (to the traveller)",
      "Staff alerts (to the OTA)",
    ]);
    const rows = [...page.querySelectorAll("tr[data-template]")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("Default (own copy)");
    expect(rows[1]).toContain("Customised");
    expect(rows[2]).toContain("Inherited from en");
    // An inherited template has no change of its own: the row points to its language's template, never "Never changed".
    expect(rows[2]).toContain("See the en template");
    expect(rows[2]).not.toContain("Never changed");
    expect(rows[3]).toContain("Default");
    expect(rows[3]).toContain("Never changed");
    expect(rows[4]).toContain("Not sent");
    expect(page.querySelector('a[href="/settings/templates/booking.confirmed/email/en-GB"]')).not.toBeNull();
    expect(page.textContent).toContain("Read only: changing templates needs the permission settings:write.");
  });

  it("handles the API's codes on the server", async () => {
    signedIn("owner");
    api.on(`GET ${TEMPLATES}`, () => apiError("TENANT_SUSPENDED", 403));
    expect((await templatesList()).querySelector('[role="alert"]')?.textContent).toContain(
      "The templates could not be loaded",
    );

    api.on(`GET ${TEMPLATES}`, () => apiError("UNAUTHENTICATED", 401));
    expect(await redirectOf(() => templatesList())).toContain("/console");
  });
});

describe("/settings/templates/[key]/[channel]/[locale]", () => {
  it("renders the editor with the variables for owners, which saves and previews as it is", async () => {
    signedIn("owner");
    api.on(`GET ${CONFIRMED}`, () => Response.json(template()));

    const page = await templatePage("booking.confirmed", "email", "en");

    expect(page.querySelector("h1")?.textContent).toBe("Booking confirmed");
    expect(page.textContent).toContain("{{booking.reference}}");
    expect(page.textContent).toContain("The booking reference.");
    const buttons = [...page.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(
      expect.arrayContaining(["Save", "Preview", "Reset to default"]),
    );
    expect(
      buttons.find((button) => button.textContent === "Reset to default")?.hasAttribute("disabled"),
    ).toBe(false);
    // No preview is rendered before one is asked for.
    expect(page.querySelector("iframe")).toBeNull();
    const posted = formDataOf(formWith(page, "bodyHtml"));

    api.on(`PUT ${CONFIRMED}`, () => Response.json(template({ version: 5 })));
    expect(await run(saveTemplate, posted)).toMatchObject({ ok: true });
    const sent = only(`PUT ${CONFIRMED}`);
    expect(sent.headers.get("If-Match")).toBe('"4"');
    expect(sent.body).toEqual({
      subject: "Your trip {{booking.reference}} is confirmed",
      bodyHtml: "<p>Hello {{booking.contact.firstName}},</p>",
      bodyText: "Hello {{booking.contact.firstName}},",
      isActive: true,
    });

    api.on(`POST ${CONFIRMED}/preview`, () => Response.json({ subject: "s", html: "<p>h</p>", text: "t" }));
    expect(await run(previewTemplate, posted)).toMatchObject({ ok: true });
  });

  it("offers a viewer the parts read only and the preview, without Save or Reset", async () => {
    signedIn("viewer");
    api.on(`GET ${CONFIRMED_FR}`, () =>
      Response.json(
        template({ locale: "fr", inheritedFrom: "en", customised: true, version: null, updatedAt: null }),
      ),
    );

    const page = await templatePage("booking.confirmed", "email", "fr");

    expect(page.textContent).toContain(
      "fr has no template of its own: its e-mails use the en template shown here.",
    );
    expect(page.querySelector('textarea[name="bodyHtml"]')?.hasAttribute("readonly")).toBe(true);
    expect([...page.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Preview"]);
    expect(page.querySelector<HTMLInputElement>('input[name="version"]')?.getAttribute("value")).toBe("");
  });

  it("disables Reset for a locale without its own row, and renders 'Template not found' for a bad address", async () => {
    signedIn("admin");
    api.on(`GET ${CONFIRMED}`, () =>
      Response.json(template({ customised: false, version: null, updatedAt: null })),
    );
    const page = await templatePage("booking.confirmed", "email", "en");
    expect(
      [...page.querySelectorAll("button")]
        .find((button) => button.textContent === "Reset to default")
        ?.hasAttribute("disabled"),
    ).toBe(true);
    expect(page.textContent).toContain("The default template: en has no template of its own.");

    for (const [key, channel, locale] of [
      ["booking.confirmed", "sms", "en"],
      ["booking.confirmed", "email", "EN"],
      ["nokey", "email", "en"],
    ] as const) {
      api.requests.length = 0;
      const missing = await templatePage(key, channel, locale);
      expect(missing.querySelector("h2")?.textContent, `${key}/${channel}/${locale}`).toBe(
        "Template not found",
      );
      expect(apiRequests()).toEqual([]);
    }

    api.on(`GET ${TEMPLATES}/booking.unknown/email/en`, () => apiError("VALIDATION_FAILED", 400));
    expect((await templatePage("booking.unknown", "email", "en")).querySelector("h2")?.textContent).toBe(
      "Template not found",
    );
  });
});
