#!/usr/bin/env node
// unit-node-options.mjs: the NODE_OPTIONS of a systemd unit file, read as systemd reads it (X-050; ADR-0029 item 5).
//
//   node tools/perf/unit-node-options.mjs deploy/systemd/velexis-platform-api.service
//   --max-old-space-size=640 --max-semi-space-size=16
//
// The load tests (ota/backend/test/load/search-load.mjs and booking-load.mjs) and the platform smoke test's start()
// (tools/perf/README.md, Run it, step 4) start their processes with the flags of the unit that runs them on the VM,
// read from the unit file instead of copied, so a measurement and the VM never differ in their heap flags.
//
// How systemd reads a unit's environment (systemd.exec(5) `Environment=`, systemd.syntax(7) "Quoting"), which this
// file follows for the [Service] section:
//   - Every `Environment=` line is split into words at unquoted whitespace. Double or single quotes keep their content
//     in one word and are removed. Each word must be one assignment `NAME=value`; a word that is not is ignored, with
//     only a warning in the journal. Unquoted, `Environment=NODE_OPTIONS=--max-old-space-size=640
//     --max-semi-space-size=16` gives the words `NODE_OPTIONS=--max-old-space-size=640` and
//     `--max-semi-space-size=16`, and the second flag is lost silently. Hence one quoted assignment:
//     `Environment="NODE_OPTIONS=--max-old-space-size=640 --max-semi-space-size=16"`.
//   - A later assignment of a name replaces an earlier one (the last one wins); an empty `Environment=` drops every
//     assignment before it. `%%` is a literal `%`.
//   - A line that ends with a backslash goes on in the next line; lines starting with `#` or `;` are comments.
// Node then splits NODE_OPTIONS at spaces, keeping a double-quoted part together (doc/api/cli.md, NODE_OPTIONS).
//
// It refuses, naming the file and the line (exit 1 as a script): a unit without NODE_OPTIONS; an `Environment=` word
// that systemd would ignore (always a mistake, which a load test must not copy); what it does not model (a backslash
// escape, a specifier other than `%%`, an unterminated quote); and, as a script, a flag that would not come back the
// same when Node splits the printed line. On the VM an `EnvironmentFile=` could override `Environment=`: the env files
// set no NODE_OPTIONS (unit-node-options.test.mjs checks deploy/env/*.env.example).
//
// Plain Node, no dependency. Tests: node --test tools/perf/unit-node-options.test.mjs.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One MiB in bytes: the unit of V8's heap flags. */
const MIB = 1_048_576;
/** systemd's size suffixes, base 1024 (systemd.resource-control(5)). */
const SIZE_SUFFIXES = Object.freeze({ "": 1, K: 1024, M: MIB, G: 1024 * MIB, T: 1024 * 1024 * MIB });
/** A variable name systemd accepts in an assignment. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMENT = /^\s*[#;]/;

/** A problem in a unit file. Its message starts with `<file>:<line>: `, or `<file>: ` for the whole file. */
class UnitFileError extends Error {
  constructor(file, line, message) {
    super(`${file}${line ? `:${line}` : ""}: ${message}`);
    this.name = "UnitFileError";
    this.file = file;
    this.line = line;
  }
}

/** True when a line ends with a backslash that is not itself escaped: it goes on in the next line. */
function continues(line) {
  return /(?:^|[^\\])(?:\\\\)*\\$/.test(line);
}

/**
 * The settings of a unit file's text, as systemd reads its lines: comments and blank lines dropped, a continued line
 * joined with the next ones (the backslash becomes a space). Each entry has `line` (its first line, from 1), `section`,
 * `key` and `value` (both trimmed).
 */
function unitLines(text) {
  const physical = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const settings = [];
  let section = "";
  for (let i = 0; i < physical.length; i++) {
    const first = i + 1;
    let line = physical[i];
    if (COMMENT.test(line)) {
      continue;
    }
    while (continues(line) && i + 1 < physical.length) {
      i += 1;
      if (!COMMENT.test(physical[i])) {
        line = `${line.slice(0, -1)} ${physical[i]}`;
      }
    }
    if (continues(line)) {
      line = line.slice(0, -1); // a continuation at the end of the file ends there
    }
    const trimmed = line.trim();
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1];
    } else if (trimmed.includes("=")) {
      const eq = trimmed.indexOf("=");
      settings.push({
        line: first,
        section,
        key: trimmed.slice(0, eq).trim(),
        value: trimmed.slice(eq + 1).trim(),
      });
    }
  }
  return settings;
}

/**
 * The words of an `Environment=` value as systemd splits them: `{ word, quoted }`, `quoted` when part of the word was
 * inside quotes. Throws an Error naming the problem for syntax this reader does not model.
 */
function splitWords(value) {
  const words = [];
  let i = 0;
  const skipSpace = () => {
    while (i < value.length && /\s/.test(value[i])) {
      i += 1;
    }
  };
  for (skipSpace(); i < value.length; skipSpace()) {
    let word = "";
    let quoted = false;
    while (i < value.length && !/\s/.test(value[i])) {
      const c = value[i];
      if (c === '"' || c === "'") {
        const end = value.indexOf(c, i + 1);
        if (end < 0) {
          throw new Error(`an unterminated ${c} quote`);
        }
        word += unescaped(value.slice(i + 1, end));
        quoted = true;
        i = end + 1;
      } else {
        const next = value.slice(i).search(/[\s"']/);
        const stop = next < 0 ? value.length : i + next;
        word += unescaped(value.slice(i, stop));
        i = stop;
      }
    }
    words.push({ word, quoted });
  }
  return words;
}

/** A part of a word with `%%` as `%`; throws for a backslash escape or another specifier, which it does not model. */
function unescaped(part) {
  if (part.includes("\\")) {
    throw new Error(`a backslash escape, which this reader does not model, in ${part}`);
  }
  if (part.replaceAll("%%", "").includes("%")) {
    throw new Error(`a specifier other than %%, which this reader does not model, in ${part}`);
  }
  return part.replaceAll("%%", "%");
}

/**
 * The environment the `Environment=` lines of a unit's [Service] section give its processes, as systemd builds it:
 * `variables` maps each name to `{ value, line, quoted, raw }` of its last assignment (`raw` is that line's whole
 * value), and `ignored` lists the words systemd would ignore (`{ line, word }`). `file` names the unit in errors.
 */
function unitEnvironment(text, file = "<unit>") {
  const variables = new Map();
  const ignored = [];
  for (const { line, section, key, value } of unitLines(text)) {
    if (section !== "Service" || key !== "Environment") {
      continue;
    }
    if (value === "") {
      variables.clear(); // an empty assignment resets the list (systemd.exec(5))
      continue;
    }
    let words;
    try {
      words = splitWords(value);
    } catch (error) {
      throw new UnitFileError(file, line, error.message);
    }
    for (const { word, quoted } of words) {
      const eq = word.indexOf("=");
      if (eq <= 0 || !NAME.test(word.slice(0, eq))) {
        ignored.push({ line, word });
      } else {
        variables.set(word.slice(0, eq), { value: word.slice(eq + 1), line, quoted, raw: value });
      }
    }
  }
  return { variables, ignored };
}

/**
 * NODE_OPTIONS split into flags as Node splits it (src/node_options.cc, ParseNodeOptionsEnvVar): at spaces, a
 * double-quoted part kept together, a backslash inside quotes taking the next character as it is.
 */
function nodeOptionsFlags(value) {
  const flags = [];
  let inString = false;
  let newFlag = true;
  for (let i = 0; i < value.length; i++) {
    let c = value[i];
    if (c === "\\" && inString) {
      if (i + 1 === value.length) {
        throw new Error(`an escape at the end of NODE_OPTIONS=${value}`);
      }
      i += 1;
      c = value[i];
    } else if (c === " " && !inString) {
      newFlag = true;
      continue;
    } else if (c === '"') {
      inString = !inString;
      continue;
    }
    if (newFlag) {
      flags.push(c);
      newFlag = false;
    } else {
      flags[flags.length - 1] += c;
    }
  }
  if (inString) {
    throw new Error(`an unterminated " in NODE_OPTIONS=${value}`);
  }
  return flags;
}

/**
 * The NODE_OPTIONS of a unit file's text: `{ flags, value, line, quoted, raw }` of its last assignment. Throws a
 * UnitFileError (the file and the line) when the unit sets none or systemd would ignore a word of an `Environment=`
 * line.
 */
function parseUnitNodeOptions(text, file = "<unit>") {
  const { variables, ignored } = unitEnvironment(text, file);
  if (ignored.length > 0) {
    const { line, word } = ignored[0];
    throw new UnitFileError(
      file,
      line,
      `systemd ignores the word "${word}" of this Environment= line (not one NAME=value assignment): quote the ` +
        `whole assignment, Environment="NODE_OPTIONS=--max-old-space-size=<MiB> --max-semi-space-size=<MiB>"`,
    );
  }
  const assignment = variables.get("NODE_OPTIONS");
  if (!assignment) {
    throw new UnitFileError(file, 0, "no Environment= line of [Service] sets NODE_OPTIONS");
  }
  let flags;
  try {
    flags = nodeOptionsFlags(assignment.value);
  } catch (error) {
    throw new UnitFileError(file, assignment.line, error.message);
  }
  return { ...assignment, flags };
}

/** The flags of a unit file's NODE_OPTIONS (parseUnitNodeOptions), for a process started as the unit starts it. */
function unitNodeOptions(path) {
  return parseUnitNodeOptions(readFileSync(path, "utf8"), path).flags;
}

/** `MemoryMax=` of a unit file's text in bytes (its last one in [Service]), or null when it sets none or `infinity`. */
function parseUnitMemoryMax(text, file = "<unit>") {
  const found = unitLines(text)
    .filter(({ section, key }) => section === "Service" && key === "MemoryMax")
    .at(-1);
  if (!found || found.value === "" || found.value === "infinity") {
    return null;
  }
  const match = /^(\d+)([KMGT]?)$/.exec(found.value);
  if (!match) {
    throw new UnitFileError(file, found.line, `MemoryMax=${found.value} is not a size this reader models`);
  }
  return Number(match[1]) * SIZE_SUFFIXES[match[2]];
}

/**
 * The value of the last `--<name>=<n>` among the flags (V8 takes the last; `_` and `-` are the same to it), or null.
 * Throws for a value that is not a whole number.
 */
function flagValue(flags, name) {
  let value = null;
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq > 0 && flag.slice(0, eq).replaceAll("_", "-") === `--${name}`) {
      if (!/^\d+$/.test(flag.slice(eq + 1))) {
        throw new Error(`${flag} is not a whole number of MiB`);
      }
      value = Number(flag.slice(eq + 1));
    }
  }
  return value;
}

/**
 * Checks an app unit file as X-050 requires (ADR-0029 item 5): its NODE_OPTIONS is one quoted assignment on its own
 * line, `Environment="NODE_OPTIONS=…"`, that sets `--max-old-space-size` and `--max-semi-space-size`, and V8's heap
 * limit with them, old + 3 x semi MiB, stays below the unit's MemoryMax. "On its own line" means the whole physical
 * line, as the units smoke test reads it (deploy/systemd/test/units-smoke.sh: no indentation, no continuation). A
 * value of 0 counts as none: V8 then sizes that generation itself. Returns `{ flags, line, oldMiB, semiMiB,
 * heapLimitMiB, memoryMaxBytes }`; throws a UnitFileError naming the file and the line otherwise.
 */
function checkAppUnit(text, file = "<unit>") {
  const options = parseUnitNodeOptions(text, file);
  const fail = (message) => {
    throw new UnitFileError(file, options.line, message);
  };
  const physical = text.split("\n")[options.line - 1].replace(/\r$/, "");
  if (
    !options.quoted ||
    options.raw !== `"NODE_OPTIONS=${options.value}"` ||
    physical !== `Environment=${options.raw}`
  ) {
    fail(
      `NODE_OPTIONS is not one quoted assignment on its own line: Environment="NODE_OPTIONS=${options.value}"`,
    );
  }
  let oldMiB = null;
  let semiMiB = null;
  try {
    oldMiB = flagValue(options.flags, "max-old-space-size");
    semiMiB = flagValue(options.flags, "max-semi-space-size");
  } catch (error) {
    fail(error.message);
  }
  if (!oldMiB) {
    fail(`NODE_OPTIONS=${options.value} sets no --max-old-space-size (0 counts as none)`);
  }
  if (!semiMiB) {
    fail(`NODE_OPTIONS=${options.value} sets no --max-semi-space-size (0 counts as none)`);
  }
  const memoryMaxBytes = parseUnitMemoryMax(text, file);
  if (memoryMaxBytes === null) {
    throw new UnitFileError(file, 0, "the unit sets no MemoryMax in [Service]");
  }
  const heapLimitMiB = oldMiB + 3 * semiMiB;
  if (heapLimitMiB * MIB >= memoryMaxBytes) {
    fail(
      `V8's heap limit ${oldMiB} + 3 x ${semiMiB} = ${heapLimitMiB} MiB is not below MemoryMax ` +
        `(${memoryMaxBytes / MIB} MiB)`,
    );
  }
  return { flags: options.flags, line: options.line, oldMiB, semiMiB, heapLimitMiB, memoryMaxBytes };
}

/** The script: prints the flags of the unit file it is given on one line, space-separated. Returns the exit code. */
function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    process.stderr.write("usage: node tools/perf/unit-node-options.mjs <unit file>\n");
    return 2;
  }
  try {
    const flags = unitNodeOptions(argv[0]);
    const unsafe = flags.find((flag) => flag === "" || /[\s"\\]/.test(flag));
    if (unsafe !== undefined) {
      throw new Error(
        `${argv[0]}: the flag ${JSON.stringify(unsafe)} would not survive Node's splitting at spaces`,
      );
    }
    process.stdout.write(`${flags.join(" ")}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`unit-node-options: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** True when Node runs this file itself: it is the script Node was started with (symbolic links resolved). */
function isProgram() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

export {
  MIB,
  UnitFileError,
  checkAppUnit,
  main,
  nodeOptionsFlags,
  parseUnitMemoryMax,
  parseUnitNodeOptions,
  splitWords,
  unitEnvironment,
  unitLines,
  unitNodeOptions,
};

if (isProgram()) {
  process.exitCode = main(process.argv.slice(2));
}
