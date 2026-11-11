// A reader for the shape of the workflows in .github/workflows, for the tests of tools/ci (task X-019; shared since
// FIX-W48-SHARED). Prettier keeps the two-space indentation of the workflows stable, so this reads them by indentation
// without a YAML package: tools/ci needs no install (README.md).

/** `lines` without their common indentation, joined; trailing blank lines dropped. */
export function dedent(lines) {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => l.match(/^ */)[0].length);
  const cut = Math.min(...indents);
  return lines
    .map((l) => l.slice(cut))
    .join("\n")
    .trimEnd();
}

/** The fields of one step (`name`, `uses`, `run`, ...); `run: |` blocks are dedented. */
export function stepFields(lines) {
  const fields = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^ {8}([a-z-]+):(?: (.*))?$/);
    if (!m) {
      continue;
    }
    const value = (m[2] ?? "").replace(/\s+#.*$/, "");
    if (value === "|") {
      const block = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^ {10}/.test(lines[i + 1]))) {
        block.push(lines[(i += 1)]);
      }
      fields[m[1]] = dedent(block);
    } else {
      fields[m[1]] = value;
    }
  }
  return fields;
}

/** jobId -> { lines, steps: [{ name, uses, run, ..., raw }] }; `raw` holds a step's own lines as written. */
export function parseWorkflow(text) {
  const jobs = new Map();
  let inJobs = false;
  let job = null;
  for (const line of text.split("\n")) {
    if (/^[^\s#]/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      job = null;
    } else if (inJobs && /^ {2}[\w-]+:\s*$/.test(line)) {
      job = { lines: [], steps: [] };
      jobs.set(line.trim().slice(0, -1), job);
    } else if (job) {
      job.lines.push(line);
    }
  }
  for (const current of jobs.values()) {
    let inSteps = false;
    let step = null;
    for (const line of current.lines) {
      if (/^ {4}[^\s#]/.test(line)) {
        inSteps = /^ {4}steps:\s*$/.test(line);
        step = null;
      } else if (inSteps && /^ {6}- /.test(line)) {
        step = [line.replace(/^ {6}- /, " ".repeat(8))];
        current.steps.push(step);
      } else if (inSteps && step) {
        step.push(line);
      }
    }
    current.steps = current.steps.map((lines) => ({ ...stepFields(lines), raw: lines }));
  }
  return jobs;
}

/** The lines of a job's own key (`services`, `env`, `timeout-minutes`, ...) as written, or [] when it has none. */
export function jobKeyOf(jobs, job, key) {
  const lines = jobs.get(job)?.lines ?? [];
  const at = lines.findIndex((line) => line === `    ${key}:` || line.startsWith(`    ${key}: `));
  if (at < 0) {
    return [];
  }
  const block = [lines[at]];
  for (let i = at + 1; i < lines.length && /^ {6}/.test(lines[i]); i += 1) {
    block.push(lines[i]);
  }
  return block;
}

/** The `with:` inputs of a step, as written. */
export function withOf(step) {
  const at = step.raw.findIndex((line) => /^ {8}with:\s*$/.test(line));
  const inputs = [];
  for (let i = at + 1; at >= 0 && i < step.raw.length && /^ {10}/.test(step.raw[i]); i += 1) {
    inputs.push(step.raw[i].trim());
  }
  return inputs;
}

/** A value as written after `key: `, without a trailing comment and without the quotes around a quoted scalar. */
export function scalar(value) {
  const bare = value.replace(/\s+#.*$/, "").trim();
  const quoted = bare.match(/^"(.*)"$/) ?? bare.match(/^'(.*)'$/);
  return quoted ? quoted[1] : bare;
}

/**
 * The `name: value` children of a block, as an object: the lines right under its key line (`lines[0]`) at its
 * indentation plus two; deeper lines belong to a child and are left out.
 */
export function mapOf(lines) {
  const indent = (lines[0] ?? "").match(/^ */)[0].length + 2;
  const map = {};
  for (const line of lines.slice(1)) {
    const m = line.match(new RegExp(`^ {${indent}}([\\w-]+):(?: (.*))?$`));
    if (m) {
      map[m[1]] = scalar(m[2] ?? "");
    }
  }
  return map;
}

/** The lines of a step's own key (`env`, `with`), as written, or [] when it has none. */
export function stepKey(step, key) {
  const at = step.raw.findIndex((line) => line === `        ${key}:` || line.startsWith(`        ${key}: `));
  if (at < 0) {
    return [];
  }
  const block = [step.raw[at]];
  for (let i = at + 1; i < step.raw.length && /^ {10}/.test(step.raw[i]); i += 1) {
    block.push(step.raw[i]);
  }
  return block;
}

/** The lines of a top-level key (`on`, `concurrency`, `permissions`), as written, or [] when it has none. */
export function topLevel(text, key) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (at < 0) {
    return [];
  }
  const block = [lines[at]];
  for (let i = at + 1; i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i])); i += 1) {
    if (lines[i].trim() !== "") {
      block.push(lines[i]);
    }
  }
  return block;
}

/** The lines of `key:` inside `lines` (a block that `topLevel`, `jobKeyOf` or `stepKey` returned), or []. */
export function childBlock(lines, key) {
  const at = lines.findIndex((line) => new RegExp(`^ *${key}:(?: |$)`).test(line));
  if (at < 0) {
    return [];
  }
  const indent = lines[at].match(/^ */)[0].length;
  const block = [lines[at]];
  for (let i = at + 1; i < lines.length && lines[i].match(/^ */)[0].length > indent; i += 1) {
    block.push(lines[i]);
  }
  return block;
}
