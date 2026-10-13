import { describe, expect, it } from "vitest";
import { CsvError, parseCsv, parseCsvFile } from "./csv.js";

describe("parseCsv", () => {
  it("reads the RFC 4180 form of fetch.mjs: quotes only where needed, LF, a final newline", () => {
    expect(parseCsv('a,b,c\n1,"x, y",\n2,"say ""hi""","two\nlines"\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", ""],
      ["2", 'say "hi"', "two\nlines"],
    ]);
  });

  it("keeps a last record without a final newline and empty fields at both ends", () => {
    expect(parseCsv(",a,\nb")).toEqual([["", "a", ""], ["b"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("rejects stray and unterminated quotes with the line number", () => {
    expect(() => parseCsv('a\n"x"y\n')).toThrow(new CsvError("line 2: text after a closing quote"));
    expect(() => parseCsv('a\nx"y\n')).toThrow(new CsvError("line 2: quote inside an unquoted field"));
    expect(() => parseCsv('a\n"x\n')).toThrow(new CsvError("line 3: unterminated quoted field"));
  });
});

describe("parseCsvFile", () => {
  it("returns the header and rows of a UTF-8 file", () => {
    const content = new TextEncoder().encode("code,name\nAAC,Arīsh\nZRH,Zürich\n");
    expect(parseCsvFile("cities.csv", content)).toEqual({
      header: ["code", "name"],
      rows: [
        ["AAC", "Arīsh"],
        ["ZRH", "Zürich"],
      ],
    });
    expect(parseCsvFile("overrides.csv", "table,key,column,value\n")).toEqual({
      header: ["table", "key", "column", "value"],
      rows: [],
    });
  });

  it.each([
    ["invalid UTF-8", new Uint8Array([0x61, 0x0a, 0xff, 0x0a]), "x.csv: not valid UTF-8"],
    ["a byte order mark", "﻿a\n1\n", "x.csv: starts with a byte order mark"],
    // The loader reads files as bytes: TextDecoder would drop a leading byte order mark unless told to keep it.
    [
      "a byte order mark in its bytes",
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a, 0x31, 0x0a]),
      "x.csv: starts with a byte order mark",
    ],
    ["CR line endings", "a\r\n1\r\n", "x.csv: has CR characters; line endings must be LF"],
    ["no content", "", "x.csv: empty (no header row)"],
    ["no final newline", "a\n1", "x.csv: does not end with a newline"],
    ["a blank line", "a\n\n1\n", "x.csv: has a blank line"],
    ["a leading blank line", "\na\n", "x.csv: has a blank line"],
    ["a broken quote", 'a\n"1\n', "x.csv: line 3: unterminated quoted field"],
    ["a short row", "a,b\n1,2\n3\n", "x.csv:3: 1 fields, expected 2"],
    ["a long row", "a,b\n1,2,3\n", "x.csv:2: 3 fields, expected 2"],
  ])("refuses a file with %s", (_, content, message) => {
    expect(() => parseCsvFile("x.csv", content)).toThrow(new CsvError(message));
  });
});
