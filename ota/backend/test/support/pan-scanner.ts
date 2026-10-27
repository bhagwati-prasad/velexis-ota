// Test support (OBE-052): looks for the airline card a test sent everywhere the OTA backend keeps or writes something,
// for the PAN-absence proof of ota/docs/flows/checkout-airline-card.md §7 (OF-05 AC1; OADR-0004 point 2, ADR-0011 §C).
// The card exists only in memory for one request: none of its values may be found afterwards in
//
//   - a tenant table: every column of every table of every tenant schema (`tenant_*`), read row by row through tenantTx
//     (text and jsonb columns, arrays as JSON, any other type as its text), and every `*_ciphertext` column decrypted
//     with the test KEKs (the AAD of `aadFor(schema, table, column, id)`, as every tenant ciphertext is bound): an
//     encrypted copy of a card is still a stored card;
//   - Redis: every key name and every value of the test's database (strings, hashes, lists, sets, sorted sets and
//     streams);
//   - BullMQ: every job of every queue the backend opens, in every state, with its data, options, return value, failure
//     reason, stack trace and logs, and the templates of the job schedulers;
//   - the logs: every line LogCapture (log-capture.ts) recorded.
//
// What counts as a value of the card (`cardNeedles`), for each card the test sent:
//
//   card number        the number, anywhere in any text
//   last 12 digits     the number's last 12 digits, anywhere (PCI DSS allows the BIN and the last 4 only), or, for a card
//                      whose last 12 digits are a zero run that synthetic numbers hold too, as a number of their own
//   security code      as a JSON value: a quoted `"123"` in any text (also escaped, `\"123\"`, or `'123'` as an inspected
//                      object prints it), a string value `"123"` at any depth of a JSON document (JSON held in a string
//                      is parsed and walked too), a text column whose whole value it is, or any value under or after a
//                      key such as `securityCode`, `cvc` or `cvv`. A bare `123` elsewhere is a count, an id or a
//                      duration, not the card's code
//   card holder        the holder's name and surname, in any case, anywhere (FIX-W29-SECURITY)
//   expiry date        `YYYY-MM` (Amadeus's `expiryDate`), `MM/YY` and `MM/YYYY` anywhere, or the month or the year under
//                      or after a key such as `expiryMonth`, `expYear` or `card_exp_month` (FIX-W29-SECURITY)
//
// A key is a key of a JSON document, a key written before its value in any text, or the name of the column that holds
// the value (`payments.card_exp_month`, `card_exp_year`: an airline card's expiry copied into them is found too).
//
// A finding names where the value is and which value it is, never the value itself (a key name or a job id that holds
// it is masked), so a failing test prints no card data. Something the scanner cannot read (a ciphertext that does not
// decrypt, a table it cannot select from although the application role can write it, a Redis type it does not know) is
// an error, not a pass: a blind spot fails the proof.
//
//   const scanner = new PanScanner([{ number: "4111111111111111", securityCode: "123", holderName: "Ann Lee",
//     expiryMonth: 7, expiryYear: 2034 }]);
//   const report = await scanner.scan({ platformDb, tenantDb, keys, redis: redis.client, queues, logs });
//   expect(report.findings).toEqual([]);
//   expect(report.errors).toEqual([]);
import { aadFor, decryptValue, type KeyProvider } from "@velexis/crypto";
import {
  isTenantSchema,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type Transaction,
} from "@velexis/db";
import type { JobType, Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { CapturedLine, LogCapture } from "./log-capture";

/** A card a test sent: every value of it that must never be found. */
export interface CardUnderTest {
  readonly number: string;
  readonly securityCode: string;
  readonly holderName: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  /**
   * Where the number's last 12 digits count: `anywhere` (the default), or `standalone`, as a number of their own (not
   * inside a longer run of digits), for a card whose last 12 digits are a run of zeros and one digit that synthetic
   * numbers hold too (the stub's declined card `4000000000000002`: its `000000000002` is inside the stub's second
   * e-ticket number `0000000000002`). The whole number counts anywhere in either case.
   */
  readonly last12?: "anywhere" | "standalone";
}

/** One value to look for (see the file header). */
export type Needle =
  /**
   * A substring of any text, compared in lower case when `ignoreCase`; when `standalone`, only where no digit comes
   * right before or after it. `pattern` matches it so (with the `g` flag, for masking).
   */
  | {
      readonly kind: "text";
      readonly label: string;
      readonly value: string;
      readonly ignoreCase: boolean;
      readonly standalone: boolean;
      readonly pattern: RegExp;
    }
  /**
   * A JSON value: when `anywhere`, a quoted `"value"` (or `'value'`) in any text, a string value equal to it at any
   * depth of a JSON document, or a text column equal to it; and, in any case, a value equal to one of `values` under a
   * key that matches `keys` (in a JSON document), or after such a key in any text (`keyed`: `"expiryMonth":7`, the
   * escaped `\"expiryMonth\":7` of JSON in a string, `expiryMonth: 7` of an inspected object).
   */
  | {
      readonly kind: "value";
      readonly label: string;
      readonly values: readonly string[];
      readonly keys: RegExp;
      readonly keyed: RegExp;
      readonly anywhere: boolean;
    };

const SECURITY_CODE_KEY = "security_?code|cvc2?|cvv2?|csc|cvn";
const EXPIRY_MONTH_KEY = "(?:card_?)?exp(?:iry|iration)?_?month";
const EXPIRY_YEAR_KEY = "(?:card_?)?exp(?:iry|iration)?_?year";

/** Keys that name a card's security code. */
export const SECURITY_CODE_KEYS = new RegExp(`^(?:${SECURITY_CODE_KEY})$`, "i");
/** Keys that name a card's expiry month or year (the request's, Amadeus's, Stripe's and the payments columns'). */
export const EXPIRY_MONTH_KEYS = new RegExp(`^(?:${EXPIRY_MONTH_KEY})$`, "i");
export const EXPIRY_YEAR_KEYS = new RegExp(`^(?:${EXPIRY_YEAR_KEY})$`, "i");

/** `value` with the characters a regular expression gives a meaning escaped. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One of `values` right after a key that matches `key` in any text: the key may be quoted (also with an escaped
 * quote), followed by `:` or `=`, and the value may be quoted; the value may not go on with another digit.
 */
function keyedValue(key: string, values: readonly string[]): RegExp {
  const quote = `(?:\\\\?["'])?`;
  return new RegExp(
    `(?<![A-Za-z0-9_])(?:${key})${quote}\\s*[:=]\\s*${quote}(?:${values.map(escapeRegExp).join("|")})(?![0-9])`,
    "i",
  );
}

/** The labels of the values, as findings name them. */
export const VALUE_LABELS = Object.freeze({
  number: "card number",
  last12: "card number's last 12 digits",
  securityCode: "security code",
  holder: "card holder",
  expiry: "expiry date",
} as const);

/** Every value of `cards` that must never be found, without duplicates. */
export function cardNeedles(cards: readonly CardUnderTest[]): Needle[] {
  const needles = new Map<string, Needle>();
  const add = (needle: Needle): void => {
    const id = JSON.stringify(needle, (_key, value: unknown) =>
      value instanceof RegExp ? value.source : value,
    );
    needles.set(id, needle);
  };
  const text = (
    label: string,
    value: string,
    options: { ignoreCase?: boolean; standalone?: boolean } = {},
  ): void => {
    const ignoreCase = options.ignoreCase ?? false;
    const standalone = options.standalone ?? false;
    const escaped = escapeRegExp(value);
    add({
      kind: "text",
      label,
      value: ignoreCase ? value.toLowerCase() : value,
      ignoreCase,
      standalone,
      pattern: new RegExp(standalone ? `(?<![0-9])${escaped}(?![0-9])` : escaped, ignoreCase ? "gi" : "g"),
    });
  };
  for (const card of cards) {
    if (!/^\d{12,19}$/.test(card.number) || !/^\d{3,4}$/.test(card.securityCode)) {
      throw new TypeError(
        "cardNeedles(): a card number of 12 to 19 digits and a security code of 3 or 4 digits",
      );
    }
    text(VALUE_LABELS.number, card.number);
    text(VALUE_LABELS.last12, card.number.slice(-12), { standalone: card.last12 === "standalone" });
    add({
      kind: "value",
      label: VALUE_LABELS.securityCode,
      values: [card.securityCode],
      keys: SECURITY_CODE_KEYS,
      keyed: keyedValue(SECURITY_CODE_KEY, [card.securityCode]),
      anywhere: true,
    });
    const holder = card.holderName.trim();
    const surname = holder.split(/\s+/).at(-1) ?? holder;
    if (surname.length < 4) {
      throw new TypeError(
        "cardNeedles(): a holder whose surname has 4 letters or more, so a match means the holder",
      );
    }
    text(VALUE_LABELS.holder, holder, { ignoreCase: true });
    text(VALUE_LABELS.holder, surname, { ignoreCase: true });
    const month = String(card.expiryMonth).padStart(2, "0");
    const year = String(card.expiryYear);
    text(VALUE_LABELS.expiry, `${year}-${month}`);
    text(VALUE_LABELS.expiry, `${month}/${year.slice(-2)}`);
    text(VALUE_LABELS.expiry, `${month}/${year}`);
    const months = [...new Set([String(card.expiryMonth), month])];
    add({
      kind: "value",
      label: VALUE_LABELS.expiry,
      values: months,
      keys: EXPIRY_MONTH_KEYS,
      keyed: keyedValue(EXPIRY_MONTH_KEY, months),
      anywhere: false,
    });
    add({
      kind: "value",
      label: VALUE_LABELS.expiry,
      values: [year],
      keys: EXPIRY_YEAR_KEYS,
      keyed: keyedValue(EXPIRY_YEAR_KEY, [year]),
      anywhere: false,
    });
  }
  return [...needles.values()];
}

/** One place where a value of the card was found: where, and which value (never the value itself). */
export interface Finding {
  readonly where: string;
  readonly value: string;
}

/** How much one scan read. */
export interface ScanCounts {
  tenantSchemas: number;
  tables: number;
  columns: number;
  rows: number;
  /** Non-null values read from tenant tables, decrypted ciphertexts included. */
  values: number;
  ciphertexts: number;
  redisKeys: number;
  queues: number;
  jobs: number;
  logLines: number;
}

/** The outcome of one scan: what was found, what could not be read, and how much was read. */
export interface ScanReport {
  readonly findings: readonly Finding[];
  readonly errors: readonly string[];
  readonly counts: Readonly<ScanCounts>;
}

/** Where a scan reads. */
export interface ScanTargets {
  /** Any connection that can read the catalogue: lists the tenant schemas. */
  readonly platformDb: Kysely<PlatformDatabase>;
  /** The tenant tables, read through tenantTx. */
  readonly tenantDb: TenantDb;
  /** The KEKs the application encrypts with (testKeyProvider()), to decrypt the ciphertext columns. */
  readonly keys: KeyProvider;
  /** The test's Redis database, which the API and the worker use. */
  readonly redis: Redis;
  /** Every queue the backend opens. */
  readonly queues: readonly Queue[];
  readonly logs: LogCapture;
}

/** Every state a BullMQ job can be in. */
const JOB_TYPES: JobType[] = [
  "active",
  "completed",
  "delayed",
  "failed",
  "paused",
  "prioritized",
  "waiting",
  "waiting-children",
];

/** How deep JSON held in strings is parsed again (a job's data in a Redis hash, a body in a log line). */
const MAX_JSON_NESTING = 8;

/** A Redis value, or a key name, read as text. */
const textOf = (value: Buffer | string): string =>
  typeof value === "string" ? value : value.toString("utf8");

/** Whether `text` may be a JSON object or array (worth parsing). */
const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A column of a tenant table and how the scanner reads it. */
interface TenantColumn {
  readonly column: string;
  /** `text` (string types), `json` (json, jsonb and arrays, read as JSON), `binary` (bytea), `other` (read as text). */
  readonly kind: "text" | "json" | "binary" | "other";
}

/** One table's columns and whether the application role can read and write it. */
interface TenantTable {
  readonly name: string;
  readonly columns: readonly TenantColumn[];
  readonly hasId: boolean;
  readonly canSelect: boolean;
  readonly canWrite: boolean;
}

/** Looks for the values of the cards a test sent (see the file header). */
export class PanScanner {
  readonly needles: readonly Needle[];
  readonly #textNeedles: ReadonlyArray<Extract<Needle, { kind: "text" }>>;
  readonly #valueNeedles: ReadonlyArray<Extract<Needle, { kind: "value" }>>;

  constructor(cards: readonly CardUnderTest[]) {
    this.needles = cardNeedles(cards);
    this.#textNeedles = this.needles.filter((needle) => needle.kind === "text");
    this.#valueNeedles = this.needles.filter((needle) => needle.kind === "value");
  }

  /** Scans every tenant table, Redis, every queue and every captured log line (the file header). */
  async scan(targets: ScanTargets): Promise<ScanReport> {
    const scan = new Scan(this);
    await this.#scanTenantTables(scan, targets);
    await this.#scanRedis(scan, targets.redis);
    await this.#scanQueues(scan, targets.queues);
    this.#scanLogs(scan, targets.logs.lines());
    return scan.report();
  }

  /** The labels of the values found in one text (a JSON document is walked too): for quick checks of an answer. */
  valuesIn(text: string): string[] {
    const scan = new Scan(this);
    scan.text("text", text, { scalar: false });
    return [...new Set(scan.report().findings.map((finding) => finding.value))];
  }

  /** `text` with every text needle replaced by its label, and any run of 12 or more digits masked. */
  mask(text: string): string {
    let masked = text;
    for (const needle of this.#textNeedles) {
      masked = masked.replace(needle.pattern, `[${needle.label}]`);
    }
    return masked.replace(/\d{12,}/g, "[digits]");
  }

  /** The text needles found in `text`. */
  textMatches(text: string): string[] {
    const lower = text.toLowerCase();
    return this.#textNeedles
      .filter((needle) => {
        const haystack = needle.ignoreCase ? lower : text;
        if (!needle.standalone) {
          return haystack.includes(needle.value);
        }
        needle.pattern.lastIndex = 0;
        return needle.pattern.test(haystack);
      })
      .map((needle) => needle.label);
  }

  /** The value needles found in `text`: quoted, after one of their keys, or as the whole of a scalar. */
  rawValueMatches(text: string, scalar: boolean): string[] {
    return this.#valueNeedles
      .filter(
        (needle) =>
          needle.keyed.test(text) ||
          (needle.anywhere &&
            needle.values.some(
              (value) =>
                text.includes(`"${value}"`) ||
                text.includes(`\\"${value}\\"`) ||
                text.includes(`'${value}'`) ||
                (scalar && text === value),
            )),
      )
      .map((needle) => needle.label);
  }

  /** The value needles whose keys name `column` and whose values hold `value` (a tenant table's column, as text). */
  columnValueMatches(column: string, value: string): string[] {
    return this.#valueNeedles
      .filter((needle) => needle.values.includes(value) && needle.keys.test(column))
      .map((needle) => needle.label);
  }

  /** The value needles a JSON value under `key` matches (see `Needle`). */
  jsonValueMatches(key: string | undefined, value: string | number | boolean): string[] {
    const text = String(value);
    return this.#valueNeedles
      .filter(
        (needle) =>
          needle.values.includes(text) &&
          ((needle.anywhere && typeof value === "string") || (key !== undefined && needle.keys.test(key))),
      )
      .map((needle) => needle.label);
  }

  async #scanTenantTables(scan: Scan, targets: ScanTargets): Promise<void> {
    const { rows: namespaces } = await sql<{ name: string }>`
      SELECT nspname AS name FROM pg_catalog.pg_namespace ORDER BY nspname
    `.execute(targets.platformDb);
    const schemas = namespaces.map((row) => row.name).filter((name) => isTenantSchema(name));
    if (schemas.length === 0) {
      scan.error("no tenant schema found");
    }
    for (const schema of schemas) {
      scan.counts.tenantSchemas += 1;
      const tables = await tenantTx(targets.tenantDb, schema, (trx) => tenantTables(trx));
      for (const table of tables) {
        scan.counts.tables += 1;
        scan.counts.columns += table.columns.length;
        if (!table.canSelect) {
          if (table.canWrite) {
            scan.error(`${schema}.${table.name}: the application role writes it but cannot read it`);
          }
          continue;
        }
        const rows = await tenantTx(targets.tenantDb, schema, (trx) => tableRows(trx, table));
        for (const row of rows) {
          scan.counts.rows += 1;
          const rowId = typeof row["__row"] === "string" ? row["__row"] : "?";
          for (const column of table.columns) {
            const value = row[column.column];
            if (value === null || value === undefined) {
              continue;
            }
            scan.counts.values += 1;
            const where = `${schema}.${table.name}.${column.column} (${table.hasId ? "id" : "ctid"} ${rowId})`;
            if (column.kind === "binary") {
              const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
              if (column.column.endsWith("_ciphertext")) {
                await this.#scanCiphertext(scan, targets.keys, {
                  schema,
                  table,
                  column,
                  rowId,
                  bytes,
                  where,
                });
              } else {
                scan.text(where, bytes.toString("latin1"), { scalar: false });
              }
            } else {
              const text = String(value);
              scan.text(where, text, { scalar: column.kind === "text" });
              if (column.kind !== "json") {
                scan.column(where, column.column, text);
              }
            }
          }
        }
      }
    }
  }

  async #scanCiphertext(
    scan: Scan,
    keys: KeyProvider,
    cell: {
      readonly schema: string;
      readonly table: TenantTable;
      readonly column: TenantColumn;
      readonly rowId: string;
      readonly bytes: Buffer;
      readonly where: string;
    },
  ): Promise<void> {
    if (!cell.table.hasId) {
      scan.error(`${cell.where}: a ciphertext in a table without an id cannot be decrypted`);
      return;
    }
    let plaintext: Buffer;
    try {
      plaintext = await decryptValue(cell.bytes, {
        aad: aadFor(cell.schema, cell.table.name, cell.column.column, cell.rowId),
        keys,
      });
    } catch (error) {
      scan.error(`${cell.where}: does not decrypt (${error instanceof Error ? error.name : typeof error})`);
      return;
    }
    scan.counts.ciphertexts += 1;
    scan.text(`${cell.where}, decrypted`, plaintext.toString("utf8"), { scalar: true });
  }

  async #scanRedis(scan: Scan, redis: Redis): Promise<void> {
    let cursor = "0";
    const keys = new Set<string>();
    do {
      const [next, found] = await redis.scanBuffer(cursor, "COUNT", 1000);
      cursor = textOf(next);
      for (const key of found) {
        keys.add(key.toString("binary"));
      }
    } while (cursor !== "0");
    for (const binaryKey of [...keys].sort()) {
      const key = Buffer.from(binaryKey, "binary");
      const name = textOf(key);
      const type = await redis.type(key);
      if (type === "none") {
        continue; // expired since the SCAN
      }
      scan.counts.redisKeys += 1;
      const where = `redis ${type} ${this.mask(name)}`;
      scan.text(`${where} (its name)`, name, { scalar: false });
      const values: Array<Buffer | string> = [];
      switch (type) {
        case "string": {
          const value = await redis.getBuffer(key);
          if (value !== null) {
            values.push(value);
          }
          break;
        }
        case "hash":
          for (const [field, value] of Object.entries(await redis.hgetallBuffer(key))) {
            values.push(field, value);
          }
          break;
        case "list":
          values.push(...(await redis.lrangeBuffer(key, 0, -1)));
          break;
        case "set":
          values.push(...(await redis.smembersBuffer(key)));
          break;
        case "zset":
          values.push(...(await redis.zrangeBuffer(key, 0, -1, "WITHSCORES")));
          break;
        case "stream":
          for (const [id, fields] of await redis.xrangeBuffer(key, "-", "+")) {
            values.push(id, ...fields);
          }
          break;
        default:
          scan.error(`${where}: a Redis type the scanner does not read`);
      }
      for (const value of values) {
        scan.text(where, textOf(value), { scalar: false });
      }
    }
  }

  async #scanQueues(scan: Scan, queues: readonly Queue[]): Promise<void> {
    for (const queue of queues) {
      scan.counts.queues += 1;
      for (const job of await queue.getJobs(JOB_TYPES, 0, -1, true)) {
        // getJobs leaves a hole for a job removed while it reads.
        if ((job as typeof job | undefined) === undefined) {
          continue;
        }
        scan.counts.jobs += 1;
        const where = `job ${queue.name} ${this.mask(job.name)} #${this.mask(String(job.id))}`;
        const logs = job.id === undefined ? { logs: [] } : await queue.getJobLogs(job.id, 0, -1);
        scan.json(where, {
          id: job.id,
          name: job.name,
          data: job.data as unknown,
          opts: job.opts,
          returnvalue: job.returnvalue as unknown,
          failedReason: job.failedReason,
          stacktrace: job.stacktrace,
          progress: job.progress,
          logs: logs.logs,
        });
      }
      for (const scheduler of await queue.getJobSchedulers(0, -1, true)) {
        scan.json(`job scheduler ${queue.name} ${this.mask(scheduler.key)}`, scheduler);
      }
    }
  }

  #scanLogs(scan: Scan, lines: readonly CapturedLine[]): void {
    for (const line of lines) {
      scan.counts.logLines += 1;
      scan.text(`log ${line.source} line ${line.line}`, line.text, { scalar: false });
    }
  }
}

/** One scan's findings, errors and counts. */
class Scan {
  readonly counts: ScanCounts = {
    tenantSchemas: 0,
    tables: 0,
    columns: 0,
    rows: 0,
    values: 0,
    ciphertexts: 0,
    redisKeys: 0,
    queues: 0,
    jobs: 0,
    logLines: 0,
  };
  readonly #findings = new Map<string, Finding>();
  readonly #errors: string[] = [];

  constructor(private readonly scanner: PanScanner) {}

  /** Records that the value `label` is at `where`. */
  found(where: string, label: string): void {
    const finding = { where: this.scanner.mask(where), value: label };
    this.#findings.set(`${finding.where}\u0000${label}`, finding);
  }

  error(message: string): void {
    this.#errors.push(this.scanner.mask(message));
  }

  /** Scans a text: substrings, quoted values, the whole value when it is a scalar, and the JSON it may hold. */
  text(where: string, text: string, options: { readonly scalar: boolean }, depth = 0): void {
    for (const label of this.scanner.textMatches(text)) {
      this.found(where, label);
    }
    for (const label of this.scanner.rawValueMatches(text, options.scalar)) {
      this.found(where, label);
    }
    if (depth < MAX_JSON_NESTING && looksLikeJson(text)) {
      const parsed = parseJson(text);
      if (parsed !== undefined) {
        this.#walk(where, parsed, undefined, depth + 1);
      }
    }
  }

  /** Scans the value of a column under the column's name, as a JSON value under its key (`card_exp_month`). */
  column(where: string, column: string, text: string): void {
    for (const label of this.scanner.columnValueMatches(column, text)) {
      this.found(where, label);
    }
  }

  /** Scans a value that is already JSON (a job): as its text, and walked. */
  json(where: string, value: unknown): void {
    this.text(where, JSON.stringify(value) ?? "", { scalar: false });
  }

  #walk(where: string, value: unknown, key: string | undefined, depth: number): void {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      for (const label of this.scanner.jsonValueMatches(key, value)) {
        this.found(where, label);
      }
      if (typeof value === "string" && depth < MAX_JSON_NESTING && looksLikeJson(value)) {
        const parsed = parseJson(value);
        if (parsed !== undefined) {
          this.#walk(where, parsed, key, depth + 1);
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        this.#walk(where, item, key, depth);
      }
    } else if (value !== null && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) {
        this.#walk(where, item, name, depth);
      }
    }
  }

  report(): ScanReport {
    return { findings: [...this.#findings.values()], errors: [...this.#errors], counts: { ...this.counts } };
  }
}

/** The tables of the transaction's tenant schema (`current_schema()` under tenantTx), with their columns. */
async function tenantTables<DB>(trx: Transaction<DB>): Promise<TenantTable[]> {
  const { rows } = await sql<{
    table: string;
    column: string;
    type: string;
    category: string;
    canSelect: boolean;
    canWrite: boolean;
  }>`
    SELECT c.relname AS table, a.attname AS column, t.typname AS type, t.typcategory AS category,
           has_table_privilege(c.oid, 'SELECT') AS "canSelect",
           has_table_privilege(c.oid, 'INSERT,UPDATE') AS "canWrite"
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    ORDER BY c.relname, a.attnum
  `.execute(trx);
  const tables = new Map<string, { columns: TenantColumn[]; canSelect: boolean; canWrite: boolean }>();
  for (const row of rows) {
    const table = tables.get(row.table) ?? { columns: [], canSelect: row.canSelect, canWrite: row.canWrite };
    tables.set(row.table, table);
    const kind: TenantColumn["kind"] =
      row.type === "bytea"
        ? "binary"
        : row.type === "json" || row.type === "jsonb" || row.category === "A"
          ? "json"
          : row.category === "S"
            ? "text"
            : "other";
    table.columns.push({ column: row.column, kind });
  }
  return [...tables].map(([name, table]) => ({
    name,
    columns: table.columns,
    hasId: table.columns.some((column) => column.column === "id"),
    canSelect: table.canSelect,
    canWrite: table.canWrite,
  }));
}

/** Every row of `table`: `__row` (its id, else its ctid) and each column as the scanner reads it. */
async function tableRows<DB>(
  trx: Transaction<DB>,
  table: TenantTable,
): Promise<Array<Record<string, unknown>>> {
  const selected = table.columns.map((column) => {
    const ref = sql.id(column.column);
    switch (column.kind) {
      case "binary":
        return sql`${ref}`;
      case "json":
        return sql`to_jsonb(${ref})::text AS ${ref}`;
      case "text":
      case "other":
        return sql`${ref}::text AS ${ref}`;
    }
  });
  const rowId = table.hasId ? sql`${sql.id("id")}::text` : sql`ctid::text`;
  const { rows } = await sql<Record<string, unknown>>`
    SELECT ${rowId} AS __row, ${sql.join(selected)} FROM ${sql.id(table.name)}
  `.execute(trx);
  return rows;
}
