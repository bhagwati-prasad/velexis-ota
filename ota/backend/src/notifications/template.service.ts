// The template of an e-mail: which one applies, and its compilation in strict mode against the key's allow-list
// (OBE-030; OADR-0013 item 3, ADR-0017 "Templates", registry of OBE-004 in templates/registry.ts).
//
// Which template applies (`effective`), for a key and the e-mail's locale:
//   1. the tenant's active `notification_templates` row of the key (channel `email`) for the locale, else for its
//      language (`en` for `en-GB`), so the rows seeded in `en` serve every English locale;
//   2. else the code default for the locale: the defaults are English only in the MVP, so this is the default of an
//      English locale;
//   3. else the English code default.
// An inactive row is skipped. A key without a code default (its files come with a later task) has no template at all.
//
// The template language is a safe subset of Handlebars, checked on the parsed template before it is compiled
// (`checkTemplate`), so a template edited by an OTA can neither run code nor reach data its key does not allow:
//   - text, comments and `{{variable}}`, where the variable is one of the key's allow-list (`booking.reference`);
//   - `{{#if variable}}`, `{{#unless variable}}` (with `{{else}}`) on a variable or a group of them (`booking`);
//   - `{{#each list}}` on a list of the allow-list (`booking.segments`), inside which `{{origin}}` is
//     `booking.segments[].origin` and `{{../brand.name}}` reaches the outer level;
//   - nothing else: no triple braces (HTML escaping always on), helpers, partials, decorators, sub-expressions,
//     literals, `@data` variables or block parameters.
// A template that breaks a rule is refused with every problem at once (`TemplateInvalidError`: part, line, message;
// `checkTemplateSources` returns them without throwing). The console's `422 TEMPLATE_INVALID` of OBE-073
// (settings/templates.service.ts) lists every one of them, each part named as the API names it (`subject`, `bodyHtml`,
// `bodyText`). It is then compiled in an isolated Handlebars environment in strict mode: a variable missing from the
// render data fails (`TemplateRenderError`, with the line Handlebars names), it never renders as an empty string. The
// HTML part is HTML-escaped; the subject and the text part are not HTML and are not escaped (a link stays a working
// link), and the subject is collapsed to one line.
//
// The console's template settings (OBE-073) read and write the tenant's rows through this service too (`tenantRow`,
// `tenantRows`, `insertRow`, `updateRow`, `deleteRow`), in the caller's TenantTx transaction: the console edits the
// row of exactly one key, channel and locale, active or not, while an e-mail takes the active row of its locale or
// language as above (`servingRowOf`), which the console shows for a locale without a row of its own (FIX-W33-OTA). The rows are read at every send (only the code defaults are cached), so a saved or
// reset template applies to the next e-mail.
//
// Errors name templates, parts, lines and variable names, never a value of the render data.
import { Inject, Injectable, Optional } from "@nestjs/common";
import Handlebars from "handlebars";
import { OutboxRepository, type NotificationTemplateRow } from "./outbox.repository";
import {
  DEFAULT_TEMPLATE_LOCALE,
  DEFAULT_TEMPLATES_DIR,
  loadTemplateDefault,
  TEMPLATE_CHANNEL,
  TEMPLATE_REGISTRY,
  type TemplateKey,
  type TemplatePart,
} from "./templates/registry";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** Where a template comes from: the tenant's row or the code default. */
export type TemplateOrigin = "tenant" | "default";

/** The three sources of a template. */
export interface TemplateSources {
  /** The subject template. */
  readonly subject: string;
  /** The HTML body template; `null` when the template has none (the e-mail goes as text only). */
  readonly html: string | null;
  /** The plain-text body template. */
  readonly text: string;
}

/** The template that applies to an e-mail. */
export interface EffectiveTemplate {
  readonly key: TemplateKey;
  readonly origin: TemplateOrigin;
  /** The locale of the template: the row's, or `en` for a code default. */
  readonly locale: string;
  /** The row's `ntt_…` id; `null` for a code default. */
  readonly templateId: string | null;
  /** The row's version; 0 for a code default. */
  readonly version: number;
  readonly sources: TemplateSources;
}

/** One rule a template breaks. */
export interface TemplateProblem {
  readonly part: TemplatePart;
  /** The 1-based line of the problem in that part; `null` when the parser gave none. */
  readonly line: number | null;
  readonly message: string;
}

/** A template that is not valid for its key: it does not parse, breaks a rule of the subset, or names a variable outside the allow-list. */
export class TemplateInvalidError extends Error {
  override readonly name = "TemplateInvalidError";
  readonly problems: readonly TemplateProblem[];

  constructor(
    readonly key: TemplateKey,
    readonly origin: TemplateOrigin,
    readonly locale: string,
    problems: readonly TemplateProblem[],
  ) {
    super(
      `The ${origin === "tenant" ? "tenant" : "code default"} template ${key} (${locale}) is invalid: ` +
        problems
          .map(
            (problem) =>
              `${problem.part}${problem.line === null ? "" : ` line ${problem.line}`}: ${problem.message}`,
          )
          .join("; ") +
        `. The variables of ${key} are: ${TEMPLATE_REGISTRY[key].variables.map((entry) => entry.name).join(", ")}.`,
    );
    this.problems = Object.freeze(problems.map((problem) => Object.freeze({ ...problem })));
  }
}

/** A valid template that failed on its render data (in strict mode: a variable missing from the data). */
export class TemplateRenderError extends Error {
  override readonly name = "TemplateRenderError";

  constructor(
    readonly key: TemplateKey,
    readonly origin: TemplateOrigin,
    readonly part: TemplatePart,
    /** Handlebars' message: a variable name and a position, never a value. */
    readonly reason: string,
    /** The 1-based line of the failing expression in that part; `null` when Handlebars named none. */
    readonly line: number | null = null,
  ) {
    super(
      `The ${origin === "tenant" ? "tenant" : "code default"} template ${key} failed to render its ${part}: ${reason}`,
    );
  }
}

/** A key has neither a tenant row nor a code default: its files come with a later task. */
export class TemplateMissingError extends Error {
  override readonly name = "TemplateMissingError";

  constructor(readonly key: TemplateKey) {
    super(`No template applies to ${key}: the tenant has no active row and the code has no default`);
  }
}

/** A rendered e-mail. */
export interface RenderedTemplate {
  /** One line, without leading or trailing spaces. */
  readonly subject: string;
  /** `null` when the template has no HTML part. */
  readonly html: string | null;
  readonly text: string;
}

/** A checked and compiled template. */
export interface CompiledTemplate {
  readonly template: EffectiveTemplate;
  /** Renders the three parts with `data` (strict mode). Throws `TemplateRenderError`. */
  render(data: Readonly<Record<string, unknown>>): RenderedTemplate;
}

/** The block helpers of the subset. */
const BLOCK_HELPERS: ReadonlySet<string> = new Set(["if", "unless", "each"]);

/** One segment of a variable path. */
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The parts of a Handlebars AST the checks read (Handlebars ships no AST types for its `parse`). */
interface AstNode {
  readonly type: string;
  readonly loc?: { readonly start?: { readonly line?: number } } | null;
  readonly path?: AstNode;
  readonly params?: readonly AstNode[];
  readonly hash?: unknown;
  readonly escaped?: boolean;
  readonly program?: AstProgram | null;
  readonly inverse?: AstProgram | null;
  // PathExpression
  readonly data?: boolean;
  readonly depth?: number;
  readonly parts?: readonly unknown[];
  readonly original?: unknown;
}

interface AstProgram {
  readonly body: readonly AstNode[];
  readonly blockParams?: readonly string[] | null;
}

/** The allow-list of a key, and the groups and lists it implies (`booking`, `booking.segments`). */
interface AllowList {
  /** Every variable: `booking.reference`, `booking.segments[].origin`. */
  readonly variables: ReadonlySet<string>;
  /** Every proper prefix of a variable at a `.` or a `[]`: `booking`, `booking.segments`, `booking.segments[]`. */
  readonly groups: ReadonlySet<string>;
  /** Every path followed by `[]` in a variable: `booking.segments`. */
  readonly lists: ReadonlySet<string>;
}

function allowListOf(key: TemplateKey): AllowList {
  const variables = new Set(TEMPLATE_REGISTRY[key].variables.map((entry) => entry.name));
  const groups = new Set<string>();
  const lists = new Set<string>();
  for (const name of variables) {
    for (let index = 0; index < name.length; index += 1) {
      if (name[index] === ".") {
        groups.add(name.slice(0, index));
      } else if (name.startsWith("[]", index)) {
        groups.add(name.slice(0, index));
        groups.add(name.slice(0, index + 2));
        lists.add(name.slice(0, index));
      }
    }
  }
  return { variables, groups, lists };
}

/** The line of a node. */
function lineOf(node: AstNode): number | null {
  const line = node.loc?.start?.line;
  return typeof line === "number" ? line : null;
}

/** `variable` as the message names it. */
const quoted = (name: string): string => JSON.stringify(name);

/**
 * Checks one part of a template of `key` against the subset and the key's allow-list (see the file header) and
 * returns every problem, an empty list for a valid part. The subject may not use a link variable: a link holds a
 * secret token, and the rendered subject is stored (`notifications.subject`) after the secrets are erased.
 */
export function checkTemplate(key: TemplateKey, part: TemplatePart, source: string): TemplateProblem[] {
  let program: AstProgram;
  try {
    program = Handlebars.parse(source) as unknown as AstProgram;
  } catch (error) {
    // The parser's message quotes the template around the position (the OTA's own text), never render data; its first
    // line names the line of the error ("Parse error on line 3:"), as `lineNumber` does for the other exceptions.
    const text = error instanceof Error ? error.message : "";
    const first = (text.split("\n")[0] ?? "").replace(/:$/, "");
    const reported = (error as { lineNumber?: unknown }).lineNumber;
    const parsed = /\bline (\d+)\b/.exec(first)?.[1];
    const line = typeof reported === "number" ? reported : parsed === undefined ? null : Number(parsed);
    const expected = /Expecting (.+), got (.+)$/m.exec(text);
    const detail = expected === null ? first : `${first}: expecting ${expected[1]}, got ${expected[2]}`;
    return [{ part, line, message: `does not parse${detail === "" ? "" : ` (${detail})`}` }];
  }
  const allow = allowListOf(key);
  const links = new Set(TEMPLATE_REGISTRY[key].links.map((link) => link.variable));
  const problems: TemplateProblem[] = [];
  const problem = (node: AstNode, message: string): void => {
    problems.push({ part, line: lineOf(node), message });
  };

  /** The variable path a path expression names in `scopes` (the list prefixes of the enclosing `each` blocks). */
  const resolve = (node: AstNode | undefined, scopes: readonly string[]): string | undefined => {
    if (node === undefined) {
      return undefined;
    }
    if (node.type !== "PathExpression") {
      problem(node, `${node.type} is not allowed: name a variable`);
      return undefined;
    }
    if (node.data === true) {
      problem(node, `${quoted(String(node.original))}: @ variables are not available`);
      return undefined;
    }
    const depth = node.depth ?? 0;
    const scope = scopes[scopes.length - 1 - depth];
    if (scope === undefined) {
      problem(node, `${quoted(String(node.original))} goes above the top level with ../`);
      return undefined;
    }
    const parts = node.parts ?? [];
    if (!parts.every((segment) => typeof segment === "string" && SEGMENT.test(segment))) {
      problem(node, `${quoted(String(node.original))} is not a variable name`);
      return undefined;
    }
    if (parts.length === 0) {
      if (scope === "") {
        problem(node, `${quoted(String(node.original))} is only available inside {{#each}}`);
        return undefined;
      }
      return scope;
    }
    const path = (parts as string[]).join(".");
    return scope === "" ? path : `${scope}.${path}`;
  };

  const walk = (body: readonly AstNode[], scopes: readonly string[]): void => {
    for (const node of body) {
      switch (node.type) {
        case "ContentStatement":
        case "CommentStatement":
          break;
        case "MustacheStatement": {
          if (node.escaped !== true) {
            problem(node, "triple braces would turn HTML escaping off: use {{variable}}");
          }
          if ((node.params ?? []).length > 0 || (node.hash !== undefined && node.hash !== null)) {
            problem(node, "helpers are not available: use {{variable}}, {{#if}}, {{#unless}} or {{#each}}");
            break;
          }
          const name = resolve(node.path, scopes);
          if (name === undefined) {
            break;
          }
          if (!allow.variables.has(name)) {
            problem(
              node,
              allow.groups.has(name)
                ? `${quoted(name)} is a group of variables, not a value: name one of its variables`
                : `${quoted(name)} is not a variable of ${key}`,
            );
          } else if (part === "subject" && links.has(name)) {
            problem(node, `${quoted(name)} holds a secret link and may not appear in the subject`);
          }
          break;
        }
        case "BlockStatement": {
          const helper = node.path?.type === "PathExpression" ? String(node.path.original) : node.path?.type;
          if (helper === undefined || !BLOCK_HELPERS.has(helper)) {
            problem(node, `{{#${helper ?? "?"}}} is not available: use {{#if}}, {{#unless}} or {{#each}}`);
            break;
          }
          const params = node.params ?? [];
          if (params.length !== 1 || (node.hash !== undefined && node.hash !== null)) {
            problem(node, `{{#${helper}}} takes exactly one variable`);
            break;
          }
          if ((node.program?.blockParams ?? []).length > 0) {
            problem(node, `{{#${helper}}} block parameters (as |…|) are not available`);
            break;
          }
          const target = resolve(params[0], scopes);
          if (target === undefined) {
            break;
          }
          if (helper === "each") {
            if (!allow.lists.has(target)) {
              problem(node, `${quoted(target)} is not a list of ${key}: {{#each}} needs one`);
              break;
            }
            walk(node.program?.body ?? [], [...scopes, `${target}[]`]);
          } else {
            if (!allow.variables.has(target) && !allow.groups.has(target)) {
              problem(node, `${quoted(target)} is not a variable of ${key}`);
              break;
            }
            walk(node.program?.body ?? [], scopes);
          }
          walk(node.inverse?.body ?? [], scopes);
          break;
        }
        default:
          problem(
            node,
            `${node.type} is not allowed (partials, decorators and raw blocks are not available)`,
          );
      }
    }
  };

  walk(program.body, [""]);
  return problems;
}

/** The isolated Handlebars of the templates: no helper or partial registered elsewhere reaches them. */
function templateEnvironment(): typeof Handlebars {
  const handlebars = Handlebars.create();
  // The subset uses `if`, `unless` and `each` only; the other built-in helpers are removed as well.
  for (const helper of ["with", "lookup", "log"]) {
    handlebars.unregisterHelper(helper);
  }
  return handlebars;
}

const ENVIRONMENT = templateEnvironment();

type CompiledPart = (data: Readonly<Record<string, unknown>>) => string;

function compilePart(source: string, part: TemplatePart): CompiledPart {
  return ENVIRONMENT.compile(source, {
    strict: true,
    knownHelpersOnly: true,
    knownHelpers: { with: false, lookup: false, log: false },
    // The subject and the text part are not HTML: escaping would break the `&` and `=` of a link.
    noEscape: part !== "html",
  }) as CompiledPart;
}

/** Collapses every run of white space, line breaks included, to one space: a subject is one header line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Every problem of the three parts of a template of `key` (subject, HTML, text, in that order; a missing HTML part has
 * none): `checkTemplate` of each. An empty list means the template is valid for its key.
 */
export function checkTemplateSources(key: TemplateKey, sources: TemplateSources): TemplateProblem[] {
  const parts: ReadonlyArray<[TemplatePart, string | null]> = [
    ["subject", sources.subject],
    ["html", sources.html],
    ["txt", sources.text],
  ];
  return parts.flatMap(([part, source]) => (source === null ? [] : checkTemplate(key, part, source)));
}

/** The line Handlebars gives a runtime error (`lineNumber`), or `null`. */
function runtimeLineOf(error: unknown): number | null {
  const line = (error as { lineNumber?: unknown } | null)?.lineNumber;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
}

/**
 * Checks every part of `template` against its key (all problems at once, `TemplateInvalidError`) and compiles it in
 * strict mode.
 */
export function compileTemplate(template: EffectiveTemplate): CompiledTemplate {
  const { key, origin, sources } = template;
  const problems = checkTemplateSources(key, sources);
  if (problems.length > 0) {
    throw new TemplateInvalidError(key, origin, template.locale, problems);
  }
  const subject = compilePart(sources.subject, "subject");
  const html = sources.html === null ? null : compilePart(sources.html, "html");
  const text = compilePart(sources.text, "txt");
  const run = (
    part: TemplatePart,
    compiled: CompiledPart,
    data: Readonly<Record<string, unknown>>,
  ): string => {
    try {
      return compiled(data);
    } catch (error) {
      const reason = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
      throw new TemplateRenderError(key, origin, part, reason, runtimeLineOf(error));
    }
  };
  return Object.freeze({
    template,
    render(data: Readonly<Record<string, unknown>>): RenderedTemplate {
      return {
        subject: oneLine(run("subject", subject, data)),
        html: html === null ? null : run("html", html, data),
        text: run("txt", text, data),
      };
    },
  });
}

/** The locales whose tenant rows serve `locale`, best first: the locale, then its language (`en-GB`, `en`). */
export function templateLocales(locale: string): string[] {
  const language = locale.split("-")[0]?.toLowerCase() ?? "";
  return [...new Set([locale, language].filter((value) => value !== ""))];
}

/**
 * The tenant's row that e-mails of one key in `locale` use, among `rows` (rows of that key, any state): the active row
 * of the locale, else of its language (`templateLocales`), with a subject; `undefined` when the code default serves.
 * The rule of `effective`, which the console's template settings show too (settings/templates.service.ts: the
 * language's row of a locale without one of its own, `inheritedFrom`; FIX-W33-OTA).
 */
export function servingRowOf(
  rows: readonly NotificationTemplateRow[],
  locale: string,
): NotificationTemplateRow | undefined {
  for (const candidate of templateLocales(locale)) {
    const row = rows.find((entry) => entry.locale === candidate && entry.is_active && entry.subject !== null);
    if (row !== undefined) {
      return row;
    }
  }
  return undefined;
}

/** Injection token of the folder of the code defaults (the registry's, unless a test gives its own). */
export const NOTIFICATION_TEMPLATES_DIR = "NOTIFICATION_TEMPLATES_DIR";

/** What the console writes into a tenant's row (channel `email`). */
export interface TemplateRowValues {
  /** The three sources; `html` is always set by the console. */
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly isActive: boolean;
  /** `updated_at`, and `created_at` of a new row. */
  readonly now: Date;
}

/** Finds, checks, compiles and renders the template of an e-mail (see the file header). */
@Injectable()
export class TemplateService {
  /** The code defaults, read and compiled once per key: `undefined` for a key without files. */
  private readonly defaults = new Map<TemplateKey, Promise<CompiledTemplate | undefined>>();

  constructor(
    private readonly repository: OutboxRepository,
    @Optional() @Inject(NOTIFICATION_TEMPLATES_DIR) private readonly dir: string = DEFAULT_TEMPLATES_DIR,
  ) {}

  /**
   * The template of `key` for an e-mail in `locale`: the tenant's active row for the locale or its language, else the
   * code default (English). Throws `TemplateMissingError` when neither exists.
   */
  async effective(trx: TenantTransaction, key: TemplateKey, locale: string): Promise<EffectiveTemplate> {
    const rows = await this.repository.activeTemplates(trx, key, TEMPLATE_CHANNEL, templateLocales(locale));
    const row = servingRowOf(rows, locale);
    if (row !== undefined && row.subject !== null) {
      return Object.freeze({
        key,
        origin: "tenant",
        locale: row.locale,
        templateId: row.id,
        version: row.version,
        sources: Object.freeze({ subject: row.subject, html: row.body_html, text: row.body_text }),
      });
    }
    const fallback = await this.codeDefault(key);
    if (fallback === undefined) {
      throw new TemplateMissingError(key);
    }
    return fallback.template;
  }

  /** The code default of `key` (English), compiled; `undefined` when the key has no default files. */
  async codeDefault(key: TemplateKey): Promise<CompiledTemplate | undefined> {
    let compiled = this.defaults.get(key);
    if (compiled === undefined) {
      compiled = this.loadDefault(key);
      this.defaults.set(key, compiled);
      // A failed read is not kept: the next e-mail tries again.
      void compiled.catch(() => this.defaults.delete(key));
    }
    return compiled;
  }

  /**
   * `template` checked and compiled: a code default from the cache, a tenant row each time (rows change, and a check
   * and compilation take well under a millisecond). Throws `TemplateInvalidError`.
   */
  async compile(template: EffectiveTemplate): Promise<CompiledTemplate> {
    if (template.origin === "default") {
      const compiled = await this.codeDefault(template.key);
      if (compiled !== undefined) {
        return compiled;
      }
    }
    return compileTemplate(template);
  }

  /** Renders `template` with `data`. Throws `TemplateInvalidError` or `TemplateRenderError`. */
  async render(
    template: EffectiveTemplate,
    data: Readonly<Record<string, unknown>>,
  ): Promise<RenderedTemplate> {
    return (await this.compile(template)).render(data);
  }

  // ---- The tenant's rows as the console edits them (OBE-073; see the file header) --------------------------------

  /**
   * The tenant's row of `key` (channel `email`) in exactly `locale`, active or not, or `undefined`; locked
   * `FOR UPDATE` with `forUpdate`.
   */
  async tenantRow(
    trx: TenantTransaction,
    key: TemplateKey,
    locale: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<NotificationTemplateRow | undefined> {
    const query = trx
      .selectFrom("notification_templates")
      .selectAll()
      .where("key", "=", key)
      .where("channel", "=", TEMPLATE_CHANNEL)
      .where("locale", "=", locale);
    return await (options.forUpdate === true ? query.forUpdate() : query).executeTakeFirst();
  }

  /**
   * The tenant's rows (channel `email`) in any of `locales`, active or not, by key and locale; of `key` only when it is
   * given.
   */
  async tenantRows(
    trx: TenantTransaction,
    locales: readonly string[],
    key?: TemplateKey,
  ): Promise<NotificationTemplateRow[]> {
    if (locales.length === 0) {
      return [];
    }
    let query = trx
      .selectFrom("notification_templates")
      .selectAll()
      .where("channel", "=", TEMPLATE_CHANNEL)
      .where("locale", "in", [...locales]);
    if (key !== undefined) {
      query = query.where("key", "=", key);
    }
    return await query.orderBy("key").orderBy("locale").execute();
  }

  /**
   * Inserts the tenant's row `id` of `key` in `locale` at version 1 (not a system row; the key's sample data for the
   * console preview), or nothing when the key, channel and locale have a row already (a concurrent insert): then
   * `undefined`.
   */
  async insertRow(
    trx: TenantTransaction,
    id: string,
    key: TemplateKey,
    locale: string,
    values: TemplateRowValues,
  ): Promise<NotificationTemplateRow | undefined> {
    return await trx
      .insertInto("notification_templates")
      .values({
        id,
        key,
        channel: TEMPLATE_CHANNEL,
        locale,
        subject: values.subject,
        body_html: values.html,
        body_text: values.text,
        // jsonb is written as JSON text (conventions §1).
        sample_data: JSON.stringify(TEMPLATE_REGISTRY[key].sampleData),
        is_system: false,
        is_active: values.isActive,
        version: 1,
        created_at: values.now,
        updated_at: values.now,
      })
      .onConflict((conflict) => conflict.columns(["key", "channel", "locale"]).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Replaces the sources and the active flag of the row `id` at `version`, which becomes `version + 1`; the row is the
   * OTA's own from then on (`is_system` false). `undefined` when the row is gone or at another version.
   */
  async updateRow(
    trx: TenantTransaction,
    id: string,
    version: number,
    values: TemplateRowValues,
  ): Promise<NotificationTemplateRow | undefined> {
    return await trx
      .updateTable("notification_templates")
      .set({
        subject: values.subject,
        body_html: values.html,
        body_text: values.text,
        is_active: values.isActive,
        is_system: false,
        version: version + 1,
        updated_at: values.now,
      })
      .where("id", "=", id)
      .where("version", "=", version)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Deletes the tenant's row of `key` (channel `email`) in exactly `locale` and returns it, or `undefined` when there
   * is none. The e-mails it was used for keep their key (`notifications.template_id` becomes null).
   */
  async deleteRow(
    trx: TenantTransaction,
    key: TemplateKey,
    locale: string,
  ): Promise<NotificationTemplateRow | undefined> {
    return await trx
      .deleteFrom("notification_templates")
      .where("key", "=", key)
      .where("channel", "=", TEMPLATE_CHANNEL)
      .where("locale", "=", locale)
      .returningAll()
      .executeTakeFirst();
  }

  private async loadDefault(key: TemplateKey): Promise<CompiledTemplate | undefined> {
    const source = await loadTemplateDefault(key, this.dir);
    if (source === undefined) {
      return undefined;
    }
    return compileTemplate({
      key,
      origin: "default",
      locale: DEFAULT_TEMPLATE_LOCALE,
      templateId: null,
      version: 0,
      sources: Object.freeze({ subject: source.subject, html: source.html, text: source.text }),
    });
  }
}
