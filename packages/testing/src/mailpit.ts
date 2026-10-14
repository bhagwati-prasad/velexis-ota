// @velexis/testing/mailpit (X-025; ADR-0015 "E-mail", ADR-0017): reads what the code under test sent to Mailpit, the
// SMTP sink of development and CI (SMTP on 127.0.0.1:1025, UI and API on :8025), through Mailpit's API v1 at
// MAILPIT_API_URL, with `fetch` only.
//
//   const to = uniqueEmail("signup");                            // signup+<uuid>@example.com: this test's own inbox
//   await request(app.server).post("/v1/auth/sign-up").send({ email: to, ... });
//   const message = await mailpit.waitForMessage({ to, subject: /Verify/ });
//   const verify = extractLinks(message).find((url) => url.includes("/verify"));
//
// Test files run in parallel against one Mailpit, and other runs may share it: give every test its own recipient with
// `uniqueEmail` and look for mail by that recipient. `clear()` empties the whole Mailpit, so never call it from a test
// file that runs next to others.
import { randomUUID } from "node:crypto";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";

/** `waitForMessage` asks Mailpit again every 100 ms. */
export const MAILPIT_POLL_INTERVAL_MS = 100;
/** How long `waitForMessage` waits by default. */
export const MAILPIT_DEFAULT_TIMEOUT_MS = 5_000;
/** How long one API request may take before it fails. */
export const MAILPIT_REQUEST_TIMEOUT_MS = 5_000;
/** The most messages one search returns (the newest first). */
export const MAILPIT_SEARCH_LIMIT = 50;
/** The domain of `uniqueEmail` addresses: reserved for examples (RFC 2606), so no mail ever leaves for a real inbox. */
export const UNIQUE_EMAIL_DOMAIN = "example.com";

/** A mailbox as Mailpit returns it. */
export interface MailpitAddress {
  readonly Name: string;
  readonly Address: string;
}

/** A file attached to, or embedded in, a message. */
export interface MailpitAttachment {
  readonly PartID: string;
  readonly FileName: string;
  readonly ContentType: string;
  readonly ContentID: string;
  readonly Size: number;
}

/** A message in a search result (`GET /api/v1/search`): its headers and a snippet, not its parts. */
export interface MailpitMessageSummary {
  /** Mailpit's ID, for `get(id)`. */
  readonly ID: string;
  /** The Message-ID header, without the angle brackets. */
  readonly MessageID: string;
  readonly Read: boolean;
  readonly From: MailpitAddress | null;
  /** The To header. Empty, never null, when there is none (as `Cc`, `Bcc`, `ReplyTo` and `Tags`). */
  readonly To: readonly MailpitAddress[];
  readonly Cc: readonly MailpitAddress[];
  /** The SMTP recipients that are in neither To nor Cc. */
  readonly Bcc: readonly MailpitAddress[];
  readonly ReplyTo: readonly MailpitAddress[];
  /** The decoded Subject header. */
  readonly Subject: string;
  /** When Mailpit received the message (ISO 8601). */
  readonly Created: string;
  readonly Tags: readonly string[];
  readonly Size: number;
  /** The number of attachments. */
  readonly Attachments: number;
  readonly Snippet: string;
}

/** A whole message (`GET /api/v1/message/{id}`): headers, the text and HTML parts, the attachments. */
export interface MailpitMessage {
  readonly ID: string;
  readonly MessageID: string;
  readonly From: MailpitAddress | null;
  readonly To: readonly MailpitAddress[];
  readonly Cc: readonly MailpitAddress[];
  readonly Bcc: readonly MailpitAddress[];
  readonly ReplyTo: readonly MailpitAddress[];
  readonly ReturnPath: string;
  readonly Subject: string;
  /** The Date header (ISO 8601). */
  readonly Date: string;
  readonly Tags: readonly string[];
  /** The decoded text part; empty when there is none. */
  readonly Text: string;
  /** The decoded HTML part; empty when there is none. */
  readonly HTML: string;
  readonly Size: number;
  readonly Inline: readonly MailpitAttachment[];
  readonly Attachments: readonly MailpitAttachment[];
}

/** What to look for. A string `subject` must equal the subject; a `RegExp` must match it. */
export interface MailpitSearch {
  /** A recipient in the To header, compared case-insensitively and in full (Mailpit itself matches a substring). */
  readonly to?: string;
  readonly subject?: string | RegExp;
}

export interface WaitForMessageOptions {
  /** The recipient, usually from `uniqueEmail`: required, so a test never picks up another test's mail. */
  readonly to: string;
  /** A string must equal the subject; a `RegExp` must match it. Any subject when left out. */
  readonly subject?: string | RegExp;
  /** How long to wait, in milliseconds; default 5000. */
  readonly timeoutMs?: number;
}

/** The time source and the wait between two checks of `waitForMessage`. Unit tests pass a fake one. */
export interface MailpitTimer {
  /** Milliseconds on a monotonic clock. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The subset of `fetch` the client uses. */
export type MailpitFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MailpitClientOptions {
  /**
   * The base URL of Mailpit's UI and API, `MAILPIT_API_URL` (`http://127.0.0.1:8025`). A path (Mailpit's
   * `--webroot`) is kept; a user and password in the URL are sent as a Basic `Authorization` header and never shown.
   */
  readonly apiUrl: string;
  /** Default: the global `fetch`. */
  readonly fetch?: MailpitFetch;
  /** Default: real time, captured when this module loads (so `vi.useFakeTimers()` later does not stall the wait). */
  readonly timer?: MailpitTimer;
  /** Per request; default 5000 ms. */
  readonly requestTimeoutMs?: number;
}

export interface MailpitClient {
  /** The API base URL, without any credentials. */
  readonly apiUrl: string;
  /**
   * `GET /api/v1/search`: the messages to `to` and with `subject`, the newest first (at most 50). Mailpit narrows the
   * list (`to:` and `subject:` match substrings there); the exact match is made here. Pass `to`, a string `subject`
   * or both: Mailpit cannot search by a regular expression.
   */
  search(criteria: MailpitSearch): Promise<MailpitMessageSummary[]>;
  /** `GET /api/v1/message/{id}`: the whole message, with its text and HTML parts. Mailpit marks it read. */
  get(id: string): Promise<MailpitMessage>;
  /**
   * `DELETE /api/v1/messages`: deletes **every** message in this Mailpit, other test files' and other runs' too. Only
   * for a manual reset or a suite that runs alone; parallel test files use `uniqueEmail` instead.
   */
  clear(): Promise<void>;
  /**
   * Checks Mailpit at once and then every 100 ms until a message to `to` (and with `subject`) is there, and returns
   * the newest such message in full. After `timeoutMs` (default 5000) it throws a `MailpitTimeoutError` that lists
   * the messages to `to` it did see (subject, time, ID; never the content).
   */
  waitForMessage(options: WaitForMessageOptions): Promise<MailpitMessage>;
}

/** A Mailpit API call that failed: not reachable, an error status or an answer that is not Mailpit's. */
export class MailpitError extends Error {
  override name = "MailpitError";
}

/** `waitForMessage` gave up: no matching message arrived in time. */
export class MailpitTimeoutError extends MailpitError {
  override name = "MailpitTimeoutError";
  readonly to: string;
  readonly subject: string | RegExp | undefined;
  readonly timeoutMs: number;
  /** The messages to `to` that Mailpit returned while waiting, none of them with the subject asked for. */
  readonly seen: readonly MailpitMessageSummary[];

  constructor(details: {
    readonly to: string;
    readonly subject: string | RegExp | undefined;
    readonly timeoutMs: number;
    readonly checks: number;
    readonly apiUrl: string;
    readonly seen: readonly MailpitMessageSummary[];
  }) {
    super(timeoutMessage(details));
    this.to = details.to;
    this.subject = details.subject;
    this.timeoutMs = details.timeoutMs;
    this.seen = Object.freeze([...details.seen]);
  }
}

/** At most this many seen messages are listed in a `MailpitTimeoutError` message. */
const LISTED_MESSAGES = 20;

function describeSubject(subject: string | RegExp | undefined): string {
  if (subject === undefined) {
    return "";
  }
  return typeof subject === "string"
    ? ` with the subject ${JSON.stringify(subject)}`
    : ` with a subject matching ${String(subject)}`;
}

function timeoutMessage(details: {
  readonly to: string;
  readonly subject: string | RegExp | undefined;
  readonly timeoutMs: number;
  readonly checks: number;
  readonly apiUrl: string;
  readonly seen: readonly MailpitMessageSummary[];
}): string {
  const { to, subject, timeoutMs, checks, apiUrl, seen } = details;
  const head =
    `waitForMessage: no message to ${to}${describeSubject(subject)} arrived within ${timeoutMs} ms ` +
    `(Mailpit at ${apiUrl}, ${checks} ${checks === 1 ? "check" : "checks"}).`;
  if (seen.length === 0) {
    return `${head}\nMessages to that address it did see: none.`;
  }
  const lines = seen
    .slice(0, LISTED_MESSAGES)
    .map(
      (message) => `  - ${JSON.stringify(message.Subject)}, received ${message.Created}, ID ${message.ID}`,
    );
  if (seen.length > LISTED_MESSAGES) {
    lines.push(`  … and ${seen.length - LISTED_MESSAGES} more`);
  }
  return [head, `Messages to that address it did see (${seen.length}):`, ...lines].join("\n");
}

// Captured when the module loads: a test that switches to vi.useFakeTimers() afterwards still waits in real time.
const realSetTimeout = globalThis.setTimeout;
const realNow = performance.now.bind(performance);
const REAL_TIMER: MailpitTimer = Object.freeze({
  now: realNow,
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      realSetTimeout(resolve, ms);
    }),
});

/** An address `to` may hold: no spaces, double quotes, angle brackets or separators, and one `@`. */
const RECIPIENT = /^[^\s"<>(),;:\\[\]@]+@[^\s"<>(),;:\\[\]@]+$/;

function checkRecipient(to: unknown, where: string): string {
  if (typeof to !== "string" || !RECIPIENT.test(to)) {
    throw new TypeError(`${where}: \`to\` must be one e-mail address such as signup+<uuid>@example.com`);
  }
  return to;
}

/** A copy of a `RegExp` without the `g` and `y` flags, with which `test` keeps `lastIndex` between checks. */
function statelessPattern(subject: string | RegExp | undefined): string | RegExp | undefined {
  return subject instanceof RegExp ? new RegExp(subject.source, subject.flags.replace(/[gy]/g, "")) : subject;
}

function subjectMatches(actual: string, subject: string | RegExp | undefined): boolean {
  if (subject === undefined) {
    return true;
  }
  return typeof subject === "string" ? actual === subject : subject.test(actual);
}

function isTo(message: MailpitMessageSummary, to: string | undefined): boolean {
  if (to === undefined) {
    return true;
  }
  const wanted = to.toLowerCase();
  return message.To.some((address) => address.Address.toLowerCase() === wanted);
}

/**
 * The longest part of `subject` without a double quote, for Mailpit's `subject:"…"` (a quoted phrase cannot hold
 * one). Any substring of the subject narrows the search as well; the exact comparison happens here.
 */
function subjectTerm(subject: string): string {
  return subject
    .split('"')
    .map((part) => part.trim())
    .reduce((longest, part) => (part.length > longest.length ? part : longest), "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A message object of the API with its lists and strings filled in: Mailpit sends `null` for an empty list. */
function normalize(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value) || typeof value.ID !== "string" || value.ID === "") {
    throw new MailpitError(
      `Mailpit answered ${what} without a message ID: is MAILPIT_API_URL Mailpit's API?`,
    );
  }
  return {
    ...value,
    MessageID: stringOf(value.MessageID),
    From: isRecord(value.From) ? value.From : null,
    To: listOf(value.To),
    Cc: listOf(value.Cc),
    Bcc: listOf(value.Bcc),
    ReplyTo: listOf(value.ReplyTo),
    Subject: stringOf(value.Subject),
    Tags: listOf(value.Tags),
  };
}

function toSummary(value: unknown): MailpitMessageSummary {
  const message = normalize(value, "a search result");
  return {
    ...message,
    Created: stringOf(message.Created),
    Snippet: stringOf(message.Snippet),
  } as unknown as MailpitMessageSummary;
}

function toMessage(value: unknown): MailpitMessage {
  const message = normalize(value, "a message");
  return {
    ...message,
    ReturnPath: stringOf(message.ReturnPath),
    Date: stringOf(message.Date),
    Text: stringOf(message.Text),
    HTML: stringOf(message.HTML),
    Inline: listOf(message.Inline),
    Attachments: listOf(message.Attachments),
  } as unknown as MailpitMessage;
}

/**
 * Why a request failed, without the URL (it may hold credentials): the system error code, the abort reason or the
 * message of the cause.
 */
function describeFetchError(error: unknown, timeoutMs: number): string {
  // AbortSignal.timeout rejects with a DOMException named TimeoutError; undici's "fetch failed" has the system
  // error (ECONNREFUSED, ENOTFOUND, …) as its cause, or an error without a code ("bad port" for a port fetch blocks).
  const name = isRecord(error) || error instanceof Error ? error.name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return `no answer within ${timeoutMs} ms`;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  if (isRecord(cause) && typeof cause.code === "string") {
    return cause.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return cause instanceof Error && cause.message !== "" ? `${message} (${cause.message})` : message;
}

/** Splits the user and password off `apiUrl`: fetch refuses a URL with credentials, and they must never be shown. */
function parseApiUrl(apiUrl: string): { readonly base: URL; readonly authorization: string | undefined } {
  let base: URL;
  try {
    base = new URL(apiUrl);
  } catch {
    throw new TypeError("Mailpit: the API URL must be an absolute http(s) URL such as http://127.0.0.1:8025");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError("Mailpit: the API URL must be an absolute http(s) URL such as http://127.0.0.1:8025");
  }
  let authorization: string | undefined;
  if (base.username !== "" || base.password !== "") {
    const user = decodeURIComponent(base.username);
    const password = decodeURIComponent(base.password);
    authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    base.username = "";
    base.password = "";
  }
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) {
    base.pathname = `${base.pathname}/`;
  }
  return { base, authorization };
}

/** A Mailpit API client for `apiUrl`. Tests normally use the ready-made `mailpit`, which reads MAILPIT_API_URL. */
export function createMailpitClient(options: MailpitClientOptions): MailpitClient {
  const { base, authorization } = parseApiUrl(options.apiUrl);
  const apiUrl = base.toString().replace(/\/$/, "");
  const fetchImpl: MailpitFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timer = options.timer ?? REAL_TIMER;
  const requestTimeoutMs = options.requestTimeoutMs ?? MAILPIT_REQUEST_TIMEOUT_MS;
  const headers: Record<string, string> = { accept: "application/json" };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }

  async function request(
    method: "GET" | "DELETE",
    path: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    const what = `${method} ${url.pathname}`;
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new MailpitError(
        `Mailpit API ${what} at ${apiUrl} failed: ${describeFetchError(error, requestTimeoutMs)}. Start Mailpit ` +
          "(docs/mvp/local-development.md §4) or point MAILPIT_API_URL at it.",
        { cause: error },
      );
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new MailpitError(
        `Mailpit API ${what} at ${apiUrl} answered ${response.status}${body === "" ? "" : `: ${body}`}`,
      );
    }
    return response;
  }

  async function json(response: Response, what: string): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new MailpitError(
        `Mailpit API ${what} at ${apiUrl} did not answer JSON: is MAILPIT_API_URL Mailpit's UI and API port (8025)?`,
      );
    }
  }

  async function searchRaw(to: string | undefined, subject: string | RegExp | undefined) {
    const terms: string[] = [];
    if (to !== undefined) {
      terms.push(`to:"${to}"`);
    }
    const phrase = typeof subject === "string" ? subjectTerm(subject) : "";
    if (phrase !== "") {
      terms.push(`subject:"${phrase}"`);
    }
    if (terms.length === 0) {
      throw new TypeError(
        "mailpit.search needs `to`, a string `subject` or both: Mailpit cannot search by a regular expression alone",
      );
    }
    const response = await request("GET", "api/v1/search", {
      query: terms.join(" "),
      limit: String(MAILPIT_SEARCH_LIMIT),
    });
    const body = await json(response, "GET /api/v1/search");
    if (!isRecord(body) || !Array.isArray(body.messages)) {
      throw new MailpitError(
        `Mailpit API GET /api/v1/search at ${apiUrl} answered without a message list: ` +
          "is MAILPIT_API_URL Mailpit's API?",
      );
    }
    return body.messages.map(toSummary).filter((message) => isTo(message, to));
  }

  async function search(criteria: MailpitSearch): Promise<MailpitMessageSummary[]> {
    const to = criteria.to === undefined ? undefined : checkRecipient(criteria.to, "mailpit.search");
    const subject = statelessPattern(criteria.subject);
    const messages = await searchRaw(to, subject);
    return messages.filter((message) => subjectMatches(message.Subject, subject));
  }

  async function get(id: string): Promise<MailpitMessage> {
    if (typeof id !== "string" || id.trim() === "") {
      throw new TypeError("mailpit.get needs a message ID");
    }
    const response = await request("GET", `api/v1/message/${encodeURIComponent(id)}`);
    return toMessage(await json(response, "GET /api/v1/message/{id}"));
  }

  async function clear(): Promise<void> {
    const response = await request("DELETE", "api/v1/messages");
    await response.text();
  }

  async function waitForMessage(waitOptions: WaitForMessageOptions): Promise<MailpitMessage> {
    const to = checkRecipient(waitOptions.to, "waitForMessage");
    const subject = statelessPattern(waitOptions.subject);
    const timeoutMs = waitOptions.timeoutMs ?? MAILPIT_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("waitForMessage: timeoutMs must be a finite number of milliseconds, 0 or more");
    }
    const deadline = timer.now() + timeoutMs;
    // Every message to `to` that did not match, by ID: the error lists them.
    const seen = new Map<string, MailpitMessageSummary>();
    let checks = 0;
    for (;;) {
      // By recipient only, so the messages with another subject are seen too.
      const messages = await searchRaw(to, undefined);
      checks += 1;
      const match = messages.find((message) => subjectMatches(message.Subject, subject));
      if (match !== undefined) {
        return await get(match.ID);
      }
      for (const message of messages) {
        seen.set(message.ID, message);
      }
      const remaining = deadline - timer.now();
      if (remaining <= 0) {
        throw new MailpitTimeoutError({
          to,
          subject: waitOptions.subject,
          timeoutMs,
          checks,
          apiUrl,
          seen: [...seen.values()],
        });
      }
      await timer.sleep(Math.min(MAILPIT_POLL_INTERVAL_MS, remaining));
    }
  }

  return Object.freeze({ apiUrl, search, get, clear, waitForMessage });
}

/**
 * MAILPIT_API_URL through @velexis/config: the environment (CI services), else the `.env.local` files of the package
 * under test and of the repository root (`loadDevEnvFiles`). The root `.env.example` has `http://127.0.0.1:8025`.
 */
export function mailpitApiUrl(): string {
  loadDevEnvFiles({ appDir: process.cwd() });
  return defineConfig({ MAILPIT_API_URL: env.url({ protocols: ["http:", "https:"] }) }).MAILPIT_API_URL;
}

let defaultClient: MailpitClient | undefined;

function defaultMailpit(): MailpitClient {
  defaultClient ??= createMailpitClient({ apiUrl: mailpitApiUrl() });
  return defaultClient;
}

/** The Mailpit at MAILPIT_API_URL, read on first use. */
export const mailpit: MailpitClient = Object.freeze({
  get apiUrl(): string {
    return defaultMailpit().apiUrl;
  },
  search: async (criteria: MailpitSearch) => await defaultMailpit().search(criteria),
  get: async (id: string) => await defaultMailpit().get(id),
  clear: async () => await defaultMailpit().clear(),
  waitForMessage: async (options: WaitForMessageOptions) => await defaultMailpit().waitForMessage(options),
});

/** `mailpit.waitForMessage`: the newest message to `to` (and with `subject`), waiting up to `timeoutMs` (5000). */
export async function waitForMessage(options: WaitForMessageOptions): Promise<MailpitMessage> {
  return await mailpit.waitForMessage(options);
}

/** 1 to 27 characters (27 + "+" + a 36-character UUID = 64, the longest local part): a-z, 0-9, ".", "_", "-". */
const EMAIL_LABEL = /^[a-z0-9](?:[a-z0-9._-]{0,25}[a-z0-9])?$/;

/**
 * `<label>+<uuid>@example.com`: a recipient no other test, test file or run uses, so parallel test files never read
 * each other's mail. The label says what the address is for in Mailpit's UI (`signup`, `invite-owner`).
 */
export function uniqueEmail(label: string): string {
  if (typeof label !== "string" || !EMAIL_LABEL.test(label) || label.includes("..")) {
    throw new TypeError(
      'uniqueEmail: the label must be 1 to 27 characters of a-z, 0-9, ".", "_" and "-", starting and ending with a ' +
        "letter or a digit",
    );
  }
  return `${label}+${randomUUID()}@${UNIQUE_EMAIL_DOMAIN}`;
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** The `href` of an `<a>` element, double-quoted, single-quoted or bare; `data-href` and the like do not count. */
const ANCHOR_HREF = /<a\s(?:[^>]*?\s)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi;
const TEXT_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
});

/** Decodes the character references an `href` may hold (`&amp;`, `&#38;`, `&#x26;`, …). */
function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Drops what ends a sentence rather than the URL: `.`, `,`, `;`, `:`, `!`, `?` and unbalanced `)`, `]`, `}`. */
function trimUrl(url: string): string {
  let result = url;
  for (;;) {
    const last = result.at(-1);
    const closing = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : undefined;
    if (last !== undefined && ".,;:!?".includes(last)) {
      result = result.slice(0, -1);
    } else if (last !== undefined && closing !== undefined && count(result, closing) < count(result, last)) {
      result = result.slice(0, -1);
    } else {
      return result;
    }
  }
}

/**
 * The links of a message: the `href`s of the `<a>` elements of its HTML part (character references decoded), then
 * the `http(s)` URLs of its text part (without the punctuation that ends a sentence), each once, in that order.
 */
export function extractLinks(message: Pick<MailpitMessage, "HTML" | "Text">): string[] {
  const links: string[] = [];
  const html = (message.HTML ?? "").replace(HTML_COMMENT, "");
  for (const match of html.matchAll(ANCHOR_HREF)) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (href !== "") {
      links.push(href);
    }
  }
  for (const match of (message.Text ?? "").matchAll(TEXT_URL)) {
    links.push(trimUrl(match[0]));
  }
  return [...new Set(links)];
}
