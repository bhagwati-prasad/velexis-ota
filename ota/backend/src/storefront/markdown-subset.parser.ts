// The Markdown subset of the content pages (OBE-072; OADR-0012 point 5, api-changes part 2 §2.4 and §4.1, the OTA
// document's StorefrontPageMarkdown): the one small parser of the backend, which checks a page body when staff save it
// (console.settings.pages.create and update, settings/pages.service.ts) and turns it into the block tree that
// storefront.getPage serves (public-pages.service.ts). It never emits HTML, and no Markdown library is used: the
// storefront renders the tree with `createElement` and `textContent` (conventions §4).
//
// The subset (StorefrontPageMarkdown):
//
//   blocks    separated by blank lines: headings `##`, `###`, `####` (levels 2 to 4; an optional closing run of `#` is
//             dropped); paragraphs, whose lines are joined with one space; bullet lists (`- ` or `* `) and numbered
//             lists (`1. `, the first number is the list's `start`), one level deep, an item's following lines (not
//             indented as a list of their own) continuing its text, and items separated by blank lines staying one
//             list; an image alone on its line, `![alt text](ast_…)`, with at most 300 characters of alt text, naming
//             an uploaded asset (that it is a `page_image` of the OTA is the services' check, with `images`). Up to
//             three spaces of indentation are dropped.
//   inline    in headings, paragraphs and list items: `**bold**`, `__bold__`, `*italic*`, `_italic_` (CommonMark's
//             delimiter runs and their flanking rules, so `snake_case` stays text) and links `[text](href)` with an
//             `https:`, `mailto:` or `tel:` URL of at most 2048 characters (the scheme in any case, answered in lower
//             case) or a relative `/p/<slug>`; a backslash escapes an ASCII punctuation character. Unmatched
//             delimiters and brackets stay text, a link never holds another link, and bold, italic and links nest at
//             most 8 deep.
//
// Everything else throws a MarkdownSubsetError with the 1-based line it starts on (`422 UNPROCESSABLE`,
// `details.reason = "markdown_not_allowed"` and `details.line` for the services): HTML (a `<` before a letter, `/`, `!`
// or `?`, which also covers comments and autolinks), code (a backtick, a `~~~` fence, a line indented by four spaces
// or a tab), block quotes, horizontal rules, tables (a line that starts with `|`, a delimiter row such as `--|--`;
// the table's first line is named), headings of level 1, 5 or 6, setext headings (`===` or `---` under text), empty
// headings and list items, `+ ` and `1) ` lists, nested lists and indented text under a list, images inside text or
// with another target, reference links (`[text][ref]`, `[ref]: url`), link titles, links without text, a longer alt
// text or URL, other URLs (`http:`, `javascript:`, `data:`, other relative paths) and control characters. Entities
// such as `&amp;` are not decoded: they stay text.
//
// The parser is linear in the body (the emphasis step is CommonMark's "process emphasis" with its openers' bottoms,
// the tree is converted without recursion), so the 50 000 characters a body may have never make it slow, and it
// throws nothing but MarkdownSubsetError (markdown-subset.fuzz.test.ts). Its messages never quote the body.
import type { components } from "@velexis/api-types";

type Schemas = components["schemas"];
export type StorefrontPageInline = Schemas["StorefrontPageInline"];
export type StorefrontPageHeadingBlock = Schemas["StorefrontPageHeadingBlock"];
export type StorefrontPageParagraphBlock = Schemas["StorefrontPageParagraphBlock"];
export type StorefrontPageListBlock = Schemas["StorefrontPageListBlock"];

/** An image block as the parser reads it: the asset and its alt text; the services add the URL and dimensions. */
export interface ParsedImageBlock {
  readonly type: "image";
  readonly assetId: string;
  readonly alt: string;
}

/** A block of a parsed body. */
export type ParsedPageBlock =
  StorefrontPageHeadingBlock | StorefrontPageParagraphBlock | StorefrontPageListBlock | ParsedImageBlock;

/** An image of a parsed body and the line it is on (the services check the asset: `asset_not_found`, `asset_kind`). */
export interface ParsedImage {
  readonly assetId: string;
  readonly line: number;
}

/** A parsed body: its blocks in order, and its images in order. */
export interface ParsedPage {
  readonly blocks: ParsedPageBlock[];
  readonly images: ParsedImage[];
}

/** The longest alt text of an image (StorefrontPageImageBlock.alt). */
export const MAX_ALT_LENGTH = 300;
/** The longest link address (StorefrontPageLink.href). */
export const MAX_HREF_LENGTH = 2048;
/** How deep bold, italic and links may nest. */
export const MAX_INLINE_DEPTH = 8;

/** A body that leaves the subset: the line it does so on (1-based) and a message that never quotes the body. */
export class MarkdownSubsetError extends Error {
  override readonly name = "MarkdownSubsetError";
  readonly reason = "markdown_not_allowed";

  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (line: number, what: string): MarkdownSubsetError =>
  new MarkdownSubsetError(line, `Line ${line} ${what}`);

// ---- Characters ------------------------------------------------------------------------------------------------

const ASCII_PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

const isAsciiPunctuation = (char: string | undefined): boolean =>
  char !== undefined && ASCII_PUNCTUATION.has(char);

/** Unicode white space as CommonMark's flanking rules read it (the start and end of the text count as white space). */
const isWhitespace = (char: string | undefined): boolean => char === undefined || /\s/u.test(char);

/** Unicode punctuation and symbols as CommonMark 0.31 reads them. */
const isPunctuation = (char: string | undefined): boolean =>
  char !== undefined && (ASCII_PUNCTUATION.has(char) || /[\p{P}\p{S}]/u.test(char));

/** Control characters other than the tab (C0, DEL, C1). */
// eslint-disable-next-line no-control-regex -- the control characters are what is refused
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/** A tag, comment, declaration or processing instruction starts here: `<` before a letter, `/`, `!` or `?`. */
const HTML_START = /[A-Za-z/!?]/;

/**
 * The checks of every line, before its block is read: control characters, then (outside backslash escapes) code
 * spans or fences with backticks, and HTML.
 */
function checkLine(text: string, line: number): void {
  if (CONTROL.test(text)) {
    throw refuse(line, "holds a control character, which content pages do not allow.");
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && isAsciiPunctuation(text[index + 1])) {
      index += 1;
    } else if (char === "`") {
      throw refuse(line, "uses code (a backtick), which content pages do not allow.");
    } else if (char === "<" && HTML_START.test(text[index + 1] ?? "")) {
      throw refuse(line, "uses HTML, which content pages do not allow.");
    }
  }
}

// ---- Links -----------------------------------------------------------------------------------------------------

const PAGE_LINK = /^\/p\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const ALLOWED_URL = /^(?:https:\/\/\S+|mailto:\S+|tel:\S+)$/;

/** The address of a link as served (scheme in lower case), or `undefined` when the subset does not allow it. */
export function allowedHref(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_HREF_LENGTH) {
    return undefined;
  }
  if (PAGE_LINK.test(raw)) {
    return raw;
  }
  const scheme = SCHEME.exec(raw);
  if (scheme === null) {
    return undefined;
  }
  const href = `${(scheme[1] ?? "").toLowerCase()}:${raw.slice(scheme[0].length)}`;
  return ALLOWED_URL.test(href) ? href : undefined;
}

// ---- Inline parsing --------------------------------------------------------------------------------------------

type InlineType = "root" | "text" | "strong" | "em" | "link";

/** A node of the inline tree while it is built: a doubly linked list of children, as CommonMark's reference does. */
class InlineNode {
  prev: InlineNode | null = null;
  next: InlineNode | null = null;
  parent: InlineNode | null = null;
  first: InlineNode | null = null;
  last: InlineNode | null = null;

  constructor(
    readonly type: InlineType,
    /** Where it starts in the text, for the line of an error. */
    readonly offset: number,
    public text = "",
    readonly href = "",
  ) {}

  append(child: InlineNode): void {
    child.unlink();
    child.parent = this;
    child.prev = this.last;
    if (this.last === null) {
      this.first = child;
    } else {
      this.last.next = child;
    }
    this.last = child;
  }

  insertAfter(sibling: InlineNode): void {
    sibling.unlink();
    sibling.parent = this.parent;
    sibling.prev = this;
    sibling.next = this.next;
    if (this.next === null) {
      if (this.parent !== null) {
        this.parent.last = sibling;
      }
    } else {
      this.next.prev = sibling;
    }
    this.next = sibling;
  }

  unlink(): void {
    if (this.prev === null) {
      if (this.parent !== null) {
        this.parent.first = this.next;
      }
    } else {
      this.prev.next = this.next;
    }
    if (this.next === null) {
      if (this.parent !== null) {
        this.parent.last = this.prev;
      }
    } else {
      this.next.prev = this.prev;
    }
    this.prev = null;
    this.next = null;
    this.parent = null;
  }
}

/** A run of `*` or `_` on the delimiter stack (CommonMark). */
interface Delimiter {
  readonly char: "*" | "_";
  readonly node: InlineNode;
  count: number;
  readonly originalCount: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  prev: Delimiter | null;
  next: Delimiter | null;
}

/** A `[` on the bracket stack. */
interface Bracket {
  readonly node: InlineNode;
  readonly prev: Bracket | null;
  readonly delimiter: Delimiter | null;
  active: boolean;
}

/** One inline text (a heading, a paragraph, a list item) with the line of each offset. */
class InlineParser {
  private readonly root: InlineNode;
  private delimiters: Delimiter | null = null;
  private brackets: Bracket | null = null;
  private position = 0;

  constructor(
    private readonly text: string,
    private readonly lineOf: (offset: number) => number,
  ) {
    this.root = new InlineNode("root", 0);
  }

  parse(): StorefrontPageInline[] {
    const { text } = this;
    while (this.position < text.length) {
      const char = text[this.position];
      if (char === "\\") {
        const next = text[this.position + 1];
        if (isAsciiPunctuation(next)) {
          this.appendText(next ?? "", this.position);
          this.position += 2;
        } else {
          this.appendText("\\", this.position);
          this.position += 1;
        }
      } else if (char === "*" || char === "_") {
        this.delimiterRun(char);
      } else if (char === "[") {
        this.openBracket();
      } else if (char === "]") {
        this.closeBracket();
      } else if (char === "!" && text[this.position + 1] === "[") {
        throw refuse(
          this.lineOf(this.position),
          "has an image inside text: put each image alone on its own line.",
        );
      } else {
        this.plainText();
      }
    }
    this.processEmphasis(null);
    return this.output();
  }

  /** Text up to the next character the parser reads. */
  private plainText(): void {
    const start = this.position;
    let end = start + 1;
    while (end < this.text.length && !"\\*_[]!".includes(this.text[end] ?? "")) {
      end += 1;
    }
    this.appendText(this.text.slice(start, end), start);
    this.position = end;
  }

  private appendText(value: string, offset: number): InlineNode {
    const node = new InlineNode("text", offset, value);
    this.root.append(node);
    return node;
  }

  /** A run of `*` or `_` with CommonMark's flanking rules. */
  private delimiterRun(char: "*" | "_"): void {
    const start = this.position;
    let end = start;
    while (this.text[end] === char) {
      end += 1;
    }
    const before = start === 0 ? undefined : this.text[start - 1];
    const after = this.text[end];
    const leftFlanking =
      !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
    const rightFlanking =
      !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
    const canOpen = char === "*" ? leftFlanking : leftFlanking && (!rightFlanking || isPunctuation(before));
    const canClose = char === "*" ? rightFlanking : rightFlanking && (!leftFlanking || isPunctuation(after));
    const node = this.appendText(this.text.slice(start, end), start);
    this.position = end;
    if (canOpen || canClose) {
      const delimiter: Delimiter = {
        char,
        node,
        count: end - start,
        originalCount: end - start,
        canOpen,
        canClose,
        prev: this.delimiters,
        next: null,
      };
      if (this.delimiters !== null) {
        this.delimiters.next = delimiter;
      }
      this.delimiters = delimiter;
    }
  }

  private removeDelimiter(delimiter: Delimiter): void {
    if (delimiter.prev !== null) {
      delimiter.prev.next = delimiter.next;
    }
    if (delimiter.next === null) {
      this.delimiters = delimiter.prev;
    } else {
      delimiter.next.prev = delimiter.prev;
    }
  }

  private openBracket(): void {
    const node = this.appendText("[", this.position);
    this.brackets = { node, prev: this.brackets, delimiter: this.delimiters, active: true };
    this.position += 1;
  }

  /** `]`: a link when `(` and an allowed address follow the latest active `[`, else text. */
  private closeBracket(): void {
    const at = this.position;
    const opener = this.brackets;
    if (opener === null) {
      this.appendText("]", at);
      this.position += 1;
      return;
    }
    if (!opener.active) {
      this.brackets = opener.prev;
      this.appendText("]", at);
      this.position += 1;
      return;
    }
    const next = this.text[at + 1];
    if (next === "[") {
      throw refuse(this.lineOf(at), "uses a reference link: write links as [text](address).");
    }
    if (next !== "(") {
      this.brackets = opener.prev;
      this.appendText("]", at);
      this.position += 1;
      return;
    }
    const { raw, end } = this.destination(at + 2);
    const href = allowedHref(raw);
    if (href === undefined) {
      throw refuse(
        this.lineOf(at),
        raw.length > MAX_HREF_LENGTH
          ? `has a link address longer than ${MAX_HREF_LENGTH} characters.`
          : "links to an address content pages do not allow: use https:, mailto:, tel: or /p/<slug>.",
      );
    }
    const link = new InlineNode("link", opener.node.offset, "", href);
    let node = opener.node.next;
    while (node !== null) {
      const following = node.next;
      link.append(node);
      node = following;
    }
    opener.node.insertAfter(link);
    opener.node.unlink();
    this.processEmphasis(opener.delimiter);
    this.brackets = opener.prev;
    // No link inside a link: the brackets before this one are text from now on. A link closed earlier made every
    // bracket below the first inactive one inactive already, so the walk stops there and stays linear in the text.
    for (let earlier = this.brackets; earlier !== null && earlier.active; earlier = earlier.prev) {
      earlier.active = false;
    }
    if (!hasText(link)) {
      throw refuse(this.lineOf(at), "has a link without text.");
    }
    this.position = end + 1;
  }

  /** The address of `(…)` from `start` (after the `(`): no white space, balanced parentheses, escapes resolved. */
  private destination(start: number): { readonly raw: string; readonly end: number } {
    let raw = "";
    let depth = 0;
    for (let index = start; index < this.text.length; index += 1) {
      const char = this.text[index] ?? "";
      if (char === "\\" && isAsciiPunctuation(this.text[index + 1])) {
        index += 1;
        raw += this.text[index] ?? "";
      } else if (char === ")" && depth === 0) {
        return { raw, end: index };
      } else if (/\s/u.test(char)) {
        throw refuse(
          this.lineOf(index),
          "has a link address with a space or a title: write links as [text](address).",
        );
      } else {
        depth += char === "(" ? 1 : char === ")" ? -1 : 0;
        raw += char;
      }
      if (raw.length > MAX_HREF_LENGTH) {
        throw refuse(this.lineOf(start), `has a link address longer than ${MAX_HREF_LENGTH} characters.`);
      }
    }
    throw refuse(this.lineOf(start), "has a link that is not closed with ).");
  }

  /**
   * CommonMark's "process emphasis" over the delimiters above `bottom`: each closer, from the left, takes the nearest
   * opener of its character (two characters for bold when both runs have two, else one for italic); the runs between
   * them become text; the openers' bottoms keep the search linear.
   */
  private processEmphasis(bottom: Delimiter | null): void {
    const openersBottom = new Map<string, Delimiter | null>();
    // The first delimiter above `bottom`; none when `bottom` is the top (a link without emphasis inside), without
    // walking the delimiters below it, which a link closed after many of them would otherwise do once per link.
    let closer = this.delimiters === bottom ? null : this.delimiters;
    while (closer !== null && closer.prev !== bottom) {
      closer = closer.prev;
    }
    while (closer !== null) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.originalCount % 3}`;
      const limit = openersBottom.has(key) ? (openersBottom.get(key) ?? null) : bottom;
      let opener = closer.prev;
      let found = false;
      while (opener !== null && opener !== bottom && opener !== limit) {
        const oddMatch =
          (closer.canOpen || opener.canClose) &&
          closer.originalCount % 3 !== 0 &&
          (opener.originalCount + closer.originalCount) % 3 === 0;
        if (opener.char === closer.char && opener.canOpen && !oddMatch) {
          found = true;
          break;
        }
        opener = opener.prev;
      }
      if (!found || opener === null) {
        openersBottom.set(key, closer.prev);
        const next = closer.next;
        if (!closer.canOpen) {
          this.removeDelimiter(closer);
        }
        closer = next;
        continue;
      }
      const used = closer.count >= 2 && opener.count >= 2 ? 2 : 1;
      opener.count -= used;
      closer.count -= used;
      opener.node.text = opener.node.text.slice(0, opener.count);
      closer.node.text = closer.node.text.slice(0, closer.count);
      const emphasis = new InlineNode(used === 2 ? "strong" : "em", opener.node.offset);
      let node = opener.node.next;
      while (node !== null && node !== closer.node) {
        const following = node.next;
        emphasis.append(node);
        node = following;
      }
      opener.node.insertAfter(emphasis);
      // The runs between the two are text now.
      opener.next = closer;
      closer.prev = opener;
      if (opener.count === 0) {
        opener.node.unlink();
        this.removeDelimiter(opener);
      }
      if (closer.count === 0) {
        closer.node.unlink();
        const next = closer.next;
        this.removeDelimiter(closer);
        closer = next;
      }
    }
    while (this.delimiters !== null && this.delimiters !== bottom) {
      this.removeDelimiter(this.delimiters);
    }
  }

  /** The tree as the document's inline nodes, without recursion: adjacent text merged, empty text and nodes dropped. */
  private output(): StorefrontPageInline[] {
    interface Frame {
      readonly node: InlineNode;
      readonly content: StorefrontPageInline[];
      cursor: InlineNode | null;
    }
    const top: Frame = { node: this.root, content: [], cursor: this.root.first };
    const stack: Frame[] = [top];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      const node = frame.cursor;
      if (node === null) {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent !== undefined && frame.content.length > 0) {
          parent.content.push(containerOf(frame.node, frame.content));
        }
        continue;
      }
      frame.cursor = node.next;
      if (node.type === "text") {
        pushText(frame.content, node.text);
        continue;
      }
      if (stack.length > MAX_INLINE_DEPTH) {
        throw refuse(
          this.lineOf(node.offset),
          `nests bold, italic and links more than ${MAX_INLINE_DEPTH} levels deep.`,
        );
      }
      stack.push({ node, content: [], cursor: node.first });
    }
    return top.content;
  }
}

/** True when the node holds text other than white space. */
function hasText(node: InlineNode): boolean {
  const pending: Array<InlineNode | null> = [node.first];
  while (pending.length > 0) {
    let current = pending.pop() ?? null;
    while (current !== null) {
      if (current.type === "text" && current.text.trim() !== "") {
        return true;
      }
      if (current.first !== null) {
        pending.push(current.first);
      }
      current = current.next;
    }
  }
  return false;
}

/** Appends text to inline content, merged with a text node before it. */
function pushText(content: StorefrontPageInline[], text: string): void {
  if (text === "") {
    return;
  }
  const last = content[content.length - 1];
  if (last?.type === "text") {
    content[content.length - 1] = { type: "text", text: last.text + text };
  } else {
    content.push({ type: "text", text });
  }
}

/** A finished bold, italic or link node (the root and text nodes are never containers of the output). */
function containerOf(node: InlineNode, content: StorefrontPageInline[]): StorefrontPageInline {
  if (node.type === "strong" || node.type === "em") {
    return { type: node.type, content };
  }
  return { type: "link", href: node.href, content };
}

/** One text of the body: its lines (each trimmed) joined with a space, with the line of each part. */
interface InlineText {
  readonly parts: Array<{ readonly text: string; readonly line: number }>;
}

/** The inline nodes of a text; refuses one that holds none. */
function parseInlineText(source: InlineText): StorefrontPageInline[] {
  const starts: number[] = [];
  let joined = "";
  for (const part of source.parts) {
    if (joined !== "") {
      joined += " ";
    }
    starts.push(joined.length);
    joined += part.text;
  }
  const lineOf = (offset: number): number => {
    let index = starts.length - 1;
    while (index > 0 && (starts[index] ?? 0) > offset) {
      index -= 1;
    }
    return source.parts[index]?.line ?? source.parts[0]?.line ?? 1;
  };
  const content = new InlineParser(joined, lineOf).parse();
  if (content.length === 0) {
    throw refuse(source.parts[0]?.line ?? 1, "has no text.");
  }
  return content;
}

// ---- Block parsing ---------------------------------------------------------------------------------------------

const HEADING = /^(#{1,6})(?=[ \t]|$)(.*)$/;
const RULE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const TABLE_DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;
const REFERENCE_DEFINITION = /^\[[^\]]+\]:/;
const BULLET = /^([-*+])(?:[ \t]+(.*))?$/;
const ORDERED = /^(\d{1,9})([.)])(?:[ \t]+(.*))?$/;
const SETEXT_UNDERLINE = /^(?:=+|-+)$/;
const FENCE = /^~{3,}/;
const ASSET_ID = /^ast_[0-9A-Za-z]{16,40}$/;

/** A list being read. */
interface OpenList {
  readonly ordered: boolean;
  /** `-`, `*` or `.`: another marker starts another list. */
  readonly marker: string;
  readonly start: number | null;
  /** The indentation of its markers. */
  readonly indent: number;
  readonly items: InlineText[];
  /** A blank line came after its last item. */
  blankAfter: boolean;
}

/** A list item line. */
interface ItemLine {
  readonly ordered: boolean;
  readonly marker: string;
  readonly start: number | null;
  readonly text: string;
}

/** The list item of a line (without its indentation), `undefined` when it starts none; refuses the forms not allowed. */
function itemOf(content: string, line: number): ItemLine | undefined {
  const bullet = BULLET.exec(content);
  if (bullet !== null) {
    if (bullet[1] === "+") {
      throw refuse(line, "starts a list with +: start bullet list items with - or *.");
    }
    return checkedItem(
      { ordered: false, marker: bullet[1] ?? "-", start: null, text: bullet[2] ?? "" },
      line,
    );
  }
  const ordered = ORDERED.exec(content);
  if (ordered !== null) {
    if (ordered[2] === ")") {
      throw refuse(line, "numbers a list item with ): write 1. instead.");
    }
    return checkedItem(
      { ordered: true, marker: ".", start: Number(ordered[1]), text: ordered[3] ?? "" },
      line,
    );
  }
  return undefined;
}

/** A list item whose text is text: not empty, and no block of its own (a nested list, heading, quote or fence). */
function checkedItem(item: ItemLine, line: number): ItemLine {
  const text = item.text.trim();
  if (text === "") {
    throw refuse(line, "is an empty list item.");
  }
  if (BULLET.test(text) || ORDERED.test(text)) {
    throw refuse(line, "nests a list: lists are one level deep.");
  }
  if (HEADING.test(text) || text.startsWith(">") || FENCE.test(text)) {
    throw refuse(line, "puts a heading, quote or code in a list item: list items hold text only.");
  }
  return { ...item, text };
}

/** The image of a line that starts with `![`; refuses any other form. */
function imageOf(content: string, line: number): ParsedImageBlock {
  let alt = "";
  let index = 2;
  for (; index < content.length; index += 1) {
    const char = content[index] ?? "";
    if (char === "\\" && isAsciiPunctuation(content[index + 1])) {
      index += 1;
      alt += content[index] ?? "";
    } else if (char === "]") {
      break;
    } else if (char === "[") {
      throw refuse(line, "has a [ in an image's alt text: write it as \\[.");
    } else {
      alt += char;
    }
  }
  const malformed = (): MarkdownSubsetError =>
    refuse(line, "has an image that is not ![alt text](ast_…) alone on its line.");
  if (content[index] !== "]" || content[index + 1] !== "(") {
    throw malformed();
  }
  const close = content.indexOf(")", index + 2);
  if (close === -1 || close !== content.length - 1) {
    throw malformed();
  }
  const assetId = content.slice(index + 2, close);
  if (!ASSET_ID.test(assetId)) {
    throw refuse(line, "has an image that names no uploaded page image: write ![alt text](ast_…).");
  }
  if (Array.from(alt).length > MAX_ALT_LENGTH) {
    throw refuse(line, `has an image with more than ${MAX_ALT_LENGTH} characters of alt text.`);
  }
  return { type: "image", assetId, alt: alt.trim() };
}

const isSpaceOrTab = (char: string | undefined): boolean => char === " " || char === "\t";

/**
 * A heading's text without its optional closing run of `#` (after spaces or tabs, or alone; `C#` keeps its `#`). Read
 * from the end, once: a regular expression such as `(?:^|[ \t]+)#+[ \t]*$` retries its run of spaces at every
 * position and takes seconds on a heading of 50 000 spaces.
 */
function withoutClosingHashes(rest: string): string {
  let end = rest.length;
  while (end > 0 && isSpaceOrTab(rest[end - 1])) {
    end -= 1;
  }
  let start = end;
  while (start > 0 && rest[start - 1] === "#") {
    start -= 1;
  }
  if (start === end) {
    return rest;
  }
  if (start > 0 && !isSpaceOrTab(rest[start - 1])) {
    return rest;
  }
  while (start > 0 && isSpaceOrTab(rest[start - 1])) {
    start -= 1;
  }
  return rest.slice(0, start);
}

/** The leading spaces of a line (a tab counts as four, which makes code). */
function indentationOf(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === " ") {
      width += 1;
    } else if (char === "\t") {
      width += 4;
    } else {
      break;
    }
  }
  return width;
}

/** The body's blocks (see the file header). */
class BlockParser {
  private readonly blocks: ParsedPageBlock[] = [];
  private readonly images: ParsedImage[] = [];
  private paragraph: InlineText | null = null;
  private list: OpenList | null = null;

  parse(body: string): ParsedPage {
    const lines = body.replace(/\r\n?/g, "\n").split("\n");
    for (const [index, raw] of lines.entries()) {
      this.line(raw, index + 1);
    }
    this.closeParagraph();
    this.closeList();
    return { blocks: this.blocks, images: this.images };
  }

  private line(raw: string, line: number): void {
    checkLine(raw, line);
    const content = raw.trim();
    if (content === "") {
      this.closeParagraph();
      if (this.list !== null) {
        this.list.blankAfter = true;
      }
      return;
    }
    const indent = indentationOf(raw);
    if (this.paragraph !== null) {
      this.paragraphLine(content, line);
    } else if (this.list !== null) {
      this.listLine(content, indent, line);
    } else {
      this.blockStart(content, indent, line);
    }
  }

  /** A line after a paragraph line: a block that interrupts it, a refused form, or more of its text. */
  private paragraphLine(content: string, line: number): void {
    const paragraph = this.paragraph as InlineText;
    if (SETEXT_UNDERLINE.test(content)) {
      throw refuse(line, "underlines a heading: write headings as ## to ####.");
    }
    if (content.includes("|") && TABLE_DELIMITER_ROW.test(content)) {
      const previous = paragraph.parts[paragraph.parts.length - 1];
      throw tableAt(previous !== undefined && previous.text.includes("|") ? previous.line : line);
    }
    const ordered = ORDERED.exec(content);
    const interrupts =
      HEADING.test(content) ||
      content.startsWith(">") ||
      content.startsWith("|") ||
      FENCE.test(content) ||
      RULE.test(content) ||
      content.startsWith("![") ||
      BULLET.test(content) ||
      (ordered !== null && ordered[1] === "1");
    if (interrupts) {
      this.closeParagraph();
      this.blockStart(content, 0, line);
      return;
    }
    paragraph.parts.push({ text: content, line });
  }

  /** A line after a list item: another item, more of the item's text, or the end of the list. */
  private listLine(content: string, indent: number, line: number): void {
    const list = this.list as OpenList;
    if (SETEXT_UNDERLINE.test(content) && !list.blankAfter) {
      throw refuse(line, "underlines a heading: write headings as ## to ####.");
    }
    if (content.includes("|") && TABLE_DELIMITER_ROW.test(content)) {
      // A table's delimiter row under an item's line, as under a paragraph's: the table starts on that line.
      const item = list.items[list.items.length - 1];
      const previous = item?.parts[item.parts.length - 1];
      throw tableAt(
        !list.blankAfter && previous !== undefined && previous.text.includes("|") ? previous.line : line,
      );
    }
    const startsBlock =
      HEADING.test(content) ||
      content.startsWith(">") ||
      content.startsWith("|") ||
      FENCE.test(content) ||
      RULE.test(content) ||
      content.startsWith("![") ||
      REFERENCE_DEFINITION.test(content);
    const item = startsBlock ? undefined : itemOf(content, line);
    if (item !== undefined) {
      if (indent > list.indent) {
        throw refuse(line, "nests a list: lists are one level deep.");
      }
      if (item.ordered === list.ordered && item.marker === list.marker) {
        list.items.push({ parts: [{ text: item.text, line }] });
        list.blankAfter = false;
        return;
      }
      this.closeList();
      this.blockStart(content, indent, line);
      return;
    }
    if (list.blankAfter) {
      if (indent > 0) {
        throw refuse(
          line,
          "is indented under a list: a list item holds one paragraph, and lists are one level deep.",
        );
      }
      this.closeList();
      this.blockStart(content, indent, line);
      return;
    }
    if (startsBlock) {
      this.closeList();
      this.blockStart(content, 0, line);
      return;
    }
    const last = list.items[list.items.length - 1] as InlineText;
    last.parts.push({ text: content, line });
  }

  /** The first line of a block. */
  private blockStart(content: string, indent: number, line: number): void {
    if (indent >= 4) {
      throw refuse(
        line,
        "is indented by four spaces or a tab, which makes code: content pages do not allow code.",
      );
    }
    if (FENCE.test(content)) {
      throw refuse(line, "starts a code block, which content pages do not allow.");
    }
    if (content.startsWith(">")) {
      throw refuse(line, "is a block quote, which content pages do not allow.");
    }
    const heading = HEADING.exec(content);
    if (heading !== null) {
      this.heading(heading[1]?.length ?? 1, heading[2] ?? "", line);
      return;
    }
    if (RULE.test(content)) {
      throw refuse(line, "is a horizontal rule, which content pages do not allow.");
    }
    if (content.startsWith("|") || (content.includes("|") && TABLE_DELIMITER_ROW.test(content))) {
      throw tableAt(line);
    }
    if (REFERENCE_DEFINITION.test(content)) {
      throw refuse(line, "defines a reference link: write links as [text](address).");
    }
    if (content.startsWith("![")) {
      const image = imageOf(content, line);
      this.blocks.push(image);
      this.images.push({ assetId: image.assetId, line });
      return;
    }
    const item = itemOf(content, line);
    if (item !== undefined) {
      this.list = {
        ordered: item.ordered,
        marker: item.marker,
        start: item.start,
        indent,
        items: [{ parts: [{ text: item.text, line }] }],
        blankAfter: false,
      };
      return;
    }
    this.paragraph = { parts: [{ text: content, line }] };
  }

  private heading(level: number, rest: string, line: number): void {
    if (level < 2 || level > 4) {
      throw refuse(line, `is a heading of level ${level}: use ## to #### (the page title is the level 1).`);
    }
    const text = withoutClosingHashes(rest).trim();
    if (text === "") {
      throw refuse(line, "is an empty heading.");
    }
    this.blocks.push({ type: "heading", level, content: parseInlineText({ parts: [{ text, line }] }) });
  }

  private closeParagraph(): void {
    if (this.paragraph !== null) {
      this.blocks.push({ type: "paragraph", content: parseInlineText(this.paragraph) });
      this.paragraph = null;
    }
  }

  private closeList(): void {
    const list = this.list;
    if (list !== null) {
      this.blocks.push({
        type: "list",
        ordered: list.ordered,
        start: list.start,
        items: list.items.map((item) => ({ content: parseInlineText(item) })),
      });
      this.list = null;
    }
  }
}

function tableAt(line: number): MarkdownSubsetError {
  return refuse(line, "starts a table, which content pages do not allow.");
}

/**
 * Parses a page body of the Markdown subset into its blocks and the images it shows (see the file header). Throws
 * MarkdownSubsetError, and nothing else, for a body outside the subset.
 */
export function parseMarkdownSubset(body: string): ParsedPage {
  return new BlockParser().parse(body);
}
