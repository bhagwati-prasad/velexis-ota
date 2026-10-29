// console.settings.templates.list, get, put, preview and reset (consoleListNotificationTemplates,
// consoleGetNotificationTemplate, consolePutNotificationTemplate, consolePreviewNotificationTemplate,
// consoleResetNotificationTemplate; `settings:read` / `settings:write`; OBE-073, api-changes part 2 §2.6, OADR-0013
// point 3): the OTA's e-mail templates (`notification_templates`, one row per key, channel and locale, shared by the
// test and live environments) as staff edit them, over the notifications module's own engine and rows
// (notifications/template.service.ts: the safe Handlebars subset, the key's allow-list of templates/registry.ts, strict
// mode).
//
// The template of a key, channel and locale (`NotificationTemplate`):
//   - the tenant's row of exactly that key, channel and locale when it exists, active or not (`customised: true`, its
//     version and `ETag: "<version>"`). A row the provisioning seed copied from a code default (`is_system`) is a row
//     of the OTA as well: shown, edited and reset as any other;
//   - else the code default of the key (`customised: false`, `isActive: true`, `version` and `updatedAt` null, no
//     `ETag`): English in the MVP, shown under the locale asked for.
// An e-mail takes the active row of its locale, else of its language (`en` for `en-GB`), else the code default
// (template.service.ts `effective`, read at every send): a row with `isActive: false` is kept and shown, and the e-mail
// uses the default; after a reset the next e-mail uses the default (or the row of the locale's language).
//
//   list     every key of TEMPLATE_KEYS for every locale of the storefront settings' `locales.supported`, by key, then
//            locale (a missing settings row → `403 TENANT_SUSPENDED`: the tenant is not ready).
//   get      the template of the path (any locale the schema allows).
//   put      the subject, HTML and text are checked against the key first (every problem at once →
//            `422 TEMPLATE_INVALID`, `details.errors[{part, line, message}]`, `part` one of `subject`, `bodyHtml`,
//            `bodyText` as the body names them); then, in one transaction: the locale must be one of the settings'
//            supported locales (`422 UNPROCESSABLE`, `details.reason = "locale_not_supported"`), the row is read
//            `FOR UPDATE`, and with a row `If-Match` is required and must match its version, without one it must be
//            absent (`412 PRECONDITION_FAILED` otherwise); the row is updated at `version + 1`, or inserted at
//            version 1 (when a concurrent put inserted it first, this one answers `412`: the row it did not know of
//            exists now);
//            the `staff_actions` row (`settings.templates.put`, target `notification_template`
//            `<key>/<channel>/<locale>`) holds the template before (null for a new row) and after. `isActive` absent
//            is true: a put replaces the template.
//   preview  renders without storing anything: the template of the path with the parts the body sends in place of its
//            own (a draft, checked as put checks it → `422 TEMPLATE_INVALID`), with the key's sample data (registry.ts;
//            the provisioning seed and put copy it into `sample_data`, and the registry stays the source, so a release
//            that adds a variable has its sample value) or, with `variables`, the sample data with the values sent in
//            their place (`previewData`; a value outside the allow-list or of the wrong kind → `400 VALIDATION_FAILED`
//            at `/variables/…`). Not audited: a read (`settings:read`).
//   reset    deletes the row (without one nothing changes) and answers the code default; the `staff_actions` row
//            (`settings.templates.reset`, same target) holds the deleted template, or null.
//
// The HTML part is rendered with Handlebars' HTML escaping always on (the subset has no triple braces), so no value of
// the render data reaches the HTML unescaped; the OTA admin shows it in a sandboxed iframe without scripts. The subject
// and the text are plain text. Errors name parts, lines and variables, never a value of the render data.
import { Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { AppError, type FieldError } from "@velexis/errors";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { consoleAction, StaffActionsWriter } from "../console/staff-actions.writer";
import type { NotificationTemplateRow } from "../notifications/outbox.repository";
import { MAX_VARIABLE_LENGTH } from "../notifications/renderer";
import {
  checkTemplateSources,
  compileTemplate,
  TemplateInvalidError,
  TemplateMissingError,
  TemplateRenderError,
  TemplateService,
  type CompiledTemplate,
  type EffectiveTemplate,
  type TemplateProblem,
  type TemplateSources,
} from "../notifications/template.service";
import {
  TEMPLATE_CHANNEL,
  TEMPLATE_KEYS,
  TEMPLATE_REGISTRY,
  type TemplateKey,
  type TemplatePart,
} from "../notifications/templates/registry";
import { StorefrontRepository } from "../storefront/storefront.repository";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";

type Schemas = components["schemas"];

export type ConsoleNotificationTemplate = Schemas["NotificationTemplate"];
export type NotificationTemplateList = Schemas["NotificationTemplateList"];
export type NotificationTemplateInput = Schemas["NotificationTemplateInput"];
export type NotificationTemplatePreviewRequest = Schemas["NotificationTemplatePreviewRequest"];
export type NotificationTemplatePreview = Schemas["NotificationTemplatePreview"];

/** The `Cache-Control` of every answer: staff data, never stored by a cache. */
export const TEMPLATES_CACHE_CONTROL = "private, no-store";

/** The `ETag` of a row at `version`. */
export function templateEtagOf(version: number): string {
  return `"${version}"`;
}

/** A template as the path names it. */
export interface TemplateAddress {
  readonly key: TemplateKey;
  readonly channel: string;
  readonly locale: string;
}

/** The `staff_actions` target type of the template operations. */
export const TEMPLATE_TARGET_TYPE = "notification_template";

/** The `staff_actions` target id of a template: its path, `<key>/<channel>/<locale>` (rows come and go, it stays). */
export function templateTargetId(address: TemplateAddress): string {
  return `${address.key}/${address.channel}/${address.locale}`;
}

// ---- 422 TEMPLATE_INVALID ---------------------------------------------------------------------------------------

/** A part of a template as the API names it (the fields of NotificationTemplateInput). */
export type TemplateApiPart = "subject" | "bodyHtml" | "bodyText";

const API_PART: Readonly<Record<TemplatePart, TemplateApiPart>> = Object.freeze({
  subject: "subject",
  html: "bodyHtml",
  txt: "bodyText",
});

/** One item of `details.errors` of `422 TEMPLATE_INVALID`. */
export interface TemplateError {
  readonly part: TemplateApiPart;
  /** The 1-based line in that part; `null` when the parser gave none. */
  readonly line: number | null;
  readonly message: string;
}

/** The engine's problems as `details.errors` items. */
export function templateErrorsOf(problems: readonly TemplateProblem[]): TemplateError[] {
  return problems.map((problem) => ({
    part: API_PART[problem.part],
    line: problem.line,
    message: problem.message,
  }));
}

/**
 * The `details.errors` item of a strict-mode render failure: Handlebars' `"name" not defined in … - 2:4` names the
 * variable and its position, never a value.
 */
export function renderErrorOf(error: TemplateRenderError): TemplateError {
  const missing = /^"([^"]*)" not defined in /.exec(error.reason);
  return {
    part: API_PART[error.part],
    line: error.line,
    message:
      missing === null
        ? error.reason.replace(/ - \d+:\d+$/, "")
        : `${JSON.stringify(missing[1])} has no value in the render data`,
  };
}

function templateInvalid(errors: readonly TemplateError[]): AppError {
  return new AppError("TEMPLATE_INVALID", {
    message: "The template does not compile or uses a variable that is not allowed.",
    details: { errors: errors.map((error) => ({ ...error })) },
  });
}

// ---- The template as the document shows it ------------------------------------------------------------------------

/** The allow-list of `key` as `variables` lists it. */
function variablesOf(key: TemplateKey): ConsoleNotificationTemplate["variables"] {
  return TEMPLATE_REGISTRY[key].variables.map((entry) => ({
    name: entry.name,
    description: entry.description,
  }));
}

/** The template of a tenant's row of `key`. */
export function templateOfRow(key: TemplateKey, row: NotificationTemplateRow): ConsoleNotificationTemplate {
  return {
    key,
    channel: TEMPLATE_CHANNEL,
    locale: row.locale,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    variables: variablesOf(key),
    customised: true,
    isActive: row.is_active,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The code default of `key` (`sources`) shown under `locale`. */
export function templateOfDefault(
  key: TemplateKey,
  locale: string,
  sources: TemplateSources,
): ConsoleNotificationTemplate {
  return {
    key,
    channel: TEMPLATE_CHANNEL,
    locale,
    subject: sources.subject,
    bodyHtml: sources.html,
    bodyText: sources.text,
    variables: variablesOf(key),
    customised: false,
    isActive: true,
    version: null,
    updatedAt: null,
  };
}

/** What `staff_actions` keeps of a row: the template, without the allow-list (code, not state). */
function auditViewOf(row: NotificationTemplateRow): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    channel: row.channel,
    locale: row.locale,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    isActive: row.is_active,
    version: row.version,
  };
}

// ---- The preview's render data ------------------------------------------------------------------------------------

/** The shape the allow-list gives render data: values, groups and lists. */
type Shape =
  | { readonly kind: "value" }
  | { readonly kind: "group"; readonly fields: Map<string, Shape> }
  | { readonly kind: "list"; readonly item: Shape };

/** Inserts the variable path `segments` (`x[]` for a list) into the group `fields`. */
function addVariable(fields: Map<string, Shape>, segments: readonly string[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return;
  }
  if (head.endsWith("[]")) {
    const name = head.slice(0, -2);
    let list = fields.get(name);
    if (list?.kind !== "list") {
      list = {
        kind: "list",
        item: rest.length === 0 ? { kind: "value" } : { kind: "group", fields: new Map() },
      };
      fields.set(name, list);
    }
    if (list.item.kind === "group") {
      addVariable(list.item.fields, rest);
    }
    return;
  }
  if (rest.length === 0) {
    fields.set(head, { kind: "value" });
    return;
  }
  let group = fields.get(head);
  if (group?.kind !== "group") {
    group = { kind: "group", fields: new Map() };
    fields.set(head, group);
  }
  addVariable(group.fields, rest);
}

const SHAPES = new Map<TemplateKey, Shape>();

/** The shape of the whole allow-list of `key` (brand, links and `documents.attached` included). */
function shapeOf(key: TemplateKey): Shape {
  let shape = SHAPES.get(key);
  if (shape === undefined) {
    const fields = new Map<string, Shape>();
    for (const entry of TEMPLATE_REGISTRY[key].variables) {
      addVariable(fields, entry.name.split("."));
    }
    shape = { kind: "group", fields };
    SHAPES.set(key, shape);
  }
  return shape;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A segment of a JSON pointer (RFC 6901). */
const pointerSegment = (name: string): string => name.replace(/~/g, "~0").replace(/\//g, "~1");

/** At most this many field errors are answered, as request validation answers them. */
const MAX_VARIABLE_ERRORS = 20;

/** The problems of `value` against `shape` at the JSON pointer `path`; messages without the value. */
function variableProblems(
  key: TemplateKey,
  value: unknown,
  shape: Shape,
  path: string,
  problems: FieldError[],
): void {
  switch (shape.kind) {
    case "value":
      if (typeof value === "string") {
        if (value.length > MAX_VARIABLE_LENGTH) {
          problems.push({
            path,
            code: "maxLength",
            message: `must be at most ${MAX_VARIABLE_LENGTH} characters`,
          });
        }
      } else if (!(
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )) {
        problems.push({ path, code: "type", message: "must be a string, a number, a boolean or null" });
      }
      return;
    case "list":
      if (!Array.isArray(value)) {
        problems.push({ path, code: "type", message: "must be a list" });
        return;
      }
      value.forEach((item: unknown, index) => {
        variableProblems(key, item, shape.item, `${path}/${index}`, problems);
      });
      return;
    case "group":
      if (!isPlainObject(value)) {
        problems.push({ path, code: "type", message: "must be an object" });
        return;
      }
      for (const [name, item] of Object.entries(value)) {
        const field = shape.fields.get(name);
        const at = `${path}/${pointerSegment(name)}`;
        if (field === undefined) {
          problems.push({ path: at, code: "additionalProperties", message: `is not a variable of ${key}` });
        } else {
          variableProblems(key, item, field, at, problems);
        }
      }
  }
}

/**
 * `given` (checked against `shape`) with the sample data `sample` where it sends nothing: a group takes each field it
 * sends merged into the sample's, and the sample's for the others; a list replaces the sample's list, each of its items
 * merged into the sample's first item; a value replaces the sample's. Only allow-listed paths are kept.
 */
function mergeIntoSample(sample: unknown, given: unknown, shape: Shape): unknown {
  switch (shape.kind) {
    case "value":
      return given;
    case "list": {
      const sampleItem: unknown = Array.isArray(sample) ? sample[0] : undefined;
      return (given as readonly unknown[]).map((item) => mergeIntoSample(sampleItem, item, shape.item));
    }
    case "group": {
      const sent = given as Record<string, unknown>;
      const base = isPlainObject(sample) ? sample : {};
      const data: Record<string, unknown> = {};
      for (const [name, field] of shape.fields) {
        if (Object.hasOwn(sent, name)) {
          data[name] = mergeIntoSample(base[name], sent[name], field);
        } else if (Object.hasOwn(base, name)) {
          data[name] = base[name];
        }
      }
      return data;
    }
  }
}

/** The render data of a preview, or the field errors of `variables`. */
export type PreviewData =
  | { readonly data: Readonly<Record<string, unknown>>; readonly fieldErrors?: undefined }
  | { readonly data?: undefined; readonly fieldErrors: readonly FieldError[] };

/**
 * The render data of a preview of `key`: the key's sample data, or, when `variables` is sent, the sample data with the
 * values it sends in their place (`mergeIntoSample`). A path outside the key's allow-list, a value of the wrong kind
 * (an object for a value, a value for a group or a list) or a string longer than MAX_VARIABLE_LENGTH is a field error
 * at `/variables/…` (JSON pointers into the body).
 */
export function previewData(key: TemplateKey, variables: unknown): PreviewData {
  const sample = TEMPLATE_REGISTRY[key].sampleData;
  if (variables === undefined) {
    return { data: sample };
  }
  const shape = shapeOf(key);
  const problems: FieldError[] = [];
  variableProblems(key, variables, shape, "/variables", problems);
  if (problems.length > 0) {
    return { fieldErrors: problems.slice(0, MAX_VARIABLE_ERRORS) };
  }
  return { data: mergeIntoSample(sample, variables, shape) as Record<string, unknown> };
}

// ---- The service --------------------------------------------------------------------------------------------------

/** A tenant whose settings row is missing (provisioning did not seed it): not ready, as storefront.get answers. */
function notReady(): AppError {
  return new AppError("TENANT_SUSPENDED", {
    message: "The storefront settings of this OTA are not ready yet.",
  });
}

/** The address of a path, checked: the schema allows `email` only, so another channel names no template. */
function checkedChannel(address: TemplateAddress): void {
  if (address.channel !== TEMPLATE_CHANNEL) {
    throw new AppError("NOT_FOUND", { message: "The OTA's templates are e-mail templates only." });
  }
}

const rowId = (key: string, locale: string): string => `${key}\u0000${locale}`;

@Injectable()
export class TemplateSettingsService {
  constructor(
    private readonly tx: TenantTx,
    private readonly templates: TemplateService,
    private readonly storefront: StorefrontRepository,
    private readonly writer: StaffActionsWriter,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** console.settings.templates.list. */
  async list(): Promise<NotificationTemplateList> {
    const { locales, rows } = await this.tx.run(async (trx) => {
      const supported = await this.supportedLocales(trx);
      const sorted = [...new Set(supported)].sort();
      return { locales: sorted, rows: await this.templates.tenantRows(trx, sorted) };
    });
    const byId = new Map(rows.map((row) => [rowId(row.key, row.locale), row]));
    const data: ConsoleNotificationTemplate[] = [];
    for (const key of [...TEMPLATE_KEYS].sort()) {
      for (const locale of locales) {
        const row = byId.get(rowId(key, locale));
        data.push(
          row === undefined
            ? templateOfDefault(key, locale, (await this.codeDefault(key)).template.sources)
            : templateOfRow(key, row),
        );
      }
    }
    return { data };
  }

  /** console.settings.templates.get. */
  async get(address: TemplateAddress): Promise<ConsoleNotificationTemplate> {
    checkedChannel(address);
    const row = await this.tx.run((trx) => this.templates.tenantRow(trx, address.key, address.locale));
    return row === undefined
      ? templateOfDefault(address.key, address.locale, (await this.codeDefault(address.key)).template.sources)
      : templateOfRow(address.key, row);
  }

  /** console.settings.templates.put with the `If-Match` of the request (see the file header). */
  async put(
    address: TemplateAddress,
    input: NotificationTemplateInput,
    ifMatch: string | undefined,
  ): Promise<ConsoleNotificationTemplate> {
    checkedChannel(address);
    const { key, locale } = address;
    const sources: TemplateSources = { subject: input.subject, html: input.bodyHtml, text: input.bodyText };
    const problems = checkTemplateSources(key, sources);
    if (problems.length > 0) {
      throw templateInvalid(templateErrorsOf(problems));
    }
    const values = {
      subject: input.subject,
      html: input.bodyHtml,
      text: input.bodyText,
      isActive: input.isActive ?? true,
      now: this.clock.now(),
    };
    const saved = await this.tx.run(async (trx) => {
      if (!(await this.supportedLocales(trx)).includes(locale)) {
        throw new AppError("UNPROCESSABLE", {
          message: `The storefront does not offer the locale ${locale}.`,
          details: { reason: "locale_not_supported" },
        });
      }
      const row = await this.templates.tenantRow(trx, key, locale, { forUpdate: true });
      let written: NotificationTemplateRow | undefined;
      if (row === undefined) {
        written =
          ifMatch === undefined
            ? await this.templates.insertRow(trx, this.ids.newId("ntt"), key, locale, values)
            : undefined;
      } else if (ifMatch !== undefined && ifMatchSatisfied(ifMatch, row.version)) {
        written = await this.templates.updateRow(trx, row.id, row.version, values);
      }
      if (written === undefined) {
        // A row without If-Match, a stale If-Match, If-Match without a row, or a row a concurrent put inserted.
        throw new AppError("PRECONDITION_FAILED");
      }
      await this.writer.record(trx, {
        action: consoleAction("consolePutNotificationTemplate"),
        targetType: TEMPLATE_TARGET_TYPE,
        targetId: templateTargetId(address),
        before: row === undefined ? null : auditViewOf(row),
        after: auditViewOf(written),
      });
      return written;
    });
    return templateOfRow(key, saved);
  }

  /** console.settings.templates.preview with the request's body (see the file header). */
  async preview(
    address: TemplateAddress,
    body: NotificationTemplatePreviewRequest | undefined,
  ): Promise<NotificationTemplatePreview> {
    checkedChannel(address);
    const prepared = previewData(address.key, body?.variables);
    if (prepared.fieldErrors !== undefined) {
      throw new AppError("VALIDATION_FAILED", {
        message: "The preview's variables do not match the template's variables.",
        fieldErrors: prepared.fieldErrors,
      });
    }
    const compiled = await this.previewTemplate(address, body ?? {});
    try {
      const rendered = compiled.render(prepared.data);
      return { subject: rendered.subject, html: rendered.html, text: rendered.text };
    } catch (error) {
      if (error instanceof TemplateRenderError) {
        throw templateInvalid([renderErrorOf(error)]);
      }
      throw error;
    }
  }

  /** console.settings.templates.reset (see the file header). */
  async reset(address: TemplateAddress): Promise<ConsoleNotificationTemplate> {
    checkedChannel(address);
    const { key, locale } = address;
    // The default is read first: a key without one (a bug of a release) deletes nothing.
    const fallback = await this.codeDefault(key);
    await this.tx.run(async (trx) => {
      const deleted = await this.templates.deleteRow(trx, key, locale);
      await this.writer.record(trx, {
        action: consoleAction("consoleResetNotificationTemplate"),
        targetType: TEMPLATE_TARGET_TYPE,
        targetId: templateTargetId(address),
        before: deleted === undefined ? null : auditViewOf(deleted),
        after: null,
      });
    });
    return templateOfDefault(key, locale, fallback.template.sources);
  }

  /**
   * The compiled template a preview renders: the template of the path (the tenant's row, active or not, else the code
   * default) with the draft parts of `draft` in place of its own. Throws `422 TEMPLATE_INVALID`.
   */
  private async previewTemplate(
    address: TemplateAddress,
    draft: NotificationTemplatePreviewRequest,
  ): Promise<CompiledTemplate> {
    const { key, locale } = address;
    const row = await this.tx.run((trx) => this.templates.tenantRow(trx, key, locale));
    const stored: EffectiveTemplate =
      row === undefined
        ? (await this.codeDefault(key)).template
        : {
            key,
            origin: "tenant",
            locale: row.locale,
            templateId: row.id,
            version: row.version,
            // The CHECK of `notification_templates` keeps an e-mail row's subject set.
            sources: { subject: row.subject ?? "", html: row.body_html, text: row.body_text },
          };
    const sources: TemplateSources = {
      subject: draft.subject ?? stored.sources.subject,
      html: draft.bodyHtml ?? stored.sources.html,
      text: draft.bodyText ?? stored.sources.text,
    };
    try {
      return compileTemplate({ ...stored, origin: "tenant", sources });
    } catch (error) {
      if (error instanceof TemplateInvalidError) {
        throw templateInvalid(templateErrorsOf(error.problems));
      }
      throw error;
    }
  }

  /** The compiled code default of `key`; a key without one is a bug of a release (`500`). */
  private async codeDefault(key: TemplateKey): Promise<CompiledTemplate> {
    const compiled = await this.templates.codeDefault(key);
    if (compiled === undefined) {
      throw new TemplateMissingError(key);
    }
    return compiled;
  }

  /** The storefront settings' supported locales; a missing settings row is `403 TENANT_SUSPENDED`. */
  private async supportedLocales(trx: TenantTransaction): Promise<readonly string[]> {
    const settings = await this.storefront.settings(trx);
    if (settings === undefined) {
      throw notReady();
    }
    return settings.supportedLocales;
  }
}
