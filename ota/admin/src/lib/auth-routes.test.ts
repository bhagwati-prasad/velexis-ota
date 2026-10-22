import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  authPageHtml,
  authPageResponse,
  escapeHtml,
  mediaTypeOf,
  originMatches,
  readCappedText,
} from "./auth-routes";

describe("originMatches", () => {
  it("accepts exactly the origin of the allowed URL and nothing else", () => {
    const allowed = "https://platform.example.com/";
    const origin = (value?: string) => new Headers(value === undefined ? {} : { Origin: value });

    expect(originMatches(origin("https://platform.example.com"), allowed)).toBe(true);
    for (const value of [
      undefined,
      "null",
      "",
      "http://platform.example.com",
      "https://platform.example.com:8443",
      "https://platform.example.com.evil.example",
      "https://evil.example",
      "https://platform.example.com/",
    ]) {
      expect(originMatches(origin(value), allowed), String(value)).toBe(false);
    }
  });
});

describe("mediaTypeOf", () => {
  it("reads the media type without its parameters, in lower case", () => {
    expect(
      mediaTypeOf(new Headers({ "Content-Type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" })),
    ).toBe("application/x-www-form-urlencoded");
    expect(mediaTypeOf(new Headers())).toBe("");
  });
});

describe("readCappedText", () => {
  /** A chunked request body of `chunks`, with no Content-Length, that records whether it was cancelled. */
  function streamed(chunks: string[]): { request: Request; cancelled: () => boolean } {
    let cancelled = false;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
        } else {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/x", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    return { request, cancelled: () => cancelled };
  }

  it("reads a body within the limit, chunk by chunk", async () => {
    const { request } = streamed(["portal", "Token=", "ptk_ä"]);

    expect(await readCappedText(request, 64)).toBe("portalToken=ptk_ä");
  });

  it("stops and cancels the stream as soon as the body passes the limit", async () => {
    const { request, cancelled } = streamed(["x".repeat(600), "x".repeat(600), "x".repeat(600)]);

    expect(await readCappedText(request, 1024)).toBeUndefined();
    expect(cancelled()).toBe(true);
  });

  it("refuses a declared Content-Length over the limit without reading", async () => {
    const request = new Request("http://localhost/x", {
      method: "POST",
      body: "short",
      headers: { "Content-Length": "4096" },
    });

    expect(await readCappedText(request, 1024)).toBeUndefined();
    expect(request.bodyUsed).toBe(false);
  });
});

describe("the page", () => {
  it("escapes every text and has no script, form or external resource", async () => {
    const html = authPageHtml({
      status: 400,
      title: "<Title>",
      message: `Say "hi" & 'bye'`,
      requestId: "req_<1>",
      links: [{ href: 'https://example.com/?a=1&b="2"', label: "<Back>" }],
    });

    expect(html).toContain("<h1>&lt;Title&gt;</h1>");
    expect(html).toContain("<p>Say &quot;hi&quot; &amp; &#39;bye&#39;</p>");
    expect(html).toContain("<code>req_&lt;1&gt;</code>");
    expect(html).toContain('<a href="https://example.com/?a=1&amp;b=&quot;2&quot;">&lt;Back&gt;</a>');
    expect(html).not.toMatch(/<script|<form|<link|<img|src=/);
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");

    const response = authPageResponse({ status: 503, title: "t", message: "m", links: [] });
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain('<p class="request-id">');
  });
});

describe("module boundaries", () => {
  it.each(["./auth-routes.ts", "../middleware.ts"])("%s is a server-only module", (file) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

    expect(source).toMatch(/^import "server-only";$/m);
  });
});
