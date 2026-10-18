// Runtime parity of the SDK with the working OpenAPI document (OADR-0016 point 4, ota/sdk/docs/types-and-builds.md §4
// point 5, ota/sdk/README.md §6 point 5, task SDK-006): the set of `x-sdk-method` names of the document (without
// `x-internal` and `x-sdk-exclude` operations) equals the set of methods of a client instance, except what an entry of
// pending-namespaces.js covers; `withOptions` and `request` are the only other members. The pending list itself is
// checked: every entry names an SDK task, covers at least one method of the document, is a whole namespace or one
// method of an implemented namespace, and still has something to add. SDK-013 empties the list.
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createVelexisClient } from "../../src/index.js";
import { PENDING } from "./pending-namespaces.js";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
/** The working contract, which grows with the spec tasks. */
const DOCUMENT = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
/** The client's members besides its namespaces (index.d.ts `VelexisClient`). */
const CLIENT_FUNCTIONS = ["request", "withOptions"];
/** An SDK task of the plan (ota/docs/plans/agent-tasks.md). */
const SDK_TASK = /^SDK-\d{3}$/;
/** A fake key with the right shape; it works nowhere, and no test sends a request. */
const PK = "pk_test_sdk006_fake";

/**
 * Parsing the working document takes about half a second alone, and more than Vitest's 10 s hook default while
 * Turborepo runs every package's tests at once on a CI runner, so the hook gets its own budget.
 */
const PARSE_TIMEOUT_MS = 60_000;

/** The child process that loads a mutated copy of the SDK starts Node and loads about 20 small modules. */
const CHILD_TIMEOUT_MS = 30_000;
/** How the child process marks a function in its JSON output. */
const FUNCTION = "[function]";

/** The `x-sdk-method` names of a parsed document, without `x-internal` and `x-sdk-exclude` operations. */
function sdkMethodsOf(document) {
  const methods = [];
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (
        operation !== undefined &&
        typeof operation["x-sdk-method"] === "string" &&
        operation["x-internal"] !== true &&
        operation["x-sdk-exclude"] !== true
      ) {
        methods.push(operation["x-sdk-method"]);
      }
    }
  }
  return methods.sort();
}

/**
 * The members of a client: the dotted path of every method of its namespaces, its top-level functions, and anything
 * that is neither a function nor an object of them.
 */
function membersOf(client) {
  const methods = [];
  const others = [];
  const walk = (object, prefix) => {
    for (const [name, value] of Object.entries(object)) {
      const path = `${prefix}.${name}`;
      if (typeof value === "function") {
        methods.push(path);
      } else if (value !== null && typeof value === "object") {
        walk(value, path);
      } else {
        others.push(path);
      }
    }
  };
  const functions = [];
  for (const [name, value] of Object.entries(client)) {
    if (typeof value === "function") {
      functions.push(name);
    } else if (value !== null && typeof value === "object") {
      walk(value, name);
    } else {
      others.push(name);
    }
  }
  return { methods: methods.sort(), functions: functions.sort(), others };
}

/** Whether a pending entry (a namespace or a method) covers a method. */
const covers = (entry, method) => method === entry || method.startsWith(`${entry}.`);

/**
 * The parity of a document and a client under a pending list: the document's methods the client lacks and no entry
 * covers, the client's methods the document lacks (never allowed, pending or not), and what is wrong with the list.
 */
function parity({ documentMethods, clientMethods, pending }) {
  const inDocument = new Set(documentMethods);
  const inClient = new Set(clientMethods);
  const clientNamespaces = new Set(clientMethods.map((method) => method.split(".")[0]));
  const isPending = (method) => pending.some(({ entry }) => covers(entry, method));
  const missing = documentMethods.filter((method) => !inClient.has(method) && !isPending(method));
  const extra = clientMethods.filter((method) => !inDocument.has(method));

  const problems = [];
  const seen = new Set();
  for (const item of pending) {
    const { entry, task } = item;
    if (typeof entry !== "string" || typeof task !== "string" || !SDK_TASK.test(task)) {
      problems.push(`${JSON.stringify(item)}: needs an entry and the SDK task that adds it`);
      continue;
    }
    if (seen.has(entry)) {
      problems.push(`${entry}: listed twice`);
    }
    seen.add(entry);
    const covered = documentMethods.filter((method) => covers(entry, method));
    if (entry.includes(".")) {
      const namespace = entry.split(".")[0];
      if (!inDocument.has(entry)) {
        problems.push(`${entry}: neither a namespace nor an x-sdk-method of the document`);
      } else if (pending.some((other) => other.entry === namespace)) {
        problems.push(`${entry}: its namespace ${namespace} is pending as a whole`);
      } else if (!clientNamespaces.has(namespace)) {
        problems.push(`${entry}: the client has no ${namespace} namespace yet; list the namespace instead`);
      }
    } else if (covered.length === 0) {
      problems.push(`${entry}: no x-sdk-method of the document is in this namespace`);
    }
    if (covered.length > 0 && covered.every((method) => inClient.has(method))) {
      problems.push(`${entry}: the client already has all of it; ${task} removes the entry`);
    }
  }
  return { missing, extra, problems };
}

let documentMethods = [];

beforeAll(() => {
  documentMethods = sdkMethodsOf(parse(readFileSync(DOCUMENT, "utf8")));
}, PARSE_TIMEOUT_MS);

describe("the client and the working document", () => {
  it("have the same methods, except what pending-namespaces.js lists [SDK-006 AC2]", () => {
    const { methods } = membersOf(createVelexisClient({ publishableKey: PK }));
    expect(parity({ documentMethods, clientMethods: methods, pending: PENDING })).toEqual({
      missing: [],
      extra: [],
      problems: [],
    });
  });

  it("has withOptions and request as the only members besides the namespaces", () => {
    const client = createVelexisClient({ publishableKey: PK });
    const { methods, functions, others } = membersOf(client);
    expect(functions).toEqual(CLIENT_FUNCTIONS);
    expect(others).toEqual([]);
    // Every namespace holds at least one method; withOptions makes a client with the same methods.
    for (const [name, value] of Object.entries(client)) {
      if (typeof value !== "function") {
        expect(
          methods.some((method) => method.startsWith(`${name}.`)),
          name,
        ).toBe(true);
      }
    }
    expect(membersOf(client.withOptions({ locale: "de-DE" })).methods).toEqual(methods);
  });
});

describe("the parity check", () => {
  const scratch = mkdtempSync(join(tmpdir(), "sdk-006-parity-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** @type {{ status: number, stdout: string, stderr: string }} */
  let removed;

  // A copy of src/ whose flights namespace has lost getFareRules, loaded as the SDK by a plain Node process (Vitest
  // serves no module from outside the package) that prints the client with every function as a marker. Starting the
  // process is slow on a busy CI runner, so the hook gets its own budget.
  beforeAll(async () => {
    const src = join(scratch, "src");
    cpSync(join(SDK_ROOT, "src"), src, { recursive: true });
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ type: "module" }));
    const flights = join(src, "namespaces", "flights.js");
    const method =
      "    getFareRules: (params, options) => core.call(op.flights_getFareRules, params, live(options)),\n";
    const text = readFileSync(flights, "utf8");
    expect(text.split(method)).toHaveLength(2);
    writeFileSync(flights, text.replace(method, ""));
    const script = [
      `import { createVelexisClient } from ${JSON.stringify(pathToFileURL(join(src, "index.js")).href)};`,
      `const client = createVelexisClient({ publishableKey: ${JSON.stringify(PK)} });`,
      `const marked = (key, value) => (typeof value === "function" ? ${JSON.stringify(FUNCTION)} : value);`,
      "process.stdout.write(JSON.stringify(client, marked));",
    ].join("\n");
    removed = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
        (error, stdout, stderr) => {
          resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
        },
      );
    });
  }, 2 * CHILD_TIMEOUT_MS);

  it("fails when a method is removed from flights.js [SDK-006 AC2]", () => {
    expect(removed.status, removed.stderr).toBe(0);
    const client = JSON.parse(removed.stdout, (key, value) => (value === FUNCTION ? () => undefined : value));
    const { methods } = membersOf(client);
    expect(methods).toContain("flights.search");
    expect(methods).not.toContain("flights.getFareRules");
    expect(parity({ documentMethods, clientMethods: methods, pending: PENDING })).toEqual({
      missing: ["flights.getFareRules"],
      extra: [],
      problems: [],
    });
  });

  // The rules on a small made-up document and client, so these tests do not change as the SDK grows.
  const DOCUMENT_METHODS = ["alpha.get", "alpha.list", "beta.get", "beta.list", "beta.sub.get", "gamma.get"];
  /** The client has alpha and beta.get; beta.list, beta.sub.get and gamma.get are not written yet. */
  const CLIENT_METHODS = ["alpha.get", "alpha.list", "beta.get"];
  const check = (pending, clientMethods = CLIENT_METHODS) =>
    parity({ documentMethods: DOCUMENT_METHODS, clientMethods, pending });

  it("passes when every method the client lacks is covered by a namespace or a method entry", () => {
    expect(
      check([
        { entry: "beta.list", task: "SDK-012" },
        { entry: "beta.sub.get", task: "SDK-012" },
        { entry: "gamma", task: "SDK-011" },
      ]),
    ).toEqual({ missing: [], extra: [], problems: [] });
  });

  it("fails on a method the client lacks that no entry covers, and on a whole missing namespace", () => {
    expect(check([{ entry: "beta.list", task: "SDK-012" }]).missing).toEqual(["beta.sub.get", "gamma.get"]);
  });

  it("fails when the client has a method that the document does not, even in a pending namespace", () => {
    const result = check(
      [{ entry: "gamma", task: "SDK-011" }],
      [...CLIENT_METHODS, "alpha.teleport", "gamma.teleport"],
    );
    expect(result.extra).toEqual(["alpha.teleport", "gamma.teleport"]);
  });

  it("refuses a pending entry whose methods the client already has: its task removes it", () => {
    const pending = [
      { entry: "beta.list", task: "SDK-012" },
      { entry: "beta.sub.get", task: "SDK-012" },
      { entry: "gamma", task: "SDK-011" },
    ];
    expect(check([...pending, { entry: "alpha", task: "SDK-005" }]).problems).toEqual([
      "alpha: the client already has all of it; SDK-005 removes the entry",
    ]);
    expect(check([...pending, { entry: "beta.get", task: "SDK-012" }]).problems).toEqual([
      "beta.get: the client already has all of it; SDK-012 removes the entry",
    ]);
  });

  it("keeps a namespace entry while the client has only part of it (SDK-011 and console)", () => {
    expect(
      check(
        [
          { entry: "beta", task: "SDK-012" },
          { entry: "gamma", task: "SDK-011" },
        ],
        CLIENT_METHODS,
      ),
    ).toEqual({ missing: [], extra: [], problems: [] });
  });

  it.each([
    [{ entry: "delta", task: "SDK-099" }, "delta: no x-sdk-method of the document is in this namespace"],
    [
      { entry: "alpha.teleport", task: "SDK-012" },
      "alpha.teleport: neither a namespace nor an x-sdk-method of the document",
    ],
    [
      { entry: "beta.sub", task: "SDK-012" },
      "beta.sub: neither a namespace nor an x-sdk-method of the document",
    ],
    [{ entry: "gamma.get", task: "SDK-011" }, "gamma.get: its namespace gamma is pending as a whole"],
    [{ entry: "gamma", task: "SDK-011" }, "gamma: listed twice"],
    [{ entry: "beta.list" }, '{"entry":"beta.list"}: needs an entry and the SDK task that adds it'],
    [
      { entry: "beta.list", task: "OBE-091" },
      '{"entry":"beta.list","task":"OBE-091"}: needs an entry and the SDK task that adds it',
    ],
  ])("refuses the pending entry %j", (extra, problem) => {
    const pending = [
      { entry: "beta.list", task: "SDK-012" },
      { entry: "beta.sub.get", task: "SDK-012" },
      { entry: "gamma", task: "SDK-011" },
    ];
    expect(check([...pending, extra]).problems).toEqual([problem]);
  });

  it("refuses a single method of a namespace that the client does not have yet", () => {
    const pending = [
      { entry: "beta.list", task: "SDK-012" },
      { entry: "beta.sub.get", task: "SDK-012" },
      { entry: "gamma.get", task: "SDK-011" },
    ];
    expect(check(pending)).toEqual({
      missing: [],
      extra: [],
      problems: ["gamma.get: the client has no gamma namespace yet; list the namespace instead"],
    });
  });
});

describe("pending-namespaces.js", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(PENDING)).toBe(true);
    for (const entry of PENDING) {
      expect(Object.isFrozen(entry), entry.entry).toBe(true);
    }
  });
});
