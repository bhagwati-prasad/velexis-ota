// The card leak checks without a browser (OFE-018 step 3): what counts as a card value where, the report of the script
// every storefront document runs, and the checks a journey runs after each path. The journey proves the same checks in
// Chromium (specs/storefront/checkout-airline-card.e2e.ts).
import { runInNewContext } from "node:vm";
import type { Page, Request, Response } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  AIRLINE_CARD_PAGE_PATHS,
  CARD_LEAK_BINDING,
  CARD_LEAK_INIT_SCRIPT,
  CardLeakGuards,
  cardValuesIn,
  formatLeaks,
  isAirlineCardPage,
  isCompletionRequest,
  joinDigits,
  redactPlace,
  type CardLeakContext,
  type PageStorage,
  type TypedCard,
} from "../support/card-leak-guards";
import { STOREFRONT_URL, SUSPENDED_STOREFRONT_URL } from "../support/stack";

/** The test PAN of OADR-0017 point 8, as a traveller types it. */
const CARD: TypedCard = {
  number: "4111 1111 1111 1111",
  securityCode: "853",
  holderName: "Ada Q Holdertest",
};
const CARD_PAGE = `${STOREFRONT_URL}/checkout/pay-airline.html?id=chk_01JB0000000000000000000000&payment=pay_1`;
const CONFIRMATION = `${STOREFRONT_URL}/confirmation.html?booking=bkg_01JB0000000000000000000000`;
const COMPLETION = `${STOREFRONT_URL}/api/v1/checkouts/chk_01JB0000000000000000000000/airline-card-completion`;

describe("isAirlineCardPage and isCompletionRequest", () => {
  it("know the airline-card page by its path on a storefront origin [OFE-018 AC1]", () => {
    expect(isAirlineCardPage(CARD_PAGE)).toBe(true);
    expect(isAirlineCardPage(`${SUSPENDED_STOREFRONT_URL}/checkout/pay-airline`)).toBe(true);
    expect(isAirlineCardPage(`${STOREFRONT_URL}/checkout/pay-card.html`)).toBe(false);
    expect(isAirlineCardPage("https://evil.example/checkout/pay-airline.html")).toBe(false);
    expect(isAirlineCardPage("about:blank")).toBe(false);
    expect(AIRLINE_CARD_PAGE_PATHS).toEqual(["/checkout/pay-airline.html", "/checkout/pay-airline"]);
  });

  it("know the completion: POST to …/airline-card-completion through the storefront [OFE-018 AC1]", () => {
    expect(isCompletionRequest("POST", COMPLETION)).toBe(true);
    expect(isCompletionRequest("post", COMPLETION)).toBe(true);
    expect(isCompletionRequest("GET", COMPLETION)).toBe(false);
    expect(isCompletionRequest("POST", `${STOREFRONT_URL}/api/v1/checkouts/chk_1/payments/pay_1`)).toBe(
      false,
    );
    expect(
      isCompletionRequest("POST", "http://127.0.0.1:4000/v1/checkouts/chk_1/airline-card-completion"),
    ).toBe(false);
    expect(isCompletionRequest("POST", "not a url")).toBe(false);
  });
});

describe("cardValuesIn", () => {
  it("finds the card number typed with spaces, hyphens or encoded, and its last 12 digits [OFE-018 AC1]", () => {
    expect(joinDigits("4111 1111-1111%201111 and 12 34")).toBe("4111111111111111 and 1234");
    for (const text of [
      '{"number":"4111111111111111"}',
      "number=4111+1111+1111+1111",
      "4111%201111%201111%201111",
      "card 4111-1111-1111-1111",
    ]) {
      expect(cardValuesIn(text, [CARD])).toEqual(["card number", "last 12 digits"]);
    }
    expect(cardValuesIn("…111111111111", [CARD])).toEqual(["last 12 digits"]);
    // The BIN and the last 4 may be kept (ADR-0011 §B.5): neither is a card value here.
    expect(cardValuesIn('{"bin":"411111","last4":"1111"}', [CARD])).toEqual([]);
  });

  it("finds the security code only as a value of its own, never inside an id, a number or an amount [OFE-018 AC1]", () => {
    for (const text of ['{"securityCode":"853"}', "cvc=853&x=1", "code: 853", "853"]) {
      expect(cardValuesIn(text, [CARD])).toEqual(["security code"]);
    }
    for (const text of ["chk_01JB853QX", "18530", "853.20", "1,853", "2026-10-29T08:53:00Z"]) {
      expect(cardValuesIn(text, [CARD])).toEqual([]);
    }
    expect(cardValuesIn('{"flightNumber":"853"}', [CARD], { securityCode: false })).toEqual([]);
  });

  it("finds the holder's name in any case, and checks every card remembered [OFE-018 AC1]", () => {
    expect(cardValuesIn("HOLDER: ADA Q HOLDERTEST", [CARD])).toEqual(["holder name"]);
    const declined: TypedCard = {
      number: "4000 0000 0000 0002",
      securityCode: "947",
      holderName: "Ada Declined",
    };
    expect(cardValuesIn("4000000000000002", [CARD, declined])).toEqual(["card number", "last 12 digits"]);
    expect(cardValuesIn("nothing here", [CARD, declined])).toEqual([]);
  });

  it("names where and what in the report, never the value [OFE-018 AC1]", () => {
    const report = formatLeaks([
      { where: 'sessionStorage "vx.config"', kinds: ["card number", "security code"] },
      { where: "the card inputs number of /checkout/pay-airline.html, which are not empty", kinds: [] },
    ]);
    expect(report).toBe(
      [
        '  - card number, security code in sessionStorage "vx.config"',
        "  - the card inputs number of /checkout/pay-airline.html, which are not empty",
      ].join("\n"),
    );
    expect(report).not.toMatch(/4111|853/);
  });

  it("names a place whose own name holds a card value without that value [OFE-018 AC1]", () => {
    expect(redactPlace('localStorage "card-4111111111111111"', [CARD])).toBe(
      'localStorage "card-[card value]"',
    );
    expect(
      redactPlace(`the request GET ${STOREFRONT_URL}/api/v1/c/4111%201111%201111%201111/x`, [CARD]),
    ).toBe(`the request GET ${STOREFRONT_URL}/api/v1/c/[card value]/x`);
    expect(redactPlace("IndexedDB 111111111111/cvc-853", [CARD])).toBe(
      "IndexedDB [card value]/cvc-[card value]",
    );
    expect(redactPlace("the cookie ADA_Q_HOLDERTEST or ada q holdertest", [CARD])).toBe(
      "the cookie ADA_Q_HOLDERTEST or [card value]",
    );
    // Nothing else changes: ids and amounts that merely contain the digits stay as they are.
    const plain = `the answer of ${STOREFRONT_URL}/api/v1/checkouts/chk_01JB853QX (1853.20)`;
    expect(redactPlace(plain, [CARD])).toBe(plain);
  });
});

/** The init script in a fake top-level document at `href`; returns its handlers, the reports and the history. */
function runInitScript(href: string, options: { readonly top?: boolean } = {}) {
  const handlers = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const reports: Record<string, unknown>[] = [];
  const calls: unknown[][] = [];
  const url = new URL(href);
  const history: Record<string, unknown> = {
    state: { step: "payment" },
    pushState: (...args: unknown[]) => calls.push(["push", ...args]),
    replaceState: (...args: unknown[]) => calls.push(["replace", ...args]),
  };
  const window: Record<string, unknown> = {
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) =>
      handlers.set(type, [...(handlers.get(type) ?? []), handler]),
    location: { href, origin: url.origin, pathname: url.pathname },
    history,
    name: "",
    JSON,
    String,
    URL,
    [CARD_LEAK_BINDING]: (report: Record<string, unknown>) => reports.push(report),
  };
  window["window"] = window;
  window["globalThis"] = window;
  window["top"] = options.top === false ? {} : window;
  runInNewContext(CARD_LEAK_INIT_SCRIPT, window);
  const fire = (type: string) => {
    for (const handler of handlers.get(type) ?? []) {
      handler({});
    }
  };
  return { handlers, reports, calls, history, fire };
}

describe("CARD_LEAK_INIT_SCRIPT", () => {
  it("reports the address, history.state and window.name of a storefront document when it loads and is left [OFE-018 AC1]", () => {
    const { reports, fire } = runInitScript(CONFIRMATION);
    fire("load");
    fire("pagehide");
    expect(reports).toEqual([
      { kind: "document", event: "load", href: CONFIRMATION, state: '{"step":"payment"}', name: "" },
      { kind: "document", event: "pagehide", href: CONFIRMATION, state: '{"step":"payment"}', name: "" },
    ]);
  });

  it("reports every address and state given to history, and passes the call on [OFE-018 AC1]", () => {
    const { reports, calls, history } = runInitScript(`${STOREFRONT_URL}/checkout.html?id=chk_1`);
    (history["pushState"] as (...args: unknown[]) => void)(
      { step: "contacts" },
      "",
      "?id=chk_1&step=contacts",
    );
    (history["replaceState"] as (...args: unknown[]) => void)(null, "");
    expect(reports).toEqual([
      {
        kind: "history",
        href: `${STOREFRONT_URL}/checkout.html?id=chk_1&step=contacts`,
        state: '{"step":"contacts"}',
      },
      { kind: "history", href: `${STOREFRONT_URL}/checkout.html?id=chk_1`, state: "null" },
    ]);
    expect(calls).toEqual([
      ["push", { step: "contacts" }, "", "?id=chk_1&step=contacts"],
      ["replace", null, ""],
    ]);
  });

  it("does nothing in a frame or on another origin [OFE-018 AC1]", () => {
    const frame = runInitScript(CARD_PAGE, { top: false });
    frame.fire("load");
    expect(frame.handlers.size).toBe(0);
    const other = runInitScript("https://js.stripe.com/v3/m-outer.html");
    expect(other.handlers.size).toBe(0);
  });
});

/** A fake browser context: the binding, the init script, the listeners and the cookies the checks use. */
function fakeContext(cookies: { name: string; value: string }[] = []) {
  const installed: {
    binding?: (source: unknown, report: unknown) => void;
    bindingName?: string;
    script?: string;
    onRequest?: (request: Request) => void;
    onResponse?: (response: Response) => void;
  } = {};
  const context = {
    exposeBinding: async (name: string, callback: (source: unknown, report: unknown) => void) => {
      installed.bindingName = name;
      installed.binding = callback;
    },
    addInitScript: async (script: { content: string }) => {
      installed.script = script.content;
    },
    cookies: async () =>
      cookies.map((cookie) => ({ ...cookie, domain: "127.0.0.1", path: "/", httpOnly: true, secure: true })),
    on: (event: string, listener: (value: never) => void) => {
      if (event === "request") {
        installed.onRequest = listener as (request: Request) => void;
      } else if (event === "response") {
        installed.onResponse = listener as (response: Response) => void;
      }
    },
  } as unknown as CardLeakContext;
  return { context, installed };
}

/** A fake request made by the document at `documentUrl`. */
function fakeRequest(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string>; document?: string } = {},
): Request {
  return {
    url: () => url,
    method: () => options.method ?? "GET",
    headers: () => options.headers ?? {},
    postData: () => options.body ?? null,
    frame: () => ({ url: () => options.document ?? CONFIRMATION }),
  } as unknown as Request;
}

/** A fake answer of the OTA API. */
function fakeResponse(url: string, body: string): Response {
  return { url: () => url, text: async () => body } as unknown as Response;
}

const CLEAN_STORAGE: PageStorage = {
  localStorage: [["vx.currency", "EUR"]],
  sessionStorage: [["vx.config", '{"name":"Demo Travel"}']],
  indexedDb: [],
  windowName: "",
  href: CONFIRMATION,
  state: "null",
  filledCardInputs: [],
};

/** A fake page at `url` whose storage reads as `storage`. */
function fakePage(url: string, storage: Partial<PageStorage> = {}): Page {
  return {
    url: () => url,
    evaluate: async () => ({ ...CLEAN_STORAGE, href: url, ...storage }),
  } as unknown as Page;
}

describe("CardLeakGuards", () => {
  it("installs its binding, its script and its request and answer listeners on the context [OFE-018 AC1]", async () => {
    const { context, installed } = fakeContext();
    await CardLeakGuards.install(context);
    expect(installed.bindingName).toBe(CARD_LEAK_BINDING);
    expect(installed.script).toBe(CARD_LEAK_INIT_SCRIPT);
    expect(installed.onRequest).toBeTypeOf("function");
    expect(installed.onResponse).toBeTypeOf("function");
  });

  it("finds nothing on a clean path, the card in the completion's body included [OFE-018 AC1]", async () => {
    const { context, installed } = fakeContext([{ name: "__Host-vx_bt", value: "opaque-token" }]);
    const guards = await CardLeakGuards.install(context);
    guards.remember(CARD);
    const page = fakePage(CONFIRMATION);
    installed.onRequest?.(
      fakeRequest(`${STOREFRONT_URL}/api/v1/payments/pay_1`, {
        method: "PATCH",
        body: '{"card":{"brand":"VISA","bin":"411111"}}',
        document: CARD_PAGE,
      }),
    );
    installed.onRequest?.(
      fakeRequest(COMPLETION, {
        method: "POST",
        body: '{"card":{"number":"4111111111111111","securityCode":"853","holderName":"Ada Q Holdertest"}}',
        headers: { "idempotency-key": "key-1", "content-length": "853" },
        document: CARD_PAGE,
      }),
    );
    installed.onResponse?.(fakeResponse(COMPLETION, '{"booking":{"id":"bkg_1","payment":{"last4":"1111"}}}'));
    installed.binding?.({}, { kind: "document", event: "load", href: CARD_PAGE, state: "null", name: "" });
    installed.binding?.({}, { kind: "document", event: "load", href: CONFIRMATION, state: "null", name: "" });
    installed.binding?.({}, { kind: "unknown" });
    installed.binding?.({}, null);
    expect(await guards.findLeaks(page)).toEqual([]);
    await guards.expectNoLeak(page);
    expect(guards.completions).toEqual([{ idempotencyKey: "key-1" }]);
  });

  it("finds a card value in storage, IndexedDB, window.name, the address and history.state of the page [OFE-018 AC1]", async () => {
    const { context } = fakeContext();
    const guards = await CardLeakGuards.install(context);
    guards.remember(CARD);
    const page = fakePage(CONFIRMATION, {
      localStorage: [["card", "4111111111111111"]],
      sessionStorage: [["vx.form", '{"cvc":"853"}']],
      indexedDb: [{ where: "IndexedDB cards/drafts", text: '{"values":["ada q holdertest"]}' }],
      windowName: "4111 1111 1111 1111",
      href: `${CONFIRMATION}&n=4111111111111111`,
      state: '{"number":"111111111111"}',
    });
    expect((await guards.findLeaks(page)).map((leak) => leak.where)).toEqual([
      'localStorage "card"',
      'sessionStorage "vx.form"',
      "IndexedDB cards/drafts",
      `window.name of ${STOREFRONT_URL}/confirmation.html`,
      `the address of ${STOREFRONT_URL}/confirmation.html`,
      `history.state of ${STOREFRONT_URL}/confirmation.html`,
    ]);
    await expect(guards.expectNoLeak(page)).rejects.toThrow(/card values found where the browser keeps them/);
  });

  it("finds a card value in a cookie, a document's address or state, a request and an answer [OFE-018 AC1]", async () => {
    const { context, installed } = fakeContext([{ name: "draft", value: "4111%201111%201111%201111" }]);
    const guards = await CardLeakGuards.install(context);
    guards.remember(CARD);
    const page = fakePage(CONFIRMATION);
    installed.binding?.(
      {},
      { kind: "document", event: "pagehide", href: CONFIRMATION, state: '{"cvc":"853"}', name: "" },
    );
    installed.binding?.({}, { kind: "history", href: `${CONFIRMATION}#4111111111111111`, state: "null" });
    installed.onRequest?.(fakeRequest(`${STOREFRONT_URL}/api/v1/log?card=4111111111111111`));
    installed.onRequest?.(
      fakeRequest(`${STOREFRONT_URL}/api/v1/payments/pay_1`, {
        method: "PATCH",
        body: '{"number":"4111111111111111"}',
      }),
    );
    installed.onRequest?.(
      fakeRequest(COMPLETION, { method: "POST", headers: { "x-card": "4111111111111111" } }),
    );
    installed.onResponse?.(
      fakeResponse(`${STOREFRONT_URL}/api/v1/bookings/bkg_1`, '{"holder":"ADA Q HOLDERTEST"}'),
    );
    const where = (await guards.findLeaks(page)).map((leak) => leak.where);
    expect(where).toEqual([
      "the cookie draft",
      `history.state of ${STOREFRONT_URL}/confirmation.html (pagehide)`,
      `an address given to history (${STOREFRONT_URL}/confirmation.html)`,
      `the address of the request GET ${STOREFRONT_URL}/api/v1/log`,
      `the body of the request PATCH ${STOREFRONT_URL}/api/v1/payments/pay_1`,
      `the header x-card of the request POST ${COMPLETION}`,
      `the answer of ${STOREFRONT_URL}/api/v1/bookings/bkg_1`,
    ]);
  });

  it("reports a place named by a card value without the value [OFE-018 AC1]", async () => {
    const { context, installed } = fakeContext([{ name: "n4111111111111111", value: "1" }]);
    const guards = await CardLeakGuards.install(context);
    guards.remember(CARD);
    installed.onRequest?.(fakeRequest(`${STOREFRONT_URL}/api/v1/cards/4111111111111111`));
    const leaks = await guards.findLeaks(
      fakePage(CONFIRMATION, { localStorage: [["Ada Q Holdertest", "x"]] }),
    );
    expect(leaks).toEqual([
      { where: 'localStorage "[card value]"', kinds: ["holder name"] },
      { where: "the cookie n[card value]", kinds: ["card number", "last 12 digits"] },
      {
        where: `the address of the request GET ${STOREFRONT_URL}/api/v1/cards/[card value]`,
        kinds: ["card number", "last 12 digits"],
      },
    ]);
    expect(formatLeaks(leaks)).not.toMatch(/4111|111111111111|holdertest/i);
  });

  it("fails on a card input of the airline-card page that is not empty [OFE-018 AC1]", async () => {
    const { context } = fakeContext();
    const guards = await CardLeakGuards.install(context);
    guards.remember(CARD);
    expect(await guards.findLeaks(fakePage(CARD_PAGE))).toEqual([]);
    expect(
      (await guards.findLeaks(fakePage(CARD_PAGE, { filledCardInputs: ["number", "csc"] }))).map(
        (leak) => leak.where,
      ),
    ).toEqual([
      `the card inputs number, csc of ${STOREFRONT_URL}/checkout/pay-airline.html, which are not empty`,
    ]);
  });

  it("fails on a request of the airline-card page to another origin [OFE-018 AC1]", async () => {
    const { context, installed } = fakeContext();
    const guards = await CardLeakGuards.install(context);
    guards.remember(CARD);
    installed.onRequest?.(fakeRequest("https://cdn.example/widget.js", { document: CARD_PAGE }));
    installed.onRequest?.(fakeRequest(`${STOREFRONT_URL}/assets/x.js`, { document: CARD_PAGE }));
    installed.onRequest?.(
      fakeRequest("https://js.stripe.com/v3/", { document: `${STOREFRONT_URL}/checkout/pay-card.html` }),
    );
    expect((await guards.findLeaks(fakePage(CONFIRMATION))).map((leak) => leak.where)).toEqual([
      "a request of the airline-card page to another origin: the request GET https://cdn.example/widget.js",
    ]);
  });

  it("refuses a check before any card was remembered, and a page that is not the storefront's [OFE-018 AC1]", async () => {
    const { context } = fakeContext();
    const guards = await CardLeakGuards.install(context);
    await expect(guards.expectNoLeak(fakePage(CONFIRMATION))).rejects.toThrow(/remember the cards/);
    guards.remember(CARD);
    expect(await guards.findLeaks(fakePage("about:blank"))).toEqual([
      { where: "the page about:blank, which is not a storefront page", kinds: [] },
    ]);
  });
});
