// storefront.listPages and storefront.getPage (listStorefrontPages, getStorefrontPage; `x-scope: both`; OBE-072,
// api-changes part 2 §4.1, OADR-0012 points 5 and 7): the published content pages of the request's tenant for the
// hosted storefront's edge and for key callers, read from `storefront_pages` through the tenancy module's `TenantTx`.
// The storefront context imports nothing of the settings context (lead decision (2a) of 2026-10-30; the console's
// page operations, settings/pages.service.ts, depend on this file and on the parser, never the reverse).
//
// Locale. The `locale` parameter when the storefront offers it (`locales.supported` of the settings, compared
// case-insensitively), else the first locale of `Accept-Language` the storefront offers (storefront.mapper.ts
// `negotiateLocale`), else the default locale; the supported and default locales come from storefront.get's entry of
// the default locale (StorefrontService.entry, cached as `sf:und`; a tenant without a settings row is
// `403 TENANT_SUSPENDED` there). So the answer's locale is always a supported one. A slug is served in that locale when
// its page there is published, else in the default locale when that page is: the list holds each slug once, and
// getPage answers the same page the list names (`locale` says which), `404 NOT_FOUND` otherwise (drafts are console
// only).
//
// Cache (OADR-0012 point 7, per tenant, environment and locale): the hash `t:<tenantId>:<env>:pages:<locale>`
// (`redisKeys.pages`, 5 minutes) with the field `list` (the list, each entry with the locale it serves) and a field
// `page:<slug>` per page read since (its blocks, images as asset id, extension, alt text and dimensions):
//
//   list     HGET list → hit: answer; miss or unreadable: one transaction reads the published pages of the locale
//            and the default locale (no bodies) → MULTI DEL, HSET list, EXPIRE 300 → answer
//   getPage  HMGET list, page:<slug> → no list: fill it as above (the page field read with it is dropped); slug not in
//            the list: 404 without SQL; page field of the listed locale: answer; else one transaction reads that
//            page, parses its body (markdown-subset.parser.ts) and reads its images' assets → MULTI HSET page:<slug>,
//            EXPIRE 300 NX (the hash keeps the expiry of its list, or gets one when it expired meanwhile) → answer
//
// Every key is written with its TTL (Redis runs with noeviction), and only slugs of published pages get a field, so a
// visitor asking for random slugs never grows the hash. A page change of the console (settings/pages.service.ts) and a
// storefront settings change (its default or supported locales; settings/storefront-settings.service.ts) delete the
// hashes of every supported locale in both environments (`pageCacheKeys`): the storefront sees a change within these
// 5 minutes and its own `sessionStorage` copy. A fill that read the rows before a change and writes after its deletion
// can serve the older pages until the hash expires. Redis down: nothing is read or written, PostgreSQL answers each
// request (architecture §10).
//
// The images. The cache keeps asset references; the answer gets each image's URL for the caller (storefront.mapper.ts
// `assetUrl`): `/api/v1/assets/<key>/<id>.<ext>` on the storefront's own origin for the edge, `PUBLIC_OTA_API_URL`
// for key callers. A body is checked when it is saved, so it parses; an image whose asset is gone or is not a
// `page_image` (neither can happen while the asset delete checks the pages) is left out with a warning, and a body
// that no longer parses is served without blocks with an error line (ids only, never the body).
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import type { ChainableCommander, Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { redisKeys, type KeyEnvironment, type RedisKey, type RedisKeyName } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { ApiConfig } from "../config";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  MarkdownSubsetError,
  parseMarkdownSubset,
  type ParsedImageBlock,
  type ParsedPageBlock,
} from "./markdown-subset.parser";
import {
  assetUrl,
  canonicalLocale,
  localesOf,
  negotiateLocale,
  type StorefrontCaller,
} from "./storefront.mapper";
import { StorefrontService } from "./storefront.service";

type Schemas = components["schemas"];
export type StorefrontPageList = Schemas["StorefrontPageList"];
export type StorefrontPageSummary = Schemas["StorefrontPageSummary"];
export type StorefrontPageContent = Schemas["StorefrontPageContent"];
export type StorefrontPageBlock = Schemas["StorefrontPageBlock"];
export type StorefrontPageKind = Schemas["StorefrontPageKind"];

/** The page kinds of the document (`StorefrontPageKind`, the CHECK of `storefront_pages.kind`), in its order. */
export const PAGE_KINDS = Object.freeze([
  "content",
  "terms",
  "privacy",
  "cookies",
  "refund_policy",
  "imprint",
  "faq",
  "about",
] as const satisfies readonly StorefrontPageKind[]);

/** The format of the cached fields; another value is rebuilt. */
const PAGES_CACHE_FORMAT = 1;
/** The hash field of the list. */
const LIST_FIELD = "list";
/** The hash field of a page's blocks. */
const pageField = (slug: string): string => `page:${slug}`;

/** ioredis statuses in which the command client cannot answer: it waits to reconnect, or has been closed. */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

const ENVIRONMENTS: readonly KeyEnvironment[] = ["test", "live"];

/** A page of the list with the locale it is served in. */
export interface ListedPage extends StorefrontPageSummary {
  readonly locale: string;
}

/** An image as the cache keeps it: the asset's id and extension, the URL is the caller's. */
export interface CachedImageBlock {
  readonly type: "image";
  readonly assetId: string;
  readonly extension: string;
  readonly alt: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** A block as the cache keeps it. */
export type CachedPageBlock = Exclude<ParsedPageBlock, ParsedImageBlock> | CachedImageBlock;

/** A page as the cache keeps it. */
export interface CachedPage {
  readonly slug: string;
  readonly locale: string;
  readonly title: string;
  readonly kind: StorefrontPageKind;
  readonly blocks: CachedPageBlock[];
  readonly updatedAt: string;
}

/** The locale of a request and the storefront's default locale. */
interface RequestLocales {
  readonly locale: string;
  readonly defaultLocale: string;
}

/** An image asset as a page shows it. */
interface PageAssetRow {
  readonly id: string;
  readonly kind: string;
  readonly fileExtension: string;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * The page caches of both environments for `locales`, the storefront's supported locales (see the file header); a
 * locale that cannot be a key part is left out, as nothing is cached under it. The tenant id is checked by the keys.
 */
export function pageCacheKeys(tenantId: string, locales: readonly string[]): RedisKeyName[] {
  // The tenant id first, so a wrong one throws instead of being taken for a locale that cannot be a key part.
  redisKeys.pages(tenantId, "test", "en");
  const parts = [...new Set(locales.flatMap((locale) => canonicalLocale(locale) ?? []))];
  return ENVIRONMENTS.flatMap((environment) =>
    parts.flatMap((locale): RedisKeyName[] => {
      try {
        return [redisKeys.pages(tenantId, environment, locale).key];
      } catch (error) {
        if (error instanceof TypeError) {
          return [];
        }
        throw error;
      }
    }),
  );
}

/** `404 NOT_FOUND` for a slug without a published page in the locale or the default locale. */
function pageNotFound(): AppError {
  return new AppError("NOT_FOUND", { message: "The page does not exist." });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isKind = (value: unknown): value is StorefrontPageKind =>
  typeof value === "string" && (PAGE_KINDS as readonly string[]).includes(value);

/** The list read back from its field, or `undefined` when it is not one this version wrote. */
export function decodeCachedList(raw: string | null | undefined): ListedPage[] | undefined {
  const stored = parseJson(raw);
  if (!isRecord(stored) || stored["v"] !== PAGES_CACHE_FORMAT || !Array.isArray(stored["pages"])) {
    return undefined;
  }
  const pages: unknown[] = stored["pages"];
  const valid = pages.every(
    (page) =>
      isRecord(page) &&
      typeof page["slug"] === "string" &&
      typeof page["title"] === "string" &&
      isKind(page["kind"]) &&
      typeof page["showInFooter"] === "boolean" &&
      Number.isInteger(page["sortOrder"]) &&
      typeof page["locale"] === "string",
  );
  return valid ? (pages as ListedPage[]) : undefined;
}

/** A page read back from its field, or `undefined` when it is not one this version wrote. */
export function decodeCachedPage(raw: string | null | undefined): CachedPage | undefined {
  const stored = parseJson(raw);
  if (!isRecord(stored) || stored["v"] !== PAGES_CACHE_FORMAT || !isRecord(stored["page"])) {
    return undefined;
  }
  const page = stored["page"];
  const blocks = page["blocks"];
  const valid =
    typeof page["slug"] === "string" &&
    typeof page["locale"] === "string" &&
    typeof page["title"] === "string" &&
    isKind(page["kind"]) &&
    typeof page["updatedAt"] === "string" &&
    Array.isArray(blocks) &&
    blocks.every(
      (block) =>
        isRecord(block) &&
        (block["type"] === "image"
          ? typeof block["assetId"] === "string" && typeof block["extension"] === "string"
          : ["heading", "paragraph", "list"].includes(String(block["type"]))),
    );
  return valid ? (page as unknown as CachedPage) : undefined;
}

function parseJson(raw: string | null | undefined): unknown {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The list of the locale from the published rows of the locale and the default locale (see the file header). */
export function listOf(
  rows: readonly {
    readonly slug: string;
    readonly locale: string;
    readonly title: string;
    readonly kind: string;
    readonly showInFooter: boolean;
    readonly sortOrder: number;
  }[],
  locales: RequestLocales,
): ListedPage[] {
  const bySlug = new Map<string, ListedPage>();
  for (const row of rows) {
    const current = bySlug.get(row.slug);
    if (!isKind(row.kind) || (current !== undefined && current.locale === locales.locale)) {
      continue;
    }
    if (row.locale === locales.locale || row.locale === locales.defaultLocale) {
      bySlug.set(row.slug, {
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        showInFooter: row.showInFooter,
        sortOrder: row.sortOrder,
        locale: row.locale,
      });
    }
  }
  return [...bySlug.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
}

@Injectable()
export class PublicPagesService {
  private readonly publicApiUrl: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly storefront: StorefrontService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<ApiConfig, true>,
    @InjectPinoLogger(PublicPagesService.name) private readonly logger: PinoLogger,
  ) {
    this.publicApiUrl = config.get("PUBLIC_OTA_API_URL", { infer: true });
  }

  /** storefront.listPages in the request's locale (see the file header). */
  async list(locale: string | undefined, acceptLanguage: string | undefined): Promise<StorefrontPageList> {
    const tenant = this.tenants.require();
    const locales = await this.localesOf(locale, acceptLanguage);
    const key = this.keyOf(tenant, locales.locale);
    const [raw] = await this.readFields(key, [LIST_FIELD]);
    const listed = decodeCachedList(raw) ?? (await this.fillList(tenant, key, locales));
    return {
      data: listed.map(({ slug, title, kind, showInFooter, sortOrder }) => ({
        slug,
        title,
        kind,
        showInFooter,
        sortOrder,
      })),
    };
  }

  /** storefront.getPage of `slug` in the request's locale, with the image URLs of `caller` (see the file header). */
  async page(
    slug: string,
    locale: string | undefined,
    acceptLanguage: string | undefined,
    caller: StorefrontCaller,
  ): Promise<StorefrontPageContent> {
    const tenant = this.tenants.require();
    const locales = await this.localesOf(locale, acceptLanguage);
    const key = this.keyOf(tenant, locales.locale);
    const [rawList, rawPage] = await this.readFields(key, [LIST_FIELD, pageField(slug)]);
    const cachedList = decodeCachedList(rawList);
    const listed = cachedList ?? (await this.fillList(tenant, key, locales));
    const entry = listed.find((candidate) => candidate.slug === slug);
    if (entry === undefined) {
      throw pageNotFound();
    }
    // A page field read before the list was filled again belongs to the hash that fill replaced.
    const cachedPage = cachedList === undefined ? undefined : decodeCachedPage(rawPage);
    let page = cachedPage?.locale === entry.locale ? cachedPage : undefined;
    if (page === undefined) {
      page = await this.loadPage(tenant, slug, entry.locale);
      if (page === undefined) {
        throw pageNotFound();
      }
      await this.writePage(key, page);
    }
    return this.forCaller(tenant, page, caller);
  }

  /** The locale of the request and the default locale (see the file header). */
  private async localesOf(
    locale: string | undefined,
    acceptLanguage: string | undefined,
  ): Promise<RequestLocales> {
    const entry = await this.storefront.entry(undefined);
    const supported = localesOf(entry);
    const defaultLocale = entry.config.defaultLocale;
    const requested = canonicalLocale(locale)?.toLowerCase();
    const offered = supported.find((candidate) => candidate.toLowerCase() === requested);
    return { locale: offered ?? negotiateLocale(acceptLanguage, supported, defaultLocale), defaultLocale };
  }

  /** The page with the image URLs of `caller`. */
  private forCaller(
    tenant: RequestTenant,
    page: CachedPage,
    caller: StorefrontCaller,
  ): StorefrontPageContent {
    const audience = { caller, publicApiUrl: this.publicApiUrl };
    return {
      slug: page.slug,
      locale: page.locale,
      title: page.title,
      kind: page.kind,
      blocks: page.blocks.map((block): StorefrontPageBlock => {
        if (block.type !== "image") {
          return block;
        }
        const { assetId, extension, alt, width, height } = block;
        return {
          type: "image",
          assetId,
          url: assetUrl(tenant.key, { id: assetId, extension }, audience),
          alt,
          width,
          height,
        };
      }),
      updatedAt: page.updatedAt,
    };
  }

  /** Reads the published pages of the locale and the default locale (no bodies) and caches the list. */
  private async fillList(
    tenant: RequestTenant,
    key: RedisKey | undefined,
    locales: RequestLocales,
  ): Promise<ListedPage[]> {
    const rows = await this.tx.run((trx) =>
      trx
        .selectFrom("storefront_pages")
        .select([
          "slug",
          "locale",
          "title",
          "kind",
          "show_in_footer as showInFooter",
          "sort_order as sortOrder",
        ])
        .where("is_published", "=", true)
        .where("locale", "in", [...new Set([locales.locale, locales.defaultLocale])])
        .execute(),
    );
    const listed = listOf(rows, locales);
    if (key !== undefined && !REDIS_DOWN.has(this.redis.status)) {
      await this.write(
        key,
        this.redis
          .multi()
          .del(key.key)
          .hset(key.key, LIST_FIELD, JSON.stringify({ v: PAGES_CACHE_FORMAT, pages: listed }))
          .expire(key.key, key.ttlSeconds),
      );
    }
    this.logger.debug({ tenantId: tenant.tenantId, pages: listed.length }, "storefront_pages.list_filled");
    return listed;
  }

  /**
   * Runs a MULTI of the hash `key`. A command the server refused inside it (EXEC answers its error, not the call) or a
   * failed EXEC drops the hash, so it never stays without its expiry; the next request reads PostgreSQL again.
   */
  private async write(key: RedisKey, commands: ChainableCommander): Promise<void> {
    try {
      const results = await commands.exec();
      if (results !== null && results.every(([error]) => error === null)) {
        return;
      }
    } catch {
      // Dropped below.
    }
    try {
      await this.redis.del(key.key);
    } catch {
      // The connection logs the outage (redis.module.ts).
    }
  }

  /** The published page `slug` of `locale` with its blocks and their images' assets, or `undefined`. */
  private async loadPage(
    tenant: RequestTenant,
    slug: string,
    locale: string,
  ): Promise<CachedPage | undefined> {
    return await this.tx.run(async (trx) => {
      const row = await trx
        .selectFrom("storefront_pages")
        .select([
          "id",
          "slug",
          "locale",
          "title",
          "kind",
          "body_markdown as bodyMarkdown",
          "updated_at as updatedAt",
        ])
        .where("slug", "=", slug)
        .where("locale", "=", locale)
        .where("is_published", "=", true)
        .executeTakeFirst();
      if (row === undefined || !isKind(row.kind)) {
        return undefined;
      }
      let parsed: ParsedPageBlock[];
      try {
        parsed = parseMarkdownSubset(row.bodyMarkdown).blocks;
      } catch (error) {
        if (!(error instanceof MarkdownSubsetError)) {
          throw error;
        }
        this.logger.error(
          { tenantId: tenant.tenantId, pageId: row.id, line: error.line },
          "storefront_pages.body_unparsable",
        );
        parsed = [];
      }
      const assets = await this.assetsOf(trx, parsed);
      const blocks = parsed.flatMap((block): CachedPageBlock[] => {
        if (block.type !== "image") {
          return [block];
        }
        const asset = assets.get(block.assetId);
        if (asset === undefined || asset.kind !== "page_image") {
          this.logger.warn(
            { tenantId: tenant.tenantId, pageId: row.id, assetId: block.assetId },
            "storefront_pages.image_missing",
          );
          return [];
        }
        return [
          {
            type: "image",
            assetId: asset.id,
            extension: asset.fileExtension,
            alt: block.alt,
            width: asset.width,
            height: asset.height,
          },
        ];
      });
      return {
        slug: row.slug,
        locale: row.locale,
        title: row.title,
        kind: row.kind,
        blocks,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /** The assets of the image blocks, by id. */
  private async assetsOf(
    trx: TenantTransaction,
    blocks: readonly ParsedPageBlock[],
  ): Promise<Map<string, PageAssetRow>> {
    const ids = [...new Set(blocks.flatMap((block) => (block.type === "image" ? [block.assetId] : [])))];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await trx
      .selectFrom("storefront_assets")
      .select(["id", "kind", "file_extension as fileExtension", "width", "height"])
      .where("id", "in", ids)
      .execute();
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Caches a page in the hash of its locale, which keeps its expiry (or gets one: it expired meanwhile). */
  private async writePage(key: RedisKey | undefined, page: CachedPage): Promise<void> {
    if (key === undefined || REDIS_DOWN.has(this.redis.status)) {
      return;
    }
    await this.write(
      key,
      this.redis
        .multi()
        .hset(key.key, pageField(page.slug), JSON.stringify({ v: PAGES_CACHE_FORMAT, page }))
        .expire(key.key, key.ttlSeconds, "NX"),
    );
  }

  /** The fields of the hash; all `null` for a miss or a Redis that does not answer. */
  private async readFields(
    key: RedisKey | undefined,
    fields: readonly string[],
  ): Promise<Array<string | null>> {
    const none = fields.map(() => null);
    if (key === undefined || REDIS_DOWN.has(this.redis.status)) {
      return none;
    }
    try {
      return await this.redis.hmget(key.key, ...fields);
    } catch {
      return none; // The connection logs the outage (redis.module.ts); PostgreSQL answers meanwhile.
    }
  }

  /** The hash of a locale, or `undefined` when the locale cannot be a key part (the cache is then skipped). */
  private keyOf(tenant: RequestTenant, locale: string): RedisKey | undefined {
    try {
      return redisKeys.pages(tenant.tenantId, tenant.environment, locale);
    } catch (error) {
      if (error instanceof TypeError) {
        return undefined;
      }
      throw error;
    }
  }
}
