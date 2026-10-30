// Unit tests of the Markdown subset of the content pages (OBE-072; OADR-0012 point 5, the OTA document's
// StorefrontPageMarkdown): what it parses into blocks and inline nodes, and what it refuses with the line it starts on.
import { describe, expect, it } from "vitest";
import {
  allowedHref,
  MarkdownSubsetError,
  MAX_ALT_LENGTH,
  MAX_HREF_LENGTH,
  MAX_INLINE_DEPTH,
  parseMarkdownSubset,
  type ParsedPage,
} from "./markdown-subset.parser";

const ASSET = "ast_01JA7P4R6T8V0X2Z4B6D8F0H2K";
const OTHER_ASSET = "ast_01JA7P5S7U9W1Y3A5C7E9G1J3M";

const text = (value: string) => ({ type: "text", text: value });

/** The `[line, message]` of the refusal of `body`; fails when the body is accepted or another error is thrown. */
function refusal(body: string): [number, string] {
  try {
    parseMarkdownSubset(body);
  } catch (error) {
    if (error instanceof MarkdownSubsetError) {
      expect(error.reason).toBe("markdown_not_allowed");
      return [error.line, error.message];
    }
    throw error;
  }
  throw new Error("the body was accepted");
}

/** The blocks of `body`. */
const blocksOf = (body: string): ParsedPage["blocks"] => parseMarkdownSubset(body).blocks;

describe("parseMarkdownSubset: the subset", () => {
  it("parses the document's example terms page into its blocks", () => {
    const body = [
      "## Who we are",
      "",
      "Acme Travel Ltd sells flights as an agent of the airlines. Questions? Write to [help@acmetravel.com](mailto:help@acmetravel.com).",
      "",
      "## Tickets",
      "",
      "- **Tickets** are issued after payment.",
      "- Read our [privacy policy](/p/privacy) and the airline's *conditions of carriage*.",
      "",
      "## Cancellations",
      "",
      "1. Open your booking.",
      "2. Choose *Cancel*.",
      "",
      `![Our team at the office](${ASSET})`,
    ].join("\n");

    expect(parseMarkdownSubset(body)).toEqual({
      blocks: [
        { type: "heading", level: 2, content: [text("Who we are")] },
        {
          type: "paragraph",
          content: [
            text("Acme Travel Ltd sells flights as an agent of the airlines. Questions? Write to "),
            { type: "link", href: "mailto:help@acmetravel.com", content: [text("help@acmetravel.com")] },
            text("."),
          ],
        },
        { type: "heading", level: 2, content: [text("Tickets")] },
        {
          type: "list",
          ordered: false,
          start: null,
          items: [
            { content: [{ type: "strong", content: [text("Tickets")] }, text(" are issued after payment.")] },
            {
              content: [
                text("Read our "),
                { type: "link", href: "/p/privacy", content: [text("privacy policy")] },
                text(" and the airline's "),
                { type: "em", content: [text("conditions of carriage")] },
                text("."),
              ],
            },
          ],
        },
        { type: "heading", level: 2, content: [text("Cancellations")] },
        {
          type: "list",
          ordered: true,
          start: 1,
          items: [
            { content: [text("Open your booking.")] },
            { content: [text("Choose "), { type: "em", content: [text("Cancel")] }, text(".")] },
          ],
        },
        { type: "image", assetId: ASSET, alt: "Our team at the office" },
      ],
      images: [{ assetId: ASSET, line: 15 }],
    });
  });

  it("answers no block for an empty body or one of blank lines", () => {
    expect(parseMarkdownSubset("")).toEqual({ blocks: [], images: [] });
    expect(parseMarkdownSubset("\n  \n\t\n")).toEqual({ blocks: [], images: [] });
  });

  it("reads headings of levels 2 to 4, without a closing run of #", () => {
    expect(blocksOf("## Two\n### Three ###\n#### Four #\n## C#")).toEqual([
      { type: "heading", level: 2, content: [text("Two")] },
      { type: "heading", level: 3, content: [text("Three")] },
      { type: "heading", level: 4, content: [text("Four")] },
      { type: "heading", level: 2, content: [text("C#")] },
    ]);
    // A closing run after tabs too; a `#` after anything else, or escaped, is the heading's text.
    expect(blocksOf("## Tabs\t##\t\n### a#b #\n#### Escaped \\#\n## C# and F#  ")).toEqual([
      { type: "heading", level: 2, content: [text("Tabs")] },
      { type: "heading", level: 3, content: [text("a#b")] },
      { type: "heading", level: 4, content: [text("Escaped #")] },
      { type: "heading", level: 2, content: [text("C# and F#")] },
    ]);
    // Without a space after the hashes it is text.
    expect(blocksOf("#hashtag and #5")).toEqual([{ type: "paragraph", content: [text("#hashtag and #5")] }]);
  });

  it("joins the lines of a paragraph with one space, whatever line endings and indentation they have", () => {
    expect(blocksOf("  First line  \r\n    second line\rthird\n\nNext paragraph")).toEqual([
      { type: "paragraph", content: [text("First line second line third")] },
      { type: "paragraph", content: [text("Next paragraph")] },
    ]);
  });

  it("reads bullet and numbered lists one level deep, items continued on their next lines", () => {
    expect(blocksOf("* one\n* two\n  continued\nlazy too\n\n* three\n\n3. three\n4. four")).toEqual([
      {
        type: "list",
        ordered: false,
        start: null,
        items: [
          { content: [text("one")] },
          { content: [text("two continued lazy too")] },
          { content: [text("three")] },
        ],
      },
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [{ content: [text("three")] }, { content: [text("four")] }],
      },
    ]);
    // Another marker starts another list; a heading or an image ends one.
    expect(blocksOf(`- a\n* b\n1. c\n## After\n- d\n![x](${ASSET})`).map((block) => block.type)).toEqual([
      "list",
      "list",
      "list",
      "heading",
      "list",
      "image",
    ]);
  });

  it("lets a bullet list or a list starting at 1 interrupt a paragraph, and keeps other numbers as text", () => {
    expect(blocksOf("Steps:\n1. Pay\n\nIn the year\n2024. we grew")).toEqual([
      { type: "paragraph", content: [text("Steps:")] },
      { type: "list", ordered: true, start: 1, items: [{ content: [text("Pay")] }] },
      { type: "paragraph", content: [text("In the year 2024. we grew")] },
    ]);
  });

  it("reads bold and italic with both characters, nested, and leaves intraword underscores and lone stars as text", () => {
    expect(blocksOf("**a** __b__ *c* _d_ ***e*** **f *g* h**")).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "strong", content: [text("a")] },
          text(" "),
          { type: "strong", content: [text("b")] },
          text(" "),
          { type: "em", content: [text("c")] },
          text(" "),
          { type: "em", content: [text("d")] },
          text(" "),
          { type: "em", content: [{ type: "strong", content: [text("e")] }] },
          text(" "),
          { type: "strong", content: [text("f "), { type: "em", content: [text("g")] }, text(" h")] },
        ],
      },
    ]);
    expect(blocksOf("snake_case_name, 5 * 3 = 15, **unclosed and _also")).toEqual([
      { type: "paragraph", content: [text("snake_case_name, 5 * 3 = 15, **unclosed and _also")] },
    ]);
  });

  it("reads links with emphasis inside and around, and keeps brackets without an address as text", () => {
    expect(blocksOf("*see [the **terms**](/p/terms)* and [sic] or [x] (y)")).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "em",
            content: [
              text("see "),
              {
                type: "link",
                href: "/p/terms",
                content: [text("the "), { type: "strong", content: [text("terms")] }],
              },
            ],
          },
          text(" and [sic] or [x] (y)"),
        ],
      },
    ]);
    // A link never holds another one: the inner link wins and the outer brackets are text.
    expect(blocksOf("[a [b](https://b.example/) c](https://a.example/)")).toEqual([
      {
        type: "paragraph",
        content: [
          text("[a "),
          { type: "link", href: "https://b.example/", content: [text("b")] },
          text(" c](https://a.example/)"),
        ],
      },
    ]);
  });

  it("accepts https:, mailto:, tel: and /p/<slug> addresses, answering the scheme in lower case, with escapes and parentheses", () => {
    expect(
      blocksOf(
        "[w](HTTPS://Example.com/a_(b)) [m](Mailto:help@example.com) [t](tel:+442071234567) [p](/p/baggage-faq) [e](https://example.com/\\))",
      ),
    ).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "link", href: "https://Example.com/a_(b)", content: [text("w")] },
          text(" "),
          { type: "link", href: "mailto:help@example.com", content: [text("m")] },
          text(" "),
          { type: "link", href: "tel:+442071234567", content: [text("t")] },
          text(" "),
          { type: "link", href: "/p/baggage-faq", content: [text("p")] },
          text(" "),
          { type: "link", href: "https://example.com/)", content: [text("e")] },
        ],
      },
    ]);
    expect(allowedHref(`https://example.com/${"a".repeat(MAX_HREF_LENGTH - 20)}`)).toBeDefined();
    for (const href of [
      "http://example.com/",
      "javascript:alert(1)",
      "data:text/html,x",
      "/checkout",
      "//evil.example",
      "ftp://x",
      "https:",
      "/p/Terms",
      "",
    ]) {
      expect([href, allowedHref(href)]).toEqual([href, undefined]);
    }
  });

  it("removes backslash escapes, so escaped Markdown and HTML characters are text", () => {
    expect(blocksOf("\\*not italic\\* \\[not a link\\](x) \\<b> \\` C:\\path \\# 100\\%")).toEqual([
      { type: "paragraph", content: [text("*not italic* [not a link](x) <b> ` C:\\path # 100%")] },
    ]);
    // Entities are not decoded.
    expect(blocksOf("R&amp;D &#106;")).toEqual([{ type: "paragraph", content: [text("R&amp;D &#106;")] }]);
  });

  it("reads an image alone on its line with escapes in its alt text, an empty alt text, and lists its images", () => {
    const page = parseMarkdownSubset(`Intro\n![Team \\[2024\\]](${ASSET})\n\n![](${OTHER_ASSET})`);

    expect(page.blocks).toEqual([
      { type: "paragraph", content: [text("Intro")] },
      { type: "image", assetId: ASSET, alt: "Team [2024]" },
      { type: "image", assetId: OTHER_ASSET, alt: "" },
    ]);
    expect(page.images).toEqual([
      { assetId: ASSET, line: 2 },
      { assetId: OTHER_ASSET, line: 4 },
    ]);
    expect(blocksOf(`![${"a".repeat(MAX_ALT_LENGTH)}](${ASSET})`)).toHaveLength(1);
  });

  it(`nests bold, italic and links up to ${MAX_INLINE_DEPTH} levels`, () => {
    const nested = (depth: number): string => `${"*a ".repeat(depth)}b${" c*".repeat(depth)}`;

    expect(blocksOf(nested(MAX_INLINE_DEPTH))).toHaveLength(1);
    expect(refusal(`\n${nested(MAX_INLINE_DEPTH + 1)}`)).toEqual([
      2,
      `Line 2 nests bold, italic and links more than ${MAX_INLINE_DEPTH} levels deep.`,
    ]);
  });
});

describe("parseMarkdownSubset: refusals, with the line they start on", () => {
  it("refuses <script>, raw HTML, comments and autolinks with the line number [OBE-072 AC1]", () => {
    expect(refusal("## Hello\n\nSome text\n<script>alert(1)</script>")).toEqual([
      4,
      "Line 4 uses HTML, which content pages do not allow.",
    ]);
    for (const [body, line] of [
      ["Text with <b>bold</b>", 1],
      ["One\ntwo <img src=x onerror=alert(1)>", 2],
      ["One\n\n</p>", 3],
      ["<!-- comment -->", 1],
      ["Visit <https://example.com>", 1],
      ["- item <?php ?>", 1],
      ["## Title <span>", 1],
      [`![<svg onload=alert(1)>](${ASSET})`, 1],
    ] as const) {
      expect([body, refusal(body)]).toEqual([
        body,
        [line, `Line ${line} uses HTML, which content pages do not allow.`],
      ]);
    }
    // A < before anything else is text.
    expect(blocksOf("1 < 2 and a <= b")).toEqual([
      { type: "paragraph", content: [text("1 < 2 and a <= b")] },
    ]);
  });

  it("refuses tables with the line of their first row [OBE-072 AC1]", () => {
    expect(refusal("Intro\n\n| Fare | Bags |\n|------|------|\n| Light | 0 |")[0]).toBe(3);
    expect(refusal("Intro\n\nFare | Bags\n--- | ---\nLight | 0")).toEqual([
      3,
      "Line 3 starts a table, which content pages do not allow.",
    ]);
    expect(refusal("Text\n:--|--:")[0]).toBe(2);
    expect(refusal("- item\n| a |")[0]).toBe(2);
    // Under a list item's line too.
    expect(refusal("Intro\n\n- Fare | Bags\n--- | ---")).toEqual([
      3,
      "Line 3 starts a table, which content pages do not allow.",
    ]);
    expect(refusal("- item\n\n--|--")[0]).toBe(3);
  });

  it("refuses javascript:, data:, http: and other links with the line number [OBE-072 AC1]", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<x",
      "http://example.com/",
      "/checkout",
      "../p/terms",
      "ftp://example.com/",
      "&#106;avascript:alert(1)",
      "",
    ]) {
      expect([href, refusal(`## Links\n\nOne\n[click](${href.replace("<", "%3C")})`)]).toEqual([
        href,
        [4, "Line 4 links to an address content pages do not allow: use https:, mailto:, tel: or /p/<slug>."],
      ]);
    }
    expect(refusal(`[long](https://example.com/${"a".repeat(MAX_HREF_LENGTH)})`)).toEqual([
      1,
      `Line 1 has a link address longer than ${MAX_HREF_LENGTH} characters.`,
    ]);
  });

  it("refuses code, quotes, rules and headings outside levels 2 to 4", () => {
    for (const [body, line, what] of [
      ["Use `code`", 1, "uses code (a backtick)"],
      ["Intro\n\n```\nx\n```", 3, "uses code (a backtick)"],
      ["~~~\nx\n~~~", 1, "starts a code block"],
      ["Intro\n\n    indented code", 3, "is indented by four spaces or a tab"],
      ["\tcode", 1, "is indented by four spaces or a tab"],
      ["> quoted", 1, "is a block quote"],
      ["Text\n> quoted", 2, "is a block quote"],
      ["Text\n\n---", 3, "is a horizontal rule"],
      ["* * *", 1, "is a horizontal rule"],
      ["# Title", 1, "is a heading of level 1"],
      ["##### Five", 1, "is a heading of level 5"],
      ["###### Six", 1, "is a heading of level 6"],
      ["Title\n=====", 2, "underlines a heading"],
      ["Title\n---", 2, "underlines a heading"],
      ["##", 1, "is an empty heading"],
      ["## ##", 1, "is an empty heading"],
    ] as const) {
      const [atLine, message] = refusal(body);
      expect([body, atLine, message.startsWith(`Line ${line} ${what}`)]).toEqual([body, line, true]);
    }
  });

  it("refuses nested lists, indented text under a list, empty items and the + and ) markers", () => {
    for (const [body, line, what] of [
      ["- one\n  - nested", 2, "nests a list"],
      ["- one\n\n    - nested", 3, "nests a list"],
      ["- - nested", 1, "nests a list"],
      ["1. 2. nested", 1, "nests a list"],
      ["- one\n\n  second paragraph", 3, "is indented under a list"],
      ["- ", 1, "is an empty list item"],
      ["Text\n\n1.", 3, "is an empty list item"],
      ["+ plus", 1, "starts a list with +"],
      ["1) one", 1, "numbers a list item with )"],
      ["- ## heading", 1, "puts a heading, quote or code in a list item"],
      ["- > quote", 1, "puts a heading, quote or code in a list item"],
    ] as const) {
      const [atLine, message] = refusal(body);
      expect([body, atLine, message.startsWith(`Line ${line} ${what}`)]).toEqual([body, line, true]);
    }
  });

  it("refuses images inside text, images of anything but an asset, titles and too long alt texts", () => {
    for (const [body, line, what] of [
      [`Text ![x](${ASSET}) more`, 1, "has an image inside text"],
      [`- ![x](${ASSET})`, 1, "has an image inside text"],
      [`![x](${ASSET}) more`, 1, "has an image that is not ![alt text](ast_…) alone on its line"],
      ["![x](https://example.com/x.png)", 1, "has an image that names no uploaded page image"],
      [`![x](${ASSET} "title")`, 1, "has an image that names no uploaded page image"],
      ["![x]", 1, "has an image that is not"],
      [`![a [b]](${ASSET})`, 1, "has a [ in an image's alt text"],
      [`![${"a".repeat(MAX_ALT_LENGTH + 1)}](${ASSET})`, 1, `has an image with more than ${MAX_ALT_LENGTH}`],
    ] as const) {
      const [atLine, message] = refusal(body);
      expect([body, atLine, message.startsWith(`Line ${line} ${what}`)]).toEqual([body, line, true]);
    }
  });

  it("refuses reference links, link titles, links without text or a closing parenthesis, and control characters", () => {
    for (const [body, line, what] of [
      ["See [terms][1]", 1, "uses a reference link"],
      ["[1]: https://example.com/", 1, "defines a reference link"],
      ['[x](https://example.com/ "title")', 1, "has a link address with a space or a title"],
      ["[](https://example.com/)", 1, "has a link without text"],
      ["[ ](https://example.com/)", 1, "has a link without text"],
      ["One\n[x](https://example.com/", 2, "has a link that is not closed"],
      ["One\nnull\u0000byte", 2, "holds a control character"],
      ["escape\u001b[31m", 1, "holds a control character"],
    ] as const) {
      const [atLine, message] = refusal(body);
      expect([body, atLine, message.startsWith(`Line ${line} ${what}`)]).toEqual([body, line, true]);
    }
  });

  it("names the line a link starts on inside a paragraph of several lines", () => {
    expect(refusal("One\ntwo [x](javascript:void(0))\nthree")[0]).toBe(2);
    expect(refusal("One\ntwo\nthree [x](http://example.com/)")[0]).toBe(3);
  });

  it("never quotes the body in its messages", () => {
    const [, message] = refusal("Secret-ish words <script>steal()</script>");

    expect(message).not.toContain("steal");
    expect(message).not.toContain("Secret");
  });
});
