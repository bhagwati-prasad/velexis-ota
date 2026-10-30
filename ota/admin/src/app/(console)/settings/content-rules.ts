// The content pages and e-mail templates of the OTA admin (OAD-015; routes.md §9, api-changes part 2 §2.4 and §2.6,
// OADR-0012 points 5 to 7, OADR-0013 point 3): what their pages (`pages/`, `templates/`), their client forms
// (`pages/page-form.tsx`, `templates/template-form.tsx`, `templates/preview-frame.tsx`) and their server actions
// (`pages/actions.ts`, `templates/actions.ts`) share. A module without a directive, for the reason settings-rules.ts
// gives: a `"use server"` module may export async functions only, and a `"use client"` module would reach the server
// only as client references. It imports of the SDK only types and no server-only module.
//
// - **Pages.** The field names (the request body's own names, so the API's field errors land on their field), the
//   kinds with their words, the limits of StorefrontPageInput, the Zod mirror the actions validate a form with, the
//   API's refusals in the admin's words (`422 UNPROCESSABLE` `markdown_not_allowed`, `asset_not_found` and
//   `asset_kind` with `details.line`, `locale_not_supported`; `409 CONFLICT` `page_exists`, `page_linked`), the lines
//   of a body around a reported line, and the list's URL model.
// - **Templates.** The keys with their words and audience, the address of a template (key, channel, locale), the Zod
//   mirror of NotificationTemplateInput, and `422 TEMPLATE_INVALID`'s `details.errors[{part, line, message}]` read
//   defensively, so a refusal is listed per part and line.
//
// Line breaks are sent as `\n`: a browser posts a textarea's lines with `\r\n`, and the API's parser and compiler count
// lines the same either way, so a body is stored as staff see it.
import type { NotificationTemplate, StaffPermission, StorefrontPage } from "@velexis/ota-sdk";
import { z } from "zod";

import type { Choice } from "@/app/(console)/bookings/[bookingId]/action-rules";
import type { ActionState } from "@/lib/action-state";

// ---- Shared -----------------------------------------------------------------------------------------------------

/** A locale as the API spells it (LocaleCode): a language and an optional region, such as `en` or `fr-CA`. */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;
/** A version as the page rendered it: a positive whole number. */
export const VERSION_PATTERN = /^[1-9][0-9]{0,9}$/;
/** An idempotency key as the page renders it (`crypto.randomUUID()`). */
export const ACTION_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest cursor a list passes on; the API's cursors are far shorter. */
const MAX_CURSOR_LENGTH = 2048;

/** The settings these pages write: the read permission and the write permission (scope §1.3). */
export const SETTINGS_READ: StaffPermission = "settings:read";
export const SETTINGS_WRITE: StaffPermission = "settings:write";

/** `value` with every line break written as `\n` (a browser posts a textarea's lines with `\r\n`). */
export function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** The length of a text as JSON Schema counts it (Unicode code points, not UTF-16 units). */
export function codePoints(value: string): number {
  return [...value].length;
}

/** The text of a form field, or `""` (a file or a missing field). */
export function textOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** A checkbox of a form: ticked when it posted `true`. */
export function checkedOf(form: FormData, name: string): boolean {
  return form.get(name) === "true";
}

/**
 * A locale as the API spells it: the language in lower case, the region in upper case (`fr_ca` → `fr-CA`); anything
 * else as it is, for the pattern to refuse.
 */
export function canonicalLocale(value: string): string {
  const [language = "", region, ...rest] = value.trim().split(/[-_]/);
  if (rest.length > 0) {
    return value.trim();
  }
  return region === undefined ? language.toLowerCase() : `${language.toLowerCase()}-${region.toUpperCase()}`;
}

/** One line of a text and its 1-based number. */
export interface NumberedLine {
  readonly number: number;
  readonly text: string;
}

/** The lines of a text, split as the API counts them (1-based, `\r\n` and `\n` alike). */
export function linesOf(text: string): string[] {
  return normalizeLineBreaks(text).split("\n");
}

/**
 * The lines around `line` (1-based), `context` lines before and after it within the text, for showing a refusal next
 * to the line it names; empty when the text has no such line.
 */
export function lineExcerpt(text: string, line: number, context = 2): NumberedLine[] {
  const lines = linesOf(text);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return [];
  }
  const first = Math.max(1, line - context);
  const last = Math.min(lines.length, line + context);
  return lines.slice(first - 1, last).map((value, index) => ({ number: first + index, text: value }));
}

/**
 * Where line `line` (1-based) is in a textarea's value (whose lines a browser keeps with `\n`): its first character and
 * the one after its last, for `setSelectionRange`; `undefined` when the text has no such line.
 */
export function lineRange(
  text: string,
  line: number,
): { readonly start: number; readonly end: number } | undefined {
  const lines = linesOf(text);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return undefined;
  }
  let start = 0;
  for (const value of lines.slice(0, line - 1)) {
    start += value.length + 1;
  }
  return { start, end: start + (lines[line - 1] ?? "").length };
}

// ---- Pages ------------------------------------------------------------------------------------------------------

/** What a content page is for (StorefrontPageKind). */
export type PageKind = StorefrontPage["kind"];

/** The pages list, which every page change revalidates. */
export const PAGES_PATH = "/settings/pages";
/** The segment of `/settings/pages/[pageId]` that opens the form of a new page: never a page id (`stp_…`). */
export const NEW_PAGE_SEGMENT = "new";
/** The form of a new page. */
export const NEW_PAGE_PATH = `${PAGES_PATH}/${NEW_PAGE_SEGMENT}`;
/** A page id as the API writes it. */
export const PAGE_ID_PATTERN = /^stp_[0-9A-Za-z]{16,40}$/;
/** A page's address on the storefront (StorefrontPageSlug): lower-case words joined by hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The page of one content page. */
export function pagePath(pageId: string): string {
  return `${PAGES_PATH}/${pageId}`;
}

/** Where the storefront shows a page: `/p/<slug>` on its host (the admin knows no storefront host). */
export function storefrontPathOf(slug: string): string {
  return `/p/${slug}`;
}

/** The limits of StorefrontPageInput. */
export const PAGE_LIMITS = Object.freeze({
  slug: 64,
  title: 120,
  body: 50_000,
  sortOrderMax: 10_000,
  sortOrderDefault: 100,
});

/** The fields of the page forms: the request body's names, and the hidden page, version and key. */
export const PAGE_FIELDS = Object.freeze({
  pageId: "pageId",
  version: "version",
  slug: "slug",
  locale: "locale",
  kind: "kind",
  title: "title",
  bodyMarkdown: "bodyMarkdown",
  isPublished: "isPublished",
  showInFooter: "showInFooter",
  sortOrder: "sortOrder",
});

/** The hidden fields of a page form: an API field error on one of them means the form is out of date. */
export const HIDDEN_PAGE_FIELDS: ReadonlySet<string> = new Set([
  PAGE_FIELDS.pageId,
  PAGE_FIELDS.version,
  "ifMatch",
]);

/** The kinds, in the document's order, with what each is for. */
export const PAGE_KINDS: readonly (Choice<PageKind> & { readonly detail: string })[] = Object.freeze([
  { value: "content", label: "Content page", detail: "Any page: information, offers, contact details." },
  {
    value: "terms",
    label: "Terms and conditions",
    detail: "The terms a legal link of the storefront settings can point to.",
  },
  { value: "privacy", label: "Privacy policy", detail: "How the OTA handles personal data." },
  { value: "cookies", label: "Cookie policy", detail: "The cookies the storefront uses." },
  { value: "refund_policy", label: "Refund policy", detail: "When and how travellers get money back." },
  { value: "imprint", label: "Imprint", detail: "The legal notice of the company behind the OTA." },
  { value: "faq", label: "FAQ", detail: "Questions travellers often ask." },
  { value: "about", label: "About us", detail: "Who the OTA is." },
]);

/** The words of a kind, or the value itself for a kind this list does not know. */
export function pageKindLabel(kind: string): string {
  return PAGE_KINDS.find((choice) => choice.value === kind)?.label ?? kind;
}

/** The Markdown subset in short, for the editor's help (StorefrontPageMarkdown). */
export const MARKDOWN_HELP: readonly { readonly syntax: string; readonly meaning: string }[] = Object.freeze([
  {
    syntax: "## Heading",
    meaning: "A heading; ### and #### for the levels below. The title is the page's top heading.",
  },
  {
    syntax: "(a blank line)",
    meaning: "Separates paragraphs, lists and images. Lines of one paragraph are joined.",
  },
  { syntax: "**bold**  *italic*", meaning: "Bold and italic text (also __bold__ and _italic_)." },
  { syntax: "- item   1. item", meaning: "A bullet or a numbered list, one level deep (also * item)." },
  {
    syntax: "[text](https://example.com)",
    meaning: "A link to an https:, mailto: or tel: address, or to another page as /p/<slug>.",
  },
  {
    syntax: "![alt text](ast_…)",
    meaning: "An image alone on its line: a page image uploaded on the Assets page, by its id.",
  },
  { syntax: "\\*", meaning: "A backslash shows the Markdown character after it as it is." },
]);

/** What the subset refuses, for the editor's help (the parser's refusals of OBE-072, markdown-subset.parser.ts). */
export const MARKDOWN_REFUSED =
  "Not allowed: HTML, tables, code, block quotes, horizontal rules, headings of level 1, 5 or 6, headings underlined with === or ---, + bullets and 1) numbers (write - and 1.), nested lists, empty headings and items, http: links, link titles, reference links and images inside text.";

const PAGE_MESSAGES = Object.freeze({
  slug: `Use lower-case letters and digits, with single hyphens between words (such as baggage-faq), at most ${PAGE_LIMITS.slug} characters.`,
  locale: "Choose one of the storefront's languages (such as en or fr-CA).",
  kind: "Choose what the page is for.",
  title: `Enter a title of at most ${PAGE_LIMITS.title} characters.`,
  titleControl: "Write the title on one line, without control characters.",
  body: `The body may be at most ${PAGE_LIMITS.body.toLocaleString("en-GB")} characters.`,
  sortOrder: `Enter a whole number from 0 to ${PAGE_LIMITS.sortOrderMax}.`,
});

/** Control characters (C0, DEL, C1), which a one-line title never holds (the API refuses them at `/title`). */
// eslint-disable-next-line no-control-regex -- the control characters are what is refused
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const titleSchema = z
  .string()
  .trim()
  .refine((value) => value !== "" && codePoints(value) <= PAGE_LIMITS.title, PAGE_MESSAGES.title)
  .refine((value) => !CONTROL_CHARACTERS.test(value), PAGE_MESSAGES.titleControl);

const bodySchema = z
  .string()
  .transform(normalizeLineBreaks)
  .refine((value) => codePoints(value) <= PAGE_LIMITS.body, PAGE_MESSAGES.body);

const sortOrderSchema = z
  .string()
  .trim()
  .refine((value) => /^(0|[1-9][0-9]{0,4})$/.test(value) && Number(value) <= PAGE_LIMITS.sortOrderMax, {
    message: PAGE_MESSAGES.sortOrder,
  })
  .transform(Number);

const kindSchema = z.enum(PAGE_KINDS.map((choice) => choice.value) as [PageKind, ...PageKind[]], {
  errorMap: () => ({ message: PAGE_MESSAGES.kind }),
});

/** The fields every page form posts: what StorefrontPageUpdate takes. */
const pageContentSchema = z.object({
  kind: kindSchema,
  title: titleSchema,
  bodyMarkdown: bodySchema,
  isPublished: z.boolean(),
  showInFooter: z.boolean(),
  sortOrder: sortOrderSchema,
});

/** The form of a new page: StorefrontPageInput (the address and the language are fixed from then on). */
export const newPageSchema = pageContentSchema.extend({
  slug: z
    .string()
    .trim()
    .refine((value) => value.length <= PAGE_LIMITS.slug && SLUG_PATTERN.test(value), PAGE_MESSAGES.slug),
  locale: z
    .string()
    .transform(canonicalLocale)
    .refine((value) => LOCALE_PATTERN.test(value), PAGE_MESSAGES.locale),
});

/** The form of a page's changes: StorefrontPageUpdate, every writable field. */
export const pageChangesSchema = pageContentSchema;

/** What a page form posts, before its schema. */
export function pageFormInput(form: FormData): Record<string, unknown> {
  return {
    slug: textOf(form, PAGE_FIELDS.slug),
    locale: textOf(form, PAGE_FIELDS.locale),
    kind: textOf(form, PAGE_FIELDS.kind),
    title: textOf(form, PAGE_FIELDS.title),
    bodyMarkdown: textOf(form, PAGE_FIELDS.bodyMarkdown),
    isPublished: checkedOf(form, PAGE_FIELDS.isPublished),
    showInFooter: checkedOf(form, PAGE_FIELDS.showInFooter),
    sortOrder: textOf(form, PAGE_FIELDS.sortOrder),
  };
}

/** The state of a page form: lib/action-state.ts's, and the body's line a refusal names. */
export interface PageActionState extends ActionState {
  /** The 1-based line of the body that the API refused (`details.line`), shown next to that line. */
  readonly bodyLine?: number;
}

/** The body's line a state names, or `undefined`. */
export function bodyLineOf(state: ActionState): number | undefined {
  const line = (state as PageActionState).bodyLine;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined;
}

/** The refusals of a body (`422 UNPROCESSABLE`, `details.reason`), which name the line they start on. */
export const BODY_REASONS = ["markdown_not_allowed", "asset_not_found", "asset_kind"] as const;
export type BodyReason = (typeof BODY_REASONS)[number];

/** Whether `value` is one of the refusals of a body. */
export function isBodyReason(value: unknown): value is BodyReason {
  return typeof value === "string" && (BODY_REASONS as readonly string[]).includes(value);
}

/** A refusal of a body in the admin's words, with the line it names (`details.line`) when the API gave one. */
export function bodyRefusalMessage(reason: BodyReason, line: number | undefined): string {
  const where = line === undefined ? undefined : `line ${line}`;
  switch (reason) {
    case "markdown_not_allowed":
      return `${where === undefined ? "The body" : `Line ${line}`} uses Markdown that content pages do not allow. Change it to the subset the help above the body lists.`;
    case "asset_not_found":
      return `The image ${where === undefined ? "in the body" : `on ${where}`} names no uploaded image. Upload it as a page image on the Assets page and use its id.`;
    case "asset_kind":
      return `The image ${where === undefined ? "in the body" : `on ${where}`} is not a page image. Upload the picture as a page image on the Assets page and use that id.`;
  }
}

/** The other refusals of a page, in the admin's words. */
export const PAGE_REFUSALS = Object.freeze({
  localeNotSupported:
    "The storefront does not offer this language. Add it to the supported languages in the storefront settings first.",
  pageExists: (slug: string, locale: string) =>
    `A page with the address ${storefrontPathOf(slug)} already exists in ${locale}. Open that page to change it, or choose another address.`,
  pageExistsUnnamed:
    "A page with this address already exists in this language. Open that page to change it, or choose another address.",
  pageLinked: (slug: string) =>
    `A legal link of the storefront settings points to ${storefrontPathOf(slug)}, so no page of that address can be deleted. Change the link in the storefront settings first, or unpublish the page to take it off the storefront.`,
  pageLinkedUnnamed:
    "A legal link of the storefront settings points to this page, so it cannot be deleted. Change the link in the storefront settings first, or unpublish the page.",
  gone: "This page no longer exists. Go back to the list of pages.",
  staleForm: "This form is out of date. Reload the page and try again.",
  busy: "This page is still being saved. Send the same form again in a moment.",
});

// ---- The pages list ---------------------------------------------------------------------------------------------

/** The page size of the pages list. */
export const PAGES_PAGE_SIZE = 50;

/** What the list's URL asks for: a locale, published or drafts, the cursor, and the parameters the API would refuse. */
export interface PageListQuery {
  readonly locale: string | undefined;
  readonly published: boolean | undefined;
  readonly cursor: string | undefined;
  readonly invalid: readonly string[];
}

/** The one value of a parameter, `undefined` when absent or empty, `null` when repeated. */
function singleOf(query: URLSearchParams, name: string): string | undefined | null {
  const values = query.getAll(name).filter((value) => value !== "");
  if (values.length > 1) {
    return null;
  }
  return values[0];
}

/**
 * The list query of a URL: one locale, put in the API's spelling (the language filter is typed: `fr_ca` and `FR-ca`
 * are `fr-CA`), `published=true|false`, one cursor of a sane length.
 */
export function pageListQueryOf(query: URLSearchParams): PageListQuery {
  const invalid: string[] = [];
  const typedLocale = singleOf(query, "locale");
  const localeValue =
    typedLocale === null || typedLocale === undefined ? typedLocale : canonicalLocale(typedLocale);
  let locale: string | undefined;
  if (localeValue === null || (localeValue !== undefined && !LOCALE_PATTERN.test(localeValue))) {
    invalid.push("locale");
  } else {
    locale = localeValue;
  }
  const publishedValue = singleOf(query, "published");
  let published: boolean | undefined;
  if (publishedValue === null || (publishedValue !== undefined && !/^(true|false)$/.test(publishedValue))) {
    invalid.push("published");
  } else if (publishedValue !== undefined) {
    published = publishedValue === "true";
  }
  const cursorValue = singleOf(query, "cursor");
  let cursor: string | undefined;
  if (cursorValue === null || (cursorValue !== undefined && cursorValue.length > MAX_CURSOR_LENGTH)) {
    invalid.push("cursor");
  } else {
    cursor = cursorValue;
  }
  return { locale, published, cursor, invalid };
}

/** The URL of the pages list with its filters and, on a later page, the cursor. */
export function pageListHref(
  filters: { readonly locale?: string | undefined; readonly published?: boolean | undefined },
  cursor?: string,
): string {
  const query = new URLSearchParams();
  if (filters.locale !== undefined) {
    query.set("locale", filters.locale);
  }
  if (filters.published !== undefined) {
    query.set("published", String(filters.published));
  }
  if (cursor !== undefined) {
    query.set("cursor", cursor);
  }
  const search = query.toString();
  return search === "" ? PAGES_PATH : `${PAGES_PATH}?${search}`;
}

// ---- Templates --------------------------------------------------------------------------------------------------

/** A template key (NotificationTemplateKey) and channel (NotificationChannel). */
export type TemplateKey = NotificationTemplate["key"];
export type TemplateChannel = NotificationTemplate["channel"];

/** The templates list, which every template change revalidates. */
export const TEMPLATES_PATH = "/settings/templates";
/** The one channel of the MVP. */
export const TEMPLATE_CHANNEL: TemplateChannel = "email";
/**
 * A template key as the API writes them (`booking.confirmed`): checked by shape rather than against this release's
 * list, so a key a later backend adds opens too (its words are then the key itself).
 */
export const TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Who receives the e-mails of a key. */
export type TemplateAudience = "customers" | "travellers" | "staff";

/** The keys of the MVP (NotificationTemplateKey, OADR-0013 point 4), in the document's order, with their words. */
export const TEMPLATE_KEYS: readonly (Choice<TemplateKey> & {
  readonly audience: TemplateAudience;
  readonly detail: string;
})[] = Object.freeze([
  {
    value: "auth.verify_email",
    label: "Verify the e-mail address",
    audience: "customers",
    detail: "Sent at sign-up with the link that confirms the address.",
  },
  {
    value: "auth.password_reset",
    label: "Password reset",
    audience: "customers",
    detail: "Sent with the link that sets a new password.",
  },
  {
    value: "account.email_changed",
    label: "E-mail address change asked for",
    audience: "customers",
    detail: "A security notice to the current address; it never shows the new one.",
  },
  {
    value: "account.deleted",
    label: "Account deleted",
    audience: "customers",
    detail: "Confirms the deletion of a customer account.",
  },
  {
    value: "booking.confirmed",
    label: "Booking confirmed",
    audience: "travellers",
    detail: "Sent when Amadeus confirmed the booking.",
  },
  {
    value: "booking.ticketed",
    label: "Tickets issued",
    audience: "travellers",
    detail: "Sent with the ticket numbers.",
  },
  {
    value: "booking.ticketing_delayed",
    label: "Ticketing delayed",
    audience: "travellers",
    detail: "Sent when the tickets take longer than usual.",
  },
  {
    value: "booking.cancelled",
    label: "Booking cancelled",
    audience: "travellers",
    detail: "Sent when the booking is cancelled, with what happens to the money.",
  },
  {
    value: "booking.cancellation_requested",
    label: "Cancellation requested",
    audience: "travellers",
    detail: "Sent when a cancellation waits for the airline or the staff.",
  },
  {
    value: "booking.not_confirmed",
    label: "Booking not confirmed",
    audience: "travellers",
    detail: "Sent when the booking could not be made.",
  },
  {
    value: "booking.updated",
    label: "Booking updated",
    audience: "travellers",
    detail: "Sent when the booking's contacts or travellers changed.",
  },
  {
    value: "staff.ticketing_failed",
    label: "Ticketing failed",
    audience: "staff",
    detail: "Tells the OTA's staff that tickets could not be issued.",
  },
  {
    value: "staff.manual_review",
    label: "Manual review needed",
    audience: "staff",
    detail: "Tells the OTA's staff that a booking waits for them.",
  },
  {
    value: "staff.airline_card_alert",
    label: "Airline card alert",
    audience: "staff",
    detail: "Tells the OTA's staff about an airline-card booking that needs attention.",
  },
]);

/** The words of an audience. */
export const TEMPLATE_AUDIENCES: Readonly<Record<TemplateAudience, string>> = Object.freeze({
  customers: "Customer accounts",
  travellers: "Bookings (to the traveller)",
  staff: "Staff alerts (to the OTA)",
});

/** The words of a key, or the key itself for one this list does not know. */
export function templateKeyLabel(key: string): string {
  return TEMPLATE_KEYS.find((choice) => choice.value === key)?.label ?? key;
}

/** The audience of a key: by its list entry, else by its prefix. */
export function templateAudienceOf(key: string): TemplateAudience {
  const known = TEMPLATE_KEYS.find((choice) => choice.value === key)?.audience;
  if (known !== undefined) {
    return known;
  }
  if (key.startsWith("staff.")) {
    return "staff";
  }
  return key.startsWith("booking.") ? "travellers" : "customers";
}

/** A template's address: its key, channel and locale (the path parameters of its operations). */
export interface TemplateRef {
  readonly templateKey: TemplateKey;
  readonly channel: TemplateChannel;
  readonly locale: string;
}

/** The address of a page's path parameters, or `undefined` when one of them is not a value the API takes. */
export function templateRefOf(key: unknown, channel: unknown, locale: unknown): TemplateRef | undefined {
  if (
    typeof key !== "string" ||
    !TEMPLATE_KEY_PATTERN.test(key) ||
    channel !== TEMPLATE_CHANNEL ||
    typeof locale !== "string" ||
    !LOCALE_PATTERN.test(locale)
  ) {
    return undefined;
  }
  return { templateKey: key as TemplateKey, channel: TEMPLATE_CHANNEL, locale };
}

/** The page of one template. */
export function templatePath(ref: TemplateRef): string {
  return `${TEMPLATES_PATH}/${encodeURIComponent(ref.templateKey)}/${ref.channel}/${ref.locale}`;
}

/** The limits of NotificationTemplateInput. */
export const TEMPLATE_LIMITS = Object.freeze({ subject: 300, bodyHtml: 100_000, bodyText: 50_000 });

/** The fields of the template forms: the address, the version, and the request body's names. */
export const TEMPLATE_FIELDS = Object.freeze({
  templateKey: "templateKey",
  channel: "channel",
  locale: "locale",
  version: "version",
  subject: "subject",
  bodyHtml: "bodyHtml",
  bodyText: "bodyText",
  isActive: "isActive",
});

/** The parts of a template as the API names them (`details.errors[].part`), with their words. */
export const TEMPLATE_PARTS = Object.freeze([
  { value: "subject", label: "Subject" },
  { value: "bodyHtml", label: "HTML body" },
  { value: "bodyText", label: "Text body" },
] as const satisfies readonly Choice[]);

export type TemplatePart = (typeof TEMPLATE_PARTS)[number]["value"];

/** The words of a part. */
export function templatePartLabel(part: TemplatePart): string {
  return TEMPLATE_PARTS.find((choice) => choice.value === part)?.label ?? part;
}

/** The address a template form posts, or `undefined` when its hidden fields are not the page's. */
export function templateRefOfForm(form: FormData): TemplateRef | undefined {
  return templateRefOf(
    textOf(form, TEMPLATE_FIELDS.templateKey),
    textOf(form, TEMPLATE_FIELDS.channel),
    textOf(form, TEMPLATE_FIELDS.locale),
  );
}

const TEMPLATE_MESSAGES = Object.freeze({
  subject: `Enter a subject of at most ${TEMPLATE_LIMITS.subject} characters.`,
  bodyHtml: `Enter the HTML body, at most ${TEMPLATE_LIMITS.bodyHtml.toLocaleString("en-GB")} characters.`,
  bodyText: `Enter the text body, at most ${TEMPLATE_LIMITS.bodyText.toLocaleString("en-GB")} characters.`,
});

/** A part that a save needs: not blank, within its limit; line breaks as `\n`. */
const requiredPart = (limit: number, message: string) =>
  z
    .string()
    .transform(normalizeLineBreaks)
    .refine((value) => value.trim() !== "" && codePoints(value) <= limit, message);

/** A part of a preview's draft: within its limit (a blank part renders blank). */
const draftPart = (limit: number, message: string) =>
  z
    .string()
    .transform(normalizeLineBreaks)
    .refine((value) => codePoints(value) <= limit, message);

/** The form of a save: NotificationTemplateInput. */
export const templateInputSchema = z.object({
  subject: requiredPart(TEMPLATE_LIMITS.subject, TEMPLATE_MESSAGES.subject),
  bodyHtml: requiredPart(TEMPLATE_LIMITS.bodyHtml, TEMPLATE_MESSAGES.bodyHtml),
  bodyText: requiredPart(TEMPLATE_LIMITS.bodyText, TEMPLATE_MESSAGES.bodyText),
  isActive: z.boolean(),
});

/** The draft of a preview: NotificationTemplatePreviewRequest's three parts. */
export const templateDraftSchema = z.object({
  subject: draftPart(TEMPLATE_LIMITS.subject, TEMPLATE_MESSAGES.subject),
  bodyHtml: draftPart(TEMPLATE_LIMITS.bodyHtml, TEMPLATE_MESSAGES.bodyHtml),
  bodyText: draftPart(TEMPLATE_LIMITS.bodyText, TEMPLATE_MESSAGES.bodyText),
});

/** What a template form posts, before its schema. */
export function templateFormInput(form: FormData): Record<string, unknown> {
  return {
    subject: textOf(form, TEMPLATE_FIELDS.subject),
    bodyHtml: textOf(form, TEMPLATE_FIELDS.bodyHtml),
    bodyText: textOf(form, TEMPLATE_FIELDS.bodyText),
    isActive: checkedOf(form, TEMPLATE_FIELDS.isActive),
  };
}

/** One problem of `422 TEMPLATE_INVALID` (`details.errors[]`): the part, its 1-based line (or none) and the message. */
export interface TemplateProblem {
  readonly part: TemplatePart;
  readonly line: number | null;
  readonly message: string;
}

/** The longest message of a problem the admin shows (the API's are short; a longer one is cut). */
const MAX_PROBLEM_MESSAGE = 500;
/** The most problems the admin lists. */
const MAX_PROBLEMS = 50;

/**
 * The problems of a `422 TEMPLATE_INVALID` (`details.errors`), read defensively: an item without a known part or a
 * message is left out, a line that is not a positive whole number is none. The API builds the messages from the
 * template and the key's variables, never from render data (templates.service.ts), so they are shown as they come.
 */
export function templateProblemsOf(
  details: Readonly<Record<string, unknown>> | undefined,
): TemplateProblem[] {
  const errors = details?.["errors"];
  if (!Array.isArray(errors)) {
    return [];
  }
  const problems: TemplateProblem[] = [];
  for (const item of errors.slice(0, MAX_PROBLEMS)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const { part, line, message } = item as Record<string, unknown>;
    if (!TEMPLATE_PARTS.some((choice) => choice.value === part) || typeof message !== "string") {
      continue;
    }
    const text = message.trim();
    if (text === "") {
      continue;
    }
    problems.push({
      part: part as TemplatePart,
      line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null,
      message:
        codePoints(text) > MAX_PROBLEM_MESSAGE
          ? `${[...text].slice(0, MAX_PROBLEM_MESSAGE).join("")}…`
          : text,
    });
  }
  return problems;
}

/** A problem as one line of text: "Line 3: …", or the message alone without a line. */
export function problemText(problem: Pick<TemplateProblem, "line" | "message">): string {
  return problem.line === null ? problem.message : `Line ${problem.line}: ${problem.message}`;
}

/** The field errors of a list of problems: the first problem of each part, on its field. */
export function problemFieldErrors(problems: readonly TemplateProblem[]): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (!Object.hasOwn(fieldErrors, problem.part)) {
      fieldErrors[problem.part] = problemText(problem);
    }
  }
  return fieldErrors;
}

/** The state of a template save or preview: lib/action-state.ts's, and the problems of a `422 TEMPLATE_INVALID`. */
export interface TemplateActionState extends ActionState {
  readonly problems?: readonly TemplateProblem[];
}

/** A rendered preview: the subject, the HTML body (none for a text-only template) and the text body. */
export interface RenderedPreview {
  readonly subject: string;
  readonly html: string | null;
  readonly text: string;
}

/** The state of a preview: a template action's, and the rendered e-mail after a success. */
export interface PreviewActionState extends TemplateActionState {
  readonly preview?: RenderedPreview;
}

/** The problems a state lists. */
export function problemsOf(state: ActionState): readonly TemplateProblem[] {
  return (state as TemplateActionState).problems ?? [];
}

/** The rendered preview of a state, or `undefined`. */
export function previewOf(state: ActionState): RenderedPreview | undefined {
  return (state as PreviewActionState).preview;
}

/** Where a template comes from, as the list and the editor say it. */
export type TemplateSource = "customised" | "seeded" | "inherited" | "default";

/**
 * Where a template comes from: the OTA's own edit (`customised`), the row provisioning seeded from the code default
 * and nobody edited (`seeded`: not customised, but a row with a version), the active row of the locale's language
 * (`inherited`), or the code default.
 */
export function templateSourceOf(
  template: Pick<NotificationTemplate, "customised" | "inheritedFrom" | "version">,
): TemplateSource {
  if (template.inheritedFrom !== null) {
    return "inherited";
  }
  if (template.version === null) {
    return "default";
  }
  return template.customised ? "customised" : "seeded";
}
