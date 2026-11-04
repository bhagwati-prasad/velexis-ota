// Redaction coverage (OBE-084 step 3; ota/docs/security-review.md §3.4, ADR-0016, conventions §7, db README §8,
// architecture §4 "Redaction" and §9): every property of the OTA document that is sensitive is redacted wherever a copy
// of it can end up. "Sensitive" is decided from the document and the central list, never by hand:
//
//   - every property of a schema marked `x-sensitive: true` (the airline card) and every property below it;
//   - every property whose name is in the central redaction list (`REDACT_PATHS` of @velexis/logger: passwords, tokens,
//     secrets, card fields, bank numbers, …), wherever the document has it;
//   - the identity-document numbers of the list's literal paths (`documents[].number`, `formOfIdentifications[].number`)
//     and the numbers of a `card` or `creditCard`.
//
// Each such property gets a sample payload that holds a marker value at its place in its schema (from the schema's
// root, arrays as one item), and the marker may not survive (at most the last 4 characters the masking keeps) in:
//
//   logs               the processes' pino logger (`createLogger`, REDACT_PATHS), with the property's redaction anchor
//                      (itself, or the nearest ancestor the list names: `card`, `documents`, …) at the top level of a
//                      log line and one level down, the depths log lines carry objects at
//   supplier_requests  `supplierRequestBody`, the request and response columns (amadeus/supplier-requests.repository.ts)
//   staff_actions      `staffActionRow`, the `before` and `after` columns (console/staff-actions.writer.ts)
//   idempotency_keys   `plainCopyOf`, the plain `response_body` copy, and the answer is then kept encrypted
//                      (common/http/idempotency.service.ts)
//   payment_events     `redactPayload`, which every writer of a copied payload calls, and `storedPayloadOf`, which keeps
//                      only the event's ids, statuses and amounts (payments/webhooks/webhook-receiver.service.ts)
//   notifications      no template takes a sensitive variable into `notifications.payload` (the caller variables of
//                      notifications/templates/registry.ts); secrets go to `secretData`, which is encrypted, and
//                      OutboxService refuses data the redactor would change
//
// Two documented exceptions hold for the persisted copies only (logs censor them too): a card's `brand` is kept (a stored
// card keeps its brand, BIN and last 4; OADR-0004 point 2), and an identity document's `holder` flag and `expiryDate`
// outside a card are kept (db README §8 drops a card's holder and expiry, not a passport's). The last test fails when a
// new writer of one of the five tables appears, so that its redaction is reviewed and listed here.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Writable } from "node:stream";
import { createLogger, REDACT_PATHS, redactPayload } from "@velexis/logger";
import type Stripe from "stripe";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { supplierRequestBody } from "../../src/amadeus/supplier-requests.repository";
import { plainCopyOf } from "../../src/common/http/idempotency.service";
import { APP_DIR } from "../../src/config";
import { staffActionRow } from "../../src/console/staff-actions.writer";
import { callerVariables, TEMPLATE_KEYS } from "../../src/notifications/templates/registry";
import { eventFactsOf, storedPayloadOf } from "../../src/payments/webhooks/webhook-receiver.service";

type JsonObject = Record<string, unknown>;

const DOCUMENT_FILE = join(APP_DIR, "openapi", "velexis-ota-booking-api.openapi.yaml");
/** Parsing the 40,000-line document and walking every schema: a few seconds on a busy runner. */
const DOCUMENT_TIMEOUT_MS = 60_000;

/** The names the central list censors at the top level of a log line (its depth-1 paths). */
const CENTRAL_NAMES: ReadonlySet<string> = new Set(REDACT_PATHS.filter((path) => /^[A-Za-z_]+$/.test(path)));
/** List parents whose items' `number` is an identity-document number (`documents[*].number`, …). */
const DOCUMENT_LISTS: ReadonlySet<string> = new Set(
  REDACT_PATHS.flatMap((path) => {
    const match = /^([A-Za-z]+)\[\*\]\.number$/.exec(path);
    return match?.[1] === undefined ? [] : [match[1]];
  }),
);
/** Parents whose `number` is a card number (`*.card.number`, `*.creditCard.number`). */
const CARD_PARENTS: ReadonlySet<string> = new Set(
  REDACT_PATHS.flatMap((path) => {
    const match = /^\*\.([A-Za-z]+)\.number$/.exec(path);
    return match?.[1] === undefined ? [] : [match[1]];
  }),
);

/** One step from a schema's root to a property: a property name, or an array's item. */
type Segment = { readonly name: string } | { readonly item: true };

/** Why a property is sensitive. */
type Reason = "x-sensitive" | "central list" | "document number" | "card number";

/** One sensitive property of the document, at one place. */
interface Occurrence {
  /** The schema it was found from (`components.schemas` name, or `<operationId> <request|status>`). */
  readonly root: string;
  readonly path: readonly Segment[];
  readonly reason: Reason;
  /**
   * An object or a list (`card`, `creditCard`, `formOfPayments`): a log line censors it whole, and a persisted copy
   * is checked through its own sensitive properties, each an occurrence of its own.
   */
  readonly container: boolean;
}

const nameOf = (segment: Segment): string | undefined => ("name" in segment ? segment.name : undefined);
const names = (path: readonly Segment[]): string[] =>
  path.flatMap((segment) => (nameOf(segment) === undefined ? [] : [nameOf(segment) as string]));
const label = (occurrence: Occurrence): string =>
  `${occurrence.root}.${occurrence.path.map((segment) => nameOf(segment) ?? "[]").join(".")}`.replace(
    /\.\[\]/g,
    "[]",
  );

let document: JsonObject;
const occurrences: Occurrence[] = [];

/** The value a local `$ref` (a JSON pointer such as `#/components/schemas/AmadeusFlightOrder/properties/tickets`) names. */
function resolveRef(ref: string): unknown {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>(
      (node, token) => (node !== null && typeof node === "object" ? (node as JsonObject)[token] : undefined),
      document,
    );
}

/** Walks every schema of the document and records each sensitive property (see the file header). */
function collect(): void {
  const schemas = ((document["components"] as JsonObject)["schemas"] ?? {}) as Record<string, JsonObject>;
  /** (schema, parent name, inside x-sensitive) already walked: every context of a schema once. */
  const visited = new Set<string>();
  const seen = new Set<string>();

  /** Whether a schema (through its `$ref`s and compositions) is an object or a list. */
  const isContainer = (schema: unknown, depth = 0): boolean => {
    if (schema === null || typeof schema !== "object" || depth > 8) {
      return false;
    }
    const node = schema as JsonObject;
    if (typeof node["$ref"] === "string") {
      return isContainer(resolveRef(node["$ref"]), depth + 1);
    }
    const types = ([] as unknown[]).concat(node["type"] ?? []);
    if (types.includes("object") || types.includes("array") || "properties" in node || "items" in node) {
      return true;
    }
    return ["allOf", "oneOf", "anyOf"].some((keyword) =>
      ((node[keyword] as unknown[] | undefined) ?? []).some((part) => isContainer(part, depth + 1)),
    );
  };

  const record = (root: string, path: readonly Segment[], reason: Reason, property: unknown): void => {
    const occurrence: Occurrence = { root, path, reason, container: isContainer(property) };
    if (!seen.has(label(occurrence))) {
      seen.add(label(occurrence));
      occurrences.push(occurrence);
    }
  };

  const walk = (root: string, schema: unknown, path: readonly Segment[], sensitive: boolean): void => {
    if (schema === null || typeof schema !== "object") {
      return;
    }
    const node = schema as JsonObject;
    if (typeof node["$ref"] === "string") {
      const target = node["$ref"];
      const parent = names(path).at(-1) ?? "";
      const context = `${target}|${parent}|${String(sensitive)}`;
      if (visited.has(context) || path.length > 12) {
        return;
      }
      visited.add(context);
      walk(root, resolveRef(target), path, sensitive);
      return;
    }
    const inSensitive = sensitive || node["x-sensitive"] === true;
    for (const keyword of ["allOf", "oneOf", "anyOf"]) {
      for (const part of (node[keyword] as unknown[] | undefined) ?? []) {
        walk(root, part, path, inSensitive);
      }
    }
    if (node["items"] !== undefined) {
      walk(root, node["items"], [...path, { item: true }], inSensitive);
    }
    if (node["additionalProperties"] !== undefined && typeof node["additionalProperties"] === "object") {
      walk(root, node["additionalProperties"], [...path, { name: "additional" }], inSensitive);
    }
    for (const [name, property] of Object.entries((node["properties"] ?? {}) as Record<string, unknown>)) {
      const here: Segment[] = [...path, { name }];
      const parent = names(path).at(-1);
      const propertySensitive =
        inSensitive || (property !== null && (property as JsonObject)["x-sensitive"] === true);
      if (propertySensitive) {
        record(root, here, "x-sensitive", property);
      } else if (CENTRAL_NAMES.has(name)) {
        record(root, here, "central list", property);
      } else if (name === "number" && parent !== undefined && DOCUMENT_LISTS.has(parent)) {
        record(root, here, "document number", property);
      } else if (name === "number" && parent !== undefined && CARD_PARENTS.has(parent)) {
        record(root, here, "card number", property);
      }
      walk(root, property, here, propertySensitive);
    }
  };

  for (const [name, schema] of Object.entries(schemas)) {
    visited.clear();
    walk(name, schema, [], false);
  }
  // Inline schemas of the operations' bodies and answers.
  for (const [path, item] of Object.entries(document["paths"] as Record<string, JsonObject>)) {
    for (const [method, operation] of Object.entries(item)) {
      const spec = operation as JsonObject;
      if (typeof spec?.["operationId"] !== "string") {
        continue;
      }
      const id = String(spec["operationId"]);
      const bodies: Array<[string, unknown]> = [
        [`${id} request`, (spec["requestBody"] as JsonObject | undefined)?.["content"]],
        ...Object.entries((spec["responses"] ?? {}) as Record<string, JsonObject>).map(
          ([status, response]) => [`${id} ${status}`, response?.["content"]] as [string, unknown],
        ),
      ];
      for (const [root, content] of bodies) {
        for (const media of Object.values((content ?? {}) as Record<string, JsonObject>)) {
          visited.clear();
          walk(root, media?.["schema"], [], false);
        }
      }
      void path;
      void method;
    }
  }
}

// ---- Samples ---------------------------------------------------------------------------------------------------------

/** A marker no other occurrence uses; its last 4 characters are digits, so masking may keep them and nothing else. */
const markerOf = (index: number): string => `Mk${index}x${(index * 7919).toString(36)}q4815`;
/** The part of a marker that must never survive: all but the last 4 characters. */
const headOf = (marker: string): string => marker.slice(0, -4);

/** The value of `path` built from its innermost value outwards: objects for names, one-item arrays for items. */
function nest(path: readonly Segment[], value: unknown): unknown {
  return path.reduceRight<unknown>(
    (inner, segment) => ("item" in segment ? [inner] : { [segment.name]: inner }),
    value,
  );
}

/**
 * Where the central list censors the property in a log line: the nearest ancestor-or-self the list names (a card, a
 * documents list, the property itself), as the index of its segment; `undefined` when none does.
 */
function logAnchor(occurrence: Occurrence): number | undefined {
  for (let index = occurrence.path.length - 1; index >= 0; index -= 1) {
    const name = nameOf(occurrence.path[index] as Segment);
    if (name !== undefined && (CENTRAL_NAMES.has(name) || DOCUMENT_LISTS.has(name))) {
      return index;
    }
  }
  return undefined;
}

/** The persisted copies keep it on purpose (see the file header), or `undefined`. */
function keptInCopies(occurrence: Occurrence): string | undefined {
  const pathNames = names(occurrence.path);
  const name = pathNames.at(-1);
  const insideCard = pathNames
    .slice(0, -1)
    .some((entry) => CARD_PARENTS.has(entry) || entry === "formOfPayments");
  if (name === "brand" && insideCard) {
    return "a stored card keeps its brand (OADR-0004 point 2)";
  }
  if ((name === "holder" || name === "expiryDate") && !insideCard) {
    return "an identity document's holder flag and expiry stay (db README §8 drops a card's)";
  }
  return undefined;
}

// ---- Sinks -----------------------------------------------------------------------------------------------------------

/** What the logger below wrote last. */
let lastLine = "";
/** The processes' logger (`createLogger`: the central list), writing into `lastLine`; pino writes synchronously. */
const logger = createLogger({
  app: "ota-api",
  env: "test",
  destination: new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lastLine = chunk.toString("utf8");
      callback();
    },
  }),
});

/** A log line of the processes' logger for `object`, as written. */
function logged(object: JsonObject): string {
  lastLine = "";
  logger.info(object, "redaction.coverage");
  return lastLine;
}

/** The persisted copies of `sample`, by table, as the writers build them. */
function persistedCopies(sample: unknown): Record<string, string> {
  const staffRow = staffActionRow(
    "sact_01JA2Z9W5K7Q3M8N4P6RXYZAB0",
    { action: "bookings.update", before: sample, after: sample },
    { actor: { type: "system" }, requestId: null, ip: null, userAgent: null },
  );
  const plain = plainCopyOf({ status: 200, headers: {}, setCookie: [], body: sample });
  const event = {
    id: "evt_redaction_coverage",
    type: "payment_intent.succeeded",
    created: 1_767_225_600,
    livemode: false,
    data: {
      object: {
        id: "pi_redaction_coverage",
        object: "payment_intent",
        status: "succeeded",
        ...(sample as JsonObject),
      },
    },
  } as unknown as Stripe.Event;
  return {
    supplier_requests: String(supplierRequestBody(sample).json),
    "staff_actions.before": String(staffRow.before),
    "staff_actions.after": String(staffRow.after),
    "idempotency_keys.response_body": JSON.stringify(plain.body),
    "payment_events (copied payloads)": JSON.stringify(redactPayload(sample)),
    "payment_events (webhooks)": JSON.stringify(storedPayloadOf(event, eventFactsOf(event))),
  };
}

beforeAll(() => {
  document = parse(readFileSync(DOCUMENT_FILE, "utf8")) as JsonObject;
  collect();
}, DOCUMENT_TIMEOUT_MS);

describe("the sensitive properties of the OTA document", () => {
  it("[OBE-084 AC1] finds the airline card's x-sensitive fields and the document's properties the central list names", () => {
    const labels = occurrences.map(label);
    for (const field of ["brand", "holderName", "number", "expiryMonth", "expiryYear", "securityCode"]) {
      expect(labels).toContain(`AirlineCardCompletionRequest.card.${field}`);
    }
    const reasons = new Set(occurrences.map((occurrence) => occurrence.reason));
    expect([...reasons].sort()).toEqual(["card number", "central list", "document number", "x-sensitive"]);
    // The session tokens, the guest booking token and the password fields of the customer and console operations.
    for (const name of [
      "accessToken",
      "refreshToken",
      "bookingToken",
      "password",
      "newPassword",
      "currentPassword",
      "portalToken",
    ]) {
      expect([name, occurrences.some((occurrence) => names(occurrence.path).at(-1) === name)]).toEqual([
        name,
        true,
      ]);
    }
    expect(occurrences.length).toBeGreaterThan(40);
  });
});

describe("redaction of every sensitive property", () => {
  it("[OBE-084 AC1] censors each one in the log lines, at the top level and one level down", () => {
    // The sink sees every line: a value no rule touches is written as it is.
    expect(logged({ context: { bookingReference: "VISIBLE1" } })).toContain("VISIBLE1");
    const leaks: string[] = [];
    occurrences.forEach((occurrence, index) => {
      const anchor = logAnchor(occurrence);
      if (anchor === undefined) {
        leaks.push(`${label(occurrence)}: no name of the central list covers it in a log line`);
        return;
      }
      const marker = markerOf(index);
      const anchorName = nameOf(occurrence.path[anchor] as Segment) as string;
      const subtree = nest(occurrence.path.slice(anchor + 1), marker);
      for (const [depth, object] of [
        ["top level", { [anchorName]: subtree }],
        ["one level down", { context: { [anchorName]: subtree } }],
      ] as const) {
        if (logged(object).includes(headOf(marker))) {
          leaks.push(`${label(occurrence)} (${depth})`);
        }
      }
    });
    expect(leaks).toEqual([]);
  });

  it("[OBE-084 AC1] keeps each one out of supplier_requests, staff_actions, idempotency_keys and payment_events", () => {
    // Each copy keeps what no rule touches (the webhook copy keeps only its own allow-list).
    const visible = persistedCopies({ bookingReference: "VISIBLE2" });
    for (const [table, copy] of Object.entries(visible).filter(
      ([table]) => table !== "payment_events (webhooks)",
    )) {
      expect([table, copy.includes("VISIBLE2")]).toEqual([table, true]);
    }
    const leaks: string[] = [];
    occurrences.forEach((occurrence, index) => {
      if (occurrence.container || keptInCopies(occurrence) !== undefined) {
        return;
      }
      const marker = markerOf(index);
      const sample = nest(occurrence.path, marker);
      for (const [table, copy] of Object.entries(persistedCopies(sample))) {
        if (copy.includes(headOf(marker))) {
          leaks.push(`${label(occurrence)} in ${table}`);
        }
      }
    });
    expect(leaks).toEqual([]);
  });

  it("[OBE-084 AC1] keeps an answer with a sensitive value only encrypted in idempotency_keys (the plain copy is marked sensitive)", () => {
    const plainOnly: string[] = [];
    occurrences.forEach((occurrence, index) => {
      if (occurrence.container || keptInCopies(occurrence) !== undefined) {
        return;
      }
      const copy = plainCopyOf({
        status: 200,
        headers: {},
        setCookie: [],
        body: nest(occurrence.path, markerOf(index)),
      });
      if (!copy.sensitive) {
        plainOnly.push(label(occurrence));
      }
    });
    expect(plainOnly).toEqual([]);
  });

  it("[OBE-084 AC1] keeps every exception of the persisted copies to the two documented ones, and censors them in logs all the same", () => {
    const kept = occurrences.filter((occurrence) => keptInCopies(occurrence) !== undefined);
    expect(kept.length).toBeGreaterThan(0);
    for (const occurrence of kept) {
      expect([label(occurrence), names(occurrence.path).at(-1)]).toEqual([
        label(occurrence),
        expect.stringMatching(/^(brand|holder|expiryDate)$/),
      ]);
    }
  });

  it("[OBE-084 AC1] lets no e-mail template take a sensitive value into notifications.payload", () => {
    const offenders: string[] = [];
    for (const key of TEMPLATE_KEYS) {
      for (const variable of callerVariables(key)) {
        // `tickets[].number`: a list of objects with a `number`.
        const segments = variable.name.split(".");
        const probe = segments.reduceRight<unknown>((inner, segment) => {
          const name = segment.replace(/\[\]$/, "");
          return { [name]: segment.endsWith("[]") ? [inner] : inner };
        }, "probe-value");
        const listed = segments.some((segment) => CENTRAL_NAMES.has(segment.replace(/\[\]$/, "")));
        if (listed || JSON.stringify(redactPayload(probe)) !== JSON.stringify(probe)) {
          offenders.push(`${key}: ${variable.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- The writers of the five tables -------------------------------------------------------------------------------

/**
 * The files that insert into each table, and the redacting function every one of them builds its payload columns
 * with. A new writer fails the test until its redaction is reviewed and it is listed here.
 */
const WRITERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  supplier_requests: { "src/amadeus/supplier-requests.repository.ts": "supplierRequestBody(" },
  staff_actions: {
    "src/console/staff-actions.writer.ts": "staffActionRow(",
    "src/identity/staff/staff-auth.service.ts": "staffActionRow(",
  },
  idempotency_keys: { "src/common/http/idempotency.repository.ts": "responseBody" },
  // insertEvent and insertProviderEvent store what their callers built: redactPayload(...) of a copied payload,
  // storedPayloadOf(...) of a webhook, or an object of ids and codes; refunds.repository.ts writes ids and amounts only.
  payment_events: {
    "src/payments/payments.repository.ts": "insertEvent(",
    "src/payments/refunds.repository.ts": "refundId",
  },
  notifications: { "src/notifications/outbox.repository.ts": "payloadJson" },
};

/** Every TypeScript file of src/ but the tests, relative to the package. */
function sourceFiles(directory = join(APP_DIR, "src")): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [relative(APP_DIR, path)] : [];
  });
}

describe("the writers of the persisted copies", () => {
  it("[OBE-084 AC1] has no writer of supplier_requests, staff_actions, idempotency_keys, payment_events or notifications but the reviewed ones", () => {
    const files = sourceFiles();
    for (const [table, writers] of Object.entries(WRITERS)) {
      const found = files.filter((file) =>
        readFileSync(join(APP_DIR, file), "utf8").includes(`insertInto("${table}")`),
      );
      expect([table, found.sort()]).toEqual([table, Object.keys(writers).sort()]);
      for (const [file, marker] of Object.entries(writers)) {
        expect([file, readFileSync(join(APP_DIR, file), "utf8").includes(marker)]).toEqual([file, true]);
      }
    }
    // The services that feed the writers above: the redactor where a payload is a copy.
    const payments = readFileSync(join(APP_DIR, "src/payments/payments.service.ts"), "utf8");
    expect(payments).toContain("JSON.stringify(redactPayload(event.payload ?? {}))");
    const idempotency = readFileSync(join(APP_DIR, "src/common/http/idempotency.service.ts"), "utf8");
    expect(idempotency).toContain("const plain = plainCopyOf(response);");
    const outbox = readFileSync(join(APP_DIR, "src/notifications/outbox.service.ts"), "utf8");
    expect(outbox).toContain("JSON.stringify(redactPayload(input.data)) !== payload");
  });
});
