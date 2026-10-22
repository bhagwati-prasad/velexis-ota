// Test support: the text of a PDF that pdfmake (pdfkit) wrote (OBE-053), so a test can search a booking document for a
// value. pdfkit embeds each font as a subset (Type0, Identity-H) and writes text as hex glyph codes (`[<0001…> 0] TJ`),
// so the PDF's bytes never hold the text itself; each font carries a ToUnicode CMap (`beginbfrange` arrays and
// `beginbfchar` pairs) that maps its codes back to UTF-16. This reader inflates every stream, reads the CMaps of the
// fonts, and decodes the `Tj` and `TJ` operators of the content streams in order, a new line where a text object
// starts at another height (`Tm`). It understands what pdfkit writes, not every PDF.
import { inflateSync } from "node:zlib";

interface PdfObject {
  readonly dictionary: string;
  readonly stream: Buffer | undefined;
}

/** Every `N 0 obj … endobj` of the file with its dictionary and its (inflated) stream. */
function objectsOf(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const header = /(\d+) 0 obj\s*/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    const id = Number(match[1]);
    const start = match.index + match[0].length;
    const streamAt = text.indexOf("stream", start);
    const endAt = text.indexOf("endobj", start);
    if (endAt < 0) {
      break;
    }
    if (streamAt < 0 || streamAt > endAt) {
      objects.set(id, { dictionary: text.slice(start, endAt), stream: undefined });
      header.lastIndex = endAt;
      continue;
    }
    const dictionary = text.slice(start, streamAt);
    const length = /\/Length (\d+)/.exec(dictionary);
    let dataStart = streamAt + "stream".length;
    if (text[dataStart] === "\r") {
      dataStart += 1;
    }
    if (text[dataStart] === "\n") {
      dataStart += 1;
    }
    const raw = pdf.subarray(dataStart, dataStart + Number(length?.[1] ?? 0));
    const stream = /\/FlateDecode/.test(dictionary) ? inflateSync(raw) : raw;
    objects.set(id, { dictionary, stream });
    header.lastIndex = text.indexOf("endobj", dataStart + raw.length);
  }
  return objects;
}

/** The code → text map of a ToUnicode CMap. */
function cmapOf(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  // A ligature's code maps to several UTF-16 units (`<0066 0069>` for "fi").
  const unicode = (hex: string) => Buffer.from(hex.replace(/\s+/g, ""), "hex").swap16().toString("utf16le");
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of (block[1] ?? "").matchAll(
      /<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(\[[^\]]*\]|<[0-9a-f\s]+>)/gi,
    )) {
      const first = parseInt(range[1] ?? "0", 16);
      const last = parseInt(range[2] ?? "0", 16);
      const target = range[3] ?? "";
      if (target.startsWith("[")) {
        [...target.matchAll(/<([0-9a-f\s]+)>/gi)].forEach((entry, index) => {
          map.set(first + index, unicode(entry[1] ?? ""));
        });
      } else {
        const base = parseInt(target.slice(1, -1), 16);
        for (let code = first; code <= last; code += 1) {
          map.set(code, String.fromCodePoint(base + code - first));
        }
      }
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? "").matchAll(/<([0-9a-f]+)>\s*<([0-9a-f\s]+)>/gi)) {
      map.set(parseInt(pair[1] ?? "0", 16), unicode(pair[2] ?? ""));
    }
  }
  return map;
}

/** The decoded text of a PDF written by pdfkit (see the file header). */
export function pdfText(pdf: Buffer): string {
  const objects = objectsOf(pdf);
  // Font resource names (/F1) → their ToUnicode maps; pdfkit names fonts once per document.
  const fonts = new Map<string, Map<number, string>>();
  for (const object of objects.values()) {
    for (const entry of object.dictionary.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
      const font = objects.get(Number(entry[2]));
      const toUnicode = font === undefined ? null : /\/ToUnicode (\d+) 0 R/.exec(font.dictionary);
      const cmap = toUnicode === null ? undefined : objects.get(Number(toUnicode[1]))?.stream;
      if (entry[1] !== undefined && cmap !== undefined) {
        fonts.set(entry[1], cmapOf(cmap.toString("latin1")));
      }
    }
  }
  const contents = new Set<number>();
  for (const object of objects.values()) {
    if (/\/Type \/Page\b/.test(object.dictionary)) {
      for (const entry of object.dictionary.matchAll(/\/Contents (\d+) 0 R/g)) {
        contents.add(Number(entry[1]));
      }
    }
  }
  let text = "";
  let lastY: string | undefined;
  for (const id of [...contents].sort((a, b) => a - b)) {
    const stream = objects.get(id)?.stream?.toString("latin1") ?? "";
    let font = new Map<number, string>();
    for (const token of stream.matchAll(
      /\/(F\d+) [\d.]+ Tf|[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ ([\d.-]+) Tm|\[((?:<[0-9a-f]*>|[\s\d.-])*)\] TJ|<([0-9a-f]*)> Tj/gi,
    )) {
      if (token[1] !== undefined) {
        font = fonts.get(token[1]) ?? new Map();
      } else if (token[2] !== undefined) {
        if (lastY !== undefined && token[2] !== lastY) {
          text += "\n";
        }
        lastY = token[2];
      } else {
        const hex =
          token[3] === undefined
            ? (token[4] ?? "")
            : [...token[3].matchAll(/<([0-9a-f]*)>/gi)].map((part) => part[1]).join("");
        for (let index = 0; index + 4 <= hex.length; index += 4) {
          text += font.get(parseInt(hex.slice(index, index + 4), 16)) ?? "�";
        }
      }
    }
  }
  return text;
}
