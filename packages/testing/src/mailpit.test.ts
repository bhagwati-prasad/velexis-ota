import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMailpitClient,
  extractLinks,
  MAILPIT_DEFAULT_TIMEOUT_MS,
  MAILPIT_POLL_INTERVAL_MS,
  MAILPIT_SEARCH_LIMIT,
  MailpitError,
  MailpitTimeoutError,
  uniqueEmail,
  type MailpitFetch,
  type MailpitTimer,
} from "./mailpit.js";
import * as mailpitModule from "./mailpit.js";

// Tests of task X-025 without a Mailpit: the API calls against a fake Mailpit (`fetch` replaced), the polling of
// waitForMessage on a fake timer, uniqueEmail and extractLinks. The real Mailpit, SMTP and two parallel test files
// are in test/integration/mailpit.int.test.ts and mailpit-parallel.int.test.ts.

const API = "http://127.0.0.1:8025";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;

interface FakeMail {
  readonly id: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
}

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: unknown;
}

/** A time source that moves only when the code under test sleeps, and records every sleep. */
function fakeTimer(): MailpitTimer & { readonly sleeps: number[]; elapsed(): number } {
  let now = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    elapsed: () => now - 1_000,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * The part of Mailpit's API v1 the client uses, with Mailpit's semantics: `to:"…"` and `subject:"…"` match
 * substrings, case-insensitively, the newest message first; empty lists are `null`; `GET /message/{id}` of an
 * unknown ID is a 404.
 */
class FakeMailpit {
  readonly requests: RecordedRequest[] = [];
  #inbox: FakeMail[] = [];
  /** Mail that "arrives" once the timer has reached its time. */
  #scheduled: { readonly at: number; readonly mail: FakeMail }[] = [];

  constructor(private readonly timer?: { elapsed(): number }) {}

  deliver(...mails: FakeMail[]): this {
    this.#inbox.unshift(...[...mails].reverse());
    return this;
  }

  deliverAt(elapsedMs: number, mail: FakeMail): this {
    this.#scheduled.push({ at: elapsedMs, mail });
    return this;
  }

  get searches(): RecordedRequest[] {
    return this.requests.filter((request) => request.url.pathname.endsWith("/api/v1/search"));
  }

  readonly fetch: MailpitFetch = (url, init) => {
    const parsed = new URL(url);
    this.requests.push({
      method: init.method ?? "GET",
      url: parsed,
      headers: { ...(init.headers as Record<string, string>) },
      signal: init.signal,
    });
    const elapsed = this.timer?.elapsed() ?? 0;
    for (const item of this.#scheduled.filter((entry) => entry.at <= elapsed)) {
      this.deliver(item.mail);
    }
    this.#scheduled = this.#scheduled.filter((entry) => entry.at > elapsed);
    const path = parsed.pathname.replace(/^.*\/api\/v1\//, "");
    if (init.method === "GET" && path === "search") {
      const query = parsed.searchParams.get("query") ?? "";
      if (query === "") {
        return Promise.resolve(new Response("Error: no search query", { status: 400 }));
      }
      const terms = [...query.matchAll(/(to|subject):"([^"]*)"/g)].map(([, field, value]) => ({
        field,
        value: (value ?? "").toLowerCase(),
      }));
      const found = this.#inbox.filter((mail) =>
        terms.every(({ field, value }) =>
          field === "to"
            ? mail.to.some((address) => address.toLowerCase().includes(value))
            : mail.subject.toLowerCase().includes(value),
        ),
      );
      return Promise.resolve(
        jsonResponse({
          total: this.#inbox.length,
          messages_count: found.length,
          messages: found.map(summary),
        }),
      );
    }
    if (init.method === "GET" && path.startsWith("message/")) {
      const mail = this.#inbox.find(
        (entry) => entry.id === decodeURIComponent(path.slice("message/".length)),
      );
      return Promise.resolve(
        mail === undefined ? new Response("message not found", { status: 404 }) : jsonResponse(full(mail)),
      );
    }
    if (init.method === "DELETE" && path === "messages") {
      this.#inbox = [];
      return Promise.resolve(new Response("ok"));
    }
    return Promise.resolve(new Response("404 page not found", { status: 404 }));
  };
}

function summary(mail: FakeMail): Record<string, unknown> {
  return {
    ID: mail.id,
    MessageID: `${mail.id}@mailpit`,
    Read: false,
    From: { Name: "Velexis", Address: "no-reply@example.com" },
    To: mail.to.map((address) => ({ Name: "", Address: address })),
    Cc: null,
    Bcc: null,
    ReplyTo: null,
    Subject: mail.subject,
    Created: "2026-10-14T06:37:57.896Z",
    Username: "",
    Tags: null,
    Size: 685,
    Attachments: 0,
    Snippet: (mail.text ?? "").slice(0, 20),
  };
}

function full(mail: FakeMail): Record<string, unknown> {
  const { Created: _created, Read: _read, Snippet: _snippet, ...rest } = summary(mail);
  return {
    ...rest,
    ReturnPath: "no-reply@example.com",
    Date: "2026-10-14T06:37:57.000Z",
    Text: mail.text ?? "",
    HTML: mail.html ?? "",
    Inline: [],
    Attachments: [],
  };
}

describe("uniqueEmail", () => {
  it("returns <label>+<uuid>@example.com, a new address on every call", () => {
    const first = uniqueEmail("signup");
    const second = uniqueEmail("signup");
    expect(first).toMatch(new RegExp(`^signup\\+${UUID.source}@example\\.com$`));
    expect(second).toMatch(new RegExp(`^signup\\+${UUID.source}@example\\.com$`));
    expect(first).not.toBe(second);
    expect(new Set(Array.from({ length: 1_000 }, () => uniqueEmail("p"))).size).toBe(1_000);
  });

  it("accepts labels of a-z, 0-9, '.', '_' and '-' up to 27 characters (a 64-character local part)", () => {
    for (const label of ["a", "invite-owner", "reset_password", "x.2", "a".repeat(27)]) {
      const address = uniqueEmail(label);
      expect(address.startsWith(`${label}+`)).toBe(true);
      expect(address.split("@")[0]?.length).toBeLessThanOrEqual(64);
    }
    expect(uniqueEmail("a".repeat(27)).split("@")[0]).toHaveLength(64);
  });

  it("refuses a label that would not make a plain, lower-case address", () => {
    for (const label of ["", "Signup", "a+b", "a@b", "a b", ".a", "a.", "a..b", "-a", "a".repeat(28), "é"]) {
      expect(() => uniqueEmail(label)).toThrow(TypeError);
    }
    expect(() => uniqueEmail(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe("extractLinks", () => {
  it("returns the hrefs of the HTML part, then the URLs of the text part, each once", () => {
    const link = "https://portal.example.com/verify-email?token=t0k3n&lang=en";
    const links = extractLinks({
      HTML:
        `<p>Welcome</p><p><a class="button" href="https://portal.example.com/verify-email?token=t0k3n&amp;lang=en">` +
        'Verify</a></p><p><a href="mailto:support@example.com">Support</a></p>',
      Text: `Welcome\n\nVerify your address: ${link}\n\nOr visit https://portal.example.com/help.\n`,
    });
    expect(links).toEqual([link, "mailto:support@example.com", "https://portal.example.com/help"]);
  });

  it("reads every way of writing an href and decodes character references", () => {
    const html = [
      `<a href='https://a.example/single'>x</a>`,
      `<a href=https://a.example/bare>x</a>`,
      `<A\n  title="t"\n  HREF = "https://a.example/upper?x=1&#38;y=2&#x26;z=3">x</A>`,
      `<a data-href="https://a.example/data" href="https://a.example/real">x</a>`,
      `<a data-href="https://a.example/data-only">x</a>`,
      `<!-- <a href="https://a.example/commented">x</a> -->`,
      `<link href="https://a.example/style.css" rel="stylesheet"><area href="https://a.example/area">`,
      `<a href="">empty</a><a href="  https://a.example/spaced  ">x</a><a href="/relative?a=1&quot;">x</a>`,
      `<abbr href="https://a.example/abbr">x</abbr><a name="top">no href</a>`,
    ].join("\n");
    expect(extractLinks({ HTML: html, Text: "" })).toEqual([
      "https://a.example/single",
      "https://a.example/bare",
      "https://a.example/upper?x=1&y=2&z=3",
      "https://a.example/real",
      "https://a.example/spaced",
      '/relative?a=1"',
    ]);
  });

  it("keeps a URL of the text part whole and leaves out the punctuation around it", () => {
    const text = [
      "Open https://a.example/one. Then https://a.example/two, and https://a.example/three;",
      "(see https://a.example/four) or https://en.example/wiki/Foo_(bar) or <https://a.example/five>",
      'Quoted "https://a.example/six"? Done: http://a.example:8080/seven?x=1&y=2#frag!',
      "[https://a.example/eight] and {https://a.example/nine}; not ftp://a.example/ten or www.a.example",
    ].join("\n");
    expect(extractLinks({ HTML: "", Text: text })).toEqual([
      "https://a.example/one",
      "https://a.example/two",
      "https://a.example/three",
      "https://a.example/four",
      "https://en.example/wiki/Foo_(bar)",
      "https://a.example/five",
      "https://a.example/six",
      "http://a.example:8080/seven?x=1&y=2#frag",
      "https://a.example/eight",
      "https://a.example/nine",
    ]);
  });

  it("returns no link for a message without parts or links", () => {
    expect(extractLinks({ HTML: "", Text: "" })).toEqual([]);
    expect(extractLinks({ HTML: "<p>No links</p>", Text: "No links." })).toEqual([]);
  });
});

describe("createMailpitClient", () => {
  it("search() asks Mailpit by recipient and subject and keeps only exact matches, newest first", async () => {
    const to = "signup+1@example.com";
    const fake = new FakeMailpit().deliver(
      { id: "m1", to: [to], subject: "Verify your e-mail" },
      { id: "m2", to: ["xsignup+1@example.com"], subject: "Verify your e-mail" },
      { id: "m3", to: ["SIGNUP+1@EXAMPLE.COM"], subject: "Verify your e-mail" },
      { id: "m4", to: [to], subject: "Verify your e-mail again" },
    );
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch });

    const found = await client.search({ to, subject: "Verify your e-mail" });
    // m2's recipient only contains the address, m4's subject only starts with the subject: Mailpit returns both.
    expect(found.map((message) => message.ID)).toEqual(["m3", "m1"]);
    const [request] = fake.requests;
    expect(request?.method).toBe("GET");
    expect(`${request?.url.origin}${request?.url.pathname}`).toBe(`${API}/api/v1/search`);
    expect(request?.url.searchParams.get("query")).toBe(`to:"${to}" subject:"Verify your e-mail"`);
    expect(request?.url.searchParams.get("limit")).toBe(String(MAILPIT_SEARCH_LIMIT));
    expect(request?.headers).toEqual({ accept: "application/json" });
    expect(request?.signal).toBeInstanceOf(AbortSignal);

    // Mailpit's null lists become empty ones.
    expect(found[0]).toMatchObject({ Cc: [], Bcc: [], ReplyTo: [], Tags: [], Subject: "Verify your e-mail" });

    // A RegExp is matched here; only the recipient goes to Mailpit.
    const byPattern = await client.search({ to, subject: /^verify/i });
    expect(byPattern.map((message) => message.ID)).toEqual(["m4", "m3", "m1"]);
    expect(fake.requests.at(-1)?.url.searchParams.get("query")).toBe(`to:"${to}"`);

    // By subject alone, every recipient.
    const bySubject = await client.search({ subject: "Verify your e-mail again" });
    expect(bySubject.map((message) => message.ID)).toEqual(["m4"]);
  });

  it("search() sends the longest part of a subject without double quotes, and compares the whole subject", async () => {
    const subject = 'Booking (ABC123): "confirmed", 100% done';
    const fake = new FakeMailpit().deliver({ id: "m1", to: ["a@example.com"], subject });
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch });
    expect((await client.search({ subject })).map((message) => message.ID)).toEqual(["m1"]);
    expect(fake.requests.at(-1)?.url.searchParams.get("query")).toBe('subject:"Booking (ABC123):"');
    expect(await client.search({ subject: 'Booking (ABC123): "confirmed"' })).toEqual([]);
  });

  it("search() refuses criteria Mailpit cannot search by, and a malformed recipient", async () => {
    const fake = new FakeMailpit();
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch });
    await expect(client.search({})).rejects.toThrow(TypeError);
    await expect(client.search({ subject: /Verify/ })).rejects.toThrow(
      "mailpit.search needs `to`, a string `subject` or both: Mailpit cannot search by a regular expression alone",
    );
    await expect(client.search({ subject: '""' })).rejects.toThrow(TypeError);
    for (const to of [
      "",
      "nobody",
      'a"b@example.com',
      "a@b@example.com",
      "a b@example.com",
      "<a@example.com>",
    ]) {
      await expect(client.search({ to })).rejects.toThrow(TypeError);
    }
    expect(fake.requests).toEqual([]);
  });

  it("get(id) returns the whole message, and names the status when Mailpit has none", async () => {
    const fake = new FakeMailpit().deliver({
      id: "a/b c",
      to: ["a@example.com"],
      subject: "Hello",
      text: "Hello https://a.example/x",
      html: '<a href="https://a.example/x">x</a>',
    });
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch });
    const message = await client.get("a/b c");
    expect(fake.requests.at(-1)?.url.pathname).toBe("/api/v1/message/a%2Fb%20c");
    expect(message).toMatchObject({
      ID: "a/b c",
      Subject: "Hello",
      To: [{ Name: "", Address: "a@example.com" }],
      Cc: [],
      Text: "Hello https://a.example/x",
      HTML: '<a href="https://a.example/x">x</a>',
      Attachments: [],
    });
    expect(extractLinks(message)).toEqual(["https://a.example/x"]);

    await expect(client.get("nope")).rejects.toThrow(
      new MailpitError(`Mailpit API GET /api/v1/message/nope at ${API} answered 404: message not found`),
    );
    await expect(client.get("")).rejects.toThrow(new TypeError("mailpit.get needs a message ID"));
  });

  it("clear() deletes every message with DELETE /api/v1/messages", async () => {
    const fake = new FakeMailpit().deliver({ id: "m1", to: ["a@example.com"], subject: "Hello" });
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch });
    await client.clear();
    expect(fake.requests.map((request) => `${request.method} ${request.url.href}`)).toEqual([
      `DELETE ${API}/api/v1/messages`,
    ]);
    expect(await client.search({ to: "a@example.com" })).toEqual([]);
  });

  it("keeps the path of the API URL and sends its credentials as a header, never showing them", async () => {
    const fake = new FakeMailpit();
    const client = createMailpitClient({
      apiUrl: "http://tester:s3cr%40t@mail.test:8025/mailpit?x=1",
      fetch: fake.fetch,
    });
    expect(client.apiUrl).toBe("http://mail.test:8025/mailpit");
    await client.search({ to: "a@example.com" });
    const [request] = fake.requests;
    expect(`${request?.url.origin}${request?.url.pathname}`).toBe(
      "http://mail.test:8025/mailpit/api/v1/search",
    );
    expect(request?.url.username).toBe("");
    expect(request?.headers.authorization).toBe(`Basic ${Buffer.from("tester:s3cr@t").toString("base64")}`);

    const error = await client.get("missing").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailpitError);
    expect(String((error as Error).message)).toContain("http://mail.test:8025/mailpit answered 404");
    expect(String((error as Error).message)).not.toMatch(/s3cr|tester/);

    expect(createMailpitClient({ apiUrl: "http://127.0.0.1:8025/", fetch: fake.fetch }).apiUrl).toBe(API);
    for (const apiUrl of ["127.0.0.1:8025", "smtp://127.0.0.1:1025", "not a url"]) {
      expect(() => createMailpitClient({ apiUrl })).toThrow(TypeError);
    }
  });

  it("explains a Mailpit that is not reachable, does not answer in time or is not Mailpit", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8025"), { code: "ECONNREFUSED" }),
    });
    const down = createMailpitClient({ apiUrl: API, fetch: () => Promise.reject(refused) });
    await expect(down.search({ to: "a@example.com" })).rejects.toThrow(
      new MailpitError(
        `Mailpit API GET /api/v1/search at ${API} failed: ECONNREFUSED. Start Mailpit ` +
          "(docs/mvp/local-development.md §4) or point MAILPIT_API_URL at it.",
      ),
    );

    // fetch's own refusals (a blocked port such as 1, here) have a cause without a system error code.
    const blocked = createMailpitClient({
      apiUrl: API,
      fetch: () => Promise.reject(new TypeError("fetch failed", { cause: new Error("bad port") })),
    });
    await expect(blocked.search({ to: "a@example.com" })).rejects.toThrow(
      `GET /api/v1/search at ${API} failed: fetch failed (bad port). Start Mailpit`,
    );

    const slow = createMailpitClient({
      apiUrl: API,
      requestTimeoutMs: 250,
      fetch: () =>
        Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    });
    await expect(slow.clear()).rejects.toThrow(
      `DELETE /api/v1/messages at ${API} failed: no answer within 250 ms`,
    );

    const notMailpit = createMailpitClient({
      apiUrl: API,
      fetch: () => Promise.resolve(new Response("<html>hello</html>", { status: 200 })),
    });
    await expect(notMailpit.search({ to: "a@example.com" })).rejects.toThrow(/did not answer JSON/);
    const wrongJson = createMailpitClient({
      apiUrl: API,
      fetch: () => Promise.resolve(jsonResponse({ ok: 1 })),
    });
    await expect(wrongJson.search({ to: "a@example.com" })).rejects.toThrow(/without a message list/);
    const noId = createMailpitClient({
      apiUrl: API,
      fetch: () => Promise.resolve(jsonResponse({ Subject: "x" })),
    });
    await expect(noId.get("x")).rejects.toThrow(/without a message ID/);
  });
});

describe("waitForMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns at once when the message is already there", async () => {
    const timer = fakeTimer();
    const to = uniqueEmail("ready");
    const fake = new FakeMailpit(timer).deliver({ id: "m1", to: [to], subject: "Verify", text: "x" });
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch, timer });
    const message = await client.waitForMessage({ to, subject: "Verify" });
    expect(message).toMatchObject({ ID: "m1", Text: "x" });
    expect(timer.sleeps).toEqual([]);
    expect(fake.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /api/v1/search",
      "GET /api/v1/message/m1",
    ]);
  });

  it("asks Mailpit every 100 ms until the message arrives, then returns it whole", async () => {
    const timer = fakeTimer();
    const to = uniqueEmail("later");
    const fake = new FakeMailpit(timer)
      .deliver({ id: "other", to: [uniqueEmail("someone-else")], subject: "Verify" })
      .deliverAt(150, { id: "welcome", to: [to], subject: "Welcome" })
      .deliverAt(350, {
        id: "verify",
        to: [to],
        subject: "Verify your e-mail",
        html: '<a href="https://portal.example.com/verify?token=abc">Verify</a>',
      });
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch, timer });
    const message = await client.waitForMessage({ to, subject: /^Verify/ });
    expect(message.ID).toBe("verify");
    expect(extractLinks(message)).toEqual(["https://portal.example.com/verify?token=abc"]);
    expect(MAILPIT_POLL_INTERVAL_MS).toBe(100);
    expect(timer.sleeps).toEqual([100, 100, 100, 100]);
    expect(fake.searches).toHaveLength(5);
    // Only the recipient goes to Mailpit, so messages with another subject are seen too.
    expect(fake.searches.every((request) => request.url.searchParams.get("query") === `to:"${to}"`)).toBe(
      true,
    );
  });

  it("returns the newest message to the recipient when several match", async () => {
    const timer = fakeTimer();
    const to = uniqueEmail("twice");
    const fake = new FakeMailpit(timer).deliver(
      { id: "old", to: [to], subject: "Code 1" },
      { id: "new", to: [to], subject: "Code 2" },
    );
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch, timer });
    expect((await client.waitForMessage({ to })).ID).toBe("new");
    expect((await client.waitForMessage({ to, subject: "Code 1" })).ID).toBe("old");
    // A global RegExp keeps lastIndex between test() calls; the pattern matches on every check all the same.
    const pattern = /Code/g;
    expect((await client.waitForMessage({ to, subject: pattern })).ID).toBe("new");
    expect((await client.waitForMessage({ to, subject: pattern })).ID).toBe("new");
  });

  it("fails after the timeout with a readable message listing the messages it did see [X-025 AC2]", async () => {
    const timer = fakeTimer();
    const to = "signup+1@example.com";
    const fake = new FakeMailpit(timer)
      .deliver({ id: "w1", to: [to], subject: "Welcome to Velexis", text: "secret-token-in-body" })
      .deliverAt(120, { id: "r1", to: [to], subject: 'Reset your "password"' });
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch, timer });

    const error = await client
      .waitForMessage({ to, subject: /Verify/, timeoutMs: 250 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailpitTimeoutError);
    expect(error).toBeInstanceOf(MailpitError);
    expect((error as Error).message).toBe(
      [
        `waitForMessage: no message to ${to} with a subject matching /Verify/ arrived within 250 ms ` +
          `(Mailpit at ${API}, 4 checks).`,
        "Messages to that address it did see (2):",
        '  - "Welcome to Velexis", received 2026-10-14T06:37:57.896Z, ID w1',
        '  - "Reset your \\"password\\"", received 2026-10-14T06:37:57.896Z, ID r1',
      ].join("\n"),
    );
    expect((error as Error).message).not.toContain("secret-token-in-body");
    const timeout = error as MailpitTimeoutError;
    expect(timeout.seen.map((message) => message.ID)).toEqual(["w1", "r1"]);
    expect([timeout.to, timeout.subject, timeout.timeoutMs]).toEqual([to, /Verify/, 250]);
    // Every 100 ms, the last wait cut to the deadline; one last check at the deadline.
    expect(timer.sleeps).toEqual([100, 100, 50]);
    expect(timer.elapsed()).toBe(250);
    expect(fake.searches).toHaveLength(4);
  });

  it("waits 5 s by default for a recipient that never gets mail, and says it saw none [X-025 AC2]", async () => {
    const timer = fakeTimer();
    const to = uniqueEmail("nobody");
    const fake = new FakeMailpit(timer).deliver({ id: "x", to: ["someone@example.com"], subject: "Verify" });
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch, timer });
    await expect(client.waitForMessage({ to, subject: "Verify" })).rejects.toThrow(
      new MailpitTimeoutError({ to, subject: "Verify", timeoutMs: 5_000, checks: 51, apiUrl: API, seen: [] }),
    );
    expect(MAILPIT_DEFAULT_TIMEOUT_MS).toBe(5_000);
    expect(timer.elapsed()).toBe(5_000);
    expect(timer.sleeps).toHaveLength(50);
    expect(timer.sleeps.every((ms) => ms === 100)).toBe(true);
    expect(
      new MailpitTimeoutError({ to, subject: "Verify", timeoutMs: 5_000, checks: 51, apiUrl: API, seen: [] })
        .message,
    ).toBe(
      `waitForMessage: no message to ${to} with the subject "Verify" arrived within 5000 ms (Mailpit at ${API}, ` +
        "51 checks).\nMessages to that address it did see: none.",
    );
  });

  it("checks once with timeoutMs 0, and refuses a bad timeout or recipient", async () => {
    const timer = fakeTimer();
    const fake = new FakeMailpit(timer);
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch, timer });
    await expect(client.waitForMessage({ to: "a@example.com", timeoutMs: 0 })).rejects.toThrow(
      "waitForMessage: no message to a@example.com arrived within 0 ms (Mailpit at http://127.0.0.1:8025, 1 check).",
    );
    expect(fake.searches).toHaveLength(1);
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(client.waitForMessage({ to: "a@example.com", timeoutMs })).rejects.toThrow(RangeError);
    }
    await expect(client.waitForMessage({ to: "" })).rejects.toThrow(TypeError);
    await expect(client.waitForMessage({} as { to: string })).rejects.toThrow(TypeError);
    expect(fake.searches).toHaveLength(1);
  });

  it("waits in real time even when the test uses fake timers", async () => {
    vi.useFakeTimers();
    const fake = new FakeMailpit();
    const client = createMailpitClient({ apiUrl: API, fetch: fake.fetch });
    // With the faked setTimeout this would never settle: the module keeps the real one.
    await expect(client.waitForMessage({ to: uniqueEmail("fake-timers"), timeoutMs: 30 })).rejects.toThrow(
      MailpitTimeoutError,
    );
    expect(fake.searches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("the @velexis/testing/mailpit subpath", () => {
  it("is exported from dist/mailpit.js, which tsc builds from src/mailpit.ts", () => {
    const packageDir = join(__dirname, "..");
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports["./mailpit"]).toEqual({
      types: "./dist/mailpit.d.ts",
      default: "./dist/mailpit.js",
    });
    const tsconfig = JSON.parse(readFileSync(join(packageDir, "tsconfig.json"), "utf8")) as {
      compilerOptions: { rootDir: string; outDir: string };
    };
    expect(tsconfig.compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist" });
    expect(Object.keys(mailpitModule)).toEqual(
      expect.arrayContaining([
        "mailpit",
        "waitForMessage",
        "uniqueEmail",
        "extractLinks",
        "createMailpitClient",
      ]),
    );
    expect(Object.keys(mailpitModule.mailpit).sort()).toEqual([
      "apiUrl",
      "clear",
      "get",
      "search",
      "waitForMessage",
    ]);
  });
});
