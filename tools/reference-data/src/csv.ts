// CSV reading for the reference data loader (task X-018). The datasets are written by scripts/fetch.mjs in one
// canonical form (README "File format"): UTF-8 without a byte order mark, comma-separated, RFC 4180 quoting only
// where needed, LF line endings, a header row and a final newline. scripts/validate.mjs checks every rule of that
// form before a snapshot is committed; the loader re-checks what it relies on (encoding, line endings, quoting,
// one field per header column) and leaves the values to PostgreSQL's types and CHECK constraints.

/** A data file that cannot be read as the canonical CSV of fetch.mjs. The message names the file and line. */
export class CsvError extends Error {
  override readonly name = "CsvError";
}

/** A parsed file: the header row and the data rows, each exactly as wide as the header. */
export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * Parses RFC 4180 CSV with LF record separators; a final LF ends the last record. Fields are returned as written
 * (an empty field is ""). Throws `CsvError` with the line number on a stray or unterminated quote.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let line = 1;
  let quoted = false;
  let atFieldStart = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i += 1;
        if (i < text.length && text[i] !== "," && text[i] !== "\n") {
          throw new CsvError(`line ${line}: text after a closing quote`);
        }
        continue;
      }
      if (c === "\n") {
        line += 1;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (!atFieldStart) {
        throw new CsvError(`line ${line}: quote inside an unquoted field`);
      }
      quoted = true;
      atFieldStart = false;
      i += 1;
      continue;
    }
    if (c === ",") {
      record.push(field);
      field = "";
      atFieldStart = true;
      i += 1;
      continue;
    }
    if (c === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      atFieldStart = true;
      line += 1;
      i += 1;
      continue;
    }
    field += c;
    atFieldStart = false;
    i += 1;
  }
  if (quoted) {
    throw new CsvError(`line ${line}: unterminated quoted field`);
  }
  if (!atFieldStart || field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/**
 * Decodes and parses one data file. `name` is used in messages only. It throws `CsvError` when the content is not
 * UTF-8, starts with a byte order mark, has CR characters, a blank line or no final newline, has no header row,
 * or has a row whose number of fields differs from the header's. `<file>:<n>` in a message is the n-th record,
 * the header being 1 (the line number, since the values of the datasets never contain a line break).
 */
export function parseCsvFile(name: string, content: Uint8Array | string): CsvTable {
  let text: string;
  try {
    // ignoreBOM keeps a leading byte order mark in the text (TextDecoder drops it by default), so it is refused.
    text =
      typeof content === "string"
        ? content
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new CsvError(`${name}: not valid UTF-8`);
  }
  if (text.startsWith("﻿")) {
    throw new CsvError(`${name}: starts with a byte order mark`);
  }
  if (text.includes("\r")) {
    throw new CsvError(`${name}: has CR characters; line endings must be LF`);
  }
  if (text === "") {
    throw new CsvError(`${name}: empty (no header row)`);
  }
  if (!text.endsWith("\n")) {
    throw new CsvError(`${name}: does not end with a newline`);
  }
  if (text.startsWith("\n") || text.includes("\n\n")) {
    throw new CsvError(`${name}: has a blank line`);
  }
  let records: string[][];
  try {
    records = parseCsv(text);
  } catch (error) {
    throw new CsvError(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [header, ...rows] = records;
  if (header === undefined) {
    throw new CsvError(`${name}: empty (no header row)`);
  }
  rows.forEach((row, index) => {
    if (row.length !== header.length) {
      throw new CsvError(`${name}:${index + 2}: ${row.length} fields, expected ${header.length}`);
    }
  });
  return { header, rows };
}
