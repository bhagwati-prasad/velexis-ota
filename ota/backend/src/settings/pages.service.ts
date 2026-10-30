// console.settings.pages.list, create, get, update and delete (consoleListStorefrontPages, consoleCreateStorefrontPage,
// consoleGetStorefrontPage, consoleUpdateStorefrontPage, consoleDeleteStorefrontPage; `settings:read` /
// `settings:write`; OBE-072, api-changes part 2 §2.4, OADR-0012 points 5 to 7): the OTA's content pages
// (`storefront_pages`, one row per slug and locale, one set for the test and live environments) as staff edit them.
// The settings context depends on the storefront context, never the reverse (lead decision (2a) of 2026-10-30): the
// bodies are checked with the storefront's parser (storefront/markdown-subset.parser.ts) and the storefront's page
// caches are named by storefront/public-pages.service.ts `pageCacheKeys`.
//
//   list    by `sort_order`, then `slug`, then `locale`, drafts included; `locale` and `published` filters; a keyset
//           cursor bound to the filters (another list's is `400 VALIDATION_FAILED` at `/query/cursor`); 20 per page.
//   get     the page; `404 NOT_FOUND` for an id of no page of the tenant.
//   create  the title trimmed (blank or with a control character: `400 VALIDATION_FAILED` at `/title`) and the body
//           parsed first; then one transaction reads the settings row `FOR SHARE` (missing: `403 TENANT_SUSPENDED`,
//           the tenant is not ready) and checks, in this order: the locale is one of the supported locales
//           (`422 UNPROCESSABLE`, `locale_not_supported`; it is stored as the settings write it), the body keeps to the
//           subset (`markdown_not_allowed` with `details.line`), each image names an asset (`asset_not_found`) of kind
//           `page_image` (`asset_kind`), with its line; the assets are read `FOR KEY SHARE`, so an asset delete waits for
//           the commit and then sees the page that shows it (`409 asset_in_use`), and a page saved after a delete sees
//           the asset gone. The row is inserted unless a page of the slug and locale exists (`409 CONFLICT`,
//           `page_exists`, `details.slug` and `details.locale`); `published_at` is set when it is created published.
//   update  the title and body checked as on create; one transaction reads the row `FOR UPDATE` (`404`), compares
//           `If-Match` (`412 PRECONDITION_FAILED`), checks the body and its images, and writes the sent fields at
//           `version + 1`; publishing sets `published_at` the first time and keeps it after.
//   delete  one transaction reads the row `FOR UPDATE` (`404`), compares `If-Match` (`412`), reads the settings row
//           `FOR SHARE` and refuses a page whose slug a legal link names, in any locale (`409 CONFLICT`,
//           `page_linked`, `details.slug`; the lock orders it with console.settings.storefront.update, which locks
//           the row before it checks that a linked slug has a page), and deletes the row; `204`.
//
// Every change writes its `staff_actions` row (`settings.pages.create|update|delete`, target `storefront_page` and the
// id) with the page before and after as the document shows it (null before a create and after a delete) in its
// transaction; refusals are the audit interceptor's rows, reads write none (OADR-0011 point 8 as decided on
// 2026-10-21). After the commit, the page caches of both environments are deleted for every supported locale and the
// page's own (`t:<tenantId>:<env>:pages:<locale>`, public-pages.service.ts), so storefront.listPages and getPage read
// the change; a Redis that does not answer is logged (`storefront_pages.cache_not_deleted`) and the answer stands:
// the hashes expire within their 5 minutes. Every answer is `Cache-Control: private, no-store` with `ETag: "<version>"`
// on get, create and update (the controller).
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types";
import { sql } from "@velexis/db";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { ifMatchSatisfied } from "../checkout/checkout.mapper";
import { IdGenerator } from "../common/ids";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { consoleAction, StaffActionsWriter } from "../console/staff-actions.writer";
import { decodeKeysetCursor, encodeCursor, invalidCursor, pageLimit } from "../reference/reference.mapper";
import {
  MarkdownSubsetError,
  parseMarkdownSubset,
  type ParsedImage,
} from "../storefront/markdown-subset.parser";
import { pageCacheKeys } from "../storefront/public-pages.service";
import { canonicalLocale } from "../storefront/storefront.mapper";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";

type Schemas = components["schemas"];
export type StorefrontPage = Schemas["StorefrontPage"];
export type StorefrontPagePage = Schemas["StorefrontPagePage"];
export type StorefrontPageInput = Schemas["StorefrontPageInput"];
export type StorefrontPageUpdate = Schemas["StorefrontPageUpdate"];
type StorefrontPageKind = Schemas["StorefrontPageKind"];

/** The `Cache-Control` of every answer of the console's page operations. */
export const PAGES_CACHE_CONTROL = "private, no-store";

/** The ETag of a page: `"<version>"` (the If-Match of its update and delete). */
export const pageEtagOf = (version: number): string => `"${version}"`;

/** The defaults of a create (StorefrontPageInput). */
const DEFAULT_KIND: StorefrontPageKind = "content";
const DEFAULT_SORT_ORDER = 100;

/** The audit target type of a page. */
const TARGET_TYPE = "storefront_page";

/** A page row as the console reads it. */
export interface PageRow {
  readonly id: string;
  readonly slug: string;
  readonly locale: string;
  readonly kind: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly isPublished: boolean;
  readonly showInFooter: boolean;
  readonly sortOrder: number;
  readonly publishedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The columns of `PageRow`. */
const PAGE_COLUMNS = [
  "id",
  "slug",
  "locale",
  "kind",
  "title",
  "body_markdown as bodyMarkdown",
  "is_published as isPublished",
  "show_in_footer as showInFooter",
  "sort_order as sortOrder",
  "published_at as publishedAt",
  "version",
  "created_at as createdAt",
  "updated_at as updatedAt",
] as const;

/** What the page operations read of the settings row. */
interface PageSettings {
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  readonly legalLinks: unknown;
}

/** A page row as the document shows it. */
export function toStorefrontPage(row: PageRow): StorefrontPage {
  return {
    id: row.id,
    slug: row.slug,
    locale: row.locale,
    kind: row.kind as StorefrontPageKind,
    title: row.title,
    bodyMarkdown: row.bodyMarkdown,
    isPublished: row.isPublished,
    showInFooter: row.showInFooter,
    sortOrder: row.sortOrder,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The storefront's locales: the default one and the supported ones, canonical and once each. */
export function storefrontLocales(
  settings: Pick<PageSettings, "defaultLocale" | "supportedLocales">,
): string[] {
  return [
    ...new Set(
      [settings.defaultLocale, ...settings.supportedLocales].flatMap(
        (locale) => canonicalLocale(locale) ?? [],
      ),
    ),
  ];
}

/** The slugs the legal links of the settings name (`legal_links`: `[{kind, label, url} | {kind, label, pageSlug}]`). */
export function linkedSlugs(legalLinks: unknown): Set<string> {
  if (!Array.isArray(legalLinks)) {
    return new Set();
  }
  return new Set(
    legalLinks.flatMap((link: unknown) =>
      typeof link === "object" &&
      link !== null &&
      typeof (link as Record<string, unknown>)["pageSlug"] === "string"
        ? [(link as Record<string, string>)["pageSlug"] as string]
        : [],
    ),
  );
}

/** Control characters (C0 with the tab and line breaks, DEL, C1), which a one-line title never holds. */
// eslint-disable-next-line no-control-regex -- the control characters are what is refused
const TITLE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A title as it is kept: trimmed; a blank one is `400 VALIDATION_FAILED` at `/title` (`minLength`), and so is one with
 * a control character (`pattern`; PostgreSQL would refuse a NUL with a `500`, and the storefront shows the title as one
 * line).
 */
export function checkedTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === "") {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [{ path: "/title", code: "minLength", message: "must not be blank" }],
    });
  }
  if (TITLE_CONTROL.test(trimmed)) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [{ path: "/title", code: "pattern", message: "must not hold control characters" }],
    });
  }
  return trimmed;
}

/** A body's images, or the refusal of a body outside the subset (thrown in the order of the file header). */
type CheckedBody =
  { readonly images: readonly ParsedImage[] } | { readonly refusal: AppError<"UNPROCESSABLE"> };

/** Parses a body: its images, or its `422 UNPROCESSABLE` `markdown_not_allowed` with the line. */
export function checkBody(body: string): CheckedBody {
  try {
    return { images: parseMarkdownSubset(body).images };
  } catch (error) {
    if (error instanceof MarkdownSubsetError) {
      return {
        refusal: new AppError("UNPROCESSABLE", {
          message: error.message,
          details: { reason: error.reason, line: error.line },
        }),
      };
    }
    throw error;
  }
}

/** The images of a checked body; throws its refusal. */
function imagesOf(body: CheckedBody): readonly ParsedImage[] {
  if ("refusal" in body) {
    throw body.refusal;
  }
  return body.images;
}

// ---- The list cursor ------------------------------------------------------------------------------------------------

/** The filters of a list as a cursor records them. */
export function pageFilterOf(query: {
  readonly locale?: string | undefined;
  readonly published?: boolean | undefined;
}): string {
  return `${query.locale ?? "*"}|${query.published === undefined ? "*" : String(query.published)}`;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** The position after `row` in the list of `filter`. */
export function encodePageCursor(
  filter: string,
  row: Pick<PageRow, "sortOrder" | "slug" | "locale">,
): string {
  return encodeCursor({ s: String(row.sortOrder), g: row.slug, l: row.locale, f: filter });
}

/** The keyset position of a cursor of the list of `filter`; `400 VALIDATION_FAILED` (`/query/cursor`) otherwise. */
export function decodePageCursor(
  filter: string,
  cursor: string,
): { readonly sortOrder: number; readonly slug: string; readonly locale: string } {
  const { s, g, l, f } = decodeKeysetCursor(cursor, ["s", "g", "l", "f"]);
  const sortOrder = Number(s);
  if (
    !/^-?\d{1,10}$/.test(s) ||
    sortOrder < INT32_MIN ||
    sortOrder > INT32_MAX ||
    !SLUG.test(g) ||
    f !== filter
  ) {
    throw invalidCursor();
  }
  return { sortOrder, slug: g, locale: l };
}

// ---- Refusals -------------------------------------------------------------------------------------------------------

function pageNotFound(): AppError {
  return new AppError("NOT_FOUND", { message: "The page does not exist." });
}

/** A tenant whose settings row is missing (provisioning did not seed it): not ready, as storefront.get answers. */
function notReady(): AppError {
  return new AppError("TENANT_SUSPENDED", {
    message: "The storefront settings of this OTA are not ready yet.",
  });
}

@Injectable()
export class PagesService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly writer: StaffActionsWriter,
    private readonly ids: IdGenerator,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectPinoLogger(PagesService.name) private readonly logger: PinoLogger,
  ) {}

  /** console.settings.pages.list (see the file header). */
  async list(query: {
    readonly locale?: string | undefined;
    readonly published?: boolean | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<StorefrontPagePage> {
    const limit = pageLimit(query.limit);
    const filter = pageFilterOf(query);
    const after = query.cursor === undefined ? undefined : decodePageCursor(filter, query.cursor);
    const rows = await this.tx.run((trx) => {
      let select = trx.selectFrom("storefront_pages").select(PAGE_COLUMNS);
      if (query.locale !== undefined) {
        select = select.where("locale", "=", query.locale);
      }
      if (query.published !== undefined) {
        select = select.where("is_published", "=", query.published);
      }
      if (after !== undefined) {
        select = select.where(
          sql<boolean>`(sort_order, slug, locale) > (${after.sortOrder}::integer, ${after.slug}::text, ${after.locale}::text)`,
        );
      }
      return select
        .orderBy("sort_order")
        .orderBy("slug")
        .orderBy("locale")
        .limit(limit + 1)
        .execute();
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toStorefrontPage),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodePageCursor(filter, last) : null,
        limit,
      },
    };
  }

  /** console.settings.pages.get. */
  async get(pageId: string): Promise<StorefrontPage> {
    const row = await this.tx.run((trx) => this.byId(trx, pageId));
    if (row === undefined) {
      throw pageNotFound();
    }
    return toStorefrontPage(row);
  }

  /** console.settings.pages.create (see the file header). */
  async create(input: StorefrontPageInput): Promise<StorefrontPage> {
    const title = checkedTitle(input.title);
    const bodyMarkdown = input.bodyMarkdown ?? "";
    const body = checkBody(bodyMarkdown);
    const tenant = this.tenants.require();
    const isPublished = input.isPublished ?? false;
    const { page, locales } = await this.tx.run(async (trx) => {
      const settings = await this.settings(trx);
      if (settings === undefined) {
        throw notReady();
      }
      const supported = storefrontLocales(settings);
      const requested = (canonicalLocale(input.locale) ?? input.locale).toLowerCase();
      const locale = supported.find((candidate) => candidate.toLowerCase() === requested);
      if (locale === undefined) {
        throw new AppError("UNPROCESSABLE", {
          message: `The storefront does not offer the locale ${input.locale}.`,
          details: { reason: "locale_not_supported" },
        });
      }
      await this.checkImages(trx, imagesOf(body));
      const inserted = await trx
        .insertInto("storefront_pages")
        .values({
          id: this.ids.newId("stp"),
          slug: input.slug,
          locale,
          kind: input.kind ?? DEFAULT_KIND,
          title,
          body_markdown: bodyMarkdown,
          is_published: isPublished,
          show_in_footer: input.showInFooter ?? false,
          sort_order: input.sortOrder ?? DEFAULT_SORT_ORDER,
          published_at: isPublished ? sql<Date>`now()` : null,
          updated_by_staff_id: this.staffId(),
        })
        .onConflict((conflict) => conflict.columns(["slug", "locale"]).doNothing())
        .returning(PAGE_COLUMNS)
        .executeTakeFirst();
      if (inserted === undefined) {
        throw new AppError("CONFLICT", {
          message: "A page with this slug already exists in this locale.",
          details: { reason: "page_exists", slug: input.slug, locale },
        });
      }
      const created = toStorefrontPage(inserted);
      await this.writer.record(trx, {
        action: consoleAction("consoleCreateStorefrontPage"),
        targetType: TARGET_TYPE,
        targetId: created.id,
        before: null,
        after: created,
      });
      return { page: created, locales: supported };
    });
    this.logger.info({ pageId: page.id, published: page.isPublished }, "storefront_pages.created");
    await this.deleteCaches(tenant, [...locales, page.locale]);
    return page;
  }

  /** console.settings.pages.update with the request's `If-Match` (see the file header). */
  async update(pageId: string, update: StorefrontPageUpdate, ifMatch: string): Promise<StorefrontPage> {
    const title = update.title === undefined ? undefined : checkedTitle(update.title);
    const body = update.bodyMarkdown === undefined ? undefined : checkBody(update.bodyMarkdown);
    const tenant = this.tenants.require();
    const { page, locales } = await this.tx.run(async (trx) => {
      const row = await this.byId(trx, pageId, { forUpdate: true });
      if (row === undefined) {
        throw pageNotFound();
      }
      if (!ifMatchSatisfied(ifMatch, row.version)) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (body !== undefined) {
        await this.checkImages(trx, imagesOf(body));
      }
      const saved = await trx
        .updateTable("storefront_pages")
        .set({
          ...(update.kind === undefined ? {} : { kind: update.kind }),
          ...(title === undefined ? {} : { title }),
          ...(update.bodyMarkdown === undefined ? {} : { body_markdown: update.bodyMarkdown }),
          ...(update.isPublished === undefined ? {} : { is_published: update.isPublished }),
          ...(update.isPublished === true && row.publishedAt === null
            ? { published_at: sql<Date>`now()` }
            : {}),
          ...(update.showInFooter === undefined ? {} : { show_in_footer: update.showInFooter }),
          ...(update.sortOrder === undefined ? {} : { sort_order: update.sortOrder }),
          updated_by_staff_id: this.staffId(),
          version: sql<number>`version + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .where("version", "=", row.version)
        .returning(PAGE_COLUMNS)
        .executeTakeFirst();
      if (saved === undefined) {
        // The row is locked since it was read: only a writer outside this service could have moved it.
        throw new AppError("PRECONDITION_FAILED");
      }
      const updated = toStorefrontPage(saved);
      await this.writer.record(trx, {
        action: consoleAction("consoleUpdateStorefrontPage"),
        targetType: TARGET_TYPE,
        targetId: row.id,
        before: toStorefrontPage(row),
        after: updated,
      });
      const settings = await this.settings(trx, { lock: false });
      return { page: updated, locales: settings === undefined ? [] : storefrontLocales(settings) };
    });
    this.logger.info({ pageId: page.id, published: page.isPublished }, "storefront_pages.updated");
    await this.deleteCaches(tenant, [...locales, page.locale]);
    return page;
  }

  /** console.settings.pages.delete with the request's `If-Match` (see the file header). */
  async delete(pageId: string, ifMatch: string): Promise<void> {
    const tenant = this.tenants.require();
    const { row, locales } = await this.tx.run(async (trx) => {
      const found = await this.byId(trx, pageId, { forUpdate: true });
      if (found === undefined) {
        throw pageNotFound();
      }
      if (!ifMatchSatisfied(ifMatch, found.version)) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const settings = await this.settings(trx);
      if (settings !== undefined && linkedSlugs(settings.legalLinks).has(found.slug)) {
        throw new AppError("CONFLICT", {
          message: "A legal link of the storefront settings points to this page; change the link first.",
          details: { reason: "page_linked", slug: found.slug },
        });
      }
      await trx.deleteFrom("storefront_pages").where("id", "=", found.id).execute();
      await this.writer.record(trx, {
        action: consoleAction("consoleDeleteStorefrontPage"),
        targetType: TARGET_TYPE,
        targetId: found.id,
        before: toStorefrontPage(found),
        after: null,
      });
      return { row: found, locales: settings === undefined ? [] : storefrontLocales(settings) };
    });
    this.logger.info({ pageId: row.id }, "storefront_pages.deleted");
    await this.deleteCaches(tenant, [...locales, row.locale]);
  }

  /** The page `pageId`; `forUpdate` locks its row until the end of the transaction. */
  private async byId(
    trx: TenantTransaction,
    pageId: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<PageRow | undefined> {
    const query = trx.selectFrom("storefront_pages").select(PAGE_COLUMNS).where("id", "=", pageId);
    return await (options.forUpdate === true ? query.forUpdate() : query).executeTakeFirst();
  }

  /** The settings row's locales and legal links, read `FOR SHARE` unless `lock` is false; `undefined` without one. */
  private async settings(
    trx: TenantTransaction,
    options: { readonly lock?: boolean } = {},
  ): Promise<PageSettings | undefined> {
    const query = trx
      .selectFrom("storefront_settings")
      .select([
        "default_locale as defaultLocale",
        "supported_locales as supportedLocales",
        "legal_links as legalLinks",
      ])
      .where("id", "=", "sfs_default");
    return await (options.lock === false ? query : query.forShare()).executeTakeFirst();
  }

  /**
   * The images of a body name assets of kind `page_image` (`422 UNPROCESSABLE`, `asset_not_found` or `asset_kind`, with
   * the line of the first one that does not); the assets are read `FOR KEY SHARE` (see the file header).
   */
  private async checkImages(trx: TenantTransaction, images: readonly ParsedImage[]): Promise<void> {
    const ids = [...new Set(images.map((image) => image.assetId))];
    if (ids.length === 0) {
      return;
    }
    const rows = await trx
      .selectFrom("storefront_assets")
      .select(["id", "kind"])
      .where("id", "in", ids)
      .forKeyShare()
      .execute();
    const kinds = new Map(rows.map((row) => [row.id, row.kind]));
    for (const image of images) {
      const kind = kinds.get(image.assetId);
      if (kind === undefined) {
        throw new AppError("UNPROCESSABLE", {
          message: `The image on line ${image.line} names an image that is not uploaded.`,
          details: { reason: "asset_not_found", line: image.line },
        });
      }
      if (kind !== "page_image") {
        throw new AppError("UNPROCESSABLE", {
          message: `The image on line ${image.line} is not a page image.`,
          details: { reason: "asset_kind", line: image.line },
        });
      }
    }
  }

  /** The staff member of the request, null for a key-only call. */
  private staffId(): string | null {
    const actor = this.writer.requestActor();
    return actor?.type === "staff" ? actor.staffId : null;
  }

  /** After a change: the page caches of both environments for `locales` (see the file header). Never fails. */
  private async deleteCaches(tenant: RequestTenant, locales: readonly string[]): Promise<void> {
    const keys = pageCacheKeys(tenant.tenantId, locales);
    if (keys.length === 0) {
      return;
    }
    try {
      await this.redis.del(...keys);
    } catch {
      this.logger.warn(
        { tenantId: tenant.tenantId, keys: keys.length },
        "storefront_pages.cache_not_deleted",
      );
    }
  }
}
