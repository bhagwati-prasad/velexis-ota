// The render data of an e-mail and its rendering (OBE-030; OADR-0013 items 3 and 5, OADR-0015 point 5, ADR-0017,
// db README §8). The render data of a key holds exactly the variables of its allow-list (templates/registry.ts):
//
//   brand.*     from the tenant's `storefront_settings` (brand name, support e-mail and phone; empty when not set) and
//               its storefront URL, `https://<key>.<STOREFRONT_BASE_DOMAIN>` (the tenant's sub-domain; custom domains
//               join with OBE-080);
//   links       built here from the e-mail's secret values, on that storefront URL: `verifyUrl` is
//               `<storefront>/account/verify.html?token=<token>`, `resetUrl` `<storefront>/account/reset-password.html?…`;
//               they exist only in memory while the worker renders the e-mail;
//   documents.attached
//               for the keys that attach booking documents (`attachesDocuments`: booking.confirmed, booking.ticketed),
//               what the sender decided when it sends the e-mail (OBE-055, attachments.ts): true when the documents
//               are attached, else false (the e-mail points to the booking page);
//   the rest    from `notifications.payload`, the variables the code that queued the e-mail passed
//               (`checkTemplateData` checked them then; only allow-listed paths are copied here).
//
// `NotificationRenderer.prepare` reads, in the caller's transaction, what a batch of rows needs from the tenant (the
// sender settings and the template of each key and locale); `RenderBatch.render` then renders one row in memory, after
// the transaction. A tenant template that turns out invalid or fails on its data (a template edited outside the
// console's checks, or a variable a later release removed from the allow-list) is logged
// (`notifications.template_fallback`, with the problems, never the data) and the code default is used instead, so a
// broken edit never stops the OTA's e-mails; a code default that fails is a bug, and the e-mail fails.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { SharedConfig } from "../config";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import { OutboxRepository, type SenderSettings } from "./outbox.repository";
import {
  TemplateInvalidError,
  TemplateMissingError,
  TemplateRenderError,
  TemplateService,
  type EffectiveTemplate,
  type RenderedTemplate,
} from "./template.service";
import {
  attachesDocuments,
  callerVariables,
  DOCUMENTS_ATTACHED_VARIABLE,
  isTemplateKey,
  TEMPLATE_REGISTRY,
  TemplateFilesError,
  type TemplateKey,
  type TemplateVariable,
} from "./templates/registry";

/** The longest string a variable may hold, in characters. */
export const MAX_VARIABLE_LENGTH = 4000;

/** The largest payload of one e-mail, as JSON text. */
export const MAX_PAYLOAD_JSON_LENGTH = 32_768;

/** The longest secret value, in characters (tokens are 43 characters of base64url). */
export const MAX_SECRET_LENGTH = 512;

/** The render data of an e-mail cannot be built: a programming error of the code that queued it, never retried. */
export class NotificationDataError extends Error {
  override readonly name = "NotificationDataError";
}

/** A JSON value of a payload. */
type Json = string | number | boolean | null | readonly Json[] | { readonly [name: string]: Json };

/** The shape the allow-list gives a payload: leaves, groups and lists. */
type Shape =
  | { readonly kind: "leaf" }
  | { readonly kind: "group"; readonly fields: Map<string, Shape> }
  | {
      readonly kind: "list";
      readonly item: Shape;
    };

/** Inserts the path `segments` (with `x[]` for lists) into the group `shape`. */
function addPath(shape: Map<string, Shape>, segments: readonly string[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return;
  }
  const list = head.endsWith("[]");
  const name = list ? head.slice(0, -2) : head;
  if (rest.length === 0 && !list) {
    shape.set(name, { kind: "leaf" });
    return;
  }
  let existing = shape.get(name);
  if (list) {
    if (existing === undefined || existing.kind !== "list") {
      existing = {
        kind: "list",
        item: rest.length === 0 ? { kind: "leaf" } : { kind: "group", fields: new Map() },
      };
      shape.set(name, existing);
    }
    if (existing.item.kind === "group") {
      addPath(existing.item.fields, rest);
    }
    return;
  }
  if (existing === undefined || existing.kind !== "group") {
    existing = { kind: "group", fields: new Map() };
    shape.set(name, existing);
  }
  addPath(existing.fields, rest);
}

function shapeOf(variables: readonly TemplateVariable[]): Map<string, Shape> {
  const root = new Map<string, Shape>();
  for (const entry of variables) {
    addPath(root, entry.name.split("."));
  }
  return root;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= MAX_VARIABLE_LENGTH)
  );
}

/** The problems of `value` against `shape` at `path`, by variable path; never a value. */
function shapeProblems(value: unknown, shape: Shape, path: string, problems: string[]): void {
  switch (shape.kind) {
    case "leaf":
      if (!isScalar(value)) {
        problems.push(
          `${path} must be a string of at most ${MAX_VARIABLE_LENGTH} characters, a number, a boolean or null`,
        );
      }
      return;
    case "list":
      if (!Array.isArray(value)) {
        problems.push(`${path} must be a list`);
        return;
      }
      for (const item of value) {
        shapeProblems(item, shape.item, `${path}[]`, problems);
      }
      return;
    case "group":
      groupProblems(value, shape.fields, path, problems);
  }
}

function groupProblems(value: unknown, fields: Map<string, Shape>, path: string, problems: string[]): void {
  if (!isPlainObject(value)) {
    problems.push(`${path === "" ? "the data" : path} must be an object`);
    return;
  }
  const prefix = path === "" ? "" : `${path}.`;
  for (const name of Object.keys(value)) {
    if (!fields.has(name)) {
      problems.push(`${prefix}${name} is not a variable of the template`);
    }
  }
  for (const [name, shape] of fields) {
    if (!(name in value)) {
      problems.push(`${prefix}${name} is missing`);
      continue;
    }
    shapeProblems(value[name], shape, `${prefix}${name}`, problems);
  }
}

/** Drops duplicates of a problem that a list repeats for each item. */
function distinct(problems: readonly string[]): string[] {
  return [...new Set(problems)];
}

/**
 * The problems of `data`, the variables code passes when it queues an e-mail of `key`: exactly the key's caller
 * variables (its allow-list without the brand and the links), every one present, scalars of at most
 * MAX_VARIABLE_LENGTH characters, lists as lists, at most MAX_PAYLOAD_JSON_LENGTH characters of JSON in all. An empty
 * list means valid. Messages name variables, never values.
 */
export function checkTemplateData(key: TemplateKey, data: unknown): string[] {
  const problems: string[] = [];
  groupProblems(data, shapeOf(callerVariables(key)), "", problems);
  if (problems.length === 0 && JSON.stringify(data).length > MAX_PAYLOAD_JSON_LENGTH) {
    problems.push(`the data is longer than ${MAX_PAYLOAD_JSON_LENGTH} characters of JSON`);
  }
  return distinct(problems);
}

/**
 * The problems of `secrets`, the secret values of an e-mail of `key`: exactly the key's `secrets`, each a non-empty
 * string of at most MAX_SECRET_LENGTH characters. Messages name the secrets, never their values.
 */
export function checkSecretData(key: TemplateKey, secrets: unknown): string[] {
  const expected = TEMPLATE_REGISTRY[key].secrets;
  if (secrets === undefined && expected.length === 0) {
    return [];
  }
  if (!isPlainObject(secrets)) {
    return expected.length === 0
      ? [`${key} has no secret values`]
      : [`the secret values ${expected.join(", ")} are required`];
  }
  const problems: string[] = [];
  for (const name of Object.keys(secrets)) {
    if (!expected.includes(name)) {
      problems.push(`${name} is not a secret value of ${key}`);
    }
  }
  for (const name of expected) {
    const value = secrets[name];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_LENGTH) {
      problems.push(`the secret value ${name} must be a string of 1 to ${MAX_SECRET_LENGTH} characters`);
    }
  }
  return problems;
}

/** A copy of what `value` holds of `shape`: allow-listed paths only. */
function pick(value: unknown, shape: Shape): Json | undefined {
  switch (shape.kind) {
    case "leaf":
      return isScalar(value) ? value : undefined;
    case "list":
      return Array.isArray(value)
        ? value.map((item) => pick(item, shape.item)).filter((item): item is Json => item !== undefined)
        : undefined;
    case "group":
      return pickGroup(value, shape.fields);
  }
}

function pickGroup(value: unknown, fields: Map<string, Shape>): { [name: string]: Json } | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const copy: { [name: string]: Json } = {};
  for (const [name, shape] of fields) {
    if (name in value) {
      const picked = pick(value[name], shape);
      if (picked !== undefined) {
        copy[name] = picked;
      }
    }
  }
  return copy;
}

/** Sets `value` at the dotted `path` of `target`, creating the groups on the way. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (isPlainObject(next)) {
      current = next;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  current[segments[segments.length - 1] ?? path] = value;
}

/** The `brand.*` variables of a tenant's e-mails. */
export interface BrandValues {
  readonly name: string;
  /** Empty when the OTA has not set it. */
  readonly supportEmail: string;
  /** Empty when the OTA has not set it. */
  readonly supportPhone: string;
  /** `https://<key>.<STOREFRONT_BASE_DOMAIN>`, without a trailing slash. */
  readonly storefrontUrl: string;
}

/** The storefront URL of a tenant: its sub-domain on STOREFRONT_BASE_DOMAIN, always https (ADR-0018). */
export function storefrontUrl(tenantKey: string, baseDomain: string): string {
  return `https://${tenantKey}.${baseDomain}`;
}

/**
 * The render data of an e-mail of `key` (see the file header): the allow-listed paths of `payload`, the brand, the
 * links built from `secrets` and, for a key that attaches documents, `documents.attached` (false unless
 * `documentsAttached`). Throws `NotificationDataError` when a secret a link needs is missing.
 */
export function renderData(
  key: TemplateKey,
  input: {
    readonly brand: BrandValues;
    readonly payload: unknown;
    readonly secrets: Readonly<Record<string, string>>;
    readonly documentsAttached?: boolean | undefined;
  },
): Record<string, unknown> {
  const definition = TEMPLATE_REGISTRY[key];
  const data: Record<string, unknown> = pickGroup(input.payload, shapeOf(callerVariables(key))) ?? {};
  data["brand"] = {
    name: input.brand.name,
    supportEmail: input.brand.supportEmail,
    supportPhone: input.brand.supportPhone,
    storefrontUrl: input.brand.storefrontUrl,
  };
  for (const link of definition.links) {
    const secret = input.secrets[link.secret];
    if (typeof secret !== "string" || secret === "") {
      throw new NotificationDataError(`An e-mail of ${key} lacks its secret value ${link.secret}`);
    }
    const query = new URLSearchParams({ [link.param]: secret }).toString();
    setPath(data, link.variable, `${input.brand.storefrontUrl}${link.path}?${query}`);
  }
  if (attachesDocuments(key)) {
    setPath(data, DOCUMENTS_ATTACHED_VARIABLE, input.documentsAttached === true);
  }
  return data;
}

/** How the sender sends a row (notifications.processor.ts, attachments.ts). */
export interface RenderOptions {
  /** The booking documents of the e-mail are attached (`documents.attached`); false when left out. */
  readonly documentsAttached?: boolean | undefined;
}

/** A rendered e-mail and how it was made. */
export interface RenderedNotification extends RenderedTemplate {
  /** The tenant row used (`notifications.template_id`); `null` for the code default. */
  readonly templateId: string | null;
  readonly origin: EffectiveTemplate["origin"];
}

/** What a row needs to be rendered. */
export interface RenderableRow {
  readonly id: string;
  readonly template_key: string;
  readonly locale: string;
  readonly payload: unknown;
}

/** The tenant's part of a batch of e-mails, read once: its sender settings and the templates of its rows. */
export interface RenderBatch {
  /** The tenant's sender settings; `undefined` before the tenant is seeded. */
  readonly sender: SenderSettings | undefined;
  readonly brand: BrandValues;
  /** Renders one row with its secret values (in memory). */
  render(
    row: RenderableRow,
    secrets: Readonly<Record<string, string>>,
    options?: RenderOptions,
  ): Promise<RenderedNotification>;
}

/** Builds the render data of e-mails and renders them (see the file header). */
@Injectable()
export class NotificationRenderer {
  private readonly baseDomain: string;

  constructor(
    private readonly templates: TemplateService,
    private readonly repository: OutboxRepository,
    @InjectPinoLogger(NotificationRenderer.name) private readonly logger: PinoLogger,
    config: ConfigService<SharedConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** The `brand.*` values of a tenant from its sender settings (the tenant's name when it has no settings row). */
  brand(
    tenant: { readonly key: string; readonly name: string },
    sender: SenderSettings | undefined,
  ): BrandValues {
    return {
      name: sender?.brandName ?? tenant.name,
      supportEmail: sender?.supportEmail ?? "",
      supportPhone: sender?.supportPhone ?? "",
      storefrontUrl: storefrontUrl(tenant.key, this.baseDomain),
    };
  }

  /**
   * Reads, in `trx`, the sender settings of the tenant and the template of each key and locale of `rows`, and returns
   * the batch that renders them after the transaction.
   */
  async prepare(
    trx: TenantTransaction,
    tenant: { readonly key: string; readonly name: string },
    rows: readonly RenderableRow[],
  ): Promise<RenderBatch> {
    const sender = await this.repository.senderSettings(trx);
    const brand = this.brand(tenant, sender);
    const effective = new Map<string, EffectiveTemplate | Error>();
    for (const row of rows) {
      const id = `${row.template_key}\u0000${row.locale}`;
      if (effective.has(id) || !isTemplateKey(row.template_key)) {
        continue;
      }
      try {
        effective.set(id, await this.templates.effective(trx, row.template_key, row.locale));
      } catch (error) {
        // A key without any template, or whose code default is broken (invalid, or some of its files missing: a bug
        // of a release), fails its rows only; the other rows of the batch are sent. Anything else (the database, a
        // file that cannot be read) fails the batch, whose claim then rolls back.
        if (!(
          error instanceof TemplateMissingError ||
          error instanceof TemplateInvalidError ||
          error instanceof TemplateFilesError
        )) {
          throw error;
        }
        effective.set(id, error);
      }
    }
    return {
      sender,
      brand,
      render: (row, secrets, options) => this.renderRow(row, secrets, brand, effective, options),
    };
  }

  private async renderRow(
    row: RenderableRow,
    secrets: Readonly<Record<string, string>>,
    brand: BrandValues,
    effective: ReadonlyMap<string, EffectiveTemplate | Error>,
    options: RenderOptions | undefined,
  ): Promise<RenderedNotification> {
    const key = row.template_key;
    if (!isTemplateKey(key)) {
      throw new NotificationDataError("The template key of the e-mail is not one of TEMPLATE_KEYS");
    }
    const template = effective.get(`${key}\u0000${row.locale}`);
    if (template === undefined || template instanceof Error) {
      throw template ?? new NotificationDataError(`No template was read for ${key}`);
    }
    const data = renderData(key, {
      brand,
      payload: row.payload,
      secrets,
      documentsAttached: options?.documentsAttached,
    });
    try {
      return {
        ...(await this.templates.render(template, data)),
        templateId: template.templateId,
        origin: template.origin,
      };
    } catch (error) {
      if (
        template.origin !== "tenant" ||
        !(error instanceof TemplateInvalidError || error instanceof TemplateRenderError)
      ) {
        throw error;
      }
      this.logger.warn(
        {
          notificationId: row.id,
          template: key,
          locale: template.locale,
          templateId: template.templateId,
          reason: error.message,
        },
        "notifications.template_fallback",
      );
      const fallback = await this.templates.codeDefault(key);
      if (fallback === undefined) {
        throw error;
      }
      return { ...fallback.render(data), templateId: null, origin: "default" };
    }
  }
}
