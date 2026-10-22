// What the OTA admin's session route handlers share (README §3 and §4, OADR-0018 points 2 and 3): their paths, the
// `Origin` check of the two that change state (`POST /sso`, `POST /auth/sign-out`), a size-capped form reader and the
// short HTML page they answer with when they cannot go on. Next.js lets a `route.ts` export only its handlers and
// segment options, so these live here.
//
// The page has no script, no form and no external resource: plain HTML with an inline style, which the middleware's
// policy allows (`style-src 'self' 'unsafe-inline'`). Every text in it is escaped, and it never contains a token: the
// messages come from lib/errors.ts by code, never from the API's own message.
import "server-only";

/** `POST /sso`: the portal's hand-off (PADR-0007 §4). */
export const SSO_PATH = "/sso";
/** `POST /auth/sign-out`: the shell's sign-out button. */
export const SIGN_OUT_PATH = "/auth/sign-out";
/** The page after a sign-out, with a link back to the portal. */
export const SIGNED_OUT_PATH = "/signed-out";
/** Where a new SSO session lands (architecture flow (c), PFE-019). */
export const SSO_LANDING_PATH = "/bookings";
/** Where `/auth/refresh` goes back to without a usable `next`: the dashboard. */
export const DEFAULT_NEXT_PATH = "/";

/** The headers these handlers read. */
export interface RequestHeaders {
  get(name: string): string | null;
}

/**
 * The request's `Origin` is exactly the origin of `allowedUrl` (login-CSRF and CSRF defence, OADR-0018 point 2). A
 * missing `Origin`, the opaque `null` and any other origin are refused.
 */
export function originMatches(headers: RequestHeaders, allowedUrl: string): boolean {
  const origin = headers.get("origin");
  return origin !== null && origin !== "null" && origin === new URL(allowedUrl).origin;
}

/** The media type of a request body, lower case and without its parameters (`; charset=…`). */
export function mediaTypeOf(headers: RequestHeaders): string {
  return (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The body as UTF-8 text, or `undefined` when it is longer than `maxBytes`. The stream is read chunk by chunk and
 * cancelled at the limit, so an oversized body is never held in memory whole.
 */
export async function readCappedText(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return undefined;
  }
  if (request.body === null) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

// ---- The page ---------------------------------------------------------------------------------------------------

/** One link of the page. */
export interface AuthPageLink {
  readonly href: string;
  readonly label: string;
}

/** What the page says. */
export interface AuthPage {
  /** The HTTP status of the answer. */
  readonly status: number;
  /** The heading (and the document title). */
  readonly title: string;
  /** One or two sentences: what happened and what to do. */
  readonly message: string;
  /** The API's request id, for staff to quote; omitted when there is none. */
  readonly requestId?: string | null | undefined;
  /** The way on: always "Back to the portal", sometimes "Try again" first. */
  readonly links: readonly AuthPageLink[];
}

const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/** `value` as HTML text or as a quoted attribute value. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** The page's look: the system font and the neutral colours of globals.css, light and dark. */
const PAGE_STYLE = [
  ":root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5}",
  "body{margin:0;min-height:100dvh;display:grid;place-items:center;background:Canvas;color:CanvasText}",
  "main{max-width:32rem;padding:2rem 1.5rem}",
  "h1{font-size:1.25rem;margin:0 0 .75rem}",
  "p{margin:0 0 1rem}",
  ".request-id{font-size:.875rem;opacity:.75}",
  ".links{display:flex;flex-wrap:wrap;gap:1rem}",
  "a{color:LinkText;font-weight:500}",
].join("");

/** The page as an HTML document. */
export function authPageHtml(page: AuthPage): string {
  const requestId =
    typeof page.requestId === "string" && page.requestId !== ""
      ? [`<p class="request-id">Request id: <code>${escapeHtml(page.requestId)}</code></p>`]
      : [];
  const links = page.links
    .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join("");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(page.title)} · Velexis OTA admin</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    '<main id="main-content">',
    `<h1>${escapeHtml(page.title)}</h1>`,
    `<p>${escapeHtml(page.message)}</p>`,
    ...requestId,
    `<p class="links">${links}</p>`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The page as an answer: HTML, never cached, never indexed. */
export function authPageResponse(page: AuthPage): Response {
  return new Response(authPageHtml(page), {
    status: page.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
