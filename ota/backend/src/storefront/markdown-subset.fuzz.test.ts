// Fuzz test of the Markdown subset parser (OBE-072 AC1; OADR-0012 point 5: "a small in-house Markdown parser must be
// maintained and fuzz-tested"). 1 000 inputs from a seeded generator (the same inputs on every run): fragments of the
// subset and of what it refuses glued at random, mutations of a valid page, and random code points (control
// characters and lone surrogates included). Each input is either refused with a MarkdownSubsetError naming one of its
// lines, or parsed into blocks that storefront.getPage's response schema accepts (StorefrontPageContent, the images
// given an edge URL). Nothing else may happen: no other error, no hang. Adversarial inputs of the largest body size
// (50 000 characters) end the same way.
import { responseChecker, type ResponseChecker } from "@velexis/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MarkdownSubsetError,
  parseMarkdownSubset,
  type ParsedPage,
  type ParsedPageBlock,
} from "./markdown-subset.parser";

const SEED = 0x0b_e0_72;
const INPUTS = 1_000;
/** The largest body (StorefrontPageMarkdown, `storefront_pages.body_markdown`). */
const MAX_BODY = 50_000;

const ASSET = "ast_01JA7P4R6T8V0X2Z4B6D8F0H2K";

/** mulberry32: a small seeded generator, so every run tests the same inputs. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Pieces of the subset, of what it refuses, and of the edges between. */
const FRAGMENTS = [
  "\n",
  "\n\n",
  "\r\n",
  " ",
  "  ",
  "    ",
  "\t",
  "word",
  "Ünïcødé",
  "日本語",
  "😀",
  "## ",
  "### ",
  "#### ",
  "# ",
  "##### ",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "2) ",
  "10. ",
  "**",
  "__",
  "*",
  "_",
  "***",
  "[",
  "]",
  "(",
  ")",
  "](",
  "[text](https://example.com/a)",
  "[mail](mailto:help@example.com)",
  "[page](/p/terms)",
  "[bad](javascript:alert(1))",
  "](http://x)",
  "![",
  `![alt](${ASSET})`,
  "![alt](https://x/y.png)",
  "\\",
  "\\*",
  "\\[",
  "<",
  "<script>",
  "</p>",
  "<!--",
  "&amp;",
  "`",
  "```",
  "~~~",
  ">",
  "|",
  "| a | b |",
  "---",
  "--|--",
  "===",
  "[ref]: https://example.com/",
  "[a][b]",
  "\u0000",
  "\u001b",
  " ",
  " ",
  "\ud800",
  "!",
  ":",
  "#",
] as const;

const SAMPLE = [
  "## Who we are",
  "",
  "Acme Travel sells **flights** as an agent of the airlines. Write to [us](mailto:help@acmetravel.com).",
  "",
  "- Tickets are issued *after* payment.",
  "- Read our [privacy policy](/p/privacy).",
  "",
  "1. Open your booking.",
  "2. Choose __Cancel__.",
  "",
  `![Our team](${ASSET})`,
].join("\n");

/** A random input of one of the three kinds (see the file header). */
function randomInput(random: () => number): string {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  const kind = random();
  if (kind < 0.45) {
    let body = "";
    const pieces = Math.floor(random() * 80);
    for (let index = 0; index < pieces; index += 1) {
      body += pick(FRAGMENTS);
    }
    return body;
  }
  if (kind < 0.85) {
    let body = SAMPLE;
    const mutations = 1 + Math.floor(random() * 4);
    for (let index = 0; index < mutations; index += 1) {
      const at = Math.floor(random() * (body.length + 1));
      const cut = random() < 0.3 ? Math.floor(random() * 8) : 0;
      body = body.slice(0, at) + pick(FRAGMENTS) + body.slice(at + cut);
    }
    return body;
  }
  let body = "";
  const length = Math.floor(random() * 200);
  for (let index = 0; index < length; index += 1) {
    const code = random() < 0.7 ? 0x20 + Math.floor(random() * 0x5f) : Math.floor(random() * 0x10000);
    body += String.fromCharCode(code);
  }
  return body;
}

/** The answer storefront.getPage would give for the parsed blocks (images with an edge URL). */
function pageContent(page: ParsedPage): unknown {
  const blocks = page.blocks.map((block: ParsedPageBlock) =>
    block.type === "image"
      ? { ...block, url: `/api/v1/assets/acme/${block.assetId}.png`, width: null, height: null }
      : block,
  );
  return {
    slug: "terms",
    locale: "en",
    title: "Terms",
    kind: "terms",
    blocks,
    updatedAt: "2026-10-30T12:00:00.000Z",
  };
}

/** What happened to an input: refused at a line it has, or accepted with schema problems (none expected). */
function outcomeOf(
  checker: ResponseChecker,
  body: string,
): { readonly refusedAt: number } | { readonly problems: readonly unknown[] } {
  let page: ParsedPage;
  try {
    page = parseMarkdownSubset(body);
  } catch (error) {
    if (!(error instanceof MarkdownSubsetError)) {
      throw error;
    }
    const lines = body.split(/\r\n?|\n/).length;
    expect(Number.isInteger(error.line) && error.line >= 1 && error.line <= lines).toBe(true);
    expect(error.message.startsWith(`Line ${error.line} `)).toBe(true);
    return { refusedAt: error.line };
  }
  expect(page.images.map((image) => image.assetId)).toEqual(
    page.blocks.flatMap((block) => (block.type === "image" ? [block.assetId] : [])),
  );
  return { problems: checker.check("getStorefrontPage", { status: 200, body: pageContent(page) }) };
}

let checker: ResponseChecker;

// Parsing the OTA document and compiling getStorefrontPage's response schema take about a second alone, several times
// that while every package's tests run at once on a 4-CPU runner: paid once here, with a budget that only stops a hang.
beforeAll(() => {
  checker = responseChecker("ota");
  expect(
    checker.check("getStorefrontPage", { status: 200, body: pageContent(parseMarkdownSubset(SAMPLE)) }),
  ).toEqual([]);
}, 60_000);

describe("parseMarkdownSubset under random input", () => {
  it("[OBE-072 AC1] never throws an unhandled error on 1 000 random inputs: each is refused with its line or parsed into schema-valid blocks", () => {
    const random = generator(SEED);
    let refused = 0;
    let accepted = 0;
    for (let index = 0; index < INPUTS; index += 1) {
      const body = randomInput(random);
      const outcome = outcomeOf(checker, body);
      if ("refusedAt" in outcome) {
        refused += 1;
      } else {
        expect([index, outcome.problems]).toEqual([index, []]);
        accepted += 1;
      }
    }
    expect(refused + accepted).toBe(INPUTS);
    // The generator reaches both outcomes often (the same counts on every run: the inputs are seeded).
    expect(refused).toBeGreaterThan(100);
    expect(accepted).toBeGreaterThan(100);
  });

  it("[OBE-072 AC1] ends adversarial bodies of 50 000 characters the same way", () => {
    const fill = (piece: string): string =>
      piece.repeat(Math.ceil(MAX_BODY / piece.length)).slice(0, MAX_BODY);
    // The last six took about 11 seconds together, far beyond this test's default budget, while the parser had steps
    // that were quadratic in the body: a regular expression for a heading's closing `#` that retried its run of
    // spaces at every position (seconds per heading), and per link a walk over every bracket and delimiter before it
    // (hundreds of milliseconds per body). Linear, they take milliseconds; no wall-clock bound is asserted, the
    // budget alone catches a regression.
    const half = MAX_BODY / 2;
    const bodies = [
      fill("*a "),
      fill("_a "),
      fill("**"),
      fill("*"),
      fill("["),
      fill("]("),
      fill("[a]("),
      fill("[x](https://e.x/"),
      fill("\\"),
      fill("a\n"),
      fill("- a\n"),
      fill("1. a\n"),
      fill("*a [b "),
      fill("x*y_"),
      `${"*a ".repeat(8)}b${" c*".repeat(8)}\n\n${fill("text ").slice(0, MAX_BODY - 100)}`,
      `## a${" ".repeat(MAX_BODY - 6)}b`,
      `## a${"\t".repeat(MAX_BODY - 6)}b`,
      `### a${" ".repeat(MAX_BODY - 9)}b #`,
      `#### a${" \t".repeat(half - 5)}b`,
      `${"[".repeat(half)}${"[a](https://e.x/) ".repeat(Math.floor(half / 18))}`,
      `${"*a ".repeat(Math.floor(half / 3))}${"[a](/p/terms)".repeat(Math.floor(half / 13))}`,
    ];
    for (const body of bodies) {
      expect(body.length).toBeLessThanOrEqual(MAX_BODY);
      const outcome = outcomeOf(checker, body);
      if (!("refusedAt" in outcome)) {
        expect(outcome.problems).toEqual([]);
      }
    }
  });
});
