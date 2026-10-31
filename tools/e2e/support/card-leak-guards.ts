// The card leak checks of the airline-card journey (OFE-018; OADR-0017 points 3, 5 and 8, ota/docs/flows/
// checkout-airline-card.md §7, OF-05 AC1). The airline-card page holds raw card values in its own inputs, so after each
// path (success, decline, the attempt limit, the lost answer, leaving the page) a journey proves that none of them
// stayed anywhere the browser keeps state:
//
//   const leaks = await CardLeakGuards.install(context);   // before the context's first navigation
//   leaks.remember(card);                                  // every card the journey types, before it types it
//   …
//   await leaks.expectNoLeak(page);                        // after the path, on a page of the storefront
//
// `expectNoLeak` fails the test, naming where and what (never the value), when the card number, its last 12 digits,
// the security code or the holder's name of any card remembered so far is found in:
//
//   - localStorage, sessionStorage, IndexedDB (every database, every object store) and `window.name` of the page;
//   - a cookie of the context, httpOnly ones included (name and value);
//   - the address of any document the context loaded, any address given to `history.pushState` / `replaceState`, and
//     `history.state` of any document (when it loaded, when it was left, and every state a script set);
//   - any request of the context (its address and headers; its body too, except the body of the airline-card
//     completion itself, `POST /api/v1/checkouts/{id}/airline-card-completion`, the only request that may carry the
//     card), and any answer of the OTA API (the card number, its last 12 digits and the holder's name);
//
// and when the page is the airline-card page and one of its card inputs is not empty, or when the airline-card page made
// a request to another origin. That the inputs are empty after the page was left is the journey's to show: it leaves
// the page and comes back (Back), and checks then. A report from the left page's own `pagehide` cannot do it: the
// page's COOP `same-origin` puts every navigation away from it into another browsing context group, and Chromium no
// longer delivers what the left document reports from there. `expectOpenerCutOff` proves that COOP: a script on
// `/checkout/pay-card.html` that opens the card page with `window.open` gets a handle that reports `closed` and no
// access to its document (OADR-0017 point 3).
//
// Card values never leave the test process: problems name the place and the kind of value only, and nothing here logs.
// The journeys type test numbers only (the success and the declined test card of the Amadeus stub, and a number that
// fails the Luhn check).
import { expect, type BrowserContext, type Page, type Request, type Response } from "@playwright/test";
import { FIRST_PARTY_ORIGINS, withoutQuery } from "./storefront-guards";
import { STOREFRONT_URL } from "./stack";

/** The airline-card page (OADR-0017 point 1; Caddy's try_files serves both paths). */
export const AIRLINE_CARD_PAGE_PATHS: readonly string[] = Object.freeze([
  "/checkout/pay-airline.html",
  "/checkout/pay-airline",
]);

/** The name of the binding through which the storefront's documents report to these checks. */
export const CARD_LEAK_BINDING = "__vxE2eCardLeak";

/** The airline-card completion, the only request that may carry a card (OADR-0017 point 5). */
const COMPLETION_PATH = /^\/api\/v1\/checkouts\/[^/]+\/airline-card-completion$/;

/** The card values a journey types: test numbers only. */
export interface TypedCard {
  /** The card number, as typed (spaces allowed). */
  readonly number: string;
  readonly securityCode: string;
  readonly holderName: string;
}

/** The kinds of card value a check looks for, as the problems name them. */
export type CardValueKind = "card number" | "last 12 digits" | "security code" | "holder name";

/**
 * Something a check found: where, and which kinds of card value (never the value itself); no kinds for a problem that
 * is not a value (a card input that is not empty, a request to another origin, a page that is not the storefront's).
 */
export interface CardLeak {
  readonly where: string;
  readonly kinds: readonly CardValueKind[];
}

/** Whether `url` is the airline-card page of the storefront. */
export function isAirlineCardPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return FIRST_PARTY_ORIGINS.includes(parsed.origin) && AIRLINE_CARD_PAGE_PATHS.includes(parsed.pathname);
  } catch {
    return false;
  }
}

/** Whether a request is the airline-card completion (`POST …/airline-card-completion` through the storefront). */
export function isCompletionRequest(method: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      method.toUpperCase() === "POST" &&
      FIRST_PARTY_ORIGINS.includes(parsed.origin) &&
      COMPLETION_PATH.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * `text` with the separators a card number may be typed or encoded with (spaces, `+`, `-`, `%20`) removed between two
 * digits, so `4111 1111 1111 1111`, `4111-1111…` and `4111%201111…` all read as the 16 digits.
 */
export function joinDigits(text: string): string {
  return text.replace(/(\d)(?:[\s+-]|%20)+(?=\d)/g, "$1");
}

/** The digits of a typed card number. */
const digitsOf = (value: string): string => value.replace(/\D/g, "");

/** Escapes `value` for a regular expression. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The kinds of card value of `cards` that `text` holds. The card number and its last 12 digits are found also when
 * typed with spaces or encoded (`joinDigits`); a 3- or 4-digit security code only as a value of its own (not inside a
 * longer word, number or amount: `739` in `"739"`, `=739&` or `: 739`, never in `1739`, `B739Q` or `739.20`); the
 * holder's name in any case. `securityCode: false` leaves the code out where short numbers are common data (API
 * answers: flight numbers, aircraft codes).
 */
export function cardValuesIn(
  text: string,
  cards: readonly TypedCard[],
  options: { readonly securityCode?: boolean } = {},
): CardValueKind[] {
  const found = new Set<CardValueKind>();
  const joined = joinDigits(text);
  const lower = text.toLowerCase();
  for (const card of cards) {
    const number = digitsOf(card.number);
    if (number.length >= 12 && (text.includes(number) || joined.includes(number))) {
      found.add("card number");
    }
    const last12 = number.slice(-12);
    if (last12.length === 12 && (text.includes(last12) || joined.includes(last12))) {
      found.add("last 12 digits");
    }
    const code = card.securityCode.trim();
    if (
      options.securityCode !== false &&
      /^\d{3,4}$/.test(code) &&
      new RegExp(`(?<![0-9A-Za-z.,])${escapeRegExp(code)}(?![0-9A-Za-z.,])`).test(text)
    ) {
      found.add("security code");
    }
    const holder = card.holderName.trim().toLowerCase();
    if (holder.length >= 4 && lower.includes(holder)) {
      found.add("holder name");
    }
  }
  return [...found];
}

/** A pattern for `digits` also typed with spaces or encoded (the separators `joinDigits` removes between two digits). */
const separatedDigits = (digits: string): string => digits.split("").join("(?:[\\s+-]|%20)*");

/**
 * `where` with every card value of `cards` replaced by `[card value]`, so that a place whose own name holds one (a
 * storage key, a cookie or header name, the path of an address) is named without it. `findLeaks` applies it to every
 * problem it returns, so a failure never prints a card value.
 */
export function redactPlace(where: string, cards: readonly TypedCard[]): string {
  let safe = where;
  for (const card of cards) {
    const number = digitsOf(card.number);
    for (const digits of [number, number.slice(-12)]) {
      if (digits.length >= 12) {
        safe = safe.replace(new RegExp(separatedDigits(digits), "g"), "[card value]");
      }
    }
    const code = card.securityCode.trim();
    if (/^\d{3,4}$/.test(code)) {
      safe = safe.replace(new RegExp(`(?<![0-9A-Za-z.,])${code}(?![0-9A-Za-z.,])`, "g"), "[card value]");
    }
    const holder = card.holderName.trim();
    if (holder.length >= 4) {
      safe = safe.replace(new RegExp(escapeRegExp(holder), "gi"), "[card value]");
    }
  }
  return safe;
}

/** One line per leak, for the error that fails the test. */
export function formatLeaks(leaks: readonly CardLeak[]): string {
  return leaks
    .map((leak) =>
      leak.kinds.length === 0 ? `  - ${leak.where}` : `  - ${leak.kinds.join(", ")} in ${leak.where}`,
    )
    .join("\n");
}

/** What a storefront document sends to the binding: its address and states, never a card input. */
type DocumentReport =
  | {
      readonly kind: "document";
      readonly event: "load" | "pagehide";
      readonly href: string;
      readonly state: string;
      readonly name: string;
    }
  | { readonly kind: "history"; readonly href: string; readonly state: string };

/**
 * Added to every document of the context before its own scripts (top-level storefront documents only). It reports the
 * document's address, `history.state` and `window.name` when it has loaded and when it is left (a report from a
 * document left for another browsing context group may not arrive), and every address and state given to
 * `history.pushState` and `replaceState`, whose calls go through unchanged. It reads no card input.
 */
export const CARD_LEAK_INIT_SCRIPT = `(() => {
  if (window.top !== window) return;
  const origins = ${JSON.stringify(FIRST_PARTY_ORIGINS)};
  if (!origins.includes(location.origin)) return;
  const report = (data) => {
    const binding = globalThis[${JSON.stringify(CARD_LEAK_BINDING)}];
    if (typeof binding === "function") binding(data);
  };
  const json = (value) => {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return String(value);
    }
  };
  const documentReport = (event) => () =>
    report({ kind: "document", event, href: location.href, state: json(history.state), name: String(window.name) });
  addEventListener("load", documentReport("load"));
  addEventListener("pagehide", documentReport("pagehide"));
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (state, title, url) {
      let href = location.href;
      try {
        href = url === undefined || url === null ? location.href : new URL(String(url), location.href).href;
      } catch {
        href = String(url);
      }
      report({ kind: "history", href, state: json(state) });
      return original.apply(this, arguments);
    };
  }
})();`;

/** One request of the context, as the checks read it. */
interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  /** The document that made it (its address), or "" when it has none. */
  readonly document: string;
}

/** One answer of the OTA API (through the storefront's `/api/`), read when the checks run. */
interface RecordedAnswer {
  readonly url: string;
  readonly body: Promise<string | null>;
}

/** The part of a browser context the checks use; a fake in the unit tests. */
export type CardLeakContext = Pick<BrowserContext, "addInitScript" | "exposeBinding" | "cookies"> & {
  on(event: "request", listener: (request: Request) => void): unknown;
  on(event: "response", listener: (response: Response) => void): unknown;
};

/** The storage of a page, as `pageStorage` reads it in the browser. */
export interface PageStorage {
  readonly localStorage: readonly (readonly [string, string])[];
  readonly sessionStorage: readonly (readonly [string, string])[];
  readonly indexedDb: readonly { readonly where: string; readonly text: string }[];
  readonly windowName: string;
  readonly href: string;
  readonly state: string;
  /** The `data-card-input` names of the page's card inputs that are not empty now (an airline-card page only). */
  readonly filledCardInputs: readonly string[];
}

/** Reads the storage of the page it runs in (passed to `page.evaluate`; no closure over test values). */
async function pageStorage(cardPaths: readonly string[]): Promise<PageStorage> {
  const json = (value: unknown): string => {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return String(value);
    }
  };
  const entries = (storage: Storage | undefined): [string, string][] => {
    const result: [string, string][] = [];
    if (storage === undefined) {
      return result;
    }
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? "";
      result.push([key, storage.getItem(key) ?? ""]);
    }
    return result;
  };
  const request = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  const indexedDb: { where: string; text: string }[] = [];
  for (const info of await indexedDB.databases()) {
    if (info.name === undefined) {
      continue;
    }
    // Only databases that exist are opened (their own version), so the check never creates one.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(info.name as string, info.version);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
    });
    try {
      for (const store of Array.from(db.objectStoreNames)) {
        const tx = db.transaction(store, "readonly");
        const keys = await request(tx.objectStore(store).getAllKeys());
        const values = await request(tx.objectStore(store).getAll());
        indexedDb.push({ where: `IndexedDB ${info.name}/${store}`, text: json({ keys, values }) });
      }
    } finally {
      db.close();
    }
  }
  const filledCardInputs = cardPaths.includes(location.pathname)
    ? Array.from(document.querySelectorAll<HTMLInputElement>("input[data-card-input]"))
        .filter((input) => input.value !== "")
        .map((input) => input.dataset["cardInput"] ?? input.id)
    : [];
  return {
    localStorage: entries(globalThis.localStorage),
    sessionStorage: entries(globalThis.sessionStorage),
    indexedDb,
    windowName: String(window.name),
    href: location.href,
    state: json(history.state),
    filledCardInputs,
  };
}

/** The card leak checks of one browser context. */
export class CardLeakGuards {
  readonly #cards: TypedCard[] = [];
  readonly #requests: RecordedRequest[] = [];
  readonly #answers: RecordedAnswer[] = [];
  readonly #reports: DocumentReport[] = [];

  private constructor(private readonly context: CardLeakContext) {}

  /** Installs the checks on `context` (before its first navigation) and returns them. */
  static async install(context: CardLeakContext): Promise<CardLeakGuards> {
    const guards = new CardLeakGuards(context);
    await context.exposeBinding(CARD_LEAK_BINDING, (_source, report: unknown) => guards.record(report));
    await context.addInitScript({ content: CARD_LEAK_INIT_SCRIPT });
    context.on("request", (request) => guards.request(request));
    context.on("response", (response) => guards.response(response));
    return guards;
  }

  /** Remembers a card the journey is about to type: from now on every check looks for its values. */
  remember(card: TypedCard): void {
    this.#cards.push(card);
  }

  /** The airline-card completions the context sent so far: their Idempotency-Key, never their body. */
  get completions(): readonly { readonly idempotencyKey: string | undefined }[] {
    return this.#requests
      .filter((request) => isCompletionRequest(request.method, request.url))
      .map((request) => ({ idempotencyKey: request.headers["idempotency-key"] }));
  }

  /** A report of a document (through the binding). */
  record(report: unknown): void {
    if (report === null || typeof report !== "object") {
      return;
    }
    const kind = (report as { kind?: unknown }).kind;
    if (kind === "document" || kind === "history") {
      this.#reports.push(report as DocumentReport);
    }
  }

  /** A request of any page or frame of the context. */
  request(request: Request): void {
    let document = "";
    try {
      document = request.frame().url();
    } catch {
      // A request without a frame (a service worker's): the storefront allows none (`worker-src 'none'`).
    }
    this.#requests.push({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      body: request.postData(),
      document,
    });
  }

  /** An answer: those of the OTA API through the storefront are read when the checks run. */
  response(response: Response): void {
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin === STOREFRONT_URL && url.pathname.startsWith("/api/")) {
      // A body that cannot be read (a redirect, a closed page) is left out.
      this.#answers.push({ url: response.url(), body: response.text().catch(() => null) });
    }
  }

  /** Every problem of the checks of `expectNoLeak` on `page` as it is now (see the top of this file). */
  async findLeaks(page: Page): Promise<CardLeak[]> {
    const leaks: CardLeak[] = [];
    const check = (where: string, text: string, options?: { readonly securityCode?: boolean }) => {
      const kinds = cardValuesIn(text, this.#cards, options);
      if (kinds.length > 0) {
        leaks.push({ where, kinds });
      }
    };

    // The page's own storage, `window.name`, address and state (on a storefront page only: storage is per origin).
    const page_ = page.url().split(/[?#]/)[0] ?? "";
    if (!FIRST_PARTY_ORIGINS.some((origin) => page.url().startsWith(`${origin}/`))) {
      leaks.push({ where: `the page ${page_}, which is not a storefront page`, kinds: [] });
    } else {
      const storage = await page.evaluate(pageStorage, [...AIRLINE_CARD_PAGE_PATHS]);
      for (const [key, value] of storage.localStorage) {
        check(`localStorage "${key}"`, `${key}\n${value}`);
      }
      for (const [key, value] of storage.sessionStorage) {
        check(`sessionStorage "${key}"`, `${key}\n${value}`);
      }
      for (const entry of storage.indexedDb) {
        check(entry.where, entry.text);
      }
      check(`window.name of ${page_}`, storage.windowName);
      check(`the address of ${page_}`, storage.href);
      check(`history.state of ${page_}`, storage.state);
      if (storage.filledCardInputs.length > 0) {
        leaks.push({
          where: `the card inputs ${storage.filledCardInputs.join(", ")} of ${page_}, which are not empty`,
          kinds: [],
        });
      }
    }

    // Every cookie of the context, httpOnly ones included.
    for (const cookie of await this.context.cookies()) {
      let value = cookie.value;
      try {
        value = decodeURIComponent(cookie.value);
      } catch {
        // The raw value is checked.
      }
      check(`the cookie ${cookie.name}`, `${cookie.name}=${value}`);
    }

    // Every document the context loaded and every state a script set.
    for (const report of this.#reports) {
      const where = withoutQuery(report.href);
      if (report.kind === "document") {
        check(`the address of a document (${where})`, report.href);
        check(`history.state of ${where} (${report.event})`, report.state);
        check(`window.name of ${where} (${report.event})`, report.name);
      } else if (report.kind === "history") {
        check(`an address given to history (${where})`, report.href);
        check(`a state given to history on ${where}`, report.state);
      }
    }

    // Every request: its address and headers; its body, except the completion's, which carries the card.
    for (const request of this.#requests) {
      const where = `the request ${request.method} ${withoutQuery(request.url)}`;
      check(`the address of ${where}`, request.url);
      for (const [name, value] of Object.entries(request.headers)) {
        check(`the header ${name} of ${where}`, value, { securityCode: name !== "content-length" });
      }
      if (request.body !== null && !isCompletionRequest(request.method, request.url)) {
        check(`the body of ${where}`, request.body);
      }
      if (isAirlineCardPage(request.document) && !requestIsFirstParty(request.url)) {
        leaks.push({ where: `a request of the airline-card page to another origin: ${where}`, kinds: [] });
      }
    }

    // Every answer of the OTA API: never the card number, its last 12 digits or the holder's name.
    for (const answer of this.#answers) {
      const body = await answer.body;
      if (body !== null) {
        check(`the answer of ${withoutQuery(answer.url)}`, body, { securityCode: false });
      }
    }
    // A place named by a card value (a storage key, a cookie name, a path) is reported without it.
    return leaks.map((leak) => ({ where: redactPlace(leak.where, this.#cards), kinds: leak.kinds }));
  }

  /** Fails the test when `findLeaks` finds anything (see the top of this file). */
  async expectNoLeak(page: Page): Promise<void> {
    expect(
      this.#cards.length,
      "remember the cards the journey types before checking for them",
    ).toBeGreaterThan(0);
    const leaks = await this.findLeaks(page);
    expect(leaks, `card values found where the browser keeps them:\n${formatLeaks(leaks)}`).toEqual([]);
  }
}

/** Whether a request goes to one of the storefront's origins (or is local: `data:`, `blob:`). */
function requestIsFirstParty(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      FIRST_PARTY_ORIGINS.includes(parsed.origin)
    );
  } catch {
    return false;
  }
}

/** Stripe.js on the card payment page: an empty script, never the network (tools/e2e/README.md, storefront guards). */
const STRIPE_JS = "https://js.stripe.com/**";

/** The window handle the opener keeps, on the opener's `window`. */
const OPENED = "__vxE2eOpenedCardPage";

/**
 * Proves the COOP `same-origin` of the airline-card page (OADR-0017 point 3): a new page of `context` on
 * `/checkout/pay-card.html` (the storefront page with Stripe.js, here an empty stand-in) runs `window.open(address)`
 * for the airline-card page at `address`. The opened page shows its card form, yet the opener's handle reports
 * `closed`, gives no access to the document and its inputs, and the opened page has no `window.opener`. Both pages
 * pass `checkA11y` and are closed afterwards. Returns nothing; fails the test otherwise.
 */
export async function expectOpenerCutOff(
  context: BrowserContext,
  address: string,
  checkA11y: (page: Page) => Promise<void>,
): Promise<void> {
  const opener = await context.newPage();
  let opened: Page | undefined;
  try {
    await opener.route(STRIPE_JS, (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
    );
    await opener.goto("/checkout/pay-card.html");
    await expect(opener.getByRole("heading", { level: 1, name: "Pay by card" })).toBeVisible();
    await expect(opener.getByRole("main").getByText("We could not find this payment")).toBeVisible();
    await checkA11y(opener);

    const openedPage = context.waitForEvent("page");
    await opener.evaluate(
      ([url, slot]) => {
        (window as unknown as Record<string, unknown>)[slot] = window.open(url, "_blank");
      },
      [address, OPENED] as const,
    );
    opened = await openedPage;
    await opened.waitForURL((url) => isAirlineCardPage(url.href));
    await expect(opened.getByRole("heading", { level: 2, name: "Your card", exact: true })).toBeVisible();
    await expect(opened.getByRole("textbox", { name: "Card number" })).toBeVisible();
    await checkA11y(opened);

    // The opener's handle is cut off: closed, and nothing of the card page's document is reachable through it.
    await expect
      .poll(() =>
        opener.evaluate((slot) => {
          const handle = (window as unknown as Record<string, Window | null>)[slot];
          return handle === null || handle === undefined ? "no handle" : handle.closed ? "closed" : "open";
        }, OPENED),
      )
      .toBe("closed");
    const reach = await opener.evaluate((slot) => {
      const handle = (window as unknown as Record<string, Window | null>)[slot];
      try {
        const inputs = handle?.document?.querySelectorAll("input[data-card-input]");
        return inputs === undefined || inputs === null ? "no document" : `${inputs.length} card inputs`;
      } catch {
        return "refused";
      }
    }, OPENED);
    expect(["no document", "refused"]).toContain(reach);
    expect(await opened.evaluate(() => window.opener === null)).toBe(true);
  } finally {
    await opened?.close();
    await opener.close();
  }
}
