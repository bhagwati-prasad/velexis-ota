// The platform's e-mail templates (PBE-011; PADR-0013 item 5, ADR-0017 "Templates", platform/docs/scope.md PF-97).
// Each template is three Handlebars files in `templates/`: `<key>.subject.hbs`, `<key>.html.hbs` and `<key>.txt.hbs`
// (English in the MVP). The build copies the folder next to the compiled code (`dist/notifications/templates`), and
// the worker loads and compiles every template once, when it starts.
//
// Every template has an allow-list of variables (EMAIL_TEMPLATES): the non-secret `variables`, stored in clear in
// `email_outbox.data`, and the `secretVariables` (links with tokens), stored only encrypted in
// `secret_payload_ciphertext` (PADR-0013 items 1 and 3). The built-in `portalUrl` and `adminUrl` (PUBLIC_PORTAL_URL and
// PUBLIC_PLATFORM_ADMIN_URL) are added by the renderer. The allow-list is checked three times: when the templates are
// loaded (a template may only name its own variables and the built-ins), when an e-mail is queued (the caller passes
// exactly the template's variables, as strings), and when it is rendered (the stored values still match).
//
// Templates are logic-less: plain text and `{{variable}}`, no helpers, blocks, partials or triple braces. They are
// compiled in an isolated Handlebars environment in strict mode, so a missing variable is an error and never an empty
// string. The HTML part is HTML-escaped; the subject and the text part are not HTML and are not escaped (a link stays
// a working link), and the subject is one line.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";

/** The template keys of M1 (PADR-0013 item 5) and of the M5 tasks, which add theirs here and in `templates/`. */
export const EMAIL_TEMPLATE_KEYS = [
  "auth.verify_email",
  "auth.account_exists",
  "auth.password_reset",
  "auth.password_changed",
  "auth.mfa_changed",
  "team.invitation",
  "tenant.welcome",
  "tenant.provisioning_failed",
  "tenant.suspended",
  "tenant.resumed",
  "ops.alert",
  // M5: the review of a payout account (PBE-058, adminReviewPayoutAccount).
  "payouts.reviewed",
] as const;

/** A key of EMAIL_TEMPLATE_KEYS. */
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** One template's allow-list and what triggers it. */
export interface EmailTemplateDefinition {
  /** What sends it (PADR-0013 item 5). */
  readonly trigger: string;
  /** Non-secret variables, stored in clear in `email_outbox.data`. */
  readonly variables: readonly string[];
  /** Secret variables (links with tokens), stored encrypted and erased when the e-mail is final. */
  readonly secretVariables: readonly string[];
}

function definition(
  trigger: string,
  variables: string[],
  secretVariables: string[] = [],
): EmailTemplateDefinition {
  return Object.freeze({
    trigger,
    variables: Object.freeze(variables),
    secretVariables: Object.freeze(secretVariables),
  });
}

/** The allow-list of every template. A variable whose name ends in `Url` is a link (see `isLinkVariable`). */
export const EMAIL_TEMPLATES: Readonly<Record<EmailTemplateKey, EmailTemplateDefinition>> = Object.freeze({
  "auth.verify_email": definition("Sign-up and resend verification", ["fullName"], ["verifyUrl"]),
  "auth.account_exists": definition(
    "Sign-up with an e-mail address that has an account",
    ["fullName"],
    ["resetUrl"],
  ),
  "auth.password_reset": definition("Password reset request", ["fullName"], ["resetUrl"]),
  "auth.password_changed": definition("Password changed or reset", ["fullName"]),
  "auth.mfa_changed": definition("MFA turned on or off, recovery codes renewed, MFA reset", [
    "fullName",
    "change",
  ]),
  "team.invitation": definition(
    "Invitation created or resent",
    ["tenantName", "inviterName", "role"],
    ["acceptUrl"],
  ),
  "tenant.welcome": definition("Tenant activated", ["fullName", "tenantName", "tenantKey"]),
  "tenant.provisioning_failed": definition("Provisioning job failed", [
    "fullName",
    "tenantName",
    "tenantKey",
  ]),
  "tenant.suspended": definition("Tenant suspended", ["fullName", "tenantName", "tenantKey"]),
  "tenant.resumed": definition("Tenant resumed", ["fullName", "tenantName", "tenantKey"]),
  "ops.alert": definition("Pool low, live office request, payout account to review, provisioning failure", [
    "title",
    "message",
  ]),
  "payouts.reviewed": definition("A platform admin verified or rejected the payout account (to the owners)", [
    "fullName",
    "tenantName",
    "tenantKey",
    "outcome",
    "nextStep",
    "payoutAccountUrl",
  ]),
});

/** Variables every template may use, filled in by the renderer from the configuration (PADR-0013 item 7). */
export const BUILT_IN_VARIABLES = ["portalUrl", "adminUrl"] as const;

/** The values of the built-in variables. */
export interface BuiltInVariables {
  /** PUBLIC_PORTAL_URL. */
  readonly portalUrl: string;
  /** PUBLIC_PLATFORM_ADMIN_URL. */
  readonly adminUrl: string;
}

/** The three files of a template, by part: `<key>.<part>.hbs`. */
export const TEMPLATE_PARTS = ["subject", "html", "txt"] as const;

/** A part of a template. */
export type TemplatePart = (typeof TEMPLATE_PARTS)[number];

/** The folder of the `.hbs` files: `src/notifications/templates`, and `dist/notifications/templates` after the build. */
export const TEMPLATES_DIR = join(__dirname, "templates");

/** The longest value a variable may have, in characters. */
export const MAX_VARIABLE_LENGTH = 4000;

/** True when `value` is a key of EMAIL_TEMPLATE_KEYS. */
export function isEmailTemplateKey(value: unknown): value is EmailTemplateKey {
  return typeof value === "string" && (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** True for the variables that hold a link (`verifyUrl`, `portalUrl`): their names end in `Url`. */
export function isLinkVariable(name: string): boolean {
  return name.endsWith("Url");
}

/**
 * The variables of an e-mail do not match its template's allow-list, or a value is not a string of at most
 * MAX_VARIABLE_LENGTH characters. The message names the template and the variables, never a value.
 */
export class EmailVariablesError extends Error {
  override readonly name = "EmailVariablesError";
}

/** A template file is missing, does not parse, or names something its allow-list does not have. */
export class EmailTemplateError extends Error {
  override readonly name = "EmailTemplateError";
}

/** The variables of one e-mail: the non-secret ones and the secret ones, by name. */
export interface EmailVariables {
  readonly data: Readonly<Record<string, unknown>>;
  readonly secretData: Readonly<Record<string, unknown>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The problems of one group of variables against its allow-list, by variable name. */
function groupProblems(group: string, values: unknown, allowed: readonly string[]): string[] {
  if (!isPlainObject(values)) {
    return [`${group} must be an object`];
  }
  const names = Object.keys(values);
  const problems: string[] = [];
  const unknown = names.filter((name) => !allowed.includes(name));
  const missing = allowed.filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    problems.push(`${group} has variables the template does not allow: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    problems.push(`${group} lacks the variables ${missing.join(", ")}`);
  }
  const invalid = names.filter((name) => {
    const value = values[name];
    return allowed.includes(name) && (typeof value !== "string" || value.length > MAX_VARIABLE_LENGTH);
  });
  if (invalid.length > 0) {
    problems.push(
      `${group} has values that are not strings of at most ${MAX_VARIABLE_LENGTH} characters: ${invalid.join(", ")}`,
    );
  }
  return problems;
}

/**
 * Checks the variables of an e-mail of template `key` against its allow-list: `data` holds exactly the template's
 * `variables` and `secretData` exactly its `secretVariables`, each a string of at most MAX_VARIABLE_LENGTH characters.
 * Throws an `EmailVariablesError` that names the variables, never a value.
 */
export function checkEmailVariables(key: EmailTemplateKey, variables: EmailVariables): void {
  const template = EMAIL_TEMPLATES[key];
  const problems = [
    ...groupProblems("data", variables.data, template.variables),
    ...groupProblems("secretData", variables.secretData, template.secretVariables),
  ];
  if (problems.length > 0) {
    throw new EmailVariablesError(`E-mail template ${key}: ${problems.join("; ")}`);
  }
}

/** One node of a Handlebars AST, as far as the checks below read it. */
interface AstNode {
  readonly type: string;
  readonly path?: {
    readonly type: string;
    readonly original?: unknown;
    readonly parts?: readonly unknown[];
    readonly depth?: number;
    readonly data?: boolean;
  };
  readonly params?: readonly unknown[];
  readonly hash?: unknown;
  readonly escaped?: boolean;
  readonly body?: readonly AstNode[];
}

/**
 * The variables a template source names, after checking that it is logic-less: only text, comments and `{{name}}`
 * mustaches of one identifier (no helpers, blocks, partials, paths with dots or `this`, and no triple braces, which
 * would turn escaping off). Throws an `EmailTemplateError` that says what is not allowed.
 */
export function templateVariables(source: string, where: string): Set<string> {
  let program: { readonly body: readonly AstNode[] };
  try {
    program = Handlebars.parse(source) as unknown as { readonly body: readonly AstNode[] };
  } catch (error) {
    throw new EmailTemplateError(`${where} does not parse: ${(error as Error).message}`);
  }
  const names = new Set<string>();
  for (const node of program.body) {
    if (node.type === "ContentStatement" || node.type === "CommentStatement") {
      continue;
    }
    const path = node.path;
    const simple =
      node.type === "MustacheStatement" &&
      node.escaped === true &&
      (node.params ?? []).length === 0 &&
      node.hash === undefined &&
      path?.type === "PathExpression" &&
      path.data !== true &&
      (path.depth ?? 0) === 0 &&
      path.parts?.length === 1 &&
      path.parts[0] === path.original &&
      typeof path.original === "string" &&
      /^[A-Za-z][A-Za-z0-9]*$/.test(path.original);
    if (!simple) {
      throw new EmailTemplateError(
        `${where} may only hold text and {{variable}} mustaches (found a ${node.type}${node.escaped === false ? " with triple braces" : ""})`,
      );
    }
    names.add(path.original as string);
  }
  return names;
}

/** What one e-mail looks like once rendered. */
export interface RenderedEmail {
  /** One line, without leading or trailing spaces. */
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

type CompiledPart = (context: Record<string, unknown>) => string;

/** One template's compiled parts. */
interface CompiledTemplate {
  readonly subject: CompiledPart;
  readonly html: CompiledPart;
  readonly text: CompiledPart;
}

/** The file name of a template part. */
export function templateFileName(key: EmailTemplateKey, part: TemplatePart): string {
  return `${key}.${part}.hbs`;
}

/**
 * Compiles one part in strict mode without helpers: a variable missing from the context throws instead of rendering
 * as an empty string. Only the HTML part is HTML-escaped: the subject and the text part keep the `&` and `=` of a link.
 */
export function compileTemplatePart(
  handlebars: typeof Handlebars,
  source: string,
  part: TemplatePart,
): (context: Record<string, unknown>) => string {
  return handlebars.compile(source, {
    strict: true,
    knownHelpersOnly: true,
    noEscape: part !== "html",
  }) as (context: Record<string, unknown>) => string;
}

/** Collapses every run of white space, line breaks included, to one space: a subject is one header line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Every template of EMAIL_TEMPLATE_KEYS, compiled. `load()` reads the folder once: a missing or extra file, a template
 * that is not logic-less, or one that names a variable outside its allow-list and the built-ins stops the load.
 */
export class EmailTemplates {
  private constructor(private readonly compiled: ReadonlyMap<EmailTemplateKey, CompiledTemplate>) {}

  /** Reads, checks and compiles the templates of `dir` (default TEMPLATES_DIR). */
  static load(dir: string = TEMPLATES_DIR): EmailTemplates {
    // An environment of its own: no helper or partial registered anywhere else can reach these templates.
    const handlebars = Handlebars.create();
    const expected = new Set<string>();
    const compiled = new Map<EmailTemplateKey, CompiledTemplate>();
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const allowed = new Set<string>([
        ...BUILT_IN_VARIABLES,
        ...EMAIL_TEMPLATES[key].variables,
        ...EMAIL_TEMPLATES[key].secretVariables,
      ]);
      const parts = {} as Record<TemplatePart, CompiledPart>;
      for (const part of TEMPLATE_PARTS) {
        const file = templateFileName(key, part);
        expected.add(file);
        let source: string;
        try {
          source = readFileSync(join(dir, file), "utf8");
        } catch (error) {
          throw new EmailTemplateError(
            `E-mail template file ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
          );
        }
        const outside = [...templateVariables(source, file)].filter((name) => !allowed.has(name));
        if (outside.length > 0) {
          throw new EmailTemplateError(
            `${file} names variables outside its allow-list: ${outside.join(", ")}`,
          );
        }
        parts[part] = compileTemplatePart(handlebars, source, part);
      }
      compiled.set(key, { subject: parts.subject, html: parts.html, text: parts.txt });
    }
    const extra = readdirSync(dir).filter((file) => !expected.has(file));
    if (extra.length > 0) {
      throw new EmailTemplateError(`The template folder holds files of no template: ${extra.join(", ")}`);
    }
    return new EmailTemplates(compiled);
  }

  /**
   * Renders the e-mail of template `key`: checks the variables against the allow-list (`EmailVariablesError`), then
   * renders the three parts in strict mode with the built-in variables added.
   */
  render(key: EmailTemplateKey, variables: EmailVariables, builtIns: BuiltInVariables): RenderedEmail {
    checkEmailVariables(key, variables);
    const template = this.compiled.get(key);
    if (template === undefined) {
      throw new EmailTemplateError(`E-mail template ${key} is not loaded`);
    }
    const context: Record<string, unknown> = {
      portalUrl: builtIns.portalUrl,
      adminUrl: builtIns.adminUrl,
      ...variables.data,
      ...variables.secretData,
    };
    return {
      subject: oneLine(template.subject(context)),
      html: template.html(context),
      text: template.text(context),
    };
  }
}
