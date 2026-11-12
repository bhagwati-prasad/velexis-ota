#!/usr/bin/env node
// @ts-check
// breached-passwords.mjs: writes and checks `src/auth/breached-passwords.txt`, the breached-password list that portal
// passwords are checked against (PBE-073; ADR-0008 "Passwords", the note of 2026-11-11 for lead decision (17b);
// src/auth/password-policy.ts).
//
// Usage (plain Node 22, no dependencies; any working directory):
//   node platform/backend/scripts/breached-passwords.mjs --check               check the committed list (offline)
//   node platform/backend/scripts/breached-passwords.mjs --source <file>       write the list from the pinned source
// Option: --list <file>, the list to check or write (default: the platform backend's src/auth/breached-passwords.txt).
//
// The source is the public list of about a million breached passwords of SecLists (MIT licence),
// `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` at the commit of SOURCE below. A person
// fetches it BY HAND into a scratch folder, never CI, a build, a test or a deploy, for example:
//   curl -fsSL -o xato-1m.txt https://raw.githubusercontent.com/danielmiessler/SecLists/c23b603128ed21e46164a0afd357f0c242135f41/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt
// and runs `--source xato-1m.txt`. The script refuses a source whose SHA-256 is not the pinned one, keeps the lines
// that meet the portal's password rule exactly as `PasswordPolicy` counts it (at least 12 characters, counted in
// Unicode code points, with a letter `\p{L}` and a decimal digit `\p{Nd}` of any script), lower-cased and trimmed,
// without duplicates, sorted by code point, one per line with a final LF, checks the result as `--check` does and
// writes it. It prints the counts and the result's SHA-256, and exits 1 when that is not LIST.sha256: regenerating
// from the pinned source gives the committed file byte for byte, so a difference means the rule or this script
// changed, and the new figures go here, into the header of password-policy.ts, password-policy.test.ts, the
// backend README and ADR-0008 after review.
//
// `--check` (CI runs it through password-policy.test.ts) reads only the list: every line is non-empty, trimmed and
// lower-cased, meets the rule, and comes after the line before it in code-point order (so no line is repeated);
// the file ends with one LF, has no CR, holds LIST.entries lines and its SHA-256 is LIST.sha256. It never touches
// the network.
//
// Exit codes: 0 done, 1 a check failed (nothing is written for a refused source), 2 invalid arguments.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The pinned source (SecLists, MIT licence), fetched by hand. */
export const SOURCE = Object.freeze({
  url: "https://raw.githubusercontent.com/danielmiessler/SecLists/c23b603128ed21e46164a0afd357f0c242135f41/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt",
  commit: "c23b603128ed21e46164a0afd357f0c242135f41",
  path: "Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt",
  sha256: "424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51",
  /** Its non-empty lines: the file has 1 000 000 lines, each ending with LF, and its line 43 is empty. */
  lines: 999_999,
});

/** The committed list as built from SOURCE on 2026-11-12 (PBE-073). */
export const LIST = Object.freeze({
  entries: 28_897,
  bytes: 421_156,
  sha256: "df67d6b895d1c029308223dd82298bbde1b2f776fd9ae5d5b9ac3bbe17e31faf",
});

/** The default list: `src/auth/breached-passwords.txt` of the platform backend. */
export const DEFAULT_LIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "auth",
  "breached-passwords.txt",
);

/** The rule of `PasswordPolicy` (src/auth/password-policy.ts): MIN_PASSWORD_LENGTH code points, a letter, a digit. */
export const MIN_PASSWORD_LENGTH = 12;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

/** @param {string | Uint8Array} data */
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * True when `password` meets the portal's rule as `PasswordPolicy.problem` counts it.
 * @param {string} password
 */
export function meetsRule(password) {
  return [...password].length >= MIN_PASSWORD_LENGTH && LETTER.test(password) && DIGIT.test(password);
}

/**
 * Compares two strings by Unicode code point (JavaScript's `<` compares UTF-16 units, which differs above U+FFFF).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareCodePoints(a, b) {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const difference =
      /** @type {number} */ (left[i]?.codePointAt(0)) - /** @type {number} */ (right[i]?.codePointAt(0));
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/**
 * The list built from the source's text: the lines that meet the rule (trimmed), lower-cased, unique, in code-point
 * order, one per line with a final LF.
 * @param {string} sourceText
 * @returns {{ text: string, sourceLines: number, meetingRule: number, entries: number }}
 */
export function buildList(sourceText) {
  /** @type {Set<string>} */
  const entries = new Set();
  let sourceLines = 0;
  let meetingRule = 0;
  for (const raw of sourceText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    sourceLines += 1;
    if (meetsRule(line)) {
      meetingRule += 1;
      entries.add(line.toLowerCase());
    }
  }
  const sorted = [...entries].sort(compareCodePoints);
  return {
    text: sorted.map((entry) => `${entry}\n`).join(""),
    sourceLines,
    meetingRule,
    entries: sorted.length,
  };
}

/** How many problems of single lines a check prints; the file's own problems are always printed. */
const LINE_PROBLEMS_SHOWN = 20;

/**
 * The problems of a list's text: the file's own (CR, the final LF, the count and the SHA-256 when `expected` names
 * them) and the first LINE_PROBLEMS_SHOWN problems of single lines (numbered from 1), which name the line, never its
 * content.
 * @param {string} text
 * @param {{ entries?: number, sha256?: string }} [expected]
 * @returns {{ problems: string[], entries: number, bytes: number, sha256: string }}
 */
export function checkList(text, expected = LIST) {
  /** @type {string[]} */
  const lineProblems = [];
  let lineProblemCount = 0;
  const add = (/** @type {string} */ problem) => {
    lineProblemCount += 1;
    if (lineProblems.length < LINE_PROBLEMS_SHOWN) {
      lineProblems.push(problem);
    }
  };
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  /** @type {string | undefined} */
  let previous;
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    if (line === "") {
      add(`${at}: empty`);
      return;
    }
    if (line !== line.trim()) {
      add(`${at}: has spaces around it`);
    }
    if (line !== line.toLowerCase()) {
      add(`${at}: not lower-cased`);
    }
    if (!meetsRule(line)) {
      add(`${at}: does not meet the rule (${MIN_PASSWORD_LENGTH} characters, a letter and a digit)`);
    }
    if (previous !== undefined) {
      const order = compareCodePoints(previous, line);
      if (order === 0) {
        add(`${at}: repeats the line before it`);
      } else if (order > 0) {
        add(`${at}: not in code-point order after the line before it`);
      }
    }
    previous = line;
  });
  const digest = sha256(text);
  /** @type {string[]} */
  const problems = [];
  if (text.includes("\r")) {
    problems.push("the file holds a CR; lines end with LF only");
  }
  if (!text.endsWith("\n")) {
    problems.push("the file does not end with LF");
  }
  if (expected.entries !== undefined && lines.length !== expected.entries) {
    problems.push(`${lines.length} lines, ${expected.entries} recorded`);
  }
  if (expected.sha256 !== undefined && digest !== expected.sha256) {
    problems.push(`SHA-256 ${digest}, ${expected.sha256} recorded`);
  }
  problems.push(...lineProblems);
  if (lineProblemCount > lineProblems.length) {
    problems.push(`… and ${lineProblemCount - lineProblems.length} more problems of single lines`);
  }
  return { problems, entries: lines.length, bytes: Buffer.byteLength(text, "utf8"), sha256: digest };
}

/**
 * `--check`: checks the list file, prints the result and returns the exit code.
 * @param {string} file
 * @param {(line: string) => void} log
 */
export function runCheck(file, log) {
  const { problems, entries, bytes, sha256: digest } = checkList(readFileSync(file, "utf8"));
  if (problems.length > 0) {
    log(`breached-passwords --check: ${file} FAILED`);
    for (const problem of problems) {
      log(`  ${problem}`);
    }
    return 1;
  }
  log(`breached-passwords --check: ${file} OK: ${entries} entries, ${bytes} bytes, SHA-256 ${digest}`);
  return 0;
}

/**
 * `--source`: builds the list from the pinned source, checks it and writes it; returns the exit code.
 * @param {string} sourceFile
 * @param {string} file
 * @param {(line: string) => void} log
 */
export function runGenerate(sourceFile, file, log) {
  const bytes = readFileSync(sourceFile);
  const sourceDigest = sha256(bytes);
  if (sourceDigest !== SOURCE.sha256) {
    log(`breached-passwords: the source's SHA-256 is ${sourceDigest}, not the pinned ${SOURCE.sha256}`);
    log(`  fetch ${SOURCE.url}`);
    log("  nothing was written");
    return 1;
  }
  const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const built = buildList(sourceText);
  log(`source: ${SOURCE.path} at ${SOURCE.commit}, ${built.sourceLines} lines, SHA-256 ${sourceDigest}`);
  log(`kept: ${built.meetingRule} lines meet the rule, ${built.entries} entries once lower-cased and unique`);
  // The structure of what is written, as --check reads it; the recorded count and SHA-256 are compared below.
  const { problems, bytes: listBytes, sha256: digest } = checkList(built.text, {});
  if (problems.length > 0) {
    log("breached-passwords: the built list fails the check; nothing was written");
    for (const problem of problems) {
      log(`  ${problem}`);
    }
    return 1;
  }
  writeFileSync(file, built.text);
  log(`wrote ${file}: ${built.entries} entries, ${listBytes} bytes, SHA-256 ${digest}`);
  if (digest !== LIST.sha256 || built.entries !== LIST.entries) {
    log(
      `the result differs from the recorded list (${LIST.entries} entries, SHA-256 ${LIST.sha256}): review it, ` +
        "then record the new figures in LIST, password-policy.ts, password-policy.test.ts, the README and ADR-0008",
    );
    return 1;
  }
  log("the result is the recorded list");
  return 0;
}

const USAGE =
  "usage: node platform/backend/scripts/breached-passwords.mjs --check [--list <file>]\n" +
  "       node platform/backend/scripts/breached-passwords.mjs --source <file> [--list <file>]";

/**
 * The command line; returns the exit code.
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 */
export function main(argv, log = console.log) {
  /** @type {{ check?: boolean, source?: string, list?: string }} */
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        check: { type: "boolean" },
        source: { type: "string" },
        list: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    log(USAGE);
    return 2;
  }
  if (values.check === true && values.source !== undefined) {
    log(USAGE);
    return 2;
  }
  const list = path.resolve(values.list ?? DEFAULT_LIST);
  if (values.check === true) {
    return runCheck(list, log);
  }
  if (values.source !== undefined) {
    return runGenerate(path.resolve(values.source), list, log);
  }
  log(USAGE);
  return 2;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`breached-passwords: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
